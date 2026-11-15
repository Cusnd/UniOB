use crate::config::Config;
use crate::crypto::{constant_time_eq, hmac_sha256_hex, sha256_hex, Sha256};
use crate::protocol::{UpdateDirective, UpdateStatusReport};
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::http::Uri;

pub const MAX_CLOCK_SKEW_SEC: u64 = 900;
pub const PLAUSIBLE_CLOCK_EPOCH: u64 = 1_700_000_000;
pub const MAX_REDIRECTS: usize = 5;
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_BINARY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const READ_CHUNK_BYTES: usize = 16 * 1024;
const RETRY_BACKOFF_SECS: [u64; 5] = [15, 30, 60, 120, 300];
const ELF_MAGIC: [u8; 4] = [0x7f, b'E', b'L', b'F'];

const UPDATE_DIR_NAME: &str = "update";
const STAGED_BIN_NAME: &str = "uniob-agent.bin";
const READY_MANIFEST_NAME: &str = "ready.json";
const UPDATE_STATE_NAME: &str = "state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyManifest {
    pub version: String,
    pub sha256: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_url: Option<String>,
    pub issued_at: u64,
    pub hmac: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedUpdateState {
    #[serde(default)]
    last_issued_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedHttpUrl {
    is_tls: bool,
    host: String,
    port: u16,
    host_header: String,
    request_target: String,
}

#[derive(Debug, Clone)]
enum WorkerEvent {
    Staged {
        version: String,
        sha256: String,
        ts: u64,
    },
    Failed {
        version: String,
        sha256: String,
        err: String,
        ts: u64,
    },
}

struct FailureBackoff {
    failures: u32,
    next_retry_at: Instant,
}

pub struct UpdateRuntime {
    node_id: String,
    token: String,
    state_dir: PathBuf,
    tls_config: Arc<rustls::ClientConfig>,
    persisted: PersistedUpdateState,
    status: UpdateStatusReport,
    last_reported: Option<UpdateStatusReport>,
    status_changed: bool,
    worker_rx: Option<Receiver<WorkerEvent>>,
    in_flight_sha256: Option<String>,
    failure_backoffs: HashMap<String, FailureBackoff>,
}

fn now_unix_sec() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn update_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(UPDATE_DIR_NAME)
}

fn staged_bin_path(state_dir: &Path) -> PathBuf {
    update_dir(state_dir).join(STAGED_BIN_NAME)
}

fn ready_manifest_path(state_dir: &Path) -> PathBuf {
    update_dir(state_dir).join(READY_MANIFEST_NAME)
}

fn state_file_path(state_dir: &Path) -> PathBuf {
    update_dir(state_dir).join(UPDATE_STATE_NAME)
}

fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn compute_update_hmac_hex(
    token: &str,
    node_id: &str,
    version: &str,
    sha256: &str,
    issued_at: u64,
    url: &str,
    fallback_url: Option<&str>,
) -> String {
    let key_hex = sha256_hex(token.as_bytes());
    let fb = fallback_url.unwrap_or("");
    let msg = format!("agent_update_v1:{node_id}:{version}:{sha256}:{issued_at}:{url}:{fb}");
    hmac_sha256_hex(key_hex.as_bytes(), msg.as_bytes())
}

fn verify_manifest_hmac(
    token: &str,
    node_id: &str,
    manifest: &ReadyManifest,
) -> Result<(), String> {
    let provided = manifest.hmac.trim().to_ascii_lowercase();
    if !is_valid_sha256_hex(&provided) {
        return Err("invalid update hmac format".to_string());
    }
    let expected = compute_update_hmac_hex(
        token,
        node_id,
        &manifest.version,
        &manifest.sha256,
        manifest.issued_at,
        &manifest.url,
        manifest.fallback_url.as_deref(),
    );
    if !constant_time_eq(expected.as_bytes(), provided.as_bytes()) {
        return Err("update HMAC-SHA256 verification failed".to_string());
    }
    Ok(())
}

fn parse_http_url(raw_url: &str) -> Result<ParsedHttpUrl, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.bytes().any(|b| b.is_ascii_control()) {
        return Err("update URL must not be empty or contain control characters".to_string());
    }

    let uri: Uri = trimmed
        .parse()
        .map_err(|e| format!("invalid update URL '{trimmed}': {e}"))?;

    let (is_tls, default_port) = match uri.scheme_str().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("https") => (true, 443),
        Some("http") => (false, 80),
        other => return Err(format!("unsupported update URL scheme: {other:?}")),
    };

    if uri
        .authority()
        .is_some_and(|auth| auth.as_str().contains('@'))
    {
        return Err("update URL userinfo is not allowed".to_string());
    }

    let raw_host = uri
        .host()
        .ok_or_else(|| "update URL missing host".to_string())?;
    let host = if raw_host.starts_with('[') && raw_host.ends_with(']') {
        raw_host[1..raw_host.len() - 1].to_string()
    } else {
        raw_host.to_string()
    };
    if host.is_empty() {
        return Err("update URL missing host".to_string());
    }

    let port = uri.port_u16().unwrap_or(default_port);
    let formatted_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let host_header = if port == default_port {
        formatted_host
    } else {
        format!("{formatted_host}:{port}")
    };

    let request_target = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/".to_string());
    if !request_target.starts_with('/') {
        return Err("update URL path must start with '/'".to_string());
    }

    Ok(ParsedHttpUrl {
        is_tls,
        host,
        port,
        host_header,
        request_target,
    })
}

fn resolve_redirect_url(base: &ParsedHttpUrl, location: &str) -> Result<String, String> {
    let loc = location.trim();
    if loc.is_empty() || loc.bytes().any(|b| b.is_ascii_control()) {
        return Err("invalid empty or control redirect Location".to_string());
    }
    let lower = loc.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Ok(loc.to_string());
    }
    let scheme = if base.is_tls { "https" } else { "http" };
    if loc.starts_with("//") {
        return Ok(format!("{scheme}:{loc}"));
    }
    if loc.starts_with('/') {
        return Ok(format!("{scheme}://{}{}", base.host_header, loc));
    }
    let base_path = base.request_target.split('?').next().unwrap_or("/");
    let dir = match base_path.rfind('/') {
        Some(idx) => &base_path[..=idx],
        None => "/",
    };
    Ok(format!("{scheme}://{}{}{}", base.host_header, dir, loc))
}

pub fn validate_directive(
    directive: &UpdateDirective,
    node_id: &str,
    token: &str,
    now_sec: u64,
    last_issued_at: u64,
) -> Result<(), String> {
    let ver = directive.version.trim();
    if ver.is_empty() || ver.len() > 64 || ver.chars().any(char::is_control) {
        return Err("invalid target version in update directive".to_string());
    }
    if !is_valid_sha256_hex(&directive.sha256) {
        return Err("invalid sha256 digest in update directive".to_string());
    }
    if now_sec >= PLAUSIBLE_CLOCK_EPOCH
        && now_sec.abs_diff(directive.issued_at) > MAX_CLOCK_SKEW_SEC
    {
        return Err(format!(
            "update directive issued_at {} outside +/-{}s window of now {}",
            directive.issued_at, MAX_CLOCK_SKEW_SEC, now_sec
        ));
    }
    if directive.issued_at <= last_issued_at {
        return Err(format!(
            "stale update directive issued_at {} <= last_issued_at {}",
            directive.issued_at, last_issued_at
        ));
    }
    let manifest = ReadyManifest {
        version: directive.version.clone(),
        sha256: directive.sha256.clone(),
        url: directive.url.clone(),
        fallback_url: directive.fallback_url.clone(),
        issued_at: directive.issued_at,
        hmac: directive.hmac.clone(),
    };
    verify_manifest_hmac(token, node_id, &manifest)?;
    parse_http_url(&directive.url)?;
    if let Some(ref fb) = directive.fallback_url {
        parse_http_url(fb)?;
    }
    Ok(())
}

fn atomic_write_bytes(dir: &Path, final_path: &Path, data: &[u8], mode: u32) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("failed to create dir {}: {e}", dir.display()))?;
    let name = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp_path = dir.join(format!(".{name}.tmp.{}", std::process::id()));

    let write_res = (|| -> io::Result<()> {
        let mut f = File::create(&tmp_path)?;
        f.write_all(data)?;
        f.sync_all()?;
        set_permissions(&tmp_path, mode)?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to write {}: {e}", tmp_path.display()));
    }

    if let Err(e) = fs::rename(&tmp_path, final_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "failed to rename {} -> {}: {e}",
            tmp_path.display(),
            final_path.display()
        ));
    }

    #[cfg(not(unix))]
    let _ = mode;

    Ok(())
}

fn set_permissions(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn load_persisted_state(state_dir: &Path) -> PersistedUpdateState {
    let path = state_file_path(state_dir);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => PersistedUpdateState::default(),
    }
}

fn save_persisted_state(state_dir: &Path, state: &PersistedUpdateState) {
    let path = state_file_path(state_dir);
    if let Ok(bytes) = serde_json::to_vec(state) {
        let _ = atomic_write_bytes(&update_dir(state_dir), &path, &bytes, 0o644);
    }
}

pub fn verify_staged_update(node_id: &str, token: &str, state_dir: &Path) -> Result<(), String> {
    let ready_path = ready_manifest_path(state_dir);
    let ready_raw = fs::read_to_string(&ready_path)
        .map_err(|e| format!("failed to read {}: {e}", ready_path.display()))?;
    let manifest: ReadyManifest = serde_json::from_str(&ready_raw)
        .map_err(|e| format!("invalid {}: {e}", ready_path.display()))?;

    let ver = manifest.version.trim();
    if ver.is_empty() || ver.len() > 64 || ver.chars().any(char::is_control) {
        return Err("invalid version in ready.json".to_string());
    }
    if !is_valid_sha256_hex(&manifest.sha256) {
        return Err("invalid sha256 in ready.json".to_string());
    }

    verify_manifest_hmac(token, node_id, &manifest)?;

    let bin_path = staged_bin_path(state_dir);
    let file =
        File::open(&bin_path).map_err(|e| format!("failed to open {}: {e}", bin_path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("failed to stat {}: {e}", bin_path.display()))?;
    if !meta.is_file() || meta.len() < 4 || meta.len() > MAX_BINARY_BYTES {
        return Err(format!(
            "staged binary {} has invalid size {}",
            bin_path.display(),
            meta.len()
        ));
    }

    let mut reader = BufReader::with_capacity(READ_CHUNK_BYTES, file);
    let mut hasher = Sha256::new();
    let mut header = [0u8; 4];
    reader
        .read_exact(&mut header)
        .map_err(|e| format!("failed to read ELF header: {e}"))?;
    if header != ELF_MAGIC {
        return Err("staged binary is not a valid ELF executable".to_string());
    }
    hasher.update(&header);

    let mut buf = [0u8; READ_CHUNK_BYTES];
    let mut total_read = 4u64;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("failed to read {}: {e}", bin_path.display()))?;
        if n == 0 {
            break;
        }
        total_read += n as u64;
        if total_read > MAX_BINARY_BYTES {
            return Err("staged binary exceeds maximum size".to_string());
        }
        hasher.update(&buf[..n]);
    }

    let actual_sha256 = hasher.finalize_hex();
    let expected_sha256 = manifest.sha256.to_ascii_lowercase();
    if !constant_time_eq(actual_sha256.as_bytes(), expected_sha256.as_bytes()) {
        return Err(format!(
            "staged binary sha256 mismatch: expected {expected_sha256}, got {actual_sha256}"
        ));
    }

    Ok(())
}

impl UpdateRuntime {
    pub fn init(cfg: &Config, state_dir: &Path, tls_config: Arc<rustls::ClientConfig>) -> Self {
        let mut persisted = load_persisted_state(state_dir);
        let current_ver = env!("CARGO_PKG_VERSION").to_string();
        let now = now_unix_sec();

        let (status, status_changed) =
            if let Ok(raw) = fs::read_to_string(ready_manifest_path(state_dir)) {
                if let Ok(manifest) = serde_json::from_str::<ReadyManifest>(&raw) {
                    (
                        UpdateStatusReport {
                            st: "staged".to_string(),
                            ver: Some(manifest.version),
                            err: None,
                            ts: Some(now),
                        },
                        true,
                    )
                } else {
                    (
                        UpdateStatusReport {
                            st: "idle".to_string(),
                            ver: None,
                            err: None,
                            ts: None,
                        },
                        false,
                    )
                }
            } else if let Some(pending) = persisted.pending_version.take() {
                persisted.pending_sha256 = None;
                save_persisted_state(state_dir, &persisted);
                if pending == current_ver {
                    (
                        UpdateStatusReport {
                            st: "idle".to_string(),
                            ver: Some(current_ver),
                            err: None,
                            ts: Some(now),
                        },
                        true,
                    )
                } else {
                    (
                        UpdateStatusReport {
                            st: "error".to_string(),
                            ver: Some(pending),
                            err: Some("staged update did not take effect".to_string()),
                            ts: Some(now),
                        },
                        true,
                    )
                }
            } else {
                (
                    UpdateStatusReport {
                        st: "idle".to_string(),
                        ver: None,
                        err: None,
                        ts: None,
                    },
                    false,
                )
            };

        Self {
            node_id: cfg.server.node_id.clone(),
            token: cfg.server.token.clone(),
            state_dir: state_dir.to_path_buf(),
            tls_config,
            persisted,
            status,
            last_reported: None,
            status_changed,
            worker_rx: None,
            in_flight_sha256: None,
            failure_backoffs: HashMap::new(),
        }
    }

    pub fn is_busy(&self) -> bool {
        self.worker_rx.is_some()
    }

    pub fn has_status_change(&self) -> bool {
        self.status_changed
    }

    pub fn pending_report(&self) -> Option<UpdateStatusReport> {
        if self.status.st != "idle"
            || (self.status_changed && self.last_reported.as_ref() != Some(&self.status))
        {
            Some(self.status.clone())
        } else {
            None
        }
    }

    pub fn mark_reported(&mut self, report: UpdateStatusReport) {
        if self.status == report {
            self.status_changed = false;
        }
        self.last_reported = Some(report);
    }

    pub fn reset_for_session(&mut self) {
        self.last_reported = None;
        if self.status.st != "idle" {
            self.status_changed = true;
        }
    }

    pub fn poll(&mut self) -> bool {
        let Some(ref rx) = self.worker_rx else {
            return false;
        };
        match rx.try_recv() {
            Ok(WorkerEvent::Staged {
                version,
                sha256,
                ts,
            }) => {
                self.worker_rx = None;
                self.in_flight_sha256 = None;
                self.failure_backoffs.remove(&sha256);
                self.persisted.pending_version = Some(version.clone());
                self.persisted.pending_sha256 = Some(sha256);
                save_persisted_state(&self.state_dir, &self.persisted);
                self.status = UpdateStatusReport {
                    st: "staged".to_string(),
                    ver: Some(version),
                    err: None,
                    ts: Some(ts),
                };
                self.status_changed = true;
                true
            }
            Ok(WorkerEvent::Failed {
                version,
                sha256,
                err,
                ts,
            }) => {
                self.worker_rx = None;
                self.in_flight_sha256 = None;
                let entry = self
                    .failure_backoffs
                    .entry(sha256)
                    .or_insert_with(|| FailureBackoff {
                        failures: 0,
                        next_retry_at: Instant::now(),
                    });
                let idx = (entry.failures as usize).min(RETRY_BACKOFF_SECS.len() - 1);
                entry.failures = entry.failures.saturating_add(1);
                entry.next_retry_at = Instant::now() + Duration::from_secs(RETRY_BACKOFF_SECS[idx]);
                self.status = UpdateStatusReport {
                    st: "error".to_string(),
                    ver: Some(version),
                    err: Some(err),
                    ts: Some(ts),
                };
                self.status_changed = true;
                true
            }
            Err(TryRecvError::Empty) => false,
            Err(TryRecvError::Disconnected) => {
                self.worker_rx = None;
                self.in_flight_sha256 = None;
                self.status = UpdateStatusReport {
                    st: "error".to_string(),
                    ver: self.status.ver.clone(),
                    err: Some("update worker terminated unexpectedly".to_string()),
                    ts: Some(now_unix_sec()),
                };
                self.status_changed = true;
                true
            }
        }
    }

    pub fn handle_directive(&mut self, directive: UpdateDirective) {
        let now_sec = now_unix_sec();
        if let Err(err) = validate_directive(
            &directive,
            &self.node_id,
            &self.token,
            now_sec,
            self.persisted.last_issued_at,
        ) {
            eprintln!("update directive rejected: {err}");
            return;
        }

        let sha_key = directive.sha256.to_ascii_lowercase();
        if self.in_flight_sha256.as_deref() == Some(&sha_key) {
            return;
        }
        if self.worker_rx.is_some() {
            eprintln!("update directive ignored while another update download is in progress");
            return;
        }

        if let Some(backoff) = self.failure_backoffs.get(&sha_key) {
            if Instant::now() < backoff.next_retry_at {
                eprintln!(
                    "update directive for {} throttled by failure backoff",
                    directive.version
                );
                return;
            }
        }

        if self.persisted.pending_sha256.as_deref() == Some(&sha_key)
            && verify_staged_update(&self.node_id, &self.token, &self.state_dir).is_ok()
        {
            self.persisted.last_issued_at = directive.issued_at;
            save_persisted_state(&self.state_dir, &self.persisted);
            self.status = UpdateStatusReport {
                st: "staged".to_string(),
                ver: Some(directive.version),
                err: None,
                ts: Some(now_sec),
            };
            self.status_changed = true;
            return;
        }

        self.persisted.last_issued_at = directive.issued_at;
        save_persisted_state(&self.state_dir, &self.persisted);

        self.in_flight_sha256 = Some(sha_key.clone());
        self.status = UpdateStatusReport {
            st: "downloading".to_string(),
            ver: Some(directive.version.clone()),
            err: None,
            ts: Some(now_sec),
        };
        self.status_changed = true;

        let (tx, rx) = mpsc::channel();
        self.worker_rx = Some(rx);
        let state_dir = self.state_dir.clone();
        let tls_config = self.tls_config.clone();

        std::thread::spawn(move || {
            let res = download_and_stage_directive(&directive, &state_dir, &tls_config);
            let ts = now_unix_sec();
            let ev = match res {
                Ok(()) => WorkerEvent::Staged {
                    version: directive.version,
                    sha256: sha_key,
                    ts,
                },
                Err(err) => WorkerEvent::Failed {
                    version: directive.version,
                    sha256: sha_key,
                    err,
                    ts,
                },
            };
            let _ = tx.send(ev);
        });
    }
}

pub fn download_and_stage_directive(
    directive: &UpdateDirective,
    state_dir: &Path,
    tls_config: &Arc<rustls::ClientConfig>,
) -> Result<(), String> {
    let dir = update_dir(state_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;

    let tmp_bin = dir.join(format!(".{STAGED_BIN_NAME}.tmp.{}", std::process::id()));
    let expected_sha = directive.sha256.to_ascii_lowercase();

    let mut urls = vec![directive.url.as_str()];
    if let Some(ref fb) = directive.fallback_url {
        urls.push(fb.as_str());
    }

    let mut last_err = None;
    let mut downloaded = false;
    for url in urls {
        match download_http_to_file(url, &tmp_bin, &expected_sha, tls_config, DOWNLOAD_TIMEOUT) {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp_bin);
                last_err = Some(err);
            }
        }
    }

    if !downloaded {
        return Err(last_err.unwrap_or_else(|| "update download failed".to_string()));
    }

    if let Err(e) = set_permissions(&tmp_bin, 0o755) {
        let _ = fs::remove_file(&tmp_bin);
        return Err(format!("failed to chmod staged binary: {e}"));
    }

    let final_bin = staged_bin_path(state_dir);
    if let Err(e) = fs::rename(&tmp_bin, &final_bin) {
        let _ = fs::remove_file(&tmp_bin);
        return Err(format!(
            "failed to rename {} -> {}: {e}",
            tmp_bin.display(),
            final_bin.display()
        ));
    }

    let manifest = ReadyManifest {
        version: directive.version.clone(),
        sha256: expected_sha,
        url: directive.url.clone(),
        fallback_url: directive.fallback_url.clone(),
        issued_at: directive.issued_at,
        hmac: directive.hmac.clone(),
    };
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|e| format!("failed to encode ready.json: {e}"))?;
    atomic_write_bytes(
        &dir,
        &ready_manifest_path(state_dir),
        &manifest_bytes,
        0o644,
    )
}

pub fn download_http_to_file(
    initial_url: &str,
    dest_path: &Path,
    expected_sha256: &str,
    tls_config: &Arc<rustls::ClientConfig>,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut current_url = initial_url.to_string();

    for redirect_count in 0..=MAX_REDIRECTS {
        let parsed = parse_http_url(&current_url)?;
        let mut resp = open_http_stream(&parsed, tls_config, deadline)?;
        let head = read_http_head(&mut resp, deadline)?;

        if matches!(head.status, 301 | 302 | 303 | 307 | 308) {
            if redirect_count == MAX_REDIRECTS {
                return Err("too many HTTP redirects".to_string());
            }
            let location = head
                .location
                .ok_or_else(|| format!("redirect HTTP {} missing Location header", head.status))?;
            let next_url = resolve_redirect_url(&parsed, &location)?;
            if parsed.is_tls && next_url.to_ascii_lowercase().starts_with("http://") {
                return Err("refusing HTTPS to HTTP redirect downgrade".to_string());
            }
            current_url = next_url;
            continue;
        }

        if head.status != 200 {
            return Err(format!("HTTP download returned status {}", head.status));
        }
        if head.gzip_encoded {
            return Err("unexpected Content-Encoding on binary download".to_string());
        }
        if let Some(len) = head.content_length {
            if len > MAX_BINARY_BYTES {
                return Err(format!(
                    "binary Content-Length {len} exceeds {} byte limit",
                    MAX_BINARY_BYTES
                ));
            }
        }

        stream_http_body_and_verify(
            &mut resp,
            &head.leftover,
            head.chunked,
            head.content_length,
            dest_path,
            expected_sha256,
            deadline,
        )?;
        return Ok(());
    }

    Err("too many HTTP redirects".to_string())
}

enum HttpStream {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl HttpStream {
    fn set_deadline_timeout(&mut self, deadline: Instant) -> Result<(), String> {
        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() {
            return Err("update download timed out".to_string());
        }
        let sock = match self {
            Self::Plain(s) => s,
            Self::Tls(tls) => &tls.sock,
        };
        sock.set_read_timeout(Some(rem))
            .map_err(|e| format!("set_read_timeout failed: {e}"))?;
        sock.set_write_timeout(Some(rem))
            .map_err(|e| format!("set_write_timeout failed: {e}"))?;
        Ok(())
    }
}

impl Read for HttpStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(s) => s.read(buf),
            Self::Tls(tls) => tls.read(buf),
        }
    }
}

impl Write for HttpStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(s) => s.write(buf),
            Self::Tls(tls) => tls.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(s) => s.flush(),
            Self::Tls(tls) => tls.flush(),
        }
    }
}

fn open_http_stream(
    url: &ParsedHttpUrl,
    tls_config: &Arc<rustls::ClientConfig>,
    deadline: Instant,
) -> Result<HttpStream, String> {
    let addrs: Vec<SocketAddr> = (url.host.as_str(), url.port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS resolution failed for {}:{}: {e}", url.host, url.port))?
        .collect();
    if addrs.is_empty() {
        return Err(format!(
            "no addresses resolved for {}:{}",
            url.host, url.port
        ));
    }

    let mut tcp = None;
    let mut last_err = None;
    for addr in addrs {
        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() {
            return Err("update download timed out during connect".to_string());
        }
        match TcpStream::connect_timeout(&addr, rem.min(Duration::from_secs(15))) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }

    let tcp = tcp.ok_or_else(|| {
        format!(
            "TCP connect to {}:{} failed: {}",
            url.host,
            url.port,
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )
    })?;
    let _ = tcp.set_nodelay(true);

    let mut stream = if url.is_tls {
        let server_name = ServerName::try_from(url.host.clone())
            .map_err(|e| format!("invalid TLS server name '{}': {e}", url.host))?;
        let conn = rustls::ClientConnection::new(tls_config.clone(), server_name)
            .map_err(|e| format!("TLS connection init failed: {e}"))?;
        HttpStream::Tls(Box::new(rustls::StreamOwned::new(conn, tcp)))
    } else {
        HttpStream::Plain(tcp)
    };

    stream.set_deadline_timeout(deadline)?;
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: uniob-agent/{}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
        url.request_target,
        url.host_header,
        env!("CARGO_PKG_VERSION")
    );
    stream
        .write_all(req.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|e| format!("failed to send HTTP request: {e}"))?;

    Ok(stream)
}

struct HttpHead {
    status: u16,
    content_length: Option<u64>,
    chunked: bool,
    gzip_encoded: bool,
    location: Option<String>,
    leftover: Vec<u8>,
}

fn read_http_head(stream: &mut HttpStream, deadline: Instant) -> Result<HttpHead, String> {
    let mut raw = Vec::with_capacity(1024);
    let mut tmp = [0u8; 2048];
    let header_end;

    loop {
        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos;
            break;
        }
        if raw.len() >= MAX_HEADER_BYTES {
            return Err("HTTP response headers exceed limit".to_string());
        }
        stream.set_deadline_timeout(deadline)?;
        let n = stream
            .read(&mut tmp)
            .map_err(|e| format!("failed reading HTTP headers: {e}"))?;
        if n == 0 {
            return Err("unexpected EOF while reading HTTP headers".to_string());
        }
        raw.extend_from_slice(&tmp[..n]);
    }

    let head_str = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| "HTTP response headers are not valid UTF-8".to_string())?;
    let leftover = raw[header_end + 4..].to_vec();

    let mut lines = head_str.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "empty HTTP response".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("malformed HTTP status line: {status_line}"))?;

    let mut content_length = None;
    let mut chunked = false;
    let mut gzip_encoded = false;
    let mut location = None;

    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let val = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = val
                .parse::<u64>()
                .map_err(|_| format!("invalid Content-Length header: {val}"))?;
            content_length = Some(parsed);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if val.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        } else if name.eq_ignore_ascii_case("content-encoding") {
            let lower = val.to_ascii_lowercase();
            if !lower.is_empty() && lower != "identity" {
                gzip_encoded = true;
            }
        } else if name.eq_ignore_ascii_case("location") {
            location = Some(val.to_string());
        }
    }

    Ok(HttpHead {
        status,
        content_length,
        chunked,
        gzip_encoded,
        location,
        leftover,
    })
}

struct BodySink {
    writer: BufWriter<File>,
    hasher: Sha256,
    magic: [u8; 4],
    total_bytes: u64,
}

impl BodySink {
    fn new(dest_path: &Path) -> Result<Self, String> {
        let file = File::create(dest_path)
            .map_err(|e| format!("failed to create {}: {e}", dest_path.display()))?;
        Ok(Self {
            writer: BufWriter::with_capacity(READ_CHUNK_BYTES, file),
            hasher: Sha256::new(),
            magic: [0u8; 4],
            total_bytes: 0,
        })
    }

    fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let next_total = self
            .total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "binary size overflow".to_string())?;
        if next_total > MAX_BINARY_BYTES {
            return Err(format!(
                "downloaded binary exceeds {} byte limit",
                MAX_BINARY_BYTES
            ));
        }

        let prev_len = self.total_bytes as usize;
        if prev_len < 4 {
            let take = (4 - prev_len).min(bytes.len());
            self.magic[prev_len..prev_len + take].copy_from_slice(&bytes[..take]);
            if prev_len + take == 4 && self.magic != ELF_MAGIC {
                return Err("downloaded payload is not a valid ELF executable".to_string());
            }
        }

        self.writer
            .write_all(bytes)
            .map_err(|e| format!("failed writing staged binary: {e}"))?;
        self.hasher.update(bytes);
        self.total_bytes = next_total;
        Ok(())
    }

    fn finish(mut self, expected_sha256: &str) -> Result<(), String> {
        if self.total_bytes < 4 || self.magic != ELF_MAGIC {
            return Err("downloaded payload is not a valid ELF executable".to_string());
        }
        self.writer
            .flush()
            .map_err(|e| format!("failed flushing staged binary: {e}"))?;
        let file = self
            .writer
            .into_inner()
            .map_err(|e| format!("failed finalizing buffered writer: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("failed syncing staged binary: {e}"))?;

        let actual = self.hasher.finalize_hex();
        if !constant_time_eq(actual.as_bytes(), expected_sha256.as_bytes()) {
            return Err(format!(
                "downloaded binary sha256 mismatch: expected {expected_sha256}, got {actual}"
            ));
        }
        Ok(())
    }
}

struct BufferedReader<'a> {
    stream: &'a mut HttpStream,
    buf: Vec<u8>,
    pos: usize,
    deadline: Instant,
}

impl<'a> BufferedReader<'a> {
    fn new(stream: &'a mut HttpStream, leftover: Vec<u8>, deadline: Instant) -> Self {
        Self {
            stream,
            buf: leftover,
            pos: 0,
            deadline,
        }
    }

    fn read_more(&mut self) -> Result<usize, String> {
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        let mut tmp = [0u8; READ_CHUNK_BYTES];
        self.stream.set_deadline_timeout(self.deadline)?;
        let n = self
            .stream
            .read(&mut tmp)
            .map_err(|e| format!("failed reading HTTP body: {e}"))?;
        if n > 0 {
            self.buf.extend_from_slice(&tmp[..n]);
        }
        Ok(n)
    }

    fn read_line_crlf(&mut self, max_len: usize) -> Result<String, String> {
        loop {
            let slice = &self.buf[self.pos..];
            if let Some(idx) = slice.windows(2).position(|w| w == b"\r\n") {
                let line = std::str::from_utf8(&slice[..idx])
                    .map_err(|_| "invalid UTF-8 in chunked HTTP header".to_string())?
                    .to_string();
                self.pos += idx + 2;
                return Ok(line);
            }
            if slice.len() > max_len {
                return Err("chunked HTTP line exceeds limit".to_string());
            }
            if self.read_more()? == 0 {
                return Err("unexpected EOF in chunked HTTP body".to_string());
            }
        }
    }

    fn read_exact_to_sink(
        &mut self,
        mut remaining: usize,
        sink: &mut BodySink,
    ) -> Result<(), String> {
        while remaining > 0 {
            if self.pos < self.buf.len() {
                let avail = &self.buf[self.pos..];
                let take = avail.len().min(remaining);
                sink.write_chunk(&avail[..take])?;
                self.pos += take;
                remaining -= take;
            } else if self.read_more()? == 0 {
                return Err("unexpected EOF while reading HTTP chunk".to_string());
            }
        }
        Ok(())
    }

    fn consume_crlf(&mut self) -> Result<(), String> {
        while self.buf.len() - self.pos < 2 {
            if self.read_more()? == 0 {
                return Err("unexpected EOF after HTTP chunk".to_string());
            }
        }
        if &self.buf[self.pos..self.pos + 2] != b"\r\n" {
            return Err("malformed HTTP chunk terminator".to_string());
        }
        self.pos += 2;
        Ok(())
    }
}

fn stream_http_body_and_verify(
    stream: &mut HttpStream,
    leftover: &[u8],
    chunked: bool,
    content_length: Option<u64>,
    dest_path: &Path,
    expected_sha256: &str,
    deadline: Instant,
) -> Result<(), String> {
    let mut sink = BodySink::new(dest_path)?;

    if chunked {
        let mut br = BufferedReader::new(stream, leftover.to_vec(), deadline);
        loop {
            let size_line = br.read_line_crlf(128)?;
            let size_hex = size_line.split(';').next().unwrap_or("").trim();
            let chunk_size = usize::from_str_radix(size_hex, 16)
                .map_err(|_| format!("invalid HTTP chunk size '{size_line}'"))?;
            if chunk_size == 0 {
                break;
            }
            br.read_exact_to_sink(chunk_size, &mut sink)?;
            br.consume_crlf()?;
        }
    } else {
        let mut written = 0u64;
        if !leftover.is_empty() {
            let take = match content_length {
                Some(len) => (leftover.len() as u64).min(len.saturating_sub(written)) as usize,
                None => leftover.len(),
            };
            sink.write_chunk(&leftover[..take])?;
            written += take as u64;
        }

        let mut buf = [0u8; READ_CHUNK_BYTES];
        while content_length.is_none_or(|len| written < len) {
            stream.set_deadline_timeout(deadline)?;
            let n = stream
                .read(&mut buf)
                .map_err(|e| format!("failed reading HTTP body: {e}"))?;
            if n == 0 {
                break;
            }
            let take = match content_length {
                Some(len) => (n as u64).min(len.saturating_sub(written)) as usize,
                None => n,
            };
            sink.write_chunk(&buf[..take])?;
            written += take as u64;
        }

        if let Some(len) = content_length {
            if written != len {
                return Err(format!(
                    "truncated HTTP body: expected {len} bytes, got {written}"
                ));
            }
        }
    }

    sink.finish(expected_sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn unique_test_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "uniob_update_test_{label}_{}_{}",
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn build_tls() -> Arc<rustls::ClientConfig> {
        let mut store = rustls::RootCertStore::empty();
        store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        Arc::new(
            rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(store)
                .with_no_client_auth(),
        )
    }

    fn fake_elf_payload(extra: &[u8]) -> (Vec<u8>, String) {
        let mut bytes = ELF_MAGIC.to_vec();
        bytes.extend_from_slice(extra);
        let hex = sha256_hex(&bytes);
        (bytes, hex)
    }

    fn sign_directive(
        token: &str,
        node_id: &str,
        version: &str,
        sha256: &str,
        issued_at: u64,
        url: &str,
        fallback_url: Option<&str>,
    ) -> UpdateDirective {
        let hmac = compute_update_hmac_hex(
            token,
            node_id,
            version,
            sha256,
            issued_at,
            url,
            fallback_url,
        );
        UpdateDirective {
            version: version.to_string(),
            sha256: sha256.to_string(),
            url: url.to_string(),
            fallback_url: fallback_url.map(ToString::to_string),
            issued_at,
            hmac,
        }
    }

    #[test]
    fn directive_validation_enforces_hmac_scheme_skew_and_monotonic_issued_at() {
        let (_bytes, sha) = fake_elf_payload(b"hello-world");
        let now = 1_763_128_000u64;
        let valid = sign_directive(
            "secret-tok",
            "nd-1",
            "0.2.1",
            &sha,
            now,
            "https://example.com/uniob-agent",
            Some("https://backup.example.com/uniob-agent"),
        );
        assert!(validate_directive(&valid, "nd-1", "secret-tok", now + 60, now - 10).is_ok());

        let mut bad_hmac = valid.clone();
        bad_hmac.hmac = "0".repeat(64);
        assert!(validate_directive(&bad_hmac, "nd-1", "secret-tok", now, 0).is_err());

        let bad_scheme = sign_directive(
            "secret-tok",
            "nd-1",
            "0.2.1",
            &sha,
            now,
            "ftp://example.com/uniob-agent",
            None,
        );
        assert!(validate_directive(&bad_scheme, "nd-1", "secret-tok", now, 0).is_err());

        assert!(validate_directive(&valid, "nd-1", "secret-tok", now + 901, 0).is_err());
        assert!(validate_directive(&valid, "nd-1", "secret-tok", now, now).is_err());
        // Pre-1_700_000_000 unsynced local clock skips skew check
        assert!(validate_directive(&valid, "nd-1", "secret-tok", 1000, 0).is_ok());
    }

    #[test]
    fn http_redirect_chunked_fallback_and_verify_staged_update_work_end_to_end() {
        let (payload, sha) = fake_elf_payload(b"streamed-elf-binary-payload-v0.2.1");

        let redirect_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_addr = redirect_listener.local_addr().unwrap();
        let cdn_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let cdn_addr = cdn_listener.local_addr().unwrap();

        let t1 = std::thread::spawn(move || {
            let (mut s, _) = redirect_listener.accept().unwrap();
            let mut req_buf = [0u8; 1024];
            let _ = s.read(&mut req_buf);
            let resp = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{cdn_addr}/cdn/bin\r\nContent-Length: 0\r\n\r\n"
            );
            s.write_all(resp.as_bytes()).unwrap();
        });

        let payload_clone = payload.clone();
        let t2 = std::thread::spawn(move || {
            let (mut s, _) = cdn_listener.accept().unwrap();
            let mut req_buf = [0u8; 1024];
            let _ = s.read(&mut req_buf);
            let split = 5usize;
            let c1 = &payload_clone[..split];
            let c2 = &payload_clone[split..];
            s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            s.write_all(format!("{:x}\r\n", c1.len()).as_bytes())
                .unwrap();
            s.write_all(c1).unwrap();
            s.write_all(b"\r\n").unwrap();
            s.write_all(format!("{:x}\r\n", c2.len()).as_bytes())
                .unwrap();
            s.write_all(c2).unwrap();
            s.write_all(b"\r\n0\r\n\r\n").unwrap();
        });

        let dead_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };

        let dir = unique_test_dir("stage_ok");
        let fallback_url = format!("http://{redirect_addr}/release/agent");
        let directive = sign_directive(
            "tok_update",
            "nd_update",
            "0.2.1",
            &sha,
            1_763_128_000,
            &format!("http://127.0.0.1:{dead_port}/unreachable"),
            Some(&fallback_url),
        );

        let tls = build_tls();
        download_and_stage_directive(&directive, &dir, &tls).unwrap();
        t1.join().unwrap();
        t2.join().unwrap();

        assert!(verify_staged_update("nd_update", "tok_update", &dir).is_ok());

        // Corrupt binary -> verification must fail
        fs::write(staged_bin_path(&dir), b"\x7fELFcorrupted").unwrap();
        assert!(verify_staged_update("nd_update", "tok_update", &dir).is_err());

        // Non-ELF payload rejected cleanly
        fs::write(staged_bin_path(&dir), b"#!/bin/sh\necho nope\n").unwrap();
        assert!(verify_staged_update("nd_update", "tok_update", &dir).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_elf_http_download_is_rejected_before_staging() {
        let bad_bytes = b"not-an-elf-binary".to_vec();
        let bad_sha = sha256_hex(&bad_bytes);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let t = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req_buf = [0u8; 1024];
            let _ = s.read(&mut req_buf);
            let hdr = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                bad_bytes.len()
            );
            s.write_all(hdr.as_bytes()).unwrap();
            s.write_all(&bad_bytes).unwrap();
        });

        let dir = unique_test_dir("non_elf");
        let directive = sign_directive(
            "tok",
            "nd",
            "0.2.1",
            &bad_sha,
            1_763_128_000,
            &format!("http://{addr}/bin"),
            None,
        );
        let res = download_and_stage_directive(&directive, &dir, &build_tls());
        t.join().unwrap();
        assert!(res.is_err());
        assert!(!ready_manifest_path(&dir).exists());
        assert!(!staged_bin_path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_runtime_reports_completion_idle_or_rollback_error_on_boot() {
        let dir = unique_test_dir("boot_transition");
        let cfg = Config::from_toml_str(
            "[server]\nurl='wss://example.com'\nnode_id='nd_boot'\ntoken='tok_boot'\n",
        )
        .unwrap();
        let tls = build_tls();

        // Simulate previous session staged env!("CARGO_PKG_VERSION") -> now upgraded
        save_persisted_state(
            &dir,
            &PersistedUpdateState {
                last_issued_at: 100,
                pending_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                pending_sha256: Some("a".repeat(64)),
            },
        );
        let mut rt = UpdateRuntime::init(&cfg, &dir, tls.clone());
        let rep = rt
            .pending_report()
            .expect("should emit idle transition once");
        assert_eq!(rep.st, "idle");
        assert_eq!(rep.ver.as_deref(), Some(env!("CARGO_PKG_VERSION")));
        rt.mark_reported(rep);
        assert!(rt.pending_report().is_none());

        // Simulate previous session staged another version, ready.json vanished, still old binary -> rollback error
        save_persisted_state(
            &dir,
            &PersistedUpdateState {
                last_issued_at: 200,
                pending_version: Some("9.9.9".to_string()),
                pending_sha256: Some("b".repeat(64)),
            },
        );
        let rt_err = UpdateRuntime::init(&cfg, &dir, tls);
        let rep_err = rt_err.pending_report().expect("should emit error");
        assert_eq!(rep_err.st, "error");
        assert_eq!(rep_err.ver.as_deref(), Some("9.9.9"));

        let _ = fs::remove_dir_all(&dir);
    }
}
