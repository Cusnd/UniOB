use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type CompactMetricTuple = [f64; 16];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHelloFrame {
    #[serde(default)]
    pub v: u8,
    #[serde(default)]
    pub agent_ver: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub kernel: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub cpu_model: String,
    #[serde(default)]
    pub cpu_cores: u32,
    #[serde(default)]
    pub mem_total: u64,
    #[serde(default)]
    pub swap_total: u64,
    #[serde(default)]
    pub boot_time: u64,
    #[serde(default)]
    pub proc_enabled: bool,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub migrated_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDiskEntry {
    pub mp: String,
    pub fs: String,
    pub total: u64,
    pub used: u64,
    pub r_bps: u64,
    pub w_bps: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProcEntry {
    pub pid: u32,
    pub user: String,
    pub comm: String,
    pub st: String,
    pub cpu: f64,
    pub rss: u64,
    pub thr: u32,
    pub cmd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuMetrics {
    pub all: f64,
    #[serde(default)]
    pub cores: Vec<f64>,
    pub steal: f64,
    pub iowait: f64,
    #[serde(default)]
    pub load: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemMetrics {
    pub used: u64,
    pub avail: u64,
    pub cached: u64,
    pub swap_used: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetMetrics {
    pub rx_bps: u64,
    pub tx_bps: u64,
    pub rx_tot: u64,
    pub tx_tot: u64,
    pub tcp_est: u32,
    pub tcp_tw: u32,
    pub udp: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMetricsPayload {
    pub ts: u64,
    pub up: u64,
    pub cpu: CpuMetrics,
    pub mem: MemMetrics,
    #[serde(default)]
    pub disks: Vec<AgentDiskEntry>,
    pub net: NetMetrics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_quality: Option<crate::network_quality::State>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMetricsFrame {
    pub ts: u64,
    pub up: u64,
    pub cpu: CpuMetrics,
    pub mem: MemMetrics,
    #[serde(default)]
    pub disks: Vec<AgentDiskEntry>,
    pub net: NetMetrics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub procs: Option<Vec<AgentProcEntry>>,
    // Decode the optional extension independently so malformed data cannot drop resource metrics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_quality: Option<serde_json::Value>,
}

impl From<&AgentMetricsFrame> for NodeMetricsPayload {
    fn from(f: &AgentMetricsFrame) -> Self {
        Self {
            ts: f.ts,
            up: f.up,
            cpu: f.cpu.clone(),
            mem: f.mem.clone(),
            disks: f.disks.clone(),
            net: f.net.clone(),
            network_quality: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMetricsBatchFrame {
    #[serde(default = "default_v2")]
    pub v: u8,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub pts: Vec<CompactMetricTuple>,
    pub last: AgentMetricsFrame,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_quality: Option<serde_json::Value>,
}

fn default_v2() -> u8 {
    2
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub enum AgentInboundFrame {
    #[serde(rename = "hello")]
    Hello(AgentHelloFrame),
    #[serde(rename = "m")]
    Metrics(AgentMetricsFrame),
    #[serde(rename = "mb")]
    MetricsBatch(AgentMetricsBatchFrame),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CtrlWatermarks {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steal: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk: Option<f64>,
}

impl CtrlWatermarks {
    pub fn is_empty(&self) -> bool {
        self.cpu.is_none()
            && self.steal.is_none()
            && self.mem.is_none()
            && self.swap.is_none()
            && self.disk.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CtrlMigrateDirective {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_url: Option<String>,
    pub epoch: i64,
    pub sig: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentCtrlFrame {
    pub t: &'static str,
    pub mode: u8,
    pub interval_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_sec: Option<u64>,
    pub top_n: u16,
    pub lease_sec: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flush_now: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watermarks: Option<CtrlWatermarks>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migrate: Option<CtrlMigrateDirective>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_quality: Option<crate::network_quality::Control>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRow {
    pub id: String,
    pub name: String,
    #[serde(default = "default_group_name")]
    pub group_name: String,
    #[serde(default = "default_empty_array_json")]
    pub tags_json: String,
    #[serde(default)]
    pub sort_order: i64,
    pub token_sha256: String,
    #[serde(default)]
    pub traffic_limit_bytes: Option<i64>,
    #[serde(default = "default_reset_day")]
    pub traffic_reset_day: i64,
    #[serde(default = "default_count_mode")]
    pub traffic_count_mode: String,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub kernel: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub cpu_model: Option<String>,
    #[serde(default)]
    pub cpu_cores: Option<i64>,
    #[serde(default)]
    pub mem_total: Option<i64>,
    #[serde(default)]
    pub swap_total: Option<i64>,
    #[serde(default)]
    pub agent_version: Option<String>,
    #[serde(default = "default_one")]
    pub proc_enabled: i64,
    #[serde(default)]
    pub mute_until: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_group_name() -> String {
    "Default".to_string()
}

fn default_empty_array_json() -> String {
    "[]".to_string()
}

fn default_reset_day() -> i64 {
    1
}

fn default_count_mode() -> String {
    "both".to_string()
}

fn default_one() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeHardwareInfo {
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub arch: Option<String>,
    pub cpu_model: Option<String>,
    pub cpu_cores: Option<i64>,
    pub mem_total: Option<i64>,
    pub swap_total: Option<i64>,
    pub agent_version: Option<String>,
    pub proc_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeTrafficSummary {
    pub limit_bytes: Option<i64>,
    pub reset_day: i64,
    pub count_mode: String,
    pub cycle_key: String,
    pub rx_bytes: i64,
    pub tx_bytes: i64,
    pub counted_bytes: i64,
    pub days_remaining: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSummary {
    pub id: String,
    pub name: String,
    pub group_name: String,
    pub tags: Vec<String>,
    pub sort_order: i64,
    pub mute_until: Option<i64>,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub arch: Option<String>,
    pub cpu_model: Option<String>,
    pub cpu_cores: Option<i64>,
    pub mem_total: Option<i64>,
    pub swap_total: Option<i64>,
    pub agent_version: Option<String>,
    pub proc_enabled: bool,
    pub online: bool,
    pub last_seen_ts: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub traffic: NodeTrafficSummary,
    pub metrics: Option<NodeMetricsPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsQueryPoint {
    pub ts: i64,
    pub cpu: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_max: Option<f64>,
    pub steal: f64,
    pub load1: f64,
    pub mem_used: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_max: Option<f64>,
    pub swap_used: f64,
    pub disk_used: f64,
    pub disk_r_bps: f64,
    pub disk_w_bps: f64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub tcp_est: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsQueryResponse {
    pub node_id: String,
    pub range: String,
    pub resolution: String,
    pub points: Vec<MetricsQueryPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationChannelRow {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub enabled: i64,
    pub config_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationChannelView {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub enabled: bool,
    pub config: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertRuleRow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub node_id: Option<String>,
    pub metric: String,
    #[serde(default = "default_operator")]
    pub operator: String,
    pub threshold: f64,
    #[serde(default = "default_duration_sec")]
    pub duration_sec: i64,
    #[serde(default = "default_cooldown_sec", alias = "renotify_sec")]
    pub cooldown_sec: i64,
    #[serde(default = "default_empty_array_json")]
    pub channel_ids_json: String,
    #[serde(default = "default_one")]
    pub enabled: i64,
    #[serde(default)]
    pub created_at: i64,
}

fn default_operator() -> String {
    "gt".to_string()
}

fn default_duration_sec() -> i64 {
    60
}

fn default_cooldown_sec() -> i64 {
    300
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertRuleView {
    pub id: String,
    pub name: String,
    pub node_id: Option<String>,
    pub metric: String,
    pub operator: String,
    pub threshold: f64,
    pub duration_sec: i64,
    pub cooldown_sec: i64,
    pub channel_ids: Vec<String>,
    pub enabled: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertIncidentRow {
    pub id: String,
    pub node_id: String,
    pub node_name: String,
    pub rule_id: String,
    pub metric: String,
    pub status: String,
    pub trigger_value: Option<f64>,
    pub threshold: Option<f64>,
    pub message: String,
    pub started_at: i64,
    pub resolved_at: Option<i64>,
    pub last_notified_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op")]
pub enum ClientInboundMessage {
    #[serde(rename = "sub_fleet")]
    SubFleet,
    #[serde(rename = "unsub_fleet")]
    UnsubFleet,
    #[serde(rename = "sub_node")]
    SubNode {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(default)]
        proc: bool,
    },
    #[serde(rename = "unsub_node")]
    UnsubNode {
        #[serde(rename = "nodeId", default)]
        node_id: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "renew")]
    Renew,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FleetTickMessage {
    pub t: &'static str,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub online: bool,
    pub last_seen_ts: Option<i64>,
    pub traffic: NodeTrafficSummary,
    pub metrics: Option<NodeMetricsPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hardware: Option<NodeHardwareInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FleetBatchMessage {
    pub t: &'static str,
    pub ticks: Vec<FleetTickMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeDetailMessage {
    pub t: &'static str,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub online: bool,
    pub ts: u64,
    pub metrics: NodeMetricsPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub procs: Option<Vec<AgentProcEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeOfflineMessage {
    pub t: &'static str,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub last_seen_ts: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertChangeMessage {
    pub t: &'static str,
    #[serde(rename = "activeAlertsCount")]
    pub active_alerts_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchdogStatusView {
    pub enabled: bool,
    pub last_ping_ts: Option<i64>,
    pub status: String,
    pub timeout_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubStatusResponse {
    pub mode: &'static str,
    pub version: String,
    pub connected_agents: usize,
    pub total_nodes: usize,
    pub watchdog: WatchdogStatusView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSystemSettingEntry {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportTrafficLedgerEntry {
    pub node_id: String,
    #[serde(alias = "cycle")]
    pub cycle_key: String,
    #[serde(default, alias = "rx_last")]
    pub last_agent_rx: i64,
    #[serde(default, alias = "tx_last")]
    pub last_agent_tx: i64,
    #[serde(default, alias = "rx_used")]
    pub cycle_rx_bytes: i64,
    #[serde(default, alias = "tx_used")]
    pub cycle_tx_bytes: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportBundle {
    pub version: u32,
    pub exported_at: i64,
    pub nodes: Vec<NodeRow>,
    pub notification_channels: Vec<NotificationChannelRow>,
    pub alert_rules: Vec<AlertRuleRow>,
    pub system_settings: Vec<ExportSystemSettingEntry>,
    pub traffic_ledgers: Vec<ExportTrafficLedgerEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SystemSettingMapValue {
    Plain(String),
    Obj {
        value: String,
        #[serde(default)]
        updated_at: Option<i64>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ImportSystemSettingsInput {
    List(Vec<ExportSystemSettingEntry>),
    Map(HashMap<String, SystemSettingMapValue>),
}

impl Default for ImportSystemSettingsInput {
    fn default() -> Self {
        Self::List(Vec::new())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ImportTrafficLedgersInput {
    List(Vec<ExportTrafficLedgerEntry>),
    Map(HashMap<String, ExportTrafficLedgerEntryNoId>),
}

impl Default for ImportTrafficLedgersInput {
    fn default() -> Self {
        Self::List(Vec::new())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportTrafficLedgerEntryNoId {
    #[serde(alias = "cycle")]
    pub cycle_key: String,
    #[serde(default, alias = "rx_last")]
    pub last_agent_rx: i64,
    #[serde(default, alias = "tx_last")]
    pub last_agent_tx: i64,
    #[serde(default, alias = "rx_used")]
    pub cycle_rx_bytes: i64,
    #[serde(default, alias = "tx_used")]
    pub cycle_tx_bytes: i64,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportBundlePayload {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub nodes: Vec<NodeRow>,
    #[serde(default)]
    pub notification_channels: Vec<NotificationChannelRow>,
    #[serde(default)]
    pub alert_rules: Vec<AlertRuleRow>,
    #[serde(default)]
    pub system_settings: ImportSystemSettingsInput,
    #[serde(default)]
    pub traffic_ledgers: ImportTrafficLedgersInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportCounts {
    pub nodes: usize,
    pub channels: usize,
    pub rules: usize,
    pub traffic_ledgers: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportBundleResponse {
    pub ok: bool,
    pub imported: ImportCounts,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HubMigrateRequest {
    pub target_url: String,
    #[serde(default)]
    pub fallback_url: Option<String>,
    #[serde(default)]
    pub node_ids: Option<Vec<String>>,
    #[serde(default)]
    pub allow_insecure_ws: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubMigrateResponse {
    pub ok: bool,
    pub target_ws_url: String,
    pub epoch: i64,
    pub targeted: usize,
    pub dispatched: usize,
}

/// Convert full `AgentMetricsFrame` into compact 16-tuple matching Protocol v2.
pub fn metrics_frame_to_tuple(m: &AgentMetricsFrame) -> CompactMetricTuple {
    let load1 = m.cpu.load.first().copied().unwrap_or(0.0);
    let (disk_used, disk_r_bps, disk_w_bps) = m.disks.iter().fold((0u64, 0u64, 0u64), |acc, d| {
        (
            acc.0.saturating_add(d.used),
            acc.1.saturating_add(d.r_bps),
            acc.2.saturating_add(d.w_bps),
        )
    });
    [
        m.ts as f64,
        m.up as f64,
        m.cpu.all,
        m.cpu.steal,
        m.cpu.iowait,
        load1,
        m.mem.used as f64,
        m.mem.swap_used as f64,
        disk_used as f64,
        disk_r_bps as f64,
        disk_w_bps as f64,
        m.net.rx_bps as f64,
        m.net.tx_bps as f64,
        m.net.rx_tot as f64,
        m.net.tx_tot as f64,
        m.net.tcp_est as f64,
    ]
}

/// Convert `AgentMetricsPayload` + tuple metrics helper
pub fn metrics_payload_to_tuple(m: &NodeMetricsPayload) -> CompactMetricTuple {
    let load1 = m.cpu.load.first().copied().unwrap_or(0.0);
    let (disk_used, disk_r_bps, disk_w_bps) = m.disks.iter().fold((0u64, 0u64, 0u64), |acc, d| {
        (
            acc.0.saturating_add(d.used),
            acc.1.saturating_add(d.r_bps),
            acc.2.saturating_add(d.w_bps),
        )
    });
    [
        m.ts as f64,
        m.up as f64,
        m.cpu.all,
        m.cpu.steal,
        m.cpu.iowait,
        load1,
        m.mem.used as f64,
        m.mem.swap_used as f64,
        disk_used as f64,
        disk_r_bps as f64,
        disk_w_bps as f64,
        m.net.rx_bps as f64,
        m.net.tx_bps as f64,
        m.net.rx_tot as f64,
        m.net.tx_tot as f64,
        m.net.tcp_est as f64,
    ]
}

#[cfg(test)]
mod network_extension_compatibility_tests {
    use super::*;
    use serde_json::{json, Value};

    fn resource() -> Value {
        json!({"ts":100,"up":5,"cpu":{"all":12,"steal":0,"iowait":0},
            "mem":{"used":1,"avail":2,"cached":0,"swap_used":0},
            "net":{"rx_bps":0,"tx_bps":0,"rx_tot":0,"tx_tot":0,"tcp_est":0,"tcp_tw":0,"udp":0}})
    }

    #[test]
    fn old_resource_snapshots_and_malformed_extensions_preserve_sixteen_item_tuple() {
        let old = resource();
        let snapshot: NodeMetricsPayload = serde_json::from_value(old.clone()).unwrap();
        assert!(snapshot.network_quality.is_none());
        let expected = metrics_payload_to_tuple(&snapshot);
        assert_eq!(expected.len(), 16);
        for extension in [
            json!(null),
            json!("bad"),
            json!({"schema_version":"bad"}),
            json!({"points":[{"result":"unexpected"}]}),
        ] {
            let mut frame = old.clone();
            frame["t"] = json!("m");
            frame["network_quality"] = extension.clone();
            let AgentInboundFrame::Metrics(decoded) = serde_json::from_value(frame).unwrap() else {
                panic!("Expected metric frame")
            };
            assert_eq!(metrics_frame_to_tuple(&decoded), expected);
            let batch = json!({"t":"mb","pts":[expected],"last":old,"network_quality":extension});
            let AgentInboundFrame::MetricsBatch(decoded) = serde_json::from_value(batch).unwrap()
            else {
                panic!("Expected batch frame")
            };
            assert_eq!(decoded.pts, [expected]);
            assert_eq!(metrics_frame_to_tuple(&decoded.last), expected);
        }
    }
}
