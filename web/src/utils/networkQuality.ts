import type {
  NetworkQualityConfig, NetworkQualityConfigResponse, NetworkQualityPoint,
  NetworkQualityQuery, NetworkQualityState, NetworkTargetId,
} from "../types/network-quality.ts";
import type { NodeMetricsSnapshot } from "../types.ts";

export const NETWORK_TARGET_IDS: NetworkTargetId[] = ["ct", "cu", "cm"];
export const NETWORK_COLORS = { ct: "var(--accent)", cu: "var(--status-ok)", cm: "var(--status-warn)" };
export const NETWORK_RESULTS = {
  ok: "成功", connect_timeout: "连接超时", connection_refused: "连接被拒绝",
  dns_error: "DNS 解析失败", dns_timeout: "DNS 解析超时", network_error: "网络错误",
};
export function mergeMetricsNetworkState(
  previous: NodeMetricsSnapshot | null | undefined, incoming: NodeMetricsSnapshot | null | undefined,
): NodeMetricsSnapshot | null {
  if (!incoming) return previous ?? null;
  if (incoming.network_quality !== undefined || previous?.network_quality === undefined) return incoming;
  return { ...incoming, network_quality: previous.network_quality };
}
export function defaultNetworkConfig(): NetworkQualityConfig {
  return { enabled: false, targets: NETWORK_TARGET_IDS.map((id, i) => ({
    id, enabled: true, label: ["电信", "联通", "移动"][i], region: "广东",
    host: `gd-${id}-v4.ip.zstaticcdn.com`, port: 80, address_family: "ipv4",
  })) };
}
// Strip control-only target_revision before sending a strict management PUT.
export function editableNetworkConfig(config: NetworkQualityConfig): NetworkQualityConfig {
  return { enabled: config.enabled, targets: config.targets.map(t => ({
    id: t.id, enabled: t.enabled, label: t.label, region: t.region,
    host: t.host, port: t.port, address_family: "ipv4",
  })) };
}
export function networkMeasurementKey(state?: NetworkQualityState): string {
  return state?.latest.map(p => `${p.target_id}:${p.segment_id}:${p.measured_at}`).sort().join("|") ?? "";
}
export async function loadNetworkHistory(
  fetchPage: (cursor?: string) => Promise<NetworkQualityQuery>, signal?: AbortSignal,
): Promise<NetworkQualityQuery> {
  const pages: NetworkQualityQuery[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await fetchPage(cursor);
    signal?.throwIfAborted();
    pages.push(page);
    cursor = page.next_cursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error("网络历史游标重复，请重新加载");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return mergeNetworkPages(pages)!;
}
export function mergeNetworkPages(pages: NetworkQualityQuery[]): NetworkQualityQuery | null {
  if (!pages.length) return null;
  const first = pages[0];
  const buckets = new Map<NetworkTargetId, Map<string, NetworkQualityPoint>>();
  for (const page of pages) {
    if (page.node_id !== first.node_id || page.range !== first.range || page.resolution_sec !== first.resolution_sec) {
      throw new Error("网络历史分页不一致，请重新加载");
    }
    for (const series of page.series) {
      let bucket = buckets.get(series.target_id);
      if (!bucket) { bucket = new Map(); buckets.set(series.target_id, bucket); }
      for (const p of series.points) {
        bucket.set(`${p.ts}:${p.segment_id}:${p.target_revision}:${p.round_seq ?? "bucket"}`, p);
      }
    }
  }
  return { ...first, next_cursor: pages[pages.length - 1].next_cursor,
    series: NETWORK_TARGET_IDS.filter(id => buckets.has(id)).map(target_id => ({ target_id,
      points: [...buckets.get(target_id)!.values()].sort((a, b) => a.ts - b.ts || a.segment_id.localeCompare(b.segment_id)),
    })),
  };
}
export interface QualityPlotPoint { ts: number; value: number; source: NetworkQualityPoint }
export function qualityPlotRuns(
  points: NetworkQualityPoint[], metric: "latency_ms" | "failure_rate_pct", resolution: number,
): QualityPlotPoint[][] {
  const runs: QualityPlotPoint[][] = [];
  let run: QualityPlotPoint[] = [];
  let previous: NetworkQualityPoint | undefined;
  for (const p of points) {
    const value = p[metric];
    const hasRoundSequence = resolution === 20 && p.round_seq !== null && previous?.round_seq != null;
    const skipped = previous && (p.segment_id !== previous.segment_id ||
      p.target_revision !== previous.target_revision || (hasRoundSequence
        ? p.round_seq! !== previous.round_seq! + 1
        : p.ts - previous.ts > resolution * 1.6));
    if (skipped || value === null || !Number.isFinite(value) || p.attempts === 0) {
      if (run.length) runs.push(run);
      run = [];
    }
    // A failed attempt still contributes its rolling failure rate, including 100%.
    if (value !== null && Number.isFinite(value) && p.attempts > 0) run.push({ ts: p.ts, value, source: p });
    previous = p;
  }
  if (run.length) runs.push(run);
  return runs;
}
export function networkStatus(
  state: NetworkQualityState | undefined, config: NetworkQualityConfigResponse | null,
  online: boolean, now: number, live: boolean,
): { label: string; tone: "subtle" | "warn" | "danger" | "ok" } {
  if (config?.supported === false || state?.supported === false) return { label: "探针不支持", tone: "subtle" };
  if (state?.config_error) return { label: "配置错误", tone: "danger" };
  if (config && (state?.applied_config_id ?? config.applied_config_id) !== config.config_id &&
    (config.effective_config.enabled || state?.enabled)) return { label: "等待配置生效", tone: "warn" };
  if (config?.effective_config.enabled === false || state?.enabled === false) return { label: "未启用", tone: "subtle" };
  const targets = config?.effective_config.targets.filter(t => t.enabled);
  const latest = state?.latest.filter(p => !targets || targets.some(t => t.id === p.target_id && t.target_revision === p.target_revision)) ?? [];
  if (!latest.length) return { label: "等待首次样本", tone: "subtle" };
  if (!online || latest.some(p => now - p.measured_at > (live ? 60 : 390))) return { label: "数据过期", tone: "warn" };
  if (latest.some(p => p.result !== "ok")) return { label: "最新探测失败", tone: "danger" };
  if (latest.some(p => p.attempts < 6) || (targets && latest.length < targets.length)) return { label: "样本不足", tone: "warn" };
  return { label: "正常", tone: "ok" };
}
export function formatQualityValue(value: number | null | undefined, suffix = ""): string {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}${suffix}`;
}
