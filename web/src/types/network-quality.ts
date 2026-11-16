export type NetworkTargetId = string;
export type NetworkQualityRange = "1h" | "24h" | "7d" | "30d";
export type NetworkDisplaySpan = "15m" | "30m" | "1h" | "6h" | "24h" | "7d" | "30d";
export type LatencyScaleMode = "piecewise" | "linear" | "log";
export type PiecewiseSizingMode = "share" | "scale";
export interface LatencyPiecewiseConfig {
  auto: boolean;
  sizingMode: PiecewiseSizingMode;
  thresholds: number[];
  shares: number[];
  scales: number[];
}
export interface NetworkTimeWindow {
  start: number;
  end: number;
}
export type NetworkProbeResult = "ok" | "connect_timeout" | "connection_refused" | "dns_error" | "dns_timeout" | "network_error";

export interface NetworkTarget {
  id: NetworkTargetId;
  enabled: boolean;
  label: string;
  region?: string;
  host: string;
  port: number;
  address_family: "ipv4";
}
export interface NetworkQualityConfig {
  enabled: boolean;
  interval_sec?: number;
  targets: NetworkTarget[];
}
export interface NetworkNodeOverride { mode: "inherit" | "off" | "custom"; config?: NetworkQualityConfig }
export interface NetworkQualityControl extends NetworkQualityConfig {
  schema_version: 1;
  config_id: string;
  targets: (NetworkTarget & { target_revision: string })[];
}
export interface NetworkQualityConfigResponse<T = NetworkQualityConfig | NetworkNodeOverride> {
  config: T;
  effective_config: NetworkQualityControl;
  config_id: string;
  applied_config_id: string | null;
  supported: boolean;
}
export interface NetworkQualityLatest {
  target_id: NetworkTargetId;
  target_revision: string;
  segment_id: string;
  target: NetworkTarget;
  measured_at: number;
  result: NetworkProbeResult;
  remote_ip: string | null;
  latency_median_ms: number | null;
  attempts: number;
  failures: number;
  failure_rate_pct: number | null;
}
export interface NetworkQualityState {
  supported: boolean;
  enabled: boolean;
  applied_config_id: string | null;
  config_error: string | null;
  dropped_samples: number;
  latest: NetworkQualityLatest[];
}
export interface NetworkQualityPoint {
  ts: number;
  segment_id: string;
  target_revision: string;
  target: NetworkTarget;
  remote_ip: string | null;
  round_seq: number | null;
  result: NetworkProbeResult | null;
  latency_ms: number | null;
  latency_max_ms: number | null;
  attempts: number;
  failures: number;
  success_count: number;
  latency_sum_ms: number;
  failure_rate_pct: number | null;
}
export interface NetworkQualityQuery {
  node_id: string;
  range: NetworkQualityRange;
  resolution_sec: 20 | 300;
  server_time: number;
  state: NetworkQualityState;
  series: { target_id: NetworkTargetId; points: NetworkQualityPoint[] }[];
  next_cursor: string | null;
}
