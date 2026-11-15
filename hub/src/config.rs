use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const DEFAULT_LISTEN: &str = "127.0.0.1:8787";
pub const DEFAULT_DB_PATH: &str = "/var/lib/uniob-hub/uniob.db";
pub const DEFAULT_WEB_DIR: &str = "/usr/local/share/uniob-hub/web";
pub const DEFAULT_RELEASES_DIR: &str = "/usr/local/share/uniob-hub/releases";
pub const DEFAULT_GITHUB_REPO: &str = "Cusnd/UniOB";
pub const DEFAULT_WATCHDOG_INTERVAL_SEC: u64 = 300;
pub const DEFAULT_WATCHDOG_TIMEOUT_SEC: u64 = 900;
pub const DEFAULT_SELF_PROBE_NODE_ID: &str = "hub-local";
pub const DEFAULT_SELF_PROBE_NODE_NAME: &str = "Hub Local";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthMode {
    Builtin,
    CfAccess,
}

impl AuthMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMode::Builtin => "builtin",
            AuthMode::CfAccess => "cf_access",
        }
    }
}

#[derive(Debug, Clone)]
pub struct HubConfig {
    pub listen: String,
    pub db_path: PathBuf,
    pub web_dir: PathBuf,
    pub releases_dir: PathBuf,
    pub public_url: String,
    pub github_repo: String,
    pub allow_insecure_ws_for_test: bool,
    pub import_bundle: Option<PathBuf>,
    pub import_only: bool,

    pub auth_mode_explicit: Option<String>,
    pub cf_access_team_domain: String,
    pub cf_access_aud: String,
    pub cf_access_allowed_emails: Vec<String>,
    pub session_secret: String,
    pub admin_password_hash: String,

    pub self_probe_enabled: bool,
    pub self_probe_node_id: String,
    pub self_probe_node_name: String,

    pub watchdog_url: String,
    pub watchdog_secret: String,
    pub watchdog_interval_sec: u64,
    pub watchdog_timeout_sec: u64,
    pub hub_label: String,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            listen: DEFAULT_LISTEN.to_string(),
            db_path: PathBuf::from(DEFAULT_DB_PATH),
            web_dir: PathBuf::from(DEFAULT_WEB_DIR),
            releases_dir: PathBuf::from(DEFAULT_RELEASES_DIR),
            public_url: String::new(),
            github_repo: DEFAULT_GITHUB_REPO.to_string(),
            allow_insecure_ws_for_test: false,
            import_bundle: None,
            import_only: false,
            auth_mode_explicit: None,
            cf_access_team_domain: String::new(),
            cf_access_aud: String::new(),
            cf_access_allowed_emails: Vec::new(),
            session_secret: String::new(),
            admin_password_hash: String::new(),
            self_probe_enabled: true,
            self_probe_node_id: DEFAULT_SELF_PROBE_NODE_ID.to_string(),
            self_probe_node_name: DEFAULT_SELF_PROBE_NODE_NAME.to_string(),
            watchdog_url: String::new(),
            watchdog_secret: String::new(),
            watchdog_interval_sec: DEFAULT_WATCHDOG_INTERVAL_SEC,
            watchdog_timeout_sec: DEFAULT_WATCHDOG_TIMEOUT_SEC,
            hub_label: read_hostname().unwrap_or_else(|| "uniob-hub".to_string()),
        }
    }
}

impl HubConfig {
    pub fn effective_auth_mode(&self) -> AuthMode {
        let cf_ready =
            !self.cf_access_team_domain.trim().is_empty() && !self.cf_access_aud.trim().is_empty();
        match self
            .auth_mode_explicit
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("builtin") => AuthMode::Builtin,
            Some("cf_access") | Some("cloudflare") | Some("access") => AuthMode::CfAccess,
            _ => {
                if cf_ready {
                    AuthMode::CfAccess
                } else {
                    AuthMode::Builtin
                }
            }
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct CliArgs {
    pub config: Option<PathBuf>,
    pub listen: Option<String>,
    pub db: Option<PathBuf>,
    pub web_dir: Option<PathBuf>,
    pub releases_dir: Option<PathBuf>,
    pub public_url: Option<String>,
    pub import_bundle: Option<PathBuf>,
    pub import_only: bool,
    pub watchdog_url: Option<String>,
    pub watchdog_secret: Option<String>,
    pub allow_insecure_ws_for_test: bool,
    pub show_help: bool,
    pub show_version: bool,
}

impl CliArgs {
    pub fn parse_from<I, S>(args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut out = CliArgs::default();
        let mut iter = args.into_iter().map(|s| s.into()).peekable();
        // Skip argv[0]
        iter.next();

        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "-h" | "--help" => out.show_help = true,
                "-v" | "--version" => out.show_version = true,
                "--import-only" => out.import_only = true,
                "--allow-insecure-ws-for-test" => out.allow_insecure_ws_for_test = true,
                "--config" => {
                    let v = next_val(&mut iter, "--config")?;
                    out.config = Some(PathBuf::from(v));
                }
                "--listen" => {
                    out.listen = Some(next_val(&mut iter, "--listen")?);
                }
                "--db" => {
                    out.db = Some(PathBuf::from(next_val(&mut iter, "--db")?));
                }
                "--web-dir" => {
                    out.web_dir = Some(PathBuf::from(next_val(&mut iter, "--web-dir")?));
                }
                "--releases-dir" => {
                    out.releases_dir = Some(PathBuf::from(next_val(&mut iter, "--releases-dir")?));
                }
                "--public-url" => {
                    out.public_url = Some(next_val(&mut iter, "--public-url")?);
                }
                "--import-bundle" => {
                    out.import_bundle =
                        Some(PathBuf::from(next_val(&mut iter, "--import-bundle")?));
                }
                "--watchdog-url" => {
                    out.watchdog_url = Some(next_val(&mut iter, "--watchdog-url")?);
                }
                "--watchdog-secret" => {
                    out.watchdog_secret = Some(next_val(&mut iter, "--watchdog-secret")?);
                }
                other => {
                    if let Some((flag, val)) = other.split_once('=') {
                        match flag {
                            "--config" => out.config = Some(PathBuf::from(val)),
                            "--listen" => out.listen = Some(val.to_string()),
                            "--db" => out.db = Some(PathBuf::from(val)),
                            "--web-dir" => out.web_dir = Some(PathBuf::from(val)),
                            "--releases-dir" => out.releases_dir = Some(PathBuf::from(val)),
                            "--public-url" => out.public_url = Some(val.to_string()),
                            "--import-bundle" => out.import_bundle = Some(PathBuf::from(val)),
                            "--watchdog-url" => out.watchdog_url = Some(val.to_string()),
                            "--watchdog-secret" => out.watchdog_secret = Some(val.to_string()),
                            _ => return Err(format!("Unknown argument: {other}")),
                        }
                    } else {
                        return Err(format!("Unknown argument: {other}"));
                    }
                }
            }
        }
        Ok(out)
    }
}

fn next_val<I>(iter: &mut std::iter::Peekable<I>, flag: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    iter.next()
        .ok_or_else(|| format!("Missing value for argument {flag}"))
}

#[derive(Debug, Default, Deserialize)]
struct TomlFile {
    // Flat aliases
    listen: Option<String>,
    db_path: Option<String>,
    web_dir: Option<String>,
    releases_dir: Option<String>,
    public_url: Option<String>,
    github_repo: Option<String>,
    hub_label: Option<String>,
    allow_insecure_ws_for_test: Option<bool>,

    server: Option<TomlServer>,
    auth: Option<TomlAuth>,
    self_probe: Option<TomlSelfProbe>,
    watchdog: Option<TomlWatchdog>,
}

#[derive(Debug, Default, Deserialize)]
struct TomlServer {
    listen: Option<String>,
    db_path: Option<String>,
    web_dir: Option<String>,
    releases_dir: Option<String>,
    public_url: Option<String>,
    github_repo: Option<String>,
    hub_label: Option<String>,
    allow_insecure_ws_for_test: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct TomlAuth {
    mode: Option<String>,
    cf_access_team_domain: Option<String>,
    cf_access_aud: Option<String>,
    cf_access_allowed_emails: Option<TomlEmails>,
    session_secret: Option<String>,
    admin_password_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TomlEmails {
    List(Vec<String>),
    Csv(String),
}

#[derive(Debug, Default, Deserialize)]
struct TomlSelfProbe {
    enabled: Option<bool>,
    node_id: Option<String>,
    node_name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct TomlWatchdog {
    url: Option<String>,
    secret: Option<String>,
    interval_sec: Option<u64>,
    timeout_sec: Option<u64>,
    hub_label: Option<String>,
}

pub fn load_config(cli: &CliArgs) -> Result<HubConfig, String> {
    let mut cfg = HubConfig::default();

    // Determine TOML config file if explicitly provided or default path exists
    if let Some(ref cfg_path) = cli.config {
        let raw = std::fs::read_to_string(cfg_path)
            .map_err(|e| format!("Failed to read config {}: {e}", cfg_path.display()))?;
        apply_toml(&mut cfg, &raw)?;
    } else {
        let default_cfg = Path::new("/etc/uniob-hub/hub.toml");
        if default_cfg.exists() {
            if let Ok(raw) = std::fs::read_to_string(default_cfg) {
                apply_toml(&mut cfg, &raw)?;
            }
        }
    }

    // Apply environment variables
    apply_env(&mut cfg);

    // Apply CLI overrides (highest priority)
    if let Some(ref v) = cli.listen {
        cfg.listen = v.clone();
    }
    if let Some(ref v) = cli.db {
        cfg.db_path = v.clone();
    }
    if let Some(ref v) = cli.web_dir {
        cfg.web_dir = v.clone();
    }
    if let Some(ref v) = cli.releases_dir {
        cfg.releases_dir = v.clone();
    }
    if let Some(ref v) = cli.public_url {
        cfg.public_url = v.trim_end_matches('/').to_string();
    }
    if let Some(ref v) = cli.import_bundle {
        cfg.import_bundle = Some(v.clone());
    }
    if cli.import_only {
        cfg.import_only = true;
    }
    if let Some(ref v) = cli.watchdog_url {
        cfg.watchdog_url = v.clone();
    }
    if let Some(ref v) = cli.watchdog_secret {
        cfg.watchdog_secret = v.clone();
    }
    if cli.allow_insecure_ws_for_test {
        cfg.allow_insecure_ws_for_test = true;
    }

    Ok(cfg)
}

fn apply_toml(cfg: &mut HubConfig, raw: &str) -> Result<(), String> {
    let parsed: TomlFile = toml::from_str(raw).map_err(|e| format!("Invalid TOML config: {e}"))?;

    if let Some(v) = parsed.listen {
        cfg.listen = v;
    }
    if let Some(v) = parsed.db_path {
        cfg.db_path = PathBuf::from(v);
    }
    if let Some(v) = parsed.web_dir {
        cfg.web_dir = PathBuf::from(v);
    }
    if let Some(v) = parsed.releases_dir {
        cfg.releases_dir = PathBuf::from(v);
    }
    if let Some(v) = parsed.public_url {
        cfg.public_url = v.trim_end_matches('/').to_string();
    }
    if let Some(v) = parsed.github_repo {
        if !v.trim().is_empty() {
            cfg.github_repo = v.trim().to_string();
        }
    }
    if let Some(v) = parsed.hub_label {
        if !v.trim().is_empty() {
            cfg.hub_label = v.trim().to_string();
        }
    }
    if let Some(v) = parsed.allow_insecure_ws_for_test {
        cfg.allow_insecure_ws_for_test = v;
    }

    if let Some(s) = parsed.server {
        if let Some(v) = s.listen {
            cfg.listen = v;
        }
        if let Some(v) = s.db_path {
            cfg.db_path = PathBuf::from(v);
        }
        if let Some(v) = s.web_dir {
            cfg.web_dir = PathBuf::from(v);
        }
        if let Some(v) = s.releases_dir {
            cfg.releases_dir = PathBuf::from(v);
        }
        if let Some(v) = s.public_url {
            cfg.public_url = v.trim_end_matches('/').to_string();
        }
        if let Some(v) = s.github_repo {
            if !v.trim().is_empty() {
                cfg.github_repo = v.trim().to_string();
            }
        }
        if let Some(v) = s.hub_label {
            if !v.trim().is_empty() {
                cfg.hub_label = v.trim().to_string();
            }
        }
        if let Some(v) = s.allow_insecure_ws_for_test {
            cfg.allow_insecure_ws_for_test = v;
        }
    }

    if let Some(a) = parsed.auth {
        if let Some(v) = a.mode {
            cfg.auth_mode_explicit = Some(v);
        }
        if let Some(v) = a.cf_access_team_domain {
            cfg.cf_access_team_domain = v;
        }
        if let Some(v) = a.cf_access_aud {
            cfg.cf_access_aud = v;
        }
        if let Some(v) = a.cf_access_allowed_emails {
            cfg.cf_access_allowed_emails = match v {
                TomlEmails::List(items) => items
                    .into_iter()
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect(),
                TomlEmails::Csv(csv) => parse_email_csv(&csv),
            };
        }
        if let Some(v) = a.session_secret {
            cfg.session_secret = v;
        }
        if let Some(v) = a.admin_password_hash {
            cfg.admin_password_hash = v;
        }
    }

    if let Some(sp) = parsed.self_probe {
        if let Some(v) = sp.enabled {
            cfg.self_probe_enabled = v;
        }
        if let Some(v) = sp.node_id {
            if !v.trim().is_empty() {
                cfg.self_probe_node_id = v.trim().to_string();
            }
        }
        if let Some(v) = sp.node_name {
            if !v.trim().is_empty() {
                cfg.self_probe_node_name = v.trim().to_string();
            }
        }
    }

    if let Some(w) = parsed.watchdog {
        if let Some(v) = w.url {
            cfg.watchdog_url = v.trim().to_string();
        }
        if let Some(v) = w.secret {
            cfg.watchdog_secret = v;
        }
        if let Some(v) = w.interval_sec {
            cfg.watchdog_interval_sec = v.clamp(60, 3600);
        }
        if let Some(v) = w.timeout_sec {
            cfg.watchdog_timeout_sec = v.clamp(120, 86400);
        }
        if let Some(v) = w.hub_label {
            if !v.trim().is_empty() {
                cfg.hub_label = v.trim().to_string();
            }
        }
    }

    Ok(())
}

fn apply_env(cfg: &mut HubConfig) {
    if let Ok(v) = std::env::var("UNIOB_LISTEN") {
        if !v.trim().is_empty() {
            cfg.listen = v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("UNIOB_DB_PATH") {
        if !v.trim().is_empty() {
            cfg.db_path = PathBuf::from(v.trim());
        }
    }
    if let Ok(v) = std::env::var("UNIOB_WEB_DIR") {
        if !v.trim().is_empty() {
            cfg.web_dir = PathBuf::from(v.trim());
        }
    }
    if let Ok(v) = std::env::var("UNIOB_RELEASES_DIR") {
        if !v.trim().is_empty() {
            cfg.releases_dir = PathBuf::from(v.trim());
        }
    }
    if let Ok(v) = std::env::var("UNIOB_PUBLIC_URL") {
        if !v.trim().is_empty() {
            cfg.public_url = v.trim().trim_end_matches('/').to_string();
        }
    }
    if let Ok(v) = std::env::var("UNIOB_GITHUB_REPO").or_else(|_| std::env::var("GITHUB_REPO")) {
        if !v.trim().is_empty() {
            cfg.github_repo = v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("UNIOB_AUTH_MODE").or_else(|_| std::env::var("AUTH_MODE")) {
        if !v.trim().is_empty() {
            cfg.auth_mode_explicit = Some(v.trim().to_string());
        }
    }
    if let Ok(v) = std::env::var("CF_ACCESS_TEAM_DOMAIN") {
        if !v.trim().is_empty() {
            cfg.cf_access_team_domain = v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("CF_ACCESS_AUD") {
        if !v.trim().is_empty() {
            cfg.cf_access_aud = v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("CF_ACCESS_ALLOWED_EMAILS") {
        cfg.cf_access_allowed_emails = parse_email_csv(&v);
    }
    if let Ok(v) = std::env::var("SESSION_SECRET") {
        if !v.trim().is_empty() {
            cfg.session_secret = v;
        }
    }
    if let Ok(v) = std::env::var("ADMIN_PASSWORD_HASH") {
        if !v.trim().is_empty() {
            cfg.admin_password_hash = v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("UNIOB_SELF_PROBE_ENABLED") {
        match v.trim().to_ascii_lowercase().as_str() {
            "0" | "false" | "no" | "off" => cfg.self_probe_enabled = false,
            "1" | "true" | "yes" | "on" => cfg.self_probe_enabled = true,
            _ => {}
        }
    }
    if let Ok(v) = std::env::var("WATCHDOG_URL") {
        if !v.trim().is_empty() {
            cfg.watchdog_url = v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("WATCHDOG_SECRET") {
        if !v.is_empty() {
            cfg.watchdog_secret = v;
        }
    }
}

pub fn parse_email_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn read_hostname() -> Option<String> {
    if let Ok(h) = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")) {
        let t = h.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Ok(s) = std::fs::read_to_string("/etc/hostname") {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_flags_and_toml() {
        let args = CliArgs::parse_from([
            "uniob-hub",
            "--listen",
            "0.0.0.0:9090",
            "--db",
            "/tmp/test.db",
            "--web-dir",
            "/tmp/web",
            "--releases-dir",
            "/tmp/rel",
            "--import-bundle",
            "/tmp/bundle.json",
            "--import-only",
            "--watchdog-url",
            "https://wd.example.com/api/watchdog/ping",
            "--watchdog-secret",
            "sec123",
            "--allow-insecure-ws-for-test",
        ])
        .unwrap();

        assert_eq!(args.listen.as_deref(), Some("0.0.0.0:9090"));
        assert_eq!(args.db.as_deref(), Some(Path::new("/tmp/test.db")));
        assert!(args.import_only);
        assert!(args.allow_insecure_ws_for_test);

        let mut cfg = HubConfig::default();
        let toml_str = r#"
[server]
listen = "127.0.0.1:8787"
db_path = "/var/lib/uniob-hub/uniob.db"
web_dir = "/usr/local/share/uniob-hub/web"
releases_dir = "/usr/local/share/uniob-hub/releases"
public_url = "https://hub.example.com/"
github_repo = "acme/uniob"

[auth]
mode = "builtin"

[self_probe]
enabled = false

[watchdog]
url = "https://worker.example.com/api/watchdog/ping"
secret = "my-secret"
interval_sec = 300
"#;
        apply_toml(&mut cfg, toml_str).unwrap();
        assert_eq!(cfg.public_url, "https://hub.example.com");
        assert_eq!(cfg.github_repo, "acme/uniob");
        assert!(!cfg.self_probe_enabled);
        assert_eq!(cfg.watchdog_interval_sec, 300);
        assert_eq!(cfg.effective_auth_mode(), AuthMode::Builtin);
    }
}
