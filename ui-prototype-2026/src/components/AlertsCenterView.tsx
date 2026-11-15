import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Edit3,
  History,
  Plus,
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
  NotificationChannel,
  PrototypeNode,
} from "../types";
import {
  formatAlertCondition,
  formatAlertMetric,
  formatAlertStatus,
  formatDurationZh,
  formatRelativeTime,
  formatTimestamp,
} from "../utils/format";

export interface AlertsCenterViewProps {
  nodes: PrototypeNode[];
  channels: NotificationChannel[];
  rules: AlertRule[];
  incidents: AlertIncident[];
  onSaveChannel: (
    ch: Omit<NotificationChannel, "id" | "created_at"> & { id?: string },
  ) => void;
  onToggleChannel: (id: string) => void;
  onDeleteChannel: (id: string) => void;
  onTestChannel: (id: string) => void;
  onSaveRule: (
    rule: Omit<AlertRule, "id" | "created_at"> & { id?: string },
  ) => void;
  onToggleRule: (id: string) => void;
  onDeleteRule: (id: string) => void;
  onApplyPresets: () => void;
  onResolveIncident: (id: string) => void;
}

type AlertsTab = "incidents" | "rules" | "channels";
type IncidentFilter = "all" | "firing" | "resolved";

const METRIC_LABELS: Record<AlertMetric, string> = {
  offline: "服务器离线时长 (秒)",
  cpu: "处理器占用 (%)",
  steal: "CPU 宿主机争抢 (%)",
  mem: "内存占用 (%)",
  swap: "虚拟内存占用 (%)",
  disk: "磁盘空间占用 (%)",
  traffic_pct: "月流量使用率 (%)",
};

function maskToken(val: string | undefined): string {
  if (!val) return "未配置";
  if (val.length <= 10) return "••••••••";
  return `${val.slice(0, 6)}••••${val.slice(-4)}`;
}

export function AlertsCenterView({
  nodes,
  channels,
  rules,
  incidents,
  onSaveChannel,
  onToggleChannel,
  onDeleteChannel,
  onTestChannel,
  onSaveRule,
  onToggleRule,
  onDeleteRule,
  onApplyPresets,
  onResolveIncident,
}: AlertsCenterViewProps): React.JSX.Element {
  const baseId = useId();
  const tabIds = {
    incidents: `${baseId}-tab-incidents`,
    rules: `${baseId}-tab-rules`,
    channels: `${baseId}-tab-channels`,
  };
  const panelIds = {
    incidents: `${baseId}-panel-incidents`,
    rules: `${baseId}-panel-rules`,
    channels: `${baseId}-panel-channels`,
  };

  const tabRefs = useRef<Record<AlertsTab, HTMLButtonElement | null>>({
    incidents: null,
    rules: null,
    channels: null,
  });

  const [activeTab, setActiveTab] = useState<AlertsTab>("incidents");
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>("all");

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
  const [confirmDeleteRuleId, setConfirmDeleteRuleId] = useState<string | null>(
    null,
  );

  // Channel form state
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [chName, setChName] = useState("运维 TG 值班机器人");
  const [chType, setChType] = useState<"telegram" | "webhook">("telegram");
  const [chBotToken, setChBotToken] = useState("");
  const [chChatId, setChChatId] = useState("");
  const [chThreadId, setChThreadId] = useState("");
  const [chUrl, setChUrl] = useState("");
  const [chSecret, setChSecret] = useState("");
  const [chFormError, setChFormError] = useState<string | null>(null);
  const [confirmDeleteChId, setConfirmDeleteChId] = useState<string | null>(
    null,
  );
  const [testedChannelId, setTestedChannelId] = useState<string | null>(null);
  const testTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
      }
    };
  }, []);

  const firingCount = useMemo(
    () => incidents.filter((i) => i.status === "firing").length,
    [incidents],
  );
  const resolvedCount = useMemo(
    () => incidents.filter((i) => i.status === "resolved").length,
    [incidents],
  );
  const enabledRulesCount = useMemo(
    () => rules.filter((r) => r.enabled).length,
    [rules],
  );
  const enabledChannelsCount = useMemo(
    () => channels.filter((c) => c.enabled).length,
    [channels],
  );

  const filteredIncidents = useMemo(() => {
    if (incidentFilter === "all") return incidents;
    return incidents.filter((inc) => inc.status === incidentFilter);
  }, [incidents, incidentFilter]);

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    const order: AlertsTab[] = ["incidents", "rules", "channels"];
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % order.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (idx - 1 + order.length) % order.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = order.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const nextTab = order[nextIdx];
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
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

  const handleRuleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const existingRule = editingRuleId
      ? rules.find((r) => r.id === editingRuleId)
      : null;
    const thresholdNum = Number(ruleThreshold);
    const targetChannels =
      ruleChannelIds.length > 0
        ? ruleChannelIds
        : channels.filter((c) => c.enabled).map((c) => c.id);

    onSaveRule({
      ...(editingRuleId ? { id: editingRuleId } : {}),
      name:
        ruleName.trim() ||
        `${METRIC_LABELS[ruleMetric]} ${ruleOperator === "gte" ? ">=" : ">"} ${ruleThreshold}`,
      node_id: ruleNodeId === "__ALL__" ? null : ruleNodeId,
      metric: ruleMetric,
      operator: ruleOperator,
      threshold: Number.isFinite(thresholdNum) ? thresholdNum : 0,
      duration_sec: Math.max(0, Number.parseInt(ruleDuration, 10) || 0),
      cooldown_sec: Math.max(60, Number.parseInt(ruleCooldown, 10) || 3600),
      channel_ids: targetChannels,
      enabled: existingRule ? existingRule.enabled : true,
    });

    setShowRuleForm(false);
    setEditingRuleId(null);
  };

  const openNewChannelForm = () => {
    setEditingChannelId(null);
    setChName("运维 TG 值班机器人");
    setChType("telegram");
    setChBotToken("");
    setChChatId("");
    setChThreadId("");
    setChUrl("");
    setChSecret("");
    setChFormError(null);
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
    setChFormError(null);
    setShowChannelForm(true);
  };

  const handleChannelSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (chType === "telegram") {
      if (!chBotToken.trim() || !chChatId.trim()) {
        setChFormError("Telegram 渠道需要填写 Bot Token 与 Chat ID");
        return;
      }
    } else if (!chUrl.trim()) {
      setChFormError("Webhook 渠道需要填写有效的回调接收地址");
      return;
    }

    const existingCh = editingChannelId
      ? channels.find((c) => c.id === editingChannelId)
      : null;

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

    onSaveChannel({
      ...(editingChannelId ? { id: editingChannelId } : {}),
      name:
        chName.trim() || (chType === "telegram" ? "Telegram Bot" : "Webhook"),
      type: chType,
      enabled: existingCh ? existingCh.enabled : true,
      config,
    });

    setShowChannelForm(false);
    setEditingChannelId(null);
    setChFormError(null);
  };

  const handleTestChannelClick = (chId: string) => {
    onTestChannel(chId);
    setTestedChannelId(chId);
    if (testTimerRef.current !== null) {
      window.clearTimeout(testTimerRef.current);
    }
    testTimerRef.current = window.setTimeout(() => {
      setTestedChannelId(null);
      testTimerRef.current = null;
    }, 2600);
  };

  return (
    <section className="space-y-5">
      {/* Page Header & Incident Response Summary */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-[var(--text-primary)]">
              实时事件响应与告警路由中心
            </h1>
            {firingCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/35">
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                <span>{firingCount} 项告警进行中</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/35">
                <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                <span>全网无活跃告警</span>
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            支持边缘水位 0s 瞬时冲刷判定、防抖恢复滞回、6 项黄金模板一键部署及 Telegram / HMAC Webhook 路由。
          </p>
        </div>

        <button
          type="button"
          onClick={onApplyPresets}
          className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-amber-500/40 bg-amber-500/12 text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          <span>一键启用 6 项推荐黄金模板</span>
        </button>
      </div>

      {/* 3-Card Telemetry KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="surface-card rounded-2xl p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              实时告警事件
            </div>
            <div className="mt-1 flex items-baseline gap-2 font-mono-num">
              <span
                className={`text-xl font-bold ${
                  firingCount > 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {firingCount}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                告警中 · {resolvedCount} 已恢复
              </span>
            </div>
          </div>
          <History
            className={`w-5 h-5 ${
              firingCount > 0 ? "text-rose-500" : "text-emerald-500"
            }`}
            aria-hidden="true"
          />
        </div>

        <div className="surface-card rounded-2xl p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              告警规则引擎
            </div>
            <div className="mt-1 flex items-baseline gap-2 font-mono-num">
              <span className="text-xl font-bold text-[var(--text-primary)]">
                {enabledRulesCount}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                / {rules.length} 条启用中
              </span>
            </div>
          </div>
          <ShieldAlert
            className="w-5 h-5 text-amber-500"
            aria-hidden="true"
          />
        </div>

        <div className="surface-card rounded-2xl p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              通知路由渠道
            </div>
            <div className="mt-1 flex items-baseline gap-2 font-mono-num">
              <span className="text-xl font-bold text-[var(--text-primary)]">
                {enabledChannelsCount}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                / {channels.length} 条在线路由
              </span>
            </div>
          </div>
          <Bell
            className="w-5 h-5 text-[var(--accent-primary)]"
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Main Tabbed Incident Response Surface */}
      <div className="surface-card rounded-2xl overflow-hidden">
        {/* Single-row [role="tablist"] */}
        <div className="px-4 sm:px-5 pt-3 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40">
          <div
            role="tablist"
            aria-label="告警中心视图切换"
            className="flex gap-6"
          >
            <button
              ref={(el) => {
                tabRefs.current.incidents = el;
              }}
              id={tabIds.incidents}
              type="button"
              role="tab"
              aria-selected={activeTab === "incidents"}
              aria-controls={panelIds.incidents}
              tabIndex={activeTab === "incidents" ? 0 : -1}
              onClick={() => setActiveTab("incidents")}
              onKeyDown={(e) => handleTabKeyDown(e, 0)}
              className={`pb-3 inline-flex items-center gap-2 text-xs font-medium transition-colors ${
                activeTab === "incidents"
                  ? "text-[var(--accent-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <History className="w-3.5 h-3.5" aria-hidden="true" />
              <span>① 实时告警事件时间线</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono-num bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                {incidents.length}
              </span>
            </button>

            <button
              ref={(el) => {
                tabRefs.current.rules = el;
              }}
              id={tabIds.rules}
              type="button"
              role="tab"
              aria-selected={activeTab === "rules"}
              aria-controls={panelIds.rules}
              tabIndex={activeTab === "rules" ? 0 : -1}
              onClick={() => setActiveTab("rules")}
              onKeyDown={(e) => handleTabKeyDown(e, 1)}
              className={`pb-3 inline-flex items-center gap-2 text-xs font-medium transition-colors ${
                activeTab === "rules"
                  ? "text-[var(--accent-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
              <span>② 告警规则引擎</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono-num bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                {rules.length}
              </span>
            </button>

            <button
              ref={(el) => {
                tabRefs.current.channels = el;
              }}
              id={tabIds.channels}
              type="button"
              role="tab"
              aria-selected={activeTab === "channels"}
              aria-controls={panelIds.channels}
              tabIndex={activeTab === "channels" ? 0 : -1}
              onClick={() => setActiveTab("channels")}
              onKeyDown={(e) => handleTabKeyDown(e, 2)}
              className={`pb-3 inline-flex items-center gap-2 text-xs font-medium transition-colors ${
                activeTab === "channels"
                  ? "text-[var(--accent-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Bell className="w-3.5 h-3.5" aria-hidden="true" />
              <span>③ 通知路由渠道</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono-num bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                {channels.length}
              </span>
            </button>
          </div>
        </div>

        {/* TabPanel 1: Incident Timeline */}
        <div
          id={panelIds.incidents}
          role="tabpanel"
          aria-labelledby={tabIds.incidents}
          hidden={activeTab !== "incidents"}
        >
          <div className="p-4 sm:p-5 space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-1">
                {(
                  [
                    { key: "all", label: `全部 (${incidents.length})` },
                    { key: "firing", label: `告警中 (${firingCount})` },
                    { key: "resolved", label: `已恢复 (${resolvedCount})` },
                  ] as const
                ).map((opt) => {
                  const active = incidentFilter === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setIncidentFilter(opt.key)}
                      aria-pressed={active}
                      className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                        active
                          ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <span className="text-[11px] text-[var(--text-muted)]">
                点击「模拟故障恢复」可验证告警闭环恢复通知流
              </span>
            </div>

            {filteredIncidents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-subtle)] py-12 text-center text-[var(--text-muted)]">
                当前筛选下暂无告警事件记录。
              </div>
            ) : (
              <div className="space-y-3">
                {filteredIncidents.map((inc) => {
                  const isFiring = inc.status === "firing";
                  const durationSec = inc.resolved_at
                    ? Math.max(0, inc.resolved_at - inc.started_at)
                    : null;
                  return (
                    <article
                      key={inc.id}
                      className={`rounded-2xl border p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 transition-colors ${
                        isFiring
                          ? "border-rose-500/40 bg-rose-500/[0.06]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-inset)]/70"
                      }`}
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                              isFiring
                                ? "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/35"
                                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35"
                            }`}
                          >
                            {isFiring ? (
                              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                            ) : (
                              <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                            )}
                            <span>{formatAlertStatus(inc.status)}</span>
                          </span>

                          <span className="font-bold text-[var(--text-primary)]">
                            {inc.node_name}
                          </span>

                          <span className="px-2 py-0.5 rounded-md font-mono-num text-[11px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                            {formatAlertMetric(inc.metric)}
                          </span>

                          {inc.trigger_value !== null && inc.threshold !== null && (
                            <span className="font-mono-num text-[11px] text-[var(--text-muted)]">
                              实测 {inc.trigger_value} / 阈值 {inc.threshold}
                            </span>
                          )}
                        </div>

                        <p className="text-[var(--text-primary)] leading-relaxed">
                          {inc.message}
                        </p>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono-num text-[var(--text-muted)]">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" aria-hidden="true" />
                            触发：{formatTimestamp(inc.started_at)}（
                            {formatRelativeTime(inc.started_at)}）
                          </span>
                          {inc.resolved_at ? (
                            <span className="text-emerald-700 dark:text-emerald-400">
                              恢复：{formatTimestamp(inc.resolved_at)} · 历时{" "}
                              {formatDurationZh(durationSec)}
                            </span>
                          ) : (
                            <span className="text-rose-600 dark:text-rose-400 font-medium">
                              持续告警中
                            </span>
                          )}
                        </div>
                      </div>

                      {isFiring && (
                        <button
                          type="button"
                          onClick={() => onResolveIncident(inc.id)}
                          className="shrink-0 self-start lg:self-center inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>模拟恢复事件</span>
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* TabPanel 2: Alert Rules Engine */}
        <div
          id={panelIds.rules}
          role="tabpanel"
          aria-labelledby={tabIds.rules}
          hidden={activeTab !== "rules"}
        >
          <div className="p-4 sm:p-5 space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[var(--text-secondary)]">
                支持全局规则与单节点定向规则，内置持续时长防抖与通知冷却保护，防止瞬时毛刺刷屏。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onApplyPresets}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 font-semibold hover:bg-amber-500/20"
                >
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>一键启用 6 项黄金模板</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    showRuleForm ? setShowRuleForm(false) : openNewRuleForm()
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-white font-semibold shadow-xs"
                  style={{ backgroundColor: "var(--accent-solid)" }}
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>新增告警规则</span>
                </button>
              </div>
            </div>

            {showRuleForm && (
              <form
                onSubmit={handleRuleSubmit}
                className="rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-inset)] p-4 space-y-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[var(--text-primary)]">
                    {editingRuleId ? "编辑告警规则" : "新建告警规则"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowRuleForm(false)}
                    aria-label="关闭规则表单"
                    className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor={`${baseId}-rule-name`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      规则名称
                    </label>
                    <input
                      id={`${baseId}-rule-name`}
                      type="text"
                      value={ruleName}
                      onChange={(e) => setRuleName(e.target.value)}
                      placeholder="例如：高 CPU Steal 宿主机争抢"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-rule-node`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      适用节点范围
                    </label>
                    <select
                      id={`${baseId}-rule-node`}
                      value={ruleNodeId}
                      onChange={(e) => setRuleNodeId(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    >
                      <option value="__ALL__">全部服务器</option>
                      {nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          仅 {n.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-rule-metric`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      监控指标
                    </label>
                    <select
                      id={`${baseId}-rule-metric`}
                      value={ruleMetric}
                      onChange={(e) =>
                        setRuleMetric(e.target.value as AlertMetric)
                      }
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
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
                      htmlFor={`${baseId}-rule-threshold`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      判定符与阈值
                    </label>
                    <div className="flex gap-2">
                      <select
                        aria-label="比较方式"
                        value={ruleOperator}
                        onChange={(e) =>
                          setRuleOperator(e.target.value as AlertOperator)
                        }
                        className="w-28 px-2.5 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                      >
                        <option value="gt">超过 (&gt;)</option>
                        <option value="gte">达到 (&gt;=)</option>
                      </select>
                      <input
                        id={`${baseId}-rule-threshold`}
                        type="number"
                        step="any"
                        value={ruleThreshold}
                        onChange={(e) => setRuleThreshold(e.target.value)}
                        className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-rule-duration`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      持续触发时长 (秒)
                    </label>
                    <input
                      id={`${baseId}-rule-duration`}
                      type="number"
                      min="0"
                      value={ruleDuration}
                      onChange={(e) => setRuleDuration(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-rule-cooldown`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      重复告警冷却 (秒)
                    </label>
                    <input
                      id={`${baseId}-rule-cooldown`}
                      type="number"
                      min="60"
                      value={ruleCooldown}
                      onChange={(e) => setRuleCooldown(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                    />
                  </div>
                </div>

                {channels.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="block text-[var(--text-secondary)]">
                      绑定通知渠道（不选默认发往所有已启用渠道）：
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {channels.map((ch) => {
                        const checked = ruleChannelIds.includes(ch.id);
                        return (
                          <label
                            key={ch.id}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border cursor-pointer ${
                              checked
                                ? "border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent-primary)] font-medium"
                                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setRuleChannelIds((prev) =>
                                  prev.includes(ch.id)
                                    ? prev.filter((x) => x !== ch.id)
                                    : [...prev, ch.id],
                                )
                              }
                              className="rounded accent-emerald-600"
                            />
                            <span>{ch.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowRuleForm(false)}
                    className="px-3.5 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded-xl text-white font-semibold"
                    style={{ backgroundColor: "var(--accent-solid)" }}
                  >
                    {editingRuleId ? "保存规则变更" : "创建规则"}
                  </button>
                </div>
              </form>
            )}

            <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
                  <tr>
                    <th scope="col" className="py-2.5 px-3">规则名称</th>
                    <th scope="col" className="py-2.5 px-3">适用范围</th>
                    <th scope="col" className="py-2.5 px-3">触发条件</th>
                    <th scope="col" className="py-2.5 px-3">防抖与冷却</th>
                    <th scope="col" className="py-2.5 px-3">状态</th>
                    <th scope="col" className="py-2.5 px-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {rules.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-10 text-center text-[var(--text-muted)]"
                      >
                        暂无告警规则，点击「一键启用 6 项黄金模板」即可快速部署。
                      </td>
                    </tr>
                  ) : (
                    rules.map((r) => {
                      const targetName = r.node_id
                        ? nodes.find((n) => n.id === r.node_id)?.name ?? r.node_id
                        : "所有服务器";
                      return (
                        <tr
                          key={r.id}
                          className="hover:bg-[var(--bg-card-hover)] transition-colors"
                        >
                          <td className="py-3 px-3 font-semibold text-[var(--text-primary)]">
                            {r.name}
                          </td>
                          <td className="py-3 px-3 text-[var(--text-secondary)]">
                            {targetName}
                          </td>
                          <td className="py-3 px-3 font-mono-num text-[var(--text-primary)]">
                            {formatAlertCondition(r.metric, r.operator, r.threshold)}
                          </td>
                          <td className="py-3 px-3 font-mono-num text-[var(--text-muted)] whitespace-nowrap">
                            持续 {formatDurationZh(r.duration_sec)} · 冷却{" "}
                            {formatDurationZh(r.cooldown_sec)}
                          </td>
                          <td className="py-3 px-3">
                            <button
                              type="button"
                              onClick={() => onToggleRule(r.id)}
                              className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                                r.enabled
                                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35"
                                  : "bg-[var(--bg-elevated)] text-[var(--text-muted)] border-[var(--border-subtle)]"
                              }`}
                            >
                              {r.enabled ? "启用中" : "已停用"}
                            </button>
                          </td>
                          <td className="py-3 px-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEditRuleForm(r)}
                                title="编辑规则"
                                aria-label={`编辑规则 ${r.name}`}
                                className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-sky-600 dark:hover:text-sky-400"
                              >
                                <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                              </button>

                              {confirmDeleteRuleId === r.id ? (
                                <span className="inline-flex items-center gap-1 ml-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onDeleteRule(r.id);
                                      setConfirmDeleteRuleId(null);
                                    }}
                                    className="px-2 py-1 rounded-lg bg-rose-600 text-white text-[11px] font-semibold"
                                  >
                                    确认删除
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteRuleId(null)}
                                    className="px-2 py-1 rounded-lg border border-[var(--border-subtle)] text-[11px]"
                                  >
                                    取消
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteRuleId(r.id)}
                                  title="删除规则"
                                  aria-label={`删除规则 ${r.name}`}
                                  className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-rose-600 dark:hover:text-rose-400"
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              )}
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
        </div>

        {/* TabPanel 3: Notification Channels */}
        <div
          id={panelIds.channels}
          role="tabpanel"
          aria-labelledby={tabIds.channels}
          hidden={activeTab !== "channels"}
        >
          <div className="p-4 sm:p-5 space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[var(--text-secondary)]">
                支持 Telegram Bot（含群组 Topic ID）与带 HMAC-SHA256 签名头的通用 Webhook 通道。
              </p>
              <button
                type="button"
                onClick={() =>
                  showChannelForm ? setShowChannelForm(false) : openNewChannelForm()
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-white font-semibold shadow-xs"
                style={{ backgroundColor: "var(--accent-solid)" }}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>添加通知渠道</span>
              </button>
            </div>

            {showChannelForm && (
              <form
                noValidate
                onSubmit={handleChannelSubmit}
                className="rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-inset)] p-4 space-y-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[var(--text-primary)]">
                    {editingChannelId ? "编辑通知渠道" : "新建通知渠道"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowChannelForm(false)}
                    aria-label="关闭渠道表单"
                    className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>

                {chFormError && (
                  <div
                    role="alert"
                    className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-700 dark:text-rose-300"
                  >
                    {chFormError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor={`${baseId}-ch-name`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      渠道名称
                    </label>
                    <input
                      id={`${baseId}-ch-name`}
                      type="text"
                      required
                      value={chName}
                      onChange={(e) => setChName(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-ch-type`}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      渠道类型
                    </label>
                    <select
                      id={`${baseId}-ch-type`}
                      value={chType}
                      onChange={(e) => {
                        setChType(e.target.value as "telegram" | "webhook");
                        setChFormError(null);
                      }}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    >
                      <option value="telegram">Telegram Bot</option>
                      <option value="webhook">通用 Webhook (HMAC)</option>
                    </select>
                  </div>

                  {chType === "telegram" ? (
                    <>
                      <div>
                        <label
                          htmlFor={`${baseId}-ch-token`}
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          Bot Token *
                        </label>
                        <input
                          id={`${baseId}-ch-token`}
                          type="text"
                          value={chBotToken}
                          onChange={(e) => setChBotToken(e.target.value)}
                          placeholder="123456789:AAH..."
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`${baseId}-ch-chat`}
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          Chat ID *
                        </label>
                        <input
                          id={`${baseId}-ch-chat`}
                          type="text"
                          value={chChatId}
                          onChange={(e) => setChChatId(e.target.value)}
                          placeholder="-1001988273645"
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label
                          htmlFor={`${baseId}-ch-thread`}
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          群组 Topic Thread ID（可选）
                        </label>
                        <input
                          id={`${baseId}-ch-thread`}
                          type="number"
                          value={chThreadId}
                          onChange={(e) => setChThreadId(e.target.value)}
                          placeholder="留空则发送至主群或私聊"
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="sm:col-span-2">
                        <label
                          htmlFor={`${baseId}-ch-url`}
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          Webhook 接收 URL *
                        </label>
                        <input
                          id={`${baseId}-ch-url`}
                          type="url"
                          value={chUrl}
                          onChange={(e) => setChUrl(e.target.value)}
                          placeholder="https://hooks.ops.example.com/uniob"
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label
                          htmlFor={`${baseId}-ch-secret`}
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          HMAC-SHA256 签名密钥（可选）
                        </label>
                        <input
                          id={`${baseId}-ch-secret`}
                          type="text"
                          value={chSecret}
                          onChange={(e) => setChSecret(e.target.value)}
                          placeholder="whsec_..."
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                    </>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowChannelForm(false)}
                    className="px-3.5 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded-xl text-white font-semibold"
                    style={{ backgroundColor: "var(--accent-solid)" }}
                  >
                    保存通知渠道
                  </button>
                </div>
              </form>
            )}

            {channels.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-subtle)] py-12 text-center text-[var(--text-muted)]">
                暂无通知路由渠道，请点击右上角添加 Telegram Bot 或 Webhook。
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {channels.map((ch) => {
                  const justTested = testedChannelId === ch.id;
                  return (
                    <article
                      key={ch.id}
                      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-inset)]/75 p-4 flex flex-col justify-between gap-3.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            {ch.type === "telegram" ? (
                              <Send
                                className="w-4 h-4 text-sky-500 shrink-0"
                                aria-hidden="true"
                              />
                            ) : (
                              <Webhook
                                className="w-4 h-4 text-indigo-500 shrink-0"
                                aria-hidden="true"
                              />
                            )}
                            <span className="font-bold text-[var(--text-primary)] truncate">
                              {ch.name}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-num uppercase bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                              {ch.type}
                            </span>
                          </div>

                          <div className="font-mono-num text-[11px] text-[var(--text-muted)] space-y-0.5">
                            {ch.type === "telegram" ? (
                              <>
                                <div>
                                  Chat: {ch.config.chat_id || "—"}
                                  {ch.config.thread_id
                                    ? ` · Topic #${ch.config.thread_id}`
                                    : ""}
                                </div>
                                <div>
                                  Token: {maskToken(ch.config.bot_token)}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="truncate">
                                  URL: {ch.config.url || "—"}
                                </div>
                                <div>
                                  签名：
                                  {ch.config.secret
                                    ? `HMAC-SHA256 (${maskToken(ch.config.secret)})`
                                    : "未配置签名密钥"}
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => onToggleChannel(ch.id)}
                          className={`shrink-0 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                            ch.enabled
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35"
                              : "bg-[var(--bg-surface)] text-[var(--text-muted)] border-[var(--border-subtle)]"
                          }`}
                        >
                          {ch.enabled ? "已启用" : "已停用"}
                        </button>
                      </div>

                      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleTestChannelClick(ch.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-sky-500/35 bg-sky-500/12 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 font-medium transition-colors"
                          >
                            <Send className="w-3 h-3" aria-hidden="true" />
                            <span>发送测试通知</span>
                          </button>
                          {justTested && (
                            <span
                              role="status"
                              className="text-[11px] font-mono-num font-semibold text-emerald-600 dark:text-emerald-400"
                            >
                              ✓ 已模拟送达 (200 OK)
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditChannelForm(ch)}
                            title="编辑渠道"
                            aria-label={`编辑 ${ch.name}`}
                            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-sky-600 dark:hover:text-sky-400"
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>

                          {confirmDeleteChId === ch.id ? (
                            <span className="inline-flex items-center gap-1 ml-1">
                              <button
                                type="button"
                                onClick={() => {
                                  onDeleteChannel(ch.id);
                                  setConfirmDeleteChId(null);
                                }}
                                className="px-2 py-1 rounded-lg bg-rose-600 text-white text-[11px] font-semibold"
                              >
                                确认删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteChId(null)}
                                className="px-2 py-1 rounded-lg border border-[var(--border-subtle)] text-[11px]"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteChId(ch.id)}
                              title="删除渠道"
                              aria-label={`删除 ${ch.name}`}
                              className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-rose-600 dark:hover:text-rose-400"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
