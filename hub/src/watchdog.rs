use crate::crypto::{now_sec, sign_watchdog_payload};
use crate::hub_state::HubState;
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct WatchdogPingPayload {
    pub hub_label: String,
    pub connected_agents: usize,
    pub total_nodes: usize,
    pub version: String,
    pub ts: i64,
}

pub async fn send_watchdog_ping_once(
    hub: &HubState,
    url: &str,
    secret: &str,
) -> Result<(), String> {
    let ts = now_sec();
    let status = hub.hub_status().await?;
    let payload = WatchdogPingPayload {
        hub_label: hub.cfg.hub_label.clone(),
        connected_agents: status.connected_agents,
        total_nodes: status.total_nodes,
        version: status.version,
        ts,
    };
    let raw_body =
        serde_json::to_string(&payload).map_err(|e| format!("Serialize watchdog payload: {e}"))?;
    let sig = sign_watchdog_payload(secret, ts, &raw_body);

    let resp = hub
        .http
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Watchdog-Timestamp", ts.to_string())
        .header("X-Watchdog-Signature", sig)
        .body(raw_body)
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            hub.record_watchdog_ping(ts, true).await;
            Ok(())
        }
        Ok(r) => {
            hub.record_watchdog_ping(ts, false).await;
            Err(format!("Watchdog HTTP {}", r.status()))
        }
        Err(e) => {
            hub.record_watchdog_ping(ts, false).await;
            Err(format!("Watchdog ping request failed: {e}"))
        }
    }
}

pub fn spawn_watchdog_loop(hub: HubState) {
    let url = hub.cfg.watchdog_url.trim().to_string();
    let secret = hub.cfg.watchdog_secret.clone();
    if url.is_empty() || secret.is_empty() {
        return;
    }
    let interval_sec = hub.cfg.watchdog_interval_sec.clamp(60, 3600);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_sec));
        loop {
            ticker.tick().await;
            if let Err(e) = send_watchdog_ping_once(&hub, &url, &secret).await {
                eprintln!("[uniob-hub] watchdog ping warning: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HubConfig;
    use crate::crypto::{constant_time_equal, hmac_sha256_hex};
    use crate::db::HubDb;
    use axum::{extract::State, http::HeaderMap, routing::post, Router};
    use std::sync::{Arc, Mutex};

    type CapturedPings = Arc<Mutex<Vec<(String, String, String)>>>;

    #[tokio::test]
    async fn watchdog_client_signs_and_delivers_ping() {
        let received: CapturedPings = Arc::new(Mutex::new(Vec::new()));
        let recv_clone = received.clone();

        let app = Router::new()
            .route(
                "/api/watchdog/ping",
                post(
                    |State(store): State<CapturedPings>,
                     headers: HeaderMap,
                     body: String| async move {
                        let ts = headers
                            .get("x-watchdog-timestamp")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let sig = headers
                            .get("x-watchdog-signature")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        store.lock().unwrap().push((ts, sig, body));
                        "{\"ok\":true}"
                    },
                ),
            )
            .with_state(recv_clone);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let cfg = HubConfig {
            watchdog_url: format!("http://{addr}/api/watchdog/ping"),
            watchdog_secret: "super-wd-secret".to_string(),
            hub_label: "test-hub".to_string(),
            ..Default::default()
        };

        let db = HubDb::open_in_memory().unwrap();
        let hub = HubState::new(cfg, db, reqwest::Client::new());
        let initial_status = hub.hub_status().await.unwrap();
        assert_eq!(initial_status.watchdog.status, "waiting");
        assert!(initial_status.watchdog.last_ping_ts.is_none());

        send_watchdog_ping_once(&hub, &hub.cfg.watchdog_url, &hub.cfg.watchdog_secret)
            .await
            .unwrap();

        {
            let captured = received.lock().unwrap();
            assert_eq!(captured.len(), 1);
            let (ts, sig, body) = &captured[0];
            let expected_sig =
                hmac_sha256_hex(b"super-wd-secret", format!("{ts}:{body}").as_bytes());
            assert!(constant_time_equal(sig, &expected_sig));
            assert!(body.contains("\"hub_label\":\"test-hub\""));
        }

        let status = hub.hub_status().await.unwrap();
        assert_eq!(status.watchdog.status, "healthy");
        assert!(status.watchdog.last_ping_ts.is_some());
    }
}
