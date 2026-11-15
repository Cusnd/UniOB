import {
  createExecutionContext,
  evictDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  BUNDLED_AGENT_VERSION,
  checkLatestAgentRelease,
  compareSemver,
  decodeAutoUpdateOverride,
  isEffectiveAutoUpdateEnabled,
  isNewerAgentVersion,
  parseAgentUpdateStatus,
  parseSha256Sums,
  RELEASE_CACHE_TTL_SEC,
  signUpdateDirective,
} from "../src/auto-update";
import { hmacSha256Hex, sha256Hex } from "../src/crypto";
import { exportBundle, importBundle } from "../src/migration";
import type {
  AgentCtrlFrame,
  AgentLatestRelease,
  AgentMetricsBatchFrame,
  AgentUpdateConfig,
  ExportBundle,
  FleetTickMessage,
  NodeSummary,
} from "../src/types";

interface AgentUpdateConfigResponse {
  ok: boolean;
  config: AgentUpdateConfig;
  latest_release: AgentLatestRelease | null;
  bundled_version: string;
}
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
  TEST_ORIGIN,
} from "./helpers";

const AMD64_SHA =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ARM64_SHA =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function makeSha256SumsText(): string {
  return [
    `${AMD64_SHA}  uniob-agent-x86_64-unknown-linux-musl`,
    `${ARM64_SHA}  uniob-agent-aarch64-unknown-linux-musl`,
  ].join("\n");
}

function makeFakeAssets(version = "0.3.0"): {
  fetcher: Fetcher;
  urls: string[];
} {
  const urls: string[] = [];
  const fetcher = {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      const pathname = new URL(url).pathname;
      if (pathname === "/releases/SHA256SUMS") {
        return new Response(makeSha256SumsText(), {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      if (pathname === "/releases/VERSION") {
        return new Response(`${version}\n`, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response("<!doctype html><html><body>SPA</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  } as unknown as Fetcher;
  return { fetcher, urls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Agent Auto-Update (`auto_update_v1`)", () => {
  it("distinguishes WORKER_VERSION 2.0.0 from BUNDLED_AGENT_VERSION 0.2.0 and parses wire formats", () => {
    expect(BUNDLED_AGENT_VERSION).toBe("0.2.0");

    expect(compareSemver("0.2.1", "0.2.0")).toBeGreaterThan(0);
    expect(compareSemver("v0.2.0", "0.2.0")).toBe(0);
    expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(isNewerAgentVersion("0.3.0", "0.2.0")).toBe(true);
    expect(isNewerAgentVersion("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerAgentVersion("0.1.9", "0.2.0")).toBe(false);

    // Compact Rust agent wire shape `{ st, ver?, err?, ts? }`
    expect(
      parseAgentUpdateStatus({
        st: "downloading",
        ver: "0.3.0",
        ts: 1700000010,
      }),
    ).toEqual({
      state: "downloading",
      target_version: "0.3.0",
      updated_at: 1700000010,
    });

    // Verbose shape `{ state, target_version?, error?, updated_at? }`
    expect(
      parseAgentUpdateStatus({
        state: "error",
        target_version: "0.3.0",
        error: "sha256 mismatch",
        updated_at: 1700000020,
      }),
    ).toEqual({
      state: "error",
      target_version: "0.3.0",
      error: "sha256 mismatch",
      updated_at: 1700000020,
    });

    expect(
      parseAgentUpdateStatus({
        st: "error",
        err: "bad\u0085ctrl",
        ts: 1700000030,
      }),
    ).toEqual({
      state: "error",
      updated_at: 1700000030,
    });

    expect(parseAgentUpdateStatus({ st: "bogus" })).toBeNull();
    expect(parseSha256Sums("<!DOCTYPE html><html></html>").size).toBe(0);
    expect(parseSha256Sums(makeSha256SumsText()).size).toBe(2);
  });

  it("signs UpdateDirective with lowercase token_sha256 HMAC-SHA256 matching WebCrypto", async () => {
    const token = "agent-secret-token-xyz";
    const tokenShaLower = await sha256Hex(token);
    const upperTokenSha = tokenShaLower.toUpperCase();

    const dirWithFallback = await signUpdateDirective("node-1", upperTokenSha, {
      version: "0.3.0",
      sha256: AMD64_SHA.toUpperCase(),
      url: "https://uniob.example.com/releases/uniob-agent-x86_64-unknown-linux-musl",
      fallback_url:
        "https://github.com/Cusnd/UniOB/releases/download/v0.3.0/uniob-agent-x86_64-unknown-linux-musl",
      issued_at: 1700001111,
    });
    const expectedMsgWithFallback = `agent_update_v1:node-1:0.3.0:${AMD64_SHA}:1700001111:https://uniob.example.com/releases/uniob-agent-x86_64-unknown-linux-musl:https://github.com/Cusnd/UniOB/releases/download/v0.3.0/uniob-agent-x86_64-unknown-linux-musl`;
    expect(dirWithFallback.sha256).toBe(AMD64_SHA);
    expect(dirWithFallback.hmac).toBe(
      await hmacSha256Hex(expectedMsgWithFallback, tokenShaLower),
    );

    const dirNoFallback = await signUpdateDirective("node-1", tokenShaLower, {
      version: "0.3.0",
      sha256: ARM64_SHA,
      url: "https://uniob.example.com/releases/uniob-agent-aarch64-unknown-linux-musl",
      issued_at: 1700001112,
    });
    expect("fallback_url" in dirNoFallback).toBe(false);
    const expectedMsgNoFallback = `agent_update_v1:node-1:0.3.0:${ARM64_SHA}:1700001112:https://uniob.example.com/releases/uniob-agent-aarch64-unknown-linux-musl:`;
    expect(dirNoFallback.hmac).toBe(
      await hmacSha256Hex(expectedMsgNoFallback, tokenShaLower),
    );
  });

  it("requires admin auth and validates config + SSRF protection on /api/agent-update/*", async () => {
    for (const [method, path] of [
      ["GET", "/api/agent-update/config"],
      ["PUT", "/api/agent-update/config"],
      ["POST", "/api/agent-update/check"],
      ["POST", "/api/agent-update/trigger"],
    ] as const) {
      const res = await SELF.fetch(`${TEST_ORIGIN}${path}`, { method });
      expect(res.status).toBe(401);
    }

    const health = await (await SELF.fetch(`${TEST_ORIGIN}/api/health`)).json<{
      version: string;
    }>();
    expect(health.version).toBe("2.0.0");

    const cookie = await setupAndLogin();
    const initialRes = await authedFetch("/api/agent-update/config", cookie);
    expect(initialRes.status).toBe(200);
    const initial = await initialRes.json<AgentUpdateConfigResponse>();
    expect(initial).toEqual({
      ok: true,
      config: {
        auto_update_enabled: false,
        channel: "stable",
        check_interval_sec: 21600,
        custom_base_url: "",
      },
      latest_release: null,
      bundled_version: "0.2.0",
    });

    // Reject SSRF custom_base_url, bad channel, out-of-range interval, unknown keys
    for (const badBody of [
      { channel: "nightly" },
      { check_interval_sec: 59 },
      { check_interval_sec: 604801 },
      { custom_base_url: "http://127.0.0.1:8080/releases" },
      { custom_base_url: "https://192.168.1.5/releases" },
      { custom_base_url: "https://169.254.169.254/latest" },
      { custom_base_url: "ftp://example.com/releases" },
      { unknown_flag: true },
    ]) {
      const res = await authedFetch("/api/agent-update/config", cookie, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(badBody),
      });
      expect(res.status).toBe(400);
    }

    const putRes = await authedFetch("/api/agent-update/config", cookie, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auto_update_enabled: true,
        channel: "github",
        check_interval_sec: 3600,
        custom_base_url: "https://cdn.example.com/agent-releases/",
      }),
    });
    expect(putRes.status).toBe(200);
    const saved = await putRes.json<AgentUpdateConfigResponse>();
    expect(saved.ok).toBe(true);
    expect(saved.config).toEqual({
      auto_update_enabled: true,
      channel: "github",
      check_interval_sec: 3600,
      custom_base_url: "https://cdn.example.com/agent-releases",
    });
    expect(saved.bundled_version).toBe("0.2.0");

    const refetch = await (
      await authedFetch("/api/agent-update/config", cookie)
    ).json<AgentUpdateConfigResponse>();
    expect(refetch.config).toEqual(saved.config);
  });

  it("resolves releases from env.ASSETS (guarding SPA HTML), GitHub API, and 15-min D1 cache", async () => {
    const cookie = await setupAndLogin();

    // Test fixture assets dir lacks /releases/SHA256SUMS and serves SPA index.html (200 text/html);
    // verify Worker ignores HTML from ASSETS and (when GitHub fallback is also unreachable) returns null safely.
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");
    globalFetchSpy.mockImplementation(async (input) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (u.startsWith("https://api.github.com/")) {
        return new Response("offline", { status: 503 });
      }
      throw new Error(`Unexpected fetch URL during SPA fallback check: ${u}`);
    });

    const spaFallbackCheck = await (
      await authedFetch("/api/agent-update/check", cookie, { method: "POST" })
    ).json<{ ok: boolean; latest_release: AgentLatestRelease | null; error: string | null }>();
    expect(spaFallbackCheck.ok).toBe(true);
    expect(spaFallbackCheck.latest_release).toBeNull();
    expect(spaFallbackCheck.error).toBeTruthy();

    // Serve valid SHA256SUMS + VERSION via env.ASSETS.fetch (not global fetch loopback)
    globalFetchSpy.mockClear();
    const { fetcher: assetsFetcher, urls: assetUrls } = makeFakeAssets("0.3.0");

    const ctx1 = createExecutionContext();
    const res1 = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/agent-update/check`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: TEST_ORIGIN },
      }),
      { ...env, ASSETS: assetsFetcher },
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    expect(res1.status).toBe(200);
    const body1 = await res1.json<{
      ok: boolean;
      bundled_version: string;
      latest_release: AgentLatestRelease | null;
      error: string | null;
    }>();
    expect(body1.ok).toBe(true);
    expect(body1.bundled_version).toBe("0.2.0");
    expect(body1.error).toBeNull();
    expect(body1.latest_release?.version).toBe("0.3.0");
    expect(body1.latest_release?.source).toBe("assets");
    expect(body1.latest_release?.assets.amd64).toMatchObject({
      arch: "amd64",
      sha256: AMD64_SHA,
      url: `${TEST_ORIGIN}/releases/uniob-agent-x86_64-unknown-linux-musl`,
      fallback_url:
        "https://github.com/Cusnd/UniOB/releases/download/v0.3.0/uniob-agent-x86_64-unknown-linux-musl",
    });
    expect(body1.latest_release?.assets.arm64).toMatchObject({
      arch: "arm64",
      sha256: ARM64_SHA,
    });
    expect(assetUrls).toEqual([
      `${TEST_ORIGIN}/releases/SHA256SUMS`,
      `${TEST_ORIGIN}/releases/VERSION`,
    ]);
    expect(globalFetchSpy).not.toHaveBeenCalled();

    // Cached result (< 900s TTL) is returned without re-fetching ASSETS
    const nowSec = Math.floor(Date.now() / 1000);
    const cachedRes = await checkLatestAgentRelease(
      { ...env, ASSETS: assetsFetcher },
      {
        auto_update_enabled: false,
        channel: "stable",
        check_interval_sec: 21600,
        custom_base_url: "",
      },
      { requestOrigin: TEST_ORIGIN, nowSec: nowSec + RELEASE_CACHE_TTL_SEC - 10 },
    );
    expect(cachedRes.release?.version).toBe("0.3.0");
    expect(assetUrls).toHaveLength(2);

    // Switch channel to GitHub & force check -> fetches repos/Cusnd/UniOB/releases/latest
    await authedFetch("/api/agent-update/config", cookie, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "github", auto_update_enabled: false }),
    });

    globalFetchSpy.mockImplementation(async (input) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (u === "https://api.github.com/repos/Cusnd/UniOB/releases/latest") {
        return new Response(
          JSON.stringify({
            tag_name: "v0.4.0",
            published_at: "2026-11-15T00:00:00Z",
            html_url: "https://github.com/Cusnd/UniOB/releases/tag/v0.4.0",
            assets: [
              {
                name: "SHA256SUMS",
                browser_download_url:
                  "https://github.com/Cusnd/UniOB/releases/download/v0.4.0/SHA256SUMS",
              },
              {
                name: "uniob-agent-x86_64-unknown-linux-musl",
                browser_download_url:
                  "https://github.com/Cusnd/UniOB/releases/download/v0.4.0/uniob-agent-x86_64-unknown-linux-musl",
              },
              {
                name: "uniob-agent-aarch64-unknown-linux-musl",
                browser_download_url:
                  "https://github.com/Cusnd/UniOB/releases/download/v0.4.0/uniob-agent-aarch64-unknown-linux-musl",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (
        u ===
        "https://github.com/Cusnd/UniOB/releases/download/v0.4.0/SHA256SUMS"
      ) {
        return new Response(makeSha256SumsText(), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${u}`);
    });

    const ghCheck = await (
      await authedFetch("/api/agent-update/check", cookie, { method: "POST" })
    ).json<{ ok: boolean; latest_release: AgentLatestRelease | null; error: string | null }>();
    expect(ghCheck.ok).toBe(true);
    expect(ghCheck.error).toBeNull();
    expect(ghCheck.latest_release?.source).toBe("github");
    expect(ghCheck.latest_release?.version).toBe("0.4.0");
    expect(ghCheck.latest_release?.tag).toBe("v0.4.0");
    expect(ghCheck.latest_release?.assets.arm64?.sha256).toBe(ARM64_SHA);
  });

  it("dispatches signed ctrl.update via override/auto-update & manual trigger, ingests upd frames, and clears status on upgrade", async () => {
    const cookie = await setupAndLogin();
    const nInherit = await createTestNode(cookie, { name: "inherit-node" });
    const nDisabled = await createTestNode(cookie, { name: "disabled-node" });
    const nNoCap = await createTestNode(cookie, { name: "nocap-node" });

    // Per-node override validation & persistence
    const badPatch = await authedFetch(`/api/nodes/${nDisabled.node.id}`, cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_update_override: "yes" }),
    });
    expect(badPatch.status).toBe(400);

    const disablePatch = await authedFetch(
      `/api/nodes/${nDisabled.node.id}`,
      cookie,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_update_override: false }),
      },
    );
    expect(disablePatch.status).toBe(200);
    const patchedBody = await disablePatch.json<{ node: NodeSummary }>();
    expect(patchedBody.node.auto_update_override).toBe(false);

    // Seed release 0.3.0 in D1 cache and enable global auto-update
    const { fetcher: assetsFetcher } = makeFakeAssets("0.3.0");
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/agent-update/check`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: TEST_ORIGIN },
      }),
      { ...env, ASSETS: assetsFetcher },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    await authedFetch("/api/agent-update/config", cookie, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auto_update_enabled: true,
        channel: "stable",
      }),
    });

    // Subscribe browser client to watch fleet_tick updates
    const clientWs = await connectClientWs(cookie);
    const initialBatchPromise = nextWsMessage(
      clientWs,
      (m: any) => m.t === "fleet_batch",
    );
    clientWs.send(JSON.stringify({ op: "sub_fleet" }));
    await initialBatchPromise;

    // 1. Inherit node (auto_update_override = null, global = true, cap = auto_update_v1, 0.2.0 < 0.3.0) receives ctrl.update on hello
    const wsInherit = await connectAgentWs(nInherit.node.id, nInherit.agent_token);
    const firstInherit = nextWsMessage<AgentCtrlFrame>(wsInherit, (m) => m.t === "ctrl");
    wsInherit.send(
      JSON.stringify(
        makeHelloFrame({
          v: 2,
          agent_ver: "0.2.0",
          arch: "amd64",
          capabilities: ["mb_v2", "auto_update_v1"],
        }),
      ),
    );
    const ctrlInherit = await firstInherit;
    expect(ctrlInherit.update).toBeDefined();
    expect(ctrlInherit.update?.version).toBe("0.3.0");
    expect(ctrlInherit.update?.sha256).toBe(AMD64_SHA);
    const inheritTokenHash = await sha256Hex(nInherit.agent_token);
    const expectedDirective = await signUpdateDirective(
      nInherit.node.id,
      inheritTokenHash,
      {
        version: ctrlInherit.update!.version,
        sha256: ctrlInherit.update!.sha256,
        url: ctrlInherit.update!.url,
        fallback_url: ctrlInherit.update!.fallback_url,
        issued_at: ctrlInherit.update!.issued_at,
      },
    );
    expect(ctrlInherit.update!.hmac).toBe(expectedDirective.hmac);

    // 2. Disabled node (`auto_update_override: false`) does NOT receive auto ctrl.update on hello
    const wsDisabled = await connectAgentWs(nDisabled.node.id, nDisabled.agent_token);
    const firstDisabled = nextWsMessage<AgentCtrlFrame>(wsDisabled, (m) => m.t === "ctrl");
    wsDisabled.send(
      JSON.stringify(
        makeHelloFrame({
          v: 2,
          agent_ver: "0.2.0",
          arch: "arm64",
          capabilities: ["mb_v2", "auto_update_v1"],
        }),
      ),
    );
    const ctrlDisabled = await firstDisabled;
    expect(ctrlDisabled.update).toBeUndefined();

    // 3. Node missing `auto_update_v1` cap never gets ctrl.update
    const wsNoCap = await connectAgentWs(nNoCap.node.id, nNoCap.agent_token);
    const firstNoCap = nextWsMessage<AgentCtrlFrame>(wsNoCap, (m) => m.t === "ctrl");
    wsNoCap.send(
      JSON.stringify(
        makeHelloFrame({
          v: 2,
          agent_ver: "0.2.0",
          arch: "amd64",
          capabilities: ["mb_v2"],
        }),
      ),
    );
    const ctrlNoCap = await firstNoCap;
    expect(ctrlNoCap.update).toBeUndefined();

    // Manual trigger without force skips override=false node and nocap node
    const trigNoForce = await (
      await authedFetch("/api/agent-update/trigger", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_ids: [nDisabled.node.id, nNoCap.node.id],
          force: false,
        }),
      })
    ).json<{ ok: boolean; targeted: number; dispatched: number; skipped: number }>();
    expect(trigNoForce).toMatchObject({
      ok: true,
      targeted: 2,
      dispatched: 0,
      skipped: 2,
    });

    // Manual trigger WITH force pushes ctrl.update to override=false node (still skips nocap)
    const manualCtrlPromise = nextWsMessage<AgentCtrlFrame>(
      wsDisabled,
      (m) => m.t === "ctrl" && Boolean(m.update),
    );
    const trigForce = await (
      await authedFetch("/api/agent-update/trigger", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_ids: [nDisabled.node.id, nNoCap.node.id],
          force: true,
        }),
      })
    ).json<{ ok: boolean; version: string; targeted: number; dispatched: number; skipped: number }>();
    expect(trigForce).toEqual({
      ok: true,
      version: "0.3.0",
      targeted: 2,
      dispatched: 1,
      skipped: 1,
    });
    const manualCtrl = await manualCtrlPromise;
    expect(manualCtrl.update?.version).toBe("0.3.0");
    expect(manualCtrl.update?.sha256).toBe(ARM64_SHA);

    // Agent sends compact Rust MetricsFrame `upd` -> fleet_tick & GET /api/nodes/:id surface normalized update_status + caps
    const now = Math.floor(Date.now() / 1000);
    const tickDownloading = nextWsMessage<FleetTickMessage>(
      clientWs,
      (m) =>
        m.t === "fleet_tick" &&
        m.nodeId === nInherit.node.id &&
        m.update_status?.state === "downloading",
    );
    wsInherit.send(
      JSON.stringify({
        ...makeMetricsFrame(now),
        upd: { st: "downloading", ver: "0.3.0", ts: now },
      }),
    );
    const tick1 = await tickDownloading;
    expect(tick1.caps).toEqual(["mb_v2", "auto_update_v1"]);
    expect(tick1.update_status).toEqual({
      state: "downloading",
      target_version: "0.3.0",
      updated_at: now,
    });

    // Agent sends MetricsBatchFrame `mb.upd` -> staged status ingested cleanly
    const mbFrame: AgentMetricsBatchFrame = {
      t: "mb",
      v: 2,
      reason: "flush",
      pts: [],
      last: {
        ts: now + 5,
        up: 125,
        cpu: makeMetricsFrame(now + 5).cpu,
        mem: makeMetricsFrame(now + 5).mem,
        disks: makeMetricsFrame(now + 5).disks,
        net: makeMetricsFrame(now + 5).net,
      },
      upd: { st: "staged", ver: "0.3.0", ts: now + 5 },
    };
    wsInherit.send(JSON.stringify(mbFrame));
    await flushMicrotasks();

    const nodeGetRes = await (
      await authedFetch(`/api/nodes/${nInherit.node.id}`, cookie)
    ).json<{ node: NodeSummary }>();
    expect(nodeGetRes.node.caps).toEqual(["mb_v2", "auto_update_v1"]);
    expect(nodeGetRes.node.auto_update_override).toBeNull();
    expect(nodeGetRes.node.update_status).toEqual({
      state: "staged",
      target_version: "0.3.0",
      updated_at: now + 5,
    });

    // Simulate agent restarting on newly upgraded 0.3.0 -> staged clears to idle and no new ctrl.update is dispatched
    wsInherit.close(1000, "restarting");
    await flushMicrotasks();

    const wsUpgraded = await connectAgentWs(nInherit.node.id, nInherit.agent_token);
    const firstUpgraded = nextWsMessage<AgentCtrlFrame>(wsUpgraded, (m) => m.t === "ctrl");
    wsUpgraded.send(
      JSON.stringify(
        makeHelloFrame({
          v: 2,
          agent_ver: "0.3.0",
          arch: "amd64",
          capabilities: ["mb_v2", "auto_update_v1"],
        }),
      ),
    );
    const ctrlUpgraded = await firstUpgraded;
    expect(ctrlUpgraded.update).toBeUndefined();

    const postUpgrade = await (
      await authedFetch(`/api/nodes/${nInherit.node.id}`, cookie)
    ).json<{ node: NodeSummary }>();
    expect(postUpgrade.node.agent_version).toBe("0.3.0");
    expect(postUpgrade.node.update_status?.state).toBe("idle");

    wsUpgraded.close(1000, "done");
    wsDisabled.close(1000, "done");
    wsNoCap.close(1000, "done");
    clientWs.close(1000, "done");
  });

  it("preserves agent_update_config and auto_update_override across export/import while excluding agent_update_cache and enforcing SSRF checks", async () => {
    const cookie = await setupAndLogin();
    const nTrue = await createTestNode(cookie, { name: "exp-true" });
    const nFalse = await createTestNode(cookie, { name: "exp-false" });

    await authedFetch(`/api/nodes/${nTrue.node.id}`, cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_update_override: true }),
    });
    await authedFetch(`/api/nodes/${nFalse.node.id}`, cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_update_override: false }),
    });
    await authedFetch("/api/agent-update/config", cookie, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auto_update_enabled: true,
        channel: "github",
        check_interval_sec: 1800,
      }),
    });

    // Ensure release cache exists in D1 so export exclusion is verified
    const { fetcher: assetsFetcher } = makeFakeAssets("0.3.0");
    await checkLatestAgentRelease(
      { ...env, ASSETS: assetsFetcher },
      {
        auto_update_enabled: true,
        channel: "stable",
        check_interval_sec: 1800,
        custom_base_url: "",
      },
      { requestOrigin: TEST_ORIGIN, force: true },
    );

    const bundle = await exportBundle(env);
    expect(
      bundle.system_settings.some((s) => s.key === "agent_update_cache"),
    ).toBe(false);
    const exportedCfg = bundle.system_settings.find(
      (s) => s.key === "agent_update_config",
    );
    expect(exportedCfg).toBeDefined();
    expect(JSON.parse(exportedCfg!.value)).toMatchObject({
      auto_update_enabled: true,
      channel: "github",
      check_interval_sec: 1800,
    });
    expect(
      bundle.nodes.find((n) => n.id === nTrue.node.id)?.auto_update_override,
    ).toBe(1);
    expect(
      bundle.nodes.find((n) => n.id === nFalse.node.id)?.auto_update_override,
    ).toBe(0);

    // Malicious SSRF agent_update_config in bundle must be rejected
    const badBundle: ExportBundle = structuredClone(bundle);
    badBundle.system_settings = badBundle.system_settings.map((s) =>
      s.key === "agent_update_config"
        ? {
            ...s,
            value: JSON.stringify({
              auto_update_enabled: true,
              channel: "stable",
              check_interval_sec: 600,
              custom_base_url: "http://127.0.0.1:9000/bad",
            }),
          }
        : s,
    );
    const badImportRes = await importBundle(
      env,
      badBundle as unknown as Record<string, unknown>,
    );
    expect(badImportRes).toMatchObject({ ok: false, status: 400 });

    // Injecting agent_update_cache must be stripped/skipped while valid overrides + config import cleanly
    const cleanImport: ExportBundle = structuredClone(bundle);
    cleanImport.system_settings.push({
      key: "agent_update_cache",
      value: JSON.stringify({ version: "9.9.9" }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    await importBundle(env, cleanImport as unknown as Record<string, unknown>);

    const doId = env.FLEET_HUB_DO.idFromName("global");
    await evictDurableObject(env.FLEET_HUB_DO.get(doId));

    const nodesRes = await (await authedFetch("/api/nodes", cookie)).json<{
      nodes: NodeSummary[];
    }>();
    expect(
      nodesRes.nodes.find((n) => n.id === nTrue.node.id)?.auto_update_override,
    ).toBe(true);
    expect(
      nodesRes.nodes.find((n) => n.id === nFalse.node.id)?.auto_update_override,
    ).toBe(false);

    // Override helper equivalence check
    expect(decodeAutoUpdateOverride(1)).toBe(true);
    expect(decodeAutoUpdateOverride(0)).toBe(false);
    expect(decodeAutoUpdateOverride(null)).toBeNull();
    expect(
      isEffectiveAutoUpdateEnabled(null, {
        auto_update_enabled: true,
        channel: "stable",
        check_interval_sec: 21600,
        custom_base_url: "",
      }),
    ).toBe(true);
    expect(
      isEffectiveAutoUpdateEnabled(false, {
        auto_update_enabled: true,
        channel: "stable",
        check_interval_sec: 21600,
        custom_base_url: "",
      }),
    ).toBe(false);
  });
});
