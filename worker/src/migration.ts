import { clearSessionSecretCache, invalidateAgentTokenCache } from "./auth";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hmacSha256Hex,
  randomBase62,
  sha256Hex,
} from "./crypto";
import type { FleetHubDO } from "./do/fleet-hub-do";
import type {
  AlertMetric,
  AlertOperator,
  AlertRuleRow,
  Env,
  ExportBundle,
  ExportSystemSettingEntry,
  ExportTrafficLedgerEntry,
  ImportBundleResponse,
  MigrationReceiveResponse,
  MigrationTicketResponse,
  NodeRow,
  NotificationChannelRow,
  SmartMigrateResponse,
  TrafficCountMode,
} from "./types";
import {
  DEFAULT_TIMEOUT_SEC,
  getWatchdogConfig,
  readSettingJson,
  saveWatchdogConfig,
  writeSettingJson,
} from "./watchdog";

export const MIGRATION_TICKET_TTL_SEC = 1800;

export const EXCLUDED_EXPORT_SETTING_KEYS = new Set([
  "watchdog_state",
  "imported_bundle_sha256",
  "migration_pull_ticket",
  "migration_receive_ticket",
  "migration_paired_token",
]);

export const ALWAYS_SKIPPED_IMPORT_SETTING_KEYS = new Set([
  "watchdog_state",
  "imported_bundle_sha256",
  "migration_pull_ticket",
  "migration_paired_token",
]);

export const VALID_METRICS = new Set<AlertMetric>([
  "offline",
  "cpu",
  "steal",
  "mem",
  "swap",
  "disk",
  "traffic_pct",
]);

export const VALID_OPERATORS = new Set<AlertOperator>(["gt", "gte"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let lastMigrationEpoch = 0;

export function nextMigrationEpoch(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  lastMigrationEpoch = Math.max(nowSec, lastMigrationEpoch + 1);
  return lastMigrationEpoch;
}

export function getFleetHub(env: Env): DurableObjectStub<FleetHubDO> {
  return env.FLEET_HUB_DO.getByName("global");
}

export function sanitizeTrafficMode(input: unknown): TrafficCountMode {
  if (input === "tx_only" || input === "max" || input === "both") {
    return input;
  }
  return "both";
}

export function sanitizeResetDay(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 1;
  }
  return Math.max(1, Math.min(31, Math.floor(input)));
}

export interface ValidatedMigrationUrlResult {
  ok: true;
  wsUrl: string;
}

export interface InvalidMigrationUrlResult {
  ok: false;
  error: string;
}

export type MigrationUrlValidation =
  | ValidatedMigrationUrlResult
  | InvalidMigrationUrlResult;

export function isProductionCfAccessEnv(env: Pick<Env, "AUTH_MODE">): boolean {
  return env.AUTH_MODE?.trim().toLowerCase() === "cf_access";
}

function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateIpv4Octets(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

/**
 * Expands any IPv6 string (including `::` shorthand and dotted IPv4 tail)
 * into eight 16-bit integer groups.
 */
function expandIpv6Groups(rawHost: string): number[] | null {
  const stripped = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;
  const host = stripped.split("%")[0]!.toLowerCase();
  if (!host.includes(":")) {
    return null;
  }

  let working = host;
  const lastColon = working.lastIndexOf(":");
  const tail = working.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4Octets(tail);
    if (!octets) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = working.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const totalProvided = left.length + right.length;
  if (halves.length === 1 && totalProvided !== 8) {
    return null;
  }
  if (halves.length === 2 && totalProvided >= 8) {
    return null;
  }

  const missing = halves.length === 2 ? 8 - totalProvided : 0;
  const tokens = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (tokens.length !== 8) {
    return null;
  }

  const groups: number[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-f]{1,4}$/.test(token)) {
      return null;
    }
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

export function isPrivateOrReservedHost(hostname: string): boolean {
  const bare = (
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  )
    .trim()
    .toLowerCase();

  if (!bare) {
    return true;
  }

  if (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare.endsWith(".local") ||
    bare.endsWith(".internal") ||
    bare.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Octets(bare);
  if (ipv4) {
    return isPrivateIpv4Octets(ipv4);
  }

  const ipv6 = expandIpv6Groups(bare);
  if (ipv6) {
    const allZero = ipv6.every((g) => g === 0);
    const isLoopback = ipv6.slice(0, 7).every((g) => g === 0) && ipv6[7] === 1;
    if (allZero || isLoopback) {
      return true;
    }
    const first = ipv6[0]!;
    // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
      return true;
    }
    // IPv4-mapped IPv6 ::ffff:a.b.c.d
    const isV4Mapped =
      ipv6[0] === 0 &&
      ipv6[1] === 0 &&
      ipv6[2] === 0 &&
      ipv6[3] === 0 &&
      ipv6[4] === 0 &&
      ipv6[5] === 0xffff;
    if (isV4Mapped) {
      const g6 = ipv6[6]!;
      const g7 = ipv6[7]!;
      return isPrivateIpv4Octets([
        (g6 >> 8) & 0xff,
        g6 & 0xff,
        (g7 >> 8) & 0xff,
        g7 & 0xff,
      ]);
    }
  }

  return false;
}

export function normalizeAndValidateMigrationUrl(
  rawUrl: string,
  options: { allowInsecureWs: boolean; isProduction: boolean },
): MigrationUrlValidation {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: "target_url is required" };
  }

  if (options.isProduction && options.allowInsecureWs) {
    return {
      ok: false,
      error: "allow_insecure_ws is forbidden in production",
    };
  }

  if (trimmed.startsWith("/")) {
    return { ok: false, error: `Invalid URL: ${trimmed}` };
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: `Invalid URL: ${trimmed}` };
  }

  if (parsed.username || parsed.password || !parsed.hostname) {
    return { ok: false, error: `Invalid URL: ${trimmed}` };
  }

  const proto = parsed.protocol.toLowerCase();
  const allowInsecure = options.allowInsecureWs && !options.isProduction;

  if (proto === "https:" || proto === "wss:") {
    parsed.protocol = "wss:";
  } else if (proto === "http:" || proto === "ws:") {
    if (!allowInsecure) {
      return {
        ok: false,
        error: "Insecure ws:// or http:// target URLs require allow_insecure_ws in non-production environments",
      };
    }
    parsed.protocol = "ws:";
  } else {
    return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
  }

  if (!allowInsecure && isPrivateOrReservedHost(parsed.hostname)) {
    return {
      ok: false,
      error: `Target host '${parsed.hostname}' is private or reserved`,
    };
  }

  // Canonicalize endpoint path to end with /api/agent/ws with no trailing query/hash.
  let cleanPath = parsed.pathname.replace(/\/+$/, "");
  if (!cleanPath.endsWith("/api/agent/ws")) {
    cleanPath = `${cleanPath}/api/agent/ws`;
  }
  parsed.pathname = cleanPath;
  parsed.search = "";
  parsed.hash = "";

  return { ok: true, wsUrl: parsed.toString() };
}

/**
 * Computes the agent migration signature:
 * HMAC-SHA256(key = UTF8(lowercase token_sha256), msg = UTF8("${nodeId}:${epoch}:${wsUrl}")).
 */
export async function signMigrationDirective(
  nodeId: string,
  tokenSha256: string,
  epoch: number,
  wsUrl: string,
): Promise<string> {
  const message = `${nodeId}:${epoch}:${wsUrl}`;
  const key = tokenSha256.trim().toLowerCase();
  return hmacSha256Hex(message, key);
}

export function shellSingleQuote(value: string): string {
  return value.replace(/[\r\n\0]/g, "").replace(/'/g, "'\\''");
}

export function resolvePublicOrigin(
  rawPublicOrigin: unknown,
  requestUrl: string,
  isProduction: boolean,
): { ok: true; origin: string } | { ok: false; error: string } {
  if (rawPublicOrigin === undefined || rawPublicOrigin === null) {
    return { ok: true, origin: new URL(requestUrl).origin };
  }
  if (typeof rawPublicOrigin !== "string") {
    return { ok: false, error: "public_origin must be a string" };
  }
  const trimmed = rawPublicOrigin.trim();
  if (!trimmed) {
    return { ok: true, origin: new URL(requestUrl).origin };
  }
  if (trimmed.startsWith("/") || /[\r\n\0\s]/.test(trimmed)) {
    return { ok: false, error: "Invalid public_origin" };
  }
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: `Invalid public_origin: ${trimmed}` };
  }
  if (parsed.username || parsed.password || !parsed.hostname) {
    return { ok: false, error: `Invalid public_origin: ${trimmed}` };
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== "https:" && (isProduction || proto !== "http:")) {
    return { ok: false, error: `Unsupported public_origin protocol: ${parsed.protocol}` };
  }
  if (isProduction && isPrivateOrReservedHost(parsed.hostname)) {
    return { ok: false, error: `public_origin host '${parsed.hostname}' is private or reserved` };
  }
  return { ok: true, origin: parsed.origin };
}

function shouldSkipImportSettingKey(key: string, allowReceiveTicket: boolean): boolean {
  if (ALWAYS_SKIPPED_IMPORT_SETTING_KEYS.has(key)) {
    return true;
  }
  return key === "migration_receive_ticket" && !allowReceiveTicket;
}

export async function exportBundle(env: Env): Promise<ExportBundle> {
  const [nodesRes, channelsRes, rulesRes, settingsRes, hubExport] = await Promise.all([
    env.DB.prepare("SELECT * FROM nodes ORDER BY sort_order ASC, created_at ASC").all<NodeRow>(),
    env.DB.prepare(
      "SELECT * FROM notification_channels ORDER BY created_at ASC",
    ).all<NotificationChannelRow>(),
    env.DB.prepare("SELECT * FROM alert_rules ORDER BY created_at ASC").all<AlertRuleRow>(),
    env.DB.prepare(
      "SELECT key, value, updated_at FROM system_settings ORDER BY key ASC",
    ).all<ExportSystemSettingEntry>(),
    getFleetHub(env).getExportData(),
  ]);

  const mirrorById = new Map(hubExport.nodes.map((n) => [n.id, n]));
  const mergedNodes = (nodesRes.results ?? []).map((row) => {
    const mirror = mirrorById.get(row.id);
    if (!mirror) {
      return row;
    }
    return {
      ...row,
      hostname: mirror.hostname ?? row.hostname,
      os: mirror.os ?? row.os,
      kernel: mirror.kernel ?? row.kernel,
      arch: mirror.arch ?? row.arch,
      cpu_model: mirror.cpu_model ?? row.cpu_model,
      cpu_cores: mirror.cpu_cores ?? row.cpu_cores,
      mem_total: mirror.mem_total ?? row.mem_total,
      swap_total: mirror.swap_total ?? row.swap_total,
      agent_version: mirror.agent_version ?? row.agent_version,
      proc_enabled: mirror.proc_enabled ?? row.proc_enabled,
    };
  });

  // Never export host-local watchdog telemetry state or ephemeral migration tickets.
  const filteredSettings = (settingsRes.results ?? []).filter(
    (entry) => !EXCLUDED_EXPORT_SETTING_KEYS.has(entry.key),
  );

  return {
    version: 1,
    exported_at: Math.floor(Date.now() / 1000),
    nodes: mergedNodes,
    notification_channels: channelsRes.results ?? [],
    alert_rules: rulesRes.results ?? [],
    system_settings: filteredSettings,
    traffic_ledgers: hubExport.trafficLedgers,
  };
}

export async function importBundle(
  env: Env,
  body: Record<string, unknown>,
  options: { allowReceiveTicket?: boolean } = {},
): Promise<{ ok: true; result: ImportBundleResponse } | { ok: false; status: 400; error: string }> {
  if (!body || !Array.isArray(body.nodes)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid export bundle: nodes array is required",
    };
  }

  const allowReceiveTicket = options.allowReceiveTicket === true;
  const nowSec = Math.floor(Date.now() / 1000);
  const normalizedNodes: NodeRow[] = [];
  for (const item of body.nodes) {
    if (!item || typeof item !== "object") {
      return { ok: false, status: 400, error: "Invalid node entry in bundle" };
    }
    const n = item as Partial<NodeRow>;
    if (
      typeof n.id !== "string" ||
      n.id.trim().length === 0 ||
      typeof n.name !== "string" ||
      n.name.trim().length === 0 ||
      typeof n.token_sha256 !== "string" ||
      n.token_sha256.trim().length === 0
    ) {
      return {
        ok: false,
        status: 400,
        error: "Each node must include id, name, and token_sha256",
      };
    }
    normalizedNodes.push({
      id: n.id,
      name: n.name,
      group_name: typeof n.group_name === "string" && n.group_name ? n.group_name : "Default",
      tags_json: typeof n.tags_json === "string" ? n.tags_json : "[]",
      sort_order: typeof n.sort_order === "number" ? n.sort_order : 0,
      token_sha256: n.token_sha256,
      traffic_limit_bytes:
        typeof n.traffic_limit_bytes === "number" ? n.traffic_limit_bytes : null,
      traffic_reset_day: sanitizeResetDay(n.traffic_reset_day),
      traffic_count_mode: sanitizeTrafficMode(n.traffic_count_mode),
      hostname: typeof n.hostname === "string" ? n.hostname : null,
      os: typeof n.os === "string" ? n.os : null,
      kernel: typeof n.kernel === "string" ? n.kernel : null,
      arch: typeof n.arch === "string" ? n.arch : null,
      cpu_model: typeof n.cpu_model === "string" ? n.cpu_model : null,
      cpu_cores: typeof n.cpu_cores === "number" ? n.cpu_cores : null,
      mem_total: typeof n.mem_total === "number" ? n.mem_total : null,
      swap_total: typeof n.swap_total === "number" ? n.swap_total : null,
      agent_version: typeof n.agent_version === "string" ? n.agent_version : null,
      proc_enabled: typeof n.proc_enabled === "number" ? n.proc_enabled : 1,
      mute_until: typeof n.mute_until === "number" ? n.mute_until : null,
      created_at: typeof n.created_at === "number" ? n.created_at : nowSec,
      updated_at: typeof n.updated_at === "number" ? n.updated_at : nowSec,
    });
  }

  const rawChannels = Array.isArray(body.notification_channels) ? body.notification_channels : [];
  const normalizedChannels: NotificationChannelRow[] = [];
  for (const item of rawChannels) {
    if (!item || typeof item !== "object") {
      return { ok: false, status: 400, error: "Invalid notification_channel entry in bundle" };
    }
    const ch = item as Partial<NotificationChannelRow>;
    if (
      typeof ch.id !== "string" ||
      typeof ch.name !== "string" ||
      (ch.type !== "telegram" && ch.type !== "webhook") ||
      typeof ch.config_json !== "string"
    ) {
      return { ok: false, status: 400, error: "Invalid notification_channel fields in bundle" };
    }
    normalizedChannels.push({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      enabled: typeof ch.enabled === "number" ? ch.enabled : 1,
      config_json: ch.config_json,
      created_at: typeof ch.created_at === "number" ? ch.created_at : nowSec,
    });
  }

  const rawRules = Array.isArray(body.alert_rules) ? body.alert_rules : [];
  const normalizedRules: AlertRuleRow[] = [];
  for (const item of rawRules) {
    if (!item || typeof item !== "object") {
      return { ok: false, status: 400, error: "Invalid alert_rule entry in bundle" };
    }
    const r = item as Partial<AlertRuleRow>;
    if (
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      !VALID_METRICS.has(r.metric as AlertMetric) ||
      !VALID_OPERATORS.has(r.operator as AlertOperator) ||
      typeof r.threshold !== "number"
    ) {
      return { ok: false, status: 400, error: "Invalid alert_rule fields in bundle" };
    }
    normalizedRules.push({
      id: r.id,
      name: r.name,
      node_id: typeof r.node_id === "string" && r.node_id ? r.node_id : null,
      metric: r.metric as AlertMetric,
      operator: r.operator as AlertOperator,
      threshold: r.threshold,
      duration_sec: typeof r.duration_sec === "number" ? r.duration_sec : 120,
      cooldown_sec: typeof r.cooldown_sec === "number" ? r.cooldown_sec : 3600,
      channel_ids_json: typeof r.channel_ids_json === "string" ? r.channel_ids_json : "[]",
      enabled: typeof r.enabled === "number" ? r.enabled : 1,
      created_at: typeof r.created_at === "number" ? r.created_at : nowSec,
    });
  }

  const normalizedSettings: ExportSystemSettingEntry[] = [];
  if (Array.isArray(body.system_settings)) {
    for (const item of body.system_settings) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { key?: unknown }).key === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as Partial<ExportSystemSettingEntry> & { key: string; value: string };
        if (!shouldSkipImportSettingKey(entry.key, allowReceiveTicket)) {
          normalizedSettings.push({
            key: entry.key,
            value: entry.value,
            updated_at: typeof entry.updated_at === "number" ? entry.updated_at : nowSec,
          });
        }
      }
    }
  } else if (body.system_settings && typeof body.system_settings === "object") {
    for (const [key, value] of Object.entries(body.system_settings as Record<string, unknown>)) {
      if (shouldSkipImportSettingKey(key, allowReceiveTicket)) {
        continue;
      }
      if (typeof value === "string") {
        normalizedSettings.push({ key, value, updated_at: nowSec });
      } else if (
        value &&
        typeof value === "object" &&
        typeof (value as { value?: unknown }).value === "string"
      ) {
        const obj = value as { value: string; updated_at?: unknown };
        normalizedSettings.push({
          key,
          value: obj.value,
          updated_at: typeof obj.updated_at === "number" ? obj.updated_at : nowSec,
        });
      }
    }
  }

  const normalizedLedgers: ExportTrafficLedgerEntry[] = [];
  if (Array.isArray(body.traffic_ledgers)) {
    for (const item of body.traffic_ledgers) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { node_id?: unknown }).node_id === "string"
      ) {
        const entry = item as Partial<ExportTrafficLedgerEntry>;
        normalizedLedgers.push({
          node_id: entry.node_id!,
          cycle_key: typeof entry.cycle_key === "string" ? entry.cycle_key : "",
          last_agent_rx: typeof entry.last_agent_rx === "number" ? entry.last_agent_rx : 0,
          last_agent_tx: typeof entry.last_agent_tx === "number" ? entry.last_agent_tx : 0,
          cycle_rx_bytes: typeof entry.cycle_rx_bytes === "number" ? entry.cycle_rx_bytes : 0,
          cycle_tx_bytes: typeof entry.cycle_tx_bytes === "number" ? entry.cycle_tx_bytes : 0,
          updated_at: typeof entry.updated_at === "number" ? entry.updated_at : nowSec,
        });
      }
    }
  } else if (body.traffic_ledgers && typeof body.traffic_ledgers === "object") {
    for (const [nodeId, val] of Object.entries(body.traffic_ledgers as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const entry = val as Partial<ExportTrafficLedgerEntry>;
        normalizedLedgers.push({
          node_id: nodeId,
          cycle_key: typeof entry.cycle_key === "string" ? entry.cycle_key : "",
          last_agent_rx: typeof entry.last_agent_rx === "number" ? entry.last_agent_rx : 0,
          last_agent_tx: typeof entry.last_agent_tx === "number" ? entry.last_agent_tx : 0,
          cycle_rx_bytes: typeof entry.cycle_rx_bytes === "number" ? entry.cycle_rx_bytes : 0,
          cycle_tx_bytes: typeof entry.cycle_tx_bytes === "number" ? entry.cycle_tx_bytes : 0,
          updated_at: typeof entry.updated_at === "number" ? entry.updated_at : nowSec,
        });
      }
    }
  }

  // NEVER use INSERT OR REPLACE on nodes; FK ON DELETE CASCADE would wipe alert_rules/incidents.
  const statements: D1PreparedStatement[] = [];
  for (const n of normalizedNodes) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO nodes (
          id, name, group_name, tags_json, sort_order, token_sha256,
          traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
          hostname, os, kernel, arch, cpu_model, cpu_cores, mem_total, swap_total,
          agent_version, proc_enabled, mute_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          group_name = excluded.group_name,
          tags_json = excluded.tags_json,
          sort_order = excluded.sort_order,
          token_sha256 = excluded.token_sha256,
          traffic_limit_bytes = excluded.traffic_limit_bytes,
          traffic_reset_day = excluded.traffic_reset_day,
          traffic_count_mode = excluded.traffic_count_mode,
          hostname = excluded.hostname,
          os = excluded.os,
          kernel = excluded.kernel,
          arch = excluded.arch,
          cpu_model = excluded.cpu_model,
          cpu_cores = excluded.cpu_cores,
          mem_total = excluded.mem_total,
          swap_total = excluded.swap_total,
          agent_version = excluded.agent_version,
          proc_enabled = excluded.proc_enabled,
          mute_until = excluded.mute_until,
          updated_at = excluded.updated_at`,
      ).bind(
        n.id,
        n.name,
        n.group_name,
        n.tags_json,
        n.sort_order,
        n.token_sha256,
        n.traffic_limit_bytes,
        n.traffic_reset_day,
        n.traffic_count_mode,
        n.hostname,
        n.os,
        n.kernel,
        n.arch,
        n.cpu_model,
        n.cpu_cores,
        n.mem_total,
        n.swap_total,
        n.agent_version,
        n.proc_enabled,
        n.mute_until,
        n.created_at,
        n.updated_at,
      ),
    );
  }

  for (const ch of normalizedChannels) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO notification_channels (id, name, type, enabled, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           type = excluded.type,
           enabled = excluded.enabled,
           config_json = excluded.config_json`,
      ).bind(ch.id, ch.name, ch.type, ch.enabled, ch.config_json, ch.created_at),
    );
  }

  for (const r of normalizedRules) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO alert_rules (
          id, name, node_id, metric, operator, threshold,
          duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          node_id = excluded.node_id,
          metric = excluded.metric,
          operator = excluded.operator,
          threshold = excluded.threshold,
          duration_sec = excluded.duration_sec,
          cooldown_sec = excluded.cooldown_sec,
          channel_ids_json = excluded.channel_ids_json,
          enabled = excluded.enabled`,
      ).bind(
        r.id,
        r.name,
        r.node_id,
        r.metric,
        r.operator,
        r.threshold,
        r.duration_sec,
        r.cooldown_sec,
        r.channel_ids_json,
        r.enabled,
        r.created_at,
      ),
    );
  }

  let sawSessionSecret = false;
  for (const entry of normalizedSettings) {
    if (entry.key === "admin_password_hash" || entry.key === "session_secret") {
      if (entry.key === "session_secret") {
        sawSessionSecret = true;
      }
      // Preserve active target auth credentials & session secret when already present.
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
        ).bind(entry.key, entry.value, entry.updated_at),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).bind(entry.key, entry.value, entry.updated_at),
      );
    }
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
  if (sawSessionSecret) {
    clearSessionSecretCache();
  }
  for (const n of normalizedNodes) {
    invalidateAgentTokenCache(n.id);
  }

  const [allNodesRes, allRulesRes, allChannelsRes] = await Promise.all([
    env.DB.prepare("SELECT * FROM nodes ORDER BY sort_order ASC, created_at ASC").all<NodeRow>(),
    env.DB.prepare("SELECT * FROM alert_rules ORDER BY created_at ASC").all<AlertRuleRow>(),
    env.DB.prepare(
      "SELECT * FROM notification_channels ORDER BY created_at ASC",
    ).all<NotificationChannelRow>(),
  ]);

  await getFleetHub(env).applyImportedBundle({
    nodes: allNodesRes.results ?? normalizedNodes,
    rules: allRulesRes.results ?? normalizedRules,
    channels: allChannelsRes.results ?? normalizedChannels,
    trafficLedgers: normalizedLedgers,
  });

  return {
    ok: true,
    result: {
      ok: true,
      imported: {
        nodes: normalizedNodes.length,
        channels: normalizedChannels.length,
        rules: normalizedRules.length,
        traffic_ledgers: normalizedLedgers.length,
      },
    },
  };
}

export async function dispatchSignedMigration(
  env: Env,
  params: {
    targetWsUrl: string;
    fallbackWsUrl?: string;
    nodeIds?: unknown[];
  },
): Promise<{ epoch: number; targeted: number; dispatched: number }> {
  const nodesRes = await env.DB.prepare("SELECT id, token_sha256 FROM nodes").all<
    Pick<NodeRow, "id" | "token_sha256">
  >();
  const allNodes = nodesRes.results ?? [];
  const cleanedIds = Array.isArray(params.nodeIds)
    ? params.nodeIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
  const requestedSet = cleanedIds.length > 0 ? new Set(cleanedIds) : null;

  const targetNodes = requestedSet
    ? allNodes.filter((n) => requestedSet.has(n.id))
    : allNodes;

  const epoch = nextMigrationEpoch();
  const signedTargets = await Promise.all(
    targetNodes.map(async (node) => ({
      nodeId: node.id,
      url: params.targetWsUrl,
      ...(params.fallbackWsUrl ? { fallbackUrl: params.fallbackWsUrl } : {}),
      epoch,
      sig: await signMigrationDirective(
        node.id,
        node.token_sha256,
        epoch,
        params.targetWsUrl,
      ),
    })),
  );

  const dispatchResult = await getFleetHub(env).dispatchMigration(signedTargets);
  return {
    epoch,
    targeted: targetNodes.length,
    dispatched: dispatchResult.dispatched.length,
  };
}

interface StoredPullTicket {
  token_sha256?: unknown;
  expires_at?: unknown;
  receive_token_sha256?: unknown;
}

interface StoredReceiveTicket {
  token_sha256?: unknown;
  expires_at?: unknown;
}

interface StoredPairedToken {
  raw_receive_token?: unknown;
  expires_at?: unknown;
}

export async function createMigrationTicket(
  env: Env,
  body: Record<string, unknown>,
  requestUrl: string,
): Promise<
  { ok: true; body: MigrationTicketResponse } | { ok: false; status: 400; error: string }
> {
  const purpose = body.purpose;
  if (purpose !== "receive" && purpose !== "install") {
    return { ok: false, status: 400, error: "purpose must be 'receive' or 'install'" };
  }

  const isProd = isProductionCfAccessEnv(env);
  const originRes = resolvePublicOrigin(body.public_origin, requestUrl, isProd);
  if (!originRes.ok) {
    return { ok: false, status: 400, error: originRes.error };
  }
  const origin = originRes.origin;
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + MIGRATION_TICKET_TTL_SEC;

  if (purpose === "receive") {
    const rawToken = `uob_mtk_${randomBase62(43)}`;
    const tokenSha256 = await sha256Hex(rawToken);
    await writeSettingJson(
      env.DB,
      "migration_receive_ticket",
      { token_sha256: tokenSha256, expires_at: expiresAt },
      nowSec,
    );
    const migrationCode = `uobm1_${base64UrlEncode(
      encoder.encode(JSON.stringify({ u: origin, k: rawToken })),
    )}`;
    return {
      ok: true,
      body: {
        ok: true,
        purpose: "receive",
        origin,
        migration_code: migrationCode,
        expires_at: expiresAt,
      },
    };
  }

  const pullToken = `uob_mpull_${randomBase62(43)}`;
  const receiveToken = `uob_mtk_${randomBase62(43)}`;
  const [pullTokenSha256, receiveTokenSha256] = await Promise.all([
    sha256Hex(pullToken),
    sha256Hex(receiveToken),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(
      "migration_pull_ticket",
      JSON.stringify({
        token_sha256: pullTokenSha256,
        expires_at: expiresAt,
        receive_token_sha256: receiveTokenSha256,
      }),
      nowSec,
    ),
    env.DB.prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(
      "migration_paired_token",
      JSON.stringify({
        raw_receive_token: receiveToken,
        expires_at: expiresAt,
      }),
      nowSec,
    ),
  ]);

  const pullUrl = `${origin}/releases/migration/pull/${pullToken}`;
  const enableWatchdog = body.enable_watchdog !== false;
  let watchdogArmed = false;
  let installCmd = `curl -fsSL '${shellSingleQuote(`${origin}/install-hub.sh`)}' | sudo bash -s -- --import-bundle '${shellSingleQuote(pullUrl)}'`;

  if (enableWatchdog) {
    const currentCfg = await getWatchdogConfig(env.DB);
    const nextTimeout =
      !currentCfg.timeout_sec || currentCfg.timeout_sec <= 300
        ? DEFAULT_TIMEOUT_SEC
        : currentCfg.timeout_sec;
    let channelIds = currentCfg.channel_ids ?? [];
    if (channelIds.length === 0) {
      const channelsRes = await env.DB.prepare(
        "SELECT id FROM notification_channels WHERE enabled = 1 ORDER BY created_at ASC",
      ).all<{ id: string }>();
      channelIds = (channelsRes.results ?? []).map((r) => r.id);
    }
    const savedCfg = await saveWatchdogConfig(
      env.DB,
      {
        enabled: true,
        timeout_sec: nextTimeout,
        channel_ids: channelIds,
      },
      nowSec,
    );
    watchdogArmed = true;
    installCmd += ` --watchdog-url '${shellSingleQuote(`${origin}/api/watchdog/ping`)}' --watchdog-secret '${shellSingleQuote(savedCfg.secret)}'`;
  }

  return {
    ok: true,
    body: {
      ok: true,
      purpose: "install",
      origin,
      pull_url: pullUrl,
      install_cmd: installCmd,
      watchdog_armed: watchdogArmed,
      expires_at: expiresAt,
    },
  };
}

export async function pullMigrationBundle(
  env: Env,
  rawToken: string,
): Promise<{ ok: true; bundle: ExportBundle } | { ok: false; status: 401; error: string }> {
  const errMsg = "迁移安装链接已过期或无效，请回到原面板重新生成";
  const token = rawToken.trim();
  if (!token.startsWith("uob_mpull_") || token.length > 128) {
    return { ok: false, status: 401, error: errMsg };
  }

  const ticket = await readSettingJson<StoredPullTicket>(env.DB, "migration_pull_ticket");
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    !ticket ||
    typeof ticket.token_sha256 !== "string" ||
    typeof ticket.expires_at !== "number" ||
    nowSec > ticket.expires_at
  ) {
    return { ok: false, status: 401, error: errMsg };
  }

  const tokenHash = await sha256Hex(token);
  if (!(await constantTimeEqual(tokenHash, ticket.token_sha256))) {
    return { ok: false, status: 401, error: errMsg };
  }

  const bundle = await exportBundle(env);
  if (typeof ticket.receive_token_sha256 === "string" && ticket.receive_token_sha256.length > 0) {
    bundle.system_settings.push({
      key: "migration_receive_ticket",
      value: JSON.stringify({
        token_sha256: ticket.receive_token_sha256,
        expires_at: ticket.expires_at,
      }),
      updated_at: nowSec,
    });
  }

  return { ok: true, bundle };
}

export async function receiveMigrationBundle(
  env: Env,
  rawToken: string,
  body: Record<string, unknown> | null,
): Promise<
  | { ok: true; body: MigrationReceiveResponse }
  | { ok: false; status: 400 | 401; error: string }
> {
  const authErrMsg = "迁移口令已过期或无效，请在新面板重新生成迁移口令";
  const token = rawToken.trim();
  if (!token.startsWith("uob_mtk_") || token.length > 128) {
    return { ok: false, status: 401, error: authErrMsg };
  }

  const ticket = await readSettingJson<StoredReceiveTicket>(env.DB, "migration_receive_ticket");
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    !ticket ||
    typeof ticket.token_sha256 !== "string" ||
    typeof ticket.expires_at !== "number" ||
    nowSec > ticket.expires_at
  ) {
    return { ok: false, status: 401, error: authErrMsg };
  }

  const tokenHash = await sha256Hex(token);
  if (!(await constantTimeEqual(tokenHash, ticket.token_sha256))) {
    return { ok: false, status: 401, error: authErrMsg };
  }

  if (!body) {
    return { ok: false, status: 400, error: "Invalid export bundle: nodes array is required" };
  }

  const imp = await importBundle(env, body, { allowReceiveTicket: false });
  if (!imp.ok) {
    return { ok: false, status: 400, error: imp.error };
  }

  return {
    ok: true,
    body: {
      ok: true,
      mode: "cloudflare-worker",
      imported: imp.result.imported,
    },
  };
}

function decodeMigrationCode(
  code: string,
): { ok: true; url: string; token: string } | { ok: false; error: string } {
  const encoded = code.slice("uobm1_".length).trim();
  const bytes = encoded ? base64UrlDecode(encoded) : null;
  if (!bytes) {
    return {
      ok: false,
      error: "迁移口令格式无效，请检查是否完整复制（当前面板和节点均未受影响）",
    };
  }
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as { u?: unknown; k?: unknown };
    const url = typeof parsed?.u === "string" ? parsed.u.trim() : "";
    const token = typeof parsed?.k === "string" ? parsed.k.trim() : "";
    if (!url || !token.startsWith("uob_mtk_") || token.length > 128) {
      return {
        ok: false,
        error: "迁移口令内容不完整或格式无效，请在新面板重新生成迁移口令（当前面板和节点均未受影响）",
      };
    }
    return { ok: true, url, token };
  } catch {
    return {
      ok: false,
      error: "迁移口令解析失败，请在新面板重新复制迁移口令（当前面板和节点均未受影响）",
    };
  }
}

export async function executeSmartMigration(
  env: Env,
  body: Record<string, unknown>,
  requestUrl: string,
): Promise<
  { ok: true; body: SmartMigrateResponse } | { ok: false; status: 400 | 502; error: string }
> {
  const targetInput = typeof body.target_input === "string" ? body.target_input.trim() : "";
  if (!targetInput) {
    return {
      ok: false,
      status: 400,
      error: "请输入目标面板地址或迁移口令（当前面板和节点均未受影响）",
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let rawTargetUrl = "";
  let receiveToken = "";

  if (targetInput.startsWith("uobm1_")) {
    const decoded = decodeMigrationCode(targetInput);
    if (!decoded.ok) {
      return { ok: false, status: 400, error: decoded.error };
    }
    rawTargetUrl = decoded.url;
    receiveToken = decoded.token;
  } else {
    const paired = await readSettingJson<StoredPairedToken>(env.DB, "migration_paired_token");
    if (
      !paired ||
      typeof paired.raw_receive_token !== "string" ||
      !paired.raw_receive_token.startsWith("uob_mtk_") ||
      paired.raw_receive_token.length > 128 ||
      typeof paired.expires_at !== "number" ||
      nowSec > paired.expires_at
    ) {
      return {
        ok: false,
        status: 400,
        error:
          "未找到有效的一键安装配对凭据（或已超过 30 分钟有效期），请重新生成一键安装命令，或粘贴目标面板的迁移口令（当前面板和节点均未受影响）",
      };
    }
    rawTargetUrl = targetInput;
    receiveToken = paired.raw_receive_token;
  }

  const allowInsecureWs = Boolean(body.allow_insecure_ws);
  const isProd = isProductionCfAccessEnv(env);
  const targetValidation = normalizeAndValidateMigrationUrl(rawTargetUrl, {
    allowInsecureWs,
    isProduction: isProd,
  });
  if (!targetValidation.ok) {
    return {
      ok: false,
      status: 400,
      error: `目标地址无效：${targetValidation.error}（当前面板和节点均未受影响）`,
    };
  }

  const targetWsUrl = targetValidation.wsUrl;
  const targetParsed = new URL(targetWsUrl);
  const targetHttpProto = targetParsed.protocol === "ws:" ? "http:" : "https:";
  const targetOrigin = `${targetHttpProto}//${targetParsed.host}`;
  const sourceOrigin = new URL(requestUrl).origin;

  if (targetOrigin.toLowerCase() === sourceOrigin.toLowerCase()) {
    return {
      ok: false,
      status: 400,
      error: "目标面板与当前面板地址相同，请填写新面板的地址或迁移口令（当前面板和节点均未受影响）",
    };
  }

  const bundle = await exportBundle(env);
  let remoteResp: Response;
  try {
    remoteResp = await fetch(`${targetOrigin}/releases/migration/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${receiveToken}`,
      },
      body: JSON.stringify(bundle),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : "网络超时或连接被拒绝";
    return {
      ok: false,
      status: 502,
      error: `无法连接目标面板（${detail}），原节点未受任何影响，请检查新面板地址及网络连通性`,
    };
  }

  if (remoteResp.status >= 300 && remoteResp.status < 400) {
    const loc = remoteResp.headers.get("Location") ?? "";
    try {
      await remoteResp.body?.cancel();
    } catch {
      // ignore cancel errors
    }
    if (loc.toLowerCase().includes("cloudflareaccess.com")) {
      return {
        ok: false,
        status: 400,
        error:
          "目标面板被 Cloudflare Access 拦截（跳转至登录页），请在 Cloudflare Zero Trust 中为目标面板的 /releases/migration/* 路径配置 Bypass（绕过）规则后再重试，原节点未受任何影响",
      };
    }
    return {
      ok: false,
      status: 502,
      error: `目标面板返回重定向（HTTP ${remoteResp.status}${loc ? ` -> ${loc}` : ""}），请使用目标面板的最终直接访问地址，原节点未受任何影响`,
    };
  }

  const remoteText = await remoteResp.text().catch(() => "");
  let remoteJson: Record<string, unknown> | null = null;
  if (remoteText) {
    try {
      const parsed = JSON.parse(remoteText) as unknown;
      if (parsed && typeof parsed === "object") {
        remoteJson = parsed as Record<string, unknown>;
      }
    } catch {
      remoteJson = null;
    }
  }
  const remoteErrMsg =
    remoteJson && typeof remoteJson.error === "string" ? remoteJson.error : "";

  if (remoteResp.status === 401 || remoteResp.status === 403) {
    return {
      ok: false,
      status: 400,
      error: remoteErrMsg
        ? `目标面板鉴权失败：${remoteErrMsg}（原节点未受任何影响）`
        : `目标面板拒绝同步（HTTP ${remoteResp.status}），迁移口令可能已过期或无效，或被 Cloudflare Access 拦截，原节点未受任何影响`,
    };
  }

  if (remoteResp.status >= 500) {
    return {
      ok: false,
      status: 502,
      error: `目标面板服务异常（HTTP ${remoteResp.status}）${remoteErrMsg ? `：${remoteErrMsg}` : ""}，原节点未受任何影响`,
    };
  }

  if (!remoteResp.ok) {
    return {
      ok: false,
      status: 400,
      error: `目标面板同步失败（HTTP ${remoteResp.status}）${remoteErrMsg ? `：${remoteErrMsg}` : ""}，原节点未受任何影响`,
    };
  }

  if (
    !remoteJson ||
    remoteJson.ok !== true ||
    !remoteJson.imported ||
    typeof remoteJson.imported !== "object"
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "目标面板返回了无效的同步响应（非 JSON 或缺少同步统计），请确认目标地址为新版 UniOB 面板，原节点未受任何影响",
    };
  }

  const rawImported = remoteJson.imported as Record<string, unknown>;
  const synced: ImportBundleResponse["imported"] = {
    nodes: typeof rawImported.nodes === "number" ? rawImported.nodes : 0,
    channels: typeof rawImported.channels === "number" ? rawImported.channels : 0,
    rules: typeof rawImported.rules === "number" ? rawImported.rules : 0,
    traffic_ledgers:
      typeof rawImported.traffic_ledgers === "number" ? rawImported.traffic_ledgers : 0,
  };

  const fbValidation = normalizeAndValidateMigrationUrl(sourceOrigin, {
    allowInsecureWs,
    isProduction: isProd,
  });
  const fallbackWsUrl =
    fbValidation.ok && fbValidation.wsUrl !== targetWsUrl ? fbValidation.wsUrl : null;

  const dispatch = await dispatchSignedMigration(env, {
    targetWsUrl,
    fallbackWsUrl: fallbackWsUrl ?? undefined,
    nodeIds: Array.isArray(body.node_ids) ? body.node_ids : undefined,
  });

  return {
    ok: true,
    body: {
      ok: true,
      target_origin: targetOrigin,
      target_ws_url: targetWsUrl,
      fallback_ws_url: fallbackWsUrl,
      synced,
      targeted: dispatch.targeted,
      dispatched: dispatch.dispatched,
      epoch: dispatch.epoch,
    },
  };
}
