/* ============================================================================
 * UniOB UI Prototype · Shared Domain & View Contract Types
 * ============================================================================ */

export type ThemeMode = "light" | "dark";
export type AccentTheme = "cobalt" | "vermilion" | "jade";

export type NavRoute =
  | "fleet"
  | "servers"
  | "alerts"
  | "migration"
  | "style-spec";

export type FleetDisplayMode = "cards" | "table" | "matrix";
export type InspectorTab = "telemetry" | "processes" | "hardware";
export type TelemetryRange = "10m" | "1h" | "24h";
export type ProcessGear = 0 | 1 | 2;
export type NoticeTone = "info" | "success" | "warning" | "danger";
export type TrafficCountMode = "both" | "tx_only" | "max";

export type ProtocolState =
  | "idle_5m"
  | "pulse_10s"
  | "live_2s"
  | "edge_flush"
  | "offline";

export type HubArchitectureMode = "scch-cloud" | "self-hosted-rust";

export type AlertMetricKind =
  | "cpu"
  | "cpu_spike"
  | "steal"
  | "mem"
  | "swap"
  | "disk"
  | "traffic_pct"
  | "offline";

export interface TelemetryPoint {
  ts: number;
  label: string;
  cpu: number;
  steal: number;
  load1: number;
  memPct: number;
  swapPct: number;
  rxKbps: number;
  txKbps: number;
  diskReadKbps: number;
  diskWriteKbps: number;
  iops: number;
  tcpEst: number;
}

export interface DiskMount {
  mountpoint: string;
  fsType: string;
  totalGb: number;
  usedGb: number;
  readKbps: number;
  writeKbps: number;
}

export interface SanitizedProcess {
  pid: number;
  user: string;
  comm: string;
  state: "R" | "S" | "D" | "Z" | "T";
  cpuPct: number;
  rssMb: number;
  threads: number;
  sanitizedCmd: string;
  redactedTokens: number;
}

export interface NodeWatermarkPolicy {
  cpuTriggerPct: number;
  memTriggerPct: number;
  swapTriggerPct: number;
  diskTriggerPct: number;
  hysteresisPct: number;
}

export interface FleetNode {
  id: string;
  name: string;
  hostname: string;
  group: "生产核心" | "亚太边缘" | "欧美枢纽" | "1G 小鸡" | "中枢本机";
  tags: string[];
  regionCode: string;
  regionShort: string;
  regionFlag: string;
  provider: string;
  ipv4: string;
  ipv6: string | null;
  os: string;
  kernel: string;
  arch: "x86_64" | "aarch64";
  cpuModel: string;
  cpuCores: number;
  memTotalMb: number;
  memUsedMb: number;
  memCachedMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  zramEnabled: boolean;
  isTinyVps: boolean;
  isHubLocal?: boolean;
  procEnabled: boolean;
  mutedUntilLabel: string | null;
  tokenPreview: string;
  online: boolean;
  protocolState: ProtocolState;
  frameIntervalLabel: string;
  uptimeDays: number;
  lastSeenSecAgo: number;
  agentVersion: string;
  binarySizeMb: number;
  agentRssMb: number;
  stateDirOverride: string | null;
  systemdHardening: string[];
  wssEndpoint: string;
  tlsVerified: boolean;
  hmacEpoch: number;

  cpuPct: number;
  cpuStealPct: number;
  load: [number, number, number];
  netRxKbps: number;
  netTxKbps: number;
  monthlyTrafficUsedGb: number;
  monthlyTrafficLimitGb: number | null;
  trafficMode: TrafficCountMode;
  trafficResetDay: number;
  trafficDaysRemaining: number;
  tcpEst: number;
  tcpTw: number;

  mounts: DiskMount[];
  series: TelemetryPoint[];
  processes: SanitizedProcess[];
  watermark: NodeWatermarkPolicy;
  activeAlertText?: string;
}

export interface ScchQuotaDimension {
  id: string;
  label: string;
  usedDisplay: string;
  limitDisplay: string;
  usedPct: number;
  note: string;
}

export interface ScchQuotaSummary {
  planName: string;
  monthlyCostUsd: number;
  dailyD1WritesUsed: number;
  dailyD1WritesLimit: number;
  hibernationRatioPct: number;
  idleCapacityNodes: number;
  ops2hCapacityNodes: number;
  live24x7CapacityNodes: number;
  rowsPerIdleNodeDay: number;
  dimensions: ScchQuotaDimension[];
}

export interface AlertIncidentItem {
  id: string;
  nodeId: string;
  nodeName: string;
  regionShort: string;
  ruleName: string;
  metric: AlertMetricKind;
  status: "firing" | "resolved";
  triggerValueText: string;
  thresholdText: string;
  recoveryBandText: string;
  edgeFlushLatencyMs: number;
  muted: boolean;
  startedAtLabel: string;
  resolvedAtLabel: string | null;
  durationLabel: string;
  summary: string;
}

export interface WatermarkRule {
  id: string;
  name: string;
  scope: string;
  metric: AlertMetricKind;
  conditionText: string;
  triggerPct: number | null;
  recoverPct: number | null;
  sustainSec: number;
  cooldownSec: number;
  edgeZeroDelay: boolean;
  channels: string[];
  enabled: boolean;
}

export interface AlertChannel {
  id: string;
  name: string;
  type: "telegram" | "bark" | "feishu" | "email";
  targetMasked: string;
  detailNote: string;
  enabled: boolean;
  lastDeliveredLabel: string;
  latencyMs: number;
}

export interface CanaryNodeMigrationItem {
  nodeId: string;
  nodeName: string;
  regionShort: string;
  phase: "queued" | "canary_probe" | "handshaking" | "cutover_ok" | "fallback_safe";
  epochAck: number;
  rttMs: number;
  note: string;
}

export interface DualHubMigrationState {
  activeMode: HubArchitectureMode;
  currentOrigin: string;
  targetOrigin: string;
  fallbackOrigin: string;
  migrationTicketSample: string;
  monotonicEpoch: number;
  canaryTimeoutSec: number;
  fallbackRetryWindowSec: number;
  fallbackMaxRetries: number;
  watchdogCron: string;
  watchdogTimeoutSec: number;
  watchdogDailyReq: number;
  watchdogStatus: "healthy" | "waiting" | "stale";
  watchdogLastPingSecAgo: number;
  watchdogHmacKeyPreview: string;
  lastSnapshotAt: string;
  lastSnapshotSizeKb: number;
  snapshotCounts: {
    nodes: number;
    rules: number;
    channels: number;
    slabRows: number;
  };
  nodeStatuses: CanaryNodeMigrationItem[];
}

export interface FleetOverviewProps {
  nodes: FleetNode[];
  scchQuota: ScchQuotaSummary;
  incidents: AlertIncidentItem[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string, initialTab?: InspectorTab) => void;
  onOpenProvision: () => void;
  onNavigate: (route: NavRoute) => void;
}

export interface NodeInspectorDrawerProps {
  node: FleetNode | null;
  open: boolean;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  onGearChange?: (nodeId: string, gear: ProcessGear) => void;
  onNotify?: (message: string, tone?: NoticeTone) => void;
}

export interface ServersProvisionViewProps {
  nodes: FleetNode[];
  provisionModalOpen: boolean;
  onOpenProvisionModal: () => void;
  onCloseProvisionModal: () => void;
  onAddNode: (newNode: FleetNode) => void;
  onUpdateNodeWatermark: (nodeId: string, watermark: NodeWatermarkPolicy) => void;
  onInspectNode: (nodeId: string, initialTab?: InspectorTab) => void;
  onNotify?: (message: string, tone?: NoticeTone) => void;
}

export interface AlertsWatchdogViewProps {
  incidents: AlertIncidentItem[];
  rules: WatermarkRule[];
  channels: AlertChannel[];
  nodes: FleetNode[];
  onToggleRule: (ruleId: string) => void;
  onToggleChannel: (channelId: string) => void;
  onInspectNode: (nodeId: string, initialTab?: InspectorTab) => void;
  onNotify?: (message: string, tone?: NoticeTone) => void;
}

export interface MigrationStudioViewProps {
  migrationState: DualHubMigrationState;
  scchQuota: ScchQuotaSummary;
  nodes: FleetNode[];
  onSwitchHubMode: (mode: HubArchitectureMode) => void;
  onNotify?: (message: string, tone?: NoticeTone) => void;
}

export interface StyleSystemViewProps {
  theme: ThemeMode;
  accent: AccentTheme;
  onThemeChange: (theme: ThemeMode) => void;
  onAccentChange: (accent: AccentTheme) => void;
  onNotify?: (message: string, tone?: NoticeTone) => void;
}
