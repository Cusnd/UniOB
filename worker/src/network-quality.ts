import { sha256Hex } from "./crypto";

export const NQ_IDS = ["ct", "cu", "cm"] as const;
export type NqId = string;
export const NQ_MIN_TARGETS = 1;
export const NQ_MAX_TARGETS = 8;
export const NQ_DEFAULT_INTERVAL_SEC = 20;
export const NQ_MIN_INTERVAL_SEC = 10;
export const NQ_MAX_INTERVAL_SEC = 300;
const NQ_TARGET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const NQ_BUILTIN_RANK: Record<string, number> = { ct: 0, cu: 1, cm: 2 };

export interface NqTarget {
  id: NqId;
  enabled: boolean;
  label: string;
  region?: string;
  host: string;
  port: number;
  address_family: "ipv4";
}
export interface NqConfig {
  enabled: boolean;
  interval_sec?: number;
  targets: NqTarget[];
}
export interface NqOverride {
  mode: "inherit" | "off" | "custom";
  config?: NqConfig;
}
export interface NqControl {
  schema_version: 1;
  config_id: string;
  enabled: boolean;
  interval_sec?: number;
  targets: (NqTarget & { target_revision: string })[];
}
export type NqResult =
  | "ok"
  | "connect_timeout"
  | "connection_refused"
  | "dns_error"
  | "dns_timeout"
  | "network_error";
export interface NqPoint {
  sample_id: string;
  round_seq: number;
  config_id: string;
  target_id: NqId;
  target_revision: string;
  segment_id: string;
  ts: number;
  result: NqResult;
  connect_ms: number | null;
  remote_ip: string | null;
  target: NqTarget;
}
export interface NqLatest {
  target_id: NqId;
  target_revision: string;
  segment_id: string;
  target: NqTarget;
  measured_at: number;
  result: NqResult;
  remote_ip: string | null;
  latency_median_ms: number | null;
  attempts: number;
  failures: number;
  failure_rate_pct: number | null;
}
export interface NqState {
  supported: boolean;
  enabled: boolean;
  applied_config_id: string | null;
  config_error: string | null;
  dropped_samples: number;
  latest: NqLatest[];
}
export interface NqPayload extends Omit<NqState, "supported"> {
  schema_version: 1;
  points: NqPoint[];
}
export interface NqQueryPoint {
  ts: number;
  segment_id: string;
  target_revision: string;
  target: NqTarget;
  remote_ip: string | null;
  round_seq: number | null;
  result: NqResult | null;
  latency_ms: number | null;
  latency_max_ms: number | null;
  attempts: number;
  failures: number;
  success_count: number;
  latency_sum_ms: number;
  failure_rate_pct: number | null;
}
export const nqEmptyState = (): NqState => ({
  supported: false,
  enabled: false,
  applied_config_id: null,
  config_error: null,
  dropped_samples: 0,
  latest: [],
});
export const nqDefaultConfig = (): NqConfig => ({
  enabled: false,
  targets: NQ_IDS.map((id, i) => ({
    id,
    enabled: true,
    label: ["电信", "联通", "移动"][i]!,
    region: "广东",
    host: `gd-${id}-v4.ip.zstaticcdn.com`,
    port: 80,
    address_family: "ipv4",
  })),
});

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new Error("Unknown network quality field");
}
function optionalText(value: unknown, max = 64): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(value))
    throw new Error("Invalid network quality text");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if ([...trimmed].length > max)
    throw new Error("Invalid network quality text");
  return trimmed;
}
function shortText(value: unknown, max = 64): string {
  const text = optionalText(value, max);
  if (!text) throw new Error("Invalid network quality text");
  return text;
}
export function nqSortTargetIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => {
    const ra = NQ_BUILTIN_RANK[a] ?? 3;
    const rb = NQ_BUILTIN_RANK[b] ?? 3;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
export function nqSortTargets<T extends { id: string }>(
  targets: readonly T[],
): T[] {
  return [...targets].sort((a, b) => {
    const ra = NQ_BUILTIN_RANK[a.id] ?? 3;
    const rb = NQ_BUILTIN_RANK[b.id] ?? 3;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
export function nqIsPublicV4(value: string): boolean {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split(".").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return (
    [a, b, c, d].every((n) => n <= 255) &&
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) &&
    !(a === 192 && b === 0 && (c === 0 || c === 2)) &&
    !(a === 192 && b === 88 && c === 99) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}
export function nqParseTarget(value: unknown): NqTarget {
  const t = obj(value);
  keys(t, [
    "id",
    "enabled",
    "label",
    "region",
    "host",
    "port",
    "address_family",
  ]);
  if (
    typeof t.id !== "string" ||
    !NQ_TARGET_ID_RE.test(t.id) ||
    typeof t.enabled !== "boolean" ||
    t.address_family !== "ipv4"
  )
    throw new Error("Invalid target identity or address family");
  const host = shortText(t.host, 253).toLowerCase();
  if (/^[\d.]+$/.test(host)) {
    if (!nqIsPublicV4(host))
      throw new Error("Target must be a public IPv4 address");
  } else if (
    !host.includes(".") ||
    !host
      .split(".")
      .every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
  )
    throw new Error("Invalid target hostname");
  const port = t.port === undefined ? 80 : t.port;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    throw new Error("Invalid TCP port");
  const region = optionalText(t.region, 64);
  return {
    id: t.id,
    enabled: t.enabled,
    label: shortText(t.label, 32),
    ...(region !== undefined ? { region } : {}),
    host,
    port: port as number,
    address_family: "ipv4",
  };
}
export function nqParseConfig(value: unknown): NqConfig {
  const c = obj(value);
  keys(c, ["enabled", "interval_sec", "targets"]);
  if (
    typeof c.enabled !== "boolean" ||
    !Array.isArray(c.targets) ||
    c.targets.length < NQ_MIN_TARGETS ||
    c.targets.length > NQ_MAX_TARGETS
  )
    throw new Error("Expected enabled and 1 to 8 targets");
  const intervalSec =
    c.interval_sec === undefined ? NQ_DEFAULT_INTERVAL_SEC : c.interval_sec;
  if (
    !Number.isInteger(intervalSec) ||
    (intervalSec as number) < NQ_MIN_INTERVAL_SEC ||
    (intervalSec as number) > NQ_MAX_INTERVAL_SEC
  )
    throw new Error("Invalid network quality interval_sec");
  const targets = c.targets.map(nqParseTarget);
  if (new Set(targets.map((t) => t.id)).size !== targets.length)
    throw new Error("Duplicate target id");
  return {
    enabled: c.enabled,
    ...(intervalSec !== NQ_DEFAULT_INTERVAL_SEC
      ? { interval_sec: intervalSec as number }
      : {}),
    targets: nqSortTargets(targets),
  };
}
export function nqParseOverride(value: unknown): NqOverride {
  const c = obj(value);
  keys(c, ["mode", "config"]);
  if (c.mode === "custom")
    return { mode: "custom", config: nqParseConfig(c.config) };
  if ((c.mode !== "inherit" && c.mode !== "off") || c.config !== undefined)
    throw new Error("Invalid node network mode");
  return { mode: c.mode };
}
export function nqValidateSetting(key: string, value: string): void {
  if (key === "network_quality_config") nqParseConfig(JSON.parse(value));
  else if (key.startsWith("network_quality_node:"))
    nqParseOverride(JSON.parse(value));
}
export function nqTargetArray(t: NqTarget): unknown[] {
  return [
    t.id,
    t.enabled,
    t.label,
    t.region ?? null,
    t.host,
    t.port,
    t.address_family,
  ];
}
export async function nqMakeControl(c: NqConfig): Promise<NqControl> {
  const sorted = nqSortTargets(c.targets);
  const intervalSec = c.interval_sec ?? NQ_DEFAULT_INTERVAL_SEC;
  const targets = await Promise.all(
    sorted.map(async (t) => ({
      ...t,
      target_revision: await sha256Hex(JSON.stringify(nqTargetArray(t))),
    })),
  );
  const hashInput =
    intervalSec === NQ_DEFAULT_INTERVAL_SEC
      ? ["network_quality_v1", c.enabled, sorted.map(nqTargetArray)]
      : [
          "network_quality_v1",
          c.enabled,
          sorted.map(nqTargetArray),
          intervalSec,
        ];
  return {
    schema_version: 1,
    config_id: await sha256Hex(JSON.stringify(hashInput)),
    enabled: c.enabled,
    ...(intervalSec !== NQ_DEFAULT_INTERVAL_SEC
      ? { interval_sec: intervalSec }
      : {}),
    targets,
  };
}

const RESULTS: NqResult[] = [
  "ok",
  "connect_timeout",
  "connection_refused",
  "dns_error",
  "dns_timeout",
  "network_error",
];
const digest = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const idString = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length > 0 &&
  x.length <= 160 &&
  !/[\x00-\x1f]/.test(x);
export async function nqParsePayload(
  value: unknown,
  now: number,
): Promise<NqPayload | null> {
  try {
    if (
      value === undefined ||
      new TextEncoder().encode(JSON.stringify(value)).length > 384 * 1024
    )
      return null;
    const p = obj(value);
    if (
      p.schema_version !== 1 ||
      typeof p.enabled !== "boolean" ||
      !(p.applied_config_id === null || digest(p.applied_config_id)) ||
      !(
        p.config_error === null ||
        (typeof p.config_error === "string" && p.config_error.length <= 256)
      ) ||
      !Number.isSafeInteger(p.dropped_samples) ||
      (p.dropped_samples as number) < 0 ||
      !Array.isArray(p.points) ||
      p.points.length > 720 ||
      !Array.isArray(p.latest) ||
      p.latest.length > NQ_MAX_TARGETS
    )
      return null;
    const revisions = new Map<string, string>();
    const points: NqPoint[] = [];
    for (const v of p.points) {
      const q = obj(v);
      const target = nqParseTarget(q.target);
      if (
        !idString(q.sample_id) ||
        !idString(q.segment_id) ||
        !digest(q.config_id) ||
        !digest(q.target_revision) ||
        q.target_id !== target.id ||
        !Number.isSafeInteger(q.round_seq) ||
        (q.round_seq as number) < 0 ||
        !Number.isSafeInteger(q.ts) ||
        !RESULTS.includes(q.result as NqResult) ||
        !(
          q.remote_ip === null ||
          (typeof q.remote_ip === "string" && nqIsPublicV4(q.remote_ip))
        )
      )
        return null;
      if (
        q.result === "ok"
          ? !finite(q.connect_ms) ||
            q.connect_ms < 0 ||
            q.connect_ms > 1500 ||
            !q.remote_ip
          : q.connect_ms !== null
      )
        return null;
      if (
        (q.result === "dns_error" || q.result === "dns_timeout") &&
        q.remote_ip !== null
      )
        return null;
      const canon = JSON.stringify(nqTargetArray(target));
      if (!revisions.has(canon)) revisions.set(canon, await sha256Hex(canon));
      if (revisions.get(canon) !== q.target_revision) return null;
      if ((q.ts as number) < now - 1800 || (q.ts as number) > now + 60)
        continue;
      points.push({
        sample_id: q.sample_id,
        segment_id: q.segment_id,
        config_id: q.config_id,
        target_revision: q.target_revision,
        target_id: target.id,
        round_seq: q.round_seq as number,
        ts: q.ts as number,
        result: q.result as NqResult,
        connect_ms: q.connect_ms as number | null,
        remote_ip: q.remote_ip as string | null,
        target,
      });
    }
    // Never trust client-supplied aggregate values. The store reconstructs latest from points.
    return {
      schema_version: 1,
      applied_config_id: p.applied_config_id as string | null,
      enabled: p.enabled,
      config_error: p.config_error as string | null,
      dropped_samples: p.dropped_samples as number,
      latest: [],
      points,
    };
  } catch {
    return null;
  }
}

export function nqWindow(points: NqPoint[], end: NqPoint): NqPoint[] {
  return points
    .filter(
      (p) =>
        p.target_id === end.target_id &&
        p.segment_id === end.segment_id &&
        p.ts <= end.ts &&
        p.ts > end.ts - 120,
    )
    .sort((a, b) => a.ts - b.ts || a.round_seq - b.round_seq)
    .slice(-6);
}
export function nqLatest(points: NqPoint[], end: NqPoint): NqLatest {
  const w = nqWindow(points, end);
  const success = w
    .filter((p) => p.result === "ok")
    .map((p) => p.connect_ms!)
    .sort((a, b) => a - b);
  const n = success.length;
  const median = n
    ? n % 2
      ? success[n >> 1]!
      : (success[n / 2 - 1]! + success[n / 2]!) / 2
    : null;
  return {
    target_id: end.target_id,
    target_revision: end.target_revision,
    segment_id: end.segment_id,
    target: end.target,
    measured_at: end.ts,
    result: end.result,
    remote_ip: end.remote_ip,
    latency_median_ms: median,
    attempts: w.length,
    failures: w.length - n,
    failure_rate_pct: w.length ? ((w.length - n) * 100) / w.length : null,
  };
}
export function nqRawQuery(points: NqPoint[]): NqQueryPoint[] {
  const sorted = [...points].sort(
    (a, b) => a.ts - b.ts || a.round_seq - b.round_seq,
  );
  const windows = new Map<string, NqPoint[]>();
  return sorted.map((p) => {
    const key = `${p.target_id}:${p.segment_id}`;
    const w = nqWindow([...(windows.get(key) ?? []), p], p);
    windows.set(key, w);
    const ok = w.filter((x) => x.result === "ok");
    return {
      ts: p.ts,
      segment_id: p.segment_id,
      target_revision: p.target_revision,
      target: p.target,
      remote_ip: p.remote_ip,
      round_seq: p.round_seq,
      result: p.result,
      latency_ms: p.connect_ms,
      latency_max_ms: ok.length
        ? Math.max(...ok.map((x) => x.connect_ms!))
        : null,
      attempts: w.length,
      failures: w.length - ok.length,
      success_count: ok.length,
      latency_sum_ms: ok.reduce((sum, x) => sum + x.connect_ms!, 0),
      failure_rate_pct: ((w.length - ok.length) * 100) / w.length,
    };
  });
}
export function nqRollup(points: NqPoint[]): NqQueryPoint[] {
  const buckets = new Map<string, NqQueryPoint>();
  for (const p of points) {
    const ts = Math.floor(p.ts / 300) * 300;
    const key = `${ts}:${p.target_id}:${p.segment_id}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        ts,
        segment_id: p.segment_id,
        target_revision: p.target_revision,
        target: p.target,
        remote_ip: p.remote_ip,
        round_seq: null,
        result: null,
        latency_ms: null,
        latency_max_ms: null,
        attempts: 0,
        failures: 0,
        success_count: 0,
        latency_sum_ms: 0,
        failure_rate_pct: null,
      };
      buckets.set(key, b);
    }
    b.attempts++;
    if (p.remote_ip) b.remote_ip = p.remote_ip;
    if (p.result === "ok") {
      b.success_count++;
      b.latency_sum_ms += p.connect_ms!;
      b.latency_max_ms = Math.max(b.latency_max_ms ?? 0, p.connect_ms!);
    } else b.failures++;
    b.latency_ms = b.success_count ? b.latency_sum_ms / b.success_count : null;
    b.failure_rate_pct = (b.failures * 100) / b.attempts;
  }
  return [...buckets.values()];
}
