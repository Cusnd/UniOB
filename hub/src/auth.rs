use crate::config::{AuthMode, HubConfig};
use crate::crypto::{
    constant_time_equal, hash_password, now_sec, sha256_hex, sign_session_token, verify_password,
    verify_rs256_jwt, verify_session_token, RsaJwk,
};
use crate::db::HubDb;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

pub const SESSION_COOKIE_NAME: &str = "uniob_session";
pub const SESSION_TTL_SEC: i64 = 604_800; // 7 days
const RATE_LIMIT_WINDOW_SEC: i64 = 300; // 5 min
const RATE_LIMIT_MAX_FAILURES: usize = 5;
const JWKS_TTL_SEC: i64 = 3600;

#[derive(Debug, Clone, Serialize)]
pub struct AdminAuthStatus {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forbidden: Option<bool>,
    #[serde(rename = "needsSetup")]
    pub needs_setup: bool,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JwksDocument {
    #[serde(default)]
    keys: Vec<RsaJwk>,
}

struct CachedJwks {
    keys: Vec<RsaJwk>,
    fetched_at: i64,
}

#[derive(Clone)]
pub struct CfAccessVerifier {
    cache: Arc<RwLock<Option<CachedJwks>>>,
    http: reqwest::Client,
    certs_url_override: Option<String>,
}

impl CfAccessVerifier {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            cache: Arc::new(RwLock::new(None)),
            http,
            certs_url_override: None,
        }
    }

    #[cfg(test)]
    pub fn with_jwks_keys_for_test(keys: Vec<RsaJwk>) -> Self {
        Self {
            cache: Arc::new(RwLock::new(Some(CachedJwks {
                keys,
                fetched_at: now_sec(),
            }))),
            http: reqwest::Client::new(),
            certs_url_override: None,
        }
    }

    pub fn with_certs_url(mut self, url: String) -> Self {
        self.certs_url_override = Some(url);
        self
    }

    fn certs_url(&self, domain: &str) -> String {
        if let Some(ref ov) = self.certs_url_override {
            return ov.clone();
        }
        let d = domain
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');
        format!("https://{d}/cdn-cgi/access/certs")
    }

    fn expected_issuer(domain: &str) -> String {
        let d = domain
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');
        format!("https://{d}")
    }

    async fn fetch_jwks(&self, url: &str) -> Result<Vec<RsaJwk>, String> {
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch CF Access JWKS: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("JWKS HTTP {}", resp.status()));
        }
        let doc: JwksDocument = resp
            .json()
            .await
            .map_err(|e| format!("Invalid JWKS JSON: {e}"))?;
        Ok(doc.keys)
    }

    pub async fn verify_jwt(
        &self,
        jwt: &str,
        domain: &str,
        aud: &str,
    ) -> Result<Option<String>, String> {
        let current = now_sec();
        let iss = Self::expected_issuer(domain);
        let url = self.certs_url(domain);

        // Try cached JWKS first
        let cached_keys = {
            let guard = self.cache.read().await;
            guard
                .as_ref()
                .filter(|c| current - c.fetched_at < JWKS_TTL_SEC)
                .map(|c| c.keys.clone())
        };

        if let Some(keys) = cached_keys {
            if let Ok(claims) = verify_rs256_jwt(jwt, &keys, &iss, aud, current) {
                return Ok(claims.email);
            }
        }

        // Refresh JWKS once on cache miss or verification failure (key rotation)
        let fresh_keys = self.fetch_jwks(&url).await?;
        {
            let mut guard = self.cache.write().await;
            *guard = Some(CachedJwks {
                keys: fresh_keys.clone(),
                fetched_at: current,
            });
        }
        let claims = verify_rs256_jwt(jwt, &fresh_keys, &iss, aud, current)?;
        Ok(claims.email)
    }
}

#[derive(Clone, Default)]
pub struct LoginRateLimiter {
    attempts: Arc<Mutex<HashMap<String, Vec<i64>>>>,
}

impl LoginRateLimiter {
    pub fn check(&self, ip: &str, current_sec: i64) -> Result<(), u64> {
        let mut guard = self.attempts.lock().unwrap();
        let cutoff = current_sec - RATE_LIMIT_WINDOW_SEC;
        let list = guard.entry(ip.to_string()).or_default();
        list.retain(|&ts| ts > cutoff);
        if list.len() >= RATE_LIMIT_MAX_FAILURES {
            let oldest = list.first().copied().unwrap_or(current_sec);
            let retry_after = (oldest + RATE_LIMIT_WINDOW_SEC - current_sec).max(1) as u64;
            return Err(retry_after);
        }
        Ok(())
    }

    pub fn record_failure(&self, ip: &str, current_sec: i64) {
        let mut guard = self.attempts.lock().unwrap();
        if guard.len() > 2048 {
            guard.clear();
        }
        let cutoff = current_sec - RATE_LIMIT_WINDOW_SEC;
        let list = guard.entry(ip.to_string()).or_default();
        list.retain(|&ts| ts > cutoff);
        list.push(current_sec);
    }

    pub fn clear(&self, ip: &str) {
        let mut guard = self.attempts.lock().unwrap();
        guard.remove(ip);
    }
}

pub fn is_https_request(headers: &HeaderMap, cfg: &HubConfig) -> bool {
    if let Some(proto) = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        if proto.trim().eq_ignore_ascii_case("https") {
            return true;
        }
    }
    if let Some(cf_visitor) = headers.get("cf-visitor").and_then(|v| v.to_str().ok()) {
        if cf_visitor.contains("\"scheme\":\"https\"")
            || cf_visitor.contains("\"scheme\": \"https\"")
        {
            return true;
        }
    }
    cfg.public_url.starts_with("https://")
}

pub fn build_session_cookie(token: &str, is_https: bool) -> String {
    if is_https {
        format!(
            "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL_SEC}; Secure"
        )
    } else {
        format!(
            "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL_SEC}"
        )
    }
}

pub fn build_clear_session_cookie(is_https: bool) -> String {
    if is_https {
        format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure")
    } else {
        format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
    }
}

pub fn parse_cookie_value<'a>(cookie_header: Option<&'a str>, name: &str) -> Option<&'a str> {
    let raw = cookie_header?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == name {
                return Some(v.trim());
            }
        }
    }
    None
}

pub fn extract_client_ip(headers: &HeaderMap, peer_ip: Option<IpAddr>) -> String {
    if let Some(cf) = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
    {
        let s = cf.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next().map(|s| s.trim()) {
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    if let Some(xri) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        let s = xri.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    peer_ip
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

pub async fn get_admin_auth_status(
    headers: &HeaderMap,
    db: &HubDb,
    cfg: &HubConfig,
    cf_verifier: &CfAccessVerifier,
) -> Result<AdminAuthStatus, String> {
    if cfg.effective_auth_mode() == AuthMode::CfAccess {
        let domain = cfg.cf_access_team_domain.trim();
        let aud = cfg.cf_access_aud.trim();
        if domain.is_empty() || aud.is_empty() {
            return Ok(AdminAuthStatus {
                authenticated: false,
                forbidden: None,
                needs_setup: false,
                mode: "cf_access".to_string(),
                email: None,
            });
        }
        let Some(jwt) = headers
            .get("cf-access-jwt-assertion")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        else {
            return Ok(AdminAuthStatus {
                authenticated: false,
                forbidden: None,
                needs_setup: false,
                mode: "cf_access".to_string(),
                email: None,
            });
        };

        let email_opt = match cf_verifier.verify_jwt(jwt, domain, aud).await {
            Ok(email) => email
                .map(|e| e.trim().to_string())
                .filter(|e| !e.is_empty()),
            Err(_) => {
                return Ok(AdminAuthStatus {
                    authenticated: false,
                    forbidden: None,
                    needs_setup: false,
                    mode: "cf_access".to_string(),
                    email: None,
                });
            }
        };

        if !cfg.cf_access_allowed_emails.is_empty() {
            let allowset: HashSet<&str> = cfg
                .cf_access_allowed_emails
                .iter()
                .map(|s| s.as_str())
                .collect();
            let allowed = email_opt
                .as_deref()
                .map(|e| allowset.contains(e.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            if !allowed {
                return Ok(AdminAuthStatus {
                    authenticated: false,
                    forbidden: Some(true),
                    needs_setup: false,
                    mode: "cf_access".to_string(),
                    email: email_opt,
                });
            }
        }

        return Ok(AdminAuthStatus {
            authenticated: true,
            forbidden: None,
            needs_setup: false,
            mode: "cf_access".to_string(),
            email: email_opt,
        });
    }

    let admin_hash = get_effective_admin_password_hash(db, cfg)?;
    let Some(_) = admin_hash else {
        return Ok(AdminAuthStatus {
            authenticated: false,
            forbidden: None,
            needs_setup: true,
            mode: "builtin".to_string(),
            email: None,
        });
    };

    let cookie_header = headers.get("cookie").and_then(|v| v.to_str().ok());
    let Some(token) = parse_cookie_value(cookie_header, SESSION_COOKIE_NAME) else {
        return Ok(AdminAuthStatus {
            authenticated: false,
            forbidden: None,
            needs_setup: false,
            mode: "builtin".to_string(),
            email: None,
        });
    };

    let secret = db.ensure_session_secret(&cfg.session_secret)?;
    let valid = verify_session_token(&secret, token, now_sec()).is_some();
    Ok(AdminAuthStatus {
        authenticated: valid,
        forbidden: None,
        needs_setup: false,
        mode: "builtin".to_string(),
        email: None,
    })
}

pub fn get_effective_admin_password_hash(
    db: &HubDb,
    cfg: &HubConfig,
) -> Result<Option<String>, String> {
    if !cfg.admin_password_hash.trim().is_empty() {
        return Ok(Some(cfg.admin_password_hash.trim().to_string()));
    }
    Ok(db
        .get_setting("admin_password_hash")?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

pub fn setup_initial_password(
    password: &str,
    db: &HubDb,
    cfg: &HubConfig,
) -> Result<(), (u16, String)> {
    if cfg.effective_auth_mode() == AuthMode::CfAccess {
        return Err((
            400,
            "Setup is disabled when Cloudflare Access mode is active".to_string(),
        ));
    }
    if !cfg.admin_password_hash.trim().is_empty() {
        return Err((
            409,
            "Admin password is already configured via config/environment".to_string(),
        ));
    }
    if password.chars().count() < 6 {
        return Err((400, "Password must be at least 6 characters".to_string()));
    }
    let hash = hash_password(password).map_err(|e| (500, e))?;
    let ts = now_sec();
    let inserted = db
        .with_conn(|c| {
            let changes = c
                .execute(
                    "INSERT OR IGNORE INTO system_settings (key, value, updated_at)
                     VALUES ('admin_password_hash', ?1, ?2)",
                    rusqlite::params![hash, ts],
                )
                .map_err(|e| format!("setup_initial_password DB error: {e}"))?;
            Ok(changes)
        })
        .map_err(|e| (500, e))?;
    if inserted == 0 {
        return Err((409, "Admin password is already configured".to_string()));
    }
    Ok(())
}

pub fn verify_admin_login(
    password: &str,
    client_ip: &str,
    db: &HubDb,
    cfg: &HubConfig,
    limiter: &LoginRateLimiter,
) -> Result<(), (u16, String, Option<u64>)> {
    if cfg.effective_auth_mode() == AuthMode::CfAccess {
        return Err((
            400,
            "Password login is disabled when Cloudflare Access mode is active".to_string(),
            None,
        ));
    }
    let ts = now_sec();
    if let Err(retry_after) = limiter.check(client_ip, ts) {
        return Err((
            429,
            "Too many failed login attempts, please try again later".to_string(),
            Some(retry_after),
        ));
    }

    let stored = get_effective_admin_password_hash(db, cfg).map_err(|e| (500, e, None))?;
    let Some(stored_hash) = stored else {
        return Err((
            400,
            "Admin password has not been configured yet".to_string(),
            None,
        ));
    };

    if password.is_empty() || !verify_password(password, &stored_hash) {
        limiter.record_failure(client_ip, ts);
        return Err((401, "Invalid password".to_string(), None));
    }

    limiter.clear(client_ip);
    Ok(())
}

pub fn create_admin_session_cookie(
    headers: &HeaderMap,
    db: &HubDb,
    cfg: &HubConfig,
) -> Result<String, String> {
    let secret = db.ensure_session_secret(&cfg.session_secret)?;
    let token = sign_session_token(&secret, "admin", SESSION_TTL_SEC, now_sec())?;
    Ok(build_session_cookie(&token, is_https_request(headers, cfg)))
}

pub fn is_valid_node_id(node_id: &str) -> bool {
    let len = node_id.len();
    (4..=64).contains(&len)
        && node_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_valid_agent_token(token: &str) -> bool {
    let Some(rest) = token.strip_prefix("uob_live_") else {
        return false;
    };
    (32..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn verify_agent_headers(headers: &HeaderMap, db: &HubDb) -> Result<String, (u16, String)> {
    let node_id = headers
        .get("x-uniob-node-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .unwrap_or("");
    if !is_valid_node_id(node_id) {
        return Err((401, "Invalid X-UniOB-Node-Id header".to_string()));
    }

    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .unwrap_or("");
    let Some(token) = auth.strip_prefix("Bearer ").map(|s| s.trim()) else {
        return Err((401, "Missing Bearer authorization".to_string()));
    };
    if !is_valid_agent_token(token) {
        return Err((401, "Invalid agent token format".to_string()));
    }

    let expected_hash = db.get_node_token_hash(node_id).map_err(|e| (500, e))?;
    let Some(stored_hash) = expected_hash else {
        return Err((401, "Invalid node credentials".to_string()));
    };
    let actual_hash = sha256_hex(token.as_bytes());
    if !constant_time_equal(&stored_hash.to_ascii_lowercase(), &actual_hash) {
        return Err((401, "Invalid node credentials".to_string()));
    }

    Ok(node_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::NodeRow;

    #[tokio::test]
    async fn setup_login_rate_limit_and_cookie_roundtrip() {
        let db = HubDb::open_in_memory().unwrap();
        let cfg = HubConfig::default();
        let limiter = LoginRateLimiter::default();
        let cf = CfAccessVerifier::new(reqwest::Client::new());

        let status = get_admin_auth_status(&HeaderMap::new(), &db, &cfg, &cf)
            .await
            .unwrap();
        assert!(!status.authenticated);
        assert!(status.needs_setup);
        assert_eq!(status.mode, "builtin");

        setup_initial_password("SuperSecret123", &db, &cfg).unwrap();
        // Second setup returns 409
        assert_eq!(
            setup_initial_password("AnotherPass123", &db, &cfg)
                .unwrap_err()
                .0,
            409
        );

        // 5 failed attempts trigger 429 on 6th attempt
        for _ in 0..5 {
            let err = verify_admin_login("wrong", "1.2.3.4", &db, &cfg, &limiter).unwrap_err();
            assert_eq!(err.0, 401);
        }
        let locked =
            verify_admin_login("SuperSecret123", "1.2.3.4", &db, &cfg, &limiter).unwrap_err();
        assert_eq!(locked.0, 429);
        assert!(locked.2.unwrap() > 0);

        // Other IP succeeds cleanly
        verify_admin_login("SuperSecret123", "5.6.7.8", &db, &cfg, &limiter).unwrap();

        let mut hdrs = HeaderMap::new();
        hdrs.insert("x-forwarded-proto", "https".parse().unwrap());
        let cookie = create_admin_session_cookie(&hdrs, &db, &cfg).unwrap();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Secure"));

        let cookie_kv = cookie.split(';').next().unwrap();
        let mut req_hdrs = HeaderMap::new();
        req_hdrs.insert("cookie", cookie_kv.parse().unwrap());
        let authed = get_admin_auth_status(&req_hdrs, &db, &cfg, &cf)
            .await
            .unwrap();
        assert!(authed.authenticated);
        assert!(!authed.needs_setup);
    }

    #[test]
    fn agent_bearer_auth_verifies_sha256_token() {
        let db = HubDb::open_in_memory().unwrap();
        let tok = crate::crypto::generate_agent_token().unwrap();
        let ts = now_sec();
        db.insert_node(&NodeRow {
            id: "node_auth1".into(),
            name: "AuthNode".into(),
            group_name: "Default".into(),
            tags_json: "[]".into(),
            sort_order: 0,
            token_sha256: sha256_hex(tok.as_bytes()),
            traffic_limit_bytes: None,
            traffic_reset_day: 1,
            traffic_count_mode: "both".into(),
            hostname: None,
            os: None,
            kernel: None,
            arch: None,
            cpu_model: None,
            cpu_cores: None,
            mem_total: None,
            swap_total: None,
            agent_version: None,
            proc_enabled: 1,
            mute_until: None,
            auto_update_override: None,
            caps_json: "[]".into(),
            update_status_json: None,
            created_at: ts,
            updated_at: ts,
        })
        .unwrap();

        let mut hdrs = HeaderMap::new();
        hdrs.insert("x-uniob-node-id", "node_auth1".parse().unwrap());
        hdrs.insert("authorization", format!("Bearer {tok}").parse().unwrap());
        assert_eq!(verify_agent_headers(&hdrs, &db).unwrap(), "node_auth1");

        let mut bad = HeaderMap::new();
        bad.insert("x-uniob-node-id", "node_auth1".parse().unwrap());
        bad.insert(
            "authorization",
            "Bearer uob_live_0000000000000000000000000000000000000000000"
                .parse()
                .unwrap(),
        );
        assert_eq!(verify_agent_headers(&bad, &db).unwrap_err().0, 401);
    }
}
