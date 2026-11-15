use crate::crypto::{constant_time_eq, hmac_sha256_hex, sha256_hex};
use crate::protocol::MigrateDirective;
use serde::Deserialize;
use std::fs;
use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tungstenite::http::Uri;

pub const DEFAULT_STATE_DIR: &str = "/var/lib/uniob";
pub const OVERRIDE_FILENAME: &str = "endpoint_override.toml";
pub const MIGRATE_MAX_CLOCK_SKEW_SEC: u64 = 600;
pub const CANARY_CTRL_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEAD_HUB_MAX_ELAPSED: Duration = Duration::from_secs(300);
pub const DEAD_HUB_MAX_RETRIES: u32 = 10;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EndpointOverride {
    pub url: String,
    #[serde(default)]
    pub fallback_url: Option<String>,
    pub epoch: u64,
}

fn escape_toml_basic_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl EndpointOverride {
    pub fn to_toml_string(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("url = {}\n", escape_toml_basic_str(&self.url)));
        if let Some(ref fb) = self.fallback_url {
            out.push_str(&format!("fallback_url = {}\n", escape_toml_basic_str(fb)));
        }
        out.push_str(&format!("epoch = {}\n", self.epoch));
        out
    }

    pub fn from_toml_str(raw: &str) -> Result<Self, String> {
        let parsed: EndpointOverride =
            toml::from_str(raw).map_err(|e| format!("invalid endpoint_override.toml: {e}"))?;
        if parsed.url.trim().is_empty() {
            return Err("endpoint_override.toml url must not be empty".to_string());
        }
        Ok(parsed)
    }
}

pub fn override_file_path(state_dir: &Path) -> PathBuf {
    state_dir.join(OVERRIDE_FILENAME)
}

pub fn save_override_atomic(state_dir: &Path, ovr: &EndpointOverride) -> Result<(), String> {
    fs::create_dir_all(state_dir)
        .map_err(|e| format!("failed to create state dir {}: {e}", state_dir.display()))?;

    let target = override_file_path(state_dir);
    let tmp = state_dir.join(format!(".{OVERRIDE_FILENAME}.tmp.{}", std::process::id()));

    let body = ovr.to_toml_string();
    let write_res = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "failed to write temp override {}: {e}",
            tmp.display()
        ));
    }

    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "failed to rename {} -> {}: {e}",
            tmp.display(),
            target.display()
        ));
    }

    Ok(())
}

pub fn clear_override_file(state_dir: &Path) {
    let target = override_file_path(state_dir);
    if let Err(e) = fs::remove_file(&target) {
        if e.kind() != io::ErrorKind::NotFound {
            eprintln!("warning: failed to remove {}: {e}", target.display());
        }
    }
}

pub fn is_forbidden_ipv4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback() // 127.0.0.0/8
        || v4.is_private() // 10/8, 172.16/12, 192.168/16
        || v4.is_link_local() // 169.254.0.0/16
        || v4.is_unspecified() // 0.0.0.0
        || o[0] == 0 // 0.0.0.0/8 "this network"
        || v4.is_multicast() // 224.0.0.0/4
        || v4.is_broadcast() // 255.255.255.255
        || v4.is_documentation() // 192.0.2/24, 198.51.100/24, 203.0.113/24
        || (o[0] == 100 && (o[1] & 0b1100_0000) == 64) // CGNAT 100.64.0.0/10
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // Benchmarking 198.18.0.0/15
        || o[0] >= 240 // Reserved 240.0.0.0/4
}

pub fn is_forbidden_ipv6(v6: Ipv6Addr) -> bool {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_forbidden_ipv4(v4);
    }
    let segs = v6.segments();
    // IPv4-compatible IPv6 ::a.b.c.d (excluding :: and ::1 which are caught below)
    if segs[0..6] == [0, 0, 0, 0, 0, 0] && (segs[6] != 0 || segs[7] > 1) {
        if let Some(v4) = v6.to_ipv4() {
            return is_forbidden_ipv4(v4);
        }
    }

    v6.is_loopback() // ::1
        || v6.is_unspecified() // ::
        || v6.is_multicast() // ff00::/8
        || (segs[0] & 0xffc0) == 0xfe80 // Link-local fe80::/10
        || (segs[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
        || (segs[0] & 0xffc0) == 0xfec0 // Deprecated site-local fec0::/10
        || (segs[0] == 0x2001 && segs[1] == 0x0db8) // Documentation 2001:db8::/32
}

pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_ipv4(v4),
        IpAddr::V6(v6) => is_forbidden_ipv6(v6),
    }
}

pub fn is_forbidden_hostname(raw_host: &str) -> bool {
    let stripped = raw_host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    if stripped.is_empty() || stripped.contains('%') {
        return true;
    }

    let lower = stripped.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower == "localhost.localdomain"
        || lower == "ip6-localhost"
        || lower == "ip6-loopback"
    {
        return true;
    }

    if let Ok(ip) = stripped.parse::<IpAddr>() {
        return is_forbidden_ip(ip);
    }

    false
}

pub fn parse_and_check_ws_url(
    raw_url: &str,
    allow_insecure_ws: bool,
) -> Result<(Uri, String, u16, bool), String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err("migration URL must not be empty".to_string());
    }

    let uri: Uri = trimmed
        .parse()
        .map_err(|e| format!("invalid migration URL '{trimmed}': {e}"))?;

    let is_tls = match uri.scheme_str().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("wss") => true,
        Some("ws") if allow_insecure_ws => false,
        Some("ws") => {
            return Err("insecure ws:// migration URL rejected (use wss://)".to_string());
        }
        other => {
            return Err(format!("unsupported migration URL scheme: {other:?}"));
        }
    };

    let raw_host = uri
        .host()
        .ok_or_else(|| "migration URL missing host".to_string())?;
    let host = if raw_host.starts_with('[') && raw_host.ends_with(']') {
        raw_host[1..raw_host.len() - 1].to_string()
    } else {
        raw_host.to_string()
    };
    if host.is_empty() {
        return Err("migration URL missing host".to_string());
    }

    if !allow_insecure_ws && is_forbidden_hostname(&host) {
        return Err(format!("SSRF guard rejected forbidden host '{host}'"));
    }

    let port = uri.port_u16().unwrap_or(if is_tls { 443 } else { 80 });
    Ok((uri, host, port, is_tls))
}

pub fn validate_and_resolve_ws_url_with<F>(
    raw_url: &str,
    allow_insecure_ws: bool,
    resolver: F,
) -> Result<(Uri, bool, Vec<SocketAddr>), String>
where
    F: FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
{
    let (uri, host, port, is_tls) = parse_and_check_ws_url(raw_url, allow_insecure_ws)?;
    let addrs = resolver(&host, port)
        .map_err(|e| format!("DNS resolution failed for {host}:{port}: {e}"))?;
    if addrs.is_empty() {
        return Err(format!("no addresses resolved for {host}:{port}"));
    }

    if !allow_insecure_ws {
        for addr in &addrs {
            if is_forbidden_ip(addr.ip()) {
                return Err(format!(
                    "SSRF guard rejected resolved IP {} for host '{host}'",
                    addr.ip()
                ));
            }
        }
    }

    Ok((uri, is_tls, addrs))
}

pub fn validate_and_resolve_ws_url(
    raw_url: &str,
    allow_insecure_ws: bool,
) -> Result<(Uri, bool, Vec<SocketAddr>), String> {
    validate_and_resolve_ws_url_with(raw_url, allow_insecure_ws, |host, port| {
        Ok((host, port).to_socket_addrs()?.collect())
    })
}

pub fn compute_migrate_hmac_hex(token: &str, node_id: &str, epoch: u64, url: &str) -> String {
    let key_hex = sha256_hex(token.as_bytes());
    let msg = format!("{node_id}:{epoch}:{url}");
    hmac_sha256_hex(key_hex.as_bytes(), msg.as_bytes())
}

pub fn verify_migrate_directive_with<F>(
    directive: &MigrateDirective,
    node_id: &str,
    token: &str,
    now_sec: u64,
    last_applied_epoch: u64,
    allow_insecure_ws: bool,
    resolver: F,
) -> Result<(Uri, bool, Vec<SocketAddr>), String>
where
    F: FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
{
    if now_sec.abs_diff(directive.epoch) > MIGRATE_MAX_CLOCK_SKEW_SEC {
        return Err(format!(
            "migrate epoch {} outside +/-{}s window of now {}",
            directive.epoch, MIGRATE_MAX_CLOCK_SKEW_SEC, now_sec
        ));
    }

    if directive.epoch <= last_applied_epoch {
        return Err(format!(
            "migrate epoch {} is not strictly newer than last_applied_epoch {}",
            directive.epoch, last_applied_epoch
        ));
    }

    let expected_sig = compute_migrate_hmac_hex(token, node_id, directive.epoch, &directive.url);
    let provided_sig = directive.sig.trim().to_ascii_lowercase();
    if provided_sig.len() != 64
        || !constant_time_eq(expected_sig.as_bytes(), provided_sig.as_bytes())
    {
        return Err("migrate HMAC-SHA256 signature verification failed".to_string());
    }

    if let Some(ref fb) = directive.fallback_url {
        parse_and_check_ws_url(fb, allow_insecure_ws)?;
    }

    validate_and_resolve_ws_url_with(&directive.url, allow_insecure_ws, resolver)
}

pub fn verify_migrate_directive(
    directive: &MigrateDirective,
    node_id: &str,
    token: &str,
    now_sec: u64,
    last_applied_epoch: u64,
    allow_insecure_ws: bool,
) -> Result<(Uri, bool, Vec<SocketAddr>), String> {
    verify_migrate_directive_with(
        directive,
        node_id,
        token,
        now_sec,
        last_applied_epoch,
        allow_insecure_ws,
        |host, port| Ok((host, port).to_socket_addrs()?.collect()),
    )
}

pub fn load_override(state_dir: &Path, allow_insecure_ws: bool) -> Option<EndpointOverride> {
    let path = override_file_path(state_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("warning: failed to read {}: {e}", path.display());
            return None;
        }
    };

    let ovr = match EndpointOverride::from_toml_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("warning: ignoring {}: {e}", path.display());
            return None;
        }
    };

    if let Err(e) = parse_and_check_ws_url(&ovr.url, allow_insecure_ws) {
        eprintln!("warning: ignoring endpoint override URL '{}': {e}", ovr.url);
        return None;
    }

    if let Some(ref fb) = ovr.fallback_url {
        if let Err(e) = parse_and_check_ws_url(fb, allow_insecure_ws) {
            eprintln!("warning: ignoring endpoint override fallback_url '{fb}': {e}");
            return None;
        }
    }

    Some(ovr)
}

#[derive(Debug, Clone)]
pub struct MigrationState {
    pub state_dir: PathBuf,
    pub allow_insecure_ws: bool,
    pub active_override: Option<EndpointOverride>,
    pub last_applied_epoch: u64,
    pub override_consecutive_failures: u32,
    pub override_first_failure_at: Option<Instant>,
}

impl MigrationState {
    pub fn init(state_dir: PathBuf, allow_insecure_ws: bool) -> Self {
        let active_override = load_override(&state_dir, allow_insecure_ws);
        let last_applied_epoch = active_override.as_ref().map(|o| o.epoch).unwrap_or(0);
        Self {
            state_dir,
            allow_insecure_ws,
            active_override,
            last_applied_epoch,
            override_consecutive_failures: 0,
            override_first_failure_at: None,
        }
    }

    pub fn current_url<'a>(&'a self, bootstrap_url: &'a str) -> &'a str {
        self.active_override
            .as_ref()
            .map(|o| o.url.as_str())
            .unwrap_or(bootstrap_url)
    }

    pub fn current_migrated_epoch(&self) -> Option<u64> {
        self.active_override.as_ref().map(|o| o.epoch)
    }

    pub fn is_using_override(&self) -> bool {
        self.active_override.is_some()
    }

    /// Commits a successful canary migration in memory and attempts atomic persistence.
    /// Returns `Err(reason)` if disk persistence failed (read-only state dir), while
    /// preserving the in-memory active override and epoch.
    pub fn commit_override(&mut self, ovr: EndpointOverride) -> Result<(), String> {
        self.last_applied_epoch = ovr.epoch;
        self.active_override = Some(ovr.clone());
        self.override_consecutive_failures = 0;
        self.override_first_failure_at = None;
        save_override_atomic(&self.state_dir, &ovr)
    }

    pub fn record_override_success(&mut self) {
        self.override_consecutive_failures = 0;
        self.override_first_failure_at = None;
    }

    /// Records a consecutive failure against the active override URL.
    /// Returns `true` when dead-hub fallback threshold (`>= 10` retries or `>= 300s`)
    /// is reached and the override is cleared back to bootstrap `server.url`.
    pub fn record_override_failure(&mut self, now: Instant) -> bool {
        if self.active_override.is_none() {
            return false;
        }
        self.override_consecutive_failures = self.override_consecutive_failures.saturating_add(1);
        let first = *self.override_first_failure_at.get_or_insert(now);
        let elapsed = now.saturating_duration_since(first);

        if self.override_consecutive_failures >= DEAD_HUB_MAX_RETRIES
            || elapsed >= DEAD_HUB_MAX_ELAPSED
        {
            self.active_override = None;
            self.override_consecutive_failures = 0;
            self.override_first_failure_at = None;
            clear_override_file(&self.state_dir);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "uniob_agent_test_{label}_{}_{}",
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn public_dns_stub(_host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        Ok(vec![SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)),
            port,
        )])
    }

    #[test]
    fn override_toml_atomic_write_load_and_readonly_fallback() {
        let dir = unique_temp_dir("atomic");
        let ovr = EndpointOverride {
            url: "wss://hub2.example.com/api/agent/ws".to_string(),
            fallback_url: Some("wss://hub1.example.com/api/agent/ws".to_string()),
            epoch: 1763128000,
        };

        let mut state = MigrationState::init(dir.clone(), false);
        assert!(state.active_override.is_none());
        assert_eq!(
            state.current_url("wss://boot.example.com/api/agent/ws"),
            "wss://boot.example.com/api/agent/ws"
        );

        state.commit_override(ovr.clone()).unwrap();
        assert_eq!(state.last_applied_epoch, 1763128000);
        assert_eq!(state.active_override.as_ref(), Some(&ovr));

        let reloaded = MigrationState::init(dir.clone(), false);
        assert_eq!(reloaded.active_override.as_ref(), Some(&ovr));
        assert_eq!(reloaded.last_applied_epoch, 1763128000);

        // Read-only state dir simulation: point state_dir at an existing regular file so
        // create_dir_all / file write fails, and verify in-memory override still takes effect!
        let blocking_file = dir.join("readonly_blocker");
        fs::write(&blocking_file, b"not a directory").unwrap();
        let mut ro_state = MigrationState::init(blocking_file, false);
        let ro_res = ro_state.commit_override(ovr.clone());
        assert!(ro_res.is_err());
        assert_eq!(ro_state.active_override.as_ref(), Some(&ovr));
        assert_eq!(ro_state.last_applied_epoch, 1763128000);
        assert_eq!(
            ro_state.current_url("wss://boot.example.com/api/agent/ws"),
            "wss://hub2.example.com/api/agent/ws"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ssrf_guard_rejects_private_loopback_cgnat_ula_link_local_and_resolved_ips() {
        let forbidden_urls = [
            "ws://hub.example.com/api/agent/ws",
            "wss://localhost/api/agent/ws",
            "wss://sub.localhost/api/agent/ws",
            "wss://localhost.localdomain/api/agent/ws",
            "wss://127.0.0.1/api/agent/ws",
            "wss://10.0.0.5/api/agent/ws",
            "wss://172.16.10.2/api/agent/ws",
            "wss://192.168.1.50/api/agent/ws",
            "wss://169.254.169.254/latest/meta-data",
            "wss://100.64.0.1/api/agent/ws",
            "wss://100.127.255.254/api/agent/ws",
            "wss://0.0.0.0/api/agent/ws",
            "wss://224.0.0.1/api/agent/ws",
            "wss://[::1]/api/agent/ws",
            "wss://[::]/api/agent/ws",
            "wss://[fe80::1]/api/agent/ws",
            "wss://[fc00::1]/api/agent/ws",
            "wss://[fd12:3456::1]/api/agent/ws",
            "wss://[ff02::1]/api/agent/ws",
            "wss://[::ffff:127.0.0.1]/api/agent/ws",
            "wss://[::ffff:10.0.0.1]/api/agent/ws",
        ];

        for bad in forbidden_urls {
            let res = validate_and_resolve_ws_url_with(bad, false, public_dns_stub);
            assert!(res.is_err(), "expected SSRF guard to reject {bad}");
        }

        // Hostname looks public, but DNS resolves to private / link-local / ULA IP -> rejected!
        for private_ip in [
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::new(100, 100, 1, 1)),
            IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1)),
        ] {
            let res = validate_and_resolve_ws_url_with(
                "wss://rebind.example.com/api/agent/ws",
                false,
                |_host, port| Ok(vec![SocketAddr::new(private_ip, port)]),
            );
            assert!(
                res.is_err(),
                "expected resolved IP {private_ip} to be rejected"
            );
        }

        // Public IP passes cleanly
        assert!(validate_and_resolve_ws_url_with(
            "wss://hub2.example.com/api/agent/ws",
            false,
            public_dns_stub
        )
        .is_ok());
    }

    #[test]
    fn migrate_directive_validates_hmac_clock_skew_and_epoch_replay() {
        let token = "uob_live_secret_token";
        let node_id = "nd_abc123";
        let now_sec = 1_763_128_000u64;
        let url = "wss://hub2.example.com/api/agent/ws";
        let sig = compute_migrate_hmac_hex(token, node_id, now_sec, url);

        let valid = MigrateDirective {
            url: url.to_string(),
            fallback_url: None,
            epoch: now_sec,
            sig: sig.clone(),
        };
        assert!(verify_migrate_directive_with(
            &valid,
            node_id,
            token,
            now_sec + 100,
            0,
            false,
            public_dns_stub
        )
        .is_ok());

        // Replay: epoch <= last_applied_epoch
        assert!(verify_migrate_directive_with(
            &valid,
            node_id,
            token,
            now_sec,
            now_sec,
            false,
            public_dns_stub
        )
        .is_err());

        // Expired / excessive skew > 600s
        assert!(verify_migrate_directive_with(
            &valid,
            node_id,
            token,
            now_sec + 601,
            0,
            false,
            public_dns_stub
        )
        .is_err());

        // Bad HMAC
        let mut bad_sig = valid.clone();
        bad_sig.sig = "0".repeat(64);
        assert!(verify_migrate_directive_with(
            &bad_sig,
            node_id,
            token,
            now_sec,
            0,
            false,
            public_dns_stub
        )
        .is_err());

        // Wrong node_id cannot reuse signature
        assert!(verify_migrate_directive_with(
            &valid,
            "nd_other",
            token,
            now_sec,
            0,
            false,
            public_dns_stub
        )
        .is_err());
    }

    #[test]
    fn dead_hub_auto_fallback_triggers_after_10_retries_or_300_seconds() {
        let dir = unique_temp_dir("deadhub");
        let ovr = EndpointOverride {
            url: "wss://hub2.example.com/api/agent/ws".to_string(),
            fallback_url: None,
            epoch: 1763128000,
        };

        // Case 1: >= 10 retries
        let mut s1 = MigrationState::init(dir.clone(), false);
        s1.commit_override(ovr.clone()).unwrap();
        assert!(override_file_path(&dir).exists());

        let t0 = Instant::now();
        for i in 1..=9 {
            assert!(!s1.record_override_failure(t0 + Duration::from_secs(i)));
            assert!(s1.is_using_override());
        }
        assert!(s1.record_override_failure(t0 + Duration::from_secs(10)));
        assert!(!s1.is_using_override());
        assert!(!override_file_path(&dir).exists());
        assert_eq!(s1.last_applied_epoch, 1763128000);

        // Case 2: >= 300s elapsed
        let mut s2 = MigrationState::init(dir.clone(), false);
        s2.commit_override(ovr).unwrap();
        assert!(!s2.record_override_failure(t0));
        assert!(s2.record_override_failure(t0 + Duration::from_secs(300)));
        assert!(!s2.is_using_override());
        assert!(!override_file_path(&dir).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_override_enforces_ssrf_unless_allow_insecure_ws() {
        let dir = unique_temp_dir("load_ssrf");
        let bad_ovr = EndpointOverride {
            url: "ws://127.0.0.1:8787/api/agent/ws".to_string(),
            fallback_url: None,
            epoch: 1763128000,
        };
        save_override_atomic(&dir, &bad_ovr).unwrap();

        assert!(load_override(&dir, false).is_none());
        assert_eq!(load_override(&dir, true), Some(bad_ovr));

        let _ = fs::remove_dir_all(&dir);
    }
}
