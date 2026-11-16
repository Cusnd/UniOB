import type {
  LatencyPiecewiseConfig,
  LatencyScaleMode,
  NetworkDisplaySpan,
  NetworkQualityConfig,
  NetworkQualityConfigResponse,
  NetworkQualityPoint,
  NetworkQualityQuery,
  NetworkQualityRange,
  NetworkQualityState,
  NetworkTarget,
  NetworkTargetId,
  NetworkTimeWindow,
  PiecewiseSizingMode,
} from "../types/network-quality.ts";
import type { MetricsRange, NodeMetricsSnapshot } from "../types.ts";

export const NETWORK_TARGET_IDS = ["ct", "cu", "cm"] as const;
export const DEFAULT_INTERVAL_SEC = 20;
export const MIN_INTERVAL_SEC = 10;
export const MAX_INTERVAL_SEC = 300;
export const MAX_NETWORK_TARGETS = 8;
export const TARGET_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export const NETWORK_COLORS: Record<string, string> = {
  ct: "var(--accent)",
  cu: "var(--status-ok)",
  cm: "var(--status-warn)",
};

export const NETWORK_PALETTE = [
  "var(--accent)",
  "var(--status-ok)",
  "var(--status-warn)",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
] as const;

export const NETWORK_RESULTS = {
  ok: "成功",
  connect_timeout: "连接超时",
  connection_refused: "连接被拒绝",
  dns_error: "DNS 解析失败",
  dns_timeout: "DNS 解析超时",
  network_error: "网络错误",
};

export type NetworkPresetKey = "cn-3net" | "apac" | "global";

export interface NetworkPreset {
  key: NetworkPresetKey;
  label: string;
  description: string;
  targets: NetworkTarget[];
}

export const NETWORK_PRESETS: Record<NetworkPresetKey, NetworkPreset> = {
  "cn-3net": {
    key: "cn-3net",
    label: "三网默认 CT/CU/CM",
    description: "电信 / 联通 / 移动 广东节点",
    targets: [
      {
        id: "ct",
        enabled: true,
        label: "电信",
        region: "广东",
        host: "gd-ct-v4.ip.zstaticcdn.com",
        port: 80,
        address_family: "ipv4",
      },
      {
        id: "cu",
        enabled: true,
        label: "联通",
        region: "广东",
        host: "gd-cu-v4.ip.zstaticcdn.com",
        port: 80,
        address_family: "ipv4",
      },
      {
        id: "cm",
        enabled: true,
        label: "移动",
        region: "广东",
        host: "gd-cm-v4.ip.zstaticcdn.com",
        port: 80,
        address_family: "ipv4",
      },
    ],
  },
  apac: {
    key: "apac",
    label: "亚太节点 HK/JP/SG",
    description: "香港 / 东京 / 新加坡 TCP 443",
    targets: [
      {
        id: "hk",
        enabled: true,
        label: "香港 HK",
        region: "香港",
        host: "s3.ap-east-1.amazonaws.com",
        port: 443,
        address_family: "ipv4",
      },
      {
        id: "jp",
        enabled: true,
        label: "东京 JP",
        region: "日本",
        host: "s3.ap-northeast-1.amazonaws.com",
        port: 443,
        address_family: "ipv4",
      },
      {
        id: "sg",
        enabled: true,
        label: "新加坡 SG",
        region: "新加坡",
        host: "s3.ap-southeast-1.amazonaws.com",
        port: 443,
        address_family: "ipv4",
      },
    ],
  },
  global: {
    key: "global",
    label: "海外节点 US/EU/JP",
    description: "美东 / 法兰克福 / 东京 TCP 443",
    targets: [
      {
        id: "us",
        enabled: true,
        label: "美东 US",
        region: "美国",
        host: "s3.us-east-1.amazonaws.com",
        port: 443,
        address_family: "ipv4",
      },
      {
        id: "eu",
        enabled: true,
        label: "法兰克福 EU",
        region: "德国",
        host: "s3.eu-central-1.amazonaws.com",
        port: 443,
        address_family: "ipv4",
      },
      {
        id: "jp",
        enabled: true,
        label: "东京 JP",
        region: "日本",
        host: "s3.ap-northeast-1.amazonaws.com",
        port: 443,
        address_family: "ipv4",
      },
    ],
  },
};

export const NETWORK_PRESET_LIST: NetworkPreset[] = [
  NETWORK_PRESETS["cn-3net"],
  NETWORK_PRESETS.apac,
  NETWORK_PRESETS.global,
];

export function clonePresetTargets(preset: NetworkPresetKey): NetworkTarget[] {
  return NETWORK_PRESETS[preset].targets.map((t) => ({ ...t }));
}

export function getTargetColor(id: NetworkTargetId, index = 0): string {
  if (NETWORK_COLORS[id]) return NETWORK_COLORS[id];
  return NETWORK_PALETTE[index % NETWORK_PALETTE.length];
}

export function targetSortRank(id: NetworkTargetId): number {
  const idx = NETWORK_TARGET_IDS.indexOf(
    id as (typeof NETWORK_TARGET_IDS)[number],
  );
  return idx === -1 ? NETWORK_TARGET_IDS.length : idx;
}

export function compareTargetIds(a: NetworkTargetId, b: NetworkTargetId): number {
  const rankDiff = targetSortRank(a) - targetSortRank(b);
  if (rankDiff !== 0) return rankDiff;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortTargetsCanonical<T extends { id: NetworkTargetId }>(
  targets: readonly T[],
): T[] {
  return [...targets].sort((a, b) => compareTargetIds(a.id, b.id));
}

export function normalizeIntervalSec(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_INTERVAL_SEC;
  }
  return Math.min(
    MAX_INTERVAL_SEC,
    Math.max(MIN_INTERVAL_SEC, Math.round(value)),
  );
}

export function mergeMetricsNetworkState(
  previous: NodeMetricsSnapshot | null | undefined,
  incoming: NodeMetricsSnapshot | null | undefined,
): NodeMetricsSnapshot | null {
  if (!incoming) return previous ?? null;
  if (
    incoming.network_quality !== undefined ||
    previous?.network_quality === undefined
  ) {
    return incoming;
  }
  return { ...incoming, network_quality: previous.network_quality };
}

export function defaultNetworkConfig(): NetworkQualityConfig {
  return {
    enabled: false,
    interval_sec: DEFAULT_INTERVAL_SEC,
    targets: clonePresetTargets("cn-3net"),
  };
}

// Strip control-only target_revision and omit empty optional region before PUT.
export function editableNetworkConfig(
  config: NetworkQualityConfig,
): NetworkQualityConfig {
  return {
    enabled: Boolean(config.enabled),
    interval_sec: normalizeIntervalSec(config.interval_sec),
    targets: config.targets.map((t) => {
      const region = t.region?.trim();
      return {
        id: t.id.trim().toLowerCase(),
        enabled: Boolean(t.enabled),
        label: t.label.trim(),
        ...(region ? { region } : {}),
        host: t.host.trim(),
        port: Number.isFinite(t.port) ? Math.trunc(t.port) : 80,
        address_family: "ipv4",
      };
    }),
  };
}

export function isPublicIpv4(rawHost: string): boolean | null {
  const host = rawHost.trim();
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) {
    return null;
  }
  const octets = parts.map((p) => {
    if (p.length > 1 && p.startsWith("0")) return -1;
    return Number(p);
  });
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  // Block unspecified, loopback, private RFC1918, CGNAT, link-local, RFC special-use, multicast/reserved.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isValidProbeHost(rawHost: string): string | null {
  const host = rawHost.trim();
  if (!host) return "请填写探测主机或域名";
  if (host.length > 253) return "主机名不能超过 253 个字符";
  if (/[\s/:?#\[\]]/.test(host)) return "主机名不应包含空格、协议或端口";
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    return "不能使用本地或内网保留域名";
  }
  const ipv4Check = isPublicIpv4(host);
  if (ipv4Check === false) {
    return "仅支持公网 IPv4 地址，不允许私网/保留地址";
  }
  if (ipv4Check === true) return null;
  const labels = lower.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    ) ||
    /^\d+$/.test(labels[labels.length - 1])
  ) {
    return "请输入有效的公网域名或 IPv4 地址";
  }
  return null;
}

export interface TargetFieldErrors {
  id?: string;
  label?: string;
  region?: string;
  host?: string;
  port?: string;
}

export interface NetworkConfigValidation {
  valid: boolean;
  formError?: string;
  intervalError?: string;
  targetErrors: TargetFieldErrors[];
  firstError?: string;
}

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || cp === 0x7f) return true;
  }
  return false;
}

export function validateNetworkTarget(
  target: NetworkTarget,
  existingIds?: Map<string, number>,
): TargetFieldErrors {
  const errs: TargetFieldErrors = {};
  const id = target.id.trim();
  if (!id) {
    errs.id = "请填写目标 ID";
  } else if (!TARGET_ID_REGEX.test(id)) {
    errs.id = "ID 仅支持小写字母、数字、_ 或 -，1~24 位";
  } else if (existingIds && (existingIds.get(id) ?? 0) > 1) {
    errs.id = `目标 ID "${id}" 重复`;
  }

  const label = target.label.trim();
  if (!label) {
    errs.label = "请填写显示名称";
  } else if (hasControlChars(label)) {
    errs.label = "显示名称不能包含控制字符";
  } else if ([...label].length > 32) {
    errs.label = "显示名称不能超过 32 个字符";
  }

  const region = target.region?.trim() ?? "";
  if (region && hasControlChars(region)) {
    errs.region = "地区备注不能包含控制字符";
  } else if ([...region].length > 64) {
    errs.region = "地区备注不能超过 64 个字符";
  }

  const hostErr = isValidProbeHost(target.host);
  if (hostErr) {
    errs.host = hostErr;
  }

  if (
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535
  ) {
    errs.port = "端口需在 1 ~ 65535 之间";
  }

  return errs;
}

export function validateNetworkConfig(
  config: NetworkQualityConfig,
): NetworkConfigValidation {
  let formError: string | undefined;
  let intervalError: string | undefined;

  if (config.interval_sec !== undefined) {
    if (
      !Number.isInteger(config.interval_sec) ||
      config.interval_sec < MIN_INTERVAL_SEC ||
      config.interval_sec > MAX_INTERVAL_SEC
    ) {
      intervalError = `探测间隔需为 ${MIN_INTERVAL_SEC} ~ ${MAX_INTERVAL_SEC} 秒的整数`;
    }
  }

  if (config.targets.length < 1 || config.targets.length > MAX_NETWORK_TARGETS) {
    formError = `探测目标数量需在 1 ~ ${MAX_NETWORK_TARGETS} 个之间`;
  } else if (config.enabled && !config.targets.some((t) => t.enabled)) {
    formError = "启用探测时至少需要开启 1 个探测目标";
  }

  const idCounts = new Map<string, number>();
  for (const target of config.targets) {
    const id = target.id.trim();
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const targetErrors = config.targets.map((target) =>
    validateNetworkTarget(target, idCounts),
  );

  const firstTargetError = targetErrors.find((e) =>
    Boolean(e.id || e.label || e.region || e.host || e.port),
  );
  const firstError =
    formError ||
    intervalError ||
    firstTargetError?.label ||
    firstTargetError?.id ||
    firstTargetError?.host ||
    firstTargetError?.port ||
    firstTargetError?.region;

  return {
    valid: !firstError,
    formError,
    intervalError,
    targetErrors,
    firstError,
  };
}

export function nextAvailableTargetId(targets: readonly NetworkTarget[]): string {
  const used = new Set(targets.map((t) => t.id.trim().toLowerCase()));
  for (let i = 1; i <= MAX_NETWORK_TARGETS + 4; i++) {
    const candidate = `target-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `t-${Date.now().toString(36).slice(-4)}`;
}

export function networkMeasurementKey(state?: NetworkQualityState): string {
  return (
    state?.latest
      .map((p) => `${p.target_id}:${p.segment_id}:${p.measured_at}`)
      .sort()
      .join("|") ?? ""
  );
}

export async function loadNetworkHistory(
  fetchPage: (cursor?: string) => Promise<NetworkQualityQuery>,
  signal?: AbortSignal,
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
    if (cursor && cursors.has(cursor)) {
      throw new Error("网络历史游标重复，请重新加载");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return mergeNetworkPages(pages)!;
}

export function mergeNetworkPages(
  pages: NetworkQualityQuery[],
): NetworkQualityQuery | null {
  if (!pages.length) return null;
  const first = pages[0];
  const buckets = new Map<NetworkTargetId, Map<string, NetworkQualityPoint>>();
  for (const page of pages) {
    if (
      page.node_id !== first.node_id ||
      page.range !== first.range ||
      page.resolution_sec !== first.resolution_sec
    ) {
      throw new Error("网络历史分页不一致，请重新加载");
    }
    for (const series of page.series) {
      let bucket = buckets.get(series.target_id);
      if (!bucket) {
        bucket = new Map();
        buckets.set(series.target_id, bucket);
      }
      for (const p of series.points) {
        bucket.set(
          `${p.ts}:${p.segment_id}:${p.target_revision}:${p.round_seq ?? "bucket"}`,
          p,
        );
      }
    }
  }
  const orderedIds = [...buckets.keys()].sort(compareTargetIds);
  return {
    ...first,
    next_cursor: pages[pages.length - 1].next_cursor,
    series: orderedIds.map((target_id) => ({
      target_id,
      points: [...buckets.get(target_id)!.values()].sort(
        (a, b) => a.ts - b.ts || a.segment_id.localeCompare(b.segment_id),
      ),
    })),
  };
}

export interface QualityPlotPoint {
  ts: number;
  value: number;
  source: NetworkQualityPoint;
}

export function qualityPlotRuns(
  points: NetworkQualityPoint[],
  metric: "latency_ms" | "failure_rate_pct",
  resolution: number,
): QualityPlotPoint[][] {
  const runs: QualityPlotPoint[][] = [];
  let run: QualityPlotPoint[] = [];
  let previous: NetworkQualityPoint | undefined;
  for (const p of points) {
    const value = p[metric];
    const hasRoundSequence =
      resolution < 300 && p.round_seq !== null && previous?.round_seq != null;
    const skipped =
      previous &&
      (p.segment_id !== previous.segment_id ||
        p.target_revision !== previous.target_revision ||
        (hasRoundSequence
          ? p.round_seq! !== previous.round_seq! + 1
          : p.ts - previous.ts > resolution * 1.6));
    if (skipped || value === null || !Number.isFinite(value) || p.attempts === 0) {
      if (run.length) runs.push(run);
      run = [];
    }
    // A failed attempt still contributes its rolling failure rate, including 100%.
    if (value !== null && Number.isFinite(value) && p.attempts > 0) {
      run.push({ ts: p.ts, value, source: p });
    }
    previous = p;
  }
  if (run.length) runs.push(run);
  return runs;
}

export function networkStatus(
  state: NetworkQualityState | undefined,
  config: NetworkQualityConfigResponse | null,
  online: boolean,
  now: number,
  live: boolean,
): { label: string; tone: "subtle" | "warn" | "danger" | "ok" } {
  if (config?.supported === false || state?.supported === false) {
    return { label: "探针不支持", tone: "subtle" };
  }
  if (state?.config_error) return { label: "配置错误", tone: "danger" };
  if (
    config &&
    (state?.applied_config_id ?? config.applied_config_id) !== config.config_id &&
    (config.effective_config.enabled || state?.enabled)
  ) {
    return { label: "等待配置生效", tone: "warn" };
  }
  if (config?.effective_config.enabled === false || state?.enabled === false) {
    return { label: "未启用", tone: "subtle" };
  }
  const intervalSec = normalizeIntervalSec(config?.effective_config.interval_sec);
  const staleAfter = live
    ? Math.max(60, intervalSec * 3)
    : Math.max(390, 330 + intervalSec * 3);
  const minAttempts = Math.max(1, Math.min(6, Math.floor(120 / intervalSec)));
  const targets = config?.effective_config.targets.filter((t) => t.enabled);
  const latest =
    state?.latest.filter(
      (p) =>
        !targets ||
        targets.some(
          (t) => t.id === p.target_id && t.target_revision === p.target_revision,
        ),
    ) ?? [];
  if (!latest.length) return { label: "等待首次样本", tone: "subtle" };
  if (!online || latest.some((p) => now - p.measured_at > staleAfter)) {
    return { label: "数据过期", tone: "warn" };
  }
  if (latest.some((p) => p.result !== "ok")) {
    return { label: "最新探测失败", tone: "danger" };
  }
  if (
    latest.some((p) => p.attempts < minAttempts) ||
    (targets && latest.length < targets.length)
  ) {
    return { label: "样本不足", tone: "warn" };
  }
  return { label: "正常", tone: "ok" };
}

export function formatQualityValue(
  value: number | null | undefined,
  suffix = "",
): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : `${value.toFixed(1)}${suffix}`;
}

export const MAX_NETWORK_RETENTION_SEC = 2592000;

export const NETWORK_SPAN_SECONDS: Record<NetworkDisplaySpan, number> = {
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};

export const NETWORK_DISPLAY_SPAN_OPTIONS: readonly {
  value: NetworkDisplaySpan;
  label: string;
}[] = [
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

export function chartModeToNetworkSpan(
  chartMode: "live" | MetricsRange,
): NetworkDisplaySpan | "1y" {
  return chartMode === "live" ? "1h" : chartMode;
}

export function minNetworkZoomSpanSec(resolutionSec: number): number {
  return Math.max(120, Math.round(resolutionSec) * 4);
}

export function resolveNetworkFetchRange(
  span: NetworkDisplaySpan,
  customWindow: NetworkTimeWindow | null,
  anchorNowSec: number,
  cachedRanges?: ReadonlySet<NetworkQualityRange>,
): NetworkQualityRange {
  if (customWindow === null) {
    if (span === "15m" || span === "30m" || span === "1h") return "1h";
    if (span === "6h" || span === "24h") return "24h";
    return span;
  }
  const lookbackSec = Math.max(0, anchorNowSec - customWindow.start);
  if (lookbackSec <= 3540) {
    return cachedRanges?.has("24h") && !cachedRanges.has("1h") ? "24h" : "1h";
  }
  if (lookbackSec <= 86340) return "24h";
  if (lookbackSec <= 604740) {
    return cachedRanges?.has("30d") && !cachedRanges.has("7d") ? "30d" : "7d";
  }
  return "30d";
}

export function clampNetworkTimeWindow(
  window: NetworkTimeWindow,
  anchorNowSec: number,
  resolutionSec = 20,
): NetworkTimeWindow {
  const earliest = anchorNowSec - MAX_NETWORK_RETENTION_SEC;
  const latest = anchorNowSec;
  const rawStart = Math.min(window.start, window.end);
  const rawEnd = Math.max(window.start, window.end);
  const minSpan = minNetworkZoomSpanSec(resolutionSec);
  const duration = Math.min(
    MAX_NETWORK_RETENTION_SEC,
    Math.max(minSpan, Math.round(rawEnd - rawStart)),
  );
  const mid = (rawStart + rawEnd) / 2;
  let start = Math.round(mid - duration / 2);
  let end = start + duration;
  if (start < earliest) {
    start = earliest;
    end = earliest + duration;
  }
  if (end > latest) {
    end = latest;
    start = Math.max(earliest, latest - duration);
  }
  return { start, end };
}

export function panNetworkTimeWindow(
  currentWindow: NetworkTimeWindow,
  direction: -1 | 1,
  anchorNowSec: number,
  resolutionSec = 20,
  activePresetSpanSec?: number,
): NetworkTimeWindow | null {
  const duration = Math.max(
    minNetworkZoomSpanSec(resolutionSec),
    Math.round(currentWindow.end - currentWindow.start),
  );
  const step = Math.max(60, Math.round(duration * 0.5));
  if (direction === 1) {
    const nextEnd = currentWindow.end + step;
    if (nextEnd >= anchorNowSec - 5) {
      if (
        activePresetSpanSec !== undefined &&
        Math.abs(duration - activePresetSpanSec) <= 5
      ) {
        return null;
      }
      return clampNetworkTimeWindow(
        { start: anchorNowSec - duration, end: anchorNowSec },
        anchorNowSec,
        resolutionSec,
      );
    }
    return clampNetworkTimeWindow(
      { start: currentWindow.start + step, end: nextEnd },
      anchorNowSec,
      resolutionSec,
    );
  }
  return clampNetworkTimeWindow(
    { start: currentWindow.start - step, end: currentWindow.end - step },
    anchorNowSec,
    resolutionSec,
  );
}

export function zoomOutNetworkTimeWindow(
  currentWindow: NetworkTimeWindow,
  anchorNowSec: number,
  resolutionSec = 20,
): NetworkTimeWindow {
  const duration =
    Math.max(
      minNetworkZoomSpanSec(resolutionSec),
      currentWindow.end - currentWindow.start,
    ) * 2;
  const mid = (currentWindow.start + currentWindow.end) / 2;
  return clampNetworkTimeWindow(
    { start: mid - duration / 2, end: mid + duration / 2 },
    anchorNowSec,
    resolutionSec,
  );
}

function lowerBoundTs(
  points: readonly NetworkQualityPoint[],
  ts: number,
): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTs(
  points: readonly NetworkQualityPoint[],
  ts: number,
): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function slicePointsForWindow(
  points: readonly NetworkQualityPoint[],
  window: NetworkTimeWindow,
): {
  contextPoints: NetworkQualityPoint[];
  visiblePoints: NetworkQualityPoint[];
} {
  if (!points.length) return { contextPoints: [], visiblePoints: [] };
  const firstVisible = lowerBoundTs(points, window.start);
  const afterVisible = upperBoundTs(points, window.end);
  const visiblePoints = points.slice(firstVisible, afterVisible);
  const contextStart = Math.max(0, firstVisible - 2);
  const contextEnd = Math.min(points.length, afterVisible + 2);
  return {
    contextPoints: points.slice(contextStart, contextEnd),
    visiblePoints,
  };
}

export const MAX_PIECEWISE_THRESHOLDS = 3;

export function defaultPiecewiseConfig(): LatencyPiecewiseConfig {
  return {
    auto: true,
    sizingMode: "share",
    thresholds: [250, 350],
    shares: [70, 15, 15],
    scales: [1, 0.4, 0.08],
  };
}

export function parseLatencyScaleMode(
  val: string | null | undefined,
): LatencyScaleMode {
  if (val === "linear" || val === "log" || val === "piecewise") return val;
  return "piecewise";
}

function defaultBandShares(bandCount: number): number[] {
  if (bandCount === 2) return [75, 25];
  if (bandCount === 3) return [70, 15, 15];
  return [64, 14, 12, 10];
}

function defaultBandScales(bandCount: number): number[] {
  if (bandCount === 2) return [1, 0.12];
  if (bandCount === 3) return [1, 0.4, 0.08];
  return [1, 0.5, 0.2, 0.06];
}

export function normalizePiecewiseConfig(raw: unknown): LatencyPiecewiseConfig {
  const defaults = defaultPiecewiseConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  const auto = typeof obj.auto === "boolean" ? obj.auto : true;
  const sizingMode: PiecewiseSizingMode =
    obj.sizingMode === "scale" ? "scale" : "share";

  const rawThresholds = Array.isArray(obj.thresholds)
    ? obj.thresholds
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .map((v) => Math.round(Math.min(60000, Math.max(1, v)) * 10) / 10)
        .sort((a, b) => a - b)
    : [];

  const thresholds: number[] = [];
  for (const v of rawThresholds) {
    if (
      thresholds.length === 0 ||
      v - thresholds[thresholds.length - 1]! >= 1
    ) {
      thresholds.push(v);
      if (thresholds.length >= MAX_PIECEWISE_THRESHOLDS) break;
    }
  }
  if (thresholds.length === 0) {
    thresholds.push(...defaults.thresholds);
  }

  const bandCount = thresholds.length + 1;
  const fallbackShares = defaultBandShares(bandCount);
  const fallbackScales = defaultBandScales(bandCount);

  const shares = Array.from({ length: bandCount }, (_, i) => {
    const v = Array.isArray(obj.shares) ? obj.shares[i] : undefined;
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.round(Math.min(1000, Math.max(1, v)) * 10) / 10;
    }
    return fallbackShares[i] ?? 10;
  });

  const scales = Array.from({ length: bandCount }, (_, i) => {
    const v = Array.isArray(obj.scales) ? obj.scales[i] : undefined;
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.round(Math.min(20, Math.max(0.01, v)) * 100) / 100;
    }
    return fallbackScales[i] ?? 0.1;
  });

  return { auto, sizingMode, thresholds, shares, scales };
}

function niceEvenCeiling(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 2) return 2;
  if (raw <= 10) return Math.ceil(raw / 2) * 2;
  const k = Math.max(0, Math.floor(Math.log10(raw)) - 1);
  const scale = Math.pow(10, k);
  const target = Math.ceil(raw);
  for (const m of [10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100]) {
    const candidate = m * scale;
    if (candidate >= target) return candidate;
  }
  return Math.ceil(target / 2) * 2;
}

function niceThresholdStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 2) return 2;
  if (raw <= 10) return Math.ceil(raw);
  const k = Math.max(0, Math.floor(Math.log10(raw)) - 1);
  const scale = Math.pow(10, k);
  const target = Math.ceil(raw);
  for (const m of [10, 12, 15, 20, 25, 30, 35, 40, 50, 60, 75, 80, 100]) {
    const candidate = m * scale;
    if (candidate >= target) return candidate;
  }
  return Math.ceil(target);
}

function quantileSorted(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface LatencyAxisBand {
  fromMs: number;
  toMs: number;
  startRatio: number;
  endRatio: number;
  compressed: boolean;
  relativeSlope: number;
}

export interface LatencyAxisTick {
  value: number;
  isThreshold: boolean;
}

export interface LatencyAxisModel {
  mode: LatencyScaleMode;
  min: number;
  max: number;
  rawPeak: number;
  outlierCount: number;
  thresholds: number[];
  bands: LatencyAxisBand[];
  ticks: LatencyAxisTick[];
  toRatio: (value: number) => number;
}

function normalizeBandRatios(
  rawHeights: readonly number[],
  minShare: number,
): number[] {
  const n = rawHeights.length;
  const fixed = new Array<boolean>(n).fill(false);
  const shares = new Array<number>(n).fill(0);
  let remainingBudget = 1;

  while (true) {
    let flexSum = 0;
    for (let i = 0; i < n; i++) {
      if (!fixed[i]) flexSum += Math.max(1e-9, rawHeights[i]!);
    }
    let newlyFixed = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const ratio =
        (Math.max(1e-9, rawHeights[i]!) / Math.max(1e-9, flexSum)) *
        remainingBudget;
      if (ratio < minShare) {
        fixed[i] = true;
        shares[i] = minShare;
        remainingBudget -= minShare;
        newlyFixed = true;
      } else {
        shares[i] = ratio;
      }
    }
    if (!newlyFixed) break;
  }

  const total = shares.reduce((a, b) => a + b, 0);
  return total > 0 ? shares.map((s) => s / total) : shares.map(() => 1 / n);
}

function buildPiecewiseAxis(
  thresholds: readonly number[],
  topMax: number,
  sizingMode: PiecewiseSizingMode,
  weights: readonly number[],
  rawPeak: number,
  allValues: readonly number[],
): LatencyAxisModel {
  const highestThreshold = thresholds[thresholds.length - 1]!;
  const effectiveMax = Math.max(
    topMax,
    niceEvenCeiling(highestThreshold * 1.2),
  );
  const bounds = [0, ...thresholds, effectiveMax];
  const m = bounds.length - 1;
  const rawHeights = Array.from({ length: m }, (_, i) => {
    const delta = Math.max(1e-6, bounds[i + 1]! - bounds[i]!);
    if (sizingMode === "share") {
      return Math.max(1, weights[i] ?? 10);
    }
    return delta * Math.max(0.01, weights[i] ?? 1);
  });
  const bandRatios = normalizeBandRatios(
    rawHeights,
    sizingMode === "share" ? 0.08 : 0.06,
  );

  let acc = 0;
  const rawBands = Array.from({ length: m }, (_, i) => {
    const fromMs = bounds[i]!;
    const toMs = bounds[i + 1]!;
    const startRatio = acc;
    acc = i === m - 1 ? 1 : acc + bandRatios[i]!;
    const endRatio = acc;
    const slope = (endRatio - startRatio) / Math.max(1e-6, toMs - fromMs);
    return { fromMs, toMs, startRatio, endRatio, slope };
  });

  const baseSlope = Math.max(1e-9, rawBands[0]!.slope);
  const bands: LatencyAxisBand[] = rawBands.map((b, i) => {
    const relativeSlope = b.slope / baseSlope;
    return {
      fromMs: b.fromMs,
      toMs: b.toMs,
      startRatio: b.startRatio,
      endRatio: b.endRatio,
      compressed: i > 0 && relativeSlope < 0.75,
      relativeSlope,
    };
  });

  const ticks: LatencyAxisTick[] = [{ value: 0, isThreshold: false }];
  if (bands[0]!.endRatio >= 0.45 && thresholds[0]! >= 4) {
    ticks.push({ value: Math.round(thresholds[0]! / 2), isThreshold: false });
  }
  for (const t of thresholds) {
    ticks.push({ value: t, isThreshold: true });
  }
  ticks.push({ value: effectiveMax, isThreshold: false });

  const firstCompressedFrom =
    bands.find((b) => b.compressed)?.fromMs ?? Infinity;
  const outlierCount = Number.isFinite(firstCompressedFrom)
    ? allValues.filter((v) => v > firstCompressedFrom).length
    : 0;

  return {
    mode: "piecewise",
    min: 0,
    max: effectiveMax,
    rawPeak,
    outlierCount,
    thresholds: [...thresholds],
    bands,
    ticks,
    toRatio: (value: number) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      if (value >= effectiveMax) return 1;
      for (const band of bands) {
        if (value <= band.toMs) {
          const span = Math.max(1e-6, band.toMs - band.fromMs);
          return (
            band.startRatio +
            ((value - band.fromMs) / span) * (band.endRatio - band.startRatio)
          );
        }
      }
      return 1;
    },
  };
}

export function subdivideRunAtThresholds(
  run: readonly { ts: number; value: number }[],
  thresholds: readonly number[],
): { ts: number; value: number }[] {
  if (run.length <= 1 || thresholds.length === 0) {
    return run.map((p) => ({ ts: p.ts, value: p.value }));
  }
  const sortedAsc = [...thresholds].sort((a, b) => a - b);
  const sortedDesc = [...sortedAsc].reverse();
  const out: { ts: number; value: number }[] = [
    { ts: run[0]!.ts, value: run[0]!.value },
  ];
  for (let i = 1; i < run.length; i++) {
    const p0 = run[i - 1]!;
    const p1 = run[i]!;
    if (p1.value > p0.value) {
      for (const t of sortedAsc) {
        if (p0.value < t && t < p1.value) {
          out.push({
            ts:
              p0.ts +
              ((t - p0.value) / (p1.value - p0.value)) * (p1.ts - p0.ts),
            value: t,
          });
        }
      }
    } else if (p1.value < p0.value) {
      for (const t of sortedDesc) {
        if (p1.value < t && t < p0.value) {
          out.push({
            ts:
              p0.ts +
              ((p0.value - t) / (p0.value - p1.value)) * (p1.ts - p0.ts),
            value: t,
          });
        }
      }
    }
    out.push({ ts: p1.ts, value: p1.value });
  }
  return out;
}

const LOG_FLOOR_CANDIDATES = [500, 200, 100, 50, 20, 10, 5] as const;
const LOG_NICE_TICKS = [
  1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300,
  400, 500, 600, 800, 1000, 1200, 1500, 2000, 3000, 5000,
] as const;

export function computeLatencyAxis(
  seriesValues: readonly (readonly number[])[],
  mode: LatencyScaleMode,
  piecewiseConfig?: LatencyPiecewiseConfig,
): LatencyAxisModel {
  const nonEmpty: number[][] = [];
  for (const series of seriesValues) {
    const clean = series
      .filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
    if (clean.length) nonEmpty.push(clean);
  }
  const all = nonEmpty.flat().sort((a, b) => a - b);
  if (!all.length) {
    return {
      mode,
      min: 0,
      max: 100,
      rawPeak: 0,
      outlierCount: 0,
      thresholds: [],
      bands: [
        {
          fromMs: 0,
          toMs: 100,
          startRatio: 0,
          endRatio: 1,
          compressed: false,
          relativeSlope: 1,
        },
      ],
      ticks: [
        { value: 0, isThreshold: false },
        { value: 50, isThreshold: false },
        { value: 100, isThreshold: false },
      ],
      toRatio: (v) => Math.max(0, Math.min(1, v / 100)),
    };
  }

  const rawPeak = all[all.length - 1]!;
  const fullMax = niceEvenCeiling(Math.max(2, rawPeak * 1.1));

  if (mode === "linear") {
    return {
      mode: "linear",
      min: 0,
      max: fullMax,
      rawPeak,
      outlierCount: 0,
      thresholds: [],
      bands: [
        {
          fromMs: 0,
          toMs: fullMax,
          startRatio: 0,
          endRatio: 1,
          compressed: false,
          relativeSlope: 1,
        },
      ],
      ticks: [
        { value: 0, isThreshold: false },
        { value: fullMax / 2, isThreshold: false },
        { value: fullMax, isThreshold: false },
      ],
      toRatio: (v) => Math.max(0, Math.min(1, v / fullMax)),
    };
  }

  if (mode === "piecewise") {
    const cfg = normalizePiecewiseConfig(piecewiseConfig);
    if (!cfg.auto) {
      return buildPiecewiseAxis(
        cfg.thresholds,
        fullMax,
        cfg.sizingMode,
        cfg.sizingMode === "share" ? cfg.shares : cfg.scales,
        rawPeak,
        all,
      );
    }

    const perSeriesNormals = nonEmpty.map((vals) => {
      if (vals.length < 6) return vals[vals.length - 1]!;
      const q1 = quantileSorted(vals, 0.25);
      const median = quantileSorted(vals, 0.5);
      const q3 = quantileSorted(vals, 0.75);
      const spread = Math.max(q3 - q1, median * 0.25, 15);
      const fence = q3 + 2.5 * spread;
      let maxInFence = q3;
      for (let i = vals.length - 1; i >= 0; i--) {
        if (vals[i]! <= fence) {
          maxInFence = Math.max(q3, vals[i]!);
          break;
        }
      }
      return maxInFence;
    });
    const normalPeak = Math.max(1, ...perSeriesNormals);
    if (rawPeak > normalPeak * 1.45) {
      const autoT = niceThresholdStep(Math.max(4, normalPeak * 1.12));
      if (autoT < fullMax * 0.82 && all.some((v) => v > autoT)) {
        return buildPiecewiseAxis([autoT], fullMax, "share", [76, 24], rawPeak, all);
      }
    }

    return {
      mode: "piecewise",
      min: 0,
      max: fullMax,
      rawPeak,
      outlierCount: 0,
      thresholds: [],
      bands: [
        {
          fromMs: 0,
          toMs: fullMax,
          startRatio: 0,
          endRatio: 1,
          compressed: false,
          relativeSlope: 1,
        },
      ],
      ticks: [
        { value: 0, isThreshold: false },
        { value: fullMax / 2, isThreshold: false },
        { value: fullMax, isThreshold: false },
      ],
      toRatio: (v) => Math.max(0, Math.min(1, v / fullMax)),
    };
  }

  // Log mode
  const rawMin = all[0]!;
  const floor = LOG_FLOOR_CANDIDATES.find(
    (c) => c <= rawMin * 0.8 && c <= fullMax / 8,
  );
  if (floor !== undefined) {
    const denom = Math.log10(fullMax / floor);
    const geoMid = Math.sqrt(floor * fullMax);
    const validMids = LOG_NICE_TICKS.filter((t) => t > floor && t < fullMax);
    let midTick = Math.max(
      floor + 1,
      Math.min(fullMax - 1, Math.round(geoMid)),
    );
    if (validMids.length) {
      midTick = validMids.reduce((best, cand) =>
        Math.abs(Math.log10(cand) - Math.log10(geoMid)) <
        Math.abs(Math.log10(best) - Math.log10(geoMid))
          ? cand
          : best,
      );
    }
    return {
      mode: "log",
      min: floor,
      max: fullMax,
      rawPeak,
      outlierCount: 0,
      thresholds: [],
      bands: [
        {
          fromMs: floor,
          toMs: fullMax,
          startRatio: 0,
          endRatio: 1,
          compressed: false,
          relativeSlope: 1,
        },
      ],
      ticks: [
        { value: floor, isThreshold: false },
        { value: midTick, isThreshold: false },
        { value: fullMax, isThreshold: false },
      ],
      toRatio: (v) =>
        Math.max(0, Math.min(1, Math.log10(Math.max(floor, v) / floor) / denom)),
    };
  }

  const fMax = Math.log10(1 + fullMax);
  const rawMid = Math.pow(10, fMax * 0.5) - 1;
  const validMids = LOG_NICE_TICKS.filter((t) => t > 0 && t < fullMax);
  let midTick = Math.max(1, Math.min(fullMax - 1, Math.round(rawMid)));
  if (validMids.length) {
    midTick = validMids.reduce((best, cand) =>
      Math.abs(Math.log10(1 + cand) - fMax * 0.5) <
      Math.abs(Math.log10(1 + best) - fMax * 0.5)
        ? cand
        : best,
    );
  }
  return {
    mode: "log",
    min: 0,
    max: fullMax,
    rawPeak,
    outlierCount: 0,
    thresholds: [],
    bands: [
      {
        fromMs: 0,
        toMs: fullMax,
        startRatio: 0,
        endRatio: 1,
        compressed: false,
        relativeSlope: 1,
      },
    ],
    ticks: [
      { value: 0, isThreshold: false },
      { value: midTick, isThreshold: false },
      { value: fullMax, isThreshold: false },
    ],
    toRatio: (v) =>
      Math.max(0, Math.min(1, Math.log10(1 + Math.max(0, v)) / fMax)),
  };
}
