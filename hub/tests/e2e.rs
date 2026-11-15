use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use uniob_hub::config::HubConfig;
use uniob_hub::crypto::{hmac_sha256_hex, now_sec, sha256_hex};
use uniob_hub::db::HubDb;
use uniob_hub::hub_state::HubState;
use uniob_hub::protocol::metrics_frame_to_tuple;
use uniob_hub::protocol::{AgentMetricsFrame, CpuMetrics, MemMetrics, NetMetrics};
use uniob_hub::routes::build_router;

async fn spawn_test_hub(
    mut cfg: HubConfig,
    cf_certs_url: Option<String>,
) -> (SocketAddr, HubState) {
    cfg.self_probe_enabled = false;
    let db = HubDb::open_in_memory().unwrap();
    let http = reqwest::Client::new();
    let mut hub = HubState::new(cfg, db, http);
    if let Some(url) = cf_certs_url {
        hub = hub.with_cf_certs_url(url);
    }
    let app = build_router(hub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    (addr, hub)
}

#[tokio::test]
async fn full_rest_agent_v2_client_ws_bundle_migrate_and_static_flow() {
    let temp = std::env::temp_dir().join(format!("uniob_hub_e2e_{}", now_sec()));
    let web_dir = temp.join("web");
    let rel_dir = temp.join("releases");
    std::fs::create_dir_all(&web_dir).unwrap();
    std::fs::create_dir_all(&rel_dir).unwrap();
    std::fs::write(
        web_dir.join("index.html"),
        "<html><body>UniOB SPA</body></html>",
    )
    .unwrap();
    std::fs::write(
        rel_dir.join("uniob-agent-x86_64-unknown-linux-musl"),
        b"ELF_FAKE_BIN",
    )
    .unwrap();

    let cfg = HubConfig {
        web_dir: web_dir.clone(),
        releases_dir: rel_dir.clone(),
        github_repo: "acme/uniob".to_string(),
        allow_insecure_ws_for_test: true,
        ..Default::default()
    };

    let (addr, hub) = spawn_test_hub(cfg, None).await;
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    // 1. Auth setup + cookie + unauth protection
    let me0: Value = client
        .get(format!("{base}/api/auth/me"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me0["authenticated"], false);
    assert_eq!(me0["needsSetup"], true);
    assert_eq!(me0["mode"], "builtin");

    assert_eq!(
        client
            .get(format!("{base}/api/nodes"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    let setup_resp = client
        .post(format!("{base}/api/auth/setup"))
        .json(&json!({ "password": "AdminPassword123!" }))
        .send()
        .await
        .unwrap();
    assert_eq!(setup_resp.status(), 200);
    let set_cookie = setup_resp
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    // 2. Public scripts, release asset (and traversal blocked), SPA fallback, and JSON 404 for unknown API
    let install_sh = client
        .get(format!("{base}/install.sh"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(install_sh.contains("acme/uniob"));
    assert!(!install_sh.contains("{{GITHUB_REPO}}"));

    let install_hub = client
        .get(format!("{base}/install-hub.sh"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(install_hub.contains("acme/uniob"));

    let rel = client
        .get(format!(
            "{base}/releases/uniob-agent-x86_64-unknown-linux-musl"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(rel.status(), 200);
    assert_eq!(rel.bytes().await.unwrap().as_ref(), b"ELF_FAKE_BIN");

    // Path traversal blocked
    let trav = client
        .get(format!("{base}/releases/..%2Fweb%2Findex.html"))
        .send()
        .await
        .unwrap();
    assert_eq!(trav.status(), 404);

    // SPA fallback serves index.html; unknown /api/* returns JSON 404
    let spa = client
        .get(format!("{base}/nodes/manage"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(spa.contains("UniOB SPA"));

    let api_404 = client
        .get(format!("{base}/api/does-not-exist"))
        .send()
        .await
        .unwrap();
    assert_eq!(api_404.status(), 404);

    // 3. Create node + apply preset rules (populates watermarks!)
    let create_node: Value = client
        .post(format!("{base}/api/nodes"))
        .header("Cookie", &set_cookie)
        .json(&json!({
            "name": "HK-Edge-01",
            "group_name": "Asia",
            "tags": ["kvm", "hk"],
            "traffic_limit_bytes": 1000000000
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let node_id = create_node["node"]["id"].as_str().unwrap().to_string();
    let agent_token = create_node["agent_token"].as_str().unwrap().to_string();
    assert!(create_node["install_cmd"]
        .as_str()
        .unwrap()
        .contains(&node_id));

    let presets_resp = client
        .post(format!("{base}/api/alerts/rules/presets"))
        .header("Cookie", &set_cookie)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(presets_resp.status(), 201);

    // 4. Connect Agent v2 WebSocket -> verify hello, initial ctrl + watermarks, and mb ingestion
    let mut agent_req = format!("ws://{addr}/api/agent/ws")
        .into_client_request()
        .unwrap();
    agent_req
        .headers_mut()
        .insert("X-UniOB-Node-Id", HeaderValue::from_str(&node_id).unwrap());
    agent_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {agent_token}")).unwrap(),
    );
    let (mut agent_ws, _) = tokio_tungstenite::connect_async(agent_req).await.unwrap();

    let hello = json!({
        "t": "hello",
        "v": 2,
        "agent_ver": "0.2.0",
        "hostname": "hk01",
        "os": "Linux",
        "kernel": "6.8.0",
        "arch": "x86_64",
        "cpu_model": "EPYC",
        "cpu_cores": 2,
        "mem_total": 4_000_000_000u64,
        "swap_total": 1_000_000_000u64,
        "boot_time": 1_700_000_000u64,
        "proc_enabled": true,
        "capabilities": ["mb_v2", "migrate_v1"]
    });
    agent_ws
        .send(WsMsg::Text(hello.to_string().into()))
        .await
        .unwrap();

    let ctrl1_txt = match timeout(Duration::from_secs(3), agent_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected frame: {other:?}"),
    };
    let ctrl1: Value = serde_json::from_str(&ctrl1_txt).unwrap();
    assert_eq!(ctrl1["t"], "ctrl");
    assert_eq!(ctrl1["mode"], 0);
    assert_eq!(ctrl1["batch_sec"], 300);
    assert_eq!(ctrl1["watermarks"]["cpu"], 90.0);

    let ts = now_sec() as u64;
    let last_frame = AgentMetricsFrame {
        network_quality: None,
        ts,
        up: 1200,
        cpu: CpuMetrics {
            all: 18.5,
            cores: vec![15.0, 22.0],
            steal: 0.2,
            iowait: 0.1,
            load: vec![0.42, 0.35, 0.30],
        },
        mem: MemMetrics {
            used: 1_000_000_000,
            avail: 3_000_000_000,
            cached: 400_000_000,
            swap_used: 0,
        },
        disks: vec![],
        net: NetMetrics {
            rx_bps: 12000,
            tx_bps: 24000,
            rx_tot: 500_000,
            tx_tot: 800_000,
            tcp_est: 12,
            tcp_tw: 1,
            udp: 3,
        },
        procs: None,
        upd: None,
    };
    let t1 = metrics_frame_to_tuple(&last_frame);
    let mb = json!({
        "t": "mb",
        "v": 2,
        "reason": "hello",
        "pts": [t1],
        "last": last_frame,
    });
    agent_ws
        .send(WsMsg::Text(mb.to_string().into()))
        .await
        .unwrap();

    // Poll until metrics persisted & /api/nodes shows online + metrics
    tokio::time::sleep(Duration::from_millis(80)).await;
    let hist: Value = client
        .get(format!("{base}/api/nodes/{node_id}/metrics?range=1h"))
        .header("Cookie", &set_cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hist["resolution"], "30s");
    assert!(!hist["points"].as_array().unwrap().is_empty());

    // 5. Connect Client WS with cookie -> sub_fleet -> receive fleet_batch & Agent mode transition 0 -> 1
    let mut client_req = format!("ws://{addr}/api/client/ws")
        .into_client_request()
        .unwrap();
    client_req
        .headers_mut()
        .insert("Cookie", HeaderValue::from_str(&set_cookie).unwrap());
    let (mut client_ws, _) = tokio_tungstenite::connect_async(client_req).await.unwrap();

    client_ws
        .send(WsMsg::Text(json!({ "op": "sub_fleet" }).to_string().into()))
        .await
        .unwrap();
    let batch_txt = match timeout(Duration::from_secs(3), client_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected client frame: {other:?}"),
    };
    let batch: Value = serde_json::from_str(&batch_txt).unwrap();
    assert_eq!(batch["t"], "fleet_batch");
    assert_eq!(batch["ticks"][0]["nodeId"], node_id);
    assert_eq!(batch["ticks"][0]["online"], true);

    // Agent receives ctrl mode=1 flush_now=true
    let ctrl2_txt = match timeout(Duration::from_secs(3), agent_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected ctrl2: {other:?}"),
    };
    let ctrl2: Value = serde_json::from_str(&ctrl2_txt).unwrap();
    assert_eq!(ctrl2["mode"], 1);
    assert_eq!(ctrl2["flush_now"], true);

    // 5b. Client renew extends lease silently, then ping receives pong immediately (no spurious fleet_batch)
    client_ws
        .send(WsMsg::Text(json!({ "op": "renew" }).to_string().into()))
        .await
        .unwrap();
    client_ws
        .send(WsMsg::Text(json!({ "op": "ping" }).to_string().into()))
        .await
        .unwrap();
    let pong_txt = match timeout(Duration::from_secs(3), client_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected client pong frame: {other:?}"),
    };
    let pong: Value = serde_json::from_str(&pong_txt).unwrap();
    assert_eq!(pong["t"], "pong");

    // 6. Canary Hot-Migration API SSRF rejection + valid signed dispatch over Agent WS
    let bad_mig = client
        .post(format!("{base}/api/hub/migrate"))
        .header("Cookie", &set_cookie)
        .json(&json!({ "target_url": "ws://127.0.0.1:9999" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_mig.status(), 400);

    let ok_mig: Value = client
        .post(format!("{base}/api/hub/migrate"))
        .header("Cookie", &set_cookie)
        .json(&json!({
            "target_url": "http://127.0.0.1:9999",
            "allow_insecure_ws": true
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ok_mig["ok"], true);
    assert_eq!(ok_mig["dispatched"], 1);
    assert_eq!(ok_mig["target_ws_url"], "ws://127.0.0.1:9999/api/agent/ws");

    let mig_ctrl_txt = match timeout(Duration::from_secs(3), agent_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected migrate ctrl: {other:?}"),
    };
    let mig_ctrl: Value = serde_json::from_str(&mig_ctrl_txt).unwrap();
    let epoch = mig_ctrl["migrate"]["epoch"].as_i64().unwrap();
    let sig = mig_ctrl["migrate"]["sig"].as_str().unwrap();
    let expected_sig = hmac_sha256_hex(
        sha256_hex(agent_token.as_bytes()).as_bytes(),
        format!("{node_id}:{epoch}:ws://127.0.0.1:9999/api/agent/ws").as_bytes(),
    );
    assert_eq!(sig, expected_sig);

    // 7. Hub status + Export/Import bundle roundtrip
    let status: Value = client
        .get(format!("{base}/api/hub/status"))
        .header("Cookie", &set_cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["mode"], "self-hosted-hub");
    assert_eq!(status["connected_agents"], 1);
    assert_eq!(status["total_nodes"], 1);

    let exported: Value = client
        .get(format!("{base}/api/export/bundle"))
        .header("Cookie", &set_cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(exported["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(exported["traffic_ledgers"].as_array().unwrap().len(), 1);

    let imported: Value = client
        .post(format!("{base}/api/import/bundle"))
        .header("Cookie", &set_cookie)
        .json(&exported)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(imported["ok"], true);
    assert_eq!(imported["imported"]["nodes"], 1);

    // Explicitly avoid unused variable warning & ensure clean cleanup
    let _ = hub;
    let _ = std::fs::remove_dir_all(&temp);
}

#[tokio::test]
async fn cf_access_rs256_jwks_verifies_and_enforces_email_allowlist() {
    let jwks_doc = json!({
        "keys": [{
            "kty": "RSA",
            "n": "nJk6aheVicFG37zgVUjVkIoFnQPXEDiaNgh2uDm7i0ntnmCMqBtsPGCigoNugazDDual0fLgu49aXeS1F7CuIl-c9Gact0X77oH5EVV0XUhlU1Zif0RJ_rZ9NfmYR-natrjbzC8DwA2Pb6fzkMZVL7JMX49F2OAZFzLLaOwk5q0zHhgjIdWIP1dWluMJBVZ3xiNCxIQmRMwoEMcCzcIkzs85ftunRySskZCGpxf5lUT1QRRMTbJdx_7O4u-ktbbwKbpbQJqr3zSn6tKbU7ZeFTaB98jQljOcZLx3Y8do1WeP70xRGbymNd19e6-r-HUbiAtKWljR6-wVhnhmR2xv6Q",
            "e": "AQAB",
            "kid": "test-key-1",
            "use": "sig",
            "alg": "RS256"
        }]
    });

    let alice_jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LTEiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3Rlc3QuY2xvdWRmbGFyZWFjY2Vzcy5jb20iLCJhdWQiOlsiYXVkLTEyMzQ1Il0sInN1YiI6InVzZXItMSIsImVtYWlsIjoiQWxpY2VARXhhbXBsZS5jb20iLCJpYXQiOjE3MDAwMDAwMDAsIm5iZiI6MTcwMDAwMDAwMCwiZXhwIjo0MDAwMDAwMDAwfQ.krmcq7KchtifLl-Cz_1ay5LCLv4HZELi2tCnoFAd-MRKyDuP1Oz8ommO5in-VhJM1qYWp0KCpQg5PXSrwjcnqYjyOg_CCYrxOQv1XjlMF0O6u0Gpwvc4lZEZ99uNaAYaAL_PPw0VnDQFV1csDFgucybfdmXqrYNdo3-LJi8_DpkuiCWUnDPOqQYMzIPaEAqNgYuFdcb6uPwMsf2Y8ZnnvUDYmrS38V9a0jN9DTPe-JbuyuqGGbawlkHEfJJKyLf41pUfDrIHdkqWeGaXyDbhVi6IH1QmNBFWc8pThlW-f_vppMWk8TcV0Eetih40ylDNgcY8Wg7kRQut5_yNdTHsHw";
    let bob_jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LTEiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3Rlc3QuY2xvdWRmbGFyZWFjY2Vzcy5jb20iLCJhdWQiOlsiYXVkLTEyMzQ1Il0sInN1YiI6InVzZXItMSIsImVtYWlsIjoiYm9iQGV2aWwuY29tIiwiaWF0IjoxNzAwMDAwMDAwLCJuYmYiOjE3MDAwMDAwMDAsImV4cCI6NDAwMDAwMDAwMH0.PP4UCVU1ft7CrrHvlVVnIDuItMBAs6LUbYqpG3IZsJK28MG_uILSSAbMhRoY3bYaYPqOOBC4qET-jsMdEOI8TwzWuoJp4yFuwukgyGYutnyQATUnBWNkN91rJ80dAhGOTDSSzK6AtKZ7pp1xkM7namPhy3uaFTstNUFb535izGhN3G3qipMtj1WNplGrh0A7Csc-x3rV9d4_mngrTCltEmvRM8g6KDIjXQEzYvrIfiJ7b4cbKXoWeyERIsB1UhX2qHHXKZ9PGBfVYaIHFmNLeXm7mijER3bihUWy_3kzd8OXwTkCNyv0akiRJcLt_DVWgCvfhFxvUH56L65I3TVSWg";

    let certs_app = axum::Router::new().route(
        "/cdn-cgi/access/certs",
        axum::routing::get({
            let doc = jwks_doc.clone();
            move || async move { axum::Json(doc) }
        }),
    );
    let certs_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let certs_addr = certs_listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(certs_listener, certs_app).await;
    });

    let cfg = HubConfig {
        auth_mode_explicit: Some("cf_access".to_string()),
        cf_access_team_domain: "test.cloudflareaccess.com".to_string(),
        cf_access_aud: "aud-12345".to_string(),
        cf_access_allowed_emails: vec!["alice@example.com".to_string()],
        ..Default::default()
    };

    let (hub_addr, _) = spawn_test_hub(
        cfg,
        Some(format!("http://{certs_addr}/cdn-cgi/access/certs")),
    )
    .await;
    let base = format!("http://{hub_addr}");
    let client = reqwest::Client::new();

    // Missing header -> 401
    assert_eq!(
        client
            .get(format!("{base}/api/nodes"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    // Valid RS256 signature + unauthorized email -> 403
    assert_eq!(
        client
            .get(format!("{base}/api/nodes"))
            .header("Cf-Access-Jwt-Assertion", bob_jwt)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );

    // Valid RS256 signature + case-insensitive allowlist match -> 200
    let ok = client
        .get(format!("{base}/api/nodes"))
        .header("Cf-Access-Jwt-Assertion", alice_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
}

async fn login_cookie(client: &reqwest::Client, base: &str, password: &str) -> String {
    let setup_resp = client
        .post(format!("{base}/api/auth/setup"))
        .json(&json!({ "password": password }))
        .send()
        .await
        .unwrap();
    assert_eq!(setup_resp.status(), 200);
    setup_resp
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn network_quality_config_wire_history_and_bundle_lifecycle() {
    let (addr, hub) = spawn_test_hub(HubConfig::default(), None).await;
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();
    let cookie = login_cookie(&client, &base, "NetworkQualityTest123!").await;
    let config_url = format!("{base}/api/network-quality/config");
    assert_eq!(client.get(&config_url).send().await.unwrap().status(), 401);
    let initial: Value = client
        .get(&config_url)
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(initial["config"]["enabled"], false);
    let mut config = initial["config"].clone();
    config["enabled"] = json!(true);
    let enabled: Value = client
        .put(&config_url)
        .header("Cookie", &cookie)
        .json(&config)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let effective = enabled["effective_config"].clone();
    assert_ne!(initial["config_id"], enabled["config_id"]);
    let mut invalid = config.clone();
    invalid["targets"][0]["host"] = json!("127.0.0.1");
    assert_eq!(
        client
            .put(&config_url)
            .header("Cookie", &cookie)
            .json(&invalid)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let created: Value = client
        .post(format!("{base}/api/nodes"))
        .header("Cookie", &cookie)
        .json(&json!({"name":"Quality Test"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["node"]["id"].as_str().unwrap();
    let token = created["agent_token"].as_str().unwrap();
    let node_config_url = format!("{base}/api/nodes/{id}/network-quality/config");
    let quality_url = format!("{base}/api/nodes/{id}/network-quality");
    let before: Value = client
        .get(&node_config_url)
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(before["config"]["mode"], "inherit");
    assert_eq!(before["supported"], false);
    let mut req = format!("ws://{addr}/api/agent/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("X-UniOB-Node-Id", HeaderValue::from_str(id).unwrap());
    req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMsg::Text(
        json!({"t":"hello","v":2,"capabilities":["mb_v2","network_quality_v1"]})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let msg = timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ctrl: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(ctrl["network_quality"], effective);
    let ts = now_sec() as u64;
    let resource = json!({"ts":ts,"up":5,"cpu":{"all":12.,"steal":0.,"iowait":0.},"mem":{"used":1,"avail":2,"cached":0,"swap_used":0},"disks":[],"net":{"rx_bps":0,"tx_bps":0,"rx_tot":0,"tx_tot":0,"tcp_est":0,"tcp_tw":0,"udp":0}});
    let mut malformed = resource.clone();
    malformed["t"] = json!("m");
    malformed["network_quality"] = json!("bad");
    ws.send(WsMsg::Text(malformed.to_string().into()))
        .await
        .unwrap();
    let mut target = effective["targets"][0].clone();
    let revision = target
        .as_object_mut()
        .unwrap()
        .remove("target_revision")
        .unwrap();
    let points: Vec<Value> = (0..15u64).map(|i| json!({"sample_id":format!("session:{i}:ct"),"round_seq":i,"config_id":effective["config_id"],"target_id":"ct","target_revision":revision,"segment_id":"session:ct:1","ts":ts-280+i*20,"result":"ok","connect_ms":i as f64+1.,"remote_ip":"1.1.1.1","target":target})).collect();
    let extension = json!({"schema_version":1,"enabled":true,"applied_config_id":effective["config_id"],"config_error":null,"dropped_samples":0,"latest":[],"points":points});
    let batch = json!({"t":"mb","v":2,"pts":[],"last":resource,"network_quality":extension});
    ws.send(WsMsg::Text(batch.to_string().into()))
        .await
        .unwrap();
    ws.send(WsMsg::Text(batch.to_string().into()))
        .await
        .unwrap();
    for _ in 0..100 {
        if hub
            .db
            .network_state(id)
            .unwrap()
            .latest
            .first()
            .is_some_and(|l| l.measured_at == ts)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let history: Value = client
        .get(format!("{quality_url}?range=1h"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history["series"][0]["points"].as_array().unwrap().len(), 15);
    assert_eq!(history["state"]["latest"][0]["attempts"], 6);
    assert_eq!(history["state"]["latest"][0]["latency_median_ms"], 12.5);
    assert_eq!(
        history["state"]["applied_config_id"],
        effective["config_id"]
    );
    let summary = hub.db.get_node_summary(id, now_sec()).unwrap().unwrap();
    let metrics = summary.metrics.unwrap();
    assert_eq!(metrics.cpu.all, 12.);
    assert_eq!(metrics.network_quality.unwrap().latest[0].attempts, 6);
    // A real reconnect keeps process-scoped sample identities and statistics.
    ws.close(None).await.unwrap();
    let mut req = format!("ws://{addr}/api/agent/ws")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("X-UniOB-Node-Id", HeaderValue::from_str(id).unwrap());
    req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(WsMsg::Text(
        json!({"t":"hello","v":2,"capabilities":["mb_v2","network_quality_v1"]})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let msg = timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let reconnected: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(reconnected["network_quality"], effective);
    let mut retransmission = batch.clone();
    retransmission["last"]["up"] = json!(6);
    ws.send(WsMsg::Text(retransmission.to_string().into()))
        .await
        .unwrap();
    for _ in 0..100 {
        if hub
            .db
            .get_node_summary(id, now_sec())
            .unwrap()
            .and_then(|s| s.metrics)
            .is_some_and(|m| m.up == 6)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let repeated: Value = client
        .get(format!("{quality_url}?range=1h"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(repeated["series"], history["series"]);
    assert_eq!(repeated["state"]["latest"], history["state"]["latest"]);
    assert_eq!(
        client
            .get(format!("{quality_url}?range=1y"))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .get(format!("{base}/api/nodes/missing/network-quality/config"))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let off: Value = client
        .put(&node_config_url)
        .header("Cookie", &cookie)
        .json(&json!({"mode":"off"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(off["effective_config"]["enabled"], false);
    let msg = timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ctrl: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
    assert_eq!(ctrl["network_quality"]["enabled"], false);
    let mut disabled = resource.clone();
    disabled["t"] = json!("m");
    disabled["network_quality"] = json!({"schema_version":1,"enabled":false,"applied_config_id":off["config_id"],"config_error":null,"dropped_samples":0,"latest":[],"points":[]});
    ws.send(WsMsg::Text(disabled.to_string().into()))
        .await
        .unwrap();
    for _ in 0..100 {
        if hub
            .db
            .network_state(id)
            .unwrap()
            .applied_config_id
            .as_deref()
            == off["config_id"].as_str()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!hub.db.network_state(id).unwrap().enabled);
    assert_eq!(hub.db.network_state(id).unwrap().latest[0].measured_at, ts);
    ws.close(None).await.unwrap();
    let mut legacy = connect_and_hello_agent(&format!("ws://{addr}/api/agent/ws"), id, token).await;
    let mut old_resource = resource.clone();
    old_resource["t"] = json!("m");
    old_resource["cpu"]["all"] = json!(21.);
    legacy
        .send(WsMsg::Text(old_resource.to_string().into()))
        .await
        .unwrap();
    for _ in 0..100 {
        if hub
            .db
            .get_node_summary(id, now_sec())
            .unwrap()
            .and_then(|s| s.metrics)
            .is_some_and(|m| m.cpu.all == 21.)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let unsupported = hub.db.network_state(id).unwrap();
    assert!(!unsupported.supported);
    assert!(!unsupported.enabled);
    assert!(unsupported.latest.is_empty());
    assert_eq!(
        hub.db
            .get_node_summary(id, now_sec())
            .unwrap()
            .unwrap()
            .metrics
            .unwrap()
            .cpu
            .all,
        21.
    );
    let retained: Value = client
        .get(format!("{quality_url}?range=1h"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(retained["series"], history["series"]);
    let bundle = hub.db.export_bundle(now_sec()).unwrap();
    assert!(bundle
        .system_settings
        .iter()
        .any(|s| s.key == format!("network_quality_node:{id}")));
    let imported: uniob_hub::protocol::ImportBundlePayload =
        serde_json::from_value(serde_json::to_value(bundle).unwrap()).unwrap();
    let new_db = HubDb::open_in_memory().unwrap();
    new_db.import_bundle(&imported, now_sec()).unwrap();
    assert!(!new_db.network_control(id).unwrap().enabled);
    assert!(new_db.network_state(id).unwrap().latest.is_empty());
    assert_eq!(
        client
            .delete(format!("{base}/api/nodes/{id}"))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert!(hub
        .db
        .get_setting(&format!("network_quality_node:{id}"))
        .unwrap()
        .is_none());
    assert!(hub.db.network_state(id).unwrap().latest.is_empty());
}

async fn connect_and_hello_agent(
    ws_url: &str,
    node_id: &str,
    agent_token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut agent_req = ws_url.into_client_request().unwrap();
    agent_req
        .headers_mut()
        .insert("X-UniOB-Node-Id", HeaderValue::from_str(node_id).unwrap());
    agent_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {agent_token}")).unwrap(),
    );
    let (mut agent_ws, _) = tokio_tungstenite::connect_async(agent_req).await.unwrap();

    let hello = json!({
        "t": "hello",
        "v": 2,
        "agent_ver": "0.2.0",
        "hostname": "hk-mig",
        "os": "Linux",
        "kernel": "6.8.0",
        "arch": "x86_64",
        "cpu_model": "EPYC",
        "cpu_cores": 2,
        "mem_total": 4_000_000_000u64,
        "swap_total": 1_000_000_000u64,
        "boot_time": 1_700_000_000u64,
        "proc_enabled": true,
        "capabilities": ["mb_v2", "migrate_v1"]
    });
    agent_ws
        .send(WsMsg::Text(hello.to_string().into()))
        .await
        .unwrap();

    let ctrl_txt = match timeout(Duration::from_secs(3), agent_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected initial ctrl frame: {other:?}"),
    };
    let ctrl: Value = serde_json::from_str(&ctrl_txt).unwrap();
    assert_eq!(ctrl["t"], "ctrl");
    assert!(ctrl.get("network_quality").is_none());
    agent_ws
}

#[tokio::test]
async fn two_hub_and_install_ticket_smart_migration_flow() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

    let client = reqwest::Client::new();

    // Spawn Hub A (source) with watchdog armed + allow_insecure_ws_for_test
    let cfg_a = HubConfig {
        allow_insecure_ws_for_test: true,
        watchdog_url: "https://wd.example.com/ping?k=1".to_string(),
        watchdog_secret: "wd_sec'quote".to_string(),
        ..Default::default()
    };
    let (addr_a, hub_a) = spawn_test_hub(cfg_a, None).await;
    let base_a = format!("http://{addr_a}");
    let cookie_a = login_cookie(&client, &base_a, "SourcePass123!").await;

    // Spawn Hub B (target for receive code uobm1_...)
    let cfg_b = HubConfig {
        allow_insecure_ws_for_test: true,
        ..Default::default()
    };
    let (addr_b, hub_b) = spawn_test_hub(cfg_b, None).await;
    let base_b = format!("http://{addr_b}");
    let cookie_b = login_cookie(&client, &base_b, "TargetPass123!").await;
    let original_b_pw_hash = hub_b
        .db
        .get_setting("admin_password_hash")
        .unwrap()
        .unwrap();
    let original_b_secret = hub_b.db.get_setting("session_secret").unwrap().unwrap();

    // Protected route auth checks (unauth -> 401)
    assert_eq!(
        client
            .post(format!("{base_a}/api/migration/ticket"))
            .json(&json!({ "purpose": "receive" }))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .post(format!("{base_a}/api/hub/migrate-smart"))
            .json(&json!({ "target_input": "example.com" }))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    // Populate Hub A with node + channel + rule preset + connect live Agent WS
    let created_node: Value = client
        .post(format!("{base_a}/api/nodes"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "name": "HK-Smart-01", "group_name": "Edge", "tags": ["hk"] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let node_id = created_node["node"]["id"].as_str().unwrap().to_string();
    let agent_token = created_node["agent_token"].as_str().unwrap().to_string();

    let ch_resp = client
        .post(format!("{base_a}/api/alerts/channels"))
        .header("Cookie", &cookie_a)
        .json(&json!({
            "type": "webhook",
            "name": "OpsHook",
            "enabled": true,
            "config": { "url": "https://hooks.example.com/uniob" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ch_resp.status(), 201);

    let preset_resp = client
        .post(format!("{base_a}/api/alerts/rules/presets"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "node_id": node_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(preset_resp.status(), 201);

    let mut agent_ws_a = connect_and_hello_agent(
        &format!("ws://{addr_a}/api/agent/ws"),
        &node_id,
        &agent_token,
    )
    .await;

    // Failure path checks: invalid purpose, bad pull/receive tokens (401 + Cache-Control: no-store), unknown /releases POST (404)
    assert_eq!(
        client
            .post(format!("{base_a}/api/migration/ticket"))
            .header("Cookie", &cookie_a)
            .json(&json!({ "purpose": "bogus" }))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );

    for pull_bad_url in [
        format!("{base_a}/releases/migration/pull/bad_prefix"),
        format!("{base_a}/api/migration/pull/uob_mpull_nonexistent"),
    ] {
        let r = client.get(pull_bad_url).send().await.unwrap();
        assert_eq!(r.status(), 401);
        assert_eq!(
            r.headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
    }

    for recv_bad_url in [
        format!("{base_b}/releases/migration/receive"),
        format!("{base_b}/api/migration/receive"),
    ] {
        let r = client
            .post(recv_bad_url)
            .header("Authorization", "Bearer uob_mtk_invalidtoken")
            .json(&json!({ "nodes": [] }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        assert_eq!(
            r.headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
    }

    assert_eq!(
        client
            .post(format!("{base_b}/releases/unknown/action"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );

    // Invalid migrate-smart inputs -> 400
    assert_eq!(
        client
            .post(format!("{base_a}/api/hub/migrate-smart"))
            .header("Cookie", &cookie_a)
            .json(&json!({ "target_input": "uobm1_not_valid_base64" }))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .post(format!("{base_a}/api/hub/migrate-smart"))
            .header("Cookie", &cookie_a)
            .json(&json!({ "target_input": "target.example.com" }))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );

    // Verify public_origin normalization on POST /api/migration/ticket
    let norm_ticket: Value = client
        .post(format!("{base_b}/api/migration/ticket"))
        .header("Cookie", &cookie_b)
        .json(&json!({
            "purpose": "receive",
            "public_origin": "https://Target.Example.COM:8443/extra/path?a=1"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(norm_ticket["origin"], "https://target.example.com:8443");
    let norm_code = norm_ticket["migration_code"].as_str().unwrap();
    let decoded_norm: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(norm_code.strip_prefix("uobm1_").unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(decoded_norm["u"], "https://target.example.com:8443");
    assert!(decoded_norm["k"].as_str().unwrap().starts_with("uob_mtk_"));

    // Reject same-origin smart migration
    let same_origin_ticket: Value = client
        .post(format!("{base_a}/api/migration/ticket"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "purpose": "receive" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        client
            .post(format!("{base_a}/api/hub/migrate-smart"))
            .header("Cookie", &cookie_a)
            .json(&json!({
                "target_input": same_origin_ticket["migration_code"],
                "allow_insecure_ws": true
            }))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );

    // ---- Flow 1: Two-hub smart migration via uobm1_... migration_code (Hub A -> Hub B) ----
    let recv_ticket_b: Value = client
        .post(format!("{base_b}/api/migration/ticket"))
        .header("Cookie", &cookie_b)
        .json(&json!({ "purpose": "receive" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(recv_ticket_b["ok"], true);
    assert_eq!(recv_ticket_b["purpose"], "receive");
    assert_eq!(recv_ticket_b["origin"], base_b);
    let migration_code_b = recv_ticket_b["migration_code"]
        .as_str()
        .unwrap()
        .to_string();

    // Without allow_insecure_ws, http://127.0.0.1 target MUST be rejected (400)
    assert_eq!(
        client
            .post(format!("{base_a}/api/hub/migrate-smart"))
            .header("Cookie", &cookie_a)
            .json(&json!({
                "target_input": migration_code_b,
                "allow_insecure_ws": false
            }))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );

    let smart_res_b: Value = client
        .post(format!("{base_a}/api/hub/migrate-smart"))
        .header("Cookie", &cookie_a)
        .json(&json!({
            "target_input": migration_code_b,
            "allow_insecure_ws": true
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(smart_res_b["ok"], true);
    assert_eq!(smart_res_b["target_origin"], base_b);
    assert_eq!(
        smart_res_b["target_ws_url"],
        format!("ws://{addr_b}/api/agent/ws")
    );
    assert_eq!(
        smart_res_b["fallback_ws_url"],
        format!("ws://{addr_a}/api/agent/ws")
    );
    assert_eq!(smart_res_b["synced"]["nodes"], 1);
    assert_eq!(smart_res_b["synced"]["channels"], 1);
    assert!(smart_res_b["synced"]["rules"].as_u64().unwrap() >= 1);
    assert_eq!(smart_res_b["synced"]["traffic_ledgers"], 0);
    assert_eq!(smart_res_b["targeted"], 1);
    assert_eq!(smart_res_b["dispatched"], 1);
    let epoch_b = smart_res_b["epoch"].as_i64().unwrap();
    assert!(epoch_b > 0);

    // Hub B now holds the migrated node/channel/rules while preserving its own credentials
    assert_eq!(
        hub_b
            .db
            .get_setting("admin_password_hash")
            .unwrap()
            .as_deref(),
        Some(original_b_pw_hash.as_str())
    );
    assert_eq!(
        hub_b.db.get_setting("session_secret").unwrap().as_deref(),
        Some(original_b_secret.as_str())
    );
    let nodes_b: Value = client
        .get(format!("{base_b}/api/nodes"))
        .header("Cookie", &cookie_b)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(nodes_b["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(nodes_b["nodes"][0]["id"], node_id);
    assert_eq!(hub_b.db.list_channels().unwrap().len(), 1);
    assert!(!hub_b.db.list_rules().unwrap().is_empty());

    // Agent WS on Hub A received signed ctrl.migrate pointing to Hub B + fallback Hub A
    let mig_txt_a = match timeout(Duration::from_secs(3), agent_ws_a.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected migrate ctrl frame on A: {other:?}"),
    };
    let mig_ctrl_a: Value = serde_json::from_str(&mig_txt_a).unwrap();
    let expected_ws_b = format!("ws://{addr_b}/api/agent/ws");
    let expected_ws_a = format!("ws://{addr_a}/api/agent/ws");
    assert_eq!(mig_ctrl_a["migrate"]["url"], expected_ws_b);
    assert_eq!(mig_ctrl_a["migrate"]["fallback_url"], expected_ws_a);
    let sig_a = mig_ctrl_a["migrate"]["sig"].as_str().unwrap();
    let expected_sig_a = hmac_sha256_hex(
        sha256_hex(agent_token.as_bytes()).as_bytes(),
        format!("{node_id}:{epoch_b}:{expected_ws_b}").as_bytes(),
    );
    assert_eq!(sig_a, expected_sig_a);

    // Agent reconnects cleanly to Hub B using original token
    let _agent_ws_b = connect_and_hello_agent(&expected_ws_b, &node_id, &agent_token).await;

    // ---- Flow 2: Install-ticket + bundle pull + three-hub paired-token sync (Hub A -> Hub C) ----
    // 2a. Verify enable_watchdog: false disarms watchdog args
    let install_no_wd: Value = client
        .post(format!("{base_a}/api/migration/ticket"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "purpose": "install", "enable_watchdog": false }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(install_no_wd["ok"], true);
    assert_eq!(install_no_wd["watchdog_armed"], false);
    assert!(!install_no_wd["install_cmd"]
        .as_str()
        .unwrap()
        .contains("--watchdog-url"));

    // 2b. Arm install ticket with watchdog active
    let install_ticket: Value = client
        .post(format!("{base_a}/api/migration/ticket"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "purpose": "install" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(install_ticket["ok"], true);
    assert_eq!(install_ticket["purpose"], "install");
    assert_eq!(install_ticket["origin"], base_a);
    assert_eq!(install_ticket["watchdog_armed"], true);
    let pull_url = install_ticket["pull_url"].as_str().unwrap().to_string();
    let pull_token = pull_url.rsplit('/').next().unwrap().to_string();
    assert!(pull_token.starts_with("uob_mpull_"));
    let install_cmd = install_ticket["install_cmd"].as_str().unwrap();
    assert!(install_cmd.contains(&format!("--import-bundle '{pull_url}'")));
    assert!(install_cmd.contains("--watchdog-url 'https://wd.example.com/ping?k=1'"));
    assert!(install_cmd.contains("--watchdog-secret 'wd_sec'\\''quote'"));

    // Public pull endpoint works via both /releases/migration/pull/{token} and /api/migration/pull/{token}
    let pull_resp = client.get(&pull_url).send().await.unwrap();
    assert_eq!(pull_resp.status(), 200);
    assert_eq!(
        pull_resp
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let pulled_bundle: Value = pull_resp.json().await.unwrap();
    let pulled_settings = pulled_bundle["system_settings"].as_array().unwrap();
    assert!(pulled_settings
        .iter()
        .any(|s| s["key"] == "migration_receive_ticket"));
    assert!(!pulled_settings
        .iter()
        .any(|s| s["key"] == "migration_pull_ticket" || s["key"] == "migration_paired_token"));

    let api_pull_resp = client
        .get(format!("{base_a}/api/migration/pull/{pull_token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(api_pull_resp.status(), 200);
    assert_eq!(
        api_pull_resp
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );

    // Spawn Hub C and import pulled bundle via import_bundle_file_idempotent (first-boot CLI path)
    let cfg_c = HubConfig {
        allow_insecure_ws_for_test: true,
        ..Default::default()
    };
    let (addr_c, hub_c) = spawn_test_hub(cfg_c, None).await;
    let base_c = format!("http://{addr_c}");
    let tmp_bundle = std::env::temp_dir().join(format!(
        "uniob_e2e_install_pull_{}_{}.json",
        std::process::id(),
        now_sec()
    ));
    std::fs::write(&tmp_bundle, serde_json::to_string(&pulled_bundle).unwrap()).unwrap();
    let did_import = hub_c.db.import_bundle_file_idempotent(&tmp_bundle).unwrap();
    let _ = std::fs::remove_file(&tmp_bundle);
    assert!(did_import);
    assert!(hub_c
        .db
        .get_setting("migration_receive_ticket")
        .unwrap()
        .is_some());
    assert_eq!(
        hub_c.db.get_setting("migration_paired_token").unwrap(),
        None
    );

    // Create an extra node on Hub A AFTER install pull to verify paired-token push syncs fresh state
    let created_node_2: Value = client
        .post(format!("{base_a}/api/nodes"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "name": "HK-Smart-02", "group_name": "Edge", "tags": [] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let node_id_2 = created_node_2["node"]["id"].as_str().unwrap().to_string();

    // Execute smart migration to Hub C using URL target (automatically uses migration_paired_token)
    let smart_res_c: Value = client
        .post(format!("{base_a}/api/hub/migrate-smart"))
        .header("Cookie", &cookie_a)
        .json(&json!({
            "target_input": base_c,
            "node_ids": [node_id],
            "allow_insecure_ws": true
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(smart_res_c["ok"], true);
    assert_eq!(smart_res_c["target_origin"], base_c);
    assert_eq!(
        smart_res_c["target_ws_url"],
        format!("ws://{addr_c}/api/agent/ws")
    );
    assert_eq!(
        smart_res_c["fallback_ws_url"],
        format!("ws://{addr_a}/api/agent/ws")
    );
    assert_eq!(smart_res_c["synced"]["nodes"], 2);
    assert_eq!(smart_res_c["synced"]["channels"], 1);
    assert!(smart_res_c["synced"]["rules"].as_u64().unwrap() >= 1);
    assert_eq!(smart_res_c["synced"]["traffic_ledgers"], 0);

    // Also verify Hub A watchdog status starts in "waiting" (enabled, before first ping)
    let status_a: Value = client
        .get(format!("{base_a}/api/hub/status"))
        .header("Cookie", &cookie_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status_a["watchdog"]["enabled"], true);
    assert_eq!(status_a["watchdog"]["status"], "waiting");
    assert_eq!(smart_res_c["targeted"], 1);
    assert_eq!(smart_res_c["dispatched"], 1);

    // Hub C now has both nodes synced and agent receives signed ctrl.migrate to Hub C
    let nodes_c = hub_c.db.list_nodes_with_summary(now_sec()).unwrap();
    assert_eq!(nodes_c.len(), 2);
    assert!(nodes_c.iter().any(|n| n.id == node_id_2));

    let mig_txt_c = match timeout(Duration::from_secs(3), agent_ws_a.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected migrate ctrl frame for C: {other:?}"),
    };
    let mig_ctrl_c: Value = serde_json::from_str(&mig_txt_c).unwrap();
    let expected_ws_c = format!("ws://{addr_c}/api/agent/ws");
    let epoch_c = smart_res_c["epoch"].as_i64().unwrap();
    assert_eq!(mig_ctrl_c["migrate"]["url"], expected_ws_c);
    assert_eq!(mig_ctrl_c["migrate"]["epoch"], epoch_c);
    let sig_c = mig_ctrl_c["migrate"]["sig"].as_str().unwrap();
    assert_eq!(
        sig_c,
        hmac_sha256_hex(
            sha256_hex(agent_token.as_bytes()).as_bytes(),
            format!("{node_id}:{epoch_c}:{expected_ws_c}").as_bytes(),
        )
    );
    let _agent_ws_c = connect_and_hello_agent(&expected_ws_c, &node_id, &agent_token).await;

    // ---- Failure-mapping checks for migrate-smart against mock targets (3xx CF Access, 401 -> 400, 500 -> 502) ----
    let mock_app = axum::Router::new().route(
        "/releases/migration/receive",
        axum::routing::post(|headers: axum::http::HeaderMap| async move {
            let auth = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if auth.ends_with("case302") {
                axum::response::Response::builder()
                    .status(302)
                    .header(
                        "location",
                        "https://team.cloudflareaccess.com/cdn-cgi/access/login",
                    )
                    .body(axum::body::Body::empty())
                    .unwrap()
            } else if auth.ends_with("case401") {
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    axum::Json(json!({ "error": "expired" })),
                )
                    .into_response()
            } else if auth.ends_with("casebadok") {
                (
                    axum::http::StatusCode::OK,
                    axum::Json(json!({ "ok": false, "error": "rejected" })),
                )
                    .into_response()
            } else {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "boom" })),
                )
                    .into_response()
            }
        }),
    );
    use axum::response::IntoResponse;
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_addr = mock_listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(mock_listener, mock_app).await;
    });
    let make_code = |suffix: &str| {
        let payload = serde_json::to_vec(&json!({
            "u": format!("http://{mock_addr}"),
            "k": format!("uob_mtk_{suffix}")
        }))
        .unwrap();
        format!("uobm1_{}", URL_SAFE_NO_PAD.encode(payload))
    };

    // 302 CF Access -> 400 with Cloudflare Access hint
    let r302 = client
        .post(format!("{base_a}/api/hub/migrate-smart"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "target_input": make_code("case302"), "allow_insecure_ws": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(r302.status(), 400);
    let r302_json: Value = r302.json().await.unwrap();
    assert!(r302_json["error"]
        .as_str()
        .unwrap()
        .contains("Cloudflare Access"));

    // Target 401 -> mapped to 400 (never 401 so source admin session stays logged in!)
    let r401 = client
        .post(format!("{base_a}/api/hub/migrate-smart"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "target_input": make_code("case401"), "allow_insecure_ws": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(r401.status(), 400);

    // Target 200 { ok: false } -> 400
    let rbadok = client
        .post(format!("{base_a}/api/hub/migrate-smart"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "target_input": make_code("casebadok"), "allow_insecure_ws": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(rbadok.status(), 400);

    // Target 500 -> 502
    let r500 = client
        .post(format!("{base_a}/api/hub/migrate-smart"))
        .header("Cookie", &cookie_a)
        .json(&json!({ "target_input": make_code("case500"), "allow_insecure_ws": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(r500.status(), 502);

    let _ = (hub_a, hub_b, hub_c);
}

#[tokio::test]
async fn auto_update_config_check_trigger_status_and_override_flow() {
    use axum::{routing::get, Router};
    use tokio::net::TcpListener;
    use uniob_hub::crypto::{hmac_sha256_hex, sha256_hex};

    let releases_dir = std::env::temp_dir().join(format!(
        "uniob_hub_e2e_releases_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&releases_dir).unwrap();

    let fake_bin = b"\x7fELF\x02\x01\x01\x00uniob-agent-v0.2.5";
    let fake_sha = sha256_hex(fake_bin);
    std::fs::write(
        releases_dir.join("uniob-agent-x86_64-unknown-linux-musl"),
        fake_bin,
    )
    .unwrap();
    std::fs::write(releases_dir.join("VERSION"), "0.2.5\n").unwrap();
    std::fs::write(
        releases_dir.join("SHA256SUMS"),
        format!("{fake_sha}  uniob-agent-x86_64-unknown-linux-musl\n"),
    )
    .unwrap();

    let hub_cfg = HubConfig {
        releases_dir: releases_dir.clone(),
        ..Default::default()
    };
    let (addr, _hub) = spawn_test_hub(hub_cfg, None).await;
    let base = format!("http://{addr}");
    let ws_base = format!("ws://{addr}");
    let client = reqwest::Client::new();

    // Unauthenticated access rejected
    assert_eq!(
        client
            .get(format!("{base}/api/agent-update/config"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    let cookie = login_cookie(&client, &base, "AutoUpdatePass123!").await;

    // Initial config
    let cfg_res: Value = client
        .get(format!("{base}/api/agent-update/config"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(cfg_res["ok"], true);
    assert_eq!(cfg_res["config"]["auto_update_enabled"], false);
    assert_eq!(cfg_res["config"]["channel"], "stable");
    assert_eq!(cfg_res["config"]["check_interval_sec"], 21600);
    assert_eq!(cfg_res["bundled_version"], "0.3.0");

    // Check release against local releases_dir
    let chk_res: Value = client
        .post(format!("{base}/api/agent-update/check"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(chk_res["ok"], true);
    assert!(chk_res["error"].is_null());
    assert_eq!(chk_res["latest_release"]["version"], "0.2.5");
    assert_eq!(chk_res["latest_release"]["source"], "local");
    let asset_url = chk_res["latest_release"]["assets"]["amd64"]["url"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(asset_url.ends_with("/releases/uniob-agent-x86_64-unknown-linux-musl"));
    assert_eq!(
        chk_res["latest_release"]["assets"]["amd64"]["sha256"],
        fake_sha
    );
    // Hub serves the staged release binary over /releases/*
    let dl_bytes = client
        .get(&asset_url)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(dl_bytes.as_ref(), fake_bin);

    // Create node & connect admin fleet client WS
    let created: Value = client
        .post(format!("{base}/api/nodes"))
        .header("Cookie", &cookie)
        .json(&json!({ "name": "AutoUpd-Node" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let node_id = created["node"]["id"].as_str().unwrap().to_string();
    let token = created["agent_token"].as_str().unwrap().to_string();
    let token_sha256 = sha256_hex(token.as_bytes());

    let mut client_req = format!("{ws_base}/api/client/ws")
        .into_client_request()
        .unwrap();
    client_req
        .headers_mut()
        .insert("Cookie", HeaderValue::from_str(&cookie).unwrap());
    let (mut client_ws, _) = tokio_tungstenite::connect_async(client_req).await.unwrap();
    client_ws
        .send(WsMsg::Text(json!({"op":"sub_fleet"}).to_string().into()))
        .await
        .unwrap();

    // Connect agent with v0.2.0 and auto_update_v1 capability
    let mut agent_req = format!("{ws_base}/api/agent/ws")
        .into_client_request()
        .unwrap();
    agent_req
        .headers_mut()
        .insert("X-UniOB-Node-Id", HeaderValue::from_str(&node_id).unwrap());
    agent_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (mut agent_ws, _) = tokio_tungstenite::connect_async(agent_req).await.unwrap();
    let hello = json!({
        "t": "hello",
        "v": 2,
        "agent_ver": "0.2.0",
        "hostname": "upd-host",
        "os": "Linux",
        "kernel": "6.8.0",
        "arch": "x86_64",
        "cpu_model": "EPYC",
        "cpu_cores": 2,
        "mem_total": 2_000_000_000u64,
        "swap_total": 0,
        "boot_time": 1_700_000_000u64,
        "proc_enabled": true,
        "capabilities": ["mb_v2", "network_quality_v1", "auto_update_v1"]
    });
    agent_ws
        .send(WsMsg::Text(hello.to_string().into()))
        .await
        .unwrap();

    // Initial hello reply should have no update because auto_update_enabled=false
    let init_ctrl_txt = match timeout(Duration::from_secs(3), agent_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected frame: {other:?}"),
    };
    let init_ctrl: Value = serde_json::from_str(&init_ctrl_txt).unwrap();
    assert!(init_ctrl.get("update").is_none());

    // Disable node via auto_update_override = false -> non-forced trigger skips it
    let patch_resp: Value = client
        .patch(format!("{base}/api/nodes/{node_id}"))
        .header("Cookie", &cookie)
        .json(&json!({ "auto_update_override": false }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(patch_resp["node"]["auto_update_override"], false);

    let skip_trig: Value = client
        .post(format!("{base}/api/agent-update/trigger"))
        .header("Cookie", &cookie)
        .json(&json!({ "node_ids": [&node_id], "force": false }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(skip_trig["targeted"], 1);
    assert_eq!(skip_trig["dispatched"], 0);
    assert_eq!(skip_trig["skipped"], 1);

    // Forced trigger dispatches signed update directive over WS
    let force_trig: Value = client
        .post(format!("{base}/api/agent-update/trigger"))
        .header("Cookie", &cookie)
        .json(&json!({ "node_ids": [&node_id], "force": true }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(force_trig["ok"], true);
    assert_eq!(force_trig["version"], "0.2.5");
    assert_eq!(force_trig["targeted"], 1);
    assert_eq!(force_trig["dispatched"], 1);
    assert_eq!(force_trig["skipped"], 0);

    let upd_ctrl_txt = match timeout(Duration::from_secs(3), agent_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("unexpected ctrl: {other:?}"),
    };
    let upd_ctrl: Value = serde_json::from_str(&upd_ctrl_txt).unwrap();
    let dir = upd_ctrl.get("update").expect("ctrl.update must be present");
    assert_eq!(dir["version"], "0.2.5");
    assert_eq!(dir["sha256"], fake_sha);
    assert_eq!(dir["url"], asset_url);
    let issued_at = dir["issued_at"].as_u64().unwrap();
    let expected_msg = format!(
        "agent_update_v1:{node_id}:0.2.5:{fake_sha}:{issued_at}:{asset_url}:{}",
        dir["fallback_url"].as_str().unwrap_or("")
    );
    let expected_hmac = hmac_sha256_hex(token_sha256.as_bytes(), expected_msg.as_bytes());
    assert_eq!(dir["hmac"], expected_hmac);

    // Agent reports downloading in `m` frame and staged in `mb` frame
    let sample_metric = json!({
        "ts": 1_800_000_010u64,
        "up": 100,
        "cpu": { "all": 10.0, "steal": 0.0, "iowait": 0.0 },
        "mem": { "used": 100, "avail": 900, "cached": 50, "swap_used": 0 },
        "net": { "rx_bps": 0, "tx_bps": 0, "rx_tot": 0, "tx_tot": 0, "tcp_est": 1, "tcp_tw": 0, "udp": 0 }
    });
    let mut m_frame = sample_metric.clone();
    m_frame["t"] = json!("m");
    m_frame["upd"] = json!({ "st": "downloading", "ver": "0.2.5", "ts": 1_800_000_010u64 });
    agent_ws
        .send(WsMsg::Text(m_frame.to_string().into()))
        .await
        .unwrap();

    let mb_frame = json!({
        "t": "mb",
        "pts": [[1800000012.0, 102.0, 12.0, 0.0, 0.0, 0.1, 100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]],
        "last": sample_metric,
        "upd": { "st": "staged", "ver": "0.2.5", "ts": 1_800_000_012u64 }
    });
    agent_ws
        .send(WsMsg::Text(mb_frame.to_string().into()))
        .await
        .unwrap();

    // Verify client fleet_tick receives staged update_status
    let mut saw_staged_tick = false;
    for _ in 0..10 {
        let msg = timeout(Duration::from_secs(3), client_ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let WsMsg::Text(txt) = msg {
            let v: Value = serde_json::from_str(&txt).unwrap();
            if v["t"] == "fleet_tick"
                && v["nodeId"] == node_id
                && v["update_status"]["state"] == "staged"
            {
                assert_eq!(v["update_status"]["target_version"], "0.2.5");
                saw_staged_tick = true;
                break;
            }
        }
    }
    assert!(
        saw_staged_tick,
        "expected fleet_tick with staged update_status"
    );

    // Verify GET /api/nodes reflects caps, auto_update_override=false, update_status=staged
    let nodes_res: Value = client
        .get(format!("{base}/api/nodes"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let n0 = nodes_res["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == node_id)
        .unwrap();
    assert_eq!(n0["auto_update_override"], false);
    assert_eq!(n0["update_status"]["state"], "staged");
    assert_eq!(n0["update_status"]["target_version"], "0.2.5");
    assert!(n0["caps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c == "auto_update_v1"));

    // Reset override to inherit (null) and enable auto_update via PUT /api/agent-update/config
    let patch_null: Value = client
        .patch(format!("{base}/api/nodes/{node_id}"))
        .header("Cookie", &cookie)
        .json(&json!({ "auto_update_override": Value::Null }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(patch_null["node"]["auto_update_override"].is_null());

    // Simulate agent restarting on 0.2.5 and reconnecting -> DB settles update_status to idle
    drop(agent_ws);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut agent_req2 = format!("{ws_base}/api/agent/ws")
        .into_client_request()
        .unwrap();
    agent_req2
        .headers_mut()
        .insert("X-UniOB-Node-Id", HeaderValue::from_str(&node_id).unwrap());
    agent_req2.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (mut agent_ws2, _) = tokio_tungstenite::connect_async(agent_req2).await.unwrap();
    let mut hello_new = hello;
    hello_new["agent_ver"] = json!("0.2.5");
    agent_ws2
        .send(WsMsg::Text(hello_new.to_string().into()))
        .await
        .unwrap();
    let _ = timeout(Duration::from_secs(3), agent_ws2.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let nodes_after_restart: Value = client
        .get(format!("{base}/api/nodes"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let n0_after = nodes_after_restart["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == node_id)
        .unwrap();
    assert_eq!(n0_after["agent_version"], "0.2.5");
    assert_eq!(n0_after["update_status"]["state"], "idle");

    // Verify SSRF and URL validation guards reject invalid custom_base_url by default
    for bad_url in [
        "http://127.0.0.1:8080/mirror",
        "https://user:pass@mirror.example.com",
        "https://mirror.example.com?q=1",
        "https://mirror.example.com#frag",
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/agent-update/config"))
                .header("Cookie", &cookie)
                .json(&json!({ "custom_base_url": bad_url }))
                .send()
                .await
                .unwrap()
                .status(),
            400,
            "expected HTTP 400 for invalid custom_base_url={bad_url}"
        );
    }

    // Export bundle, enable auto_update_enabled in bundle, connect agent on v0.2.0 to Hub B
    // (local 0.2.5 releases_dir + allow_insecure_ws_for_test=true) and verify import triggers
    // immediate update dispatch + custom_base_url loopback mirror test.
    let mut bundle: Value = client
        .get(format!("{base}/api/export/bundle"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    if let Some(nodes) = bundle["nodes"].as_array_mut() {
        for n in nodes {
            n["agent_version"] = json!("0.2.0");
            n["update_status_json"] = Value::Null;
        }
    }
    if let Some(settings) = bundle["system_settings"].as_array_mut() {
        settings.retain(|s| s["key"] != "agent_update_config");
        settings.push(json!({
            "key": "agent_update_config",
            "value": json!({
                "auto_update_enabled": true,
                "channel": "stable",
                "check_interval_sec": 300,
                "custom_base_url": ""
            })
            .to_string()
        }));
    }

    let hub_b_cfg = HubConfig {
        releases_dir: releases_dir.clone(),
        allow_insecure_ws_for_test: true,
        ..Default::default()
    };
    let (addr_b, _hub_b) = spawn_test_hub(hub_b_cfg, None).await;
    let base_b = format!("http://{addr_b}");
    let ws_base_b = format!("ws://{addr_b}");
    let cookie_b = login_cookie(&client, &base_b, "MirrorHubPass123!").await;

    // Seed matching node on Hub B and connect agent with 0.2.0 BEFORE importing bundle
    let imported_b_first: Value = client
        .post(format!("{base_b}/api/import/bundle"))
        .header("Cookie", &cookie_b)
        .json(&json!({
            "schema_version": bundle["schema_version"],
            "exported_at": bundle["exported_at"],
            "system_settings": [],
            "nodes": bundle["nodes"],
            "channels": [],
            "rules": []
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(imported_b_first["ok"], true);

    let mut agent_req_b = format!("{ws_base_b}/api/agent/ws")
        .into_client_request()
        .unwrap();
    agent_req_b
        .headers_mut()
        .insert("X-UniOB-Node-Id", HeaderValue::from_str(&node_id).unwrap());
    agent_req_b.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (mut agent_ws_b, _) = tokio_tungstenite::connect_async(agent_req_b).await.unwrap();
    let mut hello_b = hello_new.clone();
    hello_b["agent_ver"] = json!("0.2.0");
    agent_ws_b
        .send(WsMsg::Text(hello_b.to_string().into()))
        .await
        .unwrap();
    let _ = timeout(Duration::from_secs(3), agent_ws_b.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    // Importing bundle with auto_update_enabled=true must immediately dispatch 0.2.5 to connected agent
    let imported_b_enabled: Value = client
        .post(format!("{base_b}/api/import/bundle"))
        .header("Cookie", &cookie_b)
        .json(&bundle)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(imported_b_enabled["ok"], true);
    let import_ctrl_txt = match timeout(Duration::from_secs(3), agent_ws_b.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("expected auto-update ctrl frame on bundle import, got: {other:?}"),
    };
    let import_ctrl: Value = serde_json::from_str(&import_ctrl_txt).unwrap();
    assert_eq!(import_ctrl["update"]["version"], "0.2.5");
    assert_eq!(import_ctrl["update"]["sha256"], fake_sha);

    // Mock custom mirror URL on Hub B (allow_insecure_ws_for_test=true) -> auto-dispatch of 0.3.0
    let mirror_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mirror_addr = mirror_listener.local_addr().unwrap();
    let v3_sha = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    let mirror_app = Router::new()
        .route("/VERSION", get(|| async { "0.3.0\n" }))
        .route(
            "/SHA256SUMS",
            get(
                move || async move { format!("{v3_sha}  uniob-agent-x86_64-unknown-linux-musl\n") },
            ),
        );
    tokio::spawn(async move {
        let _ = axum::serve(mirror_listener, mirror_app).await;
    });

    let put_res: Value = client
        .put(format!("{base_b}/api/agent-update/config"))
        .header("Cookie", &cookie_b)
        .json(&json!({
            "auto_update_enabled": true,
            "channel": "stable",
            "check_interval_sec": 300,
            "custom_base_url": format!("http://{mirror_addr}")
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(put_res["ok"], true);
    assert_eq!(put_res["config"]["auto_update_enabled"], true);
    assert_eq!(put_res["latest_release"]["version"], "0.3.0");
    assert_eq!(put_res["latest_release"]["source"], "custom");

    // Connected node on Hub B should receive automatic update directive for 0.3.0
    let auto_ctrl_txt = match timeout(Duration::from_secs(3), agent_ws_b.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        WsMsg::Text(t) => t,
        other => panic!("expected auto update ctrl frame, got: {other:?}"),
    };
    let auto_ctrl: Value = serde_json::from_str(&auto_ctrl_txt).unwrap();
    assert_eq!(auto_ctrl["update"]["version"], "0.3.0");
    assert_eq!(auto_ctrl["update"]["sha256"], v3_sha);

    let _ = (agent_ws2, agent_ws_b);
    let _ = std::fs::remove_dir_all(&releases_dir);
}
