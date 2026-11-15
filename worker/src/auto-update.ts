import { hmacSha256Hex } from "./crypto";
import { isPrivateOrReservedHost } from "./ssrf";
import type {
  AgentLatestRelease,
  AgentReleaseArch,
  AgentReleaseAsset,
  AgentUpdateChannel,
  AgentUpdateConfig,
  AgentUpdateState,
  CtrlUpdateDirective,
  Env,
  NodeUpdateStatus,
} from "./types";
import { readSettingJson, writeSettingJson } from "./watchdog";

export const BUNDLED_AGENT_VERSION = "0.2.0";
export const AGENT_UPDATE_CONFIG_KEY = "agent_update_config";
export const AGENT_UPDATE_CACHE_KEY = "agent_update_cache";
export const RELEASE_CACHE_TTL_SEC = 900;
export const DEFAULT_GITHUB_REPO = "Cusnd/UniOB";
export const MIN_CHECK_INTERVAL_SEC = 60;
export const MAX_CHECK_INTERVAL_SEC = 604_800;
export const DEFAULT_CHECK_INTERVAL_SEC = 21_600;
const FETCH_TIMEOUT_MS = 8_000;
const ERROR_RETRY_COOLDOWN_SEC = 900;

const AGENT_ASSET_NAMES: Record<AgentReleaseArch, string> = {
  amd64: "uniob-agent-x86_64-unknown-linux-musl",
  arm64: "uniob-agent-aarch64-unknown-linux-musl",
};

const VALID_UPDATE_STATES = new Set<AgentUpdateState>([
  "idle",
  "downloading",
  "staged",
  "applying",
  "error",
]);

const CONFIG_KEYS = new Set([
  "auto_update_enabled",
  "channel",
  "check_interval_sec",
  "custom_base_url",
]);

export interface AgentUpdateCacheEntry {
  cache_key: string;
  checked_at: number;
  release: AgentLatestRelease | null;
  error: string | null;
}

export interface AgentReleaseCheckResult {
  release: AgentLatestRelease | null;
  checked_at: number;
  error: string | null;
}

export function defaultAgentUpdateConfig(): AgentUpdateConfig {
  return {
    auto_update_enabled: false,
    channel: "stable",
    check_interval_sec: DEFAULT_CHECK_INTERVAL_SEC,
    custom_base_url: "",
  };
}

export function normalizeGithubRepo(raw?: string): string {
  const trimmed = raw?.trim();
  return trimmed && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)
    ? trimmed
    : DEFAULT_GITHUB_REPO;
}

export function normalizeAgentArch(
  rawArch: string | null | undefined,
): AgentReleaseArch | null {
  switch (rawArch?.trim().toLowerCase()) {
    case "x86_64":
    case "amd64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

export function assetNameForArch(arch: AgentReleaseArch): string {
  return AGENT_ASSET_NAMES[arch];
}

export function validateCustomBaseUrl(raw: unknown): string {
  if (raw === null) {
    return "";
  }
  if (typeof raw !== "string") {
    throw new Error("custom_base_url must be a string or null");
  }
  if (/[\x00-\x1f\x7f-\x9f]/.test(raw)) {
    throw new Error("custom_base_url contains control characters");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length > 512) {
    throw new Error("custom_base_url is too long");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("custom_base_url must be a valid http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("custom_base_url must use https:// or http://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("custom_base_url must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("custom_base_url must not include query parameters or fragments");
  }
  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new Error("custom_base_url cannot target private or reserved addresses");
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${cleanPath}`;
}

export function parseAgentUpdateConfig(
  raw: unknown,
  existing?: AgentUpdateConfig,
): AgentUpdateConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected agent_update_config object");
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`Unknown agent_update_config field: ${key}`);
    }
  }
  const base = existing ?? defaultAgentUpdateConfig();

  let autoUpdateEnabled = base.auto_update_enabled;
  if (input.auto_update_enabled !== undefined) {
    if (typeof input.auto_update_enabled !== "boolean") {
      throw new Error("auto_update_enabled must be a boolean");
    }
    autoUpdateEnabled = input.auto_update_enabled;
  }

  let channel: AgentUpdateChannel = base.channel;
  if (input.channel !== undefined) {
    if (input.channel !== "stable" && input.channel !== "github") {
      throw new Error("channel must be 'stable' or 'github'");
    }
    channel = input.channel;
  }

  let checkIntervalSec = base.check_interval_sec;
  if (input.check_interval_sec !== undefined) {
    if (
      typeof input.check_interval_sec !== "number" ||
      !Number.isInteger(input.check_interval_sec) ||
      input.check_interval_sec < MIN_CHECK_INTERVAL_SEC ||
      input.check_interval_sec > MAX_CHECK_INTERVAL_SEC
    ) {
      throw new Error(
        `check_interval_sec must be an integer between ${MIN_CHECK_INTERVAL_SEC} and ${MAX_CHECK_INTERVAL_SEC}`,
      );
    }
    checkIntervalSec = input.check_interval_sec;
  }

  const customBaseUrl =
    input.custom_base_url !== undefined
      ? validateCustomBaseUrl(input.custom_base_url)
      : base.custom_base_url;

  return {
    auto_update_enabled: autoUpdateEnabled,
    channel,
    check_interval_sec: checkIntervalSec,
    custom_base_url: customBaseUrl,
  };
}

export function validateAgentUpdateConfigSetting(value: string): AgentUpdateConfig {
  return parseAgentUpdateConfig(JSON.parse(value));
}

export async function getAgentUpdateConfig(
  db: D1Database,
): Promise<AgentUpdateConfig> {
  const stored = await readSettingJson<unknown>(db, AGENT_UPDATE_CONFIG_KEY);
  if (!stored) {
    return defaultAgentUpdateConfig();
  }
  try {
    return parseAgentUpdateConfig(stored);
  } catch {
    return defaultAgentUpdateConfig();
  }
}

export async function saveAgentUpdateConfig(
  db: D1Database,
  raw: unknown,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<AgentUpdateConfig> {
  const existing = await getAgentUpdateConfig(db);
  const next = parseAgentUpdateConfig(raw, existing);
  await writeSettingJson(db, AGENT_UPDATE_CONFIG_KEY, next, nowSec);
  return next;
}

export async function readCachedAgentRelease(
  db: D1Database,
): Promise<AgentUpdateCacheEntry | null> {
  const cached = await readSettingJson<AgentUpdateCacheEntry>(
    db,
    AGENT_UPDATE_CACHE_KEY,
  );
  if (
    !cached ||
    typeof cached !== "object" ||
    typeof cached.checked_at !== "number" ||
    typeof cached.cache_key !== "string"
  ) {
    return null;
  }
  return cached;
}

export async function clearCachedAgentRelease(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM system_settings WHERE key = ?")
    .bind(AGENT_UPDATE_CACHE_KEY)
    .run();
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseSemver(raw: string): ParsedSemver | null {
  const match = raw
    .trim()
    .replace(/^v/i, "")
    .match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemver(aRaw: string, bRaw: string): number | null {
  const a = parseSemver(aRaw);
  const b = parseSemver(bRaw);
  if (!a || !b) {
    return null;
  }
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = a.pre[i];
    const bi = b.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const an = Number(ai);
      const bn = Number(bi);
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

export function isNewerAgentVersion(
  candidateVersion: string,
  currentVersion: string | null | undefined,
): boolean {
  if (!currentVersion) {
    return false;
  }
  const cmp = compareSemver(candidateVersion, currentVersion);
  return cmp !== null && cmp > 0;
}

export function parseAgentUpdateStatus(
  raw: unknown,
  fallbackTs = Math.floor(Date.now() / 1000),
): NodeUpdateStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const rawState = obj.st ?? obj.state;
  if (
    typeof rawState !== "string" ||
    !VALID_UPDATE_STATES.has(rawState as AgentUpdateState)
  ) {
    return null;
  }
  const out: NodeUpdateStatus = {
    state: rawState as AgentUpdateState,
  };
  const rawTarget = obj.ver ?? obj.target_version;
  if (
    typeof rawTarget === "string" &&
    rawTarget.trim().length > 0 &&
    rawTarget.trim().length <= 64 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(rawTarget)
  ) {
    out.target_version = rawTarget.trim();
  }
  const rawErr = obj.err ?? obj.error;
  if (
    typeof rawErr === "string" &&
    rawErr.trim().length > 0 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(rawErr)
  ) {
    out.error = rawErr.trim().slice(0, 512);
  }
  const rawTs = obj.ts ?? obj.updated_at;
  if (typeof rawTs === "number" && Number.isSafeInteger(rawTs) && rawTs > 0) {
    out.updated_at = rawTs;
  } else {
    out.updated_at = fallbackTs;
  }
  return out;
}

export function parseSha256Sums(text: string): Map<string, string> {
  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith("<") || trimmed.includes("<!doctype")) {
    return new Map();
  }
  const sums = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?([^\s]+)$/);
    if (!match) continue;
    const sha = match[1]!.toLowerCase();
    const assetName = match[2]!.split("/").pop();
    if (assetName) {
      sums.set(assetName, sha);
    }
  }
  return sums;
}

function parseVersionText(text: string): string | null {
  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith("<") || trimmed.includes("<!doctype")) {
    return null;
  }
  const firstLine = text.split(/\r?\n/)[0]?.trim();
  if (!firstLine) return null;
  const clean = firstLine.replace(/^v/i, "");
  return parseSemver(clean) ? clean : null;
}

function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get("content-type")?.toLowerCase() ?? "";
  return ct.includes("text/html");
}

function buildAssetsMap(
  sums: Map<string, string>,
  baseUrl: string,
  fallbackBaseUrl?: string,
): Partial<Record<AgentReleaseArch, AgentReleaseAsset>> {
  const assets: Partial<Record<AgentReleaseArch, AgentReleaseAsset>> = {};
  for (const arch of ["amd64", "arm64"] as const) {
    const assetName = AGENT_ASSET_NAMES[arch];
    const sha256 = sums.get(assetName);
    if (!sha256) continue;
    assets[arch] = {
      arch,
      asset_name: assetName,
      url: `${baseUrl}/${assetName}`,
      ...(fallbackBaseUrl
        ? { fallback_url: `${fallbackBaseUrl}/${assetName}` }
        : {}),
      sha256,
    };
  }
  return assets;
}

async function fetchAssetsRelease(
  env: Env,
  requestOrigin: string | undefined,
  repo: string,
  nowSec: number,
): Promise<AgentLatestRelease | null> {
  if (!env.ASSETS || !requestOrigin) {
    return null;
  }
  let origin: string;
  try {
    origin = new URL(requestOrigin).origin;
  } catch {
    return null;
  }

  const sumsRes = await env.ASSETS.fetch(
    new Request(new URL("/releases/SHA256SUMS", origin).toString()),
  );
  if (!sumsRes.ok || isHtmlResponse(sumsRes)) {
    return null;
  }
  const sums = parseSha256Sums(await sumsRes.text());
  if (sums.size === 0) {
    return null;
  }

  let version = BUNDLED_AGENT_VERSION;
  try {
    const verRes = await env.ASSETS.fetch(
      new Request(new URL("/releases/VERSION", origin).toString()),
    );
    if (verRes.ok && !isHtmlResponse(verRes)) {
      const parsed = parseVersionText(await verRes.text());
      if (parsed) {
        version = parsed;
      }
    }
  } catch {
    /* optional VERSION file defaults to bundled version */
  }

  const tag = `v${version}`;
  const assets = buildAssetsMap(
    sums,
    `${origin}/releases`,
    `https://github.com/${repo}/releases/download/${tag}`,
  );
  if (!assets.amd64 && !assets.arm64) {
    return null;
  }

  return {
    version,
    source: "assets",
    checked_at: nowSec,
    tag,
    assets,
  };
}

async function fetchCustomRelease(
  customBaseUrl: string,
  repo: string,
  nowSec: number,
): Promise<AgentLatestRelease> {
  const sumsRes = await fetch(`${customBaseUrl}/SHA256SUMS`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "uniob-worker/2.0.0" },
  });
  if (!sumsRes.ok || isHtmlResponse(sumsRes)) {
    throw new Error(
      `Custom release SHA256SUMS fetch failed (HTTP ${sumsRes.status})`,
    );
  }
  const sums = parseSha256Sums(await sumsRes.text());
  if (sums.size === 0) {
    throw new Error("Custom release SHA256SUMS contained no valid digests");
  }

  let version = BUNDLED_AGENT_VERSION;
  try {
    const verRes = await fetch(`${customBaseUrl}/VERSION`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "uniob-worker/2.0.0" },
    });
    if (verRes.ok && !isHtmlResponse(verRes)) {
      const parsed = parseVersionText(await verRes.text());
      if (parsed) {
        version = parsed;
      }
    }
  } catch {
    /* optional VERSION file defaults to bundled version */
  }

  const tag = `v${version}`;
  const assets = buildAssetsMap(
    sums,
    customBaseUrl,
    `https://github.com/${repo}/releases/download/${tag}`,
  );
  if (!assets.amd64 && !assets.arm64) {
    throw new Error("Custom release SHA256SUMS contained no agent binaries");
  }

  return {
    version,
    source: "custom",
    checked_at: nowSec,
    tag,
    assets,
  };
}

interface GithubReleaseApiPayload {
  tag_name?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  assets?: Array<{
    name?: unknown;
    browser_download_url?: unknown;
    digest?: unknown;
  }>;
}

async function fetchGithubRelease(
  env: Env,
  requestOrigin: string | undefined,
  repo: string,
  nowSec: number,
): Promise<AgentLatestRelease> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(apiUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "uniob-worker/2.0.0",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub releases API returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as GithubReleaseApiPayload;
  if (typeof data.tag_name !== "string" || !data.tag_name.trim()) {
    throw new Error("GitHub release missing tag_name");
  }
  const tag = data.tag_name.trim();
  const version = tag.replace(/^v/i, "");
  if (!parseSemver(version)) {
    throw new Error(`Invalid GitHub release version: ${tag}`);
  }

  const rawAssets = Array.isArray(data.assets) ? data.assets : [];
  const sums = new Map<string, string>();

  const sumsAsset = rawAssets.find(
    (a) =>
      a &&
      typeof a.name === "string" &&
      a.name === "SHA256SUMS" &&
      typeof a.browser_download_url === "string" &&
      a.browser_download_url.startsWith("https://"),
  );
  if (sumsAsset && typeof sumsAsset.browser_download_url === "string") {
    const sumsRes = await fetch(sumsAsset.browser_download_url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "uniob-worker/2.0.0" },
    });
    if (!sumsRes.ok) {
      throw new Error(`GitHub SHA256SUMS fetch failed (HTTP ${sumsRes.status})`);
    }
    for (const [k, v] of parseSha256Sums(await sumsRes.text())) {
      sums.set(k, v);
    }
  }

  // Optional backup from GitHub API asset digest ("sha256:...") when SHA256SUMS lacks an entry.
  const downloadUrls = new Map<string, string>();
  for (const a of rawAssets) {
    if (
      !a ||
      typeof a.name !== "string" ||
      typeof a.browser_download_url !== "string" ||
      !a.browser_download_url.startsWith("https://")
    ) {
      continue;
    }
    downloadUrls.set(a.name, a.browser_download_url);
    if (!sums.has(a.name) && typeof a.digest === "string") {
      const m = a.digest.trim().match(/^sha256:([0-9a-fA-F]{64})$/);
      if (m) {
        sums.set(a.name, m[1]!.toLowerCase());
      }
    }
  }

  let assetsFallbackBase: string | undefined;
  let assetsSums: Map<string, string> | undefined;
  if (env.ASSETS && requestOrigin) {
    try {
      const origin = new URL(requestOrigin).origin;
      const localRes = await env.ASSETS.fetch(
        new Request(new URL("/releases/SHA256SUMS", origin).toString()),
      );
      if (localRes.ok && !isHtmlResponse(localRes)) {
        assetsSums = parseSha256Sums(await localRes.text());
        assetsFallbackBase = `${origin}/releases`;
      }
    } catch {
      /* ignore missing local fallback */
    }
  }

  const assets: Partial<Record<AgentReleaseArch, AgentReleaseAsset>> = {};
  for (const arch of ["amd64", "arm64"] as const) {
    const assetName = AGENT_ASSET_NAMES[arch];
    const url = downloadUrls.get(assetName);
    const sha256 = sums.get(assetName);
    if (!url || !sha256) continue;
    const localSha = assetsSums?.get(assetName);
    assets[arch] = {
      arch,
      asset_name: assetName,
      url,
      ...(assetsFallbackBase && localSha === sha256
        ? { fallback_url: `${assetsFallbackBase}/${assetName}` }
        : {}),
      sha256,
    };
  }

  if (!assets.amd64 && !assets.arm64) {
    throw new Error(`GitHub release ${tag} contained no verified agent assets`);
  }

  return {
    version,
    source: "github",
    checked_at: nowSec,
    tag,
    published_at:
      typeof data.published_at === "string" ? data.published_at : null,
    ...(typeof data.html_url === "string" ? { notes_url: data.html_url } : {}),
    assets,
  };
}

export async function checkLatestAgentRelease(
  env: Env,
  config: AgentUpdateConfig,
  options?: {
    requestOrigin?: string;
    force?: boolean;
    nowSec?: number;
  },
): Promise<AgentReleaseCheckResult> {
  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  const repo = normalizeGithubRepo(env.GITHUB_REPO);
  const originPart =
    config.channel === "stable" && options?.requestOrigin
      ? (() => {
          try {
            return new URL(options.requestOrigin).origin;
          } catch {
            return "";
          }
        })()
      : "";
  const cacheKey = `${config.channel}|${config.custom_base_url}|${repo}|${originPart}`;

  if (!options?.force) {
    const cached = await readCachedAgentRelease(env.DB);
    if (cached && cached.cache_key === cacheKey) {
      const ttl = cached.release
        ? Math.max(
            MIN_CHECK_INTERVAL_SEC,
            Math.min(config.check_interval_sec, RELEASE_CACHE_TTL_SEC),
          )
        : 60;
      if (nowSec - cached.checked_at < ttl) {
        return {
          release: cached.release,
          checked_at: cached.checked_at,
          error: cached.error ?? null,
        };
      }
    }
  }

  let release: AgentLatestRelease | null = null;
  let error: string | null = null;

  try {
    if (config.custom_base_url) {
      release = await fetchCustomRelease(config.custom_base_url, repo, nowSec);
    } else if (config.channel === "stable") {
      const local = await fetchAssetsRelease(
        env,
        options?.requestOrigin,
        repo,
        nowSec,
      );
      release =
        local ??
        (await fetchGithubRelease(env, options?.requestOrigin, repo, nowSec));
    } else {
      release = await fetchGithubRelease(
        env,
        options?.requestOrigin,
        repo,
        nowSec,
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  await writeSettingJson(
    env.DB,
    AGENT_UPDATE_CACHE_KEY,
    {
      cache_key: cacheKey,
      checked_at: nowSec,
      release,
      error,
    } satisfies AgentUpdateCacheEntry,
    nowSec,
  );

  return { release, checked_at: nowSec, error };
}

export async function signUpdateDirective(
  nodeId: string,
  tokenSha256: string,
  params: {
    version: string;
    sha256: string;
    url: string;
    fallback_url?: string;
    issued_at: number;
  },
): Promise<CtrlUpdateDirective> {
  const sha = params.sha256.trim().toLowerCase();
  const keyHex = tokenSha256.trim().toLowerCase();
  const payload = `agent_update_v1:${nodeId}:${params.version}:${sha}:${params.issued_at}:${params.url}:${params.fallback_url ?? ""}`;
  const hmac = await hmacSha256Hex(payload, keyHex);
  return {
    version: params.version,
    sha256: sha,
    url: params.url,
    ...(params.fallback_url ? { fallback_url: params.fallback_url } : {}),
    issued_at: params.issued_at,
    hmac,
  };
}

export function decodeAutoUpdateOverride(
  val: number | null | undefined,
): boolean | null {
  return val === 1 ? true : val === 0 ? false : null;
}

export function isEffectiveAutoUpdateEnabled(
  override: boolean | null | undefined,
  config: AgentUpdateConfig,
): boolean {
  return override === true || (override == null && config.auto_update_enabled);
}

export function isNodeEligibleForUpdate(params: {
  capabilities: readonly string[];
  arch: string | null | undefined;
  agentVersion: string | null | undefined;
  autoUpdateOverride: boolean | null | undefined;
  updateStatus: NodeUpdateStatus | null | undefined;
  config: AgentUpdateConfig;
  release: AgentLatestRelease;
  nowSec: number;
  force?: boolean;
}): {
  eligible: boolean;
  asset?: AgentReleaseAsset;
  reason?: string;
} {
  if (!params.capabilities.includes("auto_update_v1")) {
    return { eligible: false, reason: "unsupported_capability" };
  }
  const normalizedArch = normalizeAgentArch(params.arch);
  if (!normalizedArch) {
    return { eligible: false, reason: "unknown_arch" };
  }
  const asset = params.release.assets[normalizedArch];
  if (!asset) {
    return { eligible: false, reason: "missing_asset" };
  }

  if (!params.force) {
    if (!isEffectiveAutoUpdateEnabled(params.autoUpdateOverride, params.config)) {
      return { eligible: false, reason: "auto_update_disabled" };
    }
    if (!isNewerAgentVersion(params.release.version, params.agentVersion)) {
      return { eligible: false, reason: "up_to_date" };
    }
    const status = params.updateStatus;
    if (status && status.target_version === params.release.version) {
      if (
        status.state === "downloading" ||
        status.state === "staged" ||
        status.state === "applying"
      ) {
        return { eligible: false, reason: "in_progress" };
      }
      if (
        status.state === "error" &&
        typeof status.updated_at === "number" &&
        params.nowSec - status.updated_at < ERROR_RETRY_COOLDOWN_SEC
      ) {
        return { eligible: false, reason: "error_cooldown" };
      }
    }
  }

  return { eligible: true, asset };
}
