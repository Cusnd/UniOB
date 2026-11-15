import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { hmacSha256Hex, sha256Hex } from "../src/crypto";
import {
  exportBundle,
  importBundle,
  isProductionCfAccessEnv,
  normalizeAndValidateMigrationUrl,
} from "../src/migration";
import { DEFAULT_TIMEOUT_SEC, runWatchdogCron } from "../src/watchdog";
import type {
  AgentCtrlFrame,
  ExportBundle,
  HubMigrateResponse,
  HubStatusResponse,
  ImportBundleResponse,
  MigrationReceiveResponse,
  MigrationTicketResponse,
  SmartMigrateResponse,
  WatchdogConfig,
  WatchdogState,
} from "../src/types";
import {
  authedFetch,
  connectAgentWs,
  createTestNode,
  flushMicrotasks,
  makeHelloFrame,
  nextWsMessage,
  setupAndLogin,
  TEST_ORIGIN,
} from "./helpers";
import { SELF } from "cloudflare:test";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Direction A Control Plane: Hub Status, Export/Import, Migration, and Watchdog", () => {
  it("reports live connected_agents, total_nodes, and watchdog state on GET /api/hub/status", async () => {
    const unauth = await SELF.fetch(`${TEST_ORIGIN}/api/hub/status`);
    expect(unauth.status).toBe(401);

    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "status-node" });

    const r0 = await authedFetch("/api/hub/status", cookie);
    expect(r0.status).toBe(200);
    const s0 = (await r0.json()) as HubStatusResponse;
    expect(s0).toMatchObject({
      mode: "cloudflare-worker",
      version: "2.0.0",
      connected_agents: 0,
      total_nodes: 1,
      watchdog: {
        enabled: false,
        last_ping_ts: null,
        status: "disabled",
      },
    });

    const ws = await connectAgentWs(node.id, agent_token);
    ws.send(JSON.stringify(makeHelloFrame({ v: 2 })));
    await flushMicrotasks();

    const r1 = await authedFetch("/api/hub/status", cookie);
    const s1 = (await r1.json()) as HubStatusResponse;
    expect(s1.connected_agents).toBe(1);
    expect(s1.total_nodes).toBe(1);

    ws.close(1000, "done");
    await flushMicrotasks();

    const r2 = await authedFetch("/api/hub/status", cookie);
    const s2 = (await r2.json()) as HubStatusResponse;
    expect(s2.connected_agents).toBe(0);
  });

  it("exports and re-imports configuration bundle safely without breaking active sessions or alert rules", async () => {
    const unauthExport = await SELF.fetch(`${TEST_ORIGIN}/api/export/bundle`);
    expect(unauthExport.status).toBe(401);

    const cookie = await setupAndLogin("InitialPass123!");
    const { node, agent_token } = await createTestNode(cookie, {
      name: "bundle-node",
      group_name: "Tokyo",
      traffic_reset_day: 10,
    });

    const chRes = await authedFetch("/api/alerts/channels", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops Bot",
        type: "telegram",
        config: { bot_token: "bot:secret", chat_id: "-10099" },
      }),
    });
    expect(chRes.status).toBe(201);
    const { channel } = (await chRes.json()) as { channel: { id: string } };

    const ruleRes = await authedFetch("/api/alerts/rules", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "High CPU",
        node_id: node.id,
        metric: "cpu",
        operator: "gt",
        threshold: 85,
        duration_sec: 60,
        cooldown_sec: 300,
        channel_ids: [channel.id],
      }),
    });
    expect(ruleRes.status).toBe(201);

    // Put some hardware & watchdog_state into DO/D1
    const ws = await connectAgentWs(node.id, agent_token);
    ws.send(JSON.stringify(makeHelloFrame({ hostname: "tok-hw-01" })));
    await flushMicrotasks();

    await env.DB.prepare(
      "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
    )
      .bind("watchdog_state", JSON.stringify({ status: "stale", last_ping_ts: 123 }), 100)
      .run();

    const expRes = await authedFetch("/api/export/bundle", cookie);
    expect(expRes.status).toBe(200);
    const bundle = (await expRes.json()) as ExportBundle;

    expect(bundle.version).toBe(1);
    expect(bundle.nodes).toHaveLength(1);
    expect(bundle.nodes[0]!.hostname).toBe("tok-hw-01");
    expect(bundle.notification_channels).toHaveLength(1);
    expect(bundle.alert_rules).toHaveLength(1);
    expect(bundle.system_settings.some((s) => s.key === "watchdog_state")).toBe(false);

    // Invalid bundle rejected
    const badImport = await authedFetch("/api/import/bundle", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(badImport.status).toBe(400);

    // Mutate exported bundle and also slip in stale watchdog_state & a bogus admin_password_hash
    const mutated: ExportBundle = {
      ...bundle,
      nodes: bundle.nodes.map((n) => ({ ...n, name: "bundle-node-restored" })),
      system_settings: [
        ...bundle.system_settings.filter((s) => s.key !== "admin_password_hash"),
        { key: "admin_password_hash", value: "should_not_overwrite", updated_at: 9999 },
        { key: "watchdog_state", value: JSON.stringify({ status: "stale" }), updated_at: 9999 },
      ],
      traffic_ledgers: [
        {
          node_id: node.id,
          cycle_key: "2026-11",
          last_agent_rx: 5000,
          last_agent_tx: 8000,
          cycle_rx_bytes: 123_456,
          cycle_tx_bytes: 654_321,
          updated_at: Math.floor(Date.now() / 1000),
        },
      ],
    };

    const impRes = await authedFetch("/api/import/bundle", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mutated),
    });
    expect(impRes.status).toBe(200);
    const impBody = (await impRes.json()) as ImportBundleResponse;
    expect(impBody).toEqual({
      ok: true,
      imported: {
        nodes: 1,
        channels: 1,
        rules: 1,
        traffic_ledgers: 1,
      },
    });

    // Session cookie still valid and node reflects updated name & traffic ledger in FleetHubDO
    const nodesAfter = await authedFetch("/api/nodes", cookie);
    expect(nodesAfter.status).toBe(200);
    const nodesBody = (await nodesAfter.json()) as {
      nodes: Array<{ id: string; name: string; traffic: { rx_bytes: number; tx_bytes: number } }>;
    };
    expect(nodesBody.nodes[0]).toMatchObject({
      id: node.id,
      name: "bundle-node-restored",
      traffic: { rx_bytes: 123_456, tx_bytes: 654_321 },
    });

    // Alert rules were preserved across node upsert (no ON DELETE CASCADE loss)
    const rulesAfter = await authedFetch("/api/alerts/rules", cookie);
    const rulesBody = (await rulesAfter.json()) as { rules: Array<{ id: string; name: string }> };
    expect(rulesBody.rules).toHaveLength(1);
    expect(rulesBody.rules[0]!.name).toBe("High CPU");

    // Imported bogus admin_password_hash & watchdog_state did not overwrite existing values
    const wdRow = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
      .bind("watchdog_state")
      .first<{ value: string }>();
    expect(JSON.parse(wdRow!.value)).toMatchObject({ last_ping_ts: 123 });

    ws.close();
  });

  it("enforces SSRF guards on migration URLs and dispatches signed HMAC canary directives", async () => {
    const cookie = await setupAndLogin();
    const n1 = await createTestNode(cookie, { name: "canary-1" });
    const n2 = await createTestNode(cookie, { name: "canary-2" });

    // Unit-check production cf_access guard against insecure ws
    expect(isProductionCfAccessEnv({ AUTH_MODE: "cf_access" })).toBe(true);
    expect(
      normalizeAndValidateMigrationUrl("ws://127.0.0.1:8080", {
        allowInsecureWs: true,
        isProduction: true,
      }),
    ).toEqual({ ok: false, error: "allow_insecure_ws is forbidden in production" });

    // Unauthenticated rejected
    const unauth = await SELF.fetch(`${TEST_ORIGIN}/api/hub/migrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_url: "https://hub2.example.com" }),
    });
    expect(unauth.status).toBe(401);

    // Reject private, loopback, link-local, CGNAT, and ws:// targets without allow_insecure_ws
    const blockedUrls = [
      "",
      "ws://hub2.example.com/api/agent/ws",
      "http://hub2.example.com",
      "https://localhost:8443",
      "https://127.0.0.1:8443",
      "https://10.0.0.1",
      "https://169.254.169.254",
      "https://172.16.0.1",
      "https://192.168.1.1",
      "https://100.64.0.1",
      "https://[::1]:8443",
      "https://[fe80::1]:8443",
      "https://[fc00::1]:8443",
      "https://[::ffff:127.0.0.1]:8443",
      "https://hub.internal",
    ];
    for (const url of blockedUrls) {
      const res = await authedFetch("/api/hub/migrate", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_url: url }),
      });
      expect(res.status, `Expected 400 for ${url}`).toBe(400);
    }

    // Connect both v2 agents
    const ws1 = await connectAgentWs(n1.node.id, n1.agent_token);
    const ctrl1Init = nextWsMessage<AgentCtrlFrame>(ws1, (m) => m.t === "ctrl");
    ws1.send(JSON.stringify(makeHelloFrame({ v: 2 })));
    await ctrl1Init;

    const ws2 = await connectAgentWs(n2.node.id, n2.agent_token);
    const ctrl2Init = nextWsMessage<AgentCtrlFrame>(ws2, (m) => m.t === "ctrl");
    ws2.send(JSON.stringify(makeHelloFrame({ v: 2 })));
    await ctrl2Init;

    // Canary migrate ONLY n1.node.id
    const migrateMsgPromise = nextWsMessage<AgentCtrlFrame>(
      ws1,
      (m) => m.t === "ctrl" && Boolean(m.migrate),
    );
    let n2ReceivedMigrate = false;
    ws2.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as AgentCtrlFrame;
        if (msg.migrate) n2ReceivedMigrate = true;
      } catch {
        // ignore
      }
    });

    const migRes = await authedFetch("/api/hub/migrate", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_url: "https://hub2.example.com:8443/",
        fallback_url: "https://monitor.example.com",
        node_ids: [n1.node.id],
      }),
    });
    expect(migRes.status).toBe(200);
    const migBody = (await migRes.json()) as HubMigrateResponse;
    expect(migBody.ok).toBe(true);
    expect(migBody.target_ws_url).toBe("wss://hub2.example.com:8443/api/agent/ws");
    expect(migBody.targeted).toBe(1);
    expect(migBody.dispatched).toBe(1);

    const migrateCtrl = await migrateMsgPromise;
    expect(migrateCtrl.migrate).toMatchObject({
      url: "wss://hub2.example.com:8443/api/agent/ws",
      fallback_url: "wss://monitor.example.com/api/agent/ws",
      epoch: migBody.epoch,
    });

    const badFallbackRes = await authedFetch("/api/hub/migrate", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_url: "https://hub2.example.com",
        fallback_url: "https://127.0.0.1:8080",
      }),
    });
    expect(badFallbackRes.status).toBe(400);

    // Verify exact HMAC-SHA256(key = lowercase(sha256(agent_token)), msg = "${nodeId}:${epoch}:${wsUrl}")
    const tokenHash = (await sha256Hex(n1.agent_token)).toLowerCase();
    const expectedSig = await hmacSha256Hex(
      `${n1.node.id}:${migBody.epoch}:wss://hub2.example.com:8443/api/agent/ws`,
      tokenHash,
    );
    expect(migrateCtrl.migrate!.sig).toBe(expectedSig);

    await flushMicrotasks();
    expect(n2ReceivedMigrate).toBe(false);

    // Non-production allow_insecure_ws works for local staging test URLs
    const insecureRes = await authedFetch("/api/hub/migrate", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_url: "http://127.0.0.1:8080",
        allow_insecure_ws: true,
        node_ids: [n2.node.id],
      }),
    });
    expect(insecureRes.status).toBe(200);
    const insecureBody = (await insecureRes.json()) as HubMigrateResponse;
    expect(insecureBody.target_ws_url).toBe("ws://127.0.0.1:8080/api/agent/ws");
    expect(insecureBody.dispatched).toBe(1);

    ws1.close();
    ws2.close();
  });

  it("handles watchdog config, signed HMAC pings without cookie auth, cron staleness alerts, and recovery", async () => {
    const cookie = await setupAndLogin();

    const sentTelegram: Array<{ text: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("https://api.telegram.org/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentTelegram.push({ text: body.text ?? "" });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const chRes = await authedFetch("/api/alerts/channels", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Watchdog TG",
        type: "telegram",
        config: { bot_token: "123:XYZ", chat_id: "-100222" },
      }),
    });
    const { channel } = (await chRes.json()) as { channel: { id: string } };

    // 1. Unauthenticated config request denied
    expect((await SELF.fetch(`${TEST_ORIGIN}/api/watchdog/config`)).status).toBe(401);

    // 2. GET auto-generates secret and defaults timeout_sec to 900; disabled ping returns 403
    const cfg0Res = await authedFetch("/api/watchdog/config", cookie);
    expect(cfg0Res.status).toBe(200);
    const cfg0 = (await cfg0Res.json()) as { config: WatchdogConfig; state: WatchdogState };
    expect(DEFAULT_TIMEOUT_SEC).toBe(900);
    expect(cfg0.config.enabled).toBe(false);
    expect(cfg0.config.timeout_sec).toBe(900);
    expect(cfg0.config.secret.length).toBeGreaterThanOrEqual(16);

    const pingDisabled = await SELF.fetch(`${TEST_ORIGIN}/api/watchdog/ping`, {
      method: "POST",
      body: "{}",
    });
    expect(pingDisabled.status).toBe(403);

    // 3. Enable watchdog -> waiting state until first ping arrives; cron must NOT fire alert
    const putRes = await authedFetch("/api/watchdog/config", cookie, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        timeout_sec: 120,
        cooldown_sec: 300,
        hub_label: "tokyo-self-hosted",
        channel_ids: [channel.id],
      }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { config: WatchdogConfig; state: WatchdogState };
    const secret = putBody.config.secret;
    expect(putBody.config.enabled).toBe(true);
    expect(putBody.state.last_ping_ts).toBeNull();

    const statusWaiting = (await (
      await authedFetch("/api/hub/status", cookie)
    ).json()) as HubStatusResponse;
    expect(statusWaiting.watchdog.status).toBe("waiting");

    const nowSec = Math.floor(Date.now() / 1000);
    const waitingCron = await runWatchdogCron(env.DB, nowSec + 10_000);
    expect(waitingCron).toEqual({ checked: true, status: "waiting", alerted: false });
    expect(sentTelegram).toHaveLength(0);

    // 4. Reject missing headers, bad HMAC, and stale timestamp
    expect(
      (
        await SELF.fetch(`${TEST_ORIGIN}/api/watchdog/ping`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(401);

    expect(
      (
        await SELF.fetch(`${TEST_ORIGIN}/api/watchdog/ping`, {
          method: "POST",
          headers: {
            "X-Watchdog-Timestamp": String(nowSec),
            "X-Watchdog-Signature": "deadbeef",
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);

    const staleTs = nowSec - 600;
    const staleBody = JSON.stringify({ hub_label: "tokyo-self-hosted" });
    const staleSig = await hmacSha256Hex(`${staleTs}:${staleBody}`, secret);
    expect(
      (
        await SELF.fetch(`${TEST_ORIGIN}/api/watchdog/ping`, {
          method: "POST",
          headers: {
            "X-Watchdog-Timestamp": String(staleTs),
            "X-Watchdog-Signature": staleSig,
          },
          body: staleBody,
        })
      ).status,
    ).toBe(401);

    // 5. Valid HMAC ping succeeds WITHOUT admin cookie
    const goodBody = JSON.stringify({
      hub_label: "tokyo-self-hosted",
      connected_agents: 5,
      total_nodes: 5,
      version: "2.0.0",
    });
    const goodSig = await hmacSha256Hex(`${nowSec}:${goodBody}`, secret);
    const goodPing = await SELF.fetch(`${TEST_ORIGIN}/api/watchdog/ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Watchdog-Timestamp": String(nowSec),
        "X-Watchdog-Signature": goodSig,
      },
      body: goodBody,
    });
    expect(goodPing.status).toBe(200);
    expect(await goodPing.json()).toMatchObject({ ok: true, status: "ok" });
    expect(sentTelegram).toHaveLength(0);

    // 6. Advance time past timeout_sec -> cron marks stale & fires Telegram alert (once per cooldown)
    const cron1 = await runWatchdogCron(env.DB, nowSec + 200);
    expect(cron1).toEqual({ checked: true, status: "stale", alerted: true });
    expect(sentTelegram).toHaveLength(1);
    expect(sentTelegram[0]!.text).toContain("🚨 <b>[UniOB 告警触发]</b>");
    expect(sentTelegram[0]!.text).toContain("自建监控面板失联");
    expect(sentTelegram[0]!.text).toContain("tokyo-self-hosted");

    const cronCooldown = await runWatchdogCron(env.DB, nowSec + 250);
    expect(cronCooldown).toEqual({ checked: true, status: "stale", alerted: false });
    expect(sentTelegram).toHaveLength(1);

    const statusStale = (await (
      await authedFetch("/api/hub/status", cookie)
    ).json()) as HubStatusResponse;
    expect(statusStale.watchdog.status).toBe("stale");

    // Worker scheduled() handler runs without throwing
    await expect(
      worker.scheduled(
        { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry: () => {} } as ScheduledController,
        env,
        { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as ExecutionContext,
      ),
    ).resolves.toBeUndefined();

    // 7. Subsequent valid ping recovers status & dispatches recovery alert
    const recTs = Math.floor(Date.now() / 1000);
    const recSig = await hmacSha256Hex(`${recTs}:${goodBody}`, secret);
    const recPing = await SELF.fetch(`${TEST_ORIGIN}/api/watchdog/ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Watchdog-Timestamp": String(recTs),
        "X-Watchdog-Signature": recSig,
      },
      body: goodBody,
    });
    expect(recPing.status).toBe(200);
    expect(sentTelegram).toHaveLength(2);
    expect(sentTelegram[1]!.text).toContain("✅ <b>[UniOB 故障恢复]</b>");
    expect(sentTelegram[1]!.text).toContain("自建监控面板已恢复连接");
    expect(sentTelegram[1]!.text).toContain("tokyo-self-hosted");

    const statusHealthy = (await (
      await authedFetch("/api/hub/status", cookie)
    ).json()) as HubStatusResponse;
    expect(statusHealthy.watchdog.status).toBe("healthy");
  });

  it("normalizes bare migration host[:port] to https/wss while keeping SSRF and TLS guards", () => {
    const strictOpts = { allowInsecureWs: false, isProduction: true };
    expect(normalizeAndValidateMigrationUrl("hub2.example.com", strictOpts)).toEqual({
      ok: true,
      wsUrl: "wss://hub2.example.com/api/agent/ws",
    });
    expect(normalizeAndValidateMigrationUrl("hub2.example.com:8443", strictOpts)).toEqual({
      ok: true,
      wsUrl: "wss://hub2.example.com:8443/api/agent/ws",
    });
    expect(normalizeAndValidateMigrationUrl("hub2.example.com:8443/custom", strictOpts)).toEqual({
      ok: true,
      wsUrl: "wss://hub2.example.com:8443/custom/api/agent/ws",
    });

    expect(normalizeAndValidateMigrationUrl("", strictOpts).ok).toBe(false);
    expect(normalizeAndValidateMigrationUrl("   ", strictOpts).ok).toBe(false);
    expect(normalizeAndValidateMigrationUrl("http://hub2.example.com", strictOpts).ok).toBe(false);
    expect(normalizeAndValidateMigrationUrl("ws://hub2.example.com", strictOpts).ok).toBe(false);
    expect(
      normalizeAndValidateMigrationUrl("http://hub2.example.com", {
        allowInsecureWs: true,
        isProduction: true,
      }).ok,
    ).toBe(false);
    expect(
      normalizeAndValidateMigrationUrl("http://hub2.example.com", {
        allowInsecureWs: true,
        isProduction: false,
      }),
    ).toEqual({
      ok: true,
      wsUrl: "ws://hub2.example.com/api/agent/ws",
    });

    for (const ssrf of [
      "127.0.0.1",
      "localhost",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.169.254",
      "internal.local",
      "user:pass@hub2.example.com",
    ]) {
      expect(normalizeAndValidateMigrationUrl(ssrf, strictOpts).ok).toBe(false);
    }
  });

  it("strips ephemeral migration/watchdog keys on export and controls receive_ticket import", async () => {
    const cookie = await setupAndLogin();
    const {
      node: { id: nodeId },
    } = await createTestNode(cookie, { name: "Hygiene Node" });
    const nowSec = Math.floor(Date.now() / 1000);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).bind("watchdog_state", '{"last_ping_ts":1}', nowSec),
      env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).bind("imported_bundle_sha256", "abc123", nowSec),
      env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).bind("migration_pull_ticket", '{"token_sha256":"x","expires_at":9999999999}', nowSec),
      env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).bind("migration_receive_ticket", '{"token_sha256":"y","expires_at":9999999999}', nowSec),
      env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).bind("migration_paired_token", '{"raw_receive_token":"uob_mtk_x","expires_at":9999999999}', nowSec),
      env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).bind("custom_keep", "ok", nowSec),
    ]);

    const exported = await exportBundle(env);
    const exportedKeys = new Set(exported.system_settings.map((s) => s.key));
    expect(exportedKeys.has("custom_keep")).toBe(true);
    expect(exportedKeys.has("watchdog_state")).toBe(false);
    expect(exportedKeys.has("imported_bundle_sha256")).toBe(false);
    expect(exportedKeys.has("migration_pull_ticket")).toBe(false);
    expect(exportedKeys.has("migration_receive_ticket")).toBe(false);
    expect(exportedKeys.has("migration_paired_token")).toBe(false);

    // Import via /api/import/bundle (allowReceiveTicket: false) skips all 5 restricted keys
    await env.DB.prepare("DELETE FROM system_settings WHERE key LIKE 'migration_%' OR key = 'imported_bundle_sha256'").run();
    const apiImportRes = await authedFetch("/api/import/bundle", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        exported_at: nowSec,
        nodes: exported.nodes,
        notification_channels: [],
        alert_rules: [],
        system_settings: [
          { key: "watchdog_state", value: '{"last_ping_ts":9}', updated_at: nowSec },
          { key: "imported_bundle_sha256", value: "dead", updated_at: nowSec },
          { key: "migration_pull_ticket", value: "skip", updated_at: nowSec },
          { key: "migration_receive_ticket", value: '{"token_sha256":"api-skip","expires_at":99}', updated_at: nowSec },
          { key: "migration_paired_token", value: "skip", updated_at: nowSec },
          { key: "panel_title", value: "UniOB", updated_at: nowSec },
        ],
        traffic_ledgers: [],
      }),
    });
    expect(apiImportRes.status).toBe(200);

    const rowsAfterApi = await env.DB.prepare(
      "SELECT key, value FROM system_settings WHERE key IN ('imported_bundle_sha256','migration_pull_ticket','migration_receive_ticket','migration_paired_token','panel_title')",
    ).all<{ key: string; value: string }>();
    const mapAfterApi = new Map((rowsAfterApi.results ?? []).map((r) => [r.key, r.value]));
    expect(mapAfterApi.get("panel_title")).toBe("UniOB");
    expect(mapAfterApi.has("imported_bundle_sha256")).toBe(false);
    expect(mapAfterApi.has("migration_pull_ticket")).toBe(false);
    expect(mapAfterApi.has("migration_receive_ticket")).toBe(false);
    expect(mapAfterApi.has("migration_paired_token")).toBe(false);

    // Explicit allowReceiveTicket: true allows ONLY migration_receive_ticket among those 5
    const directRes = await importBundle(
      env,
      {
        version: 1,
        exported_at: nowSec,
        nodes: exported.nodes.filter((n) => n.id === nodeId),
        system_settings: [
          { key: "migration_receive_ticket", value: '{"token_sha256":"trusted","expires_at":999}', updated_at: nowSec },
          { key: "migration_pull_ticket", value: "still-skipped", updated_at: nowSec },
        ],
      },
      { allowReceiveTicket: true },
    );
    expect(directRes.ok).toBe(true);
    const recvRow = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = 'migration_receive_ticket'",
    ).first<{ value: string }>();
    expect(recvRow?.value).toBe('{"token_sha256":"trusted","expires_at":999}');
    const pullRow = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = 'migration_pull_ticket'",
    ).first<{ value: string }>();
    expect(pullRow).toBeNull();
  });

  it("issues receive/install migration tickets, serves pull/receive routes cleanly, and prevents stale/bad auth", async () => {
    const cookie = await setupAndLogin();
    const {
      node: { id: nodeId },
      agent_token: rawToken,
    } = await createTestNode(cookie, { name: "Ticket Source Node" });

    // Seed enabled notification channel & legacy 180s disabled watchdog config
    const chRes = await authedFetch("/api/alerts/channels", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Auto Arm TG",
        type: "telegram",
        config: { bot_token: "123:AAA", chat_id: "-100999" },
      }),
    });
    const { channel } = (await chRes.json()) as { channel: { id: string } };
    const nowSec = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('watchdog_config', ?, ?)",
    )
      .bind(
        JSON.stringify({
          enabled: false,
          secret: "existing_secret_with_quote'test",
          timeout_sec: 180,
          cooldown_sec: 300,
          hub_label: "self-hosted-hub",
          channel_ids: [],
        }),
        nowSec,
      )
      .run();

    // 1. Unauthenticated ticket requests rejected
    expect(
      (
        await SELF.fetch(`${TEST_ORIGIN}/api/migration/ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purpose: "receive" }),
        })
      ).status,
    ).toBe(401);

    // 2. Receive ticket issues uobm1_... migration_code
    const recvTicketRes = await authedFetch("/api/migration/ticket", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: "receive",
        public_origin: "target-panel.example.com",
      }),
    });
    expect(recvTicketRes.status).toBe(200);
    const recvTicket = (await recvTicketRes.json()) as MigrationTicketResponse;
    expect(recvTicket.ok).toBe(true);
    expect(recvTicket.purpose).toBe("receive");
    expect(recvTicket.origin).toBe("https://target-panel.example.com");
    expect(recvTicket.migration_code?.startsWith("uobm1_")).toBe(true);
    expect(recvTicket.expires_at).toBeGreaterThanOrEqual(nowSec + 1790);

    // Public receive rejects missing / wrong / malformed token with 401 & no-store
    const badRecv1 = await SELF.fetch(`${TEST_ORIGIN}/releases/migration/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: [] }),
    });
    expect(badRecv1.status).toBe(401);
    expect(badRecv1.headers.get("Cache-Control")).toBe("no-store");

    const badRecv2 = await SELF.fetch(`${TEST_ORIGIN}/api/migration/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer uob_mtk_wrongtoken000000000000000000000000000000000",
      },
      body: JSON.stringify({ nodes: [] }),
    });
    expect(badRecv2.status).toBe(401);

    // Decode uobm1_ code and submit bundle via public receive routes (no cookie!)
    const encodedPart = recvTicket.migration_code!.slice("uobm1_".length);
    const padded = encodedPart.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((encodedPart.length + 3) % 4);
    const decodedPayload = JSON.parse(atob(padded)) as { u: string; k: string };
    expect(decodedPayload.u).toBe("https://target-panel.example.com");
    expect(decodedPayload.k.startsWith("uob_mtk_")).toBe(true);

    const pushBundleRes = await SELF.fetch(`${TEST_ORIGIN}/releases/migration/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${decodedPayload.k}`,
      },
      body: JSON.stringify({
        version: 1,
        exported_at: nowSec,
        nodes: [
          {
            id: "node-imported-via-receive",
            name: "Imported Receive Node",
            token_sha256: await sha256Hex("agent-raw-secret"),
          },
        ],
        notification_channels: [],
        alert_rules: [],
        system_settings: [{ key: "migration_receive_ticket", value: "must-ignore", updated_at: nowSec }],
        traffic_ledgers: [],
      }),
    });
    expect(pushBundleRes.status).toBe(200);
    expect(pushBundleRes.headers.get("Cache-Control")).toBe("no-store");
    const pushBody = (await pushBundleRes.json()) as MigrationReceiveResponse;
    expect(pushBody).toEqual({
      ok: true,
      mode: "cloudflare-worker",
      imported: { nodes: 1, channels: 0, rules: 0, traffic_ledgers: 0 },
    });

    // Alias /api/migration/receive with X-Migration-Token works too
    const aliasRecvRes = await SELF.fetch(`${TEST_ORIGIN}/api/migration/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Migration-Token": decodedPayload.k,
      },
      body: JSON.stringify({
        version: 1,
        nodes: [],
      }),
    });
    expect(aliasRecvRes.status).toBe(200);

    // 3. Install ticket with enable_watchdog=false skips arming
    const noWdInstallRes = await authedFetch("/api/migration/ticket", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "install", enable_watchdog: false }),
    });
    expect(noWdInstallRes.status).toBe(200);
    const noWdInstall = (await noWdInstallRes.json()) as MigrationTicketResponse;
    expect(noWdInstall.watchdog_armed).toBe(false);
    expect(noWdInstall.install_cmd).not.toContain("--watchdog-url");

    // 4. Install ticket with watchdog arming upgrades 180->900, populates channel_ids, escapes single quotes, leaves last_ping_ts=null
    const installTicketRes = await authedFetch("/api/migration/ticket", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "install" }),
    });
    expect(installTicketRes.status).toBe(200);
    const installTicket = (await installTicketRes.json()) as MigrationTicketResponse;
    expect(installTicket.ok).toBe(true);
    expect(installTicket.purpose).toBe("install");
    expect(installTicket.origin).toBe(TEST_ORIGIN);
    expect(installTicket.pull_url?.startsWith(`${TEST_ORIGIN}/releases/migration/pull/uob_mpull_`)).toBe(true);
    expect(installTicket.watchdog_armed).toBe(true);
    expect(installTicket.install_cmd).toContain(`curl -fsSL '${TEST_ORIGIN}/install-hub.sh' | sudo bash -s -- --import-bundle '${installTicket.pull_url}'`);
    expect(installTicket.install_cmd).toContain(`--watchdog-url '${TEST_ORIGIN}/api/watchdog/ping'`);
    expect(installTicket.install_cmd).toContain(`--watchdog-secret 'existing_secret_with_quote'\\''test'`);

    const wdAfterArm = (await (
      await authedFetch("/api/watchdog/config", cookie)
    ).json()) as { config: WatchdogConfig; state: WatchdogState };
    expect(wdAfterArm.config.enabled).toBe(true);
    expect(wdAfterArm.config.timeout_sec).toBe(900);
    expect(wdAfterArm.config.channel_ids).toEqual([channel.id]);
    expect(wdAfterArm.state.last_ping_ts).toBeNull();

    // 5. Public pull routes return bundle with embedded migration_receive_ticket & Cache-Control: no-store
    const pullToken = installTicket.pull_url!.split("/").pop()!;
    const pullRes = await SELF.fetch(`${TEST_ORIGIN}/releases/migration/pull/${pullToken}`);
    expect(pullRes.status).toBe(200);
    expect(pullRes.headers.get("Cache-Control")).toBe("no-store");
    const pulledBundle = (await pullRes.json()) as ExportBundle;
    expect(pulledBundle.nodes.some((n) => n.id === nodeId)).toBe(true);
    expect(
      pulledBundle.nodes.find((n) => n.id === nodeId)?.token_sha256,
    ).toBe(await sha256Hex(rawToken));
    const embeddedTicket = pulledBundle.system_settings.find(
      (s) => s.key === "migration_receive_ticket",
    );
    expect(embeddedTicket).toBeDefined();

    const pullAliasRes = await SELF.fetch(`${TEST_ORIGIN}/api/migration/pull/${pullToken}`);
    expect(pullAliasRes.status).toBe(200);

    // Invalid pull token rejected with 401
    expect(
      (await SELF.fetch(`${TEST_ORIGIN}/releases/migration/pull/uob_mpull_invalidtoken12345`)).status,
    ).toBe(401);

    // Expired pull & receive tickets rejected with 401
    await env.DB.prepare(
      "UPDATE system_settings SET value = ? WHERE key = 'migration_pull_ticket'",
    )
      .bind(JSON.stringify({ token_sha256: await sha256Hex(pullToken), expires_at: nowSec - 10 }))
      .run();
    expect(
      (await SELF.fetch(`${TEST_ORIGIN}/releases/migration/pull/${pullToken}`)).status,
    ).toBe(401);

    await env.DB.prepare(
      "UPDATE system_settings SET value = ? WHERE key = 'migration_receive_ticket'",
    )
      .bind(JSON.stringify({ token_sha256: await sha256Hex(decodedPayload.k), expires_at: nowSec - 10 }))
      .run();
    expect(
      (
        await SELF.fetch(`${TEST_ORIGIN}/releases/migration/receive`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${decodedPayload.k}`,
          },
          body: JSON.stringify({ nodes: [] }),
        })
      ).status,
    ).toBe(401);
  });

  it("orchestrates smart migration via uobm1_ code and paired-token URL, dispatching signed ctrl.migrate and mapping remote failures safely", async () => {
    const cookie = await setupAndLogin();
    const {
      node: { id: nodeId },
      agent_token: rawToken,
    } = await createTestNode(cookie, { name: "Smart Migrate Node" });

    // Connect node over WS so we can assert signed ctrl.migrate delivery
    const ws = await connectAgentWs(nodeId, rawToken);
    const ctrlInit = nextWsMessage<AgentCtrlFrame>(ws, (m) => m.t === "ctrl");
    ws.send(JSON.stringify(makeHelloFrame({ v: 2 })));
    await ctrlInit;

    // Create an install ticket so local migration_paired_token is populated too
    const installRes = await authedFetch("/api/migration/ticket", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "install", enable_watchdog: false }),
    });
    expect(installRes.status).toBe(200);

    const pairedRow = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = 'migration_paired_token'",
    ).first<{ value: string }>();
    const pairedToken = (JSON.parse(pairedRow!.value) as { raw_receive_token: string }).raw_receive_token;

    // Helper to build uobm1_ code
    const makeCode = (origin: string, k: string) => {
      const json = JSON.stringify({ u: origin, k });
      const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      return `uobm1_${b64}`;
    };

    const recordedReceives: Array<{ url: string; auth: string | null; redirect: string | undefined }> = [];
    let nextRemoteMode: "ok" | "cf-access" | "unauth" | "500" | "network" | "bad-json" | "ok-false" = "ok";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith("/releases/migration/receive")) {
        const headers = new Headers(init?.headers);
        recordedReceives.push({
          url,
          auth: headers.get("Authorization"),
          redirect: init?.redirect,
        });
        if (nextRemoteMode === "network") {
          throw new Error("ECONNREFUSED");
        }
        if (nextRemoteMode === "cf-access") {
          return new Response("", {
            status: 302,
            headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
          });
        }
        if (nextRemoteMode === "unauth") {
          return new Response(JSON.stringify({ error: "bad token" }), { status: 401 });
        }
        if (nextRemoteMode === "500") {
          return new Response("upstream failure", { status: 500 });
        }
        if (nextRemoteMode === "bad-json") {
          return new Response("<html>not json</html>", { status: 200 });
        }
        if (nextRemoteMode === "ok-false") {
          return new Response(JSON.stringify({ ok: false, error: "db locked" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            mode: "self-hosted",
            imported: { nodes: 1, channels: 0, rules: 0, traffic_ledgers: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // 1. Success via uobm1_ migration code -> syncs bundle + dispatches signed ctrl.migrate with fallback
    const code = makeCode("https://hub-code.example.com", "uob_mtk_code1234567890abcdef");
    const ctrlMsg1Promise = nextWsMessage<AgentCtrlFrame>(
      ws,
      (m) => m.t === "ctrl" && Boolean(m.migrate),
    );
    const smartCodeRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: code }),
    });
    expect(smartCodeRes.status).toBe(200);
    const smartCodeBody = (await smartCodeRes.json()) as SmartMigrateResponse;
    expect(smartCodeBody).toMatchObject({
      ok: true,
      target_origin: "https://hub-code.example.com",
      target_ws_url: "wss://hub-code.example.com/api/agent/ws",
      fallback_ws_url: "wss://uniob.example.com/api/agent/ws",
      synced: { nodes: 1, channels: 0, rules: 0, traffic_ledgers: 0 },
      targeted: 1,
      dispatched: 1,
    });
    expect(recordedReceives[0]).toEqual({
      url: "https://hub-code.example.com/releases/migration/receive",
      auth: "Bearer uob_mtk_code1234567890abcdef",
      redirect: "manual",
    });

    const ctrlMsg1 = await ctrlMsg1Promise;
    expect(ctrlMsg1.migrate).toMatchObject({
      url: "wss://hub-code.example.com/api/agent/ws",
      fallback_url: "wss://uniob.example.com/api/agent/ws",
      epoch: smartCodeBody.epoch,
    });
    const tokenHash = (await sha256Hex(rawToken)).toLowerCase();
    expect(ctrlMsg1.migrate!.sig).toBe(
      await hmacSha256Hex(
        `${nodeId}:${ctrlMsg1.migrate!.epoch}:${ctrlMsg1.migrate!.url}`,
        tokenHash,
      ),
    );

    // 2. Success via bare host URL + stored local migration_paired_token
    const ctrlMsg2Promise = nextWsMessage<AgentCtrlFrame>(
      ws,
      (m) => m.t === "ctrl" && Boolean(m.migrate),
    );
    const smartUrlRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: "hub-paired.example.com:8443" }),
    });
    expect(smartUrlRes.status).toBe(200);
    const smartUrlBody = (await smartUrlRes.json()) as SmartMigrateResponse;
    expect(smartUrlBody.target_origin).toBe("https://hub-paired.example.com:8443");
    expect(smartUrlBody.target_ws_url).toBe("wss://hub-paired.example.com:8443/api/agent/ws");
    expect(recordedReceives[1]?.auth).toBe(`Bearer ${pairedToken}`);

    const ctrlMsg2 = await ctrlMsg2Promise;
    expect(ctrlMsg2.migrate!.epoch).toBeGreaterThan(ctrlMsg1.migrate!.epoch);

    // 3. Same-origin target rejected with 400
    const sameOriginRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: TEST_ORIGIN }),
    });
    expect(sameOriginRes.status).toBe(400);

    // 4. SSRF private IP rejected with 400
    const ssrfRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: "127.0.0.1" }),
    });
    expect(ssrfRes.status).toBe(400);

    // 5. Remote 3xx CF Access redirect -> 400 with Bypass hint
    nextRemoteMode = "cf-access";
    const cfAccessRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: code }),
    });
    expect(cfAccessRes.status).toBe(400);
    const cfAccessErr = (await cfAccessRes.json()) as { error: string };
    expect(cfAccessErr.error).toContain("Cloudflare Access");
    expect(cfAccessErr.error).toContain("Bypass");

    // 6. Remote 401 -> mapped to 400 (does not return 401 to source browser)
    nextRemoteMode = "unauth";
    const remoteUnauthRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: code }),
    });
    expect(remoteUnauthRes.status).toBe(400);

    // 7. Remote 500 & network error -> 502
    nextRemoteMode = "500";
    expect(
      (
        await authedFetch("/api/hub/migrate-smart", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_input: code }),
        })
      ).status,
    ).toBe(502);

    nextRemoteMode = "network";
    expect(
      (
        await authedFetch("/api/hub/migrate-smart", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_input: code }),
        })
      ).status,
    ).toBe(502);

    // 8. Remote non-JSON & ok=false -> 400
    nextRemoteMode = "bad-json";
    expect(
      (
        await authedFetch("/api/hub/migrate-smart", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_input: code }),
        })
      ).status,
    ).toBe(400);

    nextRemoteMode = "ok-false";
    expect(
      (
        await authedFetch("/api/hub/migrate-smart", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_input: code }),
        })
      ).status,
    ).toBe(400);

    // 9. Bare URL with missing/expired paired token -> 400
    await env.DB.prepare("DELETE FROM system_settings WHERE key = 'migration_paired_token'").run();
    const missingPairRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: "hub-paired.example.com" }),
    });
    expect(missingPairRes.status).toBe(400);

    // 10. Whitespace-only node_ids are ignored (targets all nodes); padded IDs are trimmed
    nextRemoteMode = "ok";
    const ctrlMsg3Promise = nextWsMessage<AgentCtrlFrame>(
      ws,
      (m) => m.t === "ctrl" && Boolean(m.migrate),
    );
    const blankNodeIdsRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: code, node_ids: ["   ", ""] }),
    });
    expect(blankNodeIdsRes.status).toBe(200);
    expect(await blankNodeIdsRes.json()).toMatchObject({ targeted: 1, dispatched: 1 });
    await ctrlMsg3Promise;

    const ctrlMsg4Promise = nextWsMessage<AgentCtrlFrame>(
      ws,
      (m) => m.t === "ctrl" && Boolean(m.migrate),
    );
    const paddedNodeIdRes = await authedFetch("/api/hub/migrate-smart", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_input: code, node_ids: [` ${nodeId} `, "  "] }),
    });
    expect(paddedNodeIdRes.status).toBe(200);
    expect(await paddedNodeIdRes.json()).toMatchObject({ targeted: 1, dispatched: 1 });
    await ctrlMsg4Promise;

    ws.close();
  });
});
