use crate::crypto::{hmac_sha256_hex, now_sec};
use crate::protocol::{
    CtrlUpdateDirective, LatestRelease, NodeUpdateStatus, ReleaseAssetInfo, ReleaseAssetsMap,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;
use url::Url;

pub const AGENT_UPDATE_CONFIG_SETTING: &str = "agent_update_config";
pub const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";
pub const DEFAULT_CHANNEL: &str = "stable";
pub const DEFAULT_CHECK_INTERVAL_SEC: u64 = 21_600;
pub const MIN_CHECK_INTERVAL_SEC: u64 = 60;
pub const MAX_CHECK_INTERVAL_SEC: u64 = 604_800;
pub const RELEASE_CACHE_TTL_SEC: i64 = 900;
pub const AUTO_DISPATCH_COOLDOWN_SEC: i64 = 900;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentUpdateConfig {
    #[serde(default)]
    pub auto_update_enabled: bool,
    #[serde(default = "default_channel")]
    pub channel: String,
    #[serde(default = "default_check_interval_sec")]
    pub check_interval_sec: u64,
    #[serde(default)]
    pub custom_base_url: String,
}

impl Default for AgentUpdateConfig {
    fn default() -> Self {
        Self {
            auto_update_enabled: false,
            channel: default_channel(),
            check_interval_sec: default_check_interval_sec(),
            custom_base_url: String::new(),
        }
    }
}

fn default_channel() -> String {
    DEFAULT_CHANNEL.to_string()
}

fn default_check_interval_sec() -> u64 {
    DEFAULT_CHECK_INTERVAL_SEC
}

#[derive(Debug, Clone, Default)]
pub struct AgentUpdateCache {
    pub latest: Option<LatestRelease>,
    pub checked_at: Option<i64>,
    pub last_error: Option<String>,
    pub dispatched_versions: HashMap<String, (String, i64)>,
}

pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid custom_base_url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("custom_base_url must use http:// or https://".to_string());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("custom_base_url missing host".to_string());
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

pub fn parse_agent_update_config_patch(
    body: &Value,
    current: &AgentUpdateConfig,
) -> Result<AgentUpdateConfig, String> {
    let Some(obj) = body.as_object() else {
        return Err("Invalid JSON body".to_string());
    };
    let mut next = current.clone();

    if let Some(v) = obj.get("auto_update_enabled") {
        next.auto_update_enabled = v
            .as_bool()
            .ok_or_else(|| "auto_update_enabled must be a boolean".to_string())?;
    }
    if let Some(v) = obj.get("channel") {
        let s = v
            .as_str()
            .map(|x| x.trim().to_ascii_lowercase())
            .ok_or_else(|| "channel must be 'stable' or 'github'".to_string())?;
        if !matches!(s.as_str(), "stable" | "github") {
            return Err("channel must be 'stable' or 'github'".to_string());
        }
        next.channel = s;
    }
    if let Some(v) = obj.get("check_interval_sec") {
        let secs = v
            .as_u64()
            .ok_or_else(|| "check_interval_sec must be an integer".to_string())?;
        if !(MIN_CHECK_INTERVAL_SEC..=MAX_CHECK_INTERVAL_SEC).contains(&secs) {
            return Err(format!(
                "check_interval_sec must be between {MIN_CHECK_INTERVAL_SEC} and {MAX_CHECK_INTERVAL_SEC}"
            ));
        }
        next.check_interval_sec = secs;
    }
    if let Some(v) = obj.get("custom_base_url") {
        if v.is_null() {
            next.custom_base_url = String::new();
        } else {
            let raw = v
                .as_str()
                .ok_or_else(|| "custom_base_url must be a string or null".to_string())?;
            next.custom_base_url = normalize_base_url(raw)?;
        }
    }

    Ok(next)
}

pub fn normalize_setting(key: &str, raw: &str) -> Result<Option<String>, String> {
    if key != AGENT_UPDATE_CONFIG_SETTING {
        return Ok(None);
    }
    let val: Value = serde_json::from_str(raw)
        .map_err(|e| format!("Invalid {AGENT_UPDATE_CONFIG_SETTING} JSON: {e}"))?;
    let cfg = parse_agent_update_config_patch(&val, &AgentUpdateConfig::default())?;
    let out = serde_json::to_string(&cfg)
        .map_err(|e| format!("Failed to encode {AGENT_UPDATE_CONFIG_SETTING}: {e}"))?;
    Ok(Some(out))
}

pub fn normalize_arch(raw: Option<&str>) -> Option<&'static str> {
    let a = raw?.trim().to_ascii_lowercase();
    match a.as_str() {
        "x86_64" | "amd64" => Some("amd64"),
        "aarch64" | "arm64" => Some("arm64"),
        _ => None,
    }
}

pub fn asset_candidates_for_arch(arch: &str) -> &'static [&'static str] {
    match arch {
        "amd64" => &[
            "uniob-agent-x86_64-unknown-linux-musl",
            "uniob-agent-linux-amd64",
        ],
        "arm64" => &[
            "uniob-agent-aarch64-unknown-linux-musl",
            "uniob-agent-linux-arm64",
        ],
        _ => &[],
    }
}

pub fn compare_semver(a: &str, b: &str) -> Ordering {
    fn parse_parts(s: &str) -> ([u64; 3], bool) {
        let trimmed = s.trim().trim_start_matches('v').trim_start_matches('V');
        let (core, pre) = match trimmed.split_once('-') {
            Some((c, p)) => (c, !p.is_empty()),
            None => (trimmed, false),
        };
        let mut nums = [0u64; 3];
        for (i, seg) in core.split('.').take(3).enumerate() {
            let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
            nums[i] = digits.parse::<u64>().unwrap_or(0);
        }
        (nums, pre)
    }

    let (an, apre) = parse_parts(a);
    let (bn, bpre) = parse_parts(b);
    match an.cmp(&bn) {
        Ordering::Equal => match (apre, bpre) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => Ordering::Equal,
        },
        ord => ord,
    }
}

pub fn parse_sha256sums(text: &str) -> (HashMap<String, String>, Option<String>) {
    let mut map = HashMap::new();
    let mut version_hint: Option<String> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(comment) = line.strip_prefix('#') {
            if version_hint.is_none() {
                let c = comment.trim();
                let extracted = c
                    .strip_prefix("version:")
                    .or_else(|| c.strip_prefix("version="))
                    .map(str::trim)
                    .map(|v| v.trim_start_matches('v'));
                if let Some(v) = extracted.filter(|v| !v.is_empty() && v.len() <= 64) {
                    version_hint = Some(v.to_string());
                }
            }
            continue;
        }

        let mut parts = line.split_whitespace();
        let Some(hash_raw) = parts.next() else {
            continue;
        };
        let Some(file_raw) = parts.next() else {
            continue;
        };
        if hash_raw.len() != 64 || !hash_raw.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let cleaned_name = file_raw
            .trim_start_matches('*')
            .trim_start_matches("./")
            .rsplit('/')
            .next()
            .unwrap_or("")
            .trim();
        if !cleaned_name.is_empty() {
            map.insert(cleaned_name.to_string(), hash_raw.to_ascii_lowercase());
        }
    }

    (map, version_hint)
}

pub fn sign_update_directive(
    token_sha256: &str,
    node_id: &str,
    version: &str,
    sha256: &str,
    issued_at: u64,
    url: &str,
    fallback_url: Option<&str>,
) -> String {
    let key = token_sha256.trim().to_ascii_lowercase();
    let fb = fallback_url.unwrap_or("");
    let msg = format!("agent_update_v1:{node_id}:{version}:{sha256}:{issued_at}:{url}:{fb}");
    hmac_sha256_hex(key.as_bytes(), msg.as_bytes())
}

pub fn build_signed_directive(
    token_sha256: &str,
    node_id: &str,
    version: &str,
    asset: &ReleaseAssetInfo,
    issued_at: u64,
) -> CtrlUpdateDirective {
    let hmac = sign_update_directive(
        token_sha256,
        node_id,
        version,
        &asset.sha256,
        issued_at,
        &asset.url,
        asset.fallback_url.as_deref(),
    );
    CtrlUpdateDirective {
        version: version.to_string(),
        sha256: asset.sha256.clone(),
        url: asset.url.clone(),
        fallback_url: asset.fallback_url.clone(),
        issued_at,
        hmac,
    }
}

pub fn parse_agent_update_status(val: &Value, wall_sec: i64) -> Option<NodeUpdateStatus> {
    let obj = val.as_object()?;
    let state_raw = obj
        .get("st")
        .or_else(|| obj.get("state"))
        .and_then(|v| v.as_str())?
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        state_raw.as_str(),
        "idle" | "downloading" | "staged" | "applying" | "error"
    ) {
        return None;
    }

    let target_version = obj
        .get("ver")
        .or_else(|| obj.get("target_version"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 64 && !s.chars().any(char::is_control))
        .map(ToString::to_string);

    let error = obj
        .get("err")
        .or_else(|| obj.get("error"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(512).collect());

    let ts = obj
        .get("ts")
        .or_else(|| obj.get("updated_at"))
        .and_then(|v| v.as_i64())
        .filter(|&n| n > 0)
        .unwrap_or(wall_sec);

    Some(NodeUpdateStatus {
        state: state_raw,
        target_version,
        error,
        updated_at: Some(ts),
    })
}

fn read_local_release(releases_dir: &Path, origin: &str) -> Result<Option<LatestRelease>, String> {
    let sums_path = releases_dir.join("SHA256SUMS");
    let sums_text = match std::fs::read_to_string(&sums_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed reading {}: {e}", sums_path.display())),
    };

    let (sums, comment_ver) = parse_sha256sums(&sums_text);
    let version = std::fs::read_to_string(releases_dir.join("VERSION"))
        .ok()
        .map(|s| s.trim().trim_start_matches('v').to_string())
        .filter(|s| !s.is_empty())
        .or(comment_ver)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let origin_base = origin.trim_end_matches('/');
    let mut assets = ReleaseAssetsMap {
        amd64: None,
        arm64: None,
    };

    for arch in ["amd64", "arm64"] {
        for &name in asset_candidates_for_arch(arch) {
            if let Some(sha) = sums.get(name) {
                if releases_dir.join(name).is_file() {
                    let info = ReleaseAssetInfo {
                        arch: arch.to_string(),
                        asset_name: name.to_string(),
                        url: format!("{origin_base}/releases/{name}"),
                        fallback_url: None,
                        sha256: sha.clone(),
                    };
                    if arch == "amd64" {
                        assets.amd64 = Some(info);
                    } else {
                        assets.arm64 = Some(info);
                    }
                    break;
                }
            }
        }
    }

    if assets.amd64.is_none() && assets.arm64.is_none() {
        return Ok(None);
    }

    Ok(Some(LatestRelease {
        tag: Some(format!("v{version}")),
        version,
        checked_at: now_sec(),
        published_at: None,
        notes_url: None,
        source: "local".to_string(),
        assets,
    }))
}

async fn resolve_custom_release(
    http: &Client,
    custom_base_url: &str,
) -> Result<LatestRelease, String> {
    let base = custom_base_url.trim_end_matches('/');
    let sums_url = format!("{base}/SHA256SUMS");
    let sums_resp = http
        .get(&sums_url)
        .header(
            "User-Agent",
            format!("uniob-hub/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .map_err(|e| format!("Failed fetching {sums_url}: {e}"))?;
    if !sums_resp.status().is_success() {
        return Err(format!(
            "Fetching {sums_url} returned HTTP {}",
            sums_resp.status()
        ));
    }
    let sums_text = sums_resp
        .text()
        .await
        .map_err(|e| format!("Failed reading {sums_url}: {e}"))?;
    let (sums, comment_ver) = parse_sha256sums(&sums_text);

    let remote_ver = match http
        .get(format!("{base}/VERSION"))
        .header(
            "User-Agent",
            format!("uniob-hub/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp
            .text()
            .await
            .ok()
            .map(|s| s.trim().trim_start_matches('v').to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    };

    let version = remote_ver
        .or(comment_ver)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let mut assets = ReleaseAssetsMap {
        amd64: None,
        arm64: None,
    };
    for arch in ["amd64", "arm64"] {
        for &name in asset_candidates_for_arch(arch) {
            if let Some(sha) = sums.get(name) {
                let info = ReleaseAssetInfo {
                    arch: arch.to_string(),
                    asset_name: name.to_string(),
                    url: format!("{base}/{name}"),
                    fallback_url: None,
                    sha256: sha.clone(),
                };
                if arch == "amd64" {
                    assets.amd64 = Some(info);
                } else {
                    assets.arm64 = Some(info);
                }
                break;
            }
        }
    }

    if assets.amd64.is_none() && assets.arm64.is_none() {
        return Err(format!("No supported agent binary found in {sums_url}"));
    }

    Ok(LatestRelease {
        tag: Some(format!("v{version}")),
        version,
        checked_at: now_sec(),
        published_at: None,
        notes_url: None,
        source: "custom".to_string(),
        assets,
    })
}

#[derive(Debug, Deserialize)]
struct GithubAssetJson {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseJson {
    tag_name: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAssetJson>,
}

async fn resolve_github_release(
    http: &Client,
    github_api_base: &str,
    github_repo: &str,
    releases_dir: &Path,
    origin: &str,
) -> Result<LatestRelease, String> {
    let api_base = github_api_base.trim_end_matches('/');
    let repo = github_repo.trim().trim_matches('/');
    let url = format!("{api_base}/repos/{repo}/releases/latest");
    let resp = http
        .get(&url)
        .header(
            "User-Agent",
            format!("uniob-hub/{}", env!("CARGO_PKG_VERSION")),
        )
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub release request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub release check returned HTTP {}",
            resp.status()
        ));
    }

    let rel: GithubReleaseJson = resp
        .json()
        .await
        .map_err(|e| format!("Invalid GitHub release JSON: {e}"))?;
    let version = rel.tag_name.trim().trim_start_matches('v').to_string();
    if version.is_empty() {
        return Err("GitHub release tag_name is empty".to_string());
    }

    let mut sums: HashMap<String, String> = HashMap::new();
    if let Some(sums_asset) = rel.assets.iter().find(|a| a.name == "SHA256SUMS") {
        if let Ok(r) = http
            .get(&sums_asset.browser_download_url)
            .header(
                "User-Agent",
                format!("uniob-hub/{}", env!("CARGO_PKG_VERSION")),
            )
            .send()
            .await
        {
            if r.status().is_success() {
                if let Ok(txt) = r.text().await {
                    let (parsed, _) = parse_sha256sums(&txt);
                    sums = parsed;
                }
            }
        }
    }

    let local_sums = std::fs::read_to_string(releases_dir.join("SHA256SUMS"))
        .ok()
        .map(|s| parse_sha256sums(&s).0)
        .unwrap_or_default();
    let origin_base = origin.trim_end_matches('/');

    let mut assets = ReleaseAssetsMap {
        amd64: None,
        arm64: None,
    };

    for arch in ["amd64", "arm64"] {
        for &candidate in asset_candidates_for_arch(arch) {
            if let Some(gh_asset) = rel.assets.iter().find(|a| a.name == candidate) {
                let sha = sums.get(candidate).cloned().or_else(|| {
                    gh_asset
                        .digest
                        .as_deref()
                        .and_then(|d| d.strip_prefix("sha256:"))
                        .map(|h| h.trim().to_ascii_lowercase())
                        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
                });
                let Some(sha256) = sha else {
                    continue;
                };
                let fallback_url = if local_sums.get(candidate) == Some(&sha256)
                    && releases_dir.join(candidate).is_file()
                    && !origin_base.is_empty()
                {
                    Some(format!("{origin_base}/releases/{candidate}"))
                } else {
                    None
                };
                let info = ReleaseAssetInfo {
                    arch: arch.to_string(),
                    asset_name: candidate.to_string(),
                    url: gh_asset.browser_download_url.clone(),
                    fallback_url,
                    sha256,
                };
                if arch == "amd64" {
                    assets.amd64 = Some(info);
                } else {
                    assets.arm64 = Some(info);
                }
                break;
            }
        }
    }

    if assets.amd64.is_none() && assets.arm64.is_none() {
        return Err("GitHub release has no matching SHA256SUMS/digest assets".to_string());
    }

    Ok(LatestRelease {
        version,
        tag: Some(rel.tag_name),
        checked_at: now_sec(),
        published_at: rel.published_at,
        notes_url: rel.html_url,
        source: "github".to_string(),
        assets,
    })
}

pub async fn resolve_latest_release(
    http: &Client,
    cfg: &AgentUpdateConfig,
    releases_dir: &Path,
    github_api_base: &str,
    github_repo: &str,
    origin: &str,
) -> Result<LatestRelease, String> {
    let custom = cfg.custom_base_url.trim();
    if !custom.is_empty() {
        return resolve_custom_release(http, custom).await;
    }

    if cfg.channel == "github" {
        return resolve_github_release(http, github_api_base, github_repo, releases_dir, origin)
            .await;
    }

    if let Some(local) = read_local_release(releases_dir, origin)? {
        return Ok(local);
    }

    resolve_github_release(http, github_api_base, github_repo, releases_dir, origin).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_semver_orders_versions_and_prereleases() {
        assert_eq!(compare_semver("0.2.0", "0.2.1"), Ordering::Less);
        assert_eq!(compare_semver("v0.2.10", "0.2.2"), Ordering::Greater);
        assert_eq!(compare_semver("0.2.1-rc.1", "0.2.1"), Ordering::Less);
        assert_eq!(compare_semver("v1.0.0", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn parse_sha256sums_supports_binary_prefix_and_version_comment() {
        let raw = "\
# version=0.2.1\r\n\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  uniob-agent-x86_64-unknown-linux-musl\r\n\
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *./dist/uniob-agent-linux-arm64\r\n\
";
        let (map, ver) = parse_sha256sums(raw);
        assert_eq!(ver.as_deref(), Some("0.2.1"));
        assert_eq!(
            map.get("uniob-agent-x86_64-unknown-linux-musl")
                .map(String::as_str),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            map.get("uniob-agent-linux-arm64").map(String::as_str),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
    }

    #[test]
    fn parse_agent_update_status_accepts_wire_and_normalized_shapes() {
        let wire = serde_json::json!({ "st": "downloading", "ver": "0.2.1", "ts": 1763128000 });
        let parsed = parse_agent_update_status(&wire, 100).unwrap();
        assert_eq!(parsed.state, "downloading");
        assert_eq!(parsed.target_version.as_deref(), Some("0.2.1"));
        assert_eq!(parsed.updated_at, Some(1763128000));

        let invalid = serde_json::json!({ "st": "bogus_state" });
        assert!(parse_agent_update_status(&invalid, 100).is_none());
    }

    #[test]
    fn config_patch_validates_fields_and_allows_null_custom_url() {
        let base = AgentUpdateConfig {
            auto_update_enabled: false,
            channel: "stable".to_string(),
            check_interval_sec: 3600,
            custom_base_url: "https://mirror.example.com/agent/".to_string(),
        };
        let patched = parse_agent_update_config_patch(
            &serde_json::json!({
                "auto_update_enabled": true,
                "channel": "GitHub",
                "check_interval_sec": 120,
                "custom_base_url": null
            }),
            &base,
        )
        .unwrap();
        assert!(patched.auto_update_enabled);
        assert_eq!(patched.channel, "github");
        assert_eq!(patched.check_interval_sec, 120);
        assert_eq!(patched.custom_base_url, "");

        assert!(parse_agent_update_config_patch(
            &serde_json::json!({ "channel": "nightly" }),
            &base
        )
        .is_err());
        assert!(parse_agent_update_config_patch(
            &serde_json::json!({ "check_interval_sec": 10 }),
            &base
        )
        .is_err());
        assert!(parse_agent_update_config_patch(
            &serde_json::json!({ "custom_base_url": "ftp://example.com" }),
            &base
        )
        .is_err());
    }

    #[tokio::test]
    async fn resolves_local_release_and_mock_github_with_fallback_url() {
        use axum::{extract::State, routing::get, Router};
        use tokio::net::TcpListener;

        let dir = std::env::temp_dir().join(format!(
            "uniob_agent_update_test_{}_{}",
            std::process::id(),
            now_sec()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let amd64_bytes = b"\x7fELFmock-amd64-binary";
        let amd64_sha = crate::crypto::sha256_hex(amd64_bytes);
        std::fs::write(
            dir.join("uniob-agent-x86_64-unknown-linux-musl"),
            amd64_bytes,
        )
        .unwrap();
        std::fs::write(dir.join("VERSION"), "0.2.5\n").unwrap();
        std::fs::write(
            dir.join("SHA256SUMS"),
            format!("{amd64_sha}  uniob-agent-x86_64-unknown-linux-musl\n"),
        )
        .unwrap();

        let http = Client::new();
        let stable_cfg = AgentUpdateConfig::default();
        let local_rel = resolve_latest_release(
            &http,
            &stable_cfg,
            &dir,
            DEFAULT_GITHUB_API_BASE,
            "Cusnd/UniOB",
            "https://hub.example.com/",
        )
        .await
        .unwrap();
        assert_eq!(local_rel.source, "local");
        assert_eq!(local_rel.version, "0.2.5");
        let local_amd64 = local_rel.assets.amd64.as_ref().unwrap();
        assert_eq!(
            local_amd64.url,
            "https://hub.example.com/releases/uniob-agent-x86_64-unknown-linux-musl"
        );
        assert_eq!(local_amd64.sha256, amd64_sha);

        // Mock GitHub Releases API returning v0.2.5 matching local SHA256 (expect local fallback_url)
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mock_addr = listener.local_addr().unwrap();
        let mock_base = format!("http://{mock_addr}");
        let sums_body = format!("{amd64_sha}  uniob-agent-x86_64-unknown-linux-musl\n");
        let app = Router::new()
            .route(
                "/repos/Cusnd/UniOB/releases/latest",
                get({
                    let mb = mock_base.clone();
                    move || async move {
                        axum::Json(serde_json::json!({
                            "tag_name": "v0.2.5",
                            "published_at": "2026-11-15T00:00:00Z",
                            "html_url": "https://github.com/Cusnd/UniOB/releases/tag/v0.2.5",
                            "assets": [
                                {
                                    "name": "SHA256SUMS",
                                    "browser_download_url": format!("{mb}/dl/SHA256SUMS")
                                },
                                {
                                    "name": "uniob-agent-x86_64-unknown-linux-musl",
                                    "browser_download_url": format!("{mb}/dl/uniob-agent-x86_64-unknown-linux-musl")
                                }
                            ]
                        }))
                    }
                }),
            )
            .route(
                "/dl/SHA256SUMS",
                get(move |State(body): State<String>| async move { body }),
            )
            .with_state(sums_body);
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let gh_cfg = AgentUpdateConfig {
            auto_update_enabled: true,
            channel: "github".to_string(),
            check_interval_sec: 3600,
            custom_base_url: String::new(),
        };
        let gh_rel = resolve_latest_release(
            &http,
            &gh_cfg,
            &dir,
            &mock_base,
            "Cusnd/UniOB",
            "https://hub.example.com",
        )
        .await
        .unwrap();
        assert_eq!(gh_rel.source, "github");
        assert_eq!(gh_rel.version, "0.2.5");
        let gh_amd64 = gh_rel.assets.amd64.as_ref().unwrap();
        assert_eq!(
            gh_amd64.url,
            format!("{mock_base}/dl/uniob-agent-x86_64-unknown-linux-musl")
        );
        assert_eq!(
            gh_amd64.fallback_url.as_deref(),
            Some("https://hub.example.com/releases/uniob-agent-x86_64-unknown-linux-musl")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
