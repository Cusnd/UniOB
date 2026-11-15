import type {
  CompactMetricTuple,
  MetricsQueryPoint,
  NodeMetricsPayload,
} from "../types";

export const RAW_CHUNK_SEC = 600;
export const RAW_SLAB_SLOTS = 144; // 144 * 10m = 24h ring

export const ROLLUP_5M_SEC = 300;
export const CHUNK_5M_SEC = 3600;
export const SLAB_5M_SLOTS = 720; // 720 * 1h = 30d ring

export const ROLLUP_1H_SEC = 3600;
export const CHUNK_1H_SEC = 86400;
export const SLAB_1H_SLOTS = 366; // 366 * 1d = 366d ring

const RAW_STRIDE = 76;
const ROLLUP_STRIDE = 88;

export interface RawSlabPoint {
  ts: number;
  cpu: number;
  steal: number;
  load1: number;
  mem_used: number;
  swap_used: number;
  disk_used: number;
  disk_r_bps: number;
  disk_w_bps: number;
  net_rx_bps: number;
  net_tx_bps: number;
  tcp_est: number;
}

export interface RollupSlabPoint extends RawSlabPoint {
  cpu_max: number;
  mem_max: number;
}

export interface WelfordAccum {
  bucket_ts: number;
  count: number;
  cpu_sum: number;
  cpu_max: number;
  steal_sum: number;
  load1_sum: number;
  mem_sum: number;
  mem_max: number;
  swap_sum: number;
  disk_sum: number;
  disk_r_sum: number;
  disk_w_sum: number;
  net_rx_sum: number;
  net_tx_sum: number;
  tcp_est_sum: number;
}

export function sumDiskTotals(
  disks: Array<{ used: number; r_bps: number; w_bps: number }> | undefined,
): { diskUsed: number; diskRBps: number; diskWBps: number } {
  let diskUsed = 0;
  let diskRBps = 0;
  let diskWBps = 0;
  for (const disk of disks ?? []) {
    diskUsed += Number.isFinite(disk.used) ? disk.used : 0;
    diskRBps += Number.isFinite(disk.r_bps) ? disk.r_bps : 0;
    diskWBps += Number.isFinite(disk.w_bps) ? disk.w_bps : 0;
  }
  return { diskUsed, diskRBps, diskWBps };
}

export function payloadToCompactTuple(payload: NodeMetricsPayload): CompactMetricTuple {
  const { diskUsed, diskRBps, diskWBps } = sumDiskTotals(payload.disks);
  return [
    Math.floor(payload.ts),
    payload.up,
    payload.cpu.all,
    payload.cpu.steal,
    payload.cpu.iowait,
    payload.cpu.load[0] ?? 0,
    payload.mem.used,
    payload.mem.swap_used,
    diskUsed,
    diskRBps,
    diskWBps,
    payload.net.rx_bps,
    payload.net.tx_bps,
    payload.net.rx_tot,
    payload.net.tx_tot,
    payload.net.tcp_est,
  ];
}

export function isValidCompactTuple(value: unknown): value is CompactMetricTuple {
  return (
    Array.isArray(value) &&
    value.length >= 16 &&
    value.slice(0, 16).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export function tupleToRawPoint(tuple: CompactMetricTuple): RawSlabPoint {
  return {
    ts: Math.floor(tuple[0]),
    cpu: tuple[2],
    steal: tuple[3],
    load1: tuple[5],
    mem_used: tuple[6],
    swap_used: tuple[7],
    disk_used: tuple[8],
    disk_r_bps: tuple[9],
    disk_w_bps: tuple[10],
    net_rx_bps: tuple[11],
    net_tx_bps: tuple[12],
    tcp_est: Math.max(0, Math.round(tuple[15])),
  };
}

export function rawPointToQueryPoint(point: RawSlabPoint): MetricsQueryPoint {
  return {
    ts: point.ts,
    cpu: point.cpu,
    steal: point.steal,
    load1: point.load1,
    mem_used: point.mem_used,
    swap_used: point.swap_used,
    disk_used: point.disk_used,
    disk_r_bps: point.disk_r_bps,
    disk_w_bps: point.disk_w_bps,
    net_rx_bps: point.net_rx_bps,
    net_tx_bps: point.net_tx_bps,
    tcp_est: point.tcp_est,
  };
}

export function rollupPointToQueryPoint(point: RollupSlabPoint): MetricsQueryPoint {
  return {
    ts: point.ts,
    cpu: point.cpu,
    cpu_max: point.cpu_max,
    steal: point.steal,
    load1: point.load1,
    mem_used: point.mem_used,
    mem_max: point.mem_max,
    swap_used: point.swap_used,
    disk_used: point.disk_used,
    disk_r_bps: point.disk_r_bps,
    disk_w_bps: point.disk_w_bps,
    net_rx_bps: point.net_rx_bps,
    net_tx_bps: point.net_tx_bps,
    tcp_est: point.tcp_est,
  };
}

export function chunkSlot(bucketTs: number, chunkSec: number, slabSlots: number): number {
  const index = Math.floor(bucketTs / chunkSec);
  return ((index % slabSlots) + slabSlots) % slabSlots;
}

export function chunkBucketTs(ts: number, chunkSec: number): number {
  return Math.floor(ts / chunkSec) * chunkSec;
}

export function toUint8Array(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw)) {
    return new Uint8Array(raw);
  }
  return new Uint8Array(0);
}

export function encodeRawChunk(points: RawSlabPoint[]): Uint8Array {
  const buf = new ArrayBuffer(points.length * RAW_STRIDE);
  const view = new DataView(buf);
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const off = i * RAW_STRIDE;
    view.setUint32(off, p.ts >>> 0, true);
    view.setUint32(off + 4, Math.max(0, Math.round(p.tcp_est)) >>> 0, true);
    view.setFloat32(off + 8, p.cpu, true);
    view.setFloat32(off + 12, p.steal, true);
    view.setFloat32(off + 16, p.load1, true);
    view.setFloat64(off + 20, p.mem_used, true);
    view.setFloat64(off + 28, p.swap_used, true);
    view.setFloat64(off + 36, p.disk_used, true);
    view.setFloat64(off + 44, p.disk_r_bps, true);
    view.setFloat64(off + 52, p.disk_w_bps, true);
    view.setFloat64(off + 60, p.net_rx_bps, true);
    view.setFloat64(off + 68, p.net_tx_bps, true);
  }
  return new Uint8Array(buf);
}

export function decodeRawChunk(raw: unknown): RawSlabPoint[] {
  const bytes = toUint8Array(raw);
  const count = Math.floor(bytes.byteLength / RAW_STRIDE);
  if (count <= 0) {
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * RAW_STRIDE);
  const points: RawSlabPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const off = i * RAW_STRIDE;
    points.push({
      ts: view.getUint32(off, true),
      tcp_est: view.getUint32(off + 4, true),
      cpu: view.getFloat32(off + 8, true),
      steal: view.getFloat32(off + 12, true),
      load1: view.getFloat32(off + 16, true),
      mem_used: view.getFloat64(off + 20, true),
      swap_used: view.getFloat64(off + 28, true),
      disk_used: view.getFloat64(off + 36, true),
      disk_r_bps: view.getFloat64(off + 44, true),
      disk_w_bps: view.getFloat64(off + 52, true),
      net_rx_bps: view.getFloat64(off + 60, true),
      net_tx_bps: view.getFloat64(off + 68, true),
    });
  }
  return points;
}

export function encodeRollupChunk(points: RollupSlabPoint[]): Uint8Array {
  const buf = new ArrayBuffer(points.length * ROLLUP_STRIDE);
  const view = new DataView(buf);
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const off = i * ROLLUP_STRIDE;
    view.setUint32(off, p.ts >>> 0, true);
    view.setUint32(off + 4, Math.max(0, Math.round(p.tcp_est)) >>> 0, true);
    view.setFloat32(off + 8, p.cpu, true);
    view.setFloat32(off + 12, p.cpu_max, true);
    view.setFloat32(off + 16, p.steal, true);
    view.setFloat32(off + 20, p.load1, true);
    view.setFloat64(off + 24, p.mem_used, true);
    view.setFloat64(off + 32, p.mem_max, true);
    view.setFloat64(off + 40, p.swap_used, true);
    view.setFloat64(off + 48, p.disk_used, true);
    view.setFloat64(off + 56, p.disk_r_bps, true);
    view.setFloat64(off + 64, p.disk_w_bps, true);
    view.setFloat64(off + 72, p.net_rx_bps, true);
    view.setFloat64(off + 80, p.net_tx_bps, true);
  }
  return new Uint8Array(buf);
}

export function decodeRollupChunk(raw: unknown): RollupSlabPoint[] {
  const bytes = toUint8Array(raw);
  const count = Math.floor(bytes.byteLength / ROLLUP_STRIDE);
  if (count <= 0) {
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * ROLLUP_STRIDE);
  const points: RollupSlabPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const off = i * ROLLUP_STRIDE;
    points.push({
      ts: view.getUint32(off, true),
      tcp_est: view.getUint32(off + 4, true),
      cpu: view.getFloat32(off + 8, true),
      cpu_max: view.getFloat32(off + 12, true),
      steal: view.getFloat32(off + 16, true),
      load1: view.getFloat32(off + 20, true),
      mem_used: view.getFloat64(off + 24, true),
      mem_max: view.getFloat64(off + 32, true),
      swap_used: view.getFloat64(off + 40, true),
      disk_used: view.getFloat64(off + 48, true),
      disk_r_bps: view.getFloat64(off + 56, true),
      disk_w_bps: view.getFloat64(off + 64, true),
      net_rx_bps: view.getFloat64(off + 72, true),
      net_tx_bps: view.getFloat64(off + 80, true),
    });
  }
  return points;
}

export function mergeSortedPoints<T extends { ts: number }>(
  existing: T[],
  incoming: T[],
): T[] {
  const byTs = new Map<number, T>();
  for (const point of existing) {
    byTs.set(point.ts, point);
  }
  for (const point of incoming) {
    byTs.set(point.ts, point);
  }
  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}

function createWelfordAccum(bucketTs: number, point: RawSlabPoint): WelfordAccum {
  return {
    bucket_ts: bucketTs,
    count: 1,
    cpu_sum: point.cpu,
    cpu_max: point.cpu,
    steal_sum: point.steal,
    load1_sum: point.load1,
    mem_sum: point.mem_used,
    mem_max: point.mem_used,
    swap_sum: point.swap_used,
    disk_sum: point.disk_used,
    disk_r_sum: point.disk_r_bps,
    disk_w_sum: point.disk_w_bps,
    net_rx_sum: point.net_rx_bps,
    net_tx_sum: point.net_tx_bps,
    tcp_est_sum: point.tcp_est,
  };
}

export function finalizeWelford(acc: WelfordAccum): RollupSlabPoint {
  const n = Math.max(1, acc.count);
  return {
    ts: acc.bucket_ts,
    cpu: acc.cpu_sum / n,
    cpu_max: acc.cpu_max,
    steal: acc.steal_sum / n,
    load1: acc.load1_sum / n,
    mem_used: acc.mem_sum / n,
    mem_max: acc.mem_max,
    swap_used: acc.swap_sum / n,
    disk_used: acc.disk_sum / n,
    disk_r_bps: acc.disk_r_sum / n,
    disk_w_bps: acc.disk_w_sum / n,
    net_rx_bps: acc.net_rx_sum / n,
    net_tx_bps: acc.net_tx_sum / n,
    tcp_est: Math.round(acc.tcp_est_sum / n),
  };
}

/**
 * Advances a running bucket accumulator with a chronological point.
 * Returns any closed rollup point when the sample enters a newer bucket.
 */
export function stepWelford(
  current: WelfordAccum | null,
  bucketSec: number,
  point: RawSlabPoint,
): { closed: RollupSlabPoint | null; next: WelfordAccum } {
  const bucketTs = Math.floor(point.ts / bucketSec) * bucketSec;
  if (!current) {
    return { closed: null, next: createWelfordAccum(bucketTs, point) };
  }
  if (bucketTs < current.bucket_ts) {
    return { closed: null, next: current };
  }
  if (bucketTs > current.bucket_ts) {
    return {
      closed: finalizeWelford(current),
      next: createWelfordAccum(bucketTs, point),
    };
  }
  return {
    closed: null,
    next: {
      bucket_ts: current.bucket_ts,
      count: current.count + 1,
      cpu_sum: current.cpu_sum + point.cpu,
      cpu_max: Math.max(current.cpu_max, point.cpu),
      steal_sum: current.steal_sum + point.steal,
      load1_sum: current.load1_sum + point.load1,
      mem_sum: current.mem_sum + point.mem_used,
      mem_max: Math.max(current.mem_max, point.mem_used),
      swap_sum: current.swap_sum + point.swap_used,
      disk_sum: current.disk_sum + point.disk_used,
      disk_r_sum: current.disk_r_sum + point.disk_r_bps,
      disk_w_sum: current.disk_w_sum + point.disk_w_bps,
      net_rx_sum: current.net_rx_sum + point.net_rx_bps,
      net_tx_sum: current.net_tx_sum + point.net_tx_bps,
      tcp_est_sum: current.tcp_est_sum + point.tcp_est,
    },
  };
}
