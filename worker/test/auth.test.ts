import { listDurableObjectIds, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCloudflareAccessModeForced,
  parseAllowedEmails,
} from "../src/auth";
import { sha256Hex } from "../src/crypto";
import type { Env } from "../src/types";
import { createTestNode, setupAndLogin, TEST_ORIGIN } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createCfAccessSigner(teamDomain = "myteam", aud = "aud-test-123") {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  )) as JsonWebKey;
  const jwkWithKid = { ...publicJwk, kid: "test-key-1", alg: "RS256" };
  const enc = new TextEncoder();

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [jwkWithKid] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  async function signJwt(extraClaims: Record<string, unknown> = {}): Promise<string> {
    const header = base64UrlFromBytes(
      enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key-1" })),
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = base64UrlFromBytes(
      enc.encode(
        JSON.stringify({
          aud: [aud],
          iss: `https://${teamDomain}.cloudflareaccess.com`,
          exp: nowSec + 300,
          iat: nowSec,
          ...extraClaims,
        }),
      ),
    );
    const signingInput = `${header}.${payload}`;
    const sigBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      enc.encode(signingInput),
    );
    return `${signingInput}.${base64UrlFromBytes(new Uint8Array(sigBuf))}`;
  }

  return { signJwt };
}

async function withEnvOverrides<T>(
  overrides: Partial<
    Pick<
      Env,
      "AUTH_MODE" | "CF_ACCESS_TEAM_DOMAIN" | "CF_ACCESS_AUD" | "CF_ACCESS_ALLOWED_EMAILS"
    >
  >,
  fn: () => Promise<T>,
): Promise<T> {
  const mutableEnv = env as {
    AUTH_MODE?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
    CF_ACCESS_ALLOWED_EMAILS?: string;
  };
  const prev = {
    AUTH_MODE: mutableEnv.AUTH_MODE,
    CF_ACCESS_TEAM_DOMAIN: mutableEnv.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: mutableEnv.CF_ACCESS_AUD,
    CF_ACCESS_ALLOWED_EMAILS: mutableEnv.CF_ACCESS_ALLOWED_EMAILS,
  };
  Object.assign(mutableEnv, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(mutableEnv, prev);
  }
}

describe("Auth & Edge Security", () => {
  it("supports first-run setup, cookie attributes, login, and logout", async () => {
    const me1 = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`);
    expect(me1.status).toBe(200);
    expect(await me1.json()).toEqual({
      authenticated: false,
      needsSetup: true,
      mode: "builtin",
    });

    // Protected route blocked before auth
    const unauthNodes = await SELF.fetch(`${TEST_ORIGIN}/api/nodes`);
    expect(unauthNodes.status).toBe(401);

    // Reject too-short password
    const badSetup = await SELF.fetch(`${TEST_ORIGIN}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "123" }),
    });
    expect(badSetup.status).toBe(400);

    // Valid setup over HTTPS sets Secure cookie
    const setupRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "MyAdminPassword1!" }),
    });
    expect(setupRes.status).toBe(200);
    const setCookie = setupRes.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("uniob_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=604800");
    expect(setCookie).toContain("Secure");

    // Second setup attempt rejected
    const secondSetup = await SELF.fetch(`${TEST_ORIGIN}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "OtherPassword1!" }),
    });
    expect(secondSetup.status).toBe(409);

    const cookiePair = setCookie.split(";")[0]!;
    const me2 = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
      headers: { Cookie: cookiePair },
    });
    expect(await me2.json()).toEqual({
      authenticated: true,
      needsSetup: false,
      mode: "builtin",
    });

    // HTTP request omits Secure attribute
    const loginHttp = await SELF.fetch("http://127.0.0.1/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "MyAdminPassword1!" }),
    });
    expect(loginHttp.status).toBe(200);
    const httpCookie = loginHttp.headers.get("Set-Cookie") ?? "";
    expect(httpCookie).toContain("HttpOnly");
    expect(httpCookie).not.toContain("Secure");

    // Logout clears cookie
    const logoutRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookiePair },
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("rate limits IP after 5 failed logins (429)", async () => {
    await setupAndLogin("CorrectPass123!");
    const ip = "203.0.113.42";

    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch(`${TEST_ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": ip,
        },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt from same IP -> 429
    const limited = await SELF.fetch(`${TEST_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": ip,
      },
      body: JSON.stringify({ password: "CorrectPass123!" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();

    // Different IP can still log in
    const otherIp = await SELF.fetch(`${TEST_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.99",
      },
      body: JSON.stringify({ password: "CorrectPass123!" }),
    });
    expect(otherIp.status).toBe(200);
  });

  it("supports 64-char SHA-256 ADMIN_PASSWORD_HASH env var", async () => {
    const hash = await sha256Hex("EnvSecretPass!");
    const prevHash = env.ADMIN_PASSWORD_HASH;
    (env as { ADMIN_PASSWORD_HASH?: string }).ADMIN_PASSWORD_HASH = hash;
    try {
      const me = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`);
      expect(await me.json()).toEqual({
        authenticated: false,
        needsSetup: false,
        mode: "builtin",
      });

      const bad = await SELF.fetch(`${TEST_ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "nope" }),
      });
      expect(bad.status).toBe(401);

      const ok = await SELF.fetch(`${TEST_ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "EnvSecretPass!" }),
      });
      expect(ok.status).toBe(200);
    } finally {
      (env as { ADMIN_PASSWORD_HASH?: string }).ADMIN_PASSWORD_HASH = prevHash;
    }
  });

  it("verifies Cloudflare Access Cf-Access-Jwt-Assertion via RS256 JWKS", async () => {
    const { signJwt } = await createCfAccessSigner("myteam", "aud-test-123");
    const jwt = await signJwt({ email: "ops@uniob.dev" });

    await withEnvOverrides(
      {
        CF_ACCESS_TEAM_DOMAIN: "myteam",
        CF_ACCESS_AUD: "aud-test-123",
        CF_ACCESS_ALLOWED_EMAILS: "",
      },
      async () => {
        const missingJwt = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`);
        expect(await missingJwt.json()).toEqual({
          authenticated: false,
          needsSetup: false,
          mode: "cf_access",
        });

        const validJwt = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": jwt },
        });
        expect(await validJwt.json()).toEqual({
          authenticated: true,
          needsSetup: false,
          mode: "cf_access",
          email: "ops@uniob.dev",
        });

        const tamperedJwt = `${jwt.slice(0, -4)}AAAA`;
        const badJwt = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": tamperedJwt },
        });
        expect(await badJwt.json()).toEqual({
          authenticated: false,
          needsSetup: false,
          mode: "cf_access",
        });

        // Builtin setup & login are rejected when Cloudflare Access is enabled
        const setupRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "StrongPass123!" }),
        });
        expect(setupRes.status).toBe(400);

        const loginRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "StrongPass123!" }),
        });
        expect(loginRes.status).toBe(400);
      },
    );
  });

  it("enforces CF_ACCESS_ALLOWED_EMAILS allowlist case-insensitively and returns 403 for unauthorized or missing email", async () => {
    // Default wrangler.jsonc var preconfigures admin@example.com
    expect(env.CF_ACCESS_ALLOWED_EMAILS).toBe("admin@example.com");
    expect([...parseAllowedEmails(" ADMIN@EXAMPLE.COM , , ops@example.com , ")]).toEqual([
      "admin@example.com",
      "ops@example.com",
    ]);

    const { signJwt } = await createCfAccessSigner("myteam", "aud-test-123");
    const exactJwt = await signJwt({ email: "admin@example.com" });
    const upperJwt = await signJwt({ email: "ADMIN@EXAMPLE.COM" });
    const intruderJwt = await signJwt({ email: "intruder@example.com" });
    const missingEmailJwt = await signJwt({});
    const blankEmailJwt = await signJwt({ email: "   " });

    // Exercise wrangler.jsonc's default CF_ACCESS_ALLOWED_EMAILS without overriding it
    await withEnvOverrides(
      {
        AUTH_MODE: "cf_access",
        CF_ACCESS_TEAM_DOMAIN: "myteam",
        CF_ACCESS_AUD: "aud-test-123",
      },
      async () => {
        // Exact allowlisted email -> authenticated
        const okExact = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": exactJwt },
        });
        expect(okExact.status).toBe(200);
        expect(await okExact.json()).toEqual({
          authenticated: true,
          needsSetup: false,
          mode: "cf_access",
          email: "admin@example.com",
        });

        // Case-insensitive match -> authenticated
        const okUpper = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": upperJwt },
        });
        expect(okUpper.status).toBe(200);
        expect(await okUpper.json()).toEqual({
          authenticated: true,
          needsSetup: false,
          mode: "cf_access",
          email: "ADMIN@EXAMPLE.COM",
        });

        // Admin API succeeds for allowlisted email
        const nodesOk = await SELF.fetch(`${TEST_ORIGIN}/api/nodes`, {
          headers: { "Cf-Access-Jwt-Assertion": upperJwt },
        });
        expect(nodesOk.status).toBe(200);

        // Unauthorized email -> forbidden: true & 403 on admin routes
        const intruderMe = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": intruderJwt },
        });
        expect(intruderMe.status).toBe(200);
        expect(await intruderMe.json()).toEqual({
          authenticated: false,
          forbidden: true,
          needsSetup: false,
          mode: "cf_access",
          email: "intruder@example.com",
        });

        for (const [path, init] of [
          ["/api/nodes", {}],
          ["/api/nodes/nd_unknown/metrics", {}],
          ["/api/alerts/rules", {}],
          ["/api/client/ws", { headers: { Upgrade: "websocket" } }],
        ] as const) {
          const headers = new Headers("headers" in init ? init.headers : undefined);
          headers.set("Cf-Access-Jwt-Assertion", intruderJwt);
          const forbiddenRes = await SELF.fetch(`${TEST_ORIGIN}${path}`, { headers });
          expect(forbiddenRes.status).toBe(403);
          expect(await forbiddenRes.json()).toEqual({
            error: "Forbidden: email is not authorized",
          });
        }

        // Valid JWT missing email claim when allowlist is set -> forbidden: true & 403
        const noEmailMe = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": missingEmailJwt },
        });
        expect(noEmailMe.status).toBe(200);
        expect(await noEmailMe.json()).toEqual({
          authenticated: false,
          forbidden: true,
          needsSetup: false,
          mode: "cf_access",
        });

        const noEmailNodes = await SELF.fetch(`${TEST_ORIGIN}/api/nodes`, {
          headers: { "Cf-Access-Jwt-Assertion": missingEmailJwt },
        });
        expect(noEmailNodes.status).toBe(403);
        expect(await noEmailNodes.json()).toEqual({
          error: "Forbidden: email is not authorized",
        });

        // Whitespace-only email claim is also rejected with 403
        const blankEmailMe = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": blankEmailJwt },
        });
        expect(blankEmailMe.status).toBe(200);
        expect(await blankEmailMe.json()).toEqual({
          authenticated: false,
          forbidden: true,
          needsSetup: false,
          mode: "cf_access",
        });
      },
    );

    // Comma-separated allowlist supports multiple admin emails
    await withEnvOverrides(
      {
        AUTH_MODE: "cf_access",
        CF_ACCESS_TEAM_DOMAIN: "myteam",
        CF_ACCESS_AUD: "aud-test-123",
        CF_ACCESS_ALLOWED_EMAILS: " backup@example.com , admin@example.com ",
      },
      async () => {
        const res = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`, {
          headers: { "Cf-Access-Jwt-Assertion": exactJwt },
        });
        expect(await res.json()).toEqual({
          authenticated: true,
          needsSetup: false,
          mode: "cf_access",
          email: "admin@example.com",
        });
      },
    );
  });

  it("fails closed when AUTH_MODE=cf_access is set without CF_ACCESS_AUD", async () => {
    expect(isCloudflareAccessModeForced({ AUTH_MODE: " CF_ACCESS " } as Env)).toBe(true);
    expect(isCloudflareAccessModeForced({ AUTH_MODE: "builtin" } as Env)).toBe(false);

    await withEnvOverrides(
      {
        AUTH_MODE: "cf_access",
        CF_ACCESS_TEAM_DOMAIN: "myteam",
        CF_ACCESS_AUD: undefined,
      },
      async () => {
        const meRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/me`);
        expect(meRes.status).toBe(200);
        expect(await meRes.json()).toEqual({
          authenticated: false,
          needsSetup: false,
          mode: "cf_access",
        });

        const setupRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "StrongPass123!" }),
        });
        expect(setupRes.status).toBe(400);

        const loginRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "StrongPass123!" }),
        });
        expect(loginRes.status).toBe(400);

        const nodesRes = await SELF.fetch(`${TEST_ORIGIN}/api/nodes`);
        expect(nodesRes.status).toBe(401);
        expect(await nodesRes.json()).toEqual({ error: "Unauthorized" });
      },
    );
  });

  it("intercepts invalid Agent WebSocket tokens at the edge without waking FleetHubDO or NodeDO", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie, { name: "edge-check" });
    const initialHubIds = await listDurableObjectIds(env.FLEET_HUB_DO);
    expect(initialHubIds.length).toBe(1);
    expect((await listDurableObjectIds(env.NODE_DO)).length).toBe(0);

    // 1. Missing headers and missing ?id
    const r1 = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws`, {
      headers: { Upgrade: "websocket" },
    });
    expect(r1.status).toBe(401);

    // 2. Bad token prefix
    const r2 = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws`, {
      headers: {
        Upgrade: "websocket",
        "X-UniOB-Node-Id": "nd_nonexistent_999",
        Authorization: "Bearer bad_token_prefix",
      },
    });
    expect(r2.status).toBe(401);

    // 3. Valid format, unknown node ID -> must NOT wake DO for nd_nonexistent_999
    const r3 = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws`, {
      headers: {
        Upgrade: "websocket",
        "X-UniOB-Node-Id": "nd_nonexistent_999",
        Authorization:
          "Bearer uob_live_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
      },
    });
    expect(r3.status).toBe(401);

    // 4. Valid format, wrong token for real node
    const r4 = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws`, {
      headers: {
        Upgrade: "websocket",
        "X-UniOB-Node-Id": node.id,
        Authorization:
          "Bearer uob_live_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
      },
    });
    expect(r4.status).toBe(401);

    // 5. Query param ?id= mismatch against X-UniOB-Node-Id rejected at edge
    const r5 = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws?id=nd_other_1234`, {
      headers: {
        Upgrade: "websocket",
        "X-UniOB-Node-Id": node.id,
        Authorization: `Bearer ${agent_token}`,
      },
    });
    expect(r5.status).toBe(401);

    expect((await listDurableObjectIds(env.FLEET_HUB_DO)).length).toBe(1);
    expect((await listDurableObjectIds(env.NODE_DO)).length).toBe(0);

    // 6. Query param ?id= only (v2 style) with valid token upgrades cleanly
    const r6 = await SELF.fetch(`${TEST_ORIGIN}/api/agent/ws?id=${node.id}`, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${agent_token}`,
      },
    });
    expect(r6.status).toBe(101);
    r6.webSocket?.accept();
    r6.webSocket?.close();
  });
});
