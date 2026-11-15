import {
  base64UrlDecode,
  constantTimeEqual,
  generateRandomSecret,
  hashPasswordPBKDF2,
  sha256Hex,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from "./crypto";
import type { Env } from "./types";

export const SESSION_COOKIE_NAME = "uniob_session";
export const SESSION_TTL_SEC = 7 * 24 * 3600; // 604800 seconds
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;
const AGENT_CACHE_TTL_MS = 15_000;
const AGENT_NEGATIVE_RECHECK_MS = 5_000;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface AgentTokenCacheEntry {
  tokenSha256: string | null;
  fetchedAt: number;
  expiresAt: number;
}

interface JwkKey extends JsonWebKey {
  kid?: string;
  kty: string;
  alg?: string;
}

interface JwksCacheEntry {
  keys: JwkKey[];
  expiresAt: number;
}

const loginFailures = new Map<string, RateLimitEntry>();
const agentTokenCache = new Map<string, AgentTokenCacheEntry>();
const jwksCache = new Map<string, JwksCacheEntry>();
let cachedSessionSecret: { value: string; expiresAt: number } | null = null;

export function clearAuthCachesForTest(): void {
  loginFailures.clear();
  agentTokenCache.clear();
  jwksCache.clear();
  cachedSessionSecret = null;
}

export function clearSessionSecretCache(): void {
  cachedSessionSecret = null;
}

export function invalidateAgentTokenCache(nodeId: string): void {
  agentTokenCache.delete(nodeId);
}

export function isHttpsRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    if (url.protocol === "https:") {
      return true;
    }
  } catch {
    // ignore malformed URL
  }
  return request.headers.get("x-forwarded-proto")?.toLowerCase() === "https";
}

export function buildSessionCookie(token: string, request: Request): string {
  const secureAttr = isHttpsRequest(request) ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SEC}${secureAttr}`;
}

export function buildClearSessionCookie(request: Request): string {
  const secureAttr = isHttpsRequest(request) ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureAttr}`;
}

export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const key = part.slice(0, eqIdx).trim();
    if (key === name) {
      return part.slice(eqIdx + 1).trim();
    }
  }
  return null;
}

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) {
    return cfIp;
  }
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return "unknown";
}

function pruneExpiredRateLimits(nowMs: number): void {
  if (loginFailures.size < 256) {
    return;
  }
  for (const [ip, entry] of loginFailures) {
    if (entry.resetAt <= nowMs) {
      loginFailures.delete(ip);
    }
  }
}

export function checkLoginRateLimit(
  ip: string,
  nowMs = Date.now(),
): { allowed: boolean; retryAfterSec?: number } {
  const entry = loginFailures.get(ip);
  if (!entry) {
    return { allowed: true };
  }
  if (nowMs >= entry.resetAt) {
    loginFailures.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX_FAILURES) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
    };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip: string, nowMs = Date.now()): void {
  pruneExpiredRateLimits(nowMs);
  const existing = loginFailures.get(ip);
  if (!existing || nowMs >= existing.resetAt) {
    loginFailures.set(ip, {
      count: 1,
      resetAt: nowMs + RATE_LIMIT_WINDOW_MS,
    });
    return;
  }
  existing.count += 1;
}

export function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

export function isCloudflareAccessEnabled(env: Env): boolean {
  if (env.AUTH_MODE?.trim().toLowerCase() === "builtin") {
    return false;
  }
  return Boolean(
    env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim(),
  );
}

export function isCloudflareAccessModeForced(env: Env): boolean {
  return env.AUTH_MODE?.trim().toLowerCase() === "cf_access";
}

export function parseAllowedEmails(raw?: string): Set<string> {
  const allowed = new Set<string>();
  if (!raw) {
    return allowed;
  }
  for (const item of raw.split(",")) {
    const normalized = item.trim().toLowerCase();
    if (normalized) {
      allowed.add(normalized);
    }
  }
  return allowed;
}

export function normalizeAccessTeamDomain(raw: string): string {
  let domain = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
  if (!domain.includes(".")) {
    domain = `${domain}.cloudflareaccess.com`;
  }
  return domain;
}

async function fetchJwks(teamDomain: string, forceRefresh = false): Promise<JwkKey[]> {
  const nowMs = Date.now();
  const cached = jwksCache.get(teamDomain);
  if (!forceRefresh && cached && cached.expiresAt > nowMs) {
    return cached.keys;
  }

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const resp = await fetch(certsUrl, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch CF Access JWKS (${resp.status})`);
  }
  const body = (await resp.json()) as { keys?: JwkKey[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(teamDomain, {
    keys,
    expiresAt: nowMs + JWKS_CACHE_TTL_MS,
  });
  return keys;
}

export async function verifyCloudflareAccessJwt(
  jwt: string,
  env: Env,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ valid: boolean; email?: string }> {
  const rawDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const expectedAud = env.CF_ACCESS_AUD?.trim();
  if (!rawDomain || !expectedAud) {
    return { valid: false };
  }

  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return { valid: false };
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const headerBytes = base64UrlDecode(headerB64);
  const payloadBytes = base64UrlDecode(payloadB64);
  const sigBytes = base64UrlDecode(sigB64);
  if (!headerBytes || !payloadBytes || !sigBytes) {
    return { valid: false };
  }

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string | string[];
    iss?: string;
    exp?: number;
    nbf?: number;
    email?: string;
  };
  try {
    header = JSON.parse(decoder.decode(headerBytes));
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return { valid: false };
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    return { valid: false };
  }

  const teamDomain = normalizeAccessTeamDomain(rawDomain);
  const expectedIss = `https://${teamDomain}`;

  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    return { valid: false };
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) {
    return { valid: false };
  }
  if (payload.iss !== expectedIss) {
    return { valid: false };
  }
  const audMatch =
    typeof payload.aud === "string"
      ? payload.aud === expectedAud
      : Array.isArray(payload.aud) && payload.aud.includes(expectedAud);
  if (!audMatch) {
    return { valid: false };
  }

  let keys: JwkKey[];
  try {
    keys = await fetchJwks(teamDomain, false);
  } catch {
    return { valid: false };
  }

  let jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) {
    try {
      keys = await fetchJwks(teamDomain, true);
      jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    } catch {
      return { valid: false };
    }
  }
  if (!jwk) {
    return { valid: false };
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      sigBytes,
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
    if (!verified) {
      return { valid: false };
    }
    return {
      valid: true,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    return { valid: false };
  }
}

export async function getAdminPasswordHash(env: Env): Promise<string | null> {
  const fromEnv = env.ADMIN_PASSWORD_HASH?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'admin_password_hash'",
  ).first<{ value: string }>();
  return row?.value ?? null;
}

export async function getOrCreateSessionSecret(env: Env): Promise<string> {
  const fromEnv = env.SESSION_SECRET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const nowMs = Date.now();
  if (cachedSessionSecret && cachedSessionSecret.expiresAt > nowMs) {
    return cachedSessionSecret.value;
  }

  const existing = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'session_secret'",
  ).first<{ value: string }>();
  if (existing?.value) {
    cachedSessionSecret = { value: existing.value, expiresAt: nowMs + 60_000 };
    return existing.value;
  }

  const generated = generateRandomSecret(32);
  const nowSec = Math.floor(nowMs / 1000);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('session_secret', ?, ?)",
  )
    .bind(generated, nowSec)
    .run();

  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'session_secret'",
  ).first<{ value: string }>();
  const finalSecret = row?.value ?? generated;
  cachedSessionSecret = { value: finalSecret, expiresAt: nowMs + 60_000 };
  return finalSecret;
}

export interface AdminAuthStatus {
  authenticated: boolean;
  forbidden?: boolean;
  needsSetup: boolean;
  mode: "builtin" | "cf_access";
  email?: string;
}

export async function getAdminAuthStatus(
  request: Request,
  env: Env,
): Promise<AdminAuthStatus> {
  if (isCloudflareAccessEnabled(env)) {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
    if (!jwt) {
      return {
        authenticated: false,
        needsSetup: false,
        mode: "cf_access",
      };
    }
    const verified = await verifyCloudflareAccessJwt(jwt, env);
    if (!verified.valid) {
      return {
        authenticated: false,
        needsSetup: false,
        mode: "cf_access",
      };
    }

    const email = verified.email?.trim() || undefined;
    const allowlist = parseAllowedEmails(env.CF_ACCESS_ALLOWED_EMAILS);
    if (allowlist.size > 0) {
      if (!email || !allowlist.has(email.toLowerCase())) {
        return {
          authenticated: false,
          forbidden: true,
          needsSetup: false,
          mode: "cf_access",
          ...(email ? { email } : {}),
        };
      }
    }

    return {
      authenticated: true,
      needsSetup: false,
      mode: "cf_access",
      ...(email ? { email } : {}),
    };
  }

  if (isCloudflareAccessModeForced(env)) {
    return {
      authenticated: false,
      needsSetup: false,
      mode: "cf_access",
    };
  }

  const passwordHash = await getAdminPasswordHash(env);
  if (!passwordHash) {
    return {
      authenticated: false,
      needsSetup: true,
      mode: "builtin",
    };
  }

  const cookieToken = parseCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!cookieToken) {
    return {
      authenticated: false,
      needsSetup: false,
      mode: "builtin",
    };
  }

  const secret = await getOrCreateSessionSecret(env);
  const payload = await verifySessionToken(cookieToken, secret);
  return {
    authenticated: payload !== null,
    needsSetup: false,
    mode: "builtin",
  };
}

export async function createSessionForAdmin(
  request: Request,
  env: Env,
): Promise<{ token: string; cookie: string }> {
  const secret = await getOrCreateSessionSecret(env);
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signSessionToken(
    {
      sub: "admin",
      iat: nowSec,
      exp: nowSec + SESSION_TTL_SEC,
    },
    secret,
  );
  return {
    token,
    cookie: buildSessionCookie(token, request),
  };
}

export async function setupInitialPassword(
  password: string,
  env: Env,
): Promise<{ ok: true } | { ok: false; status: 400 | 409; error: string }> {
  if (isCloudflareAccessEnabled(env) || isCloudflareAccessModeForced(env)) {
    return {
      ok: false,
      status: 400,
      error: "Setup is disabled when Cloudflare Access mode is active",
    };
  }
  if (env.ADMIN_PASSWORD_HASH?.trim()) {
    return {
      ok: false,
      status: 409,
      error: "Admin password is already configured via environment",
    };
  }
  if (typeof password !== "string" || password.length < 6) {
    return {
      ok: false,
      status: 400,
      error: "Password must be at least 6 characters",
    };
  }

  const hash = await hashPasswordPBKDF2(password);
  const nowSec = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('admin_password_hash', ?, ?)",
  )
    .bind(hash, nowSec)
    .run();

  if (!res.meta.changes || res.meta.changes === 0) {
    return {
      ok: false,
      status: 409,
      error: "Admin password is already configured",
    };
  }

  return { ok: true };
}

export async function verifyAdminLogin(
  password: string,
  request: Request,
  env: Env,
): Promise<
  | { ok: true }
  | { ok: false; status: 400 | 401 | 429; error: string; retryAfterSec?: number }
> {
  if (isCloudflareAccessEnabled(env) || isCloudflareAccessModeForced(env)) {
    return {
      ok: false,
      status: 400,
      error: "Password login is disabled when Cloudflare Access mode is active",
    };
  }
  const ip = getClientIp(request);
  const rate = checkLoginRateLimit(ip);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      error: "Too many failed login attempts, please try again later",
      retryAfterSec: rate.retryAfterSec,
    };
  }

  const storedHash = await getAdminPasswordHash(env);
  if (!storedHash) {
    return {
      ok: false,
      status: 400,
      error: "Admin password has not been configured yet",
    };
  }

  if (typeof password !== "string" || !password) {
    recordLoginFailure(ip);
    return { ok: false, status: 401, error: "Invalid password" };
  }

  const valid = await verifyPassword(password, storedHash);
  if (!valid) {
    recordLoginFailure(ip);
    return { ok: false, status: 401, error: "Invalid password" };
  }

  clearLoginFailures(ip);
  return { ok: true };
}

const NODE_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const AGENT_TOKEN_RE = /^uob_live_[0-9A-Za-z]{32,64}$/;

export function extractAgentNodeId(request: Request): string {
  const headerId = request.headers.get("X-UniOB-Node-Id")?.trim() ?? "";
  let queryId = "";
  try {
    queryId = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  } catch {
    queryId = "";
  }
  if (headerId && queryId && headerId !== queryId) {
    return "";
  }
  return headerId || queryId;
}

export async function verifyAgentEdgeAuth(
  request: Request,
  env: Env,
): Promise<{ ok: true; nodeId: string } | { ok: false; status: 401; error: string }> {
  const nodeId = extractAgentNodeId(request);
  if (!NODE_ID_RE.test(nodeId)) {
    return { ok: false, status: 401, error: "Invalid X-UniOB-Node-Id header or id query" };
  }

  const authHeader = request.headers.get("Authorization")?.trim() ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Bearer authorization" };
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!AGENT_TOKEN_RE.test(token)) {
    return { ok: false, status: 401, error: "Invalid agent token format" };
  }

  const tokenSha256 = await sha256Hex(token);
  const nowMs = Date.now();
  const cached = agentTokenCache.get(nodeId);
  if (cached && nowMs < cached.expiresAt) {
    if (
      cached.tokenSha256 !== null &&
      (await constantTimeEqual(cached.tokenSha256, tokenSha256))
    ) {
      return { ok: true, nodeId };
    }
    if (nowMs - cached.fetchedAt < AGENT_NEGATIVE_RECHECK_MS) {
      return { ok: false, status: 401, error: "Invalid node credentials" };
    }
  }

  const row = await env.DB.prepare("SELECT token_sha256 FROM nodes WHERE id = ?")
    .bind(nodeId)
    .first<{ token_sha256: string }>();

  if (agentTokenCache.size >= 1000) {
    agentTokenCache.clear();
  }
  agentTokenCache.set(nodeId, {
    tokenSha256: row?.token_sha256 ?? null,
    fetchedAt: nowMs,
    expiresAt: nowMs + AGENT_CACHE_TTL_MS,
  });

  if (!row || !(await constantTimeEqual(row.token_sha256, tokenSha256))) {
    return { ok: false, status: 401, error: "Invalid node credentials" };
  }

  return { ok: true, nodeId };
}
