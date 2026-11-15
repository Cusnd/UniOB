import { base64UrlDecode, base64UrlEncode } from "../crypto";
import type { Env } from "../types";
import {
  nqDefaultConfig,
  nqEmptyState,
  nqLatest,
  nqMakeControl,
  nqParseConfig,
  nqParseOverride,
  nqParsePayload,
  nqRawQuery,
  nqRollup,
  nqSortTargetIds,
  type NqConfig,
  type NqControl,
  type NqOverride,
  type NqPoint,
  type NqQueryPoint,
  type NqState,
} from "../network-quality";

type JsonRow = {
  [key: string]: SqlStorageValue;
  payload: string;
  bucket_ts: number;
};
const RAW = "network_quality_chunk_10m";
const ROLLUP = "network_quality_5m_chunk_1h";
const GLOBAL = "network_quality_config";
const PREFIX = "network_quality_node:";
export const NQ_RANGE_SECONDS: Record<string, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};
const NQ_MAX_RAW_BLOCK_POINTS = 720;
const NQ_MAX_ROLLUP_BLOCK_POINTS = 2880;
const cursorEncoder = new TextEncoder();
const cursorDecoder = new TextDecoder();
function encodeCursor(cursorObj: Record<string, unknown>): string {
  return base64UrlEncode(cursorEncoder.encode(JSON.stringify(cursorObj)));
}
function decodeCursor(cursor: string): Record<string, unknown> {
  const bytes = base64UrlDecode(cursor);
  if (!bytes) throw new Error("Invalid or expired cursor");
  const parsed = JSON.parse(cursorDecoder.decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid or expired cursor");
  }
  return parsed as Record<string, unknown>;
}
const bucket = (ts: number, seconds: number) =>
  Math.floor(ts / seconds) * seconds;
const slot = (ts: number, seconds: number, count: number) =>
  Math.floor(ts / seconds) % count;
function decode<T>(value: string | undefined, raw = true): T[] {
  if (!value || value.length > (raw ? 1_000_000 : 2_000_000)) return [];
  try {
    const v = JSON.parse(value);
    if (
      v.version !== 1 ||
      !Array.isArray(v.points) ||
      v.points.length >
        (raw ? NQ_MAX_RAW_BLOCK_POINTS : NQ_MAX_ROLLUP_BLOCK_POINTS)
    )
      return [];
    for (const p of v.points) {
      if (
        !p ||
        typeof p !== "object" ||
        !p.target ||
        typeof p.target.id !== "string" ||
        !Number.isSafeInteger(p.ts) ||
        typeof p.segment_id !== "string" ||
        !p.segment_id
      )
        return [];
      if (raw && p.target_id !== p.target.id) return [];
    }
    return v.points;
  } catch {
    return [];
  }
}

/** Synchronous grouped SQLite writes. No D1 requests occur during telemetry ingestion. */
export class NetworkQualityStore {
  private settings = new Map<string, NqConfig | NqOverride>();
  private controls = new Map<string, NqControl>();
  private states = new Map<string, NqState>();
  private ready: Promise<void> | null = null;
  constructor(
    private sql: SqlStorage,
    private env: Env,
    private transaction: (fn: () => void) => void,
  ) {}

  initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS network_quality_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS network_quality_state (node_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS network_quality_chunk_10m (node_id TEXT NOT NULL, slot INTEGER NOT NULL, bucket_ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(node_id,slot));
      CREATE TABLE IF NOT EXISTS network_quality_5m_chunk_1h (node_id TEXT NOT NULL, slot INTEGER NOT NULL, bucket_ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(node_id,slot));
      CREATE INDEX IF NOT EXISTS nq_raw_time ON network_quality_chunk_10m(node_id,bucket_ts);
      CREATE INDEX IF NOT EXISTS nq_rollup_time ON network_quality_5m_chunk_1h(node_id,bucket_ts);
    `);
  }
  ensureReady(): Promise<void> {
    if (!this.ready)
      this.ready = this.load().catch((e) => {
        this.ready = null;
        throw e;
      });
    return this.ready;
  }
  private async load(): Promise<void> {
    for (const r of this.sql
      .exec<{
        node_id: string;
        payload: string;
      }>("SELECT * FROM network_quality_state")
      .toArray()) {
      try {
        this.states.set(r.node_id, JSON.parse(r.payload));
      } catch {
        /* ignore corrupt optional state */
      }
    }
    const rows = this.sql
      .exec<{
        key: string;
        value: string;
      }>("SELECT * FROM network_quality_settings")
      .toArray();
    if (!rows.some((r) => r.key === "seeded")) {
      await this.reloadSettings();
      return;
    }
    for (const r of rows) {
      try {
        if (r.key === GLOBAL)
          this.settings.set(r.key, nqParseConfig(JSON.parse(r.value)));
        else if (r.key.startsWith(PREFIX))
          this.settings.set(r.key, nqParseOverride(JSON.parse(r.value)));
      } catch {
        /* invalid imported old setting cannot enable probes */
      }
    }
    await this.buildControls();
  }
  async reloadSettings(): Promise<void> {
    const rows = await this.env.DB.prepare(
      "SELECT key,value FROM system_settings WHERE key = ? OR key LIKE ?",
    )
      .bind(GLOBAL, `${PREFIX}%`)
      .all<{ key: string; value: string }>();
    const next = new Map<string, NqConfig | NqOverride>();
    for (const r of rows.results ?? []) {
      try {
        next.set(
          r.key,
          r.key === GLOBAL
            ? nqParseConfig(JSON.parse(r.value))
            : nqParseOverride(JSON.parse(r.value)),
        );
      } catch {
        /* disabled fallback */
      }
    }
    this.transaction(() => {
      this.sql.exec("DELETE FROM network_quality_settings");
      for (const [key, value] of next)
        this.sql.exec(
          "INSERT INTO network_quality_settings(key,value) VALUES (?,?)",
          key,
          JSON.stringify(value),
        );
      this.sql.exec(
        "INSERT INTO network_quality_settings(key,value) VALUES ('seeded','1')",
      );
    });
    this.settings = next;
    await this.buildControls();
  }
  private async buildControls(): Promise<void> {
    const global =
      (this.settings.get(GLOBAL) as NqConfig | undefined) ?? nqDefaultConfig();
    const entries: Array<[string, NqControl]> = [
      ["global", await nqMakeControl(global)],
      ["off", await nqMakeControl({ ...global, enabled: false })],
    ];
    for (const [key, value] of this.settings) {
      if (key.startsWith(PREFIX) && (value as NqOverride).mode === "custom")
        entries.push([key, await nqMakeControl((value as NqOverride).config!)]);
    }
    this.controls = new Map(entries);
  }
  control(nodeId?: string): NqControl {
    const mode = nodeId
      ? (this.settings.get(PREFIX + nodeId) as NqOverride | undefined)?.mode
      : "inherit";
    return this.controls.get(
      mode === "custom" ? PREFIX + nodeId : mode === "off" ? "off" : "global",
    )!;
  }
  state(nodeId: string): NqState {
    return this.states.get(nodeId) ?? nqEmptyState();
  }
  private saveState(nodeId: string, state: NqState): void {
    if (JSON.stringify(this.states.get(nodeId)) === JSON.stringify(state))
      return;
    this.states.set(nodeId, state);
    this.sql.exec(
      "INSERT INTO network_quality_state(node_id,payload) VALUES (?,?) ON CONFLICT(node_id) DO UPDATE SET payload=excluded.payload",
      nodeId,
      JSON.stringify(state),
    );
  }
  setSupported(nodeId: string, supported: boolean): void {
    const prev = this.state(nodeId);
    this.saveState(nodeId, {
      ...prev,
      supported,
      ...(supported
        ? {}
        : {
            enabled: false,
            applied_config_id: null,
            config_error: null,
            latest: [],
          }),
    });
  }
  configResponse(nodeId?: string) {
    const effective = this.control(nodeId);
    return {
      config: nodeId
        ? (this.settings.get(PREFIX + nodeId) ?? { mode: "inherit" })
        : (this.settings.get(GLOBAL) ?? nqDefaultConfig()),
      effective_config: effective,
      config_id: effective.config_id,
      applied_config_id: nodeId ? this.state(nodeId).applied_config_id : null,
      supported: nodeId ? this.state(nodeId).supported : true,
    };
  }
  async saveConfig(value: unknown, nodeId?: string): Promise<void> {
    const parsed = nodeId ? nqParseOverride(value) : nqParseConfig(value);
    const key = nodeId ? PREFIX + nodeId : GLOBAL;
    await this.env.DB.prepare(
      "INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    )
      .bind(key, JSON.stringify(parsed), Math.floor(Date.now() / 1000))
      .run();
    this.sql.exec(
      "INSERT OR REPLACE INTO network_quality_settings(key,value) VALUES (?,?)",
      key,
      JSON.stringify(parsed),
    );
    this.settings.set(key, parsed);
    await this.buildControls();
  }
  removeNode(nodeId: string): void {
    this.states.delete(nodeId);
    this.settings.delete(PREFIX + nodeId);
    this.controls.delete(PREFIX + nodeId);
    for (const table of [RAW, ROLLUP, "network_quality_state"])
      this.sql.exec(`DELETE FROM ${table} WHERE node_id = ?`, nodeId);
    this.sql.exec(
      "DELETE FROM network_quality_settings WHERE key = ?",
      PREFIX + nodeId,
    );
  }

  private read<T>(
    table: string,
    nodeId: string,
    from: number,
    to: number,
  ): T[] {
    return this.sql
      .exec<JsonRow>(
        `SELECT bucket_ts,payload FROM ${table} WHERE node_id=? AND bucket_ts>=? AND bucket_ts<=? ORDER BY bucket_ts`,
        nodeId,
        from,
        to,
      )
      .toArray()
      .flatMap((r) => decode<T>(r.payload, table === RAW));
  }
  private block<T>(
    table: string,
    nodeId: string,
    ts: number,
    seconds: number,
    count: number,
  ): T[] {
    const row = this.sql
      .exec<JsonRow>(
        `SELECT bucket_ts,payload FROM ${table} WHERE node_id=? AND slot=?`,
        nodeId,
        slot(ts, seconds, count),
      )
      .toArray()[0];
    return row?.bucket_ts === ts ? decode<T>(row.payload, table === RAW) : [];
  }
  private write<T>(
    table: string,
    nodeId: string,
    ts: number,
    seconds: number,
    count: number,
    points: T[],
  ): void {
    const currentSlot = slot(ts, seconds, count);
    const payload = JSON.stringify({ version: 1, points });
    const updated = this.sql.exec(
      `UPDATE ${table} SET payload=? WHERE node_id=? AND slot=? AND bucket_ts=?`,
      payload,
      nodeId,
      currentSlot,
      ts,
    );
    if (updated.rowsWritten === 0) {
      this.sql.exec(
        `INSERT INTO ${table}(node_id,slot,bucket_ts,payload) VALUES (?,?,?,?) ON CONFLICT(node_id,slot) DO UPDATE SET bucket_ts=excluded.bucket_ts,payload=excluded.payload`,
        nodeId,
        currentSlot,
        ts,
        payload,
      );
    }
  }
  async ingest(nodeId: string, value: unknown, now: number): Promise<void> {
    if (!this.state(nodeId).supported) return;
    const payload = await nqParsePayload(value, now);
    if (!payload) return;
    const groups = new Map<number, NqPoint[]>();
    // Identity is per process, not per storage block. A replay with an altered
    // timestamp must not count twice in a neighboring block after reconnect.
    const seen = new Set(
      payload.points.length
        ? this.read<NqPoint>(
            RAW,
            nodeId,
            bucket(now - 1800, 600),
            bucket(now + 60, 600),
          ).map((p) => p.sample_id)
        : [],
    );
    for (const p of payload.points) {
      if (seen.has(p.sample_id)) continue;
      seen.add(p.sample_id);
      const ts = bucket(p.ts, 600);
      const list = groups.get(ts) ?? [];
      list.push(p);
      groups.set(ts, list);
    }
    this.transaction(() => {
      const affected = new Set<number>();
      for (const [ts, points] of groups) {
        const old = this.block<NqPoint>(RAW, nodeId, ts, 600, 146);
        const merged = new Map(old.map((p) => [p.sample_id, p]));
        for (const p of points) {
          if (merged.size >= NQ_MAX_RAW_BLOCK_POINTS) break;
          if (!merged.has(p.sample_id)) {
            merged.set(p.sample_id, p);
            affected.add(bucket(p.ts, 3600));
          }
        }
        // Bound malformed/excessive producers independently of reported cadence.
        if (merged.size !== old.length)
          this.write(
            RAW,
            nodeId,
            ts,
            600,
            146,
            [...merged.values()].sort(
              (a, b) => a.ts - b.ts || a.round_seq - b.round_seq,
            ),
          );
      }
      for (const hour of affected) {
        const raw = this.read<NqPoint>(RAW, nodeId, hour, hour + 3599);
        this.write(ROLLUP, nodeId, hour, 3600, 721, nqRollup(raw));
      }
      const previous = this.state(nodeId);
      const control = this.control(nodeId);
      const ack = payload.applied_config_id === control.config_id;
      let latest = previous.latest;
      if (payload.points.length && ack && control.enabled && payload.enabled) {
        const raw = this.read<NqPoint>(
          RAW,
          nodeId,
          bucket(now - 1800, 600),
          bucket(now + 60, 600),
        );
        latest = control.targets.flatMap((target) => {
          if (!control.enabled || !target.enabled) return [];
          const samples = raw.filter(
            (p) =>
              p.target_id === target.id &&
              p.target_revision === target.target_revision,
          );
          samples.sort((a, b) => b.ts - a.ts || b.round_seq - a.round_seq);
          const anchor = samples.find((p) => p.config_id === control.config_id);
          const retained = previous.latest.find(
            (p) =>
              p.target_id === target.id &&
              p.target_revision === target.target_revision,
          );
          if (retained && (!anchor || retained.measured_at > anchor.ts))
            return [retained];
          return anchor ? [nqLatest(samples, anchor)] : [];
        });
      }
      this.saveState(nodeId, {
        supported: true,
        enabled: ack ? payload.enabled : previous.enabled,
        applied_config_id: ack
          ? payload.applied_config_id
          : previous.applied_config_id,
        config_error: ack ? payload.config_error : previous.config_error,
        dropped_samples: payload.dropped_samples,
        latest,
      });
    });
  }

  query(nodeId: string, range: string, cursor?: string) {
    const duration = NQ_RANGE_SECONDS[range];
    if (!duration) throw new Error("Invalid network quality range");
    const rawRange = range === "1h" || range === "24h";
    const blockSeconds = rawRange ? 600 : 3600;
    const now = Math.floor(Date.now() / 1000);
    let to = now;
    let offset = 0;
    let resumeBucket: number | undefined;
    if (cursor) {
      try {
        const c = decodeCursor(cursor);
        if (
          c.range !== range ||
          c.node_id !== nodeId ||
          typeof c.to !== "number" ||
          !Number.isSafeInteger(c.to) ||
          c.to > now + 60 ||
          c.to < now - 1800 ||
          typeof c.offset !== "number" ||
          !Number.isSafeInteger(c.offset) ||
          c.offset < 0 ||
          c.offset >
            (rawRange ? NQ_MAX_RAW_BLOCK_POINTS : NQ_MAX_ROLLUP_BLOCK_POINTS)
        )
          throw new Error();
        if (
          c.bucket !== undefined &&
          (typeof c.bucket !== "number" ||
            !Number.isSafeInteger(c.bucket) ||
            c.bucket % blockSeconds !== 0 ||
            c.bucket < bucket(c.to - duration, blockSeconds) ||
            c.bucket > bucket(c.to, blockSeconds))
        )
          throw new Error();
        if (c.bucket === undefined && c.offset !== 0) throw new Error();
        to = c.to;
        offset = c.offset;
        resumeBucket = c.bucket;
      } catch {
        throw new Error("Invalid or expired cursor");
      }
    }
    const control = this.control(nodeId);
    const from = to - duration;
    const firstBucket = resumeBucket ?? bucket(from, blockSeconds);
    const page: NqQueryPoint[] = [];
    let bytes = 0;
    const reply = (next_cursor: string | null) => {
      const targetIds = nqSortTargetIds([
        ...control.targets.map((t) => t.id),
        ...page.map((p) => p.target.id),
      ]);
      return {
        node_id: nodeId,
        range,
        resolution_sec: rawRange ? (control.interval_sec ?? 20) : 300,
        server_time: now,
        state: this.state(nodeId),
        series: targetIds.map((target_id) => ({
          target_id,
          points: page.filter((p) => p.target.id === target_id),
        })),
        next_cursor,
      };
    };
    // Decode one block at a time. A month of frequent IP/process segments can
    // exceed the isolate's memory even though each individual response is small.
    let warmup = rawRange
      ? this.read<NqPoint>(
          RAW,
          nodeId,
          bucket(firstBucket - 120, 600),
          firstBucket - 1,
        ).filter((p) => p.ts > firstBucket - 120)
      : [];
    const rows = this.sql.exec<JsonRow>(
      `SELECT bucket_ts,payload FROM ${rawRange ? RAW : ROLLUP} WHERE node_id=? AND bucket_ts>=? AND bucket_ts<=? ORDER BY bucket_ts`,
      nodeId,
      firstBucket,
      bucket(to, blockSeconds),
    );
    let foundCursorBucket = resumeBucket === undefined || offset === 0;
    for (const row of rows) {
      let points: NqQueryPoint[];
      if (rawRange) {
        const raw = decode<NqPoint>(row.payload);
        points = nqRawQuery([...warmup, ...raw]);
        warmup = raw.filter((p) => p.ts > row.bucket_ts + 600 - 120);
      } else points = decode<NqQueryPoint>(row.payload, false);
      points = points
        .filter((p) => p.ts >= Math.max(from, row.bucket_ts) && p.ts <= to)
        .sort(
          (a, b) =>
            a.ts - b.ts ||
            (a.target.id < b.target.id
              ? -1
              : a.target.id > b.target.id
                ? 1
                : 0) ||
            (a.segment_id < b.segment_id
              ? -1
              : a.segment_id > b.segment_id
                ? 1
                : 0),
        );
      if (row.bucket_ts === resumeBucket) {
        foundCursorBucket = true;
        if (offset > 0 && offset >= points.length) {
          throw new Error("Invalid or expired cursor");
        }
      } else if (!foundCursorBucket && resumeBucket !== undefined && row.bucket_ts > resumeBucket) {
        throw new Error("Invalid or expired cursor");
      }
      for (
        let i = row.bucket_ts === firstBucket ? offset : 0;
        i < points.length;
        i++
      ) {
        const point = points[i]!;
        const size = new TextEncoder().encode(JSON.stringify(point)).length + 1;
        if (page.length && (page.length >= 3000 || bytes + size > 1_000_000))
          return reply(
            encodeCursor({
              node_id: nodeId,
              range,
              to,
              bucket: row.bucket_ts,
              offset: i,
            }),
          );
        page.push(point);
        bytes += size;
      }
    }
    if (!foundCursorBucket) {
      throw new Error("Invalid or expired cursor");
    }
    return reply(null);
  }
}
