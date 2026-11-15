import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  decodeRawChunk,
  decodeRollupChunk,
  payloadToCompactTuple,
  type RawSlabPoint,
  type RollupSlabPoint,
} from "../src/do/tsdb-slab";
import { nqEmptyState } from "../src/network-quality";
import type { AgentMetricsBatchFrame, AgentWsAttachment } from "../src/types";
import { createTestNode, makeMetricsFrame, setupAndLogin } from "./helpers";

type ResourceHub = {
  sql: SqlStorage;
  ensureNodeMirrored(nodeId: string): Promise<unknown>;
  onAgentBatch(
    ws: WebSocket,
    attachment: AgentWsAttachment,
    frame: AgentMetricsBatchFrame,
  ): Promise<void>;
};

function expectedRollups(points: RawSlabPoint[], seconds: number): RollupSlabPoint[] {
  const count = seconds / 30;
  const result: RollupSlabPoint[] = [];
  for (let i = 0; i < points.length - count; i += count) {
    const group = points.slice(i, i + count);
    const mean = (key: keyof RawSlabPoint) =>
      group.reduce((sum, point) => sum + point[key], 0) / group.length;
    result.push({
      ts: Math.floor(group[0]!.ts / seconds) * seconds,
      cpu: Math.fround(mean("cpu")),
      cpu_max: Math.max(...group.map((point) => point.cpu)),
      steal: Math.fround(mean("steal")),
      load1: Math.fround(mean("load1")),
      mem_used: mean("mem_used"),
      mem_max: Math.max(...group.map((point) => point.mem_used)),
      swap_used: mean("swap_used"),
      disk_used: mean("disk_used"),
      disk_r_bps: mean("disk_r_bps"),
      disk_w_bps: mean("disk_w_bps"),
      net_rx_bps: mean("net_rx_bps"),
      net_tx_bps: mean("net_tx_bps"),
      tcp_est: Math.round(mean("tcp_est")),
    });
  }
  return result;
}

function expectedAccumulator(points: RawSlabPoint[], seconds: number) {
  const group = points.slice(-(seconds / 30));
  const sum = (key: keyof RawSlabPoint) =>
    group.reduce((total, point) => total + point[key], 0);
  return {
    bucket_ts: Math.floor(group[0]!.ts / seconds) * seconds,
    count: group.length,
    cpu_sum: sum("cpu"),
    cpu_max: Math.max(...group.map((point) => point.cpu)),
    steal_sum: sum("steal"),
    load1_sum: sum("load1"),
    mem_sum: sum("mem_used"),
    mem_max: Math.max(...group.map((point) => point.mem_used)),
    swap_sum: sum("swap_used"),
    disk_sum: sum("disk_used"),
    disk_r_sum: sum("disk_r_bps"),
    disk_w_sum: sum("disk_w_bps"),
    net_rx_sum: sum("net_rx_bps"),
    net_tx_sum: sum("net_tx_bps"),
    tcp_est_sum: sum("tcp_est"),
  };
}

it("persists complete resource history and state with 888 Idle writes per day", async () => {
  const cookie = await setupAndLogin();
  const { node } = await createTestNode(cookie);
  const result = await runInDurableObject(
    env.FLEET_HUB_DO.getByName("global"),
    async (object) => {
      const hub = object as unknown as ResourceHub;
      await hub.ensureNodeMirrored(node.id);
      const sql = hub.sql;
      const anchor = 1_800_000_000;
      const frames = Array.from({ length: 3000 }, (_, i) => {
        const frame = makeMetricsFrame(anchor + i * 30 + 25);
        frame.up = 1000 + i * 30;
        frame.cpu.all = (i % 100) / 2;
        frame.cpu.cores = [frame.cpu.all];
        frame.cpu.steal = (i % 8) / 8;
        frame.cpu.load = [(i % 16) / 4, 0.5, 0.25];
        frame.mem.used += i * 1024;
        frame.mem.avail -= i * 1024;
        frame.mem.swap_used += i * 16;
        frame.disks[0]!.used += i * 4096;
        frame.disks[0]!.r_bps += i;
        frame.disks[0]!.w_bps += i * 2;
        frame.net.rx_bps += i;
        frame.net.tx_bps += i * 2;
        frame.net.rx_tot += i * 1000;
        frame.net.tx_tot += i * 2000;
        frame.net.tcp_est += i % 5;
        return frame;
      });
      const expectedRaw: RawSlabPoint[] = frames.map((frame) => ({
        ts: frame.ts,
        cpu: frame.cpu.all,
        steal: frame.cpu.steal,
        load1: frame.cpu.load[0]!,
        mem_used: frame.mem.used,
        swap_used: frame.mem.swap_used,
        disk_used: frame.disks[0]!.used,
        disk_r_bps: frame.disks[0]!.r_bps,
        disk_w_bps: frame.disks[0]!.w_bps,
        net_rx_bps: frame.net.rx_bps,
        net_tx_bps: frame.net.tx_bps,
        tcp_est: frame.net.tcp_est,
      }));
      for (const [table, seconds, count] of [
        ["metrics_chunk_10m", 600, 144],
        ["metrics_5m_chunk_1h", 3600, 720],
        ["metrics_1h_chunk_1d", 86400, 366],
      ] as const) {
        const aligned = Math.floor(anchor / seconds) * seconds;
        for (let i = 0; i < count; i++) {
          const ts = aligned - (count - i) * seconds;
          sql.exec(
            `INSERT OR REPLACE INTO ${table}(node_id,slot,bucket_ts,payload) VALUES (?,?,?,?)`,
            node.id,
            Math.floor(ts / seconds) % count,
            ts,
            new ArrayBuffer(0),
          );
        }
      }
      const attachment: AgentWsAttachment = {
        role: "agent",
        nodeId: node.id,
        ver: 2,
        mode: 0,
        caps: ["mb_v2"],
      };
      const ws = {
        serializeAttachment() {},
        deserializeAttachment() {
          return attachment;
        },
        send() {},
        readyState: 1,
      } as unknown as WebSocket;
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      hub.sql = {
        exec(...args: Parameters<SqlStorage["exec"]>) {
          const cursor = sql.exec(...args);
          cursors.push(cursor);
          return cursor;
        },
      } as SqlStorage;
      try {
        for (let batch = 0; batch < 300; batch++) {
          const points = frames.slice(batch * 10, (batch + 1) * 10);
          const { t: _type, ...last } = points.at(-1)!;
          await hub.onAgentBatch(ws, attachment, {
            t: "mb",
            v: 2,
            reason: "cohort",
            pts: points.map(payloadToCompactTuple),
            last,
          });
          if (batch === 11) cursors.length = 0;
        }
      } finally {
        hub.sql = sql;
      }
      const readBlocks = <T>(table: string, decode: (payload: unknown) => T[]) =>
        sql
          .exec<{ payload: ArrayBuffer }>(
            `SELECT payload FROM ${table} WHERE node_id=? ORDER BY bucket_ts`,
            node.id,
          )
          .toArray()
          .flatMap((row) => decode(row.payload));
      expect(readBlocks("metrics_chunk_10m", decodeRawChunk)).toEqual(
        expectedRaw.slice(-2880),
      );
      expect(readBlocks("metrics_5m_chunk_1h", decodeRollupChunk)).toEqual(
        expectedRollups(expectedRaw, 300),
      );
      expect(readBlocks("metrics_1h_chunk_1d", decodeRollupChunk)).toEqual(
        expectedRollups(expectedRaw, 3600),
      );
      const stored = sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT * FROM node_state WHERE node_id=?",
          node.id,
        )
        .one();
      const { t: _type, ...last } = frames.at(-1)!;
      expect(stored).toMatchObject({
        node_id: node.id,
        online: 1,
        offline_deadline_ms: null,
        last_seen_ts: expect.any(Number),
        cycle_key: "2027-01",
        last_agent_rx: last.net.rx_tot,
        last_agent_tx: last.net.tx_tot,
        cycle_rx_bytes: last.net.rx_tot - frames[0]!.net.rx_tot,
        cycle_tx_bytes: last.net.tx_tot - frames[0]!.net.tx_tot,
        traffic_updated_at: last.ts,
        last_flush_rx_tot: last.net.rx_tot,
        last_flush_tx_tot: last.net.tx_tot,
        last_raw_ts: last.ts,
        last_boot_up: last.up,
        hw_json: null,
      });
      expect(JSON.parse(stored.last_metrics_json as string)).toEqual({
        ...last,
        network_quality: nqEmptyState(),
      });
      expect(JSON.parse(stored.welford_5m_json as string)).toEqual(
        expectedAccumulator(expectedRaw, 300),
      );
      expect(JSON.parse(stored.welford_1h_json as string)).toEqual(
        expectedAccumulator(expectedRaw, 3600),
      );
      return {
        rowsWritten: cursors.reduce((total, cursor) => total + cursor.rowsWritten, 0),
      };
    },
  );
  expect(result.rowsWritten).toBe(888);
}, 60000);
