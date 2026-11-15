import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeRecoveryThreshold,
  evaluateRuleStep,
  type AlertRuleRuntimeState,
} from "../src/alert/engine";
import {
  formatTelegramAlertHtml,
  sendTelegramHtml,
  sendWebhookJson,
} from "../src/alert/telegram";
import {
  authedFetch,
  connectAgentWs,
  createTestNode,
  flushMicrotasks,
  makeHelloFrame,
  makeMetricsFrame,
  setupAndLogin,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Alert Engine, Hysteresis, Mute, and Telegram/Webhook", () => {
  it("enforces duration_sec debounce, 2-sample hysteresis recovery, and cooldown_sec", () => {
    const rule = {
      id: "rl_test",
      operator: "gt" as const,
      threshold: 90,
      duration_sec: 120,
      cooldown_sec: 3600,
    };

    expect(computeRecoveryThreshold(90)).toBeCloseTo(85.5);

    // 1. Spike below duration_sec -> PENDING -> OK
    let state: AlertRuleRuntimeState | undefined;
    let d = evaluateRuleStep(rule, state, 95, 1000);
    expect(d.nextState.state).toBe("PENDING");
    expect(d.action).toBe("none");
    state = d.nextState;

    d = evaluateRuleStep(rule, state, 50, 1060);
    expect(d.nextState.state).toBe("OK");
    expect(d.action).toBe("none");
    state = d.nextState;

    // 2. Sustained breach >= 120s -> FIRING
    d = evaluateRuleStep(rule, state, 92, 1100);
    expect(d.nextState.state).toBe("PENDING");
    state = d.nextState;

    d = evaluateRuleStep(rule, state, 93, 1220);
    expect(d.nextState.state).toBe("FIRING");
    expect(d.action).toBe("fire");
    state = d.nextState;

    // 3. Cooldown prevents re-notify before 3600s
    d = evaluateRuleStep(rule, state, 95, 2000);
    expect(d.action).toBe("none");
    state = d.nextState;

    // Re-notify after 3600s
    d = evaluateRuleStep(rule, state, 95, 4820);
    expect(d.action).toBe("renotify");
    state = d.nextState;

    // 4. Hysteresis: 87% (>= 85.5%) keeps FIRING
    d = evaluateRuleStep(rule, state, 87, 4850);
    expect(d.nextState.state).toBe("FIRING");
    expect(d.nextState.recover_ok_count).toBe(0);
    state = d.nextState;

    // 1st sample < 85.5% -> stays FIRING with recover_ok_count = 1
    d = evaluateRuleStep(rule, state, 84, 4880);
    expect(d.nextState.state).toBe("FIRING");
    expect(d.nextState.recover_ok_count).toBe(1);
    expect(d.action).toBe("none");
    state = d.nextState;

    // Bounce back >= 85.5% resets recover_ok_count to 0
    d = evaluateRuleStep(rule, state, 86, 4910);
    expect(d.nextState.state).toBe("FIRING");
    expect(d.nextState.recover_ok_count).toBe(0);
    state = d.nextState;

    // Two consecutive samples < 85.5% -> resolves!
    d = evaluateRuleStep(rule, state, 82, 4940);
    expect(d.nextState.recover_ok_count).toBe(1);
    expect(d.action).toBe("none");
    state = d.nextState;

    d = evaluateRuleStep(rule, state, 80, 4970);
    expect(d.nextState.state).toBe("OK");
    expect(d.action).toBe("resolve");
    expect(d.resolvedDurationSec).toBe(4970 - 1220);
  });

  it("formats Spec 6.2 Telegram HTML cards and retries 3x on 429/5xx", async () => {
    const firingHtml = formatTelegramAlertHtml({
      kind: "firing",
      nodeId: "nd_1",
      nodeName: "HK-BGP-Nano-01",
      groupName: "香港",
      ruleId: "rl_1",
      ruleName: "内存使用率过高",
      metric: "mem",
      operator: "gt",
      valueText: "94.2%",
      valueDetail: "961 MB / 1020 MB",
      thresholdText: "90%",
      durationSec: 120,
      triggerValue: 94.2,
      threshold: 90,
      timestampSec: 1794664510,
    });
    expect(firingHtml).toContain("🚨 <b>[UniOB 告警触发]</b>");
    expect(firingHtml).toContain("HK-BGP-Nano-01 (<code>香港</code>)");
    expect(firingHtml).toContain("&gt; 90% 持续 120s");
    expect(firingHtml).toContain("UTC+8");

    const resolvedHtml = formatTelegramAlertHtml({
      kind: "resolved",
      nodeId: "nd_1",
      nodeName: "HK-BGP-Nano-01",
      groupName: "香港",
      ruleId: "rl_1",
      ruleName: "内存使用率",
      metric: "mem",
      operator: "gt",
      valueText: "61.5%",
      valueDetail: "627 MB / 1020 MB",
      thresholdText: "90%",
      durationSec: 384, // 6m 24s
      triggerValue: 61.5,
      threshold: 90,
      timestampSec: 1794664894,
    });
    expect(resolvedHtml).toContain("✅ <b>[UniOB 故障恢复]</b>");
    expect(resolvedHtml).toContain("<b>故障历时：</b>6 分 24 秒");

    // 429 + 503 + 500 + 200 -> succeeds on 4th attempt (3 retries)
    let calls = 0;
    const delays: number[] = [];
    const mockFetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limit", { status: 429 });
      if (calls === 2) return new Response("bad gateway", { status: 502 });
      if (calls === 3) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const tgRes = await sendTelegramHtml(
      { bot_token: "111:AAA", chat_id: "-1009", thread_id: 5 },
      firingHtml,
      {
        maxRetries: 3,
        baseDelayMs: 10,
        fetchImpl: mockFetch,
        sleepImpl: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(tgRes.ok).toBe(true);
    expect(calls).toBe(4);
    expect(delays).toEqual([10, 20, 40]);

    // Webhook HMAC signature
    let capturedHeaders: Headers | undefined;
    const whRes = await sendWebhookJson(
      { url: "https://hooks.example.com/uniob", secret: "whsec_123" },
      { event: "alert.test" },
      {
        fetchImpl: (async (_url, init) => {
          capturedHeaders = new Headers(init?.headers);
          return new Response("ok", { status: 200 });
        }) as typeof fetch,
      },
    );
    expect(whRes.ok).toBe(true);
    expect(capturedHeaders?.get("X-UniOB-Signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("evaluates rules end-to-end in NodeDO and suppresses external push when muted", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "alert-e2e" });

    const tgCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.telegram.org/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
        tgCalls.push(body.text);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const chRes = await authedFetch("/api/alerts/channels", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Primary TG",
        type: "telegram",
        config: { bot_token: "bot:tok", chat_id: "999" },
      }),
    });
    expect(chRes.status).toBe(201);
    const { channel } = (await chRes.json()) as { channel: { id: string } };

    // Test channel endpoint
    const testRes = await authedFetch(`/api/alerts/channels/${channel.id}/test`, cookie, {
      method: "POST",
    });
    expect(testRes.status).toBe(200);
    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]).toContain("测试通知");

    // Create CPU rule with 60s debounce
    const ruleRes = await authedFetch("/api/alerts/rules", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "CPU 过载",
        node_id: node.id,
        metric: "cpu",
        operator: "gt",
        threshold: 90,
        duration_sec: 60,
        cooldown_sec: 3600,
        channel_ids: [channel.id],
      }),
    });
    expect(ruleRes.status).toBe(201);

    const ws = await connectAgentWs(node.id, agent_token);
    ws.send(JSON.stringify(makeHelloFrame()));
    const t0 = Math.floor(Date.now() / 1000) - 500;

    // Trigger PENDING -> FIRING -> RESOLVED
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t0, { cpu: { all: 95, cores: [95], steal: 0, iowait: 0, load: [1, 1, 1] } }),
      ),
    );
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t0 + 60, { cpu: { all: 96, cores: [96], steal: 0, iowait: 0, load: [1, 1, 1] } }),
      ),
    );
    // 1st recovery sample (< 85.5) -> not yet resolved
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t0 + 90, { cpu: { all: 80, cores: [80], steal: 0, iowait: 0, load: [1, 1, 1] } }),
      ),
    );
    await flushMicrotasks();
    expect(tgCalls).toHaveLength(2); // test + firing

    // 2nd recovery sample -> resolves!
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t0 + 120, { cpu: { all: 79, cores: [79], steal: 0, iowait: 0, load: [1, 1, 1] } }),
      ),
    );
    await flushMicrotasks();
    expect(tgCalls).toHaveLength(3); // test + firing + resolved

    // Now mute node for 30 minutes and trigger again: incident recorded, push suppressed!
    await authedFetch(`/api/nodes/${node.id}`, cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mute_until: Math.floor(Date.now() / 1000) + 1800 }),
    });

    ws.send(
      JSON.stringify(
        makeMetricsFrame(t0 + 150, { cpu: { all: 97, cores: [97], steal: 0, iowait: 0, load: [1, 1, 1] } }),
      ),
    );
    ws.send(
      JSON.stringify(
        makeMetricsFrame(t0 + 210, { cpu: { all: 98, cores: [98], steal: 0, iowait: 0, load: [1, 1, 1] } }),
      ),
    );
    await flushMicrotasks();

    // Still only 3 Telegram calls (muted!)
    expect(tgCalls).toHaveLength(3);

    // But D1 incidents has both resolved and firing incidents!
    const incRes = await authedFetch("/api/alerts/incidents?status=all&limit=10", cookie);
    const incBody = (await incRes.json()) as {
      incidents: Array<{ status: string }>;
      total: number;
    };
    expect(incBody.total).toBe(2);
    expect(incBody.incidents.some((i) => i.status === "firing")).toBe(true);
    expect(incBody.incidents.some((i) => i.status === "resolved")).toBe(true);

    // Presets API creates global templates idempotently
    const preset1 = await authedFetch("/api/alerts/rules/presets", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_ids: [channel.id] }),
    });
    expect(preset1.status).toBe(201);
    const presetBody1 = (await preset1.json()) as { rules: unknown[] };
    expect(presetBody1.rules.length).toBe(7); // 1 custom + 6 presets

    const preset2 = await authedFetch("/api/alerts/rules/presets", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_ids: [channel.id] }),
    });
    expect(preset2.status).toBe(200);

    ws.close();
  });
});
