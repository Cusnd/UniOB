use crate::alerts::{
    compute_watermarks_for_node, evaluate_node_metrics_alerts, evaluate_node_offline_alerts,
    get_offline_threshold_sec, resolve_offline_rules_if_firing,
};
use crate::auth::{CfAccessVerifier, LoginRateLimiter};
use crate::config::HubConfig;
use crate::crypto::{now_sec, sign_migrate_directive};
use crate::db::{payload_to_raw_sample, HubDb, RawSlabSample};
use crate::protocol::{
    metrics_frame_to_tuple, AgentCtrlFrame, AgentHelloFrame, AgentMetricsBatchFrame,
    AgentMetricsFrame, AlertChangeMessage, CtrlMigrateDirective, FleetBatchMessage,
    FleetTickMessage, HubMigrateRequest, HubMigrateResponse, HubStatusResponse, NodeDetailMessage,
    NodeHardwareInfo, NodeMetricsPayload, NodeOfflineMessage, NodeRow, WatchdogStatusView,
};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use url::Url;

pub const CLIENT_LEASE_SEC: u64 = 90;
pub const RAW_SAMPLE_MIN_GAP_SEC: i64 = 25;
pub const WS_CLOSE_SUPERSEDED: u16 = 4000;

#[derive(Debug, Clone)]
pub enum AgentOutboundCmd {
    Ctrl(AgentCtrlFrame),
    Close(u16, String),
}

#[derive(Clone)]
pub struct AgentSessionHandle {
    pub conn_id: u64,
    pub tx: mpsc::UnboundedSender<AgentOutboundCmd>,
    pub capabilities: Vec<String>,
}

#[derive(Clone)]
pub struct ClientSubscriber {
    pub tx: mpsc::UnboundedSender<String>,
    pub fleet: bool,
    pub node_id: Option<String>,
    pub proc: bool,
    pub lease_expires_at: i64,
}

#[derive(Debug, Default, Clone)]
pub struct WatchdogRuntimeState {
    pub enabled: bool,
    pub last_ping_ts: Option<i64>,
    pub last_ok: Option<bool>,
    pub enabled_at: Option<i64>,
    pub timeout_sec: u64,
}

#[derive(Clone)]
pub struct HubState {
    pub cfg: Arc<HubConfig>,
    pub db: HubDb,
    pub http: reqwest::Client,
    pub cf_verifier: CfAccessVerifier,
    pub rate_limiter: LoginRateLimiter,
    agents: Arc<RwLock<HashMap<String, AgentSessionHandle>>>,
    agent_last_alive: Arc<RwLock<HashMap<String, i64>>>,
    clients: Arc<RwLock<HashMap<u64, ClientSubscriber>>>,
    watchdog: Arc<RwLock<WatchdogRuntimeState>>,
    next_id: Arc<AtomicU64>,
}

impl HubState {
    pub fn new(cfg: HubConfig, db: HubDb, http: reqwest::Client) -> Self {
        let cf_verifier = CfAccessVerifier::new(http.clone());
        let wd_enabled =
            !cfg.watchdog_url.trim().is_empty() && !cfg.watchdog_secret.trim().is_empty();
        let wd_state = WatchdogRuntimeState {
            enabled: wd_enabled,
            last_ping_ts: None,
            last_ok: None,
            enabled_at: if wd_enabled { Some(now_sec()) } else { None },
            timeout_sec: cfg.watchdog_timeout_sec,
        };
        Self {
            cfg: Arc::new(cfg),
            db,
            http,
            cf_verifier,
            rate_limiter: LoginRateLimiter::default(),
            agents: Arc::new(RwLock::new(HashMap::new())),
            agent_last_alive: Arc::new(RwLock::new(HashMap::new())),
            clients: Arc::new(RwLock::new(HashMap::new())),
            watchdog: Arc::new(RwLock::new(wd_state)),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn with_cf_certs_url(mut self, certs_url: String) -> Self {
        self.cf_verifier = self.cf_verifier.with_certs_url(certs_url);
        self
    }

    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn record_watchdog_ping(&self, ts: i64, ok: bool) {
        let mut guard = self.watchdog.write().await;
        if ok {
            guard.last_ping_ts = Some(ts);
        }
        guard.last_ok = Some(ok);
    }

    pub async fn hub_status(&self) -> Result<HubStatusResponse, String> {
        let connected_agents = {
            let guard = self.agents.read().await;
            guard.len()
        };
        let total_nodes = self.db.count_nodes()?;
        let wd = self.watchdog.read().await.clone();
        let now = now_sec();
        let status = if !wd.enabled {
            "disabled".to_string()
        } else if let Some(last) = wd.last_ping_ts {
            if now - last > wd.timeout_sec as i64 || wd.last_ok == Some(false) {
                "stale".to_string()
            } else {
                "healthy".to_string()
            }
        } else {
            "waiting".to_string()
        };

        Ok(HubStatusResponse {
            mode: "self-hosted-hub",
            version: env!("CARGO_PKG_VERSION").to_string(),
            connected_agents,
            total_nodes,
            watchdog: WatchdogStatusView {
                enabled: wd.enabled,
                last_ping_ts: wd.last_ping_ts,
                status,
                timeout_sec: wd.timeout_sec,
            },
        })
    }

    pub async fn touch_agent_alive(&self, node_id: &str, ts: i64) {
        let mut guard = self.agent_last_alive.write().await;
        guard.insert(node_id.to_string(), ts);
    }

    pub async fn register_agent(
        &self,
        node_id: &str,
        tx: mpsc::UnboundedSender<AgentOutboundCmd>,
    ) -> u64 {
        let conn_id = self.alloc_id();
        let mut guard = self.agents.write().await;
        if let Some(prev) = guard.insert(
            node_id.to_string(),
            AgentSessionHandle {
                conn_id,
                tx,
                capabilities: Vec::new(),
            },
        ) {
            let _ = prev.tx.send(AgentOutboundCmd::Close(
                WS_CLOSE_SUPERSEDED,
                "Superseded by new connection".to_string(),
            ));
        }
        drop(guard);
        self.touch_agent_alive(node_id, now_sec()).await;
        conn_id
    }

    pub async fn unregister_agent(&self, node_id: &str, conn_id: u64) {
        let mut guard = self.agents.write().await;
        if let Some(existing) = guard.get(node_id) {
            if existing.conn_id == conn_id {
                guard.remove(node_id);
            }
        }
    }

    pub async fn disconnect_agent(&self, node_id: &str, code: u16, reason: &str) {
        let mut guard = self.agents.write().await;
        if let Some(existing) = guard.remove(node_id) {
            let _ = existing
                .tx
                .send(AgentOutboundCmd::Close(code, reason.to_string()));
        }
    }

    pub async fn set_agent_capabilities(&self, node_id: &str, conn_id: u64, caps: Vec<String>) {
        let mut guard = self.agents.write().await;
        if let Some(existing) = guard.get_mut(node_id) {
            if existing.conn_id == conn_id {
                existing.capabilities = caps;
            }
        }
    }

    pub async fn compute_ctrl_for_node(&self, node_id: &str, flush_now: bool) -> AgentCtrlFrame {
        let now = now_sec();
        let (any_fleet, any_detail, any_proc) = {
            let guard = self.clients.read().await;
            let mut fleet = false;
            let mut detail = false;
            let mut proc_flag = false;
            for c in guard.values() {
                if c.lease_expires_at <= now {
                    continue;
                }
                if c.fleet {
                    fleet = true;
                }
                if c.node_id.as_deref() == Some(node_id) {
                    detail = true;
                    if c.proc {
                        proc_flag = true;
                    }
                }
            }
            (fleet, detail, proc_flag)
        };

        let rules = self.db.list_rules().unwrap_or_default();
        let watermarks = compute_watermarks_for_node(node_id, &rules);

        let (mode, interval_ms, batch_sec, top_n, lease_sec) = if any_proc {
            (2u8, 2000u64, None, 30u16, CLIENT_LEASE_SEC)
        } else if any_detail {
            (1u8, 2000u64, None, 30u16, CLIENT_LEASE_SEC)
        } else if any_fleet {
            (1u8, 10000u64, None, 0u16, CLIENT_LEASE_SEC)
        } else {
            (0u8, 30000u64, Some(300u64), 0u16, 0u64)
        };

        AgentCtrlFrame {
            t: "ctrl",
            mode,
            interval_ms,
            batch_sec,
            top_n,
            lease_sec,
            flush_now: if flush_now { Some(true) } else { None },
            watermarks,
            migrate: None,
        }
    }

    pub async fn push_ctrl_to_agent(&self, node_id: &str, flush_now: bool) {
        let ctrl = self.compute_ctrl_for_node(node_id, flush_now).await;
        let guard = self.agents.read().await;
        if let Some(handle) = guard.get(node_id) {
            let _ = handle.tx.send(AgentOutboundCmd::Ctrl(ctrl));
        }
    }

    pub async fn sync_ctrl_to_all_agents(&self, flush_now: bool) {
        let node_ids: Vec<String> = {
            let guard = self.agents.read().await;
            guard.keys().cloned().collect()
        };
        for id in node_ids {
            self.push_ctrl_to_agent(&id, flush_now).await;
        }
    }

    pub async fn register_client(&self, tx: mpsc::UnboundedSender<String>) -> u64 {
        let id = self.alloc_id();
        let now = now_sec();
        let mut guard = self.clients.write().await;
        guard.insert(
            id,
            ClientSubscriber {
                tx,
                fleet: false,
                node_id: None,
                proc: false,
                lease_expires_at: now + CLIENT_LEASE_SEC as i64,
            },
        );
        id
    }

    pub async fn unregister_client(&self, client_id: u64) {
        let prev_node_id = {
            let mut guard = self.clients.write().await;
            guard.remove(&client_id).and_then(|c| c.node_id)
        };
        if let Some(node_id) = prev_node_id {
            self.push_ctrl_to_agent(&node_id, false).await;
        }
        self.sync_ctrl_to_all_agents(false).await;
    }

    pub async fn handle_client_command(
        &self,
        client_id: u64,
        cmd: crate::protocol::ClientInboundMessage,
    ) {
        use crate::protocol::ClientInboundMessage;
        let now = now_sec();
        match cmd {
            ClientInboundMessage::Ping => {
                let guard = self.clients.read().await;
                if let Some(c) = guard.get(&client_id) {
                    let _ = c.tx.send(r#"{"t":"pong"}"#.to_string());
                }
            }
            ClientInboundMessage::Renew => {
                let mut guard = self.clients.write().await;
                if let Some(c) = guard.get_mut(&client_id) {
                    if c.fleet || c.node_id.is_some() {
                        c.lease_expires_at = now + CLIENT_LEASE_SEC as i64;
                    }
                }
            }
            ClientInboundMessage::SubFleet => {
                let tx_opt = {
                    let mut guard = self.clients.write().await;
                    if let Some(c) = guard.get_mut(&client_id) {
                        c.fleet = true;
                        c.lease_expires_at = now + CLIENT_LEASE_SEC as i64;
                        Some(c.tx.clone())
                    } else {
                        None
                    }
                };
                if let Some(tx) = tx_opt {
                    if let Ok(summaries) = self.db.list_nodes_with_summary(now) {
                        let ticks: Vec<FleetTickMessage> = summaries
                            .into_iter()
                            .map(|s| FleetTickMessage {
                                t: "fleet_tick",
                                node_id: s.id,
                                online: s.online,
                                last_seen_ts: s.last_seen_ts,
                                traffic: s.traffic,
                                metrics: s.metrics,
                                hardware: Some(NodeHardwareInfo {
                                    hostname: s.hostname,
                                    os: s.os,
                                    kernel: s.kernel,
                                    arch: s.arch,
                                    cpu_model: s.cpu_model,
                                    cpu_cores: s.cpu_cores,
                                    mem_total: s.mem_total,
                                    swap_total: s.swap_total,
                                    agent_version: s.agent_version,
                                    proc_enabled: s.proc_enabled,
                                }),
                            })
                            .collect();
                        let batch = FleetBatchMessage {
                            t: "fleet_batch",
                            ticks,
                        };
                        if let Ok(json) = serde_json::to_string(&batch) {
                            let _ = tx.send(json);
                        }
                    }
                }
                self.sync_ctrl_to_all_agents(true).await;
            }
            ClientInboundMessage::UnsubFleet => {
                {
                    let mut guard = self.clients.write().await;
                    if let Some(c) = guard.get_mut(&client_id) {
                        c.fleet = false;
                        c.lease_expires_at = now + CLIENT_LEASE_SEC as i64;
                    }
                }
                self.sync_ctrl_to_all_agents(false).await;
            }
            ClientInboundMessage::SubNode { node_id, proc } => {
                let prev = {
                    let mut guard = self.clients.write().await;
                    if let Some(c) = guard.get_mut(&client_id) {
                        let old = c.node_id.replace(node_id.clone());
                        c.proc = proc;
                        c.lease_expires_at = now + CLIENT_LEASE_SEC as i64;
                        old
                    } else {
                        None
                    }
                };
                if let Some(old_id) = prev {
                    if old_id != node_id {
                        self.push_ctrl_to_agent(&old_id, false).await;
                    }
                }
                self.push_ctrl_to_agent(&node_id, true).await;
            }
            ClientInboundMessage::UnsubNode { node_id } => {
                let removed = {
                    let mut guard = self.clients.write().await;
                    if let Some(c) = guard.get_mut(&client_id) {
                        let matches = match (&node_id, &c.node_id) {
                            (Some(target), Some(curr)) => target == curr,
                            (None, Some(_)) => true,
                            _ => false,
                        };
                        if matches {
                            c.proc = false;
                            c.lease_expires_at = now + CLIENT_LEASE_SEC as i64;
                            c.node_id.take()
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some(old_id) = removed {
                    self.push_ctrl_to_agent(&old_id, false).await;
                }
            }
        }
    }

    pub async fn ingest_hello(
        &self,
        node_id: &str,
        conn_id: Option<u64>,
        hello: AgentHelloFrame,
    ) -> Result<AgentCtrlFrame, String> {
        let now = now_sec();
        self.touch_agent_alive(node_id, now).await;
        if let Some(cid) = conn_id {
            if !hello.capabilities.is_empty() {
                self.set_agent_capabilities(node_id, cid, hello.capabilities.clone())
                    .await;
            }
        }

        let hw = NodeHardwareInfo {
            hostname: non_empty(&hello.hostname),
            os: non_empty(&hello.os),
            kernel: non_empty(&hello.kernel),
            arch: non_empty(&hello.arch),
            cpu_model: non_empty(&hello.cpu_model),
            cpu_cores: Some(hello.cpu_cores as i64),
            mem_total: Some(hello.mem_total as i64),
            swap_total: Some(hello.swap_total as i64),
            agent_version: non_empty(&hello.agent_ver),
            proc_enabled: hello.proc_enabled,
        };
        self.db.update_node_hello(node_id, &hw, now)?;

        if let Some(node) = self.db.get_node_row(node_id)? {
            let resolved = resolve_offline_rules_if_firing(&self.db, &self.http, &node, now)?;
            if resolved {
                self.broadcast_alert_change().await;
            }
        }

        if let Some(summary) = self.db.get_node_summary(node_id, now)? {
            self.broadcast_fleet_tick(FleetTickMessage {
                t: "fleet_tick",
                node_id: node_id.to_string(),
                online: true,
                last_seen_ts: Some(now),
                traffic: summary.traffic,
                metrics: summary.metrics,
                hardware: Some(hw),
            })
            .await;
        }

        Ok(self.compute_ctrl_for_node(node_id, false).await)
    }

    pub async fn ingest_metrics_v1(
        &self,
        node_id: &str,
        frame: AgentMetricsFrame,
    ) -> Result<(), String> {
        let wall_sec = now_sec();
        self.touch_agent_alive(node_id, wall_sec).await;
        let Some(node) = self.db.get_node_row(node_id)? else {
            return Err("Unknown node".to_string());
        };
        let mut payload = NodeMetricsPayload::from(&frame);
        if payload.ts == 0 {
            payload.ts = wall_sec as u64;
        }
        let last_raw_ts = self.db.last_raw_write_ts(node_id)?;
        let should_write_raw =
            last_raw_ts == 0 || (payload.ts as i64 - last_raw_ts) >= RAW_SAMPLE_MIN_GAP_SEC;
        let pts = if should_write_raw {
            vec![payload_to_raw_sample(&payload)]
        } else {
            vec![]
        };

        let (traffic, was_offline) = self.db.record_metrics_batch(
            node_id,
            node.traffic_reset_day,
            &node.traffic_count_mode,
            node.traffic_limit_bytes,
            wall_sec,
            &pts,
            &payload,
            should_write_raw,
        )?;

        self.after_metrics_persisted(
            &node,
            &traffic,
            &payload,
            frame.procs,
            was_offline,
            wall_sec,
        )
        .await
    }

    pub async fn ingest_metrics_v2_mb(
        &self,
        node_id: &str,
        batch: AgentMetricsBatchFrame,
    ) -> Result<(), String> {
        let wall_sec = now_sec();
        self.touch_agent_alive(node_id, wall_sec).await;
        let Some(node) = self.db.get_node_row(node_id)? else {
            return Err("Unknown node".to_string());
        };

        let mut latest_payload = NodeMetricsPayload::from(&batch.last);
        if latest_payload.ts == 0 {
            latest_payload.ts = wall_sec as u64;
        }

        let mut samples: Vec<RawSlabSample> = Vec::with_capacity(batch.pts.len() + 1);
        for t in &batch.pts {
            if t[0].is_finite() && t[0] > 0.0 {
                samples.push(RawSlabSample::from_tuple(t));
            }
        }
        let last_sample = RawSlabSample::from_tuple(&metrics_frame_to_tuple(&batch.last));
        if samples.last().map(|s| s.ts) != Some(last_sample.ts) && last_sample.ts > 0 {
            samples.push(last_sample);
        }
        samples.sort_by_key(|s| s.ts);

        let (traffic, was_offline) = self.db.record_metrics_batch(
            node_id,
            node.traffic_reset_day,
            &node.traffic_count_mode,
            node.traffic_limit_bytes,
            wall_sec,
            &samples,
            &latest_payload,
            !samples.is_empty(),
        )?;

        self.after_metrics_persisted(
            &node,
            &traffic,
            &latest_payload,
            batch.last.procs,
            was_offline,
            wall_sec,
        )
        .await
    }

    async fn after_metrics_persisted(
        &self,
        node: &NodeRow,
        traffic: &crate::protocol::NodeTrafficSummary,
        payload: &NodeMetricsPayload,
        procs: Option<Vec<crate::protocol::AgentProcEntry>>,
        was_offline: bool,
        wall_sec: i64,
    ) -> Result<(), String> {
        let mut alert_changed = false;
        if was_offline && resolve_offline_rules_if_firing(&self.db, &self.http, node, wall_sec)? {
            alert_changed = true;
        }
        let (metric_alert_changed, _) =
            evaluate_node_metrics_alerts(&self.db, &self.http, node, traffic, payload, wall_sec)?;
        if metric_alert_changed {
            alert_changed = true;
        }
        if alert_changed {
            self.broadcast_alert_change().await;
        }

        self.broadcast_live_update(&node.id, wall_sec, traffic.clone(), payload.clone(), procs)
            .await;
        Ok(())
    }

    async fn broadcast_live_update(
        &self,
        node_id: &str,
        wall_sec: i64,
        traffic: crate::protocol::NodeTrafficSummary,
        metrics: NodeMetricsPayload,
        procs: Option<Vec<crate::protocol::AgentProcEntry>>,
    ) {
        let now = now_sec();
        let clients = self.clients.read().await;
        if clients.is_empty() {
            return;
        }

        let tick_json = serde_json::to_string(&FleetTickMessage {
            t: "fleet_tick",
            node_id: node_id.to_string(),
            online: true,
            last_seen_ts: Some(wall_sec),
            traffic,
            metrics: Some(metrics.clone()),
            hardware: None,
        })
        .ok();

        let detail_no_proc_json = serde_json::to_string(&NodeDetailMessage {
            t: "node_detail",
            node_id: node_id.to_string(),
            online: true,
            ts: metrics.ts,
            metrics: metrics.clone(),
            procs: None,
        })
        .ok();

        let detail_with_proc_json = if procs.is_some() {
            serde_json::to_string(&NodeDetailMessage {
                t: "node_detail",
                node_id: node_id.to_string(),
                online: true,
                ts: metrics.ts,
                metrics,
                procs,
            })
            .ok()
        } else {
            detail_no_proc_json.clone()
        };

        for c in clients.values() {
            if c.lease_expires_at <= now {
                continue;
            }
            if c.fleet {
                if let Some(ref json) = tick_json {
                    let _ = c.tx.send(json.clone());
                }
            }
            if c.node_id.as_deref() == Some(node_id) {
                let msg = if c.proc {
                    detail_with_proc_json.as_ref()
                } else {
                    detail_no_proc_json.as_ref()
                };
                if let Some(json) = msg {
                    let _ = c.tx.send(json.clone());
                }
            }
        }
    }

    async fn broadcast_fleet_tick(&self, tick: FleetTickMessage) {
        let now = now_sec();
        let Ok(json) = serde_json::to_string(&tick) else {
            return;
        };
        let clients = self.clients.read().await;
        for c in clients.values() {
            if c.lease_expires_at > now && c.fleet {
                let _ = c.tx.send(json.clone());
            }
        }
    }

    pub async fn broadcast_alert_change(&self) {
        let now = now_sec();
        let count = self.db.count_firing_incidents().unwrap_or(0);
        let Ok(json) = serde_json::to_string(&AlertChangeMessage {
            t: "alert_change",
            active_alerts_count: count,
        }) else {
            return;
        };
        let clients = self.clients.read().await;
        for c in clients.values() {
            if c.lease_expires_at > now {
                let _ = c.tx.send(json.clone());
            }
        }
    }

    pub async fn broadcast_node_offline(&self, node_id: &str, last_seen_ts: Option<i64>) {
        let now = now_sec();
        let Ok(json) = serde_json::to_string(&NodeOfflineMessage {
            t: "node_offline",
            node_id: node_id.to_string(),
            last_seen_ts,
        }) else {
            return;
        };
        let clients = self.clients.read().await;
        for c in clients.values() {
            if c.lease_expires_at > now && (c.fleet || c.node_id.as_deref() == Some(node_id)) {
                let _ = c.tx.send(json.clone());
            }
        }
    }

    pub async fn check_offline_nodes(&self) {
        let now = now_sec();
        let Ok(online_nodes) = self.db.list_online_node_heartbeats() else {
            return;
        };
        if online_nodes.is_empty() {
            return;
        }
        let rules = self.db.list_rules().unwrap_or_default();
        let mem_alive = self.agent_last_alive.read().await;

        let mut stale = Vec::new();
        for (node_id, db_last) in online_nodes {
            let effective_last = match (db_last, mem_alive.get(&node_id).copied()) {
                (Some(a), Some(b)) => a.max(b),
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => continue,
            };
            let threshold = get_offline_threshold_sec(&node_id, &rules);
            let elapsed = now - effective_last;
            if elapsed >= threshold {
                stale.push((node_id, effective_last, elapsed));
            }
        }
        drop(mem_alive);

        for (node_id, last_seen, elapsed) in stale {
            let _ = self.db.mark_node_offline(&node_id, now);
            self.disconnect_agent(&node_id, 1001, "Offline watchdog timeout")
                .await;
            if let Ok(Some(node)) = self.db.get_node_row(&node_id) {
                if let Ok(changed) =
                    evaluate_node_offline_alerts(&self.db, &self.http, &node, elapsed, now)
                {
                    if changed {
                        self.broadcast_alert_change().await;
                    }
                }
            }
            self.broadcast_node_offline(&node_id, Some(last_seen)).await;
        }
    }

    pub async fn dispatch_migrate(
        &self,
        req: HubMigrateRequest,
    ) -> Result<HubMigrateResponse, (u16, String)> {
        let allow_insecure = req.allow_insecure_ws && self.cfg.allow_insecure_ws_for_test;
        let target_ws_url = validate_and_normalize_migrate_url(&req.target_url, allow_insecure)
            .map_err(|e| (400, e))?;

        let fallback_ws_url = match req
            .fallback_url
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            Some(fb) => {
                Some(validate_and_normalize_migrate_url(fb, allow_insecure).map_err(|e| (400, e))?)
            }
            None => None,
        };

        let epoch = now_sec();
        let all_nodes = self
            .db
            .with_conn(|c| {
                let mut stmt = c
                    .prepare("SELECT id, token_sha256 FROM nodes")
                    .map_err(|e| format!("read nodes migrate error: {e}"))?;
                let rows = stmt
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                    .map_err(|e| format!("query nodes migrate error: {e}"))?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r.map_err(|e| format!("migrate node row error: {e}"))?);
                }
                Ok(out)
            })
            .map_err(|e| (500, e))?;

        let cleaned_ids: Option<Vec<String>> = req.node_ids.map(|ids| {
            ids.into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        });
        let targets: Vec<(String, String)> = match cleaned_ids {
            Some(ref ids) if !ids.is_empty() => all_nodes
                .into_iter()
                .filter(|(id, _)| ids.iter().any(|wanted| wanted == id))
                .collect(),
            _ => all_nodes,
        };

        let targeted = targets.len();
        let mut dispatched = 0usize;

        for (node_id, token_sha256) in targets {
            let sig = sign_migrate_directive(&token_sha256, &node_id, epoch, &target_ws_url);
            let mut ctrl = self.compute_ctrl_for_node(&node_id, true).await;
            ctrl.migrate = Some(CtrlMigrateDirective {
                url: target_ws_url.clone(),
                fallback_url: fallback_ws_url.clone(),
                epoch,
                sig,
            });
            let agents = self.agents.read().await;
            if let Some(handle) = agents.get(&node_id) {
                if handle.tx.send(AgentOutboundCmd::Ctrl(ctrl)).is_ok() {
                    dispatched += 1;
                }
            }
        }

        Ok(HubMigrateResponse {
            ok: true,
            target_ws_url,
            epoch,
            targeted,
            dispatched,
        })
    }

    pub fn spawn_background_tasks(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                tick.tick().await;
                state.check_offline_nodes().await;
            }
        });
    }
}

pub fn validate_and_normalize_migrate_url(
    raw: &str,
    allow_insecure_ws: bool,
) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("target_url is required".to_string());
    }
    let normalized_input;
    let to_parse = if trimmed.contains("://") {
        trimmed
    } else {
        normalized_input = format!("https://{trimmed}");
        normalized_input.as_str()
    };
    let mut url = Url::parse(to_parse).map_err(|e| format!("Invalid target_url: {e}"))?;
    match url.scheme() {
        "https" => {
            let _ = url.set_scheme("wss");
        }
        "http" => {
            if !allow_insecure_ws {
                return Err("target_url must use https:// or wss://".to_string());
            }
            let _ = url.set_scheme("ws");
        }
        "wss" => {}
        "ws" => {
            if !allow_insecure_ws {
                return Err("target_url must use wss://".to_string());
            }
        }
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }

    if url.path() == "/" || url.path().is_empty() {
        url.set_path("/api/agent/ws");
    }
    url.set_query(None);
    url.set_fragment(None);

    let Some(host) = url.host_str() else {
        return Err("target_url missing host".to_string());
    };
    if !allow_insecure_ws && is_blocked_migrate_host(host) {
        return Err(format!("target_url host '{host}' is blocked by SSRF guard"));
    }

    Ok(url.to_string())
}

fn is_blocked_ipv4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_multicast()
        || v4.is_broadcast()
        || (o[0] == 100 && (64..=127).contains(&o[1]))
}

pub fn is_blocked_migrate_host(host: &str) -> bool {
    let h = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if h.is_empty()
        || h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h == "home.arpa"
        || h.ends_with(".home.arpa")
    {
        return true;
    }
    if let Ok(ip) = h.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(v4) => is_blocked_ipv4(v4),
            IpAddr::V6(v6) => {
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return is_blocked_ipv4(v4);
                }
                let seg0 = v6.segments()[0];
                v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || (seg0 & 0xfe00) == 0xfc00
                    || (seg0 & 0xffc0) == 0xfe80
            }
        }
    } else {
        false
    }
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_url_normalization_and_ssrf_guard() {
        assert_eq!(
            validate_and_normalize_migrate_url("https://hub.example.com", false).unwrap(),
            "wss://hub.example.com/api/agent/ws"
        );
        assert_eq!(
            validate_and_normalize_migrate_url(
                "wss://hub.example.com:8443/custom?foo=1#bar",
                false
            )
            .unwrap(),
            "wss://hub.example.com:8443/custom"
        );
        assert_eq!(
            validate_and_normalize_migrate_url("hub.example.com", false).unwrap(),
            "wss://hub.example.com/api/agent/ws"
        );
        assert_eq!(
            validate_and_normalize_migrate_url("hub.example.com:8443/custom", false).unwrap(),
            "wss://hub.example.com:8443/custom"
        );
        assert!(
            validate_and_normalize_migrate_url("ws://hub.example.com/api/agent/ws", false).is_err()
        );
        assert!(
            validate_and_normalize_migrate_url("wss://127.0.0.1:8787/api/agent/ws", false).is_err()
        );
        assert!(validate_and_normalize_migrate_url("127.0.0.1:8787", false).is_err());
        assert!(
            validate_and_normalize_migrate_url("wss://[::ffff:127.0.0.1]/api/agent/ws", false)
                .is_err()
        );
        assert!(validate_and_normalize_migrate_url(
            "wss://[::ffff:192.168.1.10]/api/agent/ws",
            false
        )
        .is_err());
        assert!(
            validate_and_normalize_migrate_url("wss://192.168.1.10/api/agent/ws", false).is_err()
        );
        assert!(validate_and_normalize_migrate_url("192.168.1.10", false).is_err());
        assert!(validate_and_normalize_migrate_url("wss://10.0.0.1/api/agent/ws", false).is_err());
        assert!(
            validate_and_normalize_migrate_url("wss://169.254.169.254/api/agent/ws", false)
                .is_err()
        );
        assert!(validate_and_normalize_migrate_url("wss://localhost/api/agent/ws", false).is_err());
        assert!(
            validate_and_normalize_migrate_url("wss://localhost./api/agent/ws", false).is_err()
        );
        assert!(
            validate_and_normalize_migrate_url("wss://panel.home.arpa./api/agent/ws", false)
                .is_err()
        );
        assert!(validate_and_normalize_migrate_url("localhost:8080", false).is_err());
        assert!(validate_and_normalize_migrate_url("router.home.arpa", false).is_err());

        assert_eq!(
            validate_and_normalize_migrate_url("http://127.0.0.1:9999", true).unwrap(),
            "ws://127.0.0.1:9999/api/agent/ws"
        );
        assert_eq!(
            validate_and_normalize_migrate_url("127.0.0.1:9999", true).unwrap(),
            "wss://127.0.0.1:9999/api/agent/ws"
        );
    }

    #[tokio::test]
    async fn client_renew_extends_active_lease_without_repushing_ctrl_or_batch() {
        use crate::protocol::ClientInboundMessage;

        let parsed: ClientInboundMessage = serde_json::from_str(r#"{"op":"renew"}"#).unwrap();
        assert!(matches!(parsed, ClientInboundMessage::Renew));

        let db = HubDb::open_in_memory().unwrap();
        let hub = HubState::new(HubConfig::default(), db, reqwest::Client::new());

        let (agent_tx, mut agent_rx) = mpsc::unbounded_channel();
        hub.register_agent("n1", agent_tx).await;

        let (client_tx, mut client_rx) = mpsc::unbounded_channel();
        let client_id = hub.register_client(client_tx).await;

        // Artificially age lease before any subscription; renew should be a no-op when unsubscribed.
        let near_expiry = now_sec() + 5;
        {
            let mut guard = hub.clients.write().await;
            guard.get_mut(&client_id).unwrap().lease_expires_at = near_expiry;
        }
        hub.handle_client_command(client_id, ClientInboundMessage::Renew)
            .await;
        assert_eq!(
            hub.clients
                .read()
                .await
                .get(&client_id)
                .unwrap()
                .lease_expires_at,
            near_expiry
        );
        assert!(client_rx.try_recv().is_err());
        assert!(agent_rx.try_recv().is_err());

        // Subscribe fleet -> emits fleet_batch and pushes ctrl to agent.
        hub.handle_client_command(client_id, ClientInboundMessage::SubFleet)
            .await;
        assert!(client_rx.try_recv().is_ok());
        assert!(agent_rx.try_recv().is_ok());

        // Ping replies pong without extending lease_expires_at.
        {
            let mut guard = hub.clients.write().await;
            guard.get_mut(&client_id).unwrap().lease_expires_at = near_expiry;
        }
        hub.handle_client_command(client_id, ClientInboundMessage::Ping)
            .await;
        assert_eq!(client_rx.try_recv().unwrap(), r#"{"t":"pong"}"#);
        assert_eq!(
            hub.clients
                .read()
                .await
                .get(&client_id)
                .unwrap()
                .lease_expires_at,
            near_expiry
        );

        // Renew while fleet-subscribed extends lease without sending fleet_batch or ctrl.
        hub.handle_client_command(client_id, ClientInboundMessage::Renew)
            .await;
        let extended_fleet = hub
            .clients
            .read()
            .await
            .get(&client_id)
            .unwrap()
            .lease_expires_at;
        assert!(extended_fleet >= now_sec() + CLIENT_LEASE_SEC as i64 - 2);
        assert!(client_rx.try_recv().is_err());
        assert!(agent_rx.try_recv().is_err());

        // UnsubFleet + SubNode -> Renew while node-subscribed also extends without re-pushing ctrl.
        hub.handle_client_command(client_id, ClientInboundMessage::UnsubFleet)
            .await;
        hub.handle_client_command(
            client_id,
            ClientInboundMessage::SubNode {
                node_id: "n1".to_string(),
                proc: false,
            },
        )
        .await;
        while agent_rx.try_recv().is_ok() {}
        {
            let mut guard = hub.clients.write().await;
            guard.get_mut(&client_id).unwrap().lease_expires_at = near_expiry;
        }
        hub.handle_client_command(client_id, ClientInboundMessage::Renew)
            .await;
        let extended_node = hub
            .clients
            .read()
            .await
            .get(&client_id)
            .unwrap()
            .lease_expires_at;
        assert!(extended_node >= now_sec() + CLIENT_LEASE_SEC as i64 - 2);
        assert!(client_rx.try_recv().is_err());
        assert!(agent_rx.try_recv().is_err());
    }
}
