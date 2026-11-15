use crate::alerts::{send_channel_notification, AlertNotificationPayload};
use crate::auth::{
    build_clear_session_cookie, create_admin_session_cookie, extract_client_ip,
    get_admin_auth_status, is_https_request, setup_initial_password, verify_admin_login,
    verify_agent_headers,
};
use crate::crypto::{
    constant_time_equal, generate_agent_token, generate_id, now_sec, random_base62, sha256_hex,
};
use crate::hub_state::{validate_and_normalize_migrate_url, AgentOutboundCmd, HubState};
use crate::install_scripts::{render_install_agent_script, render_install_hub_script};
use crate::protocol::{
    AgentInboundFrame, AlertIncidentRow, AlertRuleRow, AlertRuleView, ClientInboundMessage,
    ExportSystemSettingEntry, HubMigrateRequest, ImportBundlePayload, ImportCounts, NodeRow,
    NotificationChannelRow, NotificationChannelView,
};
use axum::body::{Body, Bytes};
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{ConnectInfo, Path as AxumPath, Query, Request, State, WebSocketUpgrade};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;
use tower_http::services::{ServeDir, ServeFile};
use url::Url;

pub fn build_router(hub: HubState) -> Router {
    let protected = Router::new()
        .route("/api/client/ws", get(client_ws_handler))
        .route("/api/hub/status", get(hub_status_handler))
        .route("/api/export/bundle", get(export_bundle_handler))
        .route("/api/import/bundle", post(import_bundle_handler))
        .route("/api/hub/migrate", post(hub_migrate_handler))
        .route(
            "/api/migration/ticket",
            post(create_migration_ticket_handler),
        )
        .route("/api/hub/migrate-smart", post(hub_migrate_smart_handler))
        .route(
            "/api/nodes",
            get(list_nodes_handler).post(create_node_handler),
        )
        .route(
            "/api/nodes/{id}",
            axum::routing::patch(update_node_handler).delete(delete_node_handler),
        )
        .route(
            "/api/nodes/{id}/rotate-token",
            post(rotate_node_token_handler),
        )
        .route("/api/nodes/{id}/metrics", get(node_metrics_handler))
        .route(
            "/api/alerts/channels",
            get(list_channels_handler).post(create_channel_handler),
        )
        .route(
            "/api/alerts/channels/{id}",
            axum::routing::patch(update_channel_handler).delete(delete_channel_handler),
        )
        .route("/api/alerts/channels/{id}/test", post(test_channel_handler))
        .route(
            "/api/alerts/rules",
            get(list_rules_handler).post(create_rule_handler),
        )
        .route(
            "/api/alerts/rules/presets",
            post(apply_rule_presets_handler),
        )
        .route(
            "/api/alerts/rules/{id}",
            axum::routing::patch(update_rule_handler).delete(delete_rule_handler),
        )
        .route("/api/alerts/incidents", get(list_incidents_handler))
        .route_layer(middleware::from_fn_with_state(
            hub.clone(),
            require_admin_auth,
        ));

    let spa_dir = hub.cfg.web_dir.clone();
    let index_file = spa_dir.join("index.html");
    let spa_service = ServeDir::new(spa_dir).fallback(ServeFile::new(index_file));

    Router::new()
        .route("/install.sh", get(install_agent_script_handler))
        .route("/install-hub.sh", get(install_hub_script_handler))
        .route(
            "/releases/{*path}",
            get(releases_get_handler).post(releases_post_handler),
        )
        .route("/api/auth/me", get(auth_me_handler))
        .route("/api/auth/setup", post(auth_setup_handler))
        .route("/api/auth/login", post(auth_login_handler))
        .route("/api/auth/logout", post(auth_logout_handler))
        .route("/api/agent/ws", get(agent_ws_handler))
        .route("/api/migration/pull/{token}", get(migration_pull_handler))
        .route("/api/migration/receive", post(migration_receive_handler))
        .merge(protected)
        .route("/api/{*rest}", any(api_not_found_handler))
        .fallback_service(spa_service)
        .with_state(hub)
}

async fn require_admin_auth(State(hub): State<HubState>, req: Request, next: Next) -> Response {
    match get_admin_auth_status(req.headers(), &hub.db, &hub.cfg, &hub.cf_verifier).await {
        Ok(status) => {
            if !status.authenticated {
                if status.forbidden == Some(true) {
                    return json_error(StatusCode::FORBIDDEN, "Forbidden: email is not authorized");
                }
                return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
            }
            next.run(req).await
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

fn request_origin(headers: &HeaderMap, hub: &HubState) -> String {
    if !hub.cfg.public_url.is_empty() {
        return hub.cfg.public_url.clone();
    }
    let scheme = if is_https_request(headers, &hub.cfg) {
        "https"
    } else {
        "http"
    };
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&hub.cfg.listen);
    format!("{scheme}://{host}")
}

fn build_install_command(origin: &str, node_id: &str, token: &str) -> String {
    let ws_origin = if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_string()
    };
    format!(
        "curl -fsSL {origin}/install.sh | sudo bash -s -- --url {ws_origin} --id {node_id} --token {token}"
    )
}

async fn install_agent_script_handler(State(hub): State<HubState>, headers: HeaderMap) -> Response {
    let origin = request_origin(&headers, &hub);
    let body = render_install_agent_script(&hub.cfg.github_repo, &origin);
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/x-shellscript; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn install_hub_script_handler(State(hub): State<HubState>, headers: HeaderMap) -> Response {
    let origin = request_origin(&headers, &hub);
    let body = render_install_hub_script(&hub.cfg.github_repo, &origin);
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/x-shellscript; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn releases_get_handler(
    State(hub): State<HubState>,
    AxumPath(rel_path): AxumPath<String>,
) -> Response {
    let trimmed = rel_path.trim_start_matches('/');
    if let Some(token) = trimmed.strip_prefix("migration/pull/") {
        return migration_pull_with_token(&hub, token).await;
    }
    serve_release_file_handler(State(hub), AxumPath(rel_path)).await
}

async fn releases_post_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    AxumPath(rel_path): AxumPath<String>,
    body: Bytes,
) -> Response {
    let trimmed = rel_path.trim_start_matches('/');
    if trimmed == "migration/receive" {
        return migration_receive_inner(&hub, &headers, &body).await;
    }
    json_error(StatusCode::NOT_FOUND, "Not Found")
}

async fn serve_release_file_handler(
    State(hub): State<HubState>,
    AxumPath(rel_path): AxumPath<String>,
) -> Response {
    let trimmed = rel_path.trim_start_matches('/');
    if trimmed.is_empty()
        || trimmed.contains('\\')
        || trimmed
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.'))
    {
        return json_error(StatusCode::NOT_FOUND, "Release asset not found");
    }
    let candidate = PathBuf::from(&hub.cfg.releases_dir).join(trimmed);
    let Ok(base_canon) = std::fs::canonicalize(&hub.cfg.releases_dir) else {
        return json_error(StatusCode::NOT_FOUND, "Releases directory unavailable");
    };
    let Ok(file_canon) = std::fs::canonicalize(&candidate) else {
        return json_error(StatusCode::NOT_FOUND, "Release asset not found");
    };
    if !file_canon.starts_with(&base_canon) || !file_canon.is_file() {
        return json_error(StatusCode::NOT_FOUND, "Release asset not found");
    }

    let bytes = match tokio::fs::read(&file_canon).await {
        Ok(b) => b,
        Err(_) => return json_error(StatusCode::NOT_FOUND, "Release asset unreadable"),
    };
    let content_type = if trimmed.ends_with("SHA256SUMS") || trimmed.ends_with(".txt") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn api_not_found_handler() -> Response {
    json_error(StatusCode::NOT_FOUND, "Not Found")
}

// ---- Auth endpoints ----

async fn auth_me_handler(State(hub): State<HubState>, headers: HeaderMap) -> Response {
    match get_admin_auth_status(&headers, &hub.db, &hub.cfg, &hub.cf_verifier).await {
        Ok(st) => Json(st).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

#[derive(Deserialize)]
struct PasswordBody {
    #[serde(default)]
    password: Value,
}

async fn auth_setup_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    Json(body): Json<PasswordBody>,
) -> Response {
    let password = body.password.as_str().unwrap_or("");
    if let Err((code, msg)) = setup_initial_password(password, &hub.db, &hub.cfg) {
        return json_error(
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
            &msg,
        );
    }
    let cookie = match create_admin_session_cookie(&headers, &hub.db, &hub.cfg) {
        Ok(c) => c,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let mut resp = Json(json!({ "ok": true })).into_response();
    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(SET_COOKIE, hv);
    }
    resp
}

async fn auth_login_handler(State(hub): State<HubState>, req: Request) -> Response {
    let headers = req.headers().clone();
    let peer_ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    let client_ip = extract_client_ip(&headers, peer_ip);

    let body_bytes = match axum::body::to_bytes(req.into_body(), 64 * 1024).await {
        Ok(b) => b,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "Invalid request body"),
    };
    let parsed: PasswordBody = serde_json::from_slice(&body_bytes).unwrap_or(PasswordBody {
        password: Value::Null,
    });
    let password = parsed.password.as_str().unwrap_or("");

    if let Err((code, msg, retry_after)) =
        verify_admin_login(password, &client_ip, &hub.db, &hub.cfg, &hub.rate_limiter)
    {
        let mut resp = json_error(
            StatusCode::from_u16(code).unwrap_or(StatusCode::UNAUTHORIZED),
            &msg,
        );
        if let Some(sec) = retry_after {
            if let Ok(hv) = HeaderValue::from_str(&sec.to_string()) {
                resp.headers_mut().insert("Retry-After", hv);
            }
        }
        return resp;
    }

    let cookie = match create_admin_session_cookie(&headers, &hub.db, &hub.cfg) {
        Ok(c) => c,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let mut resp = Json(json!({ "ok": true })).into_response();
    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(SET_COOKIE, hv);
    }
    resp
}

async fn auth_logout_handler(State(hub): State<HubState>, headers: HeaderMap) -> Response {
    let clear = build_clear_session_cookie(is_https_request(&headers, &hub.cfg));
    let mut resp = Json(json!({ "ok": true })).into_response();
    if let Ok(hv) = HeaderValue::from_str(&clear) {
        resp.headers_mut().insert(SET_COOKIE, hv);
    }
    resp
}

// ---- WebSocket handlers ----

async fn agent_ws_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let Ok(ws) = ws else {
        return json_error(StatusCode::UPGRADE_REQUIRED, "Expected WebSocket upgrade");
    };
    let node_id = match verify_agent_headers(&headers, &hub.db) {
        Ok(id) => id,
        Err((code, msg)) => {
            return json_error(
                StatusCode::from_u16(code).unwrap_or(StatusCode::UNAUTHORIZED),
                &msg,
            );
        }
    };
    ws.on_upgrade(move |socket| handle_agent_socket(hub, node_id, socket))
}

async fn handle_agent_socket(hub: HubState, node_id: String, socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<AgentOutboundCmd>();
    let conn_id = hub.register_agent(&node_id, tx.clone()).await;

    let writer = tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                AgentOutboundCmd::Ctrl(ctrl) => {
                    if let Ok(json) = serde_json::to_string(&ctrl) {
                        if ws_tx.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                }
                AgentOutboundCmd::Close(code, reason) => {
                    let _ = ws_tx
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    let _ = ws_tx.close().await;
                    break;
                }
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(txt) => {
                hub.touch_agent_alive(&node_id, now_sec()).await;
                if let Ok(frame) = serde_json::from_str::<AgentInboundFrame>(txt.as_str()) {
                    match frame {
                        AgentInboundFrame::Hello(hello) => {
                            if let Ok(ctrl) = hub.ingest_hello(&node_id, Some(conn_id), hello).await
                            {
                                let _ = tx.send(AgentOutboundCmd::Ctrl(ctrl));
                            }
                        }
                        AgentInboundFrame::Metrics(m) => {
                            let _ = hub.ingest_metrics_v1(&node_id, m).await;
                        }
                        AgentInboundFrame::MetricsBatch(mb) => {
                            let _ = hub.ingest_metrics_v2_mb(&node_id, mb).await;
                        }
                    }
                }
            }
            Message::Ping(_) | Message::Pong(_) => {
                hub.touch_agent_alive(&node_id, now_sec()).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    hub.unregister_agent(&node_id, conn_id).await;
    writer.abort();
}

async fn client_ws_handler(
    State(hub): State<HubState>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let Ok(ws) = ws else {
        return json_error(StatusCode::UPGRADE_REQUIRED, "Expected WebSocket upgrade");
    };
    ws.on_upgrade(move |socket| handle_client_socket(hub, socket))
}

async fn handle_client_socket(hub: HubState, socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let client_id = hub.register_client(tx).await;

    let writer = tokio::spawn(async move {
        while let Some(json) = rx.recv().await {
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(txt) => {
                if let Ok(cmd) = serde_json::from_str::<ClientInboundMessage>(txt.as_str()) {
                    hub.handle_client_command(client_id, cmd).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    hub.unregister_client(client_id).await;
    writer.abort();
}

// ---- Hub control plane endpoints ----

async fn hub_status_handler(State(hub): State<HubState>) -> Response {
    match hub.hub_status().await {
        Ok(st) => Json(st).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn export_bundle_handler(State(hub): State<HubState>) -> Response {
    match hub.db.export_bundle(now_sec()) {
        Ok(bundle) => Json(bundle).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn import_bundle_handler(
    State(hub): State<HubState>,
    Json(payload): Json<ImportBundlePayload>,
) -> Response {
    match hub.db.import_bundle(&payload, now_sec()) {
        Ok(res) => {
            hub.sync_ctrl_to_all_agents(false).await;
            Json(res).into_response()
        }
        Err(e) => json_error(StatusCode::BAD_REQUEST, &e),
    }
}

async fn hub_migrate_handler(
    State(hub): State<HubState>,
    Json(payload): Json<HubMigrateRequest>,
) -> Response {
    match hub.dispatch_migrate(payload).await {
        Ok(res) => Json(res).into_response(),
        Err((code, msg)) => json_error(
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
            &msg,
        ),
    }
}

const MIGRATION_TICKET_TTL_SEC: i64 = 1800;

#[derive(Debug, Deserialize)]
struct CreateMigrationTicketRequest {
    #[serde(default)]
    purpose: String,
    #[serde(default)]
    public_origin: Option<String>,
    #[serde(default)]
    enable_watchdog: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MigrationReceiveTicketRecord {
    token_sha256: String,
    expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct MigrationPullTicketRecord {
    token_sha256: String,
    expires_at: i64,
    #[serde(default)]
    receive_token_sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MigrationPairedTokenRecord {
    raw_receive_token: String,
    expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct MigrationCodePayload {
    u: String,
    k: String,
}

#[derive(Debug, Deserialize)]
struct HubMigrateSmartRequest {
    #[serde(default)]
    target_input: String,
    #[serde(default)]
    node_ids: Option<Vec<String>>,
    #[serde(default)]
    allow_insecure_ws: bool,
}

fn no_store_json<T: Serialize>(status: StatusCode, body: &T) -> Response {
    match serde_json::to_vec(body) {
        Ok(bytes) => Response::builder()
            .status(status)
            .header(CONTENT_TYPE, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn normalize_http_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("origin is required".to_string());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&candidate).map_err(|e| format!("Invalid origin URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Origin must use http:// or https://".to_string());
    }
    if url.host_str().is_none() {
        return Err("Origin missing host".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn ws_url_to_http_origin(ws_url: &str) -> Result<String, String> {
    let mut parsed = Url::parse(ws_url).map_err(|e| format!("Invalid target URL: {e}"))?;
    let http_scheme = match parsed.scheme() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        other => return Err(format!("Unsupported URL scheme: {other}")),
    };
    let _ = parsed.set_scheme(http_scheme);
    Ok(parsed.origin().ascii_serialization())
}

fn sanitize_single_quoted_arg(val: &str) -> String {
    val.trim()
        .replace(['\r', '\n', '\0'], "")
        .replace('\'', "'\\''")
}

fn extract_migration_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        let trimmed = auth.trim();
        if trimmed
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
        {
            let token = trimmed[7..].trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    headers
        .get("x-migration-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn create_migration_ticket_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let req: CreateMigrationTicketRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("Invalid JSON body: {e}")),
    };

    let raw_origin = match req
        .public_origin
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(custom) => custom.to_string(),
        None => request_origin(&headers, &hub),
    };
    let origin = match normalize_http_origin(&raw_origin) {
        Ok(o) => o,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
    };

    let now = now_sec();
    let expires_at = now + MIGRATION_TICKET_TTL_SEC;

    match req.purpose.trim() {
        "receive" => {
            let suffix = match random_base62(43) {
                Ok(s) => s,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            };
            let raw_token = format!("uob_mtk_{suffix}");
            let record = MigrationReceiveTicketRecord {
                token_sha256: sha256_hex(raw_token.as_bytes()),
                expires_at,
            };
            let serialized = match serde_json::to_string(&record) {
                Ok(s) => s,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            };
            if let Err(e) = hub
                .db
                .set_setting("migration_receive_ticket", &serialized, now)
            {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
            }
            let code_bytes = match serde_json::to_vec(&MigrationCodePayload {
                u: origin.clone(),
                k: raw_token,
            }) {
                Ok(b) => b,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            };
            let migration_code = format!("uobm1_{}", URL_SAFE_NO_PAD.encode(code_bytes));
            no_store_json(
                StatusCode::OK,
                &json!({
                    "ok": true,
                    "purpose": "receive",
                    "origin": origin,
                    "migration_code": migration_code,
                    "expires_at": expires_at,
                }),
            )
        }
        "install" => {
            let pull_suffix = match random_base62(43) {
                Ok(s) => s,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            };
            let recv_suffix = match random_base62(43) {
                Ok(s) => s,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            };
            let pull_token = format!("uob_mpull_{pull_suffix}");
            let receive_token = format!("uob_mtk_{recv_suffix}");
            let receive_token_sha256 = sha256_hex(receive_token.as_bytes());

            let pull_record = MigrationPullTicketRecord {
                token_sha256: sha256_hex(pull_token.as_bytes()),
                expires_at,
                receive_token_sha256: Some(receive_token_sha256),
            };
            let paired_record = MigrationPairedTokenRecord {
                raw_receive_token: receive_token,
                expires_at,
            };
            let pull_serialized = match serde_json::to_string(&pull_record) {
                Ok(s) => s,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            };
            let paired_serialized = match serde_json::to_string(&paired_record) {
                Ok(s) => s,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            };
            if let Err(e) = hub
                .db
                .set_setting("migration_pull_ticket", &pull_serialized, now)
            {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
            }
            if let Err(e) = hub
                .db
                .set_setting("migration_paired_token", &paired_serialized, now)
            {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
            }

            let pull_url = format!("{origin}/releases/migration/pull/{pull_token}");
            let safe_origin = sanitize_single_quoted_arg(&origin);
            let safe_pull_url = sanitize_single_quoted_arg(&pull_url);
            let mut install_cmd = format!(
                "curl -fsSL '{safe_origin}/install-hub.sh' | sudo bash -s -- --import-bundle '{safe_pull_url}'"
            );
            let wd_url = hub.cfg.watchdog_url.trim();
            let wd_secret = hub.cfg.watchdog_secret.trim();
            let watchdog_armed =
                req.enable_watchdog != Some(false) && !wd_url.is_empty() && !wd_secret.is_empty();
            if watchdog_armed {
                let safe_wd_url = sanitize_single_quoted_arg(wd_url);
                let safe_wd_secret = sanitize_single_quoted_arg(wd_secret);
                install_cmd.push_str(&format!(
                    " --watchdog-url '{safe_wd_url}' --watchdog-secret '{safe_wd_secret}'"
                ));
            }

            no_store_json(
                StatusCode::OK,
                &json!({
                    "ok": true,
                    "purpose": "install",
                    "origin": origin,
                    "pull_url": pull_url,
                    "install_cmd": install_cmd,
                    "watchdog_armed": watchdog_armed,
                    "expires_at": expires_at,
                }),
            )
        }
        _ => json_error(
            StatusCode::BAD_REQUEST,
            "purpose must be 'receive' or 'install'",
        ),
    }
}

async fn migration_pull_handler(
    State(hub): State<HubState>,
    AxumPath(token): AxumPath<String>,
) -> Response {
    migration_pull_with_token(&hub, &token).await
}

async fn migration_pull_with_token(hub: &HubState, raw_token: &str) -> Response {
    const INVALID_PULL_MSG: &str = "迁移安装链接已过期或无效，请回到原面板重新生成";

    let token = raw_token.trim();
    if !token.starts_with("uob_mpull_")
        || token.len() <= "uob_mpull_".len()
        || token.len() > 128
        || token.contains('/')
    {
        return no_store_json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": INVALID_PULL_MSG }),
        );
    }

    let ticket_raw = match hub.db.get_setting("migration_pull_ticket") {
        Ok(Some(v)) => v,
        Ok(None) => {
            return no_store_json(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": INVALID_PULL_MSG }),
            );
        }
        Err(e) => return no_store_json(StatusCode::INTERNAL_SERVER_ERROR, &json!({ "error": e })),
    };

    let ticket: MigrationPullTicketRecord = match serde_json::from_str(&ticket_raw) {
        Ok(t) => t,
        Err(_) => {
            return no_store_json(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": INVALID_PULL_MSG }),
            );
        }
    };

    let now = now_sec();
    let supplied_hash = sha256_hex(token.as_bytes());
    if now > ticket.expires_at || !constant_time_equal(&supplied_hash, &ticket.token_sha256) {
        return no_store_json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": INVALID_PULL_MSG }),
        );
    }

    let mut bundle = match hub.db.export_bundle(now) {
        Ok(b) => b,
        Err(e) => return no_store_json(StatusCode::INTERNAL_SERVER_ERROR, &json!({ "error": e })),
    };

    if let Some(recv_hash) = ticket.receive_token_sha256.filter(|s| !s.is_empty()) {
        bundle.system_settings.push(ExportSystemSettingEntry {
            key: "migration_receive_ticket".to_string(),
            value: json!({
                "token_sha256": recv_hash,
                "expires_at": ticket.expires_at,
            })
            .to_string(),
            updated_at: now,
        });
    }

    no_store_json(StatusCode::OK, &bundle)
}

async fn migration_receive_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    migration_receive_inner(&hub, &headers, &body).await
}

async fn migration_receive_inner(hub: &HubState, headers: &HeaderMap, body: &Bytes) -> Response {
    const INVALID_RECEIVE_MSG: &str = "迁移口令已过期或无效，请在新面板重新生成迁移口令";

    let Some(token) = extract_migration_token(headers) else {
        return no_store_json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": INVALID_RECEIVE_MSG }),
        );
    };
    if !token.starts_with("uob_mtk_") || token.len() <= "uob_mtk_".len() || token.len() > 128 {
        return no_store_json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": INVALID_RECEIVE_MSG }),
        );
    }

    let ticket_raw = match hub.db.get_setting("migration_receive_ticket") {
        Ok(Some(v)) => v,
        Ok(None) => {
            return no_store_json(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": INVALID_RECEIVE_MSG }),
            );
        }
        Err(e) => return no_store_json(StatusCode::INTERNAL_SERVER_ERROR, &json!({ "error": e })),
    };

    let ticket: MigrationReceiveTicketRecord = match serde_json::from_str(&ticket_raw) {
        Ok(t) => t,
        Err(_) => {
            return no_store_json(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": INVALID_RECEIVE_MSG }),
            );
        }
    };

    let now = now_sec();
    let supplied_hash = sha256_hex(token.as_bytes());
    if now > ticket.expires_at || !constant_time_equal(&supplied_hash, &ticket.token_sha256) {
        return no_store_json(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": INVALID_RECEIVE_MSG }),
        );
    }

    let raw_val: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            return no_store_json(
                StatusCode::BAD_REQUEST,
                &json!({ "error": format!("Invalid bundle JSON: {e}") }),
            );
        }
    };
    if raw_val.get("nodes").and_then(|v| v.as_array()).is_none() {
        return no_store_json(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "Invalid bundle JSON: missing nodes array" }),
        );
    }
    let payload: ImportBundlePayload = match serde_json::from_value(raw_val) {
        Ok(p) => p,
        Err(e) => {
            return no_store_json(
                StatusCode::BAD_REQUEST,
                &json!({ "error": format!("Invalid bundle payload: {e}") }),
            );
        }
    };

    match hub.db.import_bundle(&payload, now) {
        Ok(res) => {
            hub.sync_ctrl_to_all_agents(false).await;
            no_store_json(
                StatusCode::OK,
                &json!({
                    "ok": true,
                    "mode": "self-hosted-hub",
                    "imported": res.imported,
                }),
            )
        }
        Err(e) => no_store_json(StatusCode::BAD_REQUEST, &json!({ "error": e })),
    }
}

async fn hub_migrate_smart_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let req: HubMigrateSmartRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("Invalid JSON body: {e}")),
    };

    let trimmed_input = req.target_input.trim();
    if trimmed_input.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "请输入目标面板的迁移口令 (uobm1_...) 或新面板域名",
        );
    }

    let now = now_sec();
    let (raw_target_url, receive_token) =
        if let Some(encoded) = trimmed_input.strip_prefix("uobm1_") {
            let cleaned = encoded.trim().trim_end_matches('=');
            let Ok(decoded_bytes) = URL_SAFE_NO_PAD.decode(cleaned) else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "迁移口令格式无效，请检查是否复制完整",
                );
            };
            let Ok(parsed) = serde_json::from_slice::<MigrationCodePayload>(&decoded_bytes) else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "迁移口令内容无效，请在新面板重新生成",
                );
            };
            if parsed.u.trim().is_empty()
                || !parsed.k.starts_with("uob_mtk_")
                || parsed.k.len() <= "uob_mtk_".len()
                || parsed.k.len() > 128
            {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "迁移口令已损坏或不完整，请在新面板重新生成",
                );
            }
            (parsed.u, parsed.k)
        } else {
            let paired_raw = match hub.db.get_setting("migration_paired_token") {
                Ok(Some(v)) => v,
                Ok(None) => {
                    return json_error(
                    StatusCode::BAD_REQUEST,
                    "未找到配对迁移口令：请先生成一键安装命令，或粘贴目标面板的 uobm1_ 迁移口令",
                );
                }
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            };
            let Ok(paired) = serde_json::from_str::<MigrationPairedTokenRecord>(&paired_raw) else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "配对迁移口令已失效，请重新生成安装命令或改用目标面板的迁移口令",
                );
            };
            if now > paired.expires_at || !paired.raw_receive_token.starts_with("uob_mtk_") {
                return json_error(
                StatusCode::BAD_REQUEST,
                "一键安装配对迁移口令已过期，请重新生成安装命令或使用目标面板的 uobm1_ 迁移口令",
            );
            }
            (trimmed_input.to_string(), paired.raw_receive_token)
        };

    let effective_allow_insecure = req.allow_insecure_ws && hub.cfg.allow_insecure_ws_for_test;
    let target_ws_url =
        match validate_and_normalize_migrate_url(&raw_target_url, effective_allow_insecure) {
            Ok(u) => u,
            Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
        };
    let target_origin = match ws_url_to_http_origin(&target_ws_url) {
        Ok(o) => o,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
    };

    let source_origin_norm = normalize_http_origin(&request_origin(&headers, &hub));
    if source_origin_norm.as_deref() == Ok(target_origin.as_str()) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "目标面板与当前面板地址相同，不能向自己迁移",
        );
    }

    let bundle = match hub.db.export_bundle(now) {
        Ok(b) => b,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };

    let sync_client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to initialize migration HTTP client: {e}"),
            );
        }
    };

    let receive_url = format!("{target_origin}/releases/migration/receive");
    let resp = match sync_client
        .post(&receive_url)
        .header("Authorization", format!("Bearer {receive_token}"))
        .json(&bundle)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                &format!("无法连接目标面板进行配置同步（现有服务器连接未受影响）: {e}"),
            );
        }
    };

    let status = resp.status();
    if status.is_redirection() {
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if location.contains("cloudflareaccess.com") || location.contains("/cdn-cgi/access/") {
            return json_error(
                StatusCode::BAD_REQUEST,
                "目标面板被 Cloudflare Access 拦截，请在 Zero Trust 中为 /releases/migration/*、/api/migration/*、/api/agent/ws 和 /install.sh 添加 Bypass 策略后重试（现有服务器连接未受影响）",
            );
        }
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!(
                "目标面板返回重定向 HTTP {}，无法完成配置同步（现有服务器连接未受影响）",
                status.as_u16()
            ),
        );
    }

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return json_error(
            StatusCode::BAD_REQUEST,
            "目标面板拒绝了迁移口令（可能已过期或失效），请在新面板重新生成迁移口令后重试（现有服务器连接未受影响）",
        );
    }

    if status.is_server_error() {
        return json_error(
            StatusCode::BAD_GATEWAY,
            &format!(
                "目标面板同步接口返回服务端错误 HTTP {}（现有服务器连接未受影响）",
                status.as_u16()
            ),
        );
    }

    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!(
                "目标面板配置同步失败 (HTTP {})：{}（现有服务器连接未受影响）",
                status.as_u16(),
                detail
            ),
        );
    }

    let sync_json: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "目标面板返回了无效的同步响应（现有服务器连接未受影响）",
            );
        }
    };
    if sync_json.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let detail = sync_json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("sync rejected");
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("目标面板未确认配置同步完成: {detail}（现有服务器连接未受影响）"),
        );
    }

    let imported_val = sync_json.get("imported");
    let synced = ImportCounts {
        nodes: imported_val
            .and_then(|m| m.get("nodes"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize,
        channels: imported_val
            .and_then(|m| m.get("channels"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize,
        rules: imported_val
            .and_then(|m| m.get("rules"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize,
        traffic_ledgers: imported_val
            .and_then(|m| m.get("traffic_ledgers"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize,
    };

    let fallback_ws_url = source_origin_norm
        .ok()
        .and_then(|src| validate_and_normalize_migrate_url(&src, effective_allow_insecure).ok())
        .filter(|ws| ws != &target_ws_url);

    let migrate_res = match hub
        .dispatch_migrate(HubMigrateRequest {
            target_url: target_ws_url.clone(),
            fallback_url: fallback_ws_url.clone(),
            node_ids: req.node_ids,
            allow_insecure_ws: req.allow_insecure_ws,
        })
        .await
    {
        Ok(res) => res,
        Err((code, msg)) => {
            return json_error(
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
                &msg,
            );
        }
    };

    Json(json!({
        "ok": true,
        "target_origin": target_origin,
        "target_ws_url": migrate_res.target_ws_url,
        "fallback_ws_url": fallback_ws_url,
        "synced": synced,
        "targeted": migrate_res.targeted,
        "dispatched": migrate_res.dispatched,
        "epoch": migrate_res.epoch,
    }))
    .into_response()
}

// ---- Nodes REST CRUD ----

async fn list_nodes_handler(State(hub): State<HubState>) -> Response {
    let now = now_sec();
    match (
        hub.db.list_nodes_with_summary(now),
        hub.db.count_firing_incidents(),
    ) {
        (Ok(nodes), Ok(active_alerts_count)) => {
            Json(json!({ "nodes": nodes, "activeAlertsCount": active_alerts_count }))
                .into_response()
        }
        (Err(e), _) | (_, Err(e)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn create_node_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(obj) = body.as_object() else {
        return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");
    if name.is_empty() || name.chars().count() > 100 {
        return json_error(StatusCode::BAD_REQUEST, "name is required (1-100 chars)");
    }

    let group_name = obj
        .get("group_name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(64).collect::<String>())
        .unwrap_or_else(|| "Default".to_string());

    let tags: Vec<String> = obj
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(32).collect::<String>())
                .collect()
        })
        .unwrap_or_default();

    let sort_order = obj.get("sort_order").and_then(|v| v.as_i64()).unwrap_or(0);

    let traffic_limit_bytes = match obj.get("traffic_limit_bytes") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let Some(n) = v.as_i64().or_else(|| v.as_f64().map(|f| f.trunc() as i64)) else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "traffic_limit_bytes must be a non-negative number or null",
                );
            };
            if n < 0 {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "traffic_limit_bytes must be a non-negative number or null",
                );
            }
            Some(n)
        }
    };

    let traffic_reset_day = match obj.get("traffic_reset_day") {
        None | Some(Value::Null) => 1,
        Some(v) => {
            let Some(n) = v.as_i64() else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "traffic_reset_day must be an integer between 1 and 31",
                );
            };
            if !(1..=31).contains(&n) {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "traffic_reset_day must be an integer between 1 and 31",
                );
            }
            n
        }
    };

    let traffic_count_mode = match obj.get("traffic_count_mode") {
        None | Some(Value::Null) => "both".to_string(),
        Some(v) => {
            let Some(s) = v.as_str() else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "traffic_count_mode must be both, tx_only, or max",
                );
            };
            if !matches!(s, "both" | "tx_only" | "max") {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "traffic_count_mode must be both, tx_only, or max",
                );
            }
            s.to_string()
        }
    };

    let now = now_sec();
    let id = match generate_id("nd") {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let agent_token = match generate_agent_token() {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let token_sha256 = sha256_hex(agent_token.as_bytes());
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());

    let row = NodeRow {
        id: id.clone(),
        name: name.to_string(),
        group_name,
        tags_json,
        sort_order,
        token_sha256,
        traffic_limit_bytes,
        traffic_reset_day,
        traffic_count_mode,
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
        created_at: now,
        updated_at: now,
    };

    if let Err(e) = hub.db.insert_node(&row) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    let summary = match hub.db.get_node_summary(&id, now) {
        Ok(Some(s)) => s,
        _ => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load created node",
            )
        }
    };
    let origin = request_origin(&headers, &hub);
    let install_cmd = build_install_command(&origin, &id, &agent_token);

    (
        StatusCode::CREATED,
        Json(json!({
            "node": summary,
            "agent_token": agent_token,
            "install_cmd": install_cmd,
        })),
    )
        .into_response()
}

async fn update_node_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(obj) = body.as_object() else {
        return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    let existing = match hub.db.get_node_row(&id) {
        Ok(Some(r)) => r,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Node not found"),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };

    let mut name = existing.name;
    if let Some(v) = obj.get("name") {
        let Some(s) = v.as_str().map(|x| x.trim()) else {
            return json_error(StatusCode::BAD_REQUEST, "name must be 1-100 chars");
        };
        if s.is_empty() || s.chars().count() > 100 {
            return json_error(StatusCode::BAD_REQUEST, "name must be 1-100 chars");
        }
        name = s.to_string();
    }

    let mut group_name = existing.group_name;
    if let Some(v) = obj.get("group_name") {
        if let Some(s) = v.as_str().map(|x| x.trim()) {
            group_name = if s.is_empty() {
                "Default".to_string()
            } else {
                s.chars().take(64).collect()
            };
        }
    }

    let mut tags_json = existing.tags_json;
    if let Some(v) = obj.get("tags") {
        let Some(arr) = v.as_array() else {
            return json_error(StatusCode::BAD_REQUEST, "tags must be an array");
        };
        let cleaned: Vec<String> = arr
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(32).collect())
            .collect();
        tags_json = serde_json::to_string(&cleaned).unwrap_or_else(|_| "[]".to_string());
    }

    let mut sort_order = existing.sort_order;
    if let Some(v) = obj.get("sort_order") {
        if let Some(n) = v.as_i64() {
            sort_order = n;
        }
    }

    let mut traffic_limit_bytes = existing.traffic_limit_bytes;
    if let Some(v) = obj.get("traffic_limit_bytes") {
        if v.is_null() {
            traffic_limit_bytes = None;
        } else if let Some(n) = v.as_i64().or_else(|| v.as_f64().map(|f| f.trunc() as i64)) {
            if n < 0 {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "traffic_limit_bytes must be a non-negative number or null",
                );
            }
            traffic_limit_bytes = Some(n);
        } else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "traffic_limit_bytes must be a non-negative number or null",
            );
        }
    }

    let mut traffic_reset_day = existing.traffic_reset_day;
    if let Some(v) = obj.get("traffic_reset_day") {
        let Some(n) = v.as_i64() else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "traffic_reset_day must be an integer between 1 and 31",
            );
        };
        if !(1..=31).contains(&n) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "traffic_reset_day must be an integer between 1 and 31",
            );
        }
        traffic_reset_day = n;
    }

    let mut traffic_count_mode = existing.traffic_count_mode;
    if let Some(v) = obj.get("traffic_count_mode") {
        let Some(s) = v.as_str() else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "traffic_count_mode must be both, tx_only, or max",
            );
        };
        if !matches!(s, "both" | "tx_only" | "max") {
            return json_error(
                StatusCode::BAD_REQUEST,
                "traffic_count_mode must be both, tx_only, or max",
            );
        }
        traffic_count_mode = s.to_string();
    }

    let mut mute_until = existing.mute_until;
    if let Some(v) = obj.get("mute_until") {
        if v.is_null() {
            mute_until = None;
        } else if let Some(n) = v.as_i64() {
            mute_until = Some(n);
        } else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "mute_until must be a number or null",
            );
        }
    }

    let now = now_sec();
    let res = hub.db.with_conn(|c| {
        c.execute(
            "UPDATE nodes SET
               name = ?1, group_name = ?2, tags_json = ?3, sort_order = ?4,
               traffic_limit_bytes = ?5, traffic_reset_day = ?6, traffic_count_mode = ?7,
               mute_until = ?8, updated_at = ?9
             WHERE id = ?10",
            params![
                name,
                group_name,
                tags_json,
                sort_order,
                traffic_limit_bytes,
                traffic_reset_day,
                traffic_count_mode,
                mute_until,
                now,
                id,
            ],
        )
        .map_err(|e| format!("update_node DB error: {e}"))?;
        Ok(())
    });
    if let Err(e) = res {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    match hub.db.get_node_summary(&id, now) {
        Ok(Some(node)) => Json(json!({ "node": node })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Node not found"),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn delete_node_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let now = now_sec();
    let res = hub.db.with_conn(|c| {
        let exists: Option<String> = c
            .query_row("SELECT id FROM nodes WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| format!("delete_node check error: {e}"))?;
        if exists.is_none() {
            return Ok(None);
        }
        let tx = c
            .transaction()
            .map_err(|e| format!("delete_node tx error: {e}"))?;
        let resolved = tx
            .execute(
                "UPDATE alert_incidents SET status = 'resolved', resolved_at = ?1
                 WHERE node_id = ?2 AND status = 'firing'",
                params![now, id],
            )
            .map_err(|e| format!("resolve incidents error: {e}"))?;
        tx.execute("DELETE FROM alert_rules WHERE node_id = ?1", params![id])
            .map_err(|e| format!("delete rules error: {e}"))?;
        tx.execute("DELETE FROM nodes WHERE id = ?1", params![id])
            .map_err(|e| format!("delete node error: {e}"))?;
        tx.commit()
            .map_err(|e| format!("delete commit error: {e}"))?;
        Ok(Some(resolved))
    });

    match res {
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Node not found"),
        Ok(Some(resolved)) => {
            hub.disconnect_agent(&id, 1000, "Node deleted").await;
            if resolved > 0 {
                hub.broadcast_alert_change().await;
            }
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn rotate_node_token_handler(
    State(hub): State<HubState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match hub.db.get_node_row(&id) {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Node not found"),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }

    let new_token = match generate_agent_token() {
        Ok(t) => t,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let hash = sha256_hex(new_token.as_bytes());
    let now = now_sec();
    if let Err(e) = hub.db.with_conn(|c| {
        c.execute(
            "UPDATE nodes SET token_sha256 = ?1, updated_at = ?2 WHERE id = ?3",
            params![hash, now, id],
        )
        .map_err(|e| format!("rotate_token DB error: {e}"))?;
        Ok(())
    }) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    hub.disconnect_agent(&id, 4001, "Agent token rotated").await;
    let origin = request_origin(&headers, &hub);
    let install_cmd = build_install_command(&origin, &id, &new_token);
    Json(json!({
        "agent_token": new_token,
        "install_cmd": install_cmd,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct MetricsRangeQuery {
    #[serde(default = "default_range")]
    range: String,
}

fn default_range() -> String {
    "1h".to_string()
}

async fn node_metrics_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<MetricsRangeQuery>,
) -> Response {
    if !matches!(q.range.as_str(), "1h" | "24h" | "7d" | "30d" | "1y") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Invalid range (expected 1h|24h|7d|30d|1y)",
        );
    }
    match hub.db.get_node_row(&id) {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Node not found"),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }

    match hub.db.query_metrics(&id, &q.range, now_sec()) {
        Ok(res) => Json(res).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

// ---- Notification Channels & Rules & Incidents ----

fn format_channel_view(r: NotificationChannelRow) -> NotificationChannelView {
    let config: Value = serde_json::from_str(&r.config_json).unwrap_or_else(|_| json!({}));
    NotificationChannelView {
        id: r.id,
        name: r.name,
        channel_type: r.channel_type,
        enabled: r.enabled != 0,
        config,
        created_at: r.created_at,
    }
}

fn format_rule_view(r: AlertRuleRow) -> AlertRuleView {
    let channel_ids: Vec<String> = serde_json::from_str(&r.channel_ids_json).unwrap_or_default();
    AlertRuleView {
        id: r.id,
        name: r.name,
        node_id: r.node_id,
        metric: r.metric,
        operator: r.operator,
        threshold: r.threshold,
        duration_sec: r.duration_sec,
        cooldown_sec: r.cooldown_sec,
        channel_ids,
        enabled: r.enabled != 0,
        created_at: r.created_at,
    }
}

fn validate_channel_config(channel_type: &str, cfg: &Value) -> Result<Value, String> {
    let Some(obj) = cfg.as_object() else {
        return Err("config must be an object".to_string());
    };
    if channel_type == "telegram" {
        let bot_token = obj
            .get("bot_token")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let chat_id = obj
            .get("chat_id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        if bot_token.is_empty() || chat_id.is_empty() {
            return Err("Telegram channel requires bot_token and chat_id".to_string());
        }
        let thread_id = match obj.get("thread_id") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                v.as_i64()
                    .ok_or_else(|| "thread_id must be an integer or null".to_string())?,
            ),
        };
        let mut out = json!({ "bot_token": bot_token, "chat_id": chat_id });
        if let Some(tid) = thread_id {
            out["thread_id"] = json!(tid);
        }
        return Ok(out);
    }
    if channel_type == "webhook" {
        let raw_url = obj
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let parsed =
            url::Url::parse(raw_url).map_err(|_| "Webhook url must be a valid URL".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("Webhook url must use http or https".to_string());
        }
        let secret = obj
            .get("secret")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        let mut out = json!({ "url": raw_url });
        if let Some(sec) = secret {
            out["secret"] = json!(sec);
        }
        return Ok(out);
    }
    Err("Unsupported channel type (expected telegram or webhook)".to_string())
}

async fn list_channels_handler(State(hub): State<HubState>) -> Response {
    match hub.db.list_channels() {
        Ok(rows) => {
            let channels: Vec<NotificationChannelView> =
                rows.into_iter().map(format_channel_view).collect();
            Json(json!({ "channels": channels })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn create_channel_handler(State(hub): State<HubState>, Json(body): Json<Value>) -> Response {
    let Some(obj) = body.as_object() else {
        return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");
    if name.is_empty() || name.chars().count() > 64 {
        return json_error(StatusCode::BAD_REQUEST, "name is required (1-64 chars)");
    }
    let ch_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");
    let Some(raw_cfg) = obj.get("config") else {
        return json_error(StatusCode::BAD_REQUEST, "config object is required");
    };
    let normalized_cfg = match validate_channel_config(ch_type, raw_cfg) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
    };
    let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let id = match generate_id("ch") {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let now = now_sec();
    let cfg_json = serde_json::to_string(&normalized_cfg).unwrap_or_else(|_| "{}".to_string());
    let row = NotificationChannelRow {
        id: id.clone(),
        name: name.to_string(),
        channel_type: ch_type.to_string(),
        enabled: if enabled { 1 } else { 0 },
        config_json: cfg_json,
        created_at: now,
    };

    if let Err(e) = hub.db.with_conn(|c| {
        c.execute(
            "INSERT INTO notification_channels (id, name, type, enabled, config_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                row.id,
                row.name,
                row.channel_type,
                row.enabled,
                row.config_json,
                row.created_at
            ],
        )
        .map_err(|e| format!("create_channel DB error: {e}"))?;
        Ok(())
    }) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    (
        StatusCode::CREATED,
        Json(json!({ "channel": format_channel_view(row) })),
    )
        .into_response()
}

async fn update_channel_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(obj) = body.as_object() else {
        return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    let existing = match hub.db.with_conn(|c| {
        c.query_row(
            "SELECT id, name, type, enabled, config_json, created_at FROM notification_channels WHERE id = ?1",
            params![id],
            |r| {
                Ok(NotificationChannelRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    channel_type: r.get(2)?,
                    enabled: r.get(3)?,
                    config_json: r.get(4)?,
                    created_at: r.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("fetch channel error: {e}"))
    }) {
        Ok(Some(r)) => r,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Channel not found"),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };

    let mut name = existing.name;
    if let Some(v) = obj.get("name") {
        let Some(s) = v.as_str().map(|x| x.trim()) else {
            return json_error(StatusCode::BAD_REQUEST, "name must be 1-64 chars");
        };
        if s.is_empty() || s.chars().count() > 64 {
            return json_error(StatusCode::BAD_REQUEST, "name must be 1-64 chars");
        }
        name = s.to_string();
    }

    let mut ch_type = existing.channel_type;
    if let Some(v) = obj.get("type").and_then(|x| x.as_str()) {
        ch_type = v.trim().to_string();
    }

    let mut enabled = existing.enabled;
    if let Some(v) = obj.get("enabled").and_then(|x| x.as_bool()) {
        enabled = if v { 1 } else { 0 };
    }

    let mut config_json = existing.config_json;
    if let Some(v) = obj.get("config") {
        match validate_channel_config(&ch_type, v) {
            Ok(norm) => config_json = serde_json::to_string(&norm).unwrap_or_else(|_| "{}".into()),
            Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
        }
    }

    if let Err(e) = hub.db.with_conn(|c| {
        c.execute(
            "UPDATE notification_channels SET name = ?1, type = ?2, enabled = ?3, config_json = ?4 WHERE id = ?5",
            params![name, ch_type, enabled, config_json, id],
        )
        .map_err(|e| format!("update_channel DB error: {e}"))?;
        Ok(())
    }) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    let updated = NotificationChannelRow {
        id,
        name,
        channel_type: ch_type,
        enabled,
        config_json,
        created_at: existing.created_at,
    };
    Json(json!({ "channel": format_channel_view(updated) })).into_response()
}

async fn delete_channel_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match hub.db.with_conn(|c| {
        c.execute(
            "DELETE FROM notification_channels WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("delete_channel DB error: {e}"))
    }) {
        Ok(0) => json_error(StatusCode::NOT_FOUND, "Channel not found"),
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn test_channel_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let ch = match hub.db.with_conn(|c| {
        c.query_row(
            "SELECT id, name, type, enabled, config_json, created_at FROM notification_channels WHERE id = ?1",
            params![id],
            |r| {
                Ok(NotificationChannelRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    channel_type: r.get(2)?,
                    enabled: r.get(3)?,
                    config_json: r.get(4)?,
                    created_at: r.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("test_channel DB error: {e}"))
    }) {
        Ok(Some(c)) => c,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Channel not found"),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };

    let payload = AlertNotificationPayload {
        kind: "firing",
        node_id: "test-node".to_string(),
        node_name: "Test Node".to_string(),
        group_name: "Test".to_string(),
        rule_id: "test-rule".to_string(),
        rule_name: "Channel Verification Test".to_string(),
        metric: "cpu".to_string(),
        operator: "gt".to_string(),
        value_text: "99.0%".to_string(),
        value_detail: None,
        threshold_text: "90.0%".to_string(),
        duration_sec: 60,
        trigger_value: Some(99.0),
        threshold: 90.0,
        timestamp_sec: now_sec(),
    };
    match send_channel_notification(&hub.http, &ch, &payload).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

async fn list_rules_handler(State(hub): State<HubState>) -> Response {
    match hub.db.list_rules() {
        Ok(rows) => {
            let rules: Vec<AlertRuleView> = rows.into_iter().map(format_rule_view).collect();
            Json(json!({ "rules": rules })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn apply_rule_presets_handler(
    State(hub): State<HubState>,
    body: Option<Json<Value>>,
) -> Response {
    let mut channel_ids: Vec<String> = body
        .as_ref()
        .and_then(|Json(v)| v.get("channel_ids"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if channel_ids.is_empty() {
        if let Ok(chans) = hub.db.list_channels() {
            channel_ids = chans
                .into_iter()
                .filter(|c| c.enabled != 0)
                .map(|c| c.id)
                .collect();
        }
    }

    let channel_json = serde_json::to_string(&channel_ids).unwrap_or_else(|_| "[]".to_string());
    let now = now_sec();

    let presets = [
        ("节点离线告警", "offline", "gt", 90.0, 0i64, 1800i64),
        ("CPU 使用率过高", "cpu", "gt", 90.0, 120i64, 3600i64),
        ("CPU Steal 抢占过高", "steal", "gt", 20.0, 120i64, 3600i64),
        ("内存使用率过高", "mem", "gt", 90.0, 120i64, 3600i64),
        ("磁盘空间不足", "disk", "gt", 90.0, 60i64, 3600i64),
        ("月流量配额告警", "traffic_pct", "gt", 85.0, 60i64, 86400i64),
    ];

    let existing_global_metrics: HashSet<String> = match hub.db.with_conn(|c| {
        let mut stmt = c
            .prepare("SELECT metric FROM alert_rules WHERE node_id IS NULL")
            .map_err(|e| format!("presets query error: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("presets rows error: {e}"))?;
        let mut set = HashSet::new();
        for r in rows {
            set.insert(r.map_err(|e| format!("preset metric row error: {e}"))?);
        }
        Ok(set)
    }) {
        Ok(s) => s,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };

    if let Err(e) = hub.db.with_conn(|c| {
        let tx = c
            .transaction()
            .map_err(|e| format!("presets tx error: {e}"))?;
        for (name, metric, op, threshold, dur, cd) in presets {
            if existing_global_metrics.contains(metric) {
                continue;
            }
            let id = generate_id("ar")?;
            tx.execute(
                "INSERT INTO alert_rules (
                   id, name, node_id, metric, operator, threshold,
                   duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
                 ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)",
                params![id, name, metric, op, threshold, dur, cd, channel_json, now],
            )
            .map_err(|e| format!("insert preset error: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("presets commit error: {e}"))?;
        Ok(())
    }) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    hub.sync_ctrl_to_all_agents(false).await;
    match hub.db.list_rules() {
        Ok(rows) => {
            let rules: Vec<AlertRuleView> = rows.into_iter().map(format_rule_view).collect();
            (StatusCode::CREATED, Json(json!({ "rules": rules }))).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

fn is_valid_alert_metric(m: &str) -> bool {
    matches!(
        m,
        "offline" | "cpu" | "steal" | "mem" | "swap" | "disk" | "traffic_pct"
    )
}

async fn create_rule_handler(State(hub): State<HubState>, Json(body): Json<Value>) -> Response {
    let Some(obj) = body.as_object() else {
        return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");
    if name.is_empty() || name.chars().count() > 100 {
        return json_error(StatusCode::BAD_REQUEST, "name is required (1-100 chars)");
    }
    let node_id = obj
        .get("node_id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let metric = obj
        .get("metric")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("");
    if !is_valid_alert_metric(metric) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid alert metric");
    }
    let operator = obj
        .get("operator")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("gt");
    if !matches!(operator, "gt" | "gte") {
        return json_error(StatusCode::BAD_REQUEST, "operator must be gt or gte");
    }
    let Some(threshold) = obj.get("threshold").and_then(|v| v.as_f64()) else {
        return json_error(StatusCode::BAD_REQUEST, "threshold must be a finite number");
    };
    if !threshold.is_finite() {
        return json_error(StatusCode::BAD_REQUEST, "threshold must be a finite number");
    }
    let duration_sec = obj
        .get("duration_sec")
        .and_then(|v| v.as_i64())
        .unwrap_or(60)
        .max(0);
    let cooldown_sec = obj
        .get("cooldown_sec")
        .and_then(|v| v.as_i64())
        .unwrap_or(300)
        .max(0);
    let channel_ids: Vec<String> = obj
        .get("channel_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

    let id = match generate_id("ar") {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let now = now_sec();
    let row = AlertRuleRow {
        id: id.clone(),
        name: name.to_string(),
        node_id,
        metric: metric.to_string(),
        operator: operator.to_string(),
        threshold,
        duration_sec,
        cooldown_sec,
        channel_ids_json: serde_json::to_string(&channel_ids).unwrap_or_else(|_| "[]".into()),
        enabled: if enabled { 1 } else { 0 },
        created_at: now,
    };

    if let Err(e) = hub.db.with_conn(|c| {
        c.execute(
            "INSERT INTO alert_rules (
               id, name, node_id, metric, operator, threshold,
               duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                row.id,
                row.name,
                row.node_id,
                row.metric,
                row.operator,
                row.threshold,
                row.duration_sec,
                row.cooldown_sec,
                row.channel_ids_json,
                row.enabled,
                row.created_at,
            ],
        )
        .map_err(|e| format!("create_rule DB error: {e}"))?;
        Ok(())
    }) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    hub.sync_ctrl_to_all_agents(false).await;
    (
        StatusCode::CREATED,
        Json(json!({ "rule": format_rule_view(row) })),
    )
        .into_response()
}

async fn update_rule_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(obj) = body.as_object() else {
        return json_error(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    let existing = match hub.db.with_conn(|c| {
        c.query_row(
            "SELECT id, name, node_id, metric, operator, threshold,
                    duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
             FROM alert_rules WHERE id = ?1",
            params![id],
            |r| {
                Ok(AlertRuleRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    node_id: r.get(2)?,
                    metric: r.get(3)?,
                    operator: r.get(4)?,
                    threshold: r.get(5)?,
                    duration_sec: r.get(6)?,
                    cooldown_sec: r.get(7)?,
                    channel_ids_json: r.get(8)?,
                    enabled: r.get(9)?,
                    created_at: r.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("fetch rule error: {e}"))
    }) {
        Ok(Some(r)) => r,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Rule not found"),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };

    let mut name = existing.name;
    if let Some(v) = obj.get("name").and_then(|x| x.as_str()) {
        let s = v.trim();
        if s.is_empty() || s.chars().count() > 100 {
            return json_error(StatusCode::BAD_REQUEST, "name must be 1-100 chars");
        }
        name = s.to_string();
    }

    let mut node_id = existing.node_id;
    if let Some(v) = obj.get("node_id") {
        node_id = v
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }

    let mut metric = existing.metric;
    if let Some(v) = obj.get("metric").and_then(|x| x.as_str()) {
        let s = v.trim();
        if !is_valid_alert_metric(s) {
            return json_error(StatusCode::BAD_REQUEST, "Invalid alert metric");
        }
        metric = s.to_string();
    }

    let mut operator = existing.operator;
    if let Some(v) = obj.get("operator").and_then(|x| x.as_str()) {
        let s = v.trim();
        if !matches!(s, "gt" | "gte") {
            return json_error(StatusCode::BAD_REQUEST, "operator must be gt or gte");
        }
        operator = s.to_string();
    }

    let mut threshold = existing.threshold;
    if let Some(v) = obj.get("threshold") {
        let Some(t) = v.as_f64() else {
            return json_error(StatusCode::BAD_REQUEST, "threshold must be finite");
        };
        if !t.is_finite() {
            return json_error(StatusCode::BAD_REQUEST, "threshold must be finite");
        }
        threshold = t;
    }

    let mut duration_sec = existing.duration_sec;
    if let Some(v) = obj.get("duration_sec").and_then(|x| x.as_i64()) {
        duration_sec = v.max(0);
    }

    let mut cooldown_sec = existing.cooldown_sec;
    if let Some(v) = obj.get("cooldown_sec").and_then(|x| x.as_i64()) {
        cooldown_sec = v.max(0);
    }

    let mut channel_ids_json = existing.channel_ids_json;
    if let Some(v) = obj.get("channel_ids").and_then(|x| x.as_array()) {
        let ids: Vec<String> = v
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        channel_ids_json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into());
    }

    let mut enabled = existing.enabled;
    if let Some(v) = obj.get("enabled").and_then(|x| x.as_bool()) {
        enabled = if v { 1 } else { 0 };
    }

    if let Err(e) = hub.db.with_conn(|c| {
        c.execute(
            "UPDATE alert_rules SET
               name = ?1, node_id = ?2, metric = ?3, operator = ?4, threshold = ?5,
               duration_sec = ?6, cooldown_sec = ?7, channel_ids_json = ?8, enabled = ?9
             WHERE id = ?10",
            params![
                name,
                node_id,
                metric,
                operator,
                threshold,
                duration_sec,
                cooldown_sec,
                channel_ids_json,
                enabled,
                id,
            ],
        )
        .map_err(|e| format!("update_rule DB error: {e}"))?;
        Ok(())
    }) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }

    hub.sync_ctrl_to_all_agents(false).await;
    let updated = AlertRuleRow {
        id,
        name,
        node_id,
        metric,
        operator,
        threshold,
        duration_sec,
        cooldown_sec,
        channel_ids_json,
        enabled,
        created_at: existing.created_at,
    };
    Json(json!({ "rule": format_rule_view(updated) })).into_response()
}

async fn delete_rule_handler(
    State(hub): State<HubState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let now = now_sec();
    let res = hub.db.with_conn(|c| {
        let changes = c
            .execute("DELETE FROM alert_rules WHERE id = ?1", params![id])
            .map_err(|e| format!("delete_rule DB error: {e}"))?;
        Ok(changes)
    });
    match res {
        Ok(0) => json_error(StatusCode::NOT_FOUND, "Rule not found"),
        Ok(_) => {
            let _ = hub.db.resolve_incidents_for_deleted_rule(&id, now);
            hub.sync_ctrl_to_all_agents(false).await;
            hub.broadcast_alert_change().await;
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

#[derive(Deserialize)]
struct IncidentsQuery {
    #[serde(default = "default_status_filter")]
    status: String,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}

fn default_status_filter() -> String {
    "all".to_string()
}

fn default_limit() -> i64 {
    50
}

async fn list_incidents_handler(
    State(hub): State<HubState>,
    Query(q): Query<IncidentsQuery>,
) -> Response {
    if !matches!(q.status.as_str(), "all" | "firing" | "resolved") {
        return json_error(StatusCode::BAD_REQUEST, "Invalid status filter");
    }
    let limit = q.limit.clamp(1, 200);
    let offset = q.offset.max(0);

    let res = hub.db.with_conn(|c| {
        let (total, incidents) = if q.status == "all" {
            let total: i64 = c
                .query_row("SELECT COUNT(*) FROM alert_incidents", [], |r| r.get(0))
                .map_err(|e| format!("count incidents error: {e}"))?;
            let mut stmt = c
                .prepare(
                    "SELECT id, node_id, node_name, rule_id, metric, status,
                            trigger_value, threshold, message, started_at, resolved_at, last_notified_at
                     FROM alert_incidents ORDER BY started_at DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(|e| format!("prepare incidents error: {e}"))?;
            let list = stmt
                .query_map(params![limit, offset], map_incident_row)
                .map_err(|e| format!("query incidents error: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("row incidents error: {e}"))?;
            (total, list)
        } else {
            let total: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM alert_incidents WHERE status = ?1",
                    params![q.status],
                    |r| r.get(0),
                )
                .map_err(|e| format!("count filtered incidents error: {e}"))?;
            let mut stmt = c
                .prepare(
                    "SELECT id, node_id, node_name, rule_id, metric, status,
                            trigger_value, threshold, message, started_at, resolved_at, last_notified_at
                     FROM alert_incidents WHERE status = ?1 ORDER BY started_at DESC LIMIT ?2 OFFSET ?3",
                )
                .map_err(|e| format!("prepare filtered incidents error: {e}"))?;
            let list = stmt
                .query_map(params![q.status, limit, offset], map_incident_row)
                .map_err(|e| format!("query filtered incidents error: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("row filtered incidents error: {e}"))?;
            (total, list)
        };
        Ok((total, incidents))
    });

    match res {
        Ok((total, incidents)) => {
            Json(json!({ "incidents": incidents, "total": total })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

fn map_incident_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AlertIncidentRow> {
    Ok(AlertIncidentRow {
        id: r.get(0)?,
        node_id: r.get(1)?,
        node_name: r.get(2)?,
        rule_id: r.get(3)?,
        metric: r.get(4)?,
        status: r.get(5)?,
        trigger_value: r.get(6)?,
        threshold: r.get(7)?,
        message: r.get(8)?,
        started_at: r.get(9)?,
        resolved_at: r.get(10)?,
        last_notified_at: r.get(11)?,
    })
}
