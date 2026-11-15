import { useCallback, useEffect, useId, useState } from "react";
import {
  Bell,
  CheckCircle2,
  Edit3,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import type {
  AlertIncident,
  AlertMetric,
  AlertOperator,
  AlertRule,
  NodeSummary,
  NotificationChannel,
} from "../types";
import { api } from "../api/client";
import {
  formatAlertCondition,
  formatAlertMetric,
  formatAlertStatus,
  formatDurationZh,
  formatTimestamp,
} from "../utils/format";

interface AlertsConfigProps {
  nodes: NodeSummary[];
  alertVersion: number;
  onActiveAlertsSync?: (count: number) => void;
}

const METRIC_LABELS: Record<AlertMetric, string> = {
  offline: "服务器离线时长 (秒)",
  cpu: "处理器占用 (%)",
  steal: "CPU 宿主机争抢 (%)",
  mem: "内存占用 (%)",
  swap: "虚拟内存占用 (%)",
  disk: "磁盘空间占用 (%)",
  traffic_pct: "月流量使用率 (%)",
};

export function AlertsConfig({
  nodes,
  alertVersion,
  onActiveAlertsSync,
}: AlertsConfigProps) {
  const formId = useId();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [incidents, setIncidents] = useState<AlertIncident[]>([]);
  const [incidentsTotal, setIncidentsTotal] = useState(0);
  const [incidentFilter, setIncidentFilter] = useState<
    "all" | "firing" | "resolved"
  >("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Channel form state
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [chName, setChName] = useState("我的运维 TG 机器人");
  const [chType, setChType] = useState<"telegram" | "webhook">("telegram");
  const [chBotToken, setChBotToken] = useState("");
  const [chChatId, setChChatId] = useState("");
  const [chThreadId, setChThreadId] = useState("");
  const [chUrl, setChUrl] = useState("");
  const [chSecret, setChSecret] = useState("");
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);

  // Rule form state
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleNodeId, setRuleNodeId] = useState<string>("__ALL__");
  const [ruleMetric, setRuleMetric] = useState<AlertMetric>("cpu");
  const [ruleOperator, setRuleOperator] = useState<AlertOperator>("gt");
  const [ruleThreshold, setRuleThreshold] = useState("90");
  const [ruleDuration, setRuleDuration] = useState("120");
  const [ruleCooldown, setRuleCooldown] = useState("3600");
  const [ruleChannelIds, setRuleChannelIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(
    async (statusFilter: "all" | "firing" | "resolved" = incidentFilter) => {
      setLoading(true);
      setError(null);
      try {
        const [chRes, ruleRes, incRes] = await Promise.all([
          api.getChannels(),
          api.getRules(),
          api.getIncidents({ status: statusFilter, limit: 50, offset: 0 }),
        ]);
        const nextChannels = Array.isArray(chRes?.channels) ? chRes.channels : [];
        const nextRules = Array.isArray(ruleRes?.rules) ? ruleRes.rules : [];
        const nextIncidents = Array.isArray(incRes?.incidents)
          ? incRes.incidents
          : [];
        setChannels(nextChannels);
        setRules(nextRules);
        setIncidents(nextIncidents);
        setIncidentsTotal(
          typeof incRes?.total === "number" ? incRes.total : nextIncidents.length,
        );
        if (onActiveAlertsSync && statusFilter === "all") {
          const firingCount = nextIncidents.filter(
            (i) => i.status === "firing",
          ).length;
          onActiveAlertsSync(firingCount);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载告警配置失败");
      } finally {
        setLoading(false);
      }
    },
    [incidentFilter, onActiveAlertsSync],
  );

  useEffect(() => {
    void loadAll(incidentFilter);
  }, [loadAll, incidentFilter, alertVersion]);

  const showSuccess = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };

  const openNewChannelForm = () => {
    setEditingChannelId(null);
    setChName("我的运维 TG 机器人");
    setChType("telegram");
    setChBotToken("");
    setChChatId("");
    setChThreadId("");
    setChUrl("");
    setChSecret("");
    setShowChannelForm(true);
  };

  const openEditChannelForm = (ch: NotificationChannel) => {
    setEditingChannelId(ch.id);
    setChName(ch.name);
    setChType(ch.type);
    setChBotToken(ch.config.bot_token ?? "");
    setChChatId(ch.config.chat_id ?? "");
    setChThreadId(
      ch.config.thread_id !== null && ch.config.thread_id !== undefined
        ? String(ch.config.thread_id)
        : "",
    );
    setChUrl(ch.config.url ?? "");
    setChSecret(ch.config.secret ?? "");
    setShowChannelForm(true);
  };

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const config =
        chType === "telegram"
          ? {
              bot_token: chBotToken.trim(),
              chat_id: chChatId.trim(),
              thread_id: chThreadId.trim()
                ? Number.parseInt(chThreadId.trim(), 10)
                : null,
            }
          : {
              url: chUrl.trim(),
              secret: chSecret.trim() || undefined,
            };

      const name =
        chName.trim() || (chType === "telegram" ? "Telegram Bot" : "Webhook");

      if (editingChannelId) {
        const res = await api.updateChannel(editingChannelId, {
          name,
          type: chType,
          config,
        });
        setChannels((prev) =>
          prev.map((c) => (c.id === editingChannelId ? res.channel : c)),
        );
        showSuccess(`已更新通知渠道「${res.channel.name}」`);
      } else {
        const res = await api.createChannel({
          name,
          type: chType,
          enabled: true,
          config,
        });
        setChannels((prev) => [res.channel, ...prev]);
        showSuccess(`已添加通知渠道「${res.channel.name}」`);
      }

      setShowChannelForm(false);
      setEditingChannelId(null);
      setChBotToken("");
      setChChatId("");
      setChThreadId("");
      setChUrl("");
      setChSecret("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存渠道失败");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleChannel = async (ch: NotificationChannel) => {
    try {
      const res = await api.updateChannel(ch.id, { enabled: !ch.enabled });
      setChannels((prev) => prev.map((c) => (c.id === ch.id ? res.channel : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新渠道失败");
    }
  };

  const handleDeleteChannel = async (id: string) => {
    try {
      await api.deleteChannel(id);
      setChannels((prev) => prev.filter((c) => c.id !== id));
      showSuccess("通知渠道已删除");
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除渠道失败");
    }
  };

  const handleTestChannel = async (ch: NotificationChannel) => {
    setTestingChannelId(ch.id);
    setError(null);
    try {
      const res = await api.testChannel(ch.id);
      if (res.ok) {
        showSuccess(`测试通知已发送至「${ch.name}」`);
      } else {
        setError(res.error || "发送测试通知失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送测试通知失败");
    } finally {
      setTestingChannelId(null);
    }
  };

  const handleApplyPresets = async () => {
    const targetIds = channels.filter((c) => c.enabled).map((c) => c.id);
    if (targetIds.length === 0 && channels.length > 0) {
      targetIds.push(channels[0].id);
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.applyRulePresets(targetIds);
      setRules(res.rules);
      showSuccess("已启用默认推荐告警规则模板（离线、CPU、Steal、内存、磁盘、月流量）");
    } catch (err) {
      setError(err instanceof Error ? err.message : "应用模板失败");
    } finally {
      setSaving(false);
    }
  };

  const openNewRuleForm = () => {
    setEditingRuleId(null);
    setRuleName("");
    setRuleNodeId("__ALL__");
    setRuleMetric("cpu");
    setRuleOperator("gt");
    setRuleThreshold("90");
    setRuleDuration("120");
    setRuleCooldown("3600");
    setRuleChannelIds(channels.filter((c) => c.enabled).map((c) => c.id));
    setShowRuleForm(true);
  };

  const openEditRuleForm = (rule: AlertRule) => {
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleNodeId(rule.node_id ?? "__ALL__");
    setRuleMetric(rule.metric);
    setRuleOperator(rule.operator);
    setRuleThreshold(String(rule.threshold));
    setRuleDuration(String(rule.duration_sec));
    setRuleCooldown(String(rule.cooldown_sec));
    setRuleChannelIds(rule.channel_ids);
    setShowRuleForm(true);
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const targetChannels =
        ruleChannelIds.length > 0
          ? ruleChannelIds
          : channels.filter((c) => c.enabled).map((c) => c.id);
      const payload = {
        name:
          ruleName.trim() ||
          `${METRIC_LABELS[ruleMetric]} ${ruleOperator === "gte" ? ">=" : ">"} ${ruleThreshold}`,
        node_id: ruleNodeId === "__ALL__" ? null : ruleNodeId,
        metric: ruleMetric,
        operator: ruleOperator,
        threshold: Number(ruleThreshold) || 0,
        duration_sec: Math.max(0, Number.parseInt(ruleDuration, 10) || 0),
        cooldown_sec: Math.max(60, Number.parseInt(ruleCooldown, 10) || 3600),
        channel_ids: targetChannels,
      };

      if (editingRuleId) {
        const res = await api.updateRule(editingRuleId, payload);
        setRules((prev) =>
          prev.map((r) => (r.id === editingRuleId ? res.rule : r)),
        );
        showSuccess(`已更新告警规则「${res.rule.name}」`);
      } else {
        const res = await api.createRule({
          ...payload,
          enabled: true,
        });
        setRules((prev) => [res.rule, ...prev]);
        showSuccess(`已创建告警规则「${res.rule.name}」`);
      }

      setShowRuleForm(false);
      setEditingRuleId(null);
      setRuleName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存规则失败");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleRule = async (rule: AlertRule) => {
    try {
      const res = await api.updateRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? res.rule : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新规则失败");
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await api.deleteRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除规则失败");
    }
  };

  const toggleRuleChannel = (id: string) => {
    setRuleChannelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
            告警规则与通知
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            配置 Telegram 或 Webhook 通知方式，设置服务器告警条件，并查看历史告警记录。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadAll(incidentFilter)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          刷新状态
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          {notice}
        </div>
      )}

      {/* 1. Notification Channels */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-sky-500" aria-hidden="true" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              通知渠道 (Telegram / Webhook)
            </h3>
          </div>
          <button
            type="button"
            onClick={() => (showChannelForm ? setShowChannelForm(false) : openNewChannelForm())}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            添加通知渠道
          </button>
        </div>

        {showChannelForm && (
          <form
            onSubmit={handleSaveChannel}
            className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] p-4 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {editingChannelId ? "编辑通知渠道" : "新建通知渠道"}
              </span>
              <button
                type="button"
                onClick={() => setShowChannelForm(false)}
                aria-label="关闭渠道编辑表单"
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor={`${formId}-ch-name`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  渠道名称
                </label>
                <input
                  id={`${formId}-ch-name`}
                  type="text"
                  required
                  value={chName}
                  onChange={(e) => setChName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor={`${formId}-ch-type`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  渠道类型
                </label>
                <select
                  id={`${formId}-ch-type`}
                  value={chType}
                  onChange={(e) =>
                    setChType(e.target.value as "telegram" | "webhook")
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] text-slate-900 dark:text-slate-100"
                >
                  <option value="telegram">Telegram 机器人</option>
                  <option value="webhook">通用 Webhook 地址</option>
                </select>
              </div>

              {chType === "telegram" ? (
                <>
                  <div>
                    <label
                      htmlFor={`${formId}-ch-token`}
                      className="block text-slate-600 dark:text-slate-300 mb-1"
                    >
                      机器人令牌 (Bot Token) *
                    </label>
                    <input
                      id={`${formId}-ch-token`}
                      type="text"
                      required
                      value={chBotToken}
                      onChange={(e) => setChBotToken(e.target.value)}
                      placeholder="123456789:AAH..."
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`${formId}-ch-chat`}
                      className="block text-slate-600 dark:text-slate-300 mb-1"
                    >
                      接收群组或用户 ID (Chat ID) *
                    </label>
                    <input
                      id={`${formId}-ch-chat`}
                      type="text"
                      required
                      value={chChatId}
                      onChange={(e) => setChChatId(e.target.value)}
                      placeholder="-1001234567890 或个人数字 ID"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`${formId}-ch-thread`}
                      className="block text-slate-600 dark:text-slate-300 mb-1"
                    >
                      群组话题 ID（可选）
                    </label>
                    <input
                      id={`${formId}-ch-thread`}
                      type="number"
                      value={chThreadId}
                      onChange={(e) => setChThreadId(e.target.value)}
                      placeholder="留空则发送到主群或私聊"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`${formId}-ch-url`}
                      className="block text-slate-600 dark:text-slate-300 mb-1"
                    >
                      Webhook 接收地址 *
                    </label>
                    <input
                      id={`${formId}-ch-url`}
                      type="url"
                      required
                      value={chUrl}
                      onChange={(e) => setChUrl(e.target.value)}
                      placeholder="https://example.com/webhook"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`${formId}-ch-secret`}
                      className="block text-slate-600 dark:text-slate-300 mb-1"
                    >
                      签名密钥（可选，用于接收端校验请求）
                    </label>
                    <input
                      id={`${formId}-ch-secret`}
                      type="text"
                      value={chSecret}
                      onChange={(e) => setChSecret(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowChannelForm(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold disabled:opacity-50"
              >
                保存渠道
              </button>
            </div>
          </form>
        )}

        {channels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 p-6 text-center text-xs text-slate-400">
            暂未配置任何通知渠道，点击右上角添加 Telegram Bot 或 Webhook。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {channels.map((ch) => (
              <div
                key={ch.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0b101b] p-3.5 flex flex-col justify-between gap-3 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      {ch.type === "telegram" ? (
                        <Send className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
                      ) : (
                        <Webhook className="w-3.5 h-3.5 text-indigo-500" aria-hidden="true" />
                      )}
                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                        {ch.name}
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-num uppercase bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                        {ch.type}
                      </span>
                    </div>
                    <div className="mt-1 font-mono-num text-[11px] text-slate-500 dark:text-slate-400">
                      {ch.type === "telegram"
                        ? `Chat: ${ch.config.chat_id || "—"}${
                            ch.config.thread_id
                              ? ` · Topic #${ch.config.thread_id}`
                              : ""
                          }`
                        : ch.config.url || "—"}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleToggleChannel(ch)}
                    className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                      ch.enabled
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30"
                        : "bg-slate-200 dark:bg-slate-800 text-slate-500 border-slate-300 dark:border-slate-700"
                    }`}
                  >
                    {ch.enabled ? "已启用" : "已停用"}
                  </button>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-slate-200/70 dark:border-slate-800">
                  <button
                    type="button"
                    disabled={testingChannelId === ch.id}
                    onClick={() => handleTestChannel(ch)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300 hover:bg-sky-500/20 font-medium disabled:opacity-50"
                  >
                    {testingChannelId === ch.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <Send className="w-3 h-3" aria-hidden="true" />
                    )}
                    发送测试通知
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEditChannelForm(ch)}
                      className="p-1.5 rounded-md text-slate-400 hover:text-sky-500 hover:bg-sky-500/10"
                      title="编辑渠道"
                      aria-label={`编辑 ${ch.name}`}
                    >
                      <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteChannel(ch.id)}
                      className="p-1.5 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-500/10"
                      title="删除渠道"
                      aria-label={`删除 ${ch.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Alert Rules */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-500" aria-hidden="true" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              告警规则
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={handleApplyPresets}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              一键启用默认告警模板
            </button>
            <button
              type="button"
              onClick={() => (showRuleForm ? setShowRuleForm(false) : openNewRuleForm())}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 dark:hover:bg-slate-700 text-white"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              新增规则
            </button>
          </div>
        </div>

        {showRuleForm && (
          <form
            onSubmit={handleSaveRule}
            className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] p-4 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {editingRuleId ? "编辑告警规则" : "新建告警规则"}
              </span>
              <button
                type="button"
                onClick={() => {
                  setShowRuleForm(false);
                  setEditingRuleId(null);
                }}
                aria-label="关闭规则表单"
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor={`${formId}-rule-name`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  规则名称
                </label>
                <input
                  id={`${formId}-rule-name`}
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="例如：高 CPU 占用告警"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623]"
                />
              </div>
              <div>
                <label
                  htmlFor={`${formId}-rule-node`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  适用服务器
                </label>
                <select
                  id={`${formId}-rule-node`}
                  value={ruleNodeId}
                  onChange={(e) => setRuleNodeId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623]"
                >
                  <option value="__ALL__">所有服务器</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      仅 {n.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor={`${formId}-rule-metric`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  监控项目
                </label>
                <select
                  id={`${formId}-rule-metric`}
                  value={ruleMetric}
                  onChange={(e) => setRuleMetric(e.target.value as AlertMetric)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623]"
                >
                  {Object.entries(METRIC_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor={`${formId}-rule-threshold`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  触发条件与阈值
                </label>
                <div className="flex gap-2">
                  <select
                    aria-label="比较方式"
                    value={ruleOperator}
                    onChange={(e) =>
                      setRuleOperator(e.target.value as AlertOperator)
                    }
                    className="w-28 px-2 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623]"
                  >
                    <option value="gt">超过</option>
                    <option value="gte">达到或超过</option>
                  </select>
                  <input
                    id={`${formId}-rule-threshold`}
                    type="number"
                    step="any"
                    value={ruleThreshold}
                    onChange={(e) => setRuleThreshold(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor={`${formId}-rule-duration`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  持续超过多久触发 (秒)
                </label>
                <input
                  id={`${formId}-rule-duration`}
                  type="number"
                  min="0"
                  value={ruleDuration}
                  onChange={(e) => setRuleDuration(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num"
                />
              </div>

              <div>
                <label
                  htmlFor={`${formId}-rule-cooldown`}
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  重复提醒间隔 (秒)
                </label>
                <input
                  id={`${formId}-rule-cooldown`}
                  type="number"
                  min="60"
                  value={ruleCooldown}
                  onChange={(e) => setRuleCooldown(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] font-mono-num"
                />
              </div>
            </div>

            {channels.length > 0 && (
              <div>
                <span className="block text-slate-600 dark:text-slate-300 mb-1.5">
                  接收通知渠道（不选默认发往所有已启用渠道）：
                </span>
                <div className="flex flex-wrap gap-2">
                  {channels.map((c) => {
                    const checked = ruleChannelIds.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border cursor-pointer ${
                          checked
                            ? "border-sky-500 bg-sky-500/15 text-sky-600 dark:text-sky-300"
                            : "border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRuleChannel(c.id)}
                        />
                        {c.name}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRuleForm(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold"
              >
                {editingRuleId ? "保存规则" : "创建规则"}
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-50 dark:bg-[#131c2e] text-[11px] text-slate-500 dark:text-slate-400 font-mono-num border-y border-slate-200 dark:border-slate-800">
              <tr>
                <th scope="col" className="py-2 px-3">规则名称</th>
                <th scope="col" className="py-2 px-3">适用范围</th>
                <th scope="col" className="py-2 px-3">触发条件</th>
                <th scope="col" className="py-2 px-3">持续时长 / 提醒间隔</th>
                <th scope="col" className="py-2 px-3">状态</th>
                <th scope="col" className="py-2 px-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    暂无告警规则，可点击上方「一键启用默认告警模板」快速配置。
                  </td>
                </tr>
              ) : (
                rules.map((r) => {
                  const targetNode = r.node_id
                    ? nodes.find((n) => n.id === r.node_id)?.name ?? r.node_id
                    : "所有服务器";
                  return (
                    <tr
                      key={r.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/30"
                    >
                      <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">
                        {r.name}
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">
                        {targetNode}
                      </td>
                      <td className="py-2.5 px-3 font-mono-num text-slate-700 dark:text-slate-200">
                        {formatAlertCondition(r.metric, r.operator, r.threshold)}
                      </td>
                      <td className="py-2.5 px-3 font-mono-num text-slate-500 dark:text-slate-400">
                        持续 {formatDurationZh(r.duration_sec)} · 间隔 {formatDurationZh(r.cooldown_sec)}
                      </td>
                      <td className="py-2.5 px-3">
                        <button
                          type="button"
                          onClick={() => handleToggleRule(r)}
                          className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                            r.enabled
                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30"
                              : "bg-slate-200 dark:bg-slate-800 text-slate-500 border-slate-300 dark:border-slate-700"
                          }`}
                        >
                          {r.enabled ? "启用中" : "已停用"}
                        </button>
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditRuleForm(r)}
                            className="p-1 rounded text-slate-400 hover:text-sky-500 hover:bg-sky-500/10"
                            title="编辑规则"
                            aria-label={`编辑规则 ${r.name}`}
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteRule(r.id)}
                            className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-500/10"
                            title="删除规则"
                            aria-label={`删除规则 ${r.name}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. Incident Timeline */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-sky-500" aria-hidden="true" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              历史告警记录 ({incidentsTotal})
            </h3>
          </div>

          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#090d14] p-0.5 text-xs">
            {(
              [
                { key: "all", label: "全部" },
                { key: "firing", label: "告警中" },
                { key: "resolved", label: "已恢复" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setIncidentFilter(opt.key)}
                className={`px-3 py-1 rounded-md font-medium ${
                  incidentFilter === opt.key
                    ? "bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 shadow-xs"
                    : "text-slate-600 dark:text-slate-400"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {incidents.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">
            暂无符合条件的告警历史记录
          </div>
        ) : (
          <div className="space-y-2.5">
            {incidents.map((inc) => {
              const isFiring = inc.status === "firing";
              const durationSec = inc.resolved_at
                ? Math.max(0, inc.resolved_at - inc.started_at)
                : null;
              return (
                <div
                  key={inc.id}
                  className={`rounded-xl border p-3.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                    isFiring
                      ? "border-rose-500/35 bg-rose-500/[0.06]"
                      : "border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0b101b]"
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          isFiring
                            ? "bg-rose-500/20 text-rose-600 dark:text-rose-300"
                            : "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300"
                        }`}
                      >
                        {formatAlertStatus(isFiring ? "FIRING" : "RESOLVED")}
                      </span>
                      <span className="font-bold text-slate-900 dark:text-slate-100">
                        {inc.node_name}
                      </span>
                      <span className="font-mono-num text-[11px] px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                        {formatAlertMetric(inc.metric)}
                      </span>
                    </div>
                    <p className="text-slate-700 dark:text-slate-300">
                      {inc.message}
                    </p>
                  </div>

                  <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 sm:text-right shrink-0">
                    <div>触发：{formatTimestamp(inc.started_at)}</div>
                    {inc.resolved_at ? (
                      <div className="text-emerald-600 dark:text-emerald-400">
                        恢复：{formatTimestamp(inc.resolved_at)}（历时{" "}
                        {formatDurationZh(durationSec)}）
                      </div>
                    ) : (
                      <div className="text-rose-500">持续告警中</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
