export interface AuthStatus {
  authenticated: boolean;
  needsSetup: boolean;
  mode: "builtin" | "cf_access";
  email?: string;
  forbidden?: boolean;
}

export interface CpuMetrics {
  all: number;
  cores: number[];
  steal: number;
  iowait: number;
  load: [number, number, number];
}

export interface MemMetrics {
  used: number;
  avail: number;
  cached: number;
  swap_used: number;
}

export interface DiskMetrics {
  mp: string;
  fs: string;
  total: number;
  used: number;
  r_bps: number;
  w_bps: number;
}

export interface NetMetrics {
  rx_bps: number;
  tx_bps: number;
  rx_tot: number;
  tx_tot: number;
  tcp_est: number;
  tcp_tw: number;
  udp: number;
}

export interface NodeMetricsSnapshot {
  ts: number;
  up: number;
  cpu: CpuMetrics;
  mem: MemMetrics;
  disks: DiskMetrics[];
  net: NetMetrics;
}

export type TrafficCountMode = "both" | "tx_only" | "max";

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

export interface NodeSummary {
  id: string;
  name: string;
  group_name: string;
  tags: string[];
  sort_order: number;
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
  mute_until: number | null;
  online: boolean;
  last_seen_ts: number | null;
  created_at: number;
  updated_at: number;
  traffic: NodeTrafficSummary;
  metrics: NodeMetricsSnapshot | null;
}

export interface CreateNodePayload {
  name: string;
  group_name: string;
  tags: string[];
  sort_order: number;
  traffic_limit_bytes: number | null;
  traffic_reset_day: number;
  traffic_count_mode: TrafficCountMode;
}

export interface UpdateNodePayload {
  name?: string;
  group_name?: string;
  tags?: string[];
  sort_order?: number;
  traffic_limit_bytes?: number | null;
  traffic_reset_day?: number;
  traffic_count_mode?: TrafficCountMode;
  mute_until?: number | null;
}

export interface CreateNodeResponse {
  node: NodeSummary;
  agent_token: string;
  install_cmd: string;
}

export interface RotateTokenResponse {
  agent_token: string;
  install_cmd: string;
}

export type MetricsRange = "1h" | "24h" | "7d" | "30d" | "1y";

export interface HistoricalMetricPoint {
  ts: number;
  cpu: number;
  cpu_max?: number;
  steal?: number;
  load1?: number;
  mem_used: number;
  mem_max?: number;
  swap_used?: number;
  disk_used: number;
  disk_r_bps?: number;
  disk_w_bps?: number;
  net_rx_bps: number;
  net_tx_bps: number;
  tcp_est?: number;
}

export interface NodeMetricsHistoryResponse {
  node_id: string;
  range: MetricsRange;
  resolution: "30s" | "5m" | "1h";
  points: HistoricalMetricPoint[];
}

export interface ProcEntry {
  pid: number;
  user: string;
  comm: string;
  st: string;
  cpu: number;
  rss: number;
  thr: number;
  cmd: string;
}

export interface NotificationChannelConfig {
  bot_token?: string;
  chat_id?: string;
  thread_id?: number | null;
  url?: string;
  secret?: string;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: "telegram" | "webhook";
  enabled: boolean;
  config: NotificationChannelConfig;
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

export interface AlertIncident {
  id: string;
  node_id: string;
  node_name: string;
  rule_id: string;
  metric: string;
  status: "firing" | "resolved";
  trigger_value: number | null;
  threshold: number | null;
  message: string;
  started_at: number;
  resolved_at: number | null;
  last_notified_at: number;
}

export interface HardwarePatch {
  hostname?: string | null;
  os?: string | null;
  kernel?: string | null;
  arch?: string | null;
  cpu_model?: string | null;
  cpu_cores?: number | null;
  mem_total?: number | null;
  swap_total?: number | null;
  agent_version?: string | null;
  agent_ver?: string | null;
  proc_enabled?: boolean;
}

export type WsOutboundMessage =
  | { op: "sub_fleet" }
  | { op: "unsub_fleet" }
  | { op: "sub_node"; nodeId: string; proc: boolean }
  | { op: "unsub_node"; nodeId: string }
  | { op: "renew" }
  | { op: "ping" };

export interface FleetTickData {
  t?: "fleet_tick";
  nodeId: string;
  online: boolean;
  last_seen_ts: number | null;
  traffic: NodeTrafficSummary;
  metrics: NodeMetricsSnapshot | null;
  hardware?: HardwarePatch;
}

export type WsInboundMessage =
  | ({
      t: "fleet_tick";
    } & FleetTickData)
  | {
      t: "fleet_batch";
      ticks: FleetTickData[];
    }
  | {
      t: "node_detail";
      nodeId: string;
      online: boolean;
      ts: number;
      metrics: NodeMetricsSnapshot;
      procs?: ProcEntry[];
    }
  | {
      t: "node_offline";
      nodeId: string;
      last_seen_ts: number | null;
    }
  | {
      t: "alert_change";
      activeAlertsCount?: number;
    }
  | {
      t: "pong";
    };

export type HubMode = "cloudflare-worker" | "self-hosted-hub";
export type WatchdogHealthStatus = "disabled" | "waiting" | "healthy" | "stale";

export interface HubWatchdogStatus {
  enabled: boolean;
  last_ping_ts: number | null;
  status: WatchdogHealthStatus;
  timeout_sec: number;
}

export interface HubStatusResponse {
  mode: HubMode;
  version: string;
  connected_agents: number;
  total_nodes: number;
  watchdog: HubWatchdogStatus;
}

export interface ExportBundle {
  version?: number;
  exported_at?: number;
  nodes?: unknown[];
  notification_channels?: unknown[];
  alert_rules?: unknown[];
  system_settings?: Record<string, unknown> | unknown[];
  traffic_ledgers?: unknown[];
  [key: string]: unknown;
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

export interface HubMigratePayload {
  target_url: string;
  fallback_url?: string;
  node_ids?: string[];
}

export interface HubMigrateResponse {
  ok: true;
  target_ws_url: string;
  epoch: number;
  targeted: number;
  dispatched: number;
}

export interface WatchdogConfig {
  enabled: boolean;
  secret: string;
  timeout_sec: number;
  cooldown_sec: number;
  hub_label: string;
  channel_ids?: string[];
}

export interface MigrationTicketPayload {
  purpose: "receive" | "install";
  public_origin?: string;
  enable_watchdog?: boolean;
}

export interface MigrationTicketResponse {
  ok: true;
  purpose: "receive" | "install";
  origin: string;
  expires_at: number;
  migration_code?: string;
  pull_url?: string;
  install_cmd?: string;
  watchdog_armed?: boolean;
}

export interface SmartMigratePayload {
  target_input: string;
  node_ids?: string[];
  allow_insecure_ws?: boolean;
}

export interface SmartMigrateResponse {
  ok: true;
  target_origin: string;
  target_ws_url: string;
  fallback_ws_url: string | null;
  synced: {
    nodes: number;
    channels: number;
    rules: number;
    traffic_ledgers: number;
  };
  targeted: number;
  dispatched: number;
  epoch: number;
}

export type AppRoute = "dashboard" | "nodes" | "migration" | "alerts";
export type FleetViewMode = "bento" | "table" | "matrix";
export type ViewMode = "grid" | "table";
export type ThemeMode = "dark" | "light" | "system";
export type AccentPreset = "emerald" | "indigo" | "cyan";
export type DensityMode = "comfortable" | "compact";
export type SimSpeed = "1s" | "2s" | "paused";
export type InspectorTab = "charts" | "procs" | "hardware";

export interface LiveSample {
  ts: number;
  metrics: NodeMetricsSnapshot;
}

export interface PrototypeNode extends NodeSummary {
  region_code: string;
  region_flag: string;
  provider: string;
  ipv4_masked: string;
  sparkline_cpu: number[];
  sparkline_rx: number[];
  sparkline_tx: number[];
}

export interface ToastMessage {
  id: string;
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  description?: string;
}
