use crate::agent_update::{
    build_signed_directive, compare_semver, normalize_arch, parse_agent_update_status,
    resolve_latest_release, AgentUpdateCache, AgentUpdateConfig, AUTO_DISPATCH_COOLDOWN_SEC,
    DEFAULT_GITHUB_API_BASE, RELEASE_CACHE_TTL_SEC,
};
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
    AgentMetricsFrame, AlertChangeMessage, CtrlMigrateDirective, CtrlUpdateDirective,
    FleetBatchMessage, FleetTickMessage, HubMigrateRequest, HubMigrateResponse, HubStatusResponse,
    LatestRelease, NodeDetailMessage, NodeHardwareInfo, NodeMetricsPayload, NodeOfflineMessage,
    NodeRow, NodeUpdateStatus, ReleaseAssetInfo, WatchdogStatusView,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify, RwLock};
use url::Url;

pub const CLIENT_LEASE_SEC: u64 = 90;
// Current browsers renew every 50s. This threshold also coalesces clients using
// a 20s interval, while allowing refresh before the Agent's 90s lease expires.
const AGENT_LEASE_REFRESH_AFTER: Duration = Duration::from_secs(30);
pub const RAW_SAMPLE_MIN_GAP_SEC: i64 = 25;
pub const WS_CLOSE_SUPERSEDED: u16 = 4000;

#[derive(Debug, Clone)]
pub enum AgentOutboundCmd {
    Ctrl(Box<AgentCtrlFrame>),
    Close(u16, String),
}

#[derive(Clone)]
pub struct AgentSessionHandle {
    pub conn_id: u64,
    pub tx: mpsc::UnboundedSender<AgentOutboundCmd>,
    pub capabilities: Vec<String>,
    last_ctrl_at: Option<Instant>,
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
    pub self_probe_notify: Arc<Notify>,
    github_api_base: String,
    agent_update_cache: Arc<RwLock<AgentUpdateCache>>,
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
            self_probe_notify: Arc::new(Notify::new()),
            github_api_base: DEFAULT_GITHUB_API_BASE.to_string(),
            agent_update_cache: Arc::new(RwLock::new(AgentUpdateCache::default())),
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

    pub fn with_github_api_base(mut self, base: String) -> Self {
        self.github_api_base = base;
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
                last_ctrl_at: None,
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
        self.compute_ctrl_for_node_at(node_id, flush_now, now_sec())
            .await
    }

    async fn compute_ctrl_for_node_at(
        &self,
        node_id: &str,
        flush_now: bool,
        now: i64,
    ) -> AgentCtrlFrame {
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
            update: None,
            network_quality: if self
                .agents
                .read()
                .await
                .get(node_id)
                .is_some_and(|a| a.capabilities.iter().any(|c| c == "network_quality_v1"))
            {
                self.db.network_control(node_id).ok()
            } else {
                None
            },
        }
    }

    pub async fn push_ctrl_to_agent(&self, node_id: &str, flush_now: bool) {
        if node_id == self.cfg.self_probe_node_id {
            self.self_probe_notify.notify_one();
        }
        let ctrl = self.compute_ctrl_for_node(node_id, flush_now).await;
        self.send_ctrl_to_agent(node_id, None, ctrl).await;
    }

    pub async fn send_ctrl_to_agent(
        &self,
        node_id: &str,
        conn_id: Option<u64>,
        ctrl: AgentCtrlFrame,
    ) -> bool {
        self.queue_ctrl_at(node_id, conn_id, ctrl, Instant::now(), false)
            .await
    }

    async fn queue_ctrl_at(
        &self,
        node_id: &str,
        conn_id: Option<u64>,
        ctrl: AgentCtrlFrame,
        at: Instant,
        lease_refresh: bool,
    ) -> bool {
        let mut guard = self.agents.write().await;
        let Some(handle) = guard.get_mut(node_id) else {
            return false;
        };
        if conn_id.is_some_and(|id| id != handle.conn_id) {
            return false;
        }
        if lease_refresh
            && handle
                .last_ctrl_at
                .is_some_and(|last| at.saturating_duration_since(last) < AGENT_LEASE_REFRESH_AFTER)
        {
            return false;
        }
        let active_lease = ctrl.mode > 0 && ctrl.lease_sec > 0;
        if handle
            .tx
            .send(AgentOutboundCmd::Ctrl(Box::new(ctrl)))
            .is_err()
        {
            return false;
        }
        handle.last_ctrl_at = active_lease.then_some(at);
        true
    }

    async fn renew_client_lease_at(&self, client_id: u64, now: i64, at: Instant) {
        let subscription = {
            let mut clients = self.clients.write().await;
            clients.get_mut(&client_id).and_then(|client| {
                if !client.fleet && client.node_id.is_none() {
                    return None;
                }
                client.lease_expires_at = now + CLIENT_LEASE_SEC as i64;
                Some((client.fleet, client.node_id.clone()))
            })
        };
        let Some((fleet, node_id)) = subscription else {
            return;
        };
        let targets: Vec<(String, u64)> = self
            .agents
            .read()
            .await
            .iter()
            .filter(|(id, handle)| {
                (fleet || node_id.as_ref() == Some(*id))
                    && handle.last_ctrl_at.is_none_or(|last| {
                        at.saturating_duration_since(last) >= AGENT_LEASE_REFRESH_AFTER
                    })
            })
            .map(|(id, handle)| (id.clone(), handle.conn_id))
            .collect();
        for (id, conn_id) in targets {
            let mut ctrl = self.compute_ctrl_for_node_at(&id, false, now).await;
            ctrl.network_quality = None;
            if ctrl.mode > 0 {
                // Recheck under the sender lock: concurrent viewers must share
                // one lease renewal, and a replaced connection gets a fresh clock.
                self.queue_ctrl_at(&id, Some(conn_id), ctrl, at, true).await;
            }
        }
    }

    pub async fn sync_ctrl_to_all_agents(&self, flush_now: bool) {
        self.self_probe_notify.notify_one();
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
                self.renew_client_lease_at(client_id, now, Instant::now())
                    .await;
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
                                caps: Some(s.caps),
                                auto_update_override: s.auto_update_override,
                                update_status: s.update_status,
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
            self.set_agent_capabilities(node_id, cid, hello.capabilities.clone())
                .await;
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
        self.db
            .update_node_hello_with_caps(node_id, &hw, &hello.capabilities, now)?;
        self.db.network_set_supported(
            node_id,
            hello.capabilities.iter().any(|c| c == "network_quality_v1"),
        )?;

        if let Some(node) = self.db.get_node_row(node_id)? {
            if let Some(ref json_str) = node.update_status_json {
                if let Ok(st) = serde_json::from_str::<NodeUpdateStatus>(json_str) {
                    let ver_trimmed = hello.agent_ver.trim();
                    if st.state != "idle"
                        && !ver_trimmed.is_empty()
                        && st.target_version.as_deref().is_some_and(|tv| {
                            compare_semver(ver_trimmed, tv) != std::cmp::Ordering::Less
                        })
                    {
                        let settled = NodeUpdateStatus {
                            state: "idle".to_string(),
                            target_version: Some(ver_trimmed.to_string()),
                            error: None,
                            updated_at: Some(now),
                        };
                        self.db.set_node_update_status(node_id, Some(&settled))?;
                        self.clear_node_dispatch_cooldown(node_id).await;
                    }
                }
            }
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
                caps: Some(summary.caps),
                auto_update_override: summary.auto_update_override,
                update_status: summary.update_status,
            })
            .await;
        }

        let cfg = self.db.agent_update_config()?;
        let mut ctrl = self.compute_ctrl_for_node(node_id, false).await;
        if let Ok(Some(node)) = self.db.get_node_row(node_id) {
            let target = UpdateTargetNode::from_node_row(&node, &hello.capabilities);
            if let Some(directive) = self
                .auto_directive_for_node_if_due(&target, &cfg, now)
                .await
            {
                ctrl.update = Some(directive);
            }
        }
        Ok(ctrl)
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
        let update_status = frame
            .upd
            .as_ref()
            .and_then(|v| parse_agent_update_status(v, wall_sec));
        if let Some(ref st) = update_status {
            self.db.set_node_update_status(node_id, Some(st))?;
        }
        let mut payload = NodeMetricsPayload::from(&frame);
        payload.network_quality =
            self.accept_network_quality(node_id, frame.network_quality.as_ref(), wall_sec);
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
            update_status,
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

        let update_status = batch
            .upd
            .as_ref()
            .or(batch.last.upd.as_ref())
            .and_then(|v| parse_agent_update_status(v, wall_sec));
        if let Some(ref st) = update_status {
            self.db.set_node_update_status(node_id, Some(st))?;
        }

        let mut latest_payload = NodeMetricsPayload::from(&batch.last);
        latest_payload.network_quality =
            self.accept_network_quality(node_id, batch.network_quality.as_ref(), wall_sec);
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
            update_status,
            was_offline,
            wall_sec,
        )
        .await
    }

    fn accept_network_quality(
        &self,
        node_id: &str,
        extension: Option<&serde_json::Value>,
        wall_sec: i64,
    ) -> Option<crate::network_quality::State> {
        if let Some(value) = extension {
            if let Ok(state) = self
                .db
                .ingest_network_quality(node_id, value, wall_sec as u64)
            {
                return Some(state);
            }
        }
        self.db.network_state(node_id).ok()
    }

    #[allow(clippy::too_many_arguments)]
    async fn after_metrics_persisted(
        &self,
        node: &NodeRow,
        traffic: &crate::protocol::NodeTrafficSummary,
        payload: &NodeMetricsPayload,
        procs: Option<Vec<crate::protocol::AgentProcEntry>>,
        update_status: Option<NodeUpdateStatus>,
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

        self.broadcast_live_update(
            &node.id,
            wall_sec,
            traffic.clone(),
            payload.clone(),
            procs,
            update_status,
        )
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
        update_status: Option<NodeUpdateStatus>,
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
            caps: None,
            auto_update_override: None,
            update_status,
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
            let ctrl = {
                let mut ctrl = self.compute_ctrl_for_node(&node_id, true).await;
                ctrl.migrate = Some(CtrlMigrateDirective {
                    url: target_ws_url.clone(),
                    fallback_url: fallback_ws_url.clone(),
                    epoch,
                    sig,
                });
                ctrl
            };
            if self.send_ctrl_to_agent(&node_id, None, ctrl).await {
                dispatched += 1;
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

    pub fn default_hub_origin(&self) -> String {
        let pub_url = self.cfg.public_url.trim().trim_end_matches('/');
        if !pub_url.is_empty() {
            return pub_url.to_string();
        }
        let listen = self.cfg.listen.trim();
        if let Some(port) = listen.strip_prefix("0.0.0.0:") {
            format!("http://127.0.0.1:{port}")
        } else if let Some(port) = listen.strip_prefix("[::]:") {
            format!("http://127.0.0.1:{port}")
        } else if !listen.is_empty() {
            format!("http://{listen}")
        } else {
            String::new()
        }
    }

    pub async fn cached_agent_update_snapshot(
        &self,
    ) -> (Option<LatestRelease>, Option<i64>, Option<String>) {
        let guard = self.agent_update_cache.read().await;
        (
            guard.latest.clone(),
            guard.checked_at,
            guard.last_error.clone(),
        )
    }

    pub async fn invalidate_agent_update_cache(&self) {
        let mut guard = self.agent_update_cache.write().await;
        guard.latest = None;
        guard.checked_at = None;
        guard.last_error = None;
        guard.dispatched_versions.clear();
    }

    pub async fn clear_node_dispatch_cooldown(&self, node_id: &str) {
        self.agent_update_cache
            .write()
            .await
            .dispatched_versions
            .remove(node_id);
    }

    pub async fn check_latest_release(&self, origin: &str) -> Result<LatestRelease, String> {
        let cfg = self.db.agent_update_config()?;
        let effective_origin = if origin.trim().is_empty() {
            self.default_hub_origin()
        } else {
            origin.trim().trim_end_matches('/').to_string()
        };
        match resolve_latest_release(
            &self.http,
            &cfg,
            &self.cfg.releases_dir,
            &self.github_api_base,
            &self.cfg.github_repo,
            &effective_origin,
        )
        .await
        {
            Ok(release) => {
                let mut guard = self.agent_update_cache.write().await;
                guard.latest = Some(release.clone());
                guard.checked_at = Some(release.checked_at);
                guard.last_error = None;
                Ok(release)
            }
            Err(err) => {
                let mut guard = self.agent_update_cache.write().await;
                guard.checked_at = Some(now_sec());
                guard.last_error = Some(err.clone());
                Err(err)
            }
        }
    }

    fn load_update_target_nodes(&self) -> Result<Vec<UpdateTargetNode>, String> {
        self.db.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT id, token_sha256, arch, agent_version, auto_update_override, caps_json, update_status_json
                     FROM nodes
                     ORDER BY sort_order ASC, created_at ASC",
                )
                .map_err(|e| format!("prepare update target nodes error: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    let caps_json: String = r.get(5)?;
                    let update_status_json: Option<String> = r.get(6)?;
                    let caps = serde_json::from_str::<Vec<String>>(&caps_json).unwrap_or_default();
                    let update_status = update_status_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str::<NodeUpdateStatus>(s).ok());
                    Ok(UpdateTargetNode {
                        id: r.get(0)?,
                        token_sha256: r.get(1)?,
                        arch: r.get(2)?,
                        agent_version: r.get(3)?,
                        auto_update_override: r.get(4)?,
                        caps,
                        update_status,
                    })
                })
                .map_err(|e| format!("query update target nodes error: {e}"))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| format!("read update target node row error: {e}"))?);
            }
            Ok(out)
        })
    }

    async fn auto_directive_for_node_if_due(
        &self,
        node: &UpdateTargetNode,
        cfg: &AgentUpdateConfig,
        now: i64,
    ) -> Option<CtrlUpdateDirective> {
        if node.id == self.cfg.self_probe_node_id {
            return None;
        }
        if !node.caps.iter().any(|c| c == "auto_update_v1") {
            return None;
        }
        let effective_enabled = node
            .auto_update_override
            .map(|v| v != 0)
            .unwrap_or(cfg.auto_update_enabled);
        if !effective_enabled {
            return None;
        }

        let current_ver = node
            .agent_version
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        let release = {
            let guard = self.agent_update_cache.read().await;
            guard.latest.clone()?
        };
        if compare_semver(current_ver, &release.version) != std::cmp::Ordering::Less {
            return None;
        }
        let asset = release_asset_for_arch(&release, node.arch.as_deref())?;
        if let Some(ref st) = node.update_status {
            if matches!(st.state.as_str(), "downloading" | "staged" | "applying")
                && st.target_version.as_deref() == Some(release.version.as_str())
            {
                return None;
            }
        }

        let mut guard = self.agent_update_cache.write().await;
        if guard
            .dispatched_versions
            .get(&node.id)
            .is_some_and(|(ver, ts)| {
                ver == &release.version && now.saturating_sub(*ts) < AUTO_DISPATCH_COOLDOWN_SEC
            })
        {
            return None;
        }
        guard
            .dispatched_versions
            .insert(node.id.clone(), (release.version.clone(), now));

        Some(build_signed_directive(
            &node.token_sha256,
            &node.id,
            &release.version,
            asset,
            now as u64,
        ))
    }

    pub async fn trigger_agent_update(
        &self,
        node_ids: Option<Vec<String>>,
        force: bool,
        origin: &str,
    ) -> Result<Value, (u16, String)> {
        let now = now_sec();
        let release = match self.check_latest_release(origin).await {
            Ok(rel) => rel,
            Err(err) => {
                if let Some(cached) = self.cached_agent_update_snapshot().await.0 {
                    cached
                } else {
                    return Err((502, err));
                }
            }
        };

        let all_nodes = self.load_update_target_nodes().map_err(|e| (500, e))?;
        let cleaned_ids: Option<Vec<String>> = node_ids.map(|ids| {
            ids.into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        });
        let targets: Vec<UpdateTargetNode> = match cleaned_ids {
            Some(ref ids) if !ids.is_empty() => all_nodes
                .into_iter()
                .filter(|n| ids.iter().any(|wanted| wanted == &n.id))
                .collect(),
            _ => all_nodes
                .into_iter()
                .filter(|n| n.id != self.cfg.self_probe_node_id)
                .collect(),
        };

        let targeted = targets.len();
        let mut dispatched = 0usize;
        let mut skipped = 0usize;

        for node in targets {
            if node.id == self.cfg.self_probe_node_id {
                skipped += 1;
                continue;
            }
            let live_caps = {
                let guard = self.agents.read().await;
                guard.get(&node.id).map(|h| h.capabilities.clone())
            };
            let Some(caps) = live_caps else {
                skipped += 1;
                continue;
            };
            if !caps.iter().any(|c| c == "auto_update_v1") {
                skipped += 1;
                continue;
            }
            let Some(asset) = release_asset_for_arch(&release, node.arch.as_deref()) else {
                skipped += 1;
                continue;
            };
            if !force {
                if node.auto_update_override == Some(0) {
                    skipped += 1;
                    continue;
                }
                let newer = node
                    .agent_version
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some_and(|cur| {
                        compare_semver(cur, &release.version) == std::cmp::Ordering::Less
                    });
                if !newer {
                    skipped += 1;
                    continue;
                }
            }

            let directive = build_signed_directive(
                &node.token_sha256,
                &node.id,
                &release.version,
                asset,
                now as u64,
            );
            let mut ctrl = self.compute_ctrl_for_node(&node.id, true).await;
            ctrl.update = Some(directive);
            if self.send_ctrl_to_agent(&node.id, None, ctrl).await {
                self.agent_update_cache
                    .write()
                    .await
                    .dispatched_versions
                    .insert(node.id.clone(), (release.version.clone(), now));
                dispatched += 1;
            } else {
                skipped += 1;
            }
        }

        Ok(json!({
            "ok": true,
            "version": release.version,
            "targeted": targeted,
            "dispatched": dispatched,
            "skipped": skipped,
        }))
    }

    pub async fn maybe_dispatch_auto_updates(&self, origin: &str) {
        let Ok(cfg) = self.db.agent_update_config() else {
            return;
        };
        let Ok(nodes) = self.load_update_target_nodes() else {
            return;
        };
        if !cfg.auto_update_enabled && !nodes.iter().any(|n| n.auto_update_override == Some(1)) {
            return;
        }

        let now = now_sec();
        let needs_refresh = {
            let guard = self.agent_update_cache.read().await;
            match (&guard.latest, guard.checked_at) {
                (Some(_), Some(ts)) => now.saturating_sub(ts) >= cfg.check_interval_sec as i64,
                (None, Some(ts)) => {
                    let retry_ttl = (cfg.check_interval_sec as i64).min(RELEASE_CACHE_TTL_SEC);
                    now.saturating_sub(ts) >= retry_ttl
                }
                (_, None) => true,
            }
        };
        if needs_refresh {
            let _ = self.check_latest_release(origin).await;
        }

        let live_caps: HashMap<String, Vec<String>> = {
            let guard = self.agents.read().await;
            guard
                .iter()
                .map(|(id, h)| (id.clone(), h.capabilities.clone()))
                .collect()
        };

        for mut node in nodes {
            let Some(caps) = live_caps.get(&node.id) else {
                continue;
            };
            node.caps = caps.clone();
            if let Some(directive) = self.auto_directive_for_node_if_due(&node, &cfg, now).await {
                let mut ctrl = self.compute_ctrl_for_node(&node.id, true).await;
                ctrl.update = Some(directive);
                let _ = self.send_ctrl_to_agent(&node.id, None, ctrl).await;
            }
        }
    }

    pub fn spawn_background_tasks(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(15));
            let mut update_tick: u64 = 0;
            loop {
                tick.tick().await;
                state.check_offline_nodes().await;
                if update_tick.is_multiple_of(4) {
                    let origin = state.default_hub_origin();
                    state.maybe_dispatch_auto_updates(&origin).await;
                }
                update_tick = update_tick.wrapping_add(1);
            }
        });
    }
}

struct UpdateTargetNode {
    id: String,
    token_sha256: String,
    arch: Option<String>,
    agent_version: Option<String>,
    auto_update_override: Option<i64>,
    caps: Vec<String>,
    update_status: Option<NodeUpdateStatus>,
}

impl UpdateTargetNode {
    fn from_node_row(row: &NodeRow, caps: &[String]) -> Self {
        let update_status = row
            .update_status_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<NodeUpdateStatus>(s).ok());
        Self {
            id: row.id.clone(),
            token_sha256: row.token_sha256.clone(),
            arch: row.arch.clone(),
            agent_version: row.agent_version.clone(),
            auto_update_override: row.auto_update_override,
            caps: caps.to_vec(),
            update_status,
        }
    }
}

fn release_asset_for_arch<'a>(
    release: &'a LatestRelease,
    arch: Option<&str>,
) -> Option<&'a ReleaseAssetInfo> {
    match normalize_arch(arch)? {
        "amd64" => release.assets.amd64.as_ref(),
        "arm64" => release.assets.arm64.as_ref(),
        _ => None,
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

    fn take_ctrl(rx: &mut mpsc::UnboundedReceiver<AgentOutboundCmd>) -> AgentCtrlFrame {
        match rx.try_recv().unwrap() {
            AgentOutboundCmd::Ctrl(ctrl) => *ctrl,
            other => panic!("Expected ctrl, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn repeated_renew_keeps_agent_live_beyond_ninety_seconds_without_flush_or_quality_config()
    {
        use crate::protocol::ClientInboundMessage;
        for interval in [20u64, 50] {
            let hub = HubState::new(
                HubConfig::default(),
                HubDb::open_in_memory().unwrap(),
                reqwest::Client::new(),
            );
            let (agent_tx, mut agent_rx) = mpsc::unbounded_channel();
            let conn = hub.register_agent("watched", agent_tx).await;
            hub.set_agent_capabilities("watched", conn, vec!["network_quality_v1".into()])
                .await;
            let (other_tx, mut other_rx) = mpsc::unbounded_channel();
            hub.register_agent("unwatched", other_tx).await;
            let (client_tx, mut client_rx) = mpsc::unbounded_channel();
            let client = hub.register_client(client_tx).await;
            hub.handle_client_command(
                client,
                ClientInboundMessage::SubNode {
                    node_id: "watched".into(),
                    proc: true,
                },
            )
            .await;
            let initial = take_ctrl(&mut agent_rx);
            assert_eq!(initial.mode, 2);
            assert_eq!(initial.flush_now, Some(true));
            assert!(initial.network_quality.is_some());
            let start = hub
                .agents
                .read()
                .await
                .get("watched")
                .unwrap()
                .last_ctrl_at
                .unwrap();
            let wall = now_sec();
            let mut last_refresh = 0;
            for tick in 1..=10 {
                let elapsed = tick * interval;
                // Simulate the Agent's deadline as well as both Hub clocks.
                assert!(elapsed < last_refresh + CLIENT_LEASE_SEC);
                hub.renew_client_lease_at(
                    client,
                    wall + elapsed as i64,
                    start + Duration::from_secs(elapsed),
                )
                .await;
                if elapsed - last_refresh >= AGENT_LEASE_REFRESH_AFTER.as_secs() {
                    let ctrl = take_ctrl(&mut agent_rx);
                    assert_eq!(ctrl.mode, 2);
                    assert_eq!(ctrl.interval_ms, 2000);
                    assert_eq!(ctrl.lease_sec, CLIENT_LEASE_SEC);
                    assert!(ctrl.flush_now.is_none());
                    assert!(ctrl.network_quality.is_none());
                    assert!(ctrl.migrate.is_none());
                    last_refresh = elapsed;
                }
                assert!(agent_rx.try_recv().is_err());
                assert!(other_rx.try_recv().is_err());
                assert!(client_rx.try_recv().is_err());
            }
            assert!(last_refresh > CLIENT_LEASE_SEC);
            hub.handle_client_command(client, ClientInboundMessage::UnsubNode { node_id: None })
                .await;
            assert_eq!(take_ctrl(&mut agent_rx).mode, 0);
            let prior_expiry = hub
                .clients
                .read()
                .await
                .get(&client)
                .unwrap()
                .lease_expires_at;
            hub.renew_client_lease_at(client, wall + 1000, start + Duration::from_secs(1000))
                .await;
            assert_eq!(
                hub.clients
                    .read()
                    .await
                    .get(&client)
                    .unwrap()
                    .lease_expires_at,
                prior_expiry
            );
            assert!(agent_rx.try_recv().is_err());
        }
    }

    #[tokio::test]
    async fn concurrent_fleet_renewals_share_one_refresh_and_normal_ctrl_resets_the_clock() {
        use crate::protocol::ClientInboundMessage;
        let hub = HubState::new(
            HubConfig::default(),
            HubDb::open_in_memory().unwrap(),
            reqwest::Client::new(),
        );
        let (agent_tx, mut agent_rx) = mpsc::unbounded_channel();
        let conn = hub.register_agent("n1", agent_tx).await;
        let (other_tx, mut other_rx) = mpsc::unbounded_channel();
        hub.register_agent("n2", other_tx).await;
        let (client_tx, mut client_rx) = mpsc::unbounded_channel();
        let first = hub.register_client(client_tx).await;
        let (second_tx, mut second_rx) = mpsc::unbounded_channel();
        let second = hub.register_client(second_tx).await;
        hub.handle_client_command(first, ClientInboundMessage::SubFleet)
            .await;
        hub.handle_client_command(second, ClientInboundMessage::SubFleet)
            .await;
        while agent_rx.try_recv().is_ok() {}
        while other_rx.try_recv().is_ok() {}
        while client_rx.try_recv().is_ok() {}
        while second_rx.try_recv().is_ok() {}
        let start = Instant::now();
        let wall = now_sec();
        let ctrl = hub.compute_ctrl_for_node("n1", false).await;
        assert!(
            hub.queue_ctrl_at(
                "n1",
                Some(conn),
                ctrl.clone(),
                start + Duration::from_secs(25),
                false
            )
            .await
        );
        take_ctrl(&mut agent_rx);
        hub.renew_client_lease_at(first, wall + 50, start + Duration::from_secs(50))
            .await;
        assert!(agent_rx.try_recv().is_err()); // The config/control update is only 25s old.
        assert_eq!(take_ctrl(&mut other_rx).interval_ms, 10000);
        tokio::join!(
            hub.renew_client_lease_at(first, wall + 100, start + Duration::from_secs(100)),
            hub.renew_client_lease_at(second, wall + 100, start + Duration::from_secs(100))
        );
        for rx in [&mut agent_rx, &mut other_rx] {
            let refreshed = take_ctrl(rx);
            assert_eq!(refreshed.mode, 1);
            assert_eq!(refreshed.interval_ms, 10000);
            assert_eq!(refreshed.lease_sec, 90);
            assert!(refreshed.flush_now.is_none());
            assert!(refreshed.network_quality.is_none());
            assert!(rx.try_recv().is_err());
        }
        assert!(client_rx.try_recv().is_err());
        assert!(second_rx.try_recv().is_err());

        // A superseded socket cannot send or reset the replacement's lease clock.
        let (new_tx, mut new_rx) = mpsc::unbounded_channel();
        let replacement = hub.register_agent("n1", new_tx).await;
        assert!(!hub.send_ctrl_to_agent("n1", Some(conn), ctrl.clone()).await);
        assert!(new_rx.try_recv().is_err());
        assert!(
            hub.send_ctrl_to_agent("n1", Some(replacement), ctrl.clone())
                .await
        );
        take_ctrl(&mut new_rx);
        let fresh = hub.agents.read().await.get("n1").unwrap().last_ctrl_at;
        drop(new_rx);
        assert!(
            !hub.queue_ctrl_at(
                "n1",
                Some(replacement),
                ctrl,
                start + Duration::from_secs(500),
                false
            )
            .await
        );
        assert_eq!(
            hub.agents.read().await.get("n1").unwrap().last_ctrl_at,
            fresh
        );
    }
}
