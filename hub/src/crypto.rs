use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::digest::{digest, SHA256};
use ring::hmac;
use ring::pbkdf2::{self, PBKDF2_HMAC_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{RsaPublicKeyComponents, RSA_PKCS1_2048_8192_SHA256};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;
use std::time::{SystemTime, UNIX_EPOCH};

pub const PBKDF2_ITERATIONS: u32 = 100_000;
const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPayload {
    pub sub: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RsaJwk {
    pub kty: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default)]
    pub alg: Option<String>,
    pub n: String,
    pub e: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JwtHeader {
    pub alg: String,
    #[serde(default)]
    pub kid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum JwtAud {
    Single(String),
    Multi(Vec<String>),
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfAccessClaims {
    #[serde(default)]
    pub iss: Option<String>,
    #[serde(default)]
    pub aud: Option<JwtAud>,
    #[serde(default)]
    pub exp: Option<i64>,
    #[serde(default)]
    pub nbf: Option<i64>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub sub: Option<String>,
}

pub fn now_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn sha256_hex(data: &[u8]) -> String {
    let d = digest(&SHA256, data);
    hex::encode(d.as_ref())
}

pub fn hmac_sha256_bytes(key: &[u8], data: &[u8]) -> Vec<u8> {
    let k = hmac::Key::new(hmac::HMAC_SHA256, key);
    hmac::sign(&k, data).as_ref().to_vec()
}

pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    hex::encode(hmac_sha256_bytes(key, data))
}

pub fn constant_time_equal(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in ab.iter().zip(bb.iter()) {
        diff |= std::hint::black_box(x ^ y);
    }
    std::hint::black_box(diff) == 0
}

pub fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let rng = SystemRandom::new();
    let mut buf = vec![0u8; len];
    rng.fill(&mut buf)
        .map_err(|_| "CSPRNG fill failed".to_string())?;
    Ok(buf)
}

pub fn random_base62(len: usize) -> Result<String, String> {
    let rng = SystemRandom::new();
    let mut out = String::with_capacity(len);
    let mut buf = [0u8; 64];
    while out.len() < len {
        rng.fill(&mut buf)
            .map_err(|_| "CSPRNG fill failed".to_string())?;
        for &b in &buf {
            if b < 62 * 4 {
                out.push(BASE62[(b % 62) as usize] as char);
                if out.len() == len {
                    break;
                }
            }
        }
    }
    Ok(out)
}

pub fn to_base36(mut n: u128) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut chars = Vec::with_capacity(16);
    while n > 0 {
        chars.push(DIGITS[(n % 36) as usize] as char);
        n /= 36;
    }
    chars.into_iter().rev().collect()
}

pub fn generate_agent_token() -> Result<String, String> {
    Ok(format!("uob_live_{}", random_base62(43)?))
}

pub fn generate_session_secret() -> Result<String, String> {
    Ok(hex::encode(random_bytes(32)?))
}

pub fn generate_id(prefix: &str) -> Result<String, String> {
    let ts = to_base36(now_ms());
    let rand_part = random_base62(12)?;
    Ok(format!("{prefix}_{ts}_{rand_part}"))
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = random_bytes(16)?;
    let mut out = [0u8; 32];
    let iters = NonZeroU32::new(PBKDF2_ITERATIONS).unwrap();
    pbkdf2::derive(
        PBKDF2_HMAC_SHA256,
        iters,
        &salt,
        password.as_bytes(),
        &mut out,
    );
    Ok(format!(
        "pbkdf2${PBKDF2_ITERATIONS}${}${}",
        hex::encode(salt),
        hex::encode(out)
    ))
}

pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    let parts: Vec<&str> = stored_hash.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2" {
        return false;
    }
    let Ok(iters_raw) = parts[1].parse::<u32>() else {
        return false;
    };
    if iters_raw == 0 || iters_raw > 1_000_000 {
        return false;
    }
    let Some(iters) = NonZeroU32::new(iters_raw) else {
        return false;
    };
    let Ok(salt) = hex::decode(parts[2]) else {
        return false;
    };
    let Ok(expected) = hex::decode(parts[3]) else {
        return false;
    };
    if salt.is_empty() || expected.is_empty() {
        return false;
    }
    pbkdf2::verify(
        PBKDF2_HMAC_SHA256,
        iters,
        &salt,
        password.as_bytes(),
        &expected,
    )
    .is_ok()
}

pub fn sign_session_token(
    secret: &str,
    sub: &str,
    ttl_sec: i64,
    current_sec: i64,
) -> Result<String, String> {
    let payload = SessionPayload {
        sub: sub.to_string(),
        iat: current_sec,
        exp: current_sec + ttl_sec,
    };
    let payload_json =
        serde_json::to_string(&payload).map_err(|e| format!("Session encode failed: {e}"))?;
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let sig = hmac::sign(&key, payload_b64.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(sig.as_ref());
    Ok(format!("{payload_b64}.{sig_b64}"))
}

pub fn verify_session_token(secret: &str, token: &str, current_sec: i64) -> Option<SessionPayload> {
    if secret.is_empty() || token.is_empty() {
        return None;
    }
    let (payload_b64, sig_b64) = token.split_once('.')?;
    if sig_b64.contains('.') {
        return None;
    }
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig_b64).ok()?;
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hmac::verify(&key, payload_b64.as_bytes(), &sig_bytes).ok()?;
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let payload: SessionPayload = serde_json::from_slice(&payload_bytes).ok()?;
    if payload.sub.is_empty() || payload.exp <= current_sec {
        return None;
    }
    Some(payload)
}

pub fn sign_migrate_directive(
    token_sha256_hex: &str,
    node_id: &str,
    epoch: i64,
    ws_url: &str,
) -> String {
    let key_str = token_sha256_hex.to_ascii_lowercase();
    let msg = format!("{node_id}:{epoch}:{ws_url}");
    hmac_sha256_hex(key_str.as_bytes(), msg.as_bytes())
}

pub fn sign_watchdog_payload(secret: &str, timestamp_sec: i64, raw_body: &str) -> String {
    let msg = format!("{timestamp_sec}:{raw_body}");
    hmac_sha256_hex(secret.as_bytes(), msg.as_bytes())
}

pub fn sign_webhook_payload(secret: &str, raw_body: &str) -> String {
    format!(
        "sha256={}",
        hmac_sha256_hex(secret.as_bytes(), raw_body.as_bytes())
    )
}

pub fn verify_rs256_jwt(
    jwt: &str,
    jwks: &[RsaJwk],
    expected_iss: &str,
    expected_aud: &str,
    current_sec: i64,
) -> Result<CfAccessClaims, String> {
    let mut parts = jwt.split('.');
    let header_b64 = parts.next().ok_or("Malformed JWT")?;
    let payload_b64 = parts.next().ok_or("Malformed JWT")?;
    let sig_b64 = parts.next().ok_or("Malformed JWT")?;
    if parts.next().is_some() {
        return Err("Malformed JWT".to_string());
    }

    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_b64)
        .map_err(|_| "Invalid JWT header".to_string())?;
    let header: JwtHeader =
        serde_json::from_slice(&header_bytes).map_err(|_| "Invalid JWT header JSON".to_string())?;
    if header.alg != "RS256" {
        return Err(format!("Unsupported JWT alg: {}", header.alg));
    }

    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "Invalid JWT signature base64".to_string())?;
    let signed_input = format!("{header_b64}.{payload_b64}");

    let candidates: Vec<&RsaJwk> = match header.kid.as_deref() {
        Some(kid) => jwks
            .iter()
            .filter(|k| k.kty == "RSA" && k.kid.as_deref() == Some(kid))
            .collect(),
        None => jwks.iter().filter(|k| k.kty == "RSA").collect(),
    };
    if candidates.is_empty() {
        return Err("No matching RSA JWK found".to_string());
    }

    let mut verified = false;
    for jwk in candidates {
        if let (Ok(n), Ok(e)) = (
            URL_SAFE_NO_PAD.decode(&jwk.n),
            URL_SAFE_NO_PAD.decode(&jwk.e),
        ) {
            let n_trimmed = trim_leading_zeros(&n);
            let e_trimmed = trim_leading_zeros(&e);
            let rsa = RsaPublicKeyComponents {
                n: n_trimmed,
                e: e_trimmed,
            };
            if rsa
                .verify(
                    &RSA_PKCS1_2048_8192_SHA256,
                    signed_input.as_bytes(),
                    &sig_bytes,
                )
                .is_ok()
            {
                verified = true;
                break;
            }
        }
    }
    if !verified {
        return Err("Invalid JWT signature".to_string());
    }

    let claims_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| "Invalid JWT claims base64".to_string())?;
    let claims: CfAccessClaims =
        serde_json::from_slice(&claims_bytes).map_err(|_| "Invalid JWT claims JSON".to_string())?;

    if claims.iss.as_deref() != Some(expected_iss) {
        return Err("Invalid JWT issuer".to_string());
    }
    let aud_ok = match claims.aud.as_ref() {
        Some(JwtAud::Single(a)) => a == expected_aud,
        Some(JwtAud::Multi(arr)) => arr.iter().any(|a| a == expected_aud),
        None => false,
    };
    if !aud_ok {
        return Err("Invalid JWT audience".to_string());
    }
    if let Some(nbf) = claims.nbf {
        if nbf > current_sec + 60 {
            return Err("JWT not active yet".to_string());
        }
    }
    match claims.exp {
        Some(exp) if exp > current_sec => {}
        _ => return Err("JWT expired".to_string()),
    }

    Ok(claims)
}

fn trim_leading_zeros(bytes: &[u8]) -> &[u8] {
    let first_non_zero = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    if first_non_zero == bytes.len() && !bytes.is_empty() {
        &bytes[bytes.len() - 1..]
    } else {
        &bytes[first_non_zero..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_and_verify_compatible_format() {
        let h = hash_password("UniOB-StrongPass!2026").unwrap();
        assert!(h.starts_with("pbkdf2$100000$"));
        let parts: Vec<&str> = h.split('$').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[2].len(), 32);
        assert_eq!(parts[3].len(), 64);
        assert!(verify_password("UniOB-StrongPass!2026", &h));
        assert!(!verify_password("wrong", &h));
    }

    #[test]
    fn session_token_sign_verify_expiry() {
        let secret = "test-session-secret";
        let tok = sign_session_token(secret, "admin", 604800, 1_700_000_000).unwrap();
        let parsed = verify_session_token(secret, &tok, 1_700_000_100).unwrap();
        assert_eq!(parsed.sub, "admin");
        assert_eq!(parsed.exp, 1_700_604_800);
        assert!(verify_session_token(secret, &tok, 1_700_604_800).is_none());
        assert!(verify_session_token("wrong-secret", &tok, 1_700_000_100).is_none());
    }

    #[test]
    fn agent_token_and_migrate_hmac_match_spec() {
        let tok = generate_agent_token().unwrap();
        assert!(tok.starts_with("uob_live_"));
        assert_eq!(tok.len(), 9 + 43);

        let token_hash = sha256_hex(b"uob_live_example_token_0123456789abcdef01234567");
        let sig1 = sign_migrate_directive(
            &token_hash,
            "node_1",
            1_700_000_000,
            "wss://new.example.com/api/agent/ws",
        );
        let sig2 = hmac_sha256_hex(
            token_hash.to_lowercase().as_bytes(),
            b"node_1:1700000000:wss://new.example.com/api/agent/ws",
        );
        assert_eq!(sig1, sig2);
        assert_eq!(sig1.len(), 64);
    }

    #[test]
    fn watchdog_and_webhook_signatures() {
        let w = sign_watchdog_payload("wd-secret", 1_700_000_123, r#"{"ok":true}"#);
        let expected = hmac_sha256_hex(b"wd-secret", br#"1700000123:{"ok":true}"#);
        assert_eq!(w, expected);

        let wh = sign_webhook_payload("wh-sec", "hello");
        assert!(wh.starts_with("sha256="));
        assert_eq!(wh.len(), 7 + 64);
    }
}
