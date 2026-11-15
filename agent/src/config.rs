use serde::Deserialize;
use std::fs;
use std::path::Path;

pub const DEFAULT_WS_PATH: &str = "/api/agent/ws";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    #[serde(default)]
    pub collector: CollectorConfig,
    #[serde(default)]
    pub process: ProcessConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServerConfig {
    pub url: String,
    pub node_id: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CollectorConfig {
    #[serde(default)]
    pub nic_allowlist: Vec<String>,
    #[serde(default = "default_mount_ignore_prefixes")]
    pub mount_ignore_prefixes: Vec<String>,
}

impl Default for CollectorConfig {
    fn default() -> Self {
        Self {
            nic_allowlist: Vec::new(),
            mount_ignore_prefixes: default_mount_ignore_prefixes(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ProcessConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub cmdline_mode: CmdlineMode,
}

impl Default for ProcessConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            cmdline_mode: CmdlineMode::Sanitized,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CmdlineMode {
    #[default]
    Sanitized,
    CommOnly,
    Full,
}

fn default_true() -> bool {
    true
}

fn default_mount_ignore_prefixes() -> Vec<String> {
    vec![
        "/snap".to_string(),
        "/boot/efi".to_string(),
        "/run".to_string(),
    ]
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("failed to read config {}: {e}", path.display()))?;
        Self::from_toml_str(&content)
    }

    pub fn from_toml_str(raw: &str) -> Result<Self, String> {
        let mut cfg: Config =
            toml::from_str(raw).map_err(|e| format!("failed to parse TOML config: {e}"))?;

        cfg.server.node_id = cfg.server.node_id.trim().to_string();
        if cfg.server.node_id.is_empty() {
            return Err("server.node_id must not be empty".to_string());
        }

        cfg.server.token = cfg.server.token.trim().to_string();
        if cfg.server.token.is_empty() {
            return Err("server.token must not be empty".to_string());
        }

        cfg.server.url = normalize_ws_url(&cfg.server.url)?;
        Ok(cfg)
    }
}

/// Normalizes HTTP(S)/WS(S) server URLs into a WebSocket URL and ensures `/api/agent/ws`
/// is appended when the path is empty or `/`.
pub fn normalize_ws_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("server.url must not be empty".to_string());
    }

    let (scheme, after_scheme) = if let Some(idx) = trimmed.find("://") {
        let raw_scheme = &trimmed[..idx];
        let rest = &trimmed[idx + 3..];
        let normalized_scheme = match raw_scheme.to_ascii_lowercase().as_str() {
            "https" | "wss" => "wss",
            "http" | "ws" => "ws",
            other => {
                return Err(format!(
                    "unsupported server.url scheme '{other}'; expected wss, ws, https, or http"
                ));
            }
        };
        (normalized_scheme, rest)
    } else {
        return Err(
            "server.url must include scheme (wss://, ws://, https://, or http://)".to_string(),
        );
    };

    if after_scheme.is_empty() || after_scheme.starts_with('/') || after_scheme.starts_with('?') {
        return Err("server.url must include a host".to_string());
    }

    let path_or_query_start = after_scheme.find(['/', '?', '#']);
    let (authority, tail) = match path_or_query_start {
        Some(pos) => (&after_scheme[..pos], &after_scheme[pos..]),
        None => (after_scheme, ""),
    };

    if authority.is_empty() {
        return Err("server.url must include a host".to_string());
    }

    let (path, suffix) = if let Some(qpos) = tail.find(['?', '#']) {
        (&tail[..qpos], &tail[qpos..])
    } else {
        (tail, "")
    };

    let normalized_path = if path.is_empty() || path == "/" {
        DEFAULT_WS_PATH
    } else {
        path
    };

    Ok(format!("{scheme}://{authority}{normalized_path}{suffix}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_spec_toml_and_normalizes_url() {
        let toml_str = r#"
[server]
url = "https://monitor.example.com/"
node_id = "nd_01j8x9k2m4p5q6r7s8t9v0w1x2"
token = "uob_live_secret"

[collector]
nic_allowlist = ["eth0"]
mount_ignore_prefixes = ["/snap", "/boot/efi", "/run"]

[process]
enabled = true
cmdline_mode = "sanitized"
"#;
        let cfg = Config::from_toml_str(toml_str).unwrap();
        assert_eq!(cfg.server.url, "wss://monitor.example.com/api/agent/ws");
        assert_eq!(cfg.server.node_id, "nd_01j8x9k2m4p5q6r7s8t9v0w1x2");
        assert_eq!(cfg.server.token, "uob_live_secret");
        assert_eq!(cfg.collector.nic_allowlist, vec!["eth0"]);
        assert_eq!(
            cfg.collector.mount_ignore_prefixes,
            vec!["/snap", "/boot/efi", "/run"]
        );
        assert!(cfg.process.enabled);
        assert_eq!(cfg.process.cmdline_mode, CmdlineMode::Sanitized);
    }

    #[test]
    fn defaults_optional_sections_and_cmdline_modes() {
        let toml_str = r#"
[server]
url = "http://127.0.0.1:8787"
node_id = "nd_local"
token = "uob_live_123"

[process]
enabled = false
cmdline_mode = "comm_only"
"#;
        let cfg = Config::from_toml_str(toml_str).unwrap();
        assert_eq!(cfg.server.url, "ws://127.0.0.1:8787/api/agent/ws");
        assert!(cfg.collector.nic_allowlist.is_empty());
        assert_eq!(
            cfg.collector.mount_ignore_prefixes,
            vec!["/snap", "/boot/efi", "/run"]
        );
        assert!(!cfg.process.enabled);
        assert_eq!(cfg.process.cmdline_mode, CmdlineMode::CommOnly);

        let full_toml = r#"
[server]
url = "wss://monitor.example.com/api/agent/ws"
node_id = "nd_1"
token = "tok"

[process]
cmdline_mode = "full"
"#;
        let full_cfg = Config::from_toml_str(full_toml).unwrap();
        assert_eq!(full_cfg.process.cmdline_mode, CmdlineMode::Full);
        assert_eq!(
            full_cfg.server.url,
            "wss://monitor.example.com/api/agent/ws"
        );
    }

    #[test]
    fn url_normalization_edge_cases() {
        assert_eq!(
            normalize_ws_url("HTTPS://Monitor.Example.com").unwrap(),
            "wss://Monitor.Example.com/api/agent/ws"
        );
        assert_eq!(
            normalize_ws_url("http://localhost:8787/").unwrap(),
            "ws://localhost:8787/api/agent/ws"
        );
        assert_eq!(
            normalize_ws_url("wss://example.com/custom/ws").unwrap(),
            "wss://example.com/custom/ws"
        );
        assert_eq!(
            normalize_ws_url("https://example.com?foo=bar").unwrap(),
            "wss://example.com/api/agent/ws?foo=bar"
        );
        assert!(normalize_ws_url("ftp://example.com").is_err());
        assert!(normalize_ws_url("example.com").is_err());
        assert!(normalize_ws_url("https://").is_err());
    }

    #[test]
    fn rejects_invalid_cmdline_mode_and_empty_credentials() {
        let bad_mode = r#"
[server]
url = "wss://example.com"
node_id = "nd_1"
token = "tok"
[process]
cmdline_mode = "raw"
"#;
        assert!(Config::from_toml_str(bad_mode).is_err());

        let empty_token = r#"
[server]
url = "wss://example.com"
node_id = "nd_1"
token = "   "
"#;
        assert!(Config::from_toml_str(empty_token).is_err());
    }
}
