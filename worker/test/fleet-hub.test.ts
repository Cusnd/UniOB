import {
  evictDurableObject,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { payloadToCompactTuple } from "../src/do/tsdb-slab";
import type { AgentCtrlFrame } from "../src/types";
import {
  authedFetch,
  connectAgentWs,
  connectClientWs,
  createTestNode,
  flushMicrotasks,
  makeHelloFrame,
  makeMetricsFrame,
  nextWsMessage,
  setupAndLogin,
} from "./helpers";

describe("FleetHubDO Multiplexed WebSocket & Watch Lease Transitions", () => {
  it("makes zero cross-DO calls when 0 browsers are connected", async () => {
    const cookie = await setupAndLogin();
    const { node } = await createTestNode(cookie, { name: "idle-node" });

    // Trigger Hub alarm with 0 connected clients
    const hub = env.FLEET_HUB_DO.getByName("global");
    await runInDurableObject(hub, async (_inst, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const ran = await runDurableObjectAlarm(hub);
    expect(ran).toBe(true);

    // FleetHubDO holds local node snapshot, sets no alarm when 0 browsers & 0 online agents, and creates 0 NodeDOs
    const snap = await hub.getNodeSnapshot(node.id);
    expect(snap.online).toBe(false);

    const nextHubAlarm = await runInDurableObject(hub, (_inst, state) =>
      state.storage.getAlarm(),
    );
    expect(nextHubAlarm).toBeNull();
    expect((await listDurableObjectIds(env.FLEET_HUB_DO)).length).toBe(1);
    expect((await listDurableObjectIds(env.NODE_DO)).length).toBe(0);
  });

  it("toggles Agent ctrl modes 0 <-> 1 <-> 2 and streams fleet_tick / node_detail", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "hub-node" });

    const agentWs = await connectAgentWs(node.id, agent_token);
    agentWs.send(JSON.stringify(makeHelloFrame()));
    await flushMicrotasks();

    const clientWs = await connectClientWs(cookie);

    // 1. Ping -> Pong
    const pongPromise = nextWsMessage<{ t: string }>(
      clientWs,
      (m) => m.t === "pong",
    );
    clientWs.send(JSON.stringify({ op: "ping" }));
    expect(await pongPromise).toEqual({ t: "pong" });

    // 2. sub_node(proc: false) -> Agent gets ctrl mode 1 (LIVE)
    const ctrlMode1 = nextWsMessage<AgentCtrlFrame>(
      agentWs,
      (m) => m.t === "ctrl" && m.mode === 1,
    );
    clientWs.send(JSON.stringify({ op: "sub_node", nodeId: node.id, proc: false }));
    const c1 = await ctrlMode1;
    expect(c1).toEqual({
      t: "ctrl",
      mode: 1,
      interval_ms: 2000,
      top_n: 30,
      lease_sec: 90,
    });

    // 3. sub_node(proc: true) -> Agent gets ctrl mode 2 (LIVE_PROC)
    const ctrlMode2 = nextWsMessage<AgentCtrlFrame>(
      agentWs,
      (m) => m.t === "ctrl" && m.mode === 2,
    );
    clientWs.send(JSON.stringify({ op: "sub_node", nodeId: node.id, proc: true }));
    const c2 = await ctrlMode2;
    expect(c2.mode).toBe(2);

    // 4. sub_fleet + Agent sends metrics with procs -> Browser receives fleet_tick & node_detail with procs
    clientWs.send(JSON.stringify({ op: "sub_fleet" }));
    await flushMicrotasks();

    const fleetTickPromise = nextWsMessage<{
      t: string;
      nodeId: string;
      online: boolean;
    }>(clientWs, (m) => m.t === "fleet_tick" && m.nodeId === node.id);

    const detailWithProcPromise = nextWsMessage<{
      t: string;
      nodeId: string;
      procs?: Array<{ pid: number; comm: string }>;
    }>(clientWs, (m) => m.t === "node_detail" && m.nodeId === node.id);

    const nowSec = Math.floor(Date.now() / 1000);
    agentWs.send(
      JSON.stringify(
        makeMetricsFrame(nowSec, {
          procs: [
            {
              pid: 123,
              user: "root",
              comm: "nginx",
              st: "S",
              cpu: 2.5,
              rss: 1024000,
              thr: 2,
              cmd: "nginx: master",
            },
          ],
        }),
      ),
    );

    const tick = await fleetTickPromise;
    expect(tick.online).toBe(true);

    const detail = await detailWithProcPromise;
    expect(detail.procs).toHaveLength(1);
    expect(detail.procs![0]!.comm).toBe("nginx");

    // 5. Downgrade sub_node(proc: false) -> ctrl mode 1
    const downgrade1 = nextWsMessage<AgentCtrlFrame>(
      agentWs,
      (m) => m.t === "ctrl" && m.mode === 1,
    );
    clientWs.send(JSON.stringify({ op: "sub_node", nodeId: node.id, proc: false }));
    expect((await downgrade1).mode).toBe(1);

    // Detail frame should NOT include procs when proc: false
    const detailNoProcPromise = nextWsMessage<{
      t: string;
      nodeId: string;
      procs?: unknown;
    }>(clientWs, (m) => m.t === "node_detail" && m.nodeId === node.id);
    agentWs.send(
      JSON.stringify(
        makeMetricsFrame(nowSec + 2, {
          procs: [
            {
              pid: 123,
              user: "root",
              comm: "nginx",
              st: "S",
              cpu: 2.5,
              rss: 1024000,
              thr: 2,
              cmd: "nginx: master",
            },
          ],
        }),
      ),
    );
    const detailNoProc = await detailNoProcPromise;
    expect(detailNoProc.procs).toBeUndefined();

    // 6. Close client WS -> immediately downgrades Agent to ctrl mode 0 (IDLE)
    const downgrade0 = nextWsMessage<AgentCtrlFrame>(
      agentWs,
      (m) => m.t === "ctrl" && m.mode === 0,
    );
    clientWs.close();
    expect((await downgrade0).mode).toBe(0);

    // Verify Hub switches to 15m safety alarm while agent remains online and clears to null when offline & idle
    await flushMicrotasks();
    const hub = env.FLEET_HUB_DO.getByName("global");
    const safetyAlarm = await runInDurableObject(hub, (_inst, state) =>
      state.storage.getAlarm(),
    );
    expect(safetyAlarm).not.toBeNull();
    expect(safetyAlarm! - Date.now()).toBeGreaterThan(10 * 60_000);

    agentWs.close();
    await flushMicrotasks();
    await runInDurableObject(hub, (_inst, state) => {
      state.storage.sql.exec(
        "UPDATE node_state SET last_seen_ts = ?, offline_deadline_ms = ? WHERE node_id = ?",
        Math.floor(Date.now() / 1000) - 120,
        Date.now() - 1000,
        node.id,
      );
    });
    await evictDurableObject(hub);
    await runDurableObjectAlarm(hub);
    const idleAlarm = await runInDurableObject(hub, (_inst, state) =>
      state.storage.getAlarm(),
    );
    expect(idleAlarm).toBeNull();
    expect((await listDurableObjectIds(env.NODE_DO)).length).toBe(0);
  });

  it("immediately leases newly created nodes for active fleet subscribers so initial hello pushes fleet_tick", async () => {
    const cookie = await setupAndLogin();

    // 1. With 0 browsers connected, creating a node leaves v2 agent in idle cohort mode 0
    const unWatched = await createTestNode(cookie, { name: "unwatched-new-node" });
    expect((await listDurableObjectIds(env.NODE_DO)).length).toBe(0);
    const unwatchedWs = await connectAgentWs(unWatched.node.id, unWatched.agent_token);
    const v2IdleCtrlPromise = nextWsMessage<AgentCtrlFrame>(
      unwatchedWs,
      (m) => m.t === "ctrl" && m.mode === 0,
    );
    unwatchedWs.send(JSON.stringify(makeHelloFrame({ v: 2, capabilities: ["mb", "migrate"] })));
    const v2IdleCtrl = await v2IdleCtrlPromise;
    expect(v2IdleCtrl).toEqual({
      t: "ctrl",
      mode: 0,
      interval_ms: 30000,
      batch_sec: 300,
      top_n: 0,
      lease_sec: 0,
    });

    // 2. Browser connects and subscribes to fleet -> receives fleet_batch and upgrades agent to FLEET_PULSE (10000ms, top_n: 0)
    const clientWs = await connectClientWs(cookie);
    const fleetBatchPromise = nextWsMessage<{ t: string; ticks: Array<{ nodeId: string }> }>(
      clientWs,
      (m) => m.t === "fleet_batch",
    );
    const fleetPulsePromise = nextWsMessage<AgentCtrlFrame>(
      unwatchedWs,
      (m) => m.t === "ctrl" && m.mode === 1 && m.interval_ms === 10000,
    );
    clientWs.send(JSON.stringify({ op: "sub_fleet" }));
    const batch = await fleetBatchPromise;
    expect(batch.ticks.some((t) => t.nodeId === unWatched.node.id)).toBe(true);
    expect(await fleetPulsePromise).toEqual({
      t: "ctrl",
      mode: 1,
      interval_ms: 10000,
      top_n: 0,
      lease_sec: 90,
    });

    // Auto-response handles exact '{"op":"ping"}' -> '{"t":"pong"}'
    const pongPromise = nextWsMessage<{ t: string }>(
      clientWs,
      (m) => m.t === "pong",
    );
    clientWs.send('{"op":"ping"}');
    await pongPromise;

    // 3. Create new node while AddNodeModal/Dashboard is open (no FleetHubDO alarm run!)
    const created = await createTestNode(cookie, { name: "brand-new-node" });

    // 4. Agent connects immediately and sends hello -> ctrl mode 1 (10000ms FLEET_PULSE) & instant fleet_tick w/ hardware
    const fleetTickPromise = nextWsMessage<{
      t: string;
      nodeId: string;
      online: boolean;
      hardware?: {
        hostname: string | null;
        os: string | null;
        arch: string | null;
      };
    }>(clientWs, (m) => m.t === "fleet_tick" && m.nodeId === created.node.id);

    const agentWs = await connectAgentWs(created.node.id, created.agent_token);
    const ctrlPromise = nextWsMessage<AgentCtrlFrame>(
      agentWs,
      (m) => m.t === "ctrl" && m.mode === 1 && m.interval_ms === 10000,
    );

    agentWs.send(
      JSON.stringify(
        makeHelloFrame({
          hostname: "fresh-host-01",
          os: "Ubuntu 24.04 LTS",
          arch: "aarch64",
        }),
      ),
    );

    expect((await ctrlPromise).mode).toBe(1);
    const tick = await fleetTickPromise;
    expect(tick.online).toBe(true);
    expect(tick.hardware).toMatchObject({
      hostname: "fresh-host-01",
      os: "Ubuntu 24.04 LTS",
      arch: "aarch64",
    });

    agentWs.close();
    clientWs.close();
  });

  it("broadcasts alert_change with accurate activeAlertsCount on fire, resolve, offline alarm, hello recovery, and node deletion", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "alert-ws-node" });

    await authedFetch("/api/alerts/rules", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "CPU High",
        node_id: node.id,
        metric: "cpu",
        operator: "gt",
        threshold: 80,
        duration_sec: 0,
        cooldown_sec: 3600,
        channel_ids: [],
      }),
    });
    await authedFetch("/api/alerts/rules", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Node Offline",
        node_id: node.id,
        metric: "offline",
        operator: "gt",
        threshold: 90,
        duration_sec: 0,
        cooldown_sec: 3600,
        channel_ids: [],
      }),
    });

    const clientWs = await connectClientWs(cookie);
    const pongPromise = nextWsMessage<{ t: string }>(
      clientWs,
      (m) => m.t === "pong",
    );
    clientWs.send(JSON.stringify({ op: "sub_fleet" }));
    clientWs.send(JSON.stringify({ op: "ping" }));
    await pongPromise;

    const agentWs = await connectAgentWs(node.id, agent_token);
    agentWs.send(JSON.stringify(makeHelloFrame()));
    await flushMicrotasks();

    // 1. CPU breach fires -> alert_change { activeAlertsCount: 1 }
    const baseTs = Math.floor(Date.now() / 1000) - 30;
    const cpuFireMsg = nextWsMessage<{ t: string; activeAlertsCount?: number }>(
      clientWs,
      (m) => m.t === "alert_change",
    );
    agentWs.send(
      JSON.stringify(
        makeMetricsFrame(baseTs, {
          cpu: { all: 95, cores: [95], steal: 0, iowait: 0, load: [1, 1, 1] },
        }),
      ),
    );
    expect(await cpuFireMsg).toEqual({ t: "alert_change", activeAlertsCount: 1 });

    // 2. Two consecutive hysteresis recovery samples -> alert_change { activeAlertsCount: 0 }
    const cpuResolveMsg = nextWsMessage<{ t: string; activeAlertsCount?: number }>(
      clientWs,
      (m) => m.t === "alert_change",
    );
    agentWs.send(
      JSON.stringify(
        makeMetricsFrame(baseTs + 2, {
          cpu: { all: 70, cores: [70], steal: 0, iowait: 0, load: [0.2, 0.2, 0.2] },
        }),
      ),
    );
    agentWs.send(
      JSON.stringify(
        makeMetricsFrame(baseTs + 4, {
          cpu: { all: 70, cores: [70], steal: 0, iowait: 0, load: [0.2, 0.2, 0.2] },
        }),
      ),
    );
    expect(await cpuResolveMsg).toEqual({ t: "alert_change", activeAlertsCount: 0 });

    // 3. Offline alarm fires -> alert_change { activeAlertsCount: 1 }
    const stub = env.FLEET_HUB_DO.getByName("global");
    const pastSec = Math.floor(Date.now() / 1000) - 120;
    await runInDurableObject(stub, (_inst, state) => {
      state.storage.sql.exec(
        "UPDATE node_state SET last_seen_ts = ? WHERE node_id = ?",
        pastSec,
        node.id,
      );
    });
    await evictDurableObject(stub);

    const offlineFireMsg = nextWsMessage<{ t: string; activeAlertsCount?: number }>(
      clientWs,
      (m) => m.t === "alert_change",
    );
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    expect(await offlineFireMsg).toEqual({ t: "alert_change", activeAlertsCount: 1 });

    // 4. Reconnect hello resolves offline -> alert_change { activeAlertsCount: 0 }
    const offlineResolveMsg = nextWsMessage<{ t: string; activeAlertsCount?: number }>(
      clientWs,
      (m) => m.t === "alert_change",
    );
    const agentWs2 = await connectAgentWs(node.id, agent_token);
    agentWs2.send(JSON.stringify(makeHelloFrame()));
    expect(await offlineResolveMsg).toEqual({ t: "alert_change", activeAlertsCount: 0 });

    // 5. Firing incident + DELETE /api/nodes/:id -> alert_change { activeAlertsCount: 0 }
    const cpuFireAgainMsg = nextWsMessage<{ t: string; activeAlertsCount?: number }>(
      clientWs,
      (m) => m.t === "alert_change",
    );
    agentWs2.send(
      JSON.stringify(
        makeMetricsFrame(Math.floor(Date.now() / 1000), {
          cpu: { all: 96, cores: [96], steal: 0, iowait: 0, load: [1, 1, 1] },
        }),
      ),
    );
    expect(await cpuFireAgainMsg).toEqual({ t: "alert_change", activeAlertsCount: 1 });

    const deleteResolveMsg = nextWsMessage<{ t: string; activeAlertsCount?: number }>(
      clientWs,
      (m) => m.t === "alert_change",
    );
    const delRes = await authedFetch(`/api/nodes/${node.id}`, cookie, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(await deleteResolveMsg).toEqual({ t: "alert_change", activeAlertsCount: 0 });

    agentWs2.close();
    agentWs.close();
    clientWs.close();
  });

  it("keeps open Mode-0 v2 cohort agents online for 300s+ silence and marks offline at >= 390s", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "cohort-silent" });

    const ws = await connectAgentWs(node.id, agent_token);
    const initCtrl = nextWsMessage<AgentCtrlFrame>(ws, (m) => m.t === "ctrl");
    ws.send(JSON.stringify(makeHelloFrame({ v: 2, capabilities: ["mb_v2"] })));
    expect((await initCtrl).mode).toBe(0);

    // Note: Do NOT evict DO here so WebSocket connection stays open in the active DO isolate!
    // Update both SQLite and in-memory state via a synthetic silence age test inside runInDurableObject?
    // Even better: check attachment after -200s by mutating node_state + evict? Wait: evictDurableObject closes open test WS sockets!
    // Wait: test open socket via inspecting DO alarm without eviction after simulating last_seen_ts in SQLite OR let's verify!
    const hub = env.FLEET_HUB_DO.getByName("global");
    // Open sockets keep v2 mode=0 alive at -200s; use eval helper to shift last_seen_ts on active instance!
    await runInDurableObject(hub, (inst, state) => {
      const states = (inst as unknown as { nodeStates: Map<string, { last_seen_ts: number | null }> })
        .nodeStates;
      const entry = states.get(node.id);
      if (entry) {
        entry.last_seen_ts = Math.floor(Date.now() / 1000) - 200;
      }
      state.storage.sql.exec(
        "UPDATE node_state SET last_seen_ts = ? WHERE node_id = ?",
        Math.floor(Date.now() / 1000) - 200,
        node.id,
      );
    });
    await runDurableObjectAlarm(hub);
    expect((await hub.getNodeSnapshot(node.id)).online).toBe(true);

    // Advance silence past 390s (300s cohort + 90s grace) -> alarm marks offline.
    await runInDurableObject(hub, (inst, state) => {
      const states = (inst as unknown as { nodeStates: Map<string, { last_seen_ts: number | null }> })
        .nodeStates;
      const entry = states.get(node.id);
      if (entry) {
        entry.last_seen_ts = Math.floor(Date.now() / 1000) - 400;
      }
      state.storage.sql.exec(
        "UPDATE node_state SET last_seen_ts = ? WHERE node_id = ?",
        Math.floor(Date.now() / 1000) - 400,
        node.id,
      );
    });
    await runDurableObjectAlarm(hub);
    expect((await hub.getNodeSnapshot(node.id)).online).toBe(false);

    ws.close();
  });

  it("extends active client watch lease via { op: 'renew' } without re-pushing fleet_batch or ctrl", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "lease-renew" });

    const agentWs = await connectAgentWs(node.id, agent_token);
    const initCtrl = nextWsMessage<AgentCtrlFrame>(agentWs, (m) => m.t === "ctrl");
    agentWs.send(JSON.stringify(makeHelloFrame({ v: 2 })));
    await initCtrl;

    const clientWs = await connectClientWs(cookie);
    const fleetBatch = nextWsMessage<{ t: string }>(clientWs, (m) => m.t === "fleet_batch");
    const ctrlPulse = nextWsMessage<AgentCtrlFrame>(
      agentWs,
      (m) => m.t === "ctrl" && m.mode === 1 && m.interval_ms === 10000,
    );
    clientWs.send(JSON.stringify({ op: "sub_fleet" }));
    await fleetBatch;
    await ctrlPulse;

    const hub = env.FLEET_HUB_DO.getByName("global");
    // Shorten client attachment exp to now + 10s so renew proves it resets back to +90s
    await runInDurableObject(hub, (_inst, state) => {
      for (const sock of state.getWebSockets("client")) {
        const att = sock.deserializeAttachment() as Record<string, unknown>;
        sock.serializeAttachment({ ...att, exp: Math.floor(Date.now() / 1000) + 10 });
      }
    });

    let extraBatchOnClient = false;
    let extraCtrlOnAgent = false;
    clientWs.addEventListener("message", (ev) => {
      const data = JSON.parse(String(ev.data)) as { t?: string };
      if (data.t === "fleet_batch") extraBatchOnClient = true;
    });
    agentWs.addEventListener("message", (ev) => {
      const data = JSON.parse(String(ev.data)) as { t?: string };
      if (data.t === "ctrl") extraCtrlOnAgent = true;
    });

    const beforeRenewSec = Math.floor(Date.now() / 1000);
    clientWs.send(JSON.stringify({ op: "renew" }));
    await flushMicrotasks();

    expect(extraBatchOnClient).toBe(false);
    expect(extraCtrlOnAgent).toBe(false);

    const expAfterRenew = await runInDurableObject(hub, (_inst, state) => {
      const sock = state.getWebSockets("client")[0]!;
      return (sock.deserializeAttachment() as { exp?: number }).exp ?? 0;
    });
    expect(expAfterRenew).toBeGreaterThanOrEqual(beforeRenewSec + 85);

    // Running alarm while renewed keeps subscription alive
    await runDurableObjectAlarm(hub);
    const fleetAfterAlarm = await runInDurableObject(hub, (_inst, state) => {
      const sock = state.getWebSockets("client")[0]!;
      return (sock.deserializeAttachment() as { fleet?: boolean }).fleet;
    });
    expect(fleetAfterAlarm).toBe(true);

    // Expiring exp without renew clears fleet subscription & downgrades agent to mode 0
    await runInDurableObject(hub, (_inst, state) => {
      for (const sock of state.getWebSockets("client")) {
        const att = sock.deserializeAttachment() as Record<string, unknown>;
        sock.serializeAttachment({ ...att, exp: Math.floor(Date.now() / 1000) - 5 });
      }
    });
    const downgrade0 = nextWsMessage<AgentCtrlFrame>(
      agentWs,
      (m) => m.t === "ctrl" && m.mode === 0,
    );
    await runDurableObjectAlarm(hub);
    expect((await downgrade0).mode).toBe(0);

    clientWs.close();
    agentWs.close();
  });

  it("lazily hydrates D1-inserted nodes into FleetHubDO and writes changed hardware back to D1 on hello", async () => {
    const cookie = await setupAndLogin();
    const hub = env.FLEET_HUB_DO.getByName("global");

    // Seed FleetHubDO while D1 has 0 nodes so mirror_seeded = '1'
    const initialListRes = await authedFetch("/api/nodes", cookie);
    expect(initialListRes.status).toBe(200);
    const seededCheck = await runInDurableObject(hub, (_inst, state) => {
      const meta = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM hub_meta WHERE key = 'mirror_seeded'")
        .one();
      const count = state.storage.sql
        .exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM nodes_mirror")
        .one().cnt;
      return { seeded: meta.value, count };
    });
    expect(seededCheck).toEqual({ seeded: "1", count: 0 });

    const insertDirectNode = async (id: string, name: string, rawToken: string) => {
      const tokenHash = await sha256Hex(rawToken);
      const nowSec = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO nodes (
          id, name, group_name, tags_json, sort_order, token_sha256,
          traffic_reset_day, traffic_count_mode, proc_enabled, created_at, updated_at
        ) VALUES (?, ?, 'CLI', '[]', 0, ?, 1, 'both', 1, ?, ?)`,
      )
        .bind(id, name, tokenHash, nowSec, nowSec)
        .run();
    };

    // 1. Node A inserted directly into D1 -> hello hydrates DO mirror and writes hardware back to D1
    const tokenA = "uob_live_CliNodeAToken0123456789abcdefghijkl";
    await insertDirectNode("cli_node_a", "cli-a", tokenA);

    const wsA = await connectAgentWs("cli_node_a", tokenA);
    wsA.send(
      JSON.stringify(
        makeHelloFrame({
          v: 2,
          agent_ver: "0.2.0",
          hostname: "cli-host-a",
          os: "Debian GNU/Linux 13 (trixie)",
          kernel: "6.12.0-amd64",
          arch: "x86_64",
          cpu_model: "AMD EPYC 9654",
          cpu_cores: 2,
          mem_total: 2_000_000_000,
          swap_total: 500_000_000,
          proc_enabled: false,
        }),
      ),
    );
    await flushMicrotasks();

    const mirrorA = await runInDurableObject(hub, (_inst, state) =>
      state.storage.sql
        .exec<{ id: string; hostname: string | null; proc_enabled: number }>(
          "SELECT id, hostname, proc_enabled FROM nodes_mirror WHERE id = ?",
          "cli_node_a",
        )
        .toArray(),
    );
    expect(mirrorA).toEqual([{ id: "cli_node_a", hostname: "cli-host-a", proc_enabled: 0 }]);

    const dbRowA1 = await env.DB.prepare(
      "SELECT hostname, os, kernel, arch, cpu_model, cpu_cores, mem_total, swap_total, agent_version, proc_enabled, updated_at FROM nodes WHERE id = ?",
    )
      .bind("cli_node_a")
      .first<Record<string, unknown>>();
    expect(dbRowA1).toMatchObject({
      hostname: "cli-host-a",
      os: "Debian GNU/Linux 13 (trixie)",
      kernel: "6.12.0-amd64",
      arch: "x86_64",
      cpu_model: "AMD EPYC 9654",
      cpu_cores: 2,
      mem_total: 2_000_000_000,
      swap_total: 500_000_000,
      agent_version: "0.2.0",
      proc_enabled: 0,
    });

    // Sentinel updated_at in D1 to assert 0 D1 writes when hello hardware is unchanged
    await env.DB.prepare("UPDATE nodes SET updated_at = 12345 WHERE id = ?")
      .bind("cli_node_a")
      .run();

    wsA.send(
      JSON.stringify(
        makeHelloFrame({
          v: 2,
          agent_ver: "0.2.0",
          hostname: "cli-host-a",
          os: "Debian GNU/Linux 13 (trixie)",
          kernel: "6.12.0-amd64",
          arch: "x86_64",
          cpu_model: "AMD EPYC 9654",
          cpu_cores: 2,
          mem_total: 2_000_000_000,
          swap_total: 500_000_000,
          proc_enabled: false,
        }),
      ),
    );
    await flushMicrotasks();

    const dbAfterUnchanged = await env.DB.prepare(
      "SELECT updated_at, agent_version FROM nodes WHERE id = ?",
    )
      .bind("cli_node_a")
      .first<{ updated_at: number; agent_version: string }>();
    expect(dbAfterUnchanged).toEqual({ updated_at: 12345, agent_version: "0.2.0" });

    // Changing a static field triggers D1 writeback again
    wsA.send(
      JSON.stringify(
        makeHelloFrame({
          v: 2,
          agent_ver: "0.3.0",
          hostname: "cli-host-a",
          os: "Debian GNU/Linux 13 (trixie)",
          kernel: "6.12.0-amd64",
          arch: "x86_64",
          cpu_model: "AMD EPYC 9654",
          cpu_cores: 2,
          mem_total: 2_000_000_000,
          swap_total: 500_000_000,
          proc_enabled: false,
        }),
      ),
    );
    await flushMicrotasks();

    const dbAfterChanged = await env.DB.prepare(
      "SELECT updated_at, agent_version FROM nodes WHERE id = ?",
    )
      .bind("cli_node_a")
      .first<{ updated_at: number; agent_version: string }>();
    expect(dbAfterChanged?.agent_version).toBe("0.3.0");
    expect(dbAfterChanged?.updated_at).toBeGreaterThan(12345);
    wsA.close();

    // 2. Node B inserted directly into D1 -> onAgentMetrics lazily hydrates instead of dropping frames
    const tokenB = "uob_live_CliNodeBToken0123456789abcdefghijkl";
    await insertDirectNode("cli_node_b", "cli-b", tokenB);
    const wsB = await connectAgentWs("cli_node_b", tokenB);
    const tsB = Math.floor(Date.now() / 1000) - 30;
    wsB.send(JSON.stringify(makeMetricsFrame(tsB)));
    await flushMicrotasks();

    const snapB = await hub.getNodeSnapshot("cli_node_b");
    expect(snapB.online).toBe(true);
    expect(snapB.metrics?.ts).toBe(tsB);
    wsB.close();

    // 3. Node C inserted directly into D1 -> onAgentBatch lazily hydrates instead of dropping frames
    const tokenC = "uob_live_CliNodeCToken0123456789abcdefghijkl";
    await insertDirectNode("cli_node_c", "cli-c", tokenC);
    const wsC = await connectAgentWs("cli_node_c", tokenC);
    const tsC = Math.floor(Date.now() / 1000) - 20;
    const { t: _t, ...payloadC } = makeMetricsFrame(tsC);
    wsC.send(
      JSON.stringify({
        t: "mb",
        v: 2,
        reason: "cohort",
        pts: [payloadToCompactTuple(payloadC)],
        last: payloadC,
      }),
    );
    await flushMicrotasks();

    const snapC = await hub.getNodeSnapshot("cli_node_c");
    expect(snapC.online).toBe(true);
    expect(snapC.metrics?.ts).toBe(tsC);
    wsC.close();

    // 4. Node D inserted directly into D1 -> getNodeSnapshot lazily hydrates from D1
    const tokenD = "uob_live_CliNodeDToken0123456789abcdefghijkl";
    await insertDirectNode("cli_node_d", "cli-d", tokenD);
    const snapD = await hub.getNodeSnapshot("cli_node_d");
    expect(snapD.online).toBe(false);
    const mirrorDCount = await runInDurableObject(hub, (_inst, state) =>
      state.storage.sql
        .exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM nodes_mirror WHERE id = ?", "cli_node_d")
        .one().cnt,
    );
    expect(mirrorDCount).toBe(1);

    // 5. Node E inserted directly into D1 -> GET /api/nodes detects missing snapshot and syncs mirror
    const tokenE = "uob_live_CliNodeEToken0123456789abcdefghijkl";
    await insertDirectNode("cli_node_e", "cli-e", tokenE);
    const listAfterRes = await authedFetch("/api/nodes", cookie);
    expect(listAfterRes.status).toBe(200);
    const listAfter = (await listAfterRes.json()) as {
      nodes: Array<{ id: string; name: string }>;
    };
    expect(listAfter.nodes.some((n) => n.id === "cli_node_e")).toBe(true);

    const mirrorECount = await runInDurableObject(hub, (_inst, state) =>
      state.storage.sql
        .exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM nodes_mirror WHERE id = ?", "cli_node_e")
        .one().cnt,
    );
    expect(mirrorECount).toBe(1);
  });
});
