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
