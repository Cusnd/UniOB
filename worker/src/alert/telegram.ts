import { hmacSha256Hex } from "../crypto";
import type {
  AlertMetric,
  AlertOperator,
  NotificationChannel,
  TelegramChannelConfig,
  WebhookChannelConfig,
} from "../types";

export interface NotificationAlertPayload {
  kind: "firing" | "resolved";
  nodeId: string;
  nodeName: string;
  groupName: string;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric | string;
  operator: AlertOperator;
  valueText: string;
  valueDetail?: string;
  thresholdText: string;
  durationSec: number; // for firing: rule.duration_sec; for resolved: outage duration
  triggerValue: number | null;
  threshold: number;
  timestampSec: number;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatUtcPlus8(tsSec: number): string {
  const shifted = new Date((tsSec + 8 * 3600) * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  const sec = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${min}:${sec} UTC+8`;
}

export function formatDurationZh(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  if (sec < 60) {
    return `${sec} 秒`;
  }
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m} 分 ${s} 秒`;
  }
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h} 小时 ${m} 分 ${s} 秒`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d} 天 ${h} 小时 ${m} 分`;
}

export function formatTelegramAlertHtml(payload: NotificationAlertPayload): string {
  const nodeName = escapeHtml(payload.nodeName || payload.nodeId);
  const groupName = escapeHtml(payload.groupName || "Default");
  const ruleName = escapeHtml(payload.ruleName);
  const valueText = escapeHtml(payload.valueText);
  const detailSuffix = payload.valueDetail ? ` (${escapeHtml(payload.valueDetail)})` : "";
  const timeStr = formatUtcPlus8(payload.timestampSec);

  if (payload.kind === "firing") {
    const opSymbol = payload.operator === "gte" ? "&gt;=" : "&gt;";
    const thresholdStr = escapeHtml(payload.thresholdText);
    const conditionStr =
      payload.metric === "offline"
        ? `断连超过 ${thresholdStr}`
        : payload.durationSec > 0
          ? `${opSymbol} ${thresholdStr} 持续 ${payload.durationSec}s`
          : `${opSymbol} ${thresholdStr}`;

    return [
      "🚨 <b>[UniOB 告警触发]</b>",
      `<b>节点：</b>${nodeName} (<code>${groupName}</code>)`,
      `<b>项目：</b>${ruleName}`,
      `<b>当前值：</b><code>${valueText}</code>${detailSuffix}`,
      `<b>触发条件：</b>${conditionStr}`,
      `<b>时间：</b>${timeStr}`,
    ].join("\n");
  }

  const projectLabel =
    payload.metric === "offline" ? `${ruleName} · 🟢 节点已恢复上线` : `${ruleName} 已恢复正常`;
  return [
    "✅ <b>[UniOB 故障恢复]</b>",
    `<b>节点：</b>${nodeName} (<code>${groupName}</code>)`,
    `<b>项目：</b>${projectLabel}`,
    `<b>当前值：</b><code>${valueText}</code>${detailSuffix}`,
    `<b>故障历时：</b>${formatDurationZh(payload.durationSec)}`,
    `<b>时间：</b>${timeStr}`,
  ].join("\n");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 250;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const sleepImpl = options?.sleepImpl ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchImpl(url, init);
      if (resp.ok) {
        return resp;
      }
      const retryable = resp.status === 429 || resp.status >= 500;
      if (!retryable || attempt === maxRetries) {
        return resp;
      }
      let delayMs = baseDelayMs * Math.pow(2, attempt);
      if (resp.status === 429) {
        const retryAfter = Number.parseFloat(resp.headers.get("Retry-After") ?? "");
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          delayMs = Math.min(5_000, Math.max(delayMs, retryAfter * 1000));
        }
      }
      try {
        await resp.body?.cancel();
      } catch {
        // ignore cancel errors
      }
      await sleepImpl(delayMs);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) {
        throw err;
      }
      await sleepImpl(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}

export async function sendTelegramHtml(
  config: TelegramChannelConfig,
  htmlText: string,
  options?: RetryOptions,
): Promise<{ ok: boolean; error?: string }> {
  const endpoint = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: config.chat_id,
    text: htmlText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (config.thread_id !== undefined && config.thread_id !== null) {
    body.message_thread_id = config.thread_id;
  }

  try {
    const resp = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      options,
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Telegram HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Telegram request failed",
    };
  }
}

export async function sendWebhookJson(
  config: WebhookChannelConfig,
  payload: Record<string, unknown>,
  options?: RetryOptions,
): Promise<{ ok: boolean; error?: string }> {
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "UniOB-Worker/1.0",
  };
  if (config.secret) {
    headers["X-UniOB-Signature"] = `sha256=${await hmacSha256Hex(rawBody, config.secret)}`;
  }

  try {
    const resp = await fetchWithRetry(
      config.url,
      {
        method: "POST",
        headers,
        body: rawBody,
      },
      options,
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Webhook HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Webhook request failed",
    };
  }
}

export async function deliverChannelNotification(
  channel: NotificationChannel,
  payload: NotificationAlertPayload,
  options?: RetryOptions,
): Promise<{ ok: boolean; error?: string }> {
  if (!channel.enabled) {
    return { ok: true };
  }
  if (channel.type === "telegram") {
    const html = formatTelegramAlertHtml(payload);
    return sendTelegramHtml(channel.config as TelegramChannelConfig, html, options);
  }
  const webhookPayload = {
    event: payload.kind === "firing" ? "alert.firing" : "alert.resolved",
    node_id: payload.nodeId,
    node_name: payload.nodeName,
    group_name: payload.groupName,
    rule_id: payload.ruleId,
    rule_name: payload.ruleName,
    metric: payload.metric,
    operator: payload.operator,
    value: payload.triggerValue,
    value_text: payload.valueText,
    threshold: payload.threshold,
    duration_sec: payload.durationSec,
    timestamp: payload.timestampSec,
    message: `${payload.ruleName}: ${payload.valueText}${payload.valueDetail ? ` (${payload.valueDetail})` : ""}`,
  };
  return sendWebhookJson(channel.config as WebhookChannelConfig, webhookPayload, options);
}

export const dispatchNotification = deliverChannelNotification;

export async function sendTestNotification(
  channel: NotificationChannel,
  options?: RetryOptions,
): Promise<{ ok: boolean; error?: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (channel.type === "telegram") {
    const html = [
      "🔔 <b>[UniOB 测试通知]</b>",
      `<b>渠道：</b>${escapeHtml(channel.name)}`,
      "<b>状态：</b>通知链路测试成功",
      `<b>时间：</b>${formatUtcPlus8(nowSec)}`,
    ].join("\n");
    return sendTelegramHtml(channel.config as TelegramChannelConfig, html, options);
  }
  return sendWebhookJson(
    channel.config as WebhookChannelConfig,
    {
      event: "alert.test",
      channel_id: channel.id,
      channel_name: channel.name,
      timestamp: nowSec,
      message: "UniOB webhook test notification",
    },
    options,
  );
}
