import type { FleetHubDO } from "./do/fleet-hub-do";
import type { NodeDO } from "./do/node-do";
import type { NqControl, NqState } from "./network-quality";

export interface Env {
  DB: D1Database;
  NODE_DO: DurableObjectNamespace<NodeDO>;
  FLEET_HUB_DO: DurableObjectNamespace<FleetHubDO>;
  ASSETS?: Fetcher;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  AUTH_MODE?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAILS?: string;
  GITHUB_REPO?: string;
}

export type TrafficCountMode = "both" | "tx_only" | "max";
export type SampleMode = 0 | 1 | 2;

export interface AgentHelloFrame {
  t: "hello";
  v: number;
  agent_ver: string;
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpu_model: string;
  cpu_cores: number;
  mem_total: number;
  swap_total: number;
  boot_time: number;
  proc_enabled: boolean;
  capabilities?: string[];
  migrated_epoch?: number;
}

export interface AgentDiskEntry {
  mp: string;
  fs: string;
  total: number;
  used: number;
  r_bps: number;
  w_bps: number;
}

export interface AgentProcEntry {
  pid: number;
  user: string;
  comm: string;
  st: string;
  cpu: number;
  rss: number;
  thr: number;
  cmd: string;
}

export interface NodeMetricsPayload {
  network_quality?: NqState;
  ts: number;
  up: number;
  cpu: {
    all: number;
    cores: number[];
    steal: number;
    iowait: number;
    load: number[];
  };
  mem: {
    used: number;
    avail: number;
    cached: number;
    swap_used: number;
  };
  disks: AgentDiskEntry[];
  net: {
    rx_bps: number;
    tx_bps: number;
    rx_tot: number;
    tx_tot: number;
    tcp_est: number;
    tcp_tw: number;
    udp: number;
  };
}

export interface AgentMetricsFrame extends Omit<NodeMetricsPayload, "network_quality"> {
  network_quality?: unknown;
  t: "m";
  procs?: AgentProcEntry[];
}

/**
 * Compact 16-number metric tuple for v2 cohort batching (`mb`).
 * Indices: [0:ts, 1:up, 2:cpu_all, 3:steal, 4:iowait, 5:load1, 6:mem_used,
 *           7:swap_used, 8:disk_used, 9:disk_r_bps, 10:disk_w_bps,
 *           11:net_rx_bps, 12:net_tx_bps, 13:rx_tot, 14:tx_tot, 15:tcp_est]
 */
export type CompactMetricTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type BatchFlushReason = "cohort" | "edge" | "flush" | "hello";

export interface AgentMetricsBatchFrame {
  network_quality?: unknown;
  t: "mb";
  v: 2;
  reason: BatchFlushReason;
  pts: CompactMetricTuple[];
  last: Omit<AgentMetricsFrame, "t">;
}

export interface CtrlWatermarks {
  cpu?: number;
  steal?: number;
  mem?: number;
  swap?: number;
  disk?: number;
}

export interface CtrlMigrateDirective {
  url: string;
  fallback_url?: string;
  epoch: number;
  sig: string;
}

export interface AgentCtrlFrame {
  network_quality?: NqControl;
  t: "ctrl";
  mode: SampleMode;
  interval_ms: number;
  batch_sec?: number;
  top_n: number;
  lease_sec: number;
  flush_now?: boolean;
  watermarks?: CtrlWatermarks;
  migrate?: CtrlMigrateDirective;
}

export interface NodeRow {
  id: string;
  name: string;
  group_name: string;
  tags_json: string;
  sort_order: number;
  token_sha256: string;
  traffic_limit_bytes: number | null;
  traffic_reset_day: number;
  traffic_count_mode: TrafficCountMode;
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  arch: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  mem_total: number | null;
  swap_total: number | null;
  agent_version: string | null;
  proc_enabled: number;
  mute_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface NodeTrafficSummary {
  limit_bytes: number | null;
  reset_day: number;
  count_mode: TrafficCountMode;
  cycle_key: string;
  rx_bytes: number;
  tx_bytes: number;
  counted_bytes: number;
  days_remaining: number;
}

export interface NodeHardwareInfo {
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  arch: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  mem_total: number | null;
  swap_total: number | null;
  agent_version: string | null;
  proc_enabled: boolean;
}

export interface NodeSummary extends NodeHardwareInfo {
  id: string;
  name: string;
  group_name: string;
  tags: string[];
  sort_order: number;
  mute_until: number | null;
  online: boolean;
  last_seen_ts: number | null;
  created_at: number;
  updated_at: number;
  traffic: NodeTrafficSummary;
  metrics: NodeMetricsPayload | null;
}

export interface NodeConfigSync {
  nodeId: string;
  name: string;
  groupName: string;
  trafficLimitBytes: number | null;
  trafficResetDay: number;
  trafficCountMode: TrafficCountMode;
  muteUntil: number | null;
}

export interface NodeLeaseUpdate {
  nodeId?: string;
  fleetUntil?: number;
  detailUntil?: number;
  procUntil?: number;
}

export interface NodeSnapshot {
  online: boolean;
  last_seen_ts: number | null;
  traffic: NodeTrafficSummary;
  metrics: NodeMetricsPayload | null;
  hardware: NodeHardwareInfo | null;
}

export type MetricRange = "1h" | "24h" | "7d" | "30d" | "1y";
export type MetricResolution = "30s" | "5m" | "1h";

export interface MetricsQueryPoint {
  ts: number;
  cpu: number;
  cpu_max?: number;
  steal: number;
  load1: number;
  mem_used: number;
  mem_max?: number;
  swap_used: number;
  disk_used: number;
  disk_r_bps: number;
  disk_w_bps: number;
  net_rx_bps: number;
  net_tx_bps: number;
  tcp_est: number;
}

export interface MetricsQueryResponse {
  node_id: string;
  range: MetricRange;
  resolution: MetricResolution;
  points: MetricsQueryPoint[];
}

export type ChannelType = "telegram" | "webhook";

export interface TelegramChannelConfig {
  bot_token: string;
  chat_id: string;
  thread_id?: number | null;
}

export interface WebhookChannelConfig {
  url: string;
  secret?: string;
}

export type ChannelConfig = TelegramChannelConfig | WebhookChannelConfig;

export interface NotificationChannelRow {
  id: string;
  name: string;
  type: ChannelType;
  enabled: number;
  config_json: string;
  created_at: number;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  config: ChannelConfig;
  created_at: number;
}

export type AlertMetric =
  | "offline"
  | "cpu"
  | "steal"
  | "mem"
  | "swap"
  | "disk"
  | "traffic_pct";

export type AlertOperator = "gt" | "gte";

export interface AlertRuleRow {
  id: string;
  name: string;
  node_id: string | null;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  duration_sec: number;
  cooldown_sec: number;
  channel_ids_json: string;
  enabled: number;
  created_at: number;
}

export interface AlertRule {
  id: string;
  name: string;
  node_id: string | null;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  duration_sec: number;
  cooldown_sec: number;
  channel_ids: string[];
  enabled: boolean;
  created_at: number;
}

export interface AlertIncidentRow {
  id: string;
  node_id: string;
  node_name: string;
  rule_id: string;
  metric: AlertMetric | string;
  status: "firing" | "resolved";
  trigger_value: number | null;
  threshold: number | null;
  message: string;
  started_at: number;
  resolved_at: number | null;
  last_notified_at: number;
}

export interface AgentWsAttachment {
  role: "agent";
  nodeId: string;
  ver: number;
  mode: SampleMode;
  caps: string[];
  /** Last resource ctrl dispatch, retained across Durable Object hibernation. */
  last_ctrl_ts?: number;
}

export interface ClientAttachment {
  role?: "client";
  fleet: boolean;
  nodeId: string | null;
  proc: boolean;
  exp?: number;
}

export type ClientInboundMessage =
  | { op: "sub_fleet" }
  | { op: "unsub_fleet" }
  | { op: "sub_node"; nodeId: string; proc?: boolean }
  | { op: "unsub_node"; nodeId?: string }
  | { op: "renew" }
  | { op: "ping" };

export interface FleetTickMessage {
  t: "fleet_tick";
  nodeId: string;
  online: boolean;
  last_seen_ts: number | null;
  traffic: NodeTrafficSummary;
  metrics: NodeMetricsPayload | null;
  hardware?: NodeHardwareInfo;
}

export interface FleetBatchMessage {
  t: "fleet_batch";
  ticks: FleetTickMessage[];
}

export interface NodeDetailMessage {
  t: "node_detail";
  nodeId: string;
  online: boolean;
  ts: number;
  metrics: NodeMetricsPayload;
  procs?: AgentProcEntry[];
}

export interface NodeOfflineMessage {
  t: "node_offline";
  nodeId: string;
  last_seen_ts: number | null;
}

export interface AlertChangeMessage {
  t: "alert_change";
  activeAlertsCount?: number;
}

export interface WatchdogConfig {
  enabled: boolean;
  secret: string;
  timeout_sec: number;
  cooldown_sec: number;
  hub_label: string;
  channel_ids?: string[];
}

export interface WatchdogState {
  last_ping_ts: number | null;
  enabled_at: number | null;
  status: "ok" | "stale";
  last_alert_ts: number | null;
  stale_since_ts: number | null;
  last_payload?: {
    hub_label?: string;
    connected_agents?: number;
    total_nodes?: number;
    version?: string;
  };
}

export interface HubWatchdogStatus {
  enabled: boolean;
  last_ping_ts: number | null;
  status: "disabled" | "waiting" | "healthy" | "stale";
  timeout_sec: number;
}

export interface HubStatusResponse {
  mode: "cloudflare-worker" | "self-hosted-hub";
  version: string;
  connected_agents: number;
  total_nodes: number;
  watchdog: HubWatchdogStatus;
}

export interface ExportTrafficLedgerEntry {
  node_id: string;
  cycle_key: string;
  last_agent_rx: number;
  last_agent_tx: number;
  cycle_rx_bytes: number;
  cycle_tx_bytes: number;
  updated_at: number;
}

export interface ExportSystemSettingEntry {
  key: string;
  value: string;
  updated_at: number;
}

export interface ExportBundle {
  version: number;
  exported_at: number;
  nodes: NodeRow[];
  notification_channels: NotificationChannelRow[];
  alert_rules: AlertRuleRow[];
  system_settings: ExportSystemSettingEntry[];
  traffic_ledgers: ExportTrafficLedgerEntry[];
}

export interface ImportBundleResponse {
  ok: true;
  imported: {
    nodes: number;
    channels: number;
    rules: number;
    traffic_ledgers: number;
  };
}

export interface HubMigrateRequest {
  target_url: string;
  fallback_url?: string;
  node_ids?: string[];
  allow_insecure_ws?: boolean;
}

export interface HubMigrateResponse {
  ok: true;
  target_ws_url: string;
  epoch: number;
  targeted: number;
  dispatched: number;
}

export type MigrationTicketPurpose = "receive" | "install";

export interface MigrationTicketRequest {
  purpose: MigrationTicketPurpose;
  public_origin?: string;
  enable_watchdog?: boolean;
}

export interface MigrationTicketResponse {
  ok: true;
  purpose: MigrationTicketPurpose;
  origin: string;
  expires_at: number;
  migration_code?: string;
  pull_url?: string;
  install_cmd?: string;
  watchdog_armed?: boolean;
}

export interface MigrationReceiveResponse {
  ok: true;
  mode: "cloudflare-worker" | "self-hosted-hub";
  imported: ImportBundleResponse["imported"];
}

export interface SmartMigrateRequest {
  target_input: string;
  node_ids?: string[];
  allow_insecure_ws?: boolean;
}

export interface SmartMigrateResponse {
  ok: true;
  target_origin: string;
  target_ws_url: string;
  fallback_ws_url: string | null;
  synced: ImportBundleResponse["imported"];
  targeted: number;
  dispatched: number;
  epoch: number;
}
