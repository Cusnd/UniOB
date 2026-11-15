import { Hono, type Context, type Next } from "hono";
import { countFiringAlerts, rowToAlertRule, rowToNotificationChannel } from "./alert/engine";
import { sendTestNotification } from "./alert/telegram";
import {
  buildClearSessionCookie,
  clearSessionSecretCache,
  createSessionForAdmin,
  getAdminAuthStatus,
  invalidateAgentTokenCache,
  setupInitialPassword,
  verifyAdminLogin,
  verifyAgentEdgeAuth,
} from "./auth";
import { generateAgentToken, generateId, sha256Hex } from "./crypto";
import { FleetHubDO } from "./do/fleet-hub-do";
import { NodeDO } from "./do/node-do";
import { buildInstallCommand, renderInstallHubScript, renderInstallScript } from "./install-script";
import {
  VALID_METRICS,
  VALID_OPERATORS,
  createMigrationTicket,
  dispatchSignedMigration,
  executeSmartMigration,
  exportBundle,
  getFleetHub,
  importBundle,
  isProductionCfAccessEnv,
  normalizeAndValidateMigrationUrl,
  pullMigrationBundle,
  receiveMigrationBundle,
  sanitizeResetDay,
  sanitizeTrafficMode,
} from "./migration";
import { computeTrafficCycle } from "./traffic";
import { nqParseConfig, nqParseOverride } from "./network-quality";
import { NQ_RANGE_SECONDS } from "./do/network-quality-store";
import type {
  AlertMetric,
  AlertOperator,
  AlertRuleRow,
  ChannelType,
  Env,
  HubMigrateRequest,
  HubMigrateResponse,
  HubStatusResponse,
  MetricRange,
  NodeRow,
  NodeSnapshot,
  NodeSummary,
  NotificationChannelRow,
} from "./types";
import {
  BUNDLED_AGENT_VERSION,
  checkLatestAgentRelease,
  decodeAutoUpdateOverride,
  getAgentUpdateConfig,
  readCachedAgentRelease,
  saveAgentUpdateConfig,
} from "./auto-update";
import {
  getWatchdogConfig,
  getWatchdogState,
  getWatchdogStatusSummary,
  handleWatchdogPing,
  runWatchdogCron,
  saveWatchdogConfig,
} from "./watchdog";

export { FleetHubDO, NodeDO };

const WORKER_VERSION = "2.0.0";
const VALID_RANGES = new Set<MetricRange>(["1h", "24h", "7d", "30d", "1y"]);

function formatNodeSummary(row: NodeRow, snapshot?: NodeSnapshot): NodeSummary {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) {
      tags = parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    tags = [];
  }

  const hw = snapshot?.hardware;
  const nowSec = Math.floor(Date.now() / 1000);
  const { cycleKey, daysRemaining } = computeTrafficCycle(nowSec, row.traffic_reset_day);

  return {
    id: row.id,
    name: row.name,
    group_name: row.group_name,
    tags,
    sort_order: row.sort_order,
    mute_until: row.mute_until,
    caps: snapshot?.caps ?? [],
    auto_update_override: decodeAutoUpdateOverride(row.auto_update_override),
    update_status: snapshot?.update_status ?? null,
    hostname: hw?.hostname ?? row.hostname,
    os: hw?.os ?? row.os,
    kernel: hw?.kernel ?? row.kernel,
    arch: hw?.arch ?? row.arch,
    cpu_model: hw?.cpu_model ?? row.cpu_model,
    cpu_cores: hw?.cpu_cores ?? row.cpu_cores,
    mem_total: hw?.mem_total ?? row.mem_total,
    swap_total: hw?.swap_total ?? row.swap_total,
    agent_version: hw?.agent_version ?? row.agent_version,
    proc_enabled: hw ? hw.proc_enabled : row.proc_enabled === 1,
    online: snapshot?.online ?? false,
    last_seen_ts: snapshot?.last_seen_ts ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    traffic: snapshot?.traffic ?? {
      limit_bytes: row.traffic_limit_bytes,
      reset_day: row.traffic_reset_day,
      count_mode: row.traffic_count_mode,
      cycle_key: cycleKey,
      rx_bytes: 0,
      tx_bytes: 0,
      counted_bytes: 0,
      days_remaining: daysRemaining,
    },
    metrics: snapshot?.metrics ?? null,
  };
}

async function parseJson<T>(c: Context<{ Bindings: Env }>): Promise<T | null> {
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

async function pushAlertConfigToHub(env: Env): Promise<void> {
  const [rulesRes, channelsRes] = await Promise.all([
    env.DB.prepare("SELECT * FROM alert_rules ORDER BY created_at ASC").all<AlertRuleRow>(),
    env.DB.prepare(
      "SELECT * FROM notification_channels ORDER BY created_at ASC",
    ).all<NotificationChannelRow>(),
  ]);
  await getFleetHub(env).refreshRulesAndChannels(
    rulesRes.results ?? [],
    channelsRes.results ?? [],
  );
}

function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 16);
}



function isValidChannelConfig(type: ChannelType, config: unknown): boolean {
  if (!config || typeof config !== "object") {
    return false;
  }
  const obj = config as Record<string, unknown>;
  if (type === "telegram") {
    return (
      typeof obj.bot_token === "string" &&
      obj.bot_token.trim().length > 0 &&
      (typeof obj.chat_id === "string" || typeof obj.chat_id === "number") &&
      String(obj.chat_id).trim().length > 0
    );
  }
  if (type === "webhook") {
    if (typeof obj.url !== "string") {
      return false;
    }
    try {
      const parsed = new URL(obj.url.trim());
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  return false;
}

async function requireAdminMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const status = await getAdminAuthStatus(c.req.raw, c.env);
  if (!status.authenticated) {
    if (status.forbidden) {
      return c.json({ error: "Forbidden: email is not authorized" }, 403);
    }
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}

const app = new Hono<{ Bindings: Env }>();

// Public routes before admin auth middleware.
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    mode: "cloudflare-worker",
    version: WORKER_VERSION,
    ts: Math.floor(Date.now() / 1000),
  }),
);

app.get("/api/auth/me", async (c) => {
  const status = await getAdminAuthStatus(c.req.raw, c.env);
  return c.json(status, 200);
});

app.get("/api/auth/status", async (c) => {
  const status = await getAdminAuthStatus(c.req.raw, c.env);
  return c.json(status, 200);
});

app.post("/api/auth/setup", async (c) => {
  const body = await parseJson<{ password?: unknown }>(c);
  if (!body || typeof body.password !== "string") {
    return c.json({ error: "password is required" }, 400);
  }
  const setup = await setupInitialPassword(body.password, c.env);
  if (!setup.ok) {
    return c.json({ error: setup.error }, setup.status);
  }
  const session = await createSessionForAdmin(c.req.raw, c.env);
  return c.json(
    { ok: true },
    200,
    {
      "Set-Cookie": session.cookie,
    },
  );
});

app.post("/api/auth/login", async (c) => {
  const body = await parseJson<{ password?: unknown }>(c);
  const password = typeof body?.password === "string" ? body.password : "";
  const result = await verifyAdminLogin(password, c.req.raw, c.env);
  if (!result.ok) {
    const headers: Record<string, string> = {};
    if (result.retryAfterSec !== undefined) {
      headers["Retry-After"] = String(result.retryAfterSec);
    }
    return c.json({ error: result.error }, result.status, headers);
  }
  const session = await createSessionForAdmin(c.req.raw, c.env);
  return c.json(
    { ok: true },
    200,
    {
      "Set-Cookie": session.cookie,
    },
  );
});

app.post("/api/auth/logout", (c) => {
  return c.json(
    { ok: true },
    200,
    {
      "Set-Cookie": buildClearSessionCookie(c.req.raw),
    },
  );
});

app.get("/install.sh", (c) => {
  const origin = new URL(c.req.url).origin;
  const script = renderInstallScript(c.env.GITHUB_REPO, origin);
  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

app.get("/install-hub.sh", (c) => {
  const origin = new URL(c.req.url).origin;
  const script = renderInstallHubScript(c.env.GITHUB_REPO, origin);
  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

app.get("/api/agent/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const auth = await verifyAgentEdgeAuth(c.req.raw, c.env);
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-UniOB-Role", "agent");
  headers.set("X-UniOB-Node-Id", auth.nodeId);
  const forwardReq = new Request(c.req.raw, { headers });
  return getFleetHub(c.env).fetch(forwardReq);
});

app.post("/api/watchdog/ping", async (c) => {
  const result = await handleWatchdogPing(c.env.DB, c.req.raw);
  return c.json(result.body, result.statusCode as 200 | 400 | 401 | 403);
});

function extractMigrationBearerToken(authHeader: string | undefined, altHeader: string | undefined): string {
  const rawAuth = authHeader?.trim() ?? "";
  if (rawAuth.toLowerCase().startsWith("bearer ")) {
    return rawAuth.slice(7).trim();
  }
  return altHeader?.trim() ?? "";
}

app.get("/releases/migration/pull/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  const res = await pullMigrationBundle(c.env, c.req.param("token"));
  if (!res.ok) {
    return c.json({ error: res.error }, res.status);
  }
  return c.json(res.bundle);
});

app.get("/api/migration/pull/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  const res = await pullMigrationBundle(c.env, c.req.param("token"));
  if (!res.ok) {
    return c.json({ error: res.error }, res.status);
  }
  return c.json(res.bundle);
});

app.post("/releases/migration/receive", async (c) => {
  c.header("Cache-Control", "no-store");
  const token = extractMigrationBearerToken(
    c.req.header("authorization"),
    c.req.header("x-migration-token"),
  );
  const body = await parseJson<Record<string, unknown>>(c);
  const res = await receiveMigrationBundle(c.env, token, body);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status);
  }
  return c.json(res.body);
});

app.post("/api/migration/receive", async (c) => {
  c.header("Cache-Control", "no-store");
  const token = extractMigrationBearerToken(
    c.req.header("authorization"),
    c.req.header("x-migration-token"),
  );
  const body = await parseJson<Record<string, unknown>>(c);
  const res = await receiveMigrationBundle(c.env, token, body);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status);
  }
  return c.json(res.body);
});

function isPublicMigrationApiPath(path: string): boolean {
  if (path === "/api/migration/receive") {
    return true;
  }
  const pullPrefix = "/api/migration/pull/";
  if (!path.startsWith(pullPrefix) || path.length <= pullPrefix.length) {
    return false;
  }
  return !path.slice(pullPrefix.length).includes("/");
}

// Require Admin Auth on all remaining /api/* routes.
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (
    path === "/api/health" ||
    path === "/api/auth/me" ||
    path === "/api/auth/status" ||
    path === "/api/auth/setup" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    path === "/api/agent/ws" ||
    path === "/api/watchdog/ping" ||
    isPublicMigrationApiPath(path)
  ) {
    await next();
    return;
  }
  return requireAdminMiddleware(c, next);
});

app.get("/api/client/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-UniOB-Role", "client");
  const forwardReq = new Request(c.req.raw, { headers });
  return getFleetHub(c.env).fetch(forwardReq);
});

// ---- Nodes API ----

app.get("/api/nodes", async (c) => {
  const hub = getFleetHub(c.env);
  const [nodesRes, snapshots, firingAlerts] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM nodes ORDER BY sort_order ASC, created_at ASC",
    ).all<NodeRow>(),
    hub.getFleetSnapshot(),
    countFiringAlerts(c.env.DB),
  ]);

  const rows = nodesRes.results ?? [];
  const missing = rows.filter((row) => !(row.id in snapshots));
  if (missing.length > 0) {
    await Promise.all(missing.map((row) => hub.syncNodeConfig(row)));
  }

  const nodes = rows.map((row) =>
    formatNodeSummary(row, snapshots[row.id]),
  );

  return c.json({
    nodes,
    activeAlertsCount: firingAlerts,
    server_ts: Math.floor(Date.now() / 1000),
  });
});

app.get("/api/nodes/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
    .bind(id)
    .first<NodeRow>();
  if (!row) {
    return c.json({ error: "Node not found" }, 404);
  }

  const [snapshot, incidentsRes] = await Promise.all([
    getFleetHub(c.env).getNodeSnapshot(id),
    c.env.DB.prepare(
      `SELECT i.*, r.name AS rule_name, r.metric, r.operator, r.threshold
       FROM alert_incidents i
       LEFT JOIN alert_rules r ON r.id = i.rule_id
       WHERE i.node_id = ?
       ORDER BY i.started_at DESC
       LIMIT 50`,
    )
      .bind(id)
      .all<Record<string, unknown>>(),
  ]);

  return c.json({
    node: formatNodeSummary(row, snapshot),
    incidents: incidentsRes.results ?? [],
  });
});

app.post("/api/nodes", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) {
    return c.json({ error: "Node name is required (1-80 chars)" }, 400);
  }

  const groupName =
    typeof body.group_name === "string" && body.group_name.trim().length > 0
      ? body.group_name.trim().slice(0, 64)
      : "Default";
  const tags = sanitizeTags(body.tags);
  const sortOrder =
    typeof body.sort_order === "number" && Number.isFinite(body.sort_order)
      ? Math.floor(body.sort_order)
      : 0;
  const trafficLimitBytes =
    typeof body.traffic_limit_bytes === "number" &&
    Number.isFinite(body.traffic_limit_bytes) &&
    body.traffic_limit_bytes > 0
      ? Math.floor(body.traffic_limit_bytes)
      : null;
  const trafficResetDay = sanitizeResetDay(body.traffic_reset_day);
  const trafficCountMode = sanitizeTrafficMode(body.traffic_count_mode);

  const id = generateId("node");
  const token = generateAgentToken();
  const tokenSha256 = await sha256Hex(token);
  const nowSec = Math.floor(Date.now() / 1000);

  const row: NodeRow = {
    id,
    name,
    group_name: groupName,
    tags_json: JSON.stringify(tags),
    sort_order: sortOrder,
    token_sha256: tokenSha256,
    traffic_limit_bytes: trafficLimitBytes,
    traffic_reset_day: trafficResetDay,
    traffic_count_mode: trafficCountMode,
    hostname: null,
    os: null,
    kernel: null,
    arch: null,
    cpu_model: null,
    cpu_cores: null,
    mem_total: null,
    swap_total: null,
    agent_version: null,
    proc_enabled: 1,
    mute_until: null,
    auto_update_override: null,
    created_at: nowSec,
    updated_at: nowSec,
  };

  await c.env.DB.prepare(
    `INSERT INTO nodes (
      id, name, group_name, tags_json, sort_order, token_sha256,
      traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.name,
      row.group_name,
      row.tags_json,
      row.sort_order,
      row.token_sha256,
      row.traffic_limit_bytes,
      row.traffic_reset_day,
      row.traffic_count_mode,
      row.created_at,
      row.updated_at,
    )
    .run();

  await getFleetHub(c.env).syncNodeConfig(row);

  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      node: formatNodeSummary(row),
      agent_token: token,
      install_cmd: buildInstallCommand(origin, id, token),
    },
    201,
  );
});

app.patch("/api/nodes/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
    .bind(id)
    .first<NodeRow>();
  if (!existing) {
    return c.json({ error: "Node not found" }, 404);
  }

  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim().slice(0, 80)
      : existing.name;
  const groupName =
    typeof body.group_name === "string" && body.group_name.trim().length > 0
      ? body.group_name.trim().slice(0, 64)
      : existing.group_name;
  const tagsJson =
    body.tags !== undefined
      ? JSON.stringify(sanitizeTags(body.tags))
      : existing.tags_json;
  const sortOrder =
    typeof body.sort_order === "number" && Number.isFinite(body.sort_order)
      ? Math.floor(body.sort_order)
      : existing.sort_order;
  const trafficLimitBytes =
    body.traffic_limit_bytes === null
      ? null
      : typeof body.traffic_limit_bytes === "number" &&
          Number.isFinite(body.traffic_limit_bytes) &&
          body.traffic_limit_bytes > 0
        ? Math.floor(body.traffic_limit_bytes)
        : existing.traffic_limit_bytes;
  const trafficResetDay =
    body.traffic_reset_day !== undefined
      ? sanitizeResetDay(body.traffic_reset_day)
      : existing.traffic_reset_day;
  const trafficCountMode =
    body.traffic_count_mode !== undefined
      ? sanitizeTrafficMode(body.traffic_count_mode)
      : existing.traffic_count_mode;
  const muteUntil =
    body.mute_until === null
      ? null
      : typeof body.mute_until === "number" && Number.isFinite(body.mute_until)
        ? Math.floor(body.mute_until)
        : existing.mute_until;
  if (
    body.auto_update_override !== undefined &&
    body.auto_update_override !== null &&
    typeof body.auto_update_override !== "boolean"
  ) {
    return c.json(
      { error: "auto_update_override must be boolean or null" },
      400,
    );
  }
  const autoUpdateOverride =
    body.auto_update_override === undefined
      ? existing.auto_update_override
      : body.auto_update_override === null
        ? null
        : body.auto_update_override
          ? 1
          : 0;
  const nowSec = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `UPDATE nodes SET
      name = ?, group_name = ?, tags_json = ?, sort_order = ?,
      traffic_limit_bytes = ?, traffic_reset_day = ?, traffic_count_mode = ?,
      mute_until = ?, auto_update_override = ?, updated_at = ?
    WHERE id = ?`,
  )
    .bind(
      name,
      groupName,
      tagsJson,
      sortOrder,
      trafficLimitBytes,
      trafficResetDay,
      trafficCountMode,
      muteUntil,
      autoUpdateOverride,
      nowSec,
      id,
    )
    .run();

  const updated = await c.env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
    .bind(id)
    .first<NodeRow>();
  if (!updated) {
    return c.json({ error: "Node not found" }, 404);
  }

  const hub = getFleetHub(c.env);
  await hub.syncNodeConfig(updated);
  const snapshot = await hub.getNodeSnapshot(id);
  return c.json({ node: formatNodeSummary(updated, snapshot) });
});

app.post("/api/nodes/:id/rotate-token", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
    .bind(id)
    .first<NodeRow>();
  if (!existing) {
    return c.json({ error: "Node not found" }, 404);
  }

  const token = generateAgentToken();
  const tokenSha256 = await sha256Hex(token);
  const nowSec = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare("UPDATE nodes SET token_sha256 = ?, updated_at = ? WHERE id = ?")
    .bind(tokenSha256, nowSec, id)
    .run();

  invalidateAgentTokenCache(id);

  const updated = { ...existing, token_sha256: tokenSha256, updated_at: nowSec };
  const hub = getFleetHub(c.env);
  await hub.syncNodeConfig(updated);
  await hub.disconnectAgent(id, "Token rotated");

  const origin = new URL(c.req.url).origin;
  return c.json({
    node: formatNodeSummary(updated),
    agent_token: token,
    install_cmd: buildInstallCommand(origin, id, token),
  });
});

app.post("/api/nodes/:id/mute", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
    .bind(id)
    .first<NodeRow>();
  if (!existing) {
    return c.json({ error: "Node not found" }, 404);
  }

  const body = (await parseJson<Record<string, unknown>>(c)) ?? {};
  const nowSec = Math.floor(Date.now() / 1000);
  let muteUntil: number | null = null;

  if (body.mute_until === null || body.duration_sec === 0) {
    muteUntil = null;
  } else if (typeof body.mute_until === "number" && Number.isFinite(body.mute_until)) {
    muteUntil = body.mute_until > nowSec ? Math.floor(body.mute_until) : null;
  } else if (typeof body.duration_sec === "number" && Number.isFinite(body.duration_sec)) {
    muteUntil = body.duration_sec > 0 ? nowSec + Math.floor(body.duration_sec) : null;
  } else {
    muteUntil = nowSec + 3600;
  }

  await c.env.DB.prepare("UPDATE nodes SET mute_until = ?, updated_at = ? WHERE id = ?")
    .bind(muteUntil, nowSec, id)
    .run();

  const updated = { ...existing, mute_until: muteUntil, updated_at: nowSec };
  const hub = getFleetHub(c.env);
  await hub.syncNodeConfig(updated);
  const snapshot = await hub.getNodeSnapshot(id);
  return c.json({ node: formatNodeSummary(updated, snapshot) });
});

app.delete("/api/nodes/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT id FROM nodes WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ error: "Node not found" }, 404);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM alert_incidents WHERE node_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM system_settings WHERE key = ?").bind(`network_quality_node:${id}`),
    c.env.DB.prepare("DELETE FROM nodes WHERE id = ?").bind(id),
  ]);
  invalidateAgentTokenCache(id);
  await getFleetHub(c.env).deleteNode(id);
  await pushAlertConfigToHub(c.env);
  return c.json({ ok: true });
});

app.get("/api/nodes/:id/metrics", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT id FROM nodes WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ error: "Node not found" }, 404);
  }

  const rawRange = c.req.query("range");
  if (rawRange !== undefined && !VALID_RANGES.has(rawRange as MetricRange)) {
    return c.json({ error: "Invalid metrics range" }, 400);
  }
  const range: MetricRange = (rawRange as MetricRange | undefined) ?? "1h";
  const result = await getFleetHub(c.env).queryMetrics(id, range);
  return c.json(result);
});

// Network quality uses admin auth already applied to /api/* above.
app.get("/api/network-quality/config", async c => c.json(await getFleetHub(c.env).getNetworkQualityConfig()));
app.put("/api/network-quality/config", async c => {
  let config;
  try { config = nqParseConfig(await c.req.json()); } catch (e) { return c.json({error: e instanceof Error ? e.message : "Invalid configuration"},400); }
  return c.json(await getFleetHub(c.env).saveNetworkQualityConfig(config));
});
app.get("/api/nodes/:id/network-quality/config", async c => {
  const id = c.req.param("id");
  if (!await c.env.DB.prepare("SELECT id FROM nodes WHERE id=?").bind(id).first()) return c.json({error:"Node not found"},404);
  return c.json(await getFleetHub(c.env).getNetworkQualityConfig(id));
});
app.put("/api/nodes/:id/network-quality/config", async c => {
  const id = c.req.param("id");
  if (!await c.env.DB.prepare("SELECT id FROM nodes WHERE id=?").bind(id).first()) return c.json({error:"Node not found"},404);
  let config;
  try { config = nqParseOverride(await c.req.json()); } catch (e) { return c.json({error: e instanceof Error ? e.message : "Invalid configuration"},400); }
  return c.json(await getFleetHub(c.env).saveNetworkQualityConfig(config,id));
});
app.get("/api/nodes/:id/network-quality", async c => {
  const id = c.req.param("id");
  if (!await c.env.DB.prepare("SELECT id FROM nodes WHERE id=?").bind(id).first()) return c.json({error:"Node not found"},404);
  const range = c.req.query("range") ?? "1h";
  if (!Object.hasOwn(NQ_RANGE_SECONDS,range)) return c.json({error:"Invalid network quality range"},400);
  const result = await getFleetHub(c.env).queryNetworkQuality(id,range,c.req.query("cursor"));
  if ("error" in result) return c.json({error:result.error},400);
  return c.json(result);
});

// ---- Alert Channels, Rules, and Incidents API ----

app.get("/api/alerts/channels", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM notification_channels ORDER BY created_at ASC",
  ).all<NotificationChannelRow>();
  return c.json({
    channels: (res.results ?? []).map(rowToNotificationChannel),
  });
});

app.post("/api/alerts/channels", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const type = body.type as ChannelType;
  if (!name || (type !== "telegram" && type !== "webhook")) {
    return c.json({ error: "Valid name and channel type are required" }, 400);
  }
  if (!isValidChannelConfig(type, body.config)) {
    return c.json({ error: "Invalid channel config" }, 400);
  }

  const id = generateId("ch");
  const enabled = body.enabled === false ? 0 : 1;
  const createdAt = Math.floor(Date.now() / 1000);
  const configJson = JSON.stringify(body.config);

  await c.env.DB.prepare(
    `INSERT INTO notification_channels (id, name, type, enabled, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, name, type, enabled, configJson, createdAt)
    .run();

  await pushAlertConfigToHub(c.env);

  const row: NotificationChannelRow = {
    id,
    name,
    type,
    enabled,
    config_json: configJson,
    created_at: createdAt,
  };
  return c.json({ channel: rowToNotificationChannel(row) }, 201);
});

app.patch("/api/alerts/channels/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT * FROM notification_channels WHERE id = ?",
  )
    .bind(id)
    .first<NotificationChannelRow>();
  if (!existing) {
    return c.json({ error: "Channel not found" }, 404);
  }

  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : existing.name;
  const type =
    body.type === "telegram" || body.type === "webhook"
      ? body.type
      : existing.type;
  const enabled =
    typeof body.enabled === "boolean"
      ? body.enabled
        ? 1
        : 0
      : existing.enabled;

  let configJson = existing.config_json;
  if (body.config !== undefined) {
    if (!isValidChannelConfig(type, body.config)) {
      return c.json({ error: "Invalid channel config" }, 400);
    }
    configJson = JSON.stringify(body.config);
  }

  await c.env.DB.prepare(
    `UPDATE notification_channels
     SET name = ?, type = ?, enabled = ?, config_json = ?
     WHERE id = ?`,
  )
    .bind(name, type, enabled, configJson, id)
    .run();

  await pushAlertConfigToHub(c.env);

  const updated: NotificationChannelRow = {
    ...existing,
    name,
    type,
    enabled,
    config_json: configJson,
  };
  return c.json({ channel: rowToNotificationChannel(updated) });
});

app.delete("/api/alerts/channels/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM notification_channels WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ error: "Channel not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM notification_channels WHERE id = ?")
    .bind(id)
    .run();
  await pushAlertConfigToHub(c.env);
  return c.json({ ok: true });
});

app.post("/api/alerts/channels/:id/test", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM notification_channels WHERE id = ?",
  )
    .bind(id)
    .first<NotificationChannelRow>();
  if (!row) {
    return c.json({ error: "Channel not found" }, 404);
  }
  const channel = rowToNotificationChannel(row);
  const result = await sendTestNotification(channel);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error ?? "Delivery failed" }, 502);
  }
  return c.json({ ok: true });
});

app.get("/api/alerts/rules", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM alert_rules ORDER BY created_at ASC",
  ).all<AlertRuleRow>();
  return c.json({
    rules: (res.results ?? []).map(rowToAlertRule),
  });
});

app.post("/api/alerts/rules", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const metric = body.metric as AlertMetric;
  const operator = body.operator as AlertOperator;
  const threshold = Number(body.threshold);

  if (
    !name ||
    !VALID_METRICS.has(metric) ||
    !VALID_OPERATORS.has(operator) ||
    !Number.isFinite(threshold)
  ) {
    return c.json({ error: "Invalid alert rule fields" }, 400);
  }

  const nodeId =
    typeof body.node_id === "string" && body.node_id.trim().length > 0
      ? body.node_id.trim()
      : null;
  if (nodeId) {
    const node = await c.env.DB.prepare("SELECT id FROM nodes WHERE id = ?")
      .bind(nodeId)
      .first<{ id: string }>();
    if (!node) {
      return c.json({ error: "Referenced node not found" }, 404);
    }
  }

  const durationSec =
    typeof body.duration_sec === "number" && Number.isFinite(body.duration_sec)
      ? Math.max(0, Math.floor(body.duration_sec))
      : 120;
  const cooldownSec =
    typeof body.cooldown_sec === "number" && Number.isFinite(body.cooldown_sec)
      ? Math.max(0, Math.floor(body.cooldown_sec))
      : 3600;
  const channelIds = Array.isArray(body.channel_ids)
    ? body.channel_ids.filter(
        (cid): cid is string => typeof cid === "string" && cid.trim().length > 0,
      )
    : [];
  const enabled = body.enabled === false ? 0 : 1;
  const id = generateId("rule");
  const createdAt = Math.floor(Date.now() / 1000);
  const channelIdsJson = JSON.stringify(channelIds);

  await c.env.DB.prepare(
    `INSERT INTO alert_rules (
      id, name, node_id, metric, operator, threshold,
      duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      name,
      nodeId,
      metric,
      operator,
      threshold,
      durationSec,
      cooldownSec,
      channelIdsJson,
      enabled,
      createdAt,
    )
    .run();

  await pushAlertConfigToHub(c.env);

  const row: AlertRuleRow = {
    id,
    name,
    node_id: nodeId,
    metric,
    operator,
    threshold,
    duration_sec: durationSec,
    cooldown_sec: cooldownSec,
    channel_ids_json: channelIdsJson,
    enabled,
    created_at: createdAt,
  };
  return c.json({ rule: rowToAlertRule(row) }, 201);
});

app.patch("/api/alerts/rules/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM alert_rules WHERE id = ?")
    .bind(id)
    .first<AlertRuleRow>();
  if (!existing) {
    return c.json({ error: "Rule not found" }, 404);
  }

  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : existing.name;
  const metric =
    body.metric !== undefined && VALID_METRICS.has(body.metric as AlertMetric)
      ? (body.metric as AlertMetric)
      : existing.metric;
  const operator =
    body.operator !== undefined && VALID_OPERATORS.has(body.operator as AlertOperator)
      ? (body.operator as AlertOperator)
      : existing.operator;
  const threshold =
    typeof body.threshold === "number" && Number.isFinite(body.threshold)
      ? body.threshold
      : existing.threshold;
  const nodeId =
    body.node_id === null
      ? null
      : typeof body.node_id === "string" && body.node_id.trim().length > 0
        ? body.node_id.trim()
        : existing.node_id;
  const durationSec =
    typeof body.duration_sec === "number" && Number.isFinite(body.duration_sec)
      ? Math.max(0, Math.floor(body.duration_sec))
      : existing.duration_sec;
  const cooldownSec =
    typeof body.cooldown_sec === "number" && Number.isFinite(body.cooldown_sec)
      ? Math.max(0, Math.floor(body.cooldown_sec))
      : existing.cooldown_sec;
  const channelIdsJson = Array.isArray(body.channel_ids)
    ? JSON.stringify(
        body.channel_ids.filter(
          (cid): cid is string => typeof cid === "string" && cid.trim().length > 0,
        ),
      )
    : existing.channel_ids_json;
  const enabled =
    typeof body.enabled === "boolean"
      ? body.enabled
        ? 1
        : 0
      : existing.enabled;

  await c.env.DB.prepare(
    `UPDATE alert_rules SET
      name = ?, node_id = ?, metric = ?, operator = ?, threshold = ?,
      duration_sec = ?, cooldown_sec = ?, channel_ids_json = ?, enabled = ?
     WHERE id = ?`,
  )
    .bind(
      name,
      nodeId,
      metric,
      operator,
      threshold,
      durationSec,
      cooldownSec,
      channelIdsJson,
      enabled,
      id,
    )
    .run();

  await pushAlertConfigToHub(c.env);

  const updated: AlertRuleRow = {
    ...existing,
    name,
    node_id: nodeId,
    metric,
    operator,
    threshold,
    duration_sec: durationSec,
    cooldown_sec: cooldownSec,
    channel_ids_json: channelIdsJson,
    enabled,
  };
  return c.json({ rule: rowToAlertRule(updated) });
});

app.delete("/api/alerts/rules/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT id FROM alert_rules WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ error: "Rule not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM alert_rules WHERE id = ?").bind(id).run();
  await pushAlertConfigToHub(c.env);
  return c.json({ ok: true });
});

app.post("/api/alerts/rules/presets", async (c) => {
  const body = (await parseJson<{ channel_ids?: unknown }>(c)) ?? {};
  const channelIds = Array.isArray(body.channel_ids)
    ? body.channel_ids.filter(
        (cid): cid is string => typeof cid === "string" && cid.trim().length > 0,
      )
    : [];
  const channelIdsJson = JSON.stringify(channelIds);
  const nowSec = Math.floor(Date.now() / 1000);

  const presets: Array<{
    id: string;
    name: string;
    metric: AlertMetric;
    operator: AlertOperator;
    threshold: number;
    duration_sec: number;
    cooldown_sec: number;
  }> = [
    {
      id: "preset_offline",
      name: "节点离线",
      metric: "offline",
      operator: "gt",
      threshold: 60,
      duration_sec: 0,
      cooldown_sec: 3600,
    },
    {
      id: "preset_cpu",
      name: "CPU 持续过高",
      metric: "cpu",
      operator: "gt",
      threshold: 90,
      duration_sec: 120,
      cooldown_sec: 3600,
    },
    {
      id: "preset_steal",
      name: "CPU Steal 异常",
      metric: "steal",
      operator: "gt",
      threshold: 15,
      duration_sec: 120,
      cooldown_sec: 3600,
    },
    {
      id: "preset_mem",
      name: "内存占用过高",
      metric: "mem",
      operator: "gt",
      threshold: 90,
      duration_sec: 120,
      cooldown_sec: 3600,
    },
    {
      id: "preset_disk",
      name: "磁盘空间不足",
      metric: "disk",
      operator: "gt",
      threshold: 90,
      duration_sec: 60,
      cooldown_sec: 3600,
    },
    {
      id: "preset_traffic_pct",
      name: "流量配额预警",
      metric: "traffic_pct",
      operator: "gte",
      threshold: 90,
      duration_sec: 0,
      cooldown_sec: 86400,
    },
  ];

  const existingRows = await c.env.DB.prepare(
    "SELECT id, metric FROM alert_rules WHERE node_id IS NULL",
  ).all<{ id: string; metric: string }>();
  const existingMetrics = new Set((existingRows.results ?? []).map((r) => r.metric));
  const existingIds = new Set((existingRows.results ?? []).map((r) => r.id));

  let createdCount = 0;
  for (const preset of presets) {
    if (existingIds.has(preset.id) || existingMetrics.has(preset.metric)) {
      continue;
    }
    await c.env.DB.prepare(
      `INSERT INTO alert_rules (
        id, name, node_id, metric, operator, threshold,
        duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
      .bind(
        preset.id,
        preset.name,
        preset.metric,
        preset.operator,
        preset.threshold,
        preset.duration_sec,
        preset.cooldown_sec,
        channelIdsJson,
        nowSec,
      )
      .run();
    createdCount += 1;
  }

  if (createdCount > 0) {
    await pushAlertConfigToHub(c.env);
  }

  const allRes = await c.env.DB.prepare(
    "SELECT * FROM alert_rules ORDER BY created_at ASC",
  ).all<AlertRuleRow>();

  return c.json(
    {
      created: createdCount,
      rules: (allRes.results ?? []).map(rowToAlertRule),
    },
    createdCount > 0 ? 201 : 200,
  );
});

app.get("/api/alerts/incidents", async (c) => {
  const nodeId = c.req.query("node_id");
  const status = c.req.query("status");
  const rawLimit = Number(c.req.query("limit") ?? 100);
  const rawOffset = Number(c.req.query("offset") ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 100;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (nodeId) {
    conditions.push("i.node_id = ?");
    bindings.push(nodeId);
  }
  if (status === "firing" || status === "resolved") {
    conditions.push("i.status = ?");
    bindings.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countQuery = `SELECT COUNT(*) AS cnt FROM alert_incidents i ${where}`;
  const listQuery = `
    SELECT i.*, n.name AS node_name, r.name AS rule_name, r.metric, r.operator, r.threshold
    FROM alert_incidents i
    LEFT JOIN nodes n ON n.id = i.node_id
    LEFT JOIN alert_rules r ON r.id = i.rule_id
    ${where}
    ORDER BY i.started_at DESC
    LIMIT ? OFFSET ?
  `;

  const countStmt = c.env.DB.prepare(countQuery);
  const listStmt = c.env.DB.prepare(listQuery);

  const [countRes, listRes] = await Promise.all([
    bindings.length > 0
      ? countStmt.bind(...bindings).first<{ cnt: number }>()
      : countStmt.first<{ cnt: number }>(),
    listStmt.bind(...bindings, limit, offset).all<Record<string, unknown>>(),
  ]);

  return c.json({
    incidents: listRes.results ?? [],
    total: Number(countRes?.cnt ?? 0),
  });
});

// ---- Direction A Control Plane Routes ----

app.get("/api/hub/status", async (c) => {
  const [hubStats, watchdog] = await Promise.all([
    getFleetHub(c.env).getHubStats(),
    getWatchdogStatusSummary(c.env.DB),
  ]);

  const payload: HubStatusResponse = {
    mode: "cloudflare-worker",
    version: WORKER_VERSION,
    connected_agents: hubStats.connectedAgents,
    total_nodes: hubStats.totalNodes,
    watchdog,
  };
  return c.json(payload);
});

app.get("/api/export/bundle", async (c) => {
  return c.json(await exportBundle(c.env));
});

app.post("/api/import/bundle", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid export bundle: nodes array is required" }, 400);
  }
  const res = await importBundle(c.env, body, { allowReceiveTicket: false });
  if (!res.ok) {
    return c.json({ error: res.error }, res.status);
  }
  return c.json(res.result);
});

app.post("/api/migration/ticket", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const res = await createMigrationTicket(c.env, body, c.req.url);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status);
  }
  return c.json(res.body);
});

app.post("/api/hub/migrate", async (c) => {
  const body = await parseJson<HubMigrateRequest>(c);
  if (!body || typeof body.target_url !== "string") {
    return c.json({ error: "target_url is required" }, 400);
  }

  const allowInsecureWs = Boolean(body.allow_insecure_ws);
  const isProd = isProductionCfAccessEnv(c.env);
  const targetValidation = normalizeAndValidateMigrationUrl(body.target_url, {
    allowInsecureWs,
    isProduction: isProd,
  });
  if (!targetValidation.ok) {
    return c.json({ error: targetValidation.error }, 400);
  }

  let normalizedFallback: string | undefined;
  if (typeof body.fallback_url === "string" && body.fallback_url.trim().length > 0) {
    const fallbackValidation = normalizeAndValidateMigrationUrl(body.fallback_url, {
      allowInsecureWs,
      isProduction: isProd,
    });
    if (!fallbackValidation.ok) {
      return c.json({ error: `Invalid fallback_url: ${fallbackValidation.error}` }, 400);
    }
    normalizedFallback = fallbackValidation.wsUrl;
  }

  const dispatch = await dispatchSignedMigration(c.env, {
    targetWsUrl: targetValidation.wsUrl,
    fallbackWsUrl: normalizedFallback,
    nodeIds: body.node_ids,
  });

  const resp: HubMigrateResponse = {
    ok: true,
    target_ws_url: targetValidation.wsUrl,
    epoch: dispatch.epoch,
    targeted: dispatch.targeted,
    dispatched: dispatch.dispatched,
  };
  return c.json(resp);
});

app.post("/api/hub/migrate-smart", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const res = await executeSmartMigration(c.env, body, c.req.url);
  if (!res.ok) {
    return c.json({ error: res.error }, res.status);
  }
  return c.json(res.body);
});

app.get("/api/watchdog/config", async (c) => {
  const [config, state] = await Promise.all([
    getWatchdogConfig(c.env.DB),
    getWatchdogState(c.env.DB),
  ]);
  return c.json({ config, state });
});

app.put("/api/watchdog/config", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (
    body.secret !== undefined &&
    typeof body.secret === "string" &&
    body.secret.trim().length > 0 &&
    body.secret.trim().length < 8
  ) {
    return c.json({ error: "Watchdog secret must be at least 8 characters" }, 400);
  }

  const [config, state] = await Promise.all([
    saveWatchdogConfig(c.env.DB, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      secret: typeof body.secret === "string" ? body.secret : undefined,
      rotate_secret: body.rotate_secret === true,
      timeout_sec: typeof body.timeout_sec === "number" ? body.timeout_sec : undefined,
      cooldown_sec: typeof body.cooldown_sec === "number" ? body.cooldown_sec : undefined,
      hub_label: typeof body.hub_label === "string" ? body.hub_label : undefined,
      channel_ids: Array.isArray(body.channel_ids)
        ? (body.channel_ids as string[])
        : undefined,
    }),
    getWatchdogState(c.env.DB),
  ]);

  return c.json({ config, state });
});

app.get("/api/agent-update/config", async (c) => {
  const [config, cached] = await Promise.all([
    getAgentUpdateConfig(c.env.DB),
    readCachedAgentRelease(c.env.DB),
  ]);
  return c.json({
    ok: true,
    config,
    latest_release: cached?.release ?? null,
    bundled_version: BUNDLED_AGENT_VERSION,
  });
});

app.put("/api/agent-update/config", async (c) => {
  const body = await parseJson<Record<string, unknown>>(c);
  if (!body || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let config;
  try {
    config = await saveAgentUpdateConfig(c.env.DB, body);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Invalid configuration" },
      400,
    );
  }
  const origin = new URL(c.req.url).origin;
  const cached = await readCachedAgentRelease(c.env.DB);
  await getFleetHub(c.env).syncAgentUpdateState({
    config,
    origin,
    clearReleaseCache: true,
  });
  return c.json({
    ok: true,
    config,
    latest_release: cached?.release ?? null,
    bundled_version: BUNDLED_AGENT_VERSION,
  });
});

app.post("/api/agent-update/check", async (c) => {
  const config = await getAgentUpdateConfig(c.env.DB);
  const origin = new URL(c.req.url).origin;
  const checked = await checkLatestAgentRelease(c.env, config, {
    requestOrigin: origin,
    force: true,
  });
  await getFleetHub(c.env).syncAgentUpdateState({
    config,
    origin,
    release: checked.release,
  });
  return c.json({
    ok: true,
    latest_release: checked.release,
    checked_at: checked.checked_at,
    bundled_version: BUNDLED_AGENT_VERSION,
    error: checked.error,
  });
});

app.post("/api/agent-update/trigger", async (c) => {
  let body: Record<string, unknown> = {};
  const rawText = await c.req.text();
  if (rawText.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
  }

  let nodeIds: string[] | undefined;
  if (body.node_ids !== undefined) {
    if (
      !Array.isArray(body.node_ids) ||
      !body.node_ids.every(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      )
    ) {
      return c.json(
        { error: "node_ids must be an array of non-empty node IDs" },
        400,
      );
    }
    nodeIds = [...new Set(body.node_ids.map((id) => id.trim()))];
  }
  const force = body.force === true;

  const config = await getAgentUpdateConfig(c.env.DB);
  const origin = new URL(c.req.url).origin;
  const checked = await checkLatestAgentRelease(c.env, config, {
    requestOrigin: origin,
  });
  if (!checked.release) {
    return c.json(
      { error: checked.error ?? "No verified agent release available" },
      409,
    );
  }

  const result = await getFleetHub(c.env).triggerAgentUpdates({
    release: checked.release,
    config,
    nodeIds,
    force,
    origin,
  });
  return c.json({ ok: true, ...result });
});

// Static frontend assets fallback for non-API requests.
app.all("*", async (c) => {
  if (c.env.ASSETS) {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404 || c.req.path.startsWith("/api/")) {
      return res;
    }
    const indexUrl = new URL("/index.html", c.req.url);
    return c.env.ASSETS.fetch(new Request(indexUrl.toString(), { method: "GET" }));
  }
  return c.json({ error: "Not found" }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runWatchdogCron(env.DB);
  },
};
