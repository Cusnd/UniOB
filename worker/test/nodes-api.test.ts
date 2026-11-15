import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  authedFetch,
  connectAgentWs,
  createTestNode,
  flushMicrotasks,
  makeHelloFrame,
  makeMetricsFrame,
  setupAndLogin,
  TEST_ORIGIN,
} from "./helpers";

describe("Nodes REST API", () => {
  it("supports node CRUD, token hashing in D1, and NodeSummary schema", async () => {
    const cookie = await setupAndLogin();

    const created = await createTestNode(cookie, {
      name: "sg-kvm-01",
      group_name: "新加坡",
      tags: ["cn2", "prod"],
      sort_order: 10,
      traffic_limit_bytes: 500_000_000_000,
      traffic_reset_day: 15,
      traffic_count_mode: "tx_only",
    });

    expect(created.agent_token).toMatch(/^uob_live_[0-9A-Za-z]{43}$/);
    expect(created.install_cmd).toContain(
      `curl -fsSL ${TEST_ORIGIN}/install.sh | sudo bash -s -- --url wss://uniob.example.com --id ${created.node.id} --token ${created.agent_token}`,
    );

    // D1 stores SHA-256 hash, never plaintext
    const row = await env.DB.prepare(
      "SELECT token_sha256, tags_json FROM nodes WHERE id = ?",
    )
      .bind(created.node.id)
      .first<{ token_sha256: string; tags_json: string }>();
    expect(row?.token_sha256).toBe(await sha256Hex(created.agent_token));
    expect(row?.tags_json).toBe(JSON.stringify(["cn2", "prod"]));

    // List nodes
    const listRes = await authedFetch("/api/nodes", cookie);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      nodes: Array<Record<string, unknown>>;
      activeAlertsCount: number;
    };
    expect(listBody.activeAlertsCount).toBe(0);
    expect(listBody.nodes).toHaveLength(1);
    expect(listBody.nodes[0]).toMatchObject({
      id: created.node.id,
      name: "sg-kvm-01",
      group_name: "新加坡",
      tags: ["cn2", "prod"],
      sort_order: 10,
      online: false,
      last_seen_ts: null,
      proc_enabled: true,
      mute_until: null,
      metrics: null,
      traffic: {
        limit_bytes: 500_000_000_000,
        reset_day: 15,
        count_mode: "tx_only",
        rx_bytes: 0,
        tx_bytes: 0,
        counted_bytes: 0,
      },
    });

    // Patch node
    const muteUntil = Math.floor(Date.now() / 1000) + 1800;
    const patchRes = await authedFetch(`/api/nodes/${created.node.id}`, cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "sg-kvm-renamed",
        traffic_count_mode: "max",
        mute_until: muteUntil,
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      node: { name: string; mute_until: number; traffic: { count_mode: string } };
    };
    expect(patched.node.name).toBe("sg-kvm-renamed");
    expect(patched.node.mute_until).toBe(muteUntil);
    expect(patched.node.traffic.count_mode).toBe("max");
  });

  it("rotates agent token, disconnects existing WS, and rejects old token", async () => {
    const cookie = await setupAndLogin();
    const created = await createTestNode(cookie, { name: "rotate-node" });

    const ws1 = await connectAgentWs(created.node.id, created.agent_token);
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws1.addEventListener("close", (ev) => {
        resolve({ code: ev.code, reason: ev.reason });
      });
    });

    ws1.send(JSON.stringify(makeHelloFrame()));
    await flushMicrotasks();

    const rotRes = await authedFetch(
      `/api/nodes/${created.node.id}/rotate-token`,
      cookie,
      { method: "POST" },
    );
    expect(rotRes.status).toBe(200);
    const rotBody = (await rotRes.json()) as {
      agent_token: string;
      install_cmd: string;
    };
    expect(rotBody.agent_token).toMatch(/^uob_live_/);
    expect(rotBody.agent_token).not.toBe(created.agent_token);

    const closed = await closePromise;
    expect(closed.code).toBe(4001);

    // Old token rejected at edge with 401
    const oldAttempt = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws`, {
      headers: {
        Upgrade: "websocket",
        "X-UniOB-Node-Id": created.node.id,
        Authorization: `Bearer ${created.agent_token}`,
      },
    });
    expect(oldAttempt.status).toBe(401);

    // New token connects cleanly
    const ws2 = await connectAgentWs(created.node.id, rotBody.agent_token);
    ws2.send(JSON.stringify(makeHelloFrame()));
    await flushMicrotasks();
    ws2.close();
  });

  it("deletes node, wipes NodeDO SQLite storage, and queries metrics ranges", async () => {
    const cookie = await setupAndLogin();
    const created = await createTestNode(cookie, { name: "del-node" });
    const nowSec = Math.floor(Date.now() / 1000);

    const ws = await connectAgentWs(created.node.id, created.agent_token);
    ws.send(JSON.stringify(makeHelloFrame()));
    ws.send(JSON.stringify(makeMetricsFrame(nowSec - 60)));
    ws.send(JSON.stringify(makeMetricsFrame(nowSec)));
    await flushMicrotasks();

    // Query 1h metrics
    const mRes = await authedFetch(
      `/api/nodes/${created.node.id}/metrics?range=1h`,
      cookie,
    );
    expect(mRes.status).toBe(200);
    const mBody = (await mRes.json()) as {
      node_id: string;
      range: string;
      resolution: string;
      points: Array<{ ts: number; cpu: number }>;
    };
    expect(mBody.node_id).toBe(created.node.id);
    expect(mBody.range).toBe("1h");
    expect(mBody.resolution).toBe("30s");
    expect(mBody.points.length).toBe(2);

    // Invalid range returns 400
    const badRange = await authedFetch(
      `/api/nodes/${created.node.id}/metrics?range=99y`,
      cookie,
    );
    expect(badRange.status).toBe(400);

    // Delete node
    const delRes = await authedFetch(`/api/nodes/${created.node.id}`, cookie, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });

    // Verify D1 deleted and NodeDO storage wiped
    const dbRow = await env.DB.prepare("SELECT id FROM nodes WHERE id = ?")
      .bind(created.node.id)
      .first();
    expect(dbRow).toBeNull();

    const hub = env.FLEET_HUB_DO.getByName("global");
    const remaining = await runInDurableObject(hub, (_inst, state) => {
      const mirror = state.storage.sql
        .exec<{ cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM nodes_mirror WHERE id = ?",
          created.node.id,
        )
        .one().cnt;
      const chunks = state.storage.sql
        .exec<{ cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM metrics_chunk_10m WHERE node_id = ?",
          created.node.id,
        )
        .one().cnt;
      const nodeState = state.storage.sql
        .exec<{ cnt: number }>(
          "SELECT COUNT(*) AS cnt FROM node_state WHERE node_id = ?",
          created.node.id,
        )
        .one().cnt;
      return { mirror, chunks, nodeState };
    });
    expect(remaining).toEqual({ mirror: 0, chunks: 0, nodeState: 0 });
    ws.close();
  });
});
