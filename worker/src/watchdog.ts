import { rowToNotificationChannel } from "./alert/engine";
import { deliverChannelNotification } from "./alert/telegram";
import { constantTimeEqual, generateRandomSecret, hmacSha256Hex } from "./crypto";
import type {
  HubWatchdogStatus,
  NotificationChannelRow,
  WatchdogConfig,
  WatchdogState,
} from "./types";

const CONFIG_KEY = "watchdog_config";
const STATE_KEY = "watchdog_state";
const PING_MAX_SKEW_SEC = 300;
export const DEFAULT_TIMEOUT_SEC = 900;

export function defaultWatchdogState(): WatchdogState {
  return {
    last_ping_ts: null,
    enabled_at: null,
    status: "ok",
    last_alert_ts: null,
    stale_since_ts: null,
  };
}

export async function readSettingJson<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db
    .prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  if (!row?.value) {
    return null;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function writeSettingJson(
  db: D1Database,
  key: string,
  value: unknown,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), nowSec)
    .run();
}

export async function getWatchdogConfig(db: D1Database): Promise<WatchdogConfig> {
  const existing = await readSettingJson<Partial<WatchdogConfig>>(db, CONFIG_KEY);
  if (existing && typeof existing.secret === "string" && existing.secret.length > 0) {
    return {
      enabled: Boolean(existing.enabled),
      secret: existing.secret,
      timeout_sec:
        typeof existing.timeout_sec === "number" && existing.timeout_sec >= 30
          ? Math.floor(existing.timeout_sec)
          : DEFAULT_TIMEOUT_SEC,
      cooldown_sec:
        typeof existing.cooldown_sec === "number" && existing.cooldown_sec >= 60
          ? Math.floor(existing.cooldown_sec)
          : 1800,
      hub_label:
        typeof existing.hub_label === "string" && existing.hub_label.trim().length > 0
          ? existing.hub_label.trim()
          : "Self-Hosted UniOB Hub",
      ...(Array.isArray(existing.channel_ids)
        ? {
            channel_ids: existing.channel_ids.filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0,
            ),
          }
        : {}),
    };
  }

  const created: WatchdogConfig = {
    enabled: false,
    secret: generateRandomSecret(),
    timeout_sec: DEFAULT_TIMEOUT_SEC,
    cooldown_sec: 1800,
    hub_label: "Self-Hosted UniOB Hub",
    channel_ids: [],
  };
  await writeSettingJson(db, CONFIG_KEY, created);
  return created;
}

export async function getWatchdogState(db: D1Database): Promise<WatchdogState> {
  const raw = await readSettingJson<Partial<WatchdogState>>(db, STATE_KEY);
  if (!raw) {
    return defaultWatchdogState();
  }
  const status = raw.status === "stale" ? "stale" : "ok";
  return {
    last_ping_ts: typeof raw.last_ping_ts === "number" ? raw.last_ping_ts : null,
    enabled_at: typeof raw.enabled_at === "number" ? raw.enabled_at : null,
    status,
    last_alert_ts: typeof raw.last_alert_ts === "number" ? raw.last_alert_ts : null,
    stale_since_ts: typeof raw.stale_since_ts === "number" ? raw.stale_since_ts : null,
    ...(raw.last_payload ? { last_payload: raw.last_payload } : {}),
  };
}

export async function saveWatchdogConfig(
  db: D1Database,
  patch: Partial<WatchdogConfig> & { rotate_secret?: boolean },
  nowSec = Math.floor(Date.now() / 1000),
): Promise<WatchdogConfig> {
  const current = await getWatchdogConfig(db);

  let nextSecret = current.secret;
  if (patch.rotate_secret) {
    nextSecret = generateRandomSecret();
  } else if (typeof patch.secret === "string" && patch.secret.trim().length >= 8) {
    nextSecret = patch.secret.trim();
  }

  const nextEnabled =
    patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled;
  const nextTimeout =
    typeof patch.timeout_sec === "number" && Number.isFinite(patch.timeout_sec)
      ? Math.max(30, Math.floor(patch.timeout_sec))
      : current.timeout_sec;
  const nextCooldown =
    typeof patch.cooldown_sec === "number" && Number.isFinite(patch.cooldown_sec)
      ? Math.max(60, Math.floor(patch.cooldown_sec))
      : current.cooldown_sec;
  const nextHubLabel =
    typeof patch.hub_label === "string" && patch.hub_label.trim().length > 0
      ? patch.hub_label.trim().slice(0, 120)
      : current.hub_label;
  const nextChannelIds = Array.isArray(patch.channel_ids)
    ? patch.channel_ids.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      )
    : (current.channel_ids ?? []);

  const next: WatchdogConfig = {
    enabled: nextEnabled,
    secret: nextSecret,
    timeout_sec: nextTimeout,
    cooldown_sec: nextCooldown,
    hub_label: nextHubLabel,
    channel_ids: nextChannelIds,
  };

  await writeSettingJson(db, CONFIG_KEY, next, nowSec);

  if (nextEnabled && !current.enabled) {
    const state = await getWatchdogState(db);
    if (state.enabled_at === null) {
      await writeSettingJson(
        db,
        STATE_KEY,
        {
          ...state,
          enabled_at: nowSec,
        },
        nowSec,
      );
    }
  }

  return next;
}

export async function getWatchdogStatusSummary(db: D1Database): Promise<HubWatchdogStatus> {
  const [config, state] = await Promise.all([
    getWatchdogConfig(db),
    getWatchdogState(db),
  ]);
  const summaryStatus: HubWatchdogStatus["status"] = !config.enabled
    ? "disabled"
    : state.last_ping_ts === null
      ? "waiting"
      : state.status === "stale"
        ? "stale"
        : "healthy";
  return {
    enabled: config.enabled,
    last_ping_ts: state.last_ping_ts,
    status: summaryStatus,
    timeout_sec: config.timeout_sec,
  };
}

export const getHubWatchdogStatus = getWatchdogStatusSummary;

async function dispatchWatchdogNotification(
  db: D1Database,
  config: WatchdogConfig,
  kind: "firing" | "resolved",
  valueText: string,
  triggerValue: number,
  nowSec: number,
  detailText?: string,
  durationSec = config.timeout_sec,
): Promise<void> {
  const rows = await db
    .prepare("SELECT * FROM notification_channels WHERE enabled = 1")
    .all<NotificationChannelRow>();
  const targetIds = config.channel_ids && config.channel_ids.length > 0
    ? new Set(config.channel_ids)
    : null;

  const channels = (rows.results ?? [])
    .filter((row) => (targetIds ? targetIds.has(row.id) : true))
    .map(rowToNotificationChannel);

  if (channels.length === 0) {
    return;
  }

  const hubLabel = detailText || config.hub_label || "Self-Hosted UniOB Hub";
  const payload = {
    kind,
    nodeId: "self-hosted-hub",
    nodeName: hubLabel,
    groupName: "掉线提醒",
    ruleId: "watchdog",
    ruleName: kind === "firing" ? "自建监控面板失联" : "自建监控面板已恢复连接",
    metric: "offline" as const,
    operator: "gt" as const,
    valueText,
    valueDetail: hubLabel,
    thresholdText: `${config.timeout_sec} 秒`,
    durationSec,
    triggerValue,
    threshold: config.timeout_sec,
    timestampSec: nowSec,
  };

  await Promise.allSettled(
    channels.map((channel) => deliverChannelNotification(channel, payload)),
  );
}

export interface WatchdogPingResult {
  statusCode: number;
  body: Record<string, unknown>;
}

/**
 * Verifies signed heartbeat pings from a self-hosted `uniob-hub` using
 * X-Watchdog-Timestamp and X-Watchdog-Signature (`HMAC-SHA256(secret, "${ts}:${rawBody}")`).
 */
export async function handleWatchdogPing(
  db: D1Database,
  request: Request,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<WatchdogPingResult> {
  const config = await getWatchdogConfig(db);
  if (!config.enabled) {
    return { statusCode: 403, body: { error: "Watchdog is disabled" } };
  }

  const tsHeader = request.headers.get("X-Watchdog-Timestamp")?.trim() ?? "";
  const sigHeader = request.headers.get("X-Watchdog-Signature")?.trim().toLowerCase() ?? "";
  if (!tsHeader || !sigHeader || !/^\d+$/.test(tsHeader)) {
    return {
      statusCode: 401,
      body: { error: "Missing or invalid watchdog signature headers" },
    };
  }

  const tsNum = Number(tsHeader);
  if (!Number.isSafeInteger(tsNum) || Math.abs(nowSec - tsNum) > PING_MAX_SKEW_SEC) {
    return { statusCode: 401, body: { error: "Watchdog timestamp outside replay window" } };
  }

  const rawBody = await request.text();
  const expectedSig = await hmacSha256Hex(`${tsHeader}:${rawBody}`, config.secret);
  if (!(await constantTimeEqual(expectedSig, sigHeader))) {
    return { statusCode: 401, body: { error: "Invalid watchdog HMAC signature" } };
  }

  let parsedBody: {
    hub_label?: unknown;
    version?: unknown;
    connected_agents?: unknown;
    total_nodes?: unknown;
  } = {};
  if (rawBody.trim().length > 0) {
    try {
      const json = JSON.parse(rawBody) as unknown;
      if (json && typeof json === "object") {
        parsedBody = json as typeof parsedBody;
      }
    } catch {
      return { statusCode: 400, body: { error: "Invalid JSON payload" } };
    }
  }

  const prevState = await getWatchdogState(db);
  const hubPayload = {
    ...(typeof parsedBody.hub_label === "string"
      ? { hub_label: parsedBody.hub_label }
      : {}),
    ...(typeof parsedBody.version === "string" ? { version: parsedBody.version } : {}),
    ...(typeof parsedBody.connected_agents === "number"
      ? { connected_agents: parsedBody.connected_agents }
      : {}),
    ...(typeof parsedBody.total_nodes === "number"
      ? { total_nodes: parsedBody.total_nodes }
      : {}),
  };

  const nextState: WatchdogState = {
    last_ping_ts: nowSec,
    enabled_at: prevState.enabled_at ?? nowSec,
    status: "ok",
    last_alert_ts: prevState.last_alert_ts,
    stale_since_ts: null,
    ...(Object.keys(hubPayload).length > 0
      ? { last_payload: hubPayload }
      : prevState.last_payload
        ? { last_payload: prevState.last_payload }
        : {}),
  };
  await writeSettingJson(db, STATE_KEY, nextState, nowSec);

  if (prevState.status === "stale") {
    const outageDuration =
      prevState.stale_since_ts !== null ? Math.max(0, nowSec - prevState.stale_since_ts) : 0;
    await dispatchWatchdogNotification(
      db,
      config,
      "resolved",
      "自建监控面板已恢复连接",
      0,
      nowSec,
      hubPayload.hub_label ?? config.hub_label,
      outageDuration,
    );
  }

  return {
    statusCode: 200,
    body: { ok: true, status: "ok", ts: nowSec },
  };
}

export async function runWatchdogCron(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ checked: boolean; status: WatchdogState["status"] | "waiting"; alerted: boolean }> {
  const [config, state] = await Promise.all([
    getWatchdogConfig(db),
    getWatchdogState(db),
  ]);

  if (!config.enabled) {
    return { checked: false, status: state.status, alerted: false };
  }

  if (state.last_ping_ts === null) {
    return { checked: true, status: "waiting", alerted: false };
  }

  const ageSec = nowSec - state.last_ping_ts;
  if (ageSec <= config.timeout_sec) {
    return { checked: true, status: state.status, alerted: false };
  }

  const cooldownElapsed =
    state.last_alert_ts === null || nowSec - state.last_alert_ts >= config.cooldown_sec;
  const shouldAlert = state.status !== "stale" || cooldownElapsed;

  const nextState: WatchdogState = {
    ...state,
    status: "stale",
    stale_since_ts: state.stale_since_ts ?? nowSec,
    last_alert_ts: shouldAlert ? nowSec : state.last_alert_ts,
  };
  await writeSettingJson(db, STATE_KEY, nextState, nowSec);

  if (shouldAlert) {
    await dispatchWatchdogNotification(
      db,
      config,
      "firing",
      `超过 ${ageSec} 秒未收到心跳（超时 ${config.timeout_sec} 秒）`,
      ageSec,
      nowSec,
      state.last_payload?.hub_label ?? config.hub_label,
      config.timeout_sec,
    );
  }

  return { checked: true, status: "stale", alerted: shouldAlert };
}
