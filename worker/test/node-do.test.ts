import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunkBucketTs,
  chunkSlot,
  CHUNK_1H_SEC,
  CHUNK_5M_SEC,
  decodeRawChunk,
  decodeRollupChunk,
  payloadToCompactTuple,
  RAW_CHUNK_SEC,
  RAW_SLAB_SLOTS,
  SLAB_1H_SLOTS,
  SLAB_5M_SLOTS,
} from "../src/do/tsdb-slab";
import type { AgentCtrlFrame, AgentMetricsBatchFrame } from "../src/types";
import {
  authedFetch,
  connectAgentWs,
  createTestNode,
  flushMicrotasks,
  makeHelloFrame,
  makeMetricsFrame,
  nextWsMessage,
  setupAndLogin,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FleetHubDO SCCH SQLite, Ring-Slab TSDB, Traffic Ledger, and Offline Alarm", () => {
  it("persists hello hardware locally, survives eviction with zero-DDL cold wake, and preserves NodeDO binding", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "evict-test" });

    const ws = await connectAgentWs(node.id, agent_token);
    ws.send(
      JSON.stringify(
        makeHelloFrame({
          hostname: "tokyo-edge-01",
          cpu_model: "Intel Xeon Platinum",
          cpu_cores: 4,
          mem_total: 4_294_967_296,
          proc_enabled: false,
        }),
      ),
    );
    await flushMicrotasks();

    // Changed hello hardware syncs to D1 nodes table so SQL queries see live hardware.
    const d1Row = await env.DB.prepare("SELECT hostname FROM nodes WHERE id = ?")
      .bind(node.id)
      .first<{ hostname: string | null }>();
    expect(d1Row?.hostname).toBe("tokyo-edge-01");

    const hub = env.FLEET_HUB_DO.getByName("global");
    const meta = await runInDurableObject(hub, (_inst, state) => {
      const schemaVer = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM hub_meta WHERE key = 'schema_version'")
        .one().value;
      const seeded = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM hub_meta WHERE key = 'mirror_seeded'")
        .one().value;
      return { schemaVer, seeded };
    });
    expect(meta.schemaVer).toBe("2");
    expect(meta.seeded).toBe("1");

    // Evict DO -> cold wake skips DDL and skips D1 mirror seeding because schema_version='2' & mirror_seeded='1'.
    await evictDurableObject(hub);

    const listRes = await authedFetch("/api/nodes", cookie);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      nodes: Array<{
        id: string;
        online: boolean;
        hostname: string;
        cpu_cores: number;
        proc_enabled: boolean;
      }>;
    };
    expect(listBody.nodes[0]).toMatchObject({
      id: node.id,
      online: true,
      hostname: "tokyo-edge-01",
      cpu_cores: 4,
      proc_enabled: false,
    });

    // After eviction + cold wake, hot-path metric frame still processes purely from local mirror.
    ws.send(JSON.stringify(makeMetricsFrame(Math.floor(Date.now() / 1000) - 5)));
    await flushMicrotasks();

    // Legacy NodeDO class remains exported and callable for migration compatibility.
    const legacyStub = env.NODE_DO.getByName("compat-node");
    const legacySnap = await legacyStub.getSnapshot();
    expect(legacySnap.online).toBe(false);

    ws.close();
  });

  it("throttles v1 raw slab writes to once per 30s, avoids redundant setAlarm on m, and schedules disconnect deadline", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "throttle-node" });
    const hub = env.FLEET_HUB_DO.getByName("global");

    const ws = await connectAgentWs(node.id, agent_token);
    ws.send(JSON.stringify(makeHelloFrame()));
    await flushMicrotasks();

    const initialAlarm = await runInDurableObject(hub, async (_inst, state) => {
      return state.storage.getAlarm();
    });
    expect(initialAlarm).not.toBeNull();

    const baseTs = Math.floor(Date.now() / 1000) - 120;
    // Send 2s frames for 10 seconds -> only 1 raw slab point should be written.
    for (let offset = 0; offset <= 10; offset += 2) {
      ws.send(
        JSON.stringify(
          makeMetricsFrame(baseTs + offset, {
            cpu: {
              all: 10 + offset,
              cores: [10 + offset],
              steal: 0,
              iowait: 0,
              load: [0.1, 0.1, 0.1],
            },
          }),
        ),
      );
    }
    await flushMicrotasks();

    const afterBurst = await runInDurableObject(hub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec<{ payload: ArrayBuffer }>(
          "SELECT payload FROM metrics_chunk_10m WHERE node_id = ?",
          node.id,
        )
        .toArray();
      const totalPts = rows.reduce((sum, r) => sum + decodeRawChunk(r.payload).length, 0);
      const alarm = await state.storage.getAlarm();
      return { totalPts, alarm };
    });
    expect(afterBurst.totalPts).toBe(1);
    expect(afterBurst.alarm).toBe(initialAlarm);

    // Send frame >= 30s later -> 2nd raw slab point written, alarm still untouched.
    ws.send(JSON.stringify(makeMetricsFrame(baseTs + 30)));
    await flushMicrotasks();

    const after30s = await runInDurableObject(hub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec<{ payload: ArrayBuffer }>(
          "SELECT payload FROM metrics_chunk_10m WHERE node_id = ?",
          node.id,
        )
        .toArray();
      const totalPts = rows.reduce((sum, r) => sum + decodeRawChunk(r.payload).length, 0);
      const alarm = await state.storage.getAlarm();
      return { totalPts, alarm };
    });
    expect(after30s.totalPts).toBe(2);
    expect(after30s.alarm).toBe(initialAlarm);

    // Closing agent WebSocket schedules event-driven 60s disconnect deadline alarm.
    ws.close(1000, "bye");
    await flushMicrotasks();

    const disconnectAlarm = await runInDurableObject(hub, async (_inst, state) => {
      return state.storage.getAlarm();
    });
    expect(disconnectAlarm).not.toBeNull();
    expect(disconnectAlarm! - Date.now()).toBeLessThanOrEqual(65_000);
    expect(disconnectAlarm!).toBeLessThan(initialAlarm!);
  });

  it("ingests v2 mb cohort batches with 25s min-gap and flushes stale cohort data on metrics query", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "cohort-node" });

    const ws = await connectAgentWs(node.id, agent_token);
    const ctrlPromise = nextWsMessage<AgentCtrlFrame>(ws, (m) => m.t === "ctrl");
    ws.send(JSON.stringify(makeHelloFrame({ v: 2, capabilities: ["batch_v2", "ctrl_v2"] })));

    const initialCtrl = await ctrlPromise;
    expect(initialCtrl).toMatchObject({
      t: "ctrl",
      mode: 0,
      interval_ms: 30000,
      batch_sec: 300,
      top_n: 0,
      lease_sec: 0,
    });

    const t0 = Math.floor(Date.now() / 1000) - 300;
    const mkPayload = (ts: number, cpuAll: number) => {
      const { t: _t, ...rest } = makeMetricsFrame(ts, {
        cpu: { all: cpuAll, cores: [cpuAll], steal: 0, iowait: 0, load: [0.3, 0.2, 0.1] },
      });
      return rest;
    };

    const batchFrame: AgentMetricsBatchFrame = {
      t: "mb",
      v: 2,
      reason: "cohort",
      pts: [
        payloadToCompactTuple(mkPayload(t0, 11)),
        payloadToCompactTuple(mkPayload(t0 + 10, 12)), // < 25s -> skipped
        payloadToCompactTuple(mkPayload(t0 + 25, 22)),
        payloadToCompactTuple(mkPayload(t0 + 55, 33)),
      ],
      last: mkPayload(t0 + 55, 33),
    };
    ws.send(JSON.stringify(batchFrame));
    await flushMicrotasks();

    const hub = env.FLEET_HUB_DO.getByName("global");
    const storedBatchCount = await runInDurableObject(hub, (_inst, state) => {
      const rows = state.storage.sql
        .exec<{ payload: ArrayBuffer }>(
          "SELECT payload FROM metrics_chunk_10m WHERE node_id = ?",
          node.id,
        )
        .toArray();
      return rows.reduce((sum, r) => sum + decodeRawChunk(r.payload).length, 0);
    });
    expect(storedBatchCount).toBe(3);

    // Since latest raw point is >35s old, GET /api/nodes/:id/metrics triggers flush_now and awaits flush batch.
    const flushCtrlPromise = nextWsMessage<AgentCtrlFrame>(
      ws,
      (m) => m.t === "ctrl" && m.flush_now === true,
    );
    const queryPromise = authedFetch(`/api/nodes/${node.id}/metrics?range=1h`, cookie);

    const flushCtrl = await flushCtrlPromise;
    expect(flushCtrl.flush_now).toBe(true);

    const freshTs = Math.floor(Date.now() / 1000) - 2;
    const freshLast = mkPayload(freshTs, 44);
    ws.send(
      JSON.stringify({
        t: "mb",
        v: 2,
        reason: "flush",
        pts: [payloadToCompactTuple(freshLast)],
        last: freshLast,
      } satisfies AgentMetricsBatchFrame),
    );

    const queryRes = await queryPromise;
    expect(queryRes.status).toBe(200);
    const queryBody = (await queryRes.json()) as {
      resolution: string;
      points: Array<{ ts: number; cpu: number }>;
    };
    expect(queryBody.resolution).toBe("30s");
    expect(queryBody.points.some((p) => p.ts === freshTs && Math.abs(p.cpu - 44) < 0.01)).toBe(
      true,
    );

    ws.close();
  });

  it("executes Welford 5m & 1h rollups on bucket boundaries and overwrites 24h ring-slab slots with zero DELETEs", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "rollup-node" });
    const hub = env.FLEET_HUB_DO.getByName("global");

    const ws = await connectAgentWs(node.id, agent_token);
    ws.send(JSON.stringify(makeHelloFrame()));

    const nowHour = Math.floor(Date.now() / 3600_000) * 3600;
    const h0 = nowHour - 26 * 3600;

    ws.send(
      JSON.stringify(
        makeMetricsFrame(h0, {
          cpu: { all: 20, cores: [20], steal: 2, iowait: 0, load: [0.5, 0.3, 0.2] },
          mem: { used: 200_000_000, avail: 800_000_000, cached: 100_000_000, swap_used: 0 },
          net: {
            rx_bps: 1_000,
            tx_bps: 2_000,
            rx_tot: 1_000,
            tx_tot: 2_000,
            tcp_est: 5,
            tcp_tw: 0,
            udp: 0,
          },
        }),
      ),
    );
    ws.send(
      JSON.stringify(
        makeMetricsFrame(h0 + 30, {
          cpu: { all: 40, cores: [40], steal: 6, iowait: 0, load: [1.5, 0.5, 0.3] },
          mem: { used: 400_000_000, avail: 600_000_000, cached: 100_000_000, swap_used: 0 },
          net: {
            rx_bps: 3_000,
            tx_bps: 4_000,
            rx_tot: 2_000,
            tx_tot: 4_000,
            tcp_est: 8,
            tcp_tw: 0,
            udp: 0,
          },
        }),
      ),
    );
    // Cross 5m boundary -> flushes Welford 5m bucket for h0
    ws.send(JSON.stringify(makeMetricsFrame(h0 + 300)));
    // Cross 1h boundary -> flushes Welford 5m & 1h buckets for h0
    ws.send(JSON.stringify(makeMetricsFrame(h0 + 3600)));
    await flushMicrotasks();

    const rollups = await runInDurableObject(hub, (_inst, state) => {
      const slot5m = chunkSlot(chunkBucketTs(h0, CHUNK_5M_SEC), CHUNK_5M_SEC, SLAB_5M_SLOTS);
      const row5m = state.storage.sql
        .exec<{ bucket_ts: number; payload: ArrayBuffer }>(
          "SELECT bucket_ts, payload FROM metrics_5m_chunk_1h WHERE node_id = ? AND slot = ?",
          node.id,
          slot5m,
        )
        .toArray()[0];
      const slot1h = chunkSlot(chunkBucketTs(h0, CHUNK_1H_SEC), CHUNK_1H_SEC, SLAB_1H_SLOTS);
      const row1h = state.storage.sql
        .exec<{ bucket_ts: number; payload: ArrayBuffer }>(
          "SELECT bucket_ts, payload FROM metrics_1h_chunk_1d WHERE node_id = ? AND slot = ?",
          node.id,
          slot1h,
        )
        .toArray()[0];
      return {
        m5: row5m ? decodeRollupChunk(row5m.payload) : [],
        m1h: row1h ? decodeRollupChunk(row1h.payload) : [],
      };
    });

    const b5 = rollups.m5.find((p) => p.ts === h0);
    expect(b5).toBeDefined();
    expect(b5!.cpu).toBeCloseTo(30);
    expect(b5!.cpu_max).toBe(40);
    expect(b5!.steal).toBeCloseTo(4);
    expect(b5!.mem_used).toBe(300_000_000);
    expect(b5!.mem_max).toBe(400_000_000);
    expect(b5!.net_rx_bps).toBe(2000);
    expect(b5!.net_tx_bps).toBe(3000);

    const b1h = rollups.m1h.find((p) => p.ts === h0);
    expect(b1h).toBeDefined();
    expect(b1h!.cpu_max).toBe(40);
    expect(b1h!.net_rx_bps).toBeGreaterThan(0);

    // Send sample exactly 86400s (144 * 600s) later -> same ring-slab slot overwrites h0 chunk without DELETE.
    ws.send(JSON.stringify(makeMetricsFrame(h0 + 86_400)));
    await flushMicrotasks();

    const wrappedSlot = await runInDurableObject(hub, (_inst, state) => {
      const slot = chunkSlot(chunkBucketTs(h0, RAW_CHUNK_SEC), RAW_CHUNK_SEC, RAW_SLAB_SLOTS);
      const row = state.storage.sql
        .exec<{ bucket_ts: number; payload: ArrayBuffer }>(
          "SELECT bucket_ts, payload FROM metrics_chunk_10m WHERE node_id = ? AND slot = ?",
          node.id,
          slot,
        )
        .one();
      const staleRows = state.storage.sql
        .exec<{ cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM metrics_chunk_10m WHERE node_id = ? AND bucket_ts <= ?",
          node.id,
          h0,
        )
        .one().cnt;
      return {
        bucket_ts: row.bucket_ts,
        points: decodeRawChunk(row.payload),
        staleRows,
      };
    });
    expect(wrappedSlot.bucket_ts).toBe(h0 + 86_400);
    expect(wrappedSlot.points.map((p) => p.ts)).toEqual([h0 + 86_400]);
    expect(wrappedSlot.staleRows).toBe(0);

    // Query 7d & 1y via REST API
    const r7d = await authedFetch(`/api/nodes/${node.id}/metrics?range=7d`, cookie);
    expect(r7d.status).toBe(200);
    const b7d = (await r7d.json()) as { resolution: string; points: unknown[] };
    expect(b7d.resolution).toBe("5m");
    expect(b7d.points.length).toBeGreaterThanOrEqual(2);

    const r1y = await authedFetch(`/api/nodes/${node.id}/metrics?range=1y`, cookie);
    expect(r1y.status).toBe(200);
    const b1y = (await r1y.json()) as { resolution: string; points: unknown[] };
    expect(b1y.resolution).toBe("1h");
    expect(b1y.points.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  it("handles monotonic traffic across OS reboots, billing cycle resets, coalesced flushes, and count modes", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, {
      name: "traffic-node",
      traffic_reset_day: 15,
      traffic_count_mode: "both",
    });

    const ws = await connectAgentWs(node.id, agent_token);
    ws.send(JSON.stringify(makeHelloFrame()));

    // Cycle 1: Nov 10, 2026 (before reset day 15 -> cycle_key = "2026-10")
    const t1 = Math.floor(Date.UTC(2026, 10, 10, 12, 0, 0) / 1000);
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t1, {
          net: { rx_bps: 0, tx_bps: 0, rx_tot: 10_000, tx_tot: 20_000, tcp_est: 1, tcp_tw: 0, udp: 0 },
        }),
      ),
    );
    // +5000 rx, +10000 tx
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t1 + 30, {
          net: { rx_bps: 0, tx_bps: 0, rx_tot: 15_000, tx_tot: 30_000, tcp_est: 1, tcp_tw: 0, udp: 0 },
        }),
      ),
    );
    // OS reboot -> counters drop to 3_000 rx, 4_000 tx
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t1 + 60, {
          net: { rx_bps: 0, tx_bps: 0, rx_tot: 3_000, tx_tot: 4_000, tcp_est: 1, tcp_tw: 0, udp: 0 },
        }),
      ),
    );
    await flushMicrotasks();

    const hub = env.FLEET_HUB_DO.getByName("global");
    const ledger1 = await runInDurableObject(hub, (_inst, state) => {
      return state.storage.sql
        .exec<{
          cycle_key: string;
          cycle_rx_bytes: number;
          cycle_tx_bytes: number;
        }>("SELECT cycle_key, cycle_rx_bytes, cycle_tx_bytes FROM node_state WHERE node_id = ?", node.id)
        .one();
    });
    expect(ledger1.cycle_key).toBe("2026-10");
    expect(ledger1.cycle_rx_bytes).toBe(8_000); // 5000 + 3000
    expect(ledger1.cycle_tx_bytes).toBe(14_000); // 10000 + 4000

    // Sub-64 MiB traffic bump within <30s is coalesced in memory rather than hitting SQLite immediately.
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t1 + 62, {
          net: { rx_bps: 0, tx_bps: 0, rx_tot: 3_500, tx_tot: 4_500, tcp_est: 1, tcp_tw: 0, udp: 0 },
        }),
      ),
    );
    await flushMicrotasks();

    const coalescedSql = await runInDurableObject(hub, (_inst, state) => {
      return state.storage.sql
        .exec<{ cycle_rx_bytes: number; cycle_tx_bytes: number }>(
          "SELECT cycle_rx_bytes, cycle_tx_bytes FROM node_state WHERE node_id = ?",
          node.id,
        )
        .one();
    });
    expect(coalescedSql.cycle_rx_bytes).toBe(8_000);
    expect(coalescedSql.cycle_tx_bytes).toBe(14_000);

    // Check count_mode via REST PATCH + FleetHubDO snapshot
    await authedFetch(`/api/nodes/${node.id}`, cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traffic_count_mode: "tx_only" }),
    });
    const snapTx = await hub.getNodeSnapshot(node.id);
    expect(snapTx.traffic.count_mode).toBe("tx_only");

    // Cross reset_day=15 -> Nov 16, 2026 -> cycle_key = "2026-11", counters reset.
    const t2 = Math.floor(Date.UTC(2026, 10, 16, 0, 1, 0) / 1000);
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t2, {
          net: { rx_bps: 0, tx_bps: 0, rx_tot: 4_000, tx_tot: 5_500, tcp_est: 1, tcp_tw: 0, udp: 0 },
        }),
      ),
    );
    await flushMicrotasks();

    const ledger2 = await runInDurableObject(hub, (_inst, state) => {
      return state.storage.sql
        .exec<{
          cycle_key: string;
          cycle_rx_bytes: number;
          cycle_tx_bytes: number;
        }>("SELECT cycle_key, cycle_rx_bytes, cycle_tx_bytes FROM node_state WHERE node_id = ?", node.id)
        .one();
    });
    expect(ledger2.cycle_key).toBe("2026-11");
    expect(ledger2.cycle_rx_bytes).toBe(500);
    expect(ledger2.cycle_tx_bytes).toBe(1_000);

    ws.close();
  });

  it("triggers offline alert in alarm(), clears idle alarm when all nodes offline, and sends recovery card on reconnect", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, {
      name: "HK-Watchdog",
      group_name: "香港",
    });

    const sentPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("https://api.telegram.org/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        sentPayloads.push({ url, body });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const chRes = await authedFetch("/api/alerts/channels", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "TG Ops",
        type: "telegram",
        config: { bot_token: "123:ABC", chat_id: "-1001", thread_id: 77 },
      }),
    });
    const { channel } = (await chRes.json()) as { channel: { id: string } };

    await authedFetch("/api/alerts/rules", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "节点离线",
        node_id: node.id,
        metric: "offline",
        operator: "gt",
        threshold: 90,
        duration_sec: 0,
        cooldown_sec: 3600,
        channel_ids: [channel.id],
      }),
    });

    const ws1 = await connectAgentWs(node.id, agent_token);
    ws1.send(JSON.stringify(makeHelloFrame()));
    await flushMicrotasks();

    const hub = env.FLEET_HUB_DO.getByName("global");
    const pastSec = Math.floor(Date.now() / 1000) - 120;
    await runInDurableObject(hub, (_inst, state) => {
      state.storage.sql.exec(
        "UPDATE node_state SET last_seen_ts = ? WHERE node_id = ?",
        pastSec,
        node.id,
      );
    });
    await evictDurableObject(hub);

    const ran = await runDurableObjectAlarm(hub);
    expect(ran).toBe(true);

    const snap = await hub.getNodeSnapshot(node.id);
    expect(snap.online).toBe(false);

    // Zero idle alarms once all nodes are offline and no browsers are connected.
    const idleAlarm = await runInDurableObject(hub, async (_inst, state) => {
      return state.storage.getAlarm();
    });
    expect(idleAlarm).toBeNull();

    const incRes1 = await authedFetch("/api/alerts/incidents?status=firing", cookie);
    const incBody1 = (await incRes1.json()) as {
      incidents: Array<{ status: string; metric: string; node_id: string }>;
      total: number;
    };
    expect(incBody1.total).toBe(1);
    expect(incBody1.incidents[0]!.metric).toBe("offline");

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(sentPayloads[0]!.body.parse_mode).toBe("HTML");
    expect(sentPayloads[0]!.body.disable_web_page_preview).toBe(true);
    expect(sentPayloads[0]!.body.message_thread_id).toBe(77);
    expect(String(sentPayloads[0]!.body.text)).toContain("🚨 <b>[UniOB 告警触发]</b>");

    // Reconnect agent -> resolves offline incident and sends recovery card.
    const ws2 = await connectAgentWs(node.id, agent_token);
    ws2.send(JSON.stringify(makeHelloFrame()));
    await flushMicrotasks();

    const snap2 = await hub.getNodeSnapshot(node.id);
    expect(snap2.online).toBe(true);

    const incRes2 = await authedFetch("/api/alerts/incidents?status=resolved", cookie);
    const incBody2 = (await incRes2.json()) as {
      incidents: Array<{ status: string; resolved_at: number | null }>;
      total: number;
    };
    expect(incBody2.total).toBe(1);
    expect(incBody2.incidents[0]!.resolved_at).not.toBeNull();

    expect(sentPayloads).toHaveLength(2);
    expect(String(sentPayloads[1]!.body.text)).toContain("✅ <b>[UniOB 故障恢复]</b>");
    expect(String(sentPayloads[1]!.body.text)).toContain("故障历时：");

    ws2.close();
    ws1.close();
  });
});
