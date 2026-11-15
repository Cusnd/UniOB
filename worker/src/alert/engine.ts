import { generateId } from "../crypto";
import type {
  AlertMetric,
  AlertOperator,
  AlertRule,
  AlertRuleRow,
  NodeMetricsPayload,
  NodeTrafficSummary,
  NotificationChannel,
  NotificationChannelRow,
} from "../types";
import {
  dispatchNotification,
  type NotificationAlertPayload,
  type RetryOptions,
} from "./telegram";

export type AlertRuleMachineState = "OK" | "PENDING" | "FIRING";

export type AlertRuleRuntimeState = {
  rule_id: string;
  state: AlertRuleMachineState;
  first_breach_ts: number | null;
  last_notified_ts: number | null;
  recover_ok_count: number;
  incident_id: string | null;
  started_at: number | null;
};

export interface EvaluatedMetricReading {
  value: number;
  valueText: string;
  valueDetail?: string;
}

export interface RuleStepDecision {
  nextState: AlertRuleRuntimeState;
  action: "none" | "fire" | "renotify" | "resolve";
  changed: boolean;
  resolvedDurationSec?: number;
  incidentId?: string;
}

export interface AlertEvaluationContext {
  nodeId: string;
  nodeName: string;
  groupName: string;
  muteUntil: number | null;
  memTotalBytes: number | null;
  swapTotalBytes: number | null;
  traffic: NodeTrafficSummary;
  metrics: NodeMetricsPayload;
  nowSec: number;
}

export function computeRecoveryThreshold(threshold: number): number {
  if (threshold > 0.5) {
    return Math.min(threshold * 0.95, threshold - 0.5);
  }
  return threshold * 0.95;
}

export function isThresholdBreached(
  value: number,
  operator: AlertOperator,
  threshold: number,
): boolean {
  return operator === "gte" ? value >= threshold : value > threshold;
}

export function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024;
  let unitIdx = 0;
  while (val >= 1024 && unitIdx < units.length - 1) {
    val /= 1024;
    unitIdx += 1;
  }
  return `${val >= 100 ? val.toFixed(0) : val.toFixed(1)} ${units[unitIdx]}`;
}

export function extractMetricReading(
  metric: AlertMetric,
  ctx: AlertEvaluationContext,
): EvaluatedMetricReading | null {
  switch (metric) {
    case "cpu": {
      const val = ctx.metrics.cpu.all;
      return {
        value: val,
        valueText: `${val.toFixed(1)}%`,
        valueDetail: `Load ${(ctx.metrics.cpu.load[0] ?? 0).toFixed(2)}`,
      };
    }
    case "steal": {
      const val = ctx.metrics.cpu.steal;
      return {
        value: val,
        valueText: `${val.toFixed(1)}%`,
      };
    }
    case "mem": {
      const total =
        ctx.memTotalBytes && ctx.memTotalBytes > 0
          ? ctx.memTotalBytes
          : ctx.metrics.mem.used + ctx.metrics.mem.avail;
      if (total <= 0) {
        return null;
      }
      const val = (ctx.metrics.mem.used / total) * 100;
      return {
        value: val,
        valueText: `${val.toFixed(1)}%`,
        valueDetail: `${formatBytesCompact(ctx.metrics.mem.used)} / ${formatBytesCompact(total)}`,
      };
    }
    case "swap": {
      const total = ctx.swapTotalBytes ?? 0;
      if (total <= 0) {
        return null;
      }
      const val = (ctx.metrics.mem.swap_used / total) * 100;
      return {
        value: val,
        valueText: `${val.toFixed(1)}%`,
        valueDetail: `${formatBytesCompact(ctx.metrics.mem.swap_used)} / ${formatBytesCompact(total)}`,
      };
    }
    case "disk": {
      let maxPct = -1;
      let maxDisk: { mp: string; used: number; total: number } | null = null;
      for (const d of ctx.metrics.disks) {
        if (d.total > 0) {
          const pct = (d.used / d.total) * 100;
          if (pct > maxPct) {
            maxPct = pct;
            maxDisk = d;
          }
        }
      }
      if (!maxDisk || maxPct < 0) {
        return null;
      }
      return {
        value: maxPct,
        valueText: `${maxPct.toFixed(1)}%`,
        valueDetail: `${maxDisk.mp} ${formatBytesCompact(maxDisk.used)} / ${formatBytesCompact(maxDisk.total)}`,
      };
    }
    case "traffic_pct": {
      const limit = ctx.traffic.limit_bytes;
      if (!limit || limit <= 0) {
        return null;
      }
      const val = (ctx.traffic.counted_bytes / limit) * 100;
      return {
        value: val,
        valueText: `${val.toFixed(1)}%`,
        valueDetail: `${formatBytesCompact(ctx.traffic.counted_bytes)} / ${formatBytesCompact(limit)}`,
      };
    }
    case "offline":
      return null;
  }
}

export function evaluateRuleStep(
  rule: Pick<AlertRule, "id" | "operator" | "threshold" | "duration_sec" | "cooldown_sec">,
  current: AlertRuleRuntimeState | undefined,
  value: number,
  nowSec: number,
): RuleStepDecision {
  const prev: AlertRuleRuntimeState = current ?? {
    rule_id: rule.id,
    state: "OK",
    first_breach_ts: null,
    last_notified_ts: null,
    recover_ok_count: 0,
    incident_id: null,
    started_at: null,
  };

  const breached = isThresholdBreached(value, rule.operator, rule.threshold);

  if (prev.state === "OK") {
    if (!breached) {
      return { nextState: prev, action: "none", changed: false };
    }
    if (rule.duration_sec <= 0) {
      const incidentId = generateId("inc");
      return {
        nextState: {
          rule_id: rule.id,
          state: "FIRING",
          first_breach_ts: nowSec,
          last_notified_ts: nowSec,
          recover_ok_count: 0,
          incident_id: incidentId,
          started_at: nowSec,
        },
        action: "fire",
        changed: true,
        incidentId,
      };
    }
    return {
      nextState: {
        rule_id: rule.id,
        state: "PENDING",
        first_breach_ts: nowSec,
        last_notified_ts: null,
        recover_ok_count: 0,
        incident_id: null,
        started_at: null,
      },
      action: "none",
      changed: true,
    };
  }

  if (prev.state === "PENDING") {
    if (!breached) {
      return {
        nextState: {
          rule_id: rule.id,
          state: "OK",
          first_breach_ts: null,
          last_notified_ts: null,
          recover_ok_count: 0,
          incident_id: null,
          started_at: null,
        },
        action: "none",
        changed: true,
      };
    }
    const firstBreach = prev.first_breach_ts ?? nowSec;
    if (nowSec - firstBreach >= rule.duration_sec) {
      const incidentId = generateId("inc");
      return {
        nextState: {
          rule_id: rule.id,
          state: "FIRING",
          first_breach_ts: firstBreach,
          last_notified_ts: nowSec,
          recover_ok_count: 0,
          incident_id: incidentId,
          started_at: nowSec,
        },
        action: "fire",
        changed: true,
        incidentId,
      };
    }
    return { nextState: prev, action: "none", changed: false };
  }

  // prev.state === "FIRING"
  const recoveryThreshold = computeRecoveryThreshold(rule.threshold);
  if (value < recoveryThreshold) {
    const nextRecoverCount = prev.recover_ok_count + 1;
    if (nextRecoverCount >= 2) {
      const startedAt = prev.started_at ?? nowSec;
      const resolvedDurationSec = Math.max(0, nowSec - startedAt);
      const incidentId = prev.incident_id ?? undefined;
      return {
        nextState: {
          rule_id: rule.id,
          state: "OK",
          first_breach_ts: null,
          last_notified_ts: null,
          recover_ok_count: 0,
          incident_id: null,
          started_at: null,
        },
        action: "resolve",
        changed: true,
        resolvedDurationSec,
        incidentId,
      };
    }
    return {
      nextState: {
        ...prev,
        recover_ok_count: nextRecoverCount,
      },
      action: "none",
      changed: true,
    };
  }

  // Value is >= recoveryThreshold
  let nextRecoverCount = prev.recover_ok_count;
  let changed = false;
  if (nextRecoverCount !== 0) {
    nextRecoverCount = 0;
    changed = true;
  }

  if (
    breached &&
    rule.cooldown_sec > 0 &&
    nowSec - (prev.last_notified_ts ?? 0) >= rule.cooldown_sec
  ) {
    return {
      nextState: {
        ...prev,
        recover_ok_count: 0,
        last_notified_ts: nowSec,
      },
      action: "renotify",
      changed: true,
      incidentId: prev.incident_id ?? undefined,
    };
  }

  return {
    nextState: changed ? { ...prev, recover_ok_count: 0 } : prev,
    action: "none",
    changed,
  };
}

export function rowToAlertRule(row: AlertRuleRow): AlertRule {
  let channelIds: string[] = [];
  try {
    const parsed = JSON.parse(row.channel_ids_json);
    if (Array.isArray(parsed)) {
      channelIds = parsed.filter((id): id is string => typeof id === "string");
    }
  } catch {
    channelIds = [];
  }
  return {
    id: row.id,
    name: row.name,
    node_id: row.node_id,
    metric: row.metric,
    operator: row.operator,
    threshold: row.threshold,
    duration_sec: row.duration_sec,
    cooldown_sec: row.cooldown_sec,
    channel_ids: channelIds,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
  };
}

export function rowToNotificationChannel(
  row: NotificationChannelRow,
): NotificationChannel {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config_json);
    if (parsed && typeof parsed === "object") {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: Boolean(row.enabled),
    config: config as unknown as NotificationChannel["config"],
    created_at: row.created_at,
  };
}

export async function loadNodeRulesAndChannels(
  db: D1Database,
  nodeId: string,
): Promise<{ rules: AlertRule[]; channelsById: Map<string, NotificationChannel> }> {
  const [ruleRes, channelRes] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM alert_rules WHERE enabled = 1 AND (node_id IS NULL OR node_id = ?) ORDER BY created_at ASC",
      )
      .bind(nodeId)
      .all<AlertRuleRow>(),
    db
      .prepare("SELECT * FROM notification_channels WHERE enabled = 1")
      .all<NotificationChannelRow>(),
  ]);

  const rules = (ruleRes.results ?? []).map(rowToAlertRule);
  const channelsById = new Map<string, NotificationChannel>();
  for (const row of channelRes.results ?? []) {
    const ch = rowToNotificationChannel(row);
    channelsById.set(ch.id, ch);
  }
  return { rules, channelsById };
}

export function isNodeMuted(muteUntil: number | null, nowSec: number): boolean {
  return muteUntil !== null && muteUntil > nowSec;
}

export async function notifyChannels(
  channelsById: Map<string, NotificationChannel>,
  channelIds: string[],
  payload: NotificationAlertPayload,
  muteUntil: number | null,
  retryOptions?: RetryOptions,
): Promise<void> {
  if (isNodeMuted(muteUntil, payload.timestampSec)) {
    return;
  }
  const tasks: Promise<unknown>[] = [];
  for (const id of channelIds) {
    const channel = channelsById.get(id);
    if (channel && channel.enabled) {
      tasks.push(dispatchNotification(channel, payload, retryOptions));
    }
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

export function formatRuleThresholdText(metric: AlertMetric, threshold: number): string {
  if (metric === "offline") {
    return `${threshold}s`;
  }
  return `${threshold}%`;
}

export async function recordIncidentFiring(
  db: D1Database,
  params: {
    incidentId: string;
    nodeId: string;
    nodeName: string;
    ruleId: string;
    metric: AlertMetric;
    triggerValue: number | null;
    threshold: number;
    message: string;
    startedAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_incidents (
        id, node_id, node_name, rule_id, metric, status,
        trigger_value, threshold, message, started_at, resolved_at, last_notified_at
      ) VALUES (?, ?, ?, ?, ?, 'firing', ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      params.incidentId,
      params.nodeId,
      params.nodeName,
      params.ruleId,
      params.metric,
      params.triggerValue,
      params.threshold,
      params.message,
      params.startedAt,
      params.startedAt,
    )
    .run();
}

export async function recordIncidentRenotify(
  db: D1Database,
  incidentId: string,
  nowSec: number,
): Promise<void> {
  await db
    .prepare("UPDATE alert_incidents SET last_notified_at = ? WHERE id = ?")
    .bind(nowSec, incidentId)
    .run();
}

export async function recordIncidentResolved(
  db: D1Database,
  incidentId: string,
  resolvedAt: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE alert_incidents SET status = 'resolved', resolved_at = ? WHERE id = ?",
    )
    .bind(resolvedAt, incidentId)
    .run();
}

export async function countFiringAlerts(db: D1Database): Promise<number> {
  const res = await db
    .prepare("SELECT COUNT(*) AS cnt FROM alert_incidents WHERE status = 'firing'")
    .first<{ cnt: number }>();
  return Number(res?.cnt ?? 0);
}
