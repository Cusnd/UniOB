import type {
  NetworkQualityConfig,
  NetworkQualityConfigResponse,
  NetworkQualityPoint,
  NetworkQualityQuery,
  NetworkQualityState,
  NetworkTarget,
  NetworkTargetId,
} from "../types/network-quality.ts";
import type { NodeMetricsSnapshot } from "../types.ts";

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
  const [a, b] = octets;
  // Block unspecified, loopback, private RFC1918, CGNAT, link-local, multicast/reserved.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
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
  } else if (label.length > 32) {
    errs.label = "显示名称不能超过 32 个字符";
  }

  const region = target.region?.trim() ?? "";
  if (region.length > 64) {
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
