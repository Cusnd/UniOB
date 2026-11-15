import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  Webhook,
} from "lucide-react";
import type {
  AlertIncident,
  AlertMetric,
  AlertOperator,
  AlertRule,
  HorizonNode,
  InspectorTab,
  NotificationChannel,
} from "../types";
import { api } from "../api/client";
import {
  formatDurationZh,
  formatRelativeTime,
  isNodeMuted,
} from "../utils/format";
import {
  Badge,
  Button,
  Card,
  IconCloseButton,
  MetricBar,
  NativeDialog,
  SectionHeader,
  SegmentedControl,
  StatusDot,
  Switch,
  TabBar,
} from "./ui/Primitives";

export interface AlertsCenterViewProps {
  nodes: HorizonNode[];
  alertVersion: number;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onMuteNode: (nodeId: string, seconds: number | null) => Promise<void>;
  onActiveCountChange: (count: number) => void;
  onNotify: (
    tone: "success" | "info" | "warning" | "danger",
    title: string,
    description?: string,
  ) => void;
}

type AlertSubTab = "timeline" | "rules" | "channels";
type IncidentFilter = "all" | "firing" | "resolved";

const PAGE_SIZE = 50;

const SHORT_INCIDENT_TAG: Record<string, string> = {
  cpu: "CPU 过高",
  steal: "CPU 争抢",
  mem: "内存告警",
  swap: "交换区高",
  disk: "磁盘不足",
  traffic_pct: "流量超限",
  offline: "离线",
  watchdog: "连通异常",
};

const METRIC_DEFAULT_NAME: Record<AlertMetric, string> = {
  cpu: "CPU 使用率过高",
  steal: "CPU 争抢率过高",
  mem: "内存使用率过高",
  swap: "交换区占用过高",
  disk: "磁盘空间不足",
  traffic_pct: "月流量配额告警",
  offline: "服务器离线告警",
};

function formatChannelTarget(ch: NotificationChannel): string {
  if (ch.type === "telegram") {
    const cid = ch.config.chat_id?.trim();
    if (!cid) return "Telegram";
    return ch.config.thread_id ? `${cid} · #${ch.config.thread_id}` : cid;
  }
  const rawUrl = ch.config.url?.trim() ?? "";
  if (!rawUrl) return "Webhook";
  try {
    const u = new URL(rawUrl);
    return u.host;
  } catch {
    return rawUrl.slice(0, 32);
  }
}

export function AlertsCenterView(
  props: AlertsCenterViewProps,
): React.JSX.Element {
  const {
    nodes,
    alertVersion,
    onSelectNode,
    onMuteNode,
    onActiveCountChange,
    onNotify,
  } = props;

  const ruleModalTitleId = useId();
  const channelModalTitleId = useId();
  const deleteConfirmTitleId = useId();

  const onActiveCountChangeRef = useRef(onActiveCountChange);
  onActiveCountChangeRef.current = onActiveCountChange;

  const [activeTab, setActiveTab] = useState<AlertSubTab>("timeline");
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>("all");
  const [pageOffset, setPageOffset] = useState(0);

  // Real data states
  const [incidents, setIncidents] = useState<AlertIncident[]>([]);
  const [incidentsTotal, setIncidentsTotal] = useState(0);
  const [firingTotal, setFiringTotal] = useState(0);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Action busy states
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [busyChannelId, setBusyChannelId] = useState<string | null>(null);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [testedChannelIds, setTestedChannelIds] = useState<
    Record<string, boolean>
  >({});
  const [applyingPresets, setApplyingPresets] = useState(false);
  const [busyMuteNodeId, setBusyMuteNodeId] = useState<string | null>(null);

  // Rule Create / Edit Modal state
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleNodeId, setRuleNodeId] = useState<string>("");
  const [ruleMetric, setRuleMetric] = useState<AlertMetric>("cpu");
  const [ruleOperator, setRuleOperator] = useState<AlertOperator>("gte");
  const [ruleThreshold, setRuleThreshold] = useState(90);
  const [ruleDurationSec, setRuleDurationSec] = useState(120);
  const [ruleCooldownSec, setRuleCooldownSec] = useState(1800);
  const [ruleChannelIds, setRuleChannelIds] = useState<string[]>([]);
  const [savingRule, setSavingRule] = useState(false);
  const [ruleFormError, setRuleFormError] = useState<string | null>(null);

  // Channel Create / Edit Modal state
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] =
    useState<NotificationChannel | null>(null);
  const [chType, setChType] = useState<"telegram" | "webhook">("telegram");
  const [chName, setChName] = useState("");
  const [chBotToken, setChBotToken] = useState("");
  const [chChatId, setChChatId] = useState("");
  const [chThreadId, setChThreadId] = useState("");
  const [chWebhookUrl, setChWebhookUrl] = useState("");
  const [chWebhookSecret, setChWebhookSecret] = useState("");
  const [savingChannel, setSavingChannel] = useState(false);
  const [channelFormError, setChannelFormError] = useState<string | null>(null);

  // Delete confirmation dialog state (shared for rules & channels)
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "rule"; item: AlertRule }
    | { kind: "channel"; item: NotificationChannel }
    | null
  >(null);
  const [deletingItem, setDeletingItem] = useState(false);

  const nodeMap = useMemo(() => {
    const map = new Map<string, HorizonNode>();
    for (const n of nodes) map.set(n.id, n);
    return map;
  }, [nodes]);

  const loadRulesAndChannels = useCallback(async () => {
    const [rulesRes, chRes] = await Promise.all([
      api.getRules(),
      api.getChannels(),
    ]);
    setRules(Array.isArray(rulesRes?.rules) ? rulesRes.rules : []);
    setChannels(Array.isArray(chRes?.channels) ? chRes.channels : []);
  }, []);

  const loadIncidentsData = useCallback(async () => {
    const [listRes, firingRes] = await Promise.all([
      api.getIncidents({
        status: incidentFilter,
        limit: PAGE_SIZE,
        offset: pageOffset,
      }),
      incidentFilter === "firing"
        ? Promise.resolve(null)
        : api.getIncidents({ status: "firing", limit: 1, offset: 0 }),
    ]);

    const items = Array.isArray(listRes?.incidents) ? listRes.incidents : [];
    const total = typeof listRes?.total === "number" ? listRes.total : items.length;
    const activeFiring =
      incidentFilter === "firing"
        ? total
        : typeof firingRes?.total === "number"
          ? firingRes.total
          : items.filter((i) => i.status === "firing").length;

    setIncidents(items);
    setIncidentsTotal(total);
    setFiringTotal(activeFiring);
    onActiveCountChangeRef.current(activeFiring);
  }, [incidentFilter, pageOffset]);

  const refreshAll = useCallback(async () => {
    setLoadError(null);
    try {
      await Promise.all([loadIncidentsData(), loadRulesAndChannels()]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载告警数据失败");
    } finally {
      setLoading(false);
    }
  }, [loadIncidentsData, loadRulesAndChannels]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll, alertVersion]);

  const handleFilterChange = (next: IncidentFilter) => {
    setIncidentFilter(next);
    setPageOffset(0);
  };

  const openCreateRuleModal = () => {
    setEditingRule(null);
    setRuleMetric("cpu");
    setRuleName(METRIC_DEFAULT_NAME.cpu);
    setRuleNodeId("");
    setRuleOperator("gte");
    setRuleThreshold(90);
    setRuleDurationSec(120);
    setRuleCooldownSec(1800);
    setRuleChannelIds(channels.filter((c) => c.enabled).map((c) => c.id));
    setRuleFormError(null);
    setRuleModalOpen(true);
  };

  const openEditRuleModal = (rule: AlertRule) => {
    setEditingRule(rule);
    setRuleName(rule.name);
    setRuleNodeId(rule.node_id ?? "");
    setRuleMetric(rule.metric);
    setRuleOperator(rule.operator);
    setRuleThreshold(rule.threshold);
    setRuleDurationSec(rule.duration_sec);
    setRuleCooldownSec(rule.cooldown_sec);
    setRuleChannelIds(rule.channel_ids);
    setRuleFormError(null);
    setRuleModalOpen(true);
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRule) return;
    const cleanName = ruleName.trim() || METRIC_DEFAULT_NAME[ruleMetric];

    setSavingRule(true);
    setRuleFormError(null);
    try {
      const payload = {
        name: cleanName,
        node_id: ruleNodeId ? ruleNodeId : null,
        metric: ruleMetric,
        operator: ruleOperator,
        threshold: Math.max(1, Number(ruleThreshold) || 1),
        duration_sec:
          ruleMetric === "offline"
            ? 0
            : Math.max(0, Math.round(Number(ruleDurationSec) || 0)),
        cooldown_sec: Math.max(60, Math.round(Number(ruleCooldownSec) || 300)),
        channel_ids: ruleChannelIds,
        enabled: editingRule ? editingRule.enabled : true,
      };

      if (editingRule) {
        const res = await api.updateRule(editingRule.id, payload);
        setRules((prev) =>
          prev.map((r) => (r.id === editingRule.id ? res.rule : r)),
        );
        onNotify("success", `已更新规则：${res.rule.name}`);
      } else {
        const res = await api.createRule(payload);
        setRules((prev) => [res.rule, ...prev]);
        onNotify("success", `已新建规则：${res.rule.name}`);
      }
      setRuleModalOpen(false);
    } catch (err) {
      setRuleFormError(err instanceof Error ? err.message : "保存规则失败");
    } finally {
      setSavingRule(false);
    }
  };

  const handleToggleRule = async (rule: AlertRule) => {
    if (busyRuleId === rule.id) return;
    setBusyRuleId(rule.id);
    try {
      const res = await api.updateRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? res.rule : r)));
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "切换规则状态失败",
      );
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleApplyPresets = async () => {
    if (applyingPresets) return;
    setApplyingPresets(true);
    try {
      const enabledIds = channels.filter((c) => c.enabled).map((c) => c.id);
      const res = await api.applyRulePresets(enabledIds);
      if (Array.isArray(res?.rules)) {
        await loadRulesAndChannels();
      }
      onNotify("success", "已导入推荐触发规则");
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "导入推荐规则失败",
      );
    } finally {
      setApplyingPresets(false);
    }
  };

  const openCreateChannelModal = () => {
    setEditingChannel(null);
    setChType("telegram");
    setChName("");
    setChBotToken("");
    setChChatId("");
    setChThreadId("");
    setChWebhookUrl("");
    setChWebhookSecret("");
    setChannelFormError(null);
    setChannelModalOpen(true);
  };

  const openEditChannelModal = (ch: NotificationChannel) => {
    setEditingChannel(ch);
    setChType(ch.type);
    setChName(ch.name);
    setChBotToken(ch.config.bot_token ?? "");
    setChChatId(ch.config.chat_id ?? "");
    setChThreadId(
      ch.config.thread_id !== null && ch.config.thread_id !== undefined
        ? String(ch.config.thread_id)
        : "",
    );
    setChWebhookUrl(ch.config.url ?? "");
    setChWebhookSecret(ch.config.secret ?? "");
    setChannelFormError(null);
    setChannelModalOpen(true);
  };

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingChannel) return;
    const cleanName =
      chName.trim() || (chType === "telegram" ? "Telegram 通知" : "Webhook 通知");

    if (chType === "telegram") {
      if (!chBotToken.trim() || !chChatId.trim()) {
        setChannelFormError("请填写 Telegram Bot Token 与 Chat ID");
        return;
      }
    } else if (!chWebhookUrl.trim()) {
      setChannelFormError("请填写 Webhook 接收地址");
      return;
    }

    const parsedThread = chThreadId.trim() ? Number(chThreadId.trim()) : null;
    const config =
      chType === "telegram"
        ? {
            bot_token: chBotToken.trim(),
            chat_id: chChatId.trim(),
            thread_id:
              parsedThread !== null && Number.isFinite(parsedThread)
                ? parsedThread
                : null,
          }
        : {
            url: chWebhookUrl.trim(),
            ...(chWebhookSecret.trim()
              ? { secret: chWebhookSecret.trim() }
              : {}),
          };

    setSavingChannel(true);
    setChannelFormError(null);
    try {
      if (editingChannel) {
        const res = await api.updateChannel(editingChannel.id, {
          name: cleanName,
          type: chType,
          config,
        });
        setChannels((prev) =>
          prev.map((c) => (c.id === editingChannel.id ? res.channel : c)),
        );
        onNotify("success", `已更新渠道：${res.channel.name}`);
      } else {
        const res = await api.createChannel({
          name: cleanName,
          type: chType,
          enabled: true,
          config,
        });
        setChannels((prev) => [...prev, res.channel]);
        onNotify("success", `已添加渠道：${res.channel.name}`);
      }
      setChannelModalOpen(false);
    } catch (err) {
      setChannelFormError(
        err instanceof Error ? err.message : "保存通知渠道失败",
      );
    } finally {
      setSavingChannel(false);
    }
  };

  const handleToggleChannel = async (ch: NotificationChannel) => {
    if (busyChannelId === ch.id) return;
    setBusyChannelId(ch.id);
    try {
      const res = await api.updateChannel(ch.id, { enabled: !ch.enabled });
      setChannels((prev) =>
        prev.map((c) => (c.id === ch.id ? res.channel : c)),
      );
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "更新通知渠道状态失败",
      );
    } finally {
      setBusyChannelId(null);
    }
  };

  const handleTestChannel = async (ch: NotificationChannel) => {
    if (testingChannelId === ch.id) return;
    setTestingChannelId(ch.id);
    try {
      const res = await api.testChannel(ch.id);
      if (res.ok) {
        setTestedChannelIds((prev) => ({ ...prev, [ch.id]: true }));
        onNotify("success", `测试通知已送达 ${ch.name}`);
        window.setTimeout(() => {
          setTestedChannelIds((prev) => ({ ...prev, [ch.id]: false }));
        }, 2200);
      } else {
        onNotify("danger", "发送测试通知失败", res.error);
      }
    } catch (err) {
      onNotify(
        "danger",
        "发送测试通知失败",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setTestingChannelId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || deletingItem) return;
    setDeletingItem(true);
    try {
      if (pendingDelete.kind === "rule") {
        await api.deleteRule(pendingDelete.item.id);
        setRules((prev) => prev.filter((r) => r.id !== pendingDelete.item.id));
        onNotify("info", `已删除规则：${pendingDelete.item.name}`);
      } else {
        await api.deleteChannel(pendingDelete.item.id);
        setChannels((prev) =>
          prev.filter((c) => c.id !== pendingDelete.item.id),
        );
        onNotify("info", `已删除渠道：${pendingDelete.item.name}`);
      }
      setPendingDelete(null);
    } catch (err) {
      onNotify("danger", err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingItem(false);
    }
  };

  const handleToggleIncidentMute = async (nodeId: string) => {
    const target = nodeMap.get(nodeId);
    if (!target || busyMuteNodeId === nodeId) return;
    setBusyMuteNodeId(nodeId);
    try {
      const muted = isNodeMuted(target);
      await onMuteNode(nodeId, muted ? null : 3600);
    } catch {
      // Handled by App toast
    } finally {
      setBusyMuteNodeId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Clean Header */}
      <SectionHeader
        title="告警通知"
        badge={
          firingTotal > 0 ? (
            <Badge tone="danger">{firingTotal} 项告警中</Badge>
          ) : (
            <Badge tone="ok">全部正常</Badge>
          )
        }
        actions={
          activeTab === "timeline" ? (
            <SegmentedControl<IncidentFilter>
              ariaLabel="筛选告警状态"
              value={incidentFilter}
              onChange={handleFilterChange}
              options={[
                { value: "all", label: "全部" },
                { value: "firing", label: "告警中", badge: firingTotal },
                { value: "resolved", label: "已恢复" },
              ]}
            />
          ) : activeTab === "rules" ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={applyingPresets}
                icon={
                  applyingPresets ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  )
                }
                onClick={() => void handleApplyPresets()}
              >
                推荐规则
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={openCreateRuleModal}
              >
                新建规则
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={openCreateChannelModal}
            >
              添加渠道
            </Button>
          )
        }
      />

      {loadError && (
        <div
          role="alert"
          style={{
            backgroundColor: "var(--status-danger-bg)",
            border: "1px solid var(--status-danger-border)",
            color: "var(--status-danger-ink)",
          }}
          className="flex items-center justify-between gap-3 rounded-[10px] px-4 py-2.5 text-[12.5px]"
        >
          <span>{loadError}</span>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => void refreshAll()}
          >
            重试
          </Button>
        </div>
      )}

      {/* Sub-view Tabs */}
      <TabBar<AlertSubTab>
        ariaLabel="告警模块切换"
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: "timeline", label: "告警记录", count: incidentsTotal },
          { id: "rules", label: "触发规则", count: rules.length },
          { id: "channels", label: "通知渠道", count: channels.length },
        ]}
      />

      {/* Tab 1: 告警记录 (Single clean visual row per incident, zero prose) */}
      <div role="tabpanel" hidden={activeTab !== "timeline"}>
        <Card padded={false} className="overflow-hidden">
          {loading ? (
            <div
              style={{ color: "var(--text-secondary)" }}
              className="flex items-center justify-center gap-2 py-14 text-[13px]"
            >
              <Loader2
                style={{ color: "var(--accent)" }}
                className="h-4 w-4 animate-spin"
                aria-hidden="true"
              />
              <span>正在加载告警记录…</span>
            </div>
          ) : incidents.length === 0 ? (
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="flex flex-col items-center justify-center gap-2 py-14 text-[13px]"
            >
              <Bell className="h-5 w-5 opacity-50" aria-hidden="true" />
              <span>当前没有匹配的告警记录</span>
            </div>
          ) : (
            <>
              <div className="divide-y divide-[var(--border-hairline)]">
                {incidents.map((inc) => {
                  const isFiring = inc.status === "firing";
                  const targetNode = nodeMap.get(inc.node_id) ?? null;
                  const muted = targetNode ? isNodeMuted(targetNode) : false;
                  const shortTag = SHORT_INCIDENT_TAG[inc.metric] ?? inc.metric;
                  const isPctMetric =
                    inc.metric !== "offline" &&
                    inc.metric !== "watchdog" &&
                    inc.trigger_value !== null &&
                    Number.isFinite(inc.trigger_value);

                  return (
                    <div
                      key={inc.id}
                      className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      {/* Left: Status dot + Server name + Short tag */}
                      <div className="flex min-w-[220px] items-center gap-3">
                        <StatusDot
                          tone={isFiring ? "danger" : "ok"}
                          pulse={isFiring && !muted}
                        />
                        <span
                          style={{ color: "var(--text-primary)" }}
                          className="text-[13.5px] font-semibold"
                        >
                          {inc.node_name}
                        </span>
                        <Badge
                          tone={
                            isFiring
                              ? inc.metric === "offline"
                                ? "danger"
                                : "warn"
                              : "neutral"
                          }
                        >
                          {shortTag}
                        </Badge>
                        {muted && <Badge tone="subtle">已静音</Badge>}
                      </div>

                      {/* Middle: Compact visual meter + crisp reading */}
                      <div className="flex flex-1 items-center justify-end gap-5 sm:justify-center">
                        {isPctMetric && inc.trigger_value !== null ? (
                          <div className="flex w-44 items-center gap-2.5">
                            <MetricBar
                              valuePct={inc.trigger_value}
                              toneOverride={isFiring ? "danger" : "ok"}
                              thickness={4}
                              className="flex-1"
                            />
                            <span
                              style={{
                                color: isFiring
                                  ? "var(--status-danger-ink)"
                                  : "var(--text-primary)",
                              }}
                              className="font-mono-num tabular-nums w-12 text-right text-[13px] font-semibold"
                            >
                              {inc.trigger_value.toFixed(1)}%
                            </span>
                          </div>
                        ) : (
                          <span
                            style={{
                              color: isFiring
                                ? "var(--status-danger-ink)"
                                : "var(--text-secondary)",
                            }}
                            className="font-mono-num tabular-nums text-[13px] font-semibold"
                          >
                            {inc.metric === "offline"
                              ? inc.trigger_value !== null
                                ? `离线 ${formatDurationZh(inc.trigger_value)}`
                                : "连接中断"
                              : isFiring
                                ? "告警中"
                                : "已恢复"}
                          </span>
                        )}
                      </div>

                      {/* Right: Relative time + 查看 / 静音 */}
                      <div className="flex items-center gap-2">
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="font-mono-num tabular-nums mr-1 text-[12px]"
                        >
                          {formatRelativeTime(
                            isFiring
                              ? inc.started_at
                              : (inc.resolved_at ?? inc.started_at),
                          )}
                        </span>
                        {targetNode && (
                          <>
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => onSelectNode(targetNode, "charts")}
                            >
                              查看
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busyMuteNodeId === targetNode.id}
                              icon={
                                muted ? (
                                  <VolumeX
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Volume2
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                )
                              }
                              onClick={() =>
                                void handleToggleIncidentMute(targetNode.id)
                              }
                            >
                              {muted ? "取消静音" : "静音"}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {incidentsTotal > PAGE_SIZE && (
                <div
                  style={{ borderTop: "1px solid var(--border-hairline)" }}
                  className="flex items-center justify-between px-5 py-3 text-[12px]"
                >
                  <span
                    style={{ color: "var(--text-tertiary)" }}
                    className="font-mono-num tabular-nums"
                  >
                    {pageOffset + 1}–
                    {Math.min(pageOffset + PAGE_SIZE, incidentsTotal)} /{" "}
                    {incidentsTotal}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={pageOffset === 0}
                      icon={
                        <ChevronLeft
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                      }
                      onClick={() =>
                        setPageOffset((p) => Math.max(0, p - PAGE_SIZE))
                      }
                    >
                      上一页
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={pageOffset + PAGE_SIZE >= incidentsTotal}
                      icon={
                        <ChevronRight
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                      }
                      onClick={() => setPageOffset((p) => p + PAGE_SIZE)}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {/* Tab 2: 触发规则 */}
      <div role="tabpanel" hidden={activeTab !== "rules"}>
        {rules.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-3 py-14 text-center">
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="text-[13px]"
            >
              暂未配置触发规则
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={applyingPresets}
                icon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={() => void handleApplyPresets()}
              >
                一键导入推荐规则
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={openCreateRuleModal}
              >
                新建规则
              </Button>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rules.map((rule) => {
              const scopeNode = rule.node_id
                ? nodeMap.get(rule.node_id)
                : null;
              const scopeLabel = rule.node_id
                ? (scopeNode?.name ?? "指定服务器")
                : "全部服务器";

              return (
                <Card
                  key={rule.id}
                  className="flex flex-col justify-between gap-4 p-5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      style={{ color: "var(--text-primary)" }}
                      className="truncate text-[14px] font-semibold"
                    >
                      {rule.name}
                    </span>
                    <Switch
                      checked={rule.enabled}
                      disabled={busyRuleId === rule.id}
                      onChange={() => void handleToggleRule(rule)}
                      ariaLabel={`启用规则 ${rule.name}`}
                    />
                  </div>

                  <div
                    style={{ color: "var(--text-primary)" }}
                    className="font-mono-num tabular-nums py-1 text-[26px] leading-none font-semibold tracking-[-0.02em]"
                  >
                    {rule.metric === "offline"
                      ? formatDurationZh(rule.threshold)
                      : `${rule.threshold}%`}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral">{scopeLabel}</Badge>
                      {rule.metric !== "offline" && rule.duration_sec > 0 && (
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="font-mono-num text-[11.5px]"
                        >
                          持续 {formatDurationZh(rule.duration_sec)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`编辑规则 ${rule.name}`}
                        icon={
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        }
                        onClick={() => openEditRuleModal(rule)}
                      />
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`删除规则 ${rule.name}`}
                        icon={
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        }
                        onClick={() =>
                          setPendingDelete({ kind: "rule", item: rule })
                        }
                      />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Tab 3: 通知渠道 */}
      <div role="tabpanel" hidden={activeTab !== "channels"}>
        {channels.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-3 py-14 text-center">
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="text-[13px]"
            >
              暂未添加通知渠道
            </span>
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={openCreateChannelModal}
            >
              添加通知渠道
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
            {channels.map((ch) => {
              const isTested = Boolean(testedChannelIds[ch.id]);
              const isTesting = testingChannelId === ch.id;

              return (
                <Card
                  key={ch.id}
                  className="flex items-center justify-between gap-4 p-4"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px]"
                    >
                      {ch.type === "telegram" ? (
                        <MessageSquare
                          className="h-4 w-4"
                          aria-hidden="true"
                        />
                      ) : (
                        <Webhook className="h-4 w-4" aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="truncate text-[14px] font-semibold"
                      >
                        {ch.name}
                      </div>
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="font-mono-num truncate text-[12px]"
                      >
                        {formatChannelTarget(ch)}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="xs"
                      variant={isTested ? "accent" : "secondary"}
                      disabled={!ch.enabled || isTesting}
                      icon={
                        isTesting ? (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : isTested ? (
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Send className="h-3.5 w-3.5" aria-hidden="true" />
                        )
                      }
                      onClick={() => void handleTestChannel(ch)}
                    >
                      {isTested ? "已送达" : "测试"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`编辑渠道 ${ch.name}`}
                      icon={
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      }
                      onClick={() => openEditChannelModal(ch)}
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`删除渠道 ${ch.name}`}
                      icon={
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      }
                      onClick={() =>
                        setPendingDelete({ kind: "channel", item: ch })
                      }
                    />
                    <Switch
                      checked={ch.enabled}
                      disabled={busyChannelId === ch.id}
                      onChange={() => void handleToggleChannel(ch)}
                      ariaLabel={`启用渠道 ${ch.name}`}
                    />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Create / Edit Rule Modal */}
      <NativeDialog
        open={ruleModalOpen}
        onClose={() => {
          if (!savingRule) setRuleModalOpen(false);
        }}
        titleId={ruleModalTitleId}
        maxWidthClass="max-w-[440px]"
      >
        <form onSubmit={(e) => void handleSaveRule(e)} className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h3
              id={ruleModalTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              {editingRule ? "编辑触发规则" : "新建触发规则"}
            </h3>
            <IconCloseButton
              onClick={() => {
                if (!savingRule) setRuleModalOpen(false);
              }}
            />
          </div>

          {ruleFormError && (
            <div
              role="alert"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                border: "1px solid var(--status-danger-border)",
                color: "var(--status-danger-ink)",
              }}
              className="rounded-[8px] px-3 py-2 text-[12px]"
            >
              {ruleFormError}
            </div>
          )}

          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="rule-metric"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  监控项
                </label>
                <select
                  id="rule-metric"
                  value={ruleMetric}
                  onChange={(e) => {
                    const nextMetric = e.target.value as AlertMetric;
                    setRuleMetric(nextMetric);
                    if (!editingRule) {
                      setRuleName(METRIC_DEFAULT_NAME[nextMetric]);
                      setRuleThreshold(nextMetric === "offline" ? 180 : 90);
                    }
                  }}
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px]"
                >
                  <option value="cpu">CPU 使用率</option>
                  <option value="mem">内存使用率</option>
                  <option value="disk">磁盘使用率</option>
                  <option value="swap">交换区使用率</option>
                  <option value="steal">CPU 争抢率</option>
                  <option value="traffic_pct">月流量占比</option>
                  <option value="offline">离线时长</option>
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="rule-scope"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  适用范围
                </label>
                <select
                  id="rule-scope"
                  value={ruleNodeId}
                  onChange={(e) => setRuleNodeId(e.target.value)}
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px]"
                >
                  <option value="">全部服务器</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="rule-name"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                规则名称
              </label>
              <input
                id="rule-name"
                type="text"
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
              />
            </div>

            {ruleMetric !== "offline" ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[12px]">
                  <span style={{ color: "var(--text-secondary)" }}>
                    触发阈值
                  </span>
                  <span
                    style={{ color: "var(--text-primary)" }}
                    className="font-mono-num tabular-nums font-semibold"
                  >
                    {ruleThreshold}%
                  </span>
                </div>
                <input
                  type="range"
                  min={20}
                  max={99}
                  value={Math.min(99, Math.max(20, ruleThreshold))}
                  onChange={(e) => setRuleThreshold(Number(e.target.value))}
                  style={{ accentColor: "var(--ink-primary)" }}
                  className="w-full cursor-pointer"
                />
              </div>
            ) : (
              <div className="space-y-1">
                <label
                  htmlFor="rule-offline-sec"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  离线判定时长（秒）
                </label>
                <input
                  id="rule-offline-sec"
                  type="number"
                  min={30}
                  max={86400}
                  value={ruleThreshold}
                  onChange={(e) =>
                    setRuleThreshold(Math.max(30, Number(e.target.value) || 30))
                  }
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {ruleMetric !== "offline" && (
                <div className="space-y-1">
                  <label
                    htmlFor="rule-duration-sec"
                    style={{ color: "var(--text-secondary)" }}
                    className="block text-[12px] font-medium"
                  >
                    持续时间（秒）
                  </label>
                  <input
                    id="rule-duration-sec"
                    type="number"
                    min={0}
                    max={3600}
                    value={ruleDurationSec}
                    onChange={(e) =>
                      setRuleDurationSec(
                        Math.max(0, Number(e.target.value) || 0),
                      )
                    }
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                    }}
                    className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                  />
                </div>
              )}

              <div
                className={`space-y-1 ${ruleMetric === "offline" ? "col-span-2" : ""}`}
              >
                <label
                  htmlFor="rule-cooldown-sec"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  通知冷却间隔（秒）
                </label>
                <input
                  id="rule-cooldown-sec"
                  type="number"
                  min={60}
                  max={86400}
                  value={ruleCooldownSec}
                  onChange={(e) =>
                    setRuleCooldownSec(
                      Math.max(60, Number(e.target.value) || 60),
                    )
                  }
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>
            </div>

            {channels.length > 0 && (
              <div className="space-y-1.5">
                <span
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  关联通知渠道
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((ch) => {
                    const checked = ruleChannelIds.includes(ch.id);
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        aria-pressed={checked}
                        onClick={() =>
                          setRuleChannelIds((prev) =>
                            checked
                              ? prev.filter((id) => id !== ch.id)
                              : [...prev, ch.id],
                          )
                        }
                        style={
                          checked
                            ? {
                                backgroundColor: "var(--ink-primary)",
                                color: "var(--ink-on-primary)",
                              }
                            : {
                                backgroundColor: "var(--bg-subtle)",
                                color: "var(--text-secondary)",
                                border: "1px solid var(--border-hairline)",
                              }
                        }
                        className="h-7 cursor-pointer rounded-[6px] px-2.5 text-[12px] font-medium transition-colors"
                      >
                        {ch.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={savingRule}
              onClick={() => setRuleModalOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={savingRule}
              icon={
                savingRule ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : undefined
              }
            >
              {savingRule ? "保存中..." : "保存规则"}
            </Button>
          </div>
        </form>
      </NativeDialog>

      {/* Create / Edit Channel Modal */}
      <NativeDialog
        open={channelModalOpen}
        onClose={() => {
          if (!savingChannel) setChannelModalOpen(false);
        }}
        titleId={channelModalTitleId}
        maxWidthClass="max-w-[440px]"
      >
        <form
          onSubmit={(e) => void handleSaveChannel(e)}
          className="space-y-4 p-5"
        >
          <div className="flex items-center justify-between">
            <h3
              id={channelModalTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              {editingChannel ? "编辑通知渠道" : "添加通知渠道"}
            </h3>
            <IconCloseButton
              onClick={() => {
                if (!savingChannel) setChannelModalOpen(false);
              }}
            />
          </div>

          {channelFormError && (
            <div
              role="alert"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                border: "1px solid var(--status-danger-border)",
                color: "var(--status-danger-ink)",
              }}
              className="rounded-[8px] px-3 py-2 text-[12px]"
            >
              {channelFormError}
            </div>
          )}

          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor="ch-type"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                渠道类型
              </label>
              <select
                id="ch-type"
                value={chType}
                onChange={(e) =>
                  setChType(e.target.value as "telegram" | "webhook")
                }
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-9 w-full rounded-[8px] px-3 text-[13px]"
              >
                <option value="telegram">Telegram 机器人</option>
                <option value="webhook">Webhook（飞书 / 企业微信 / Bark）</option>
              </select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="ch-name"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                渠道名称
              </label>
              <input
                id="ch-name"
                type="text"
                required
                value={chName}
                onChange={(e) => setChName(e.target.value)}
                placeholder={
                  chType === "telegram" ? "例如：运维告警群" : "例如：飞书通知群"
                }
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
              />
            </div>

            {chType === "telegram" ? (
              <>
                <div className="space-y-1">
                  <label
                    htmlFor="ch-bot-token"
                    style={{ color: "var(--text-secondary)" }}
                    className="block text-[12px] font-medium"
                  >
                    Bot Token
                  </label>
                  <input
                    id="ch-bot-token"
                    type="password"
                    required
                    value={chBotToken}
                    onChange={(e) => setChBotToken(e.target.value)}
                    placeholder="123456789:ABCdefGHIjklMNO..."
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                    }}
                    className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label
                      htmlFor="ch-chat-id"
                      style={{ color: "var(--text-secondary)" }}
                      className="block text-[12px] font-medium"
                    >
                      Chat ID
                    </label>
                    <input
                      id="ch-chat-id"
                      type="text"
                      required
                      value={chChatId}
                      onChange={(e) => setChChatId(e.target.value)}
                      placeholder="-100123456789"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-subtle)",
                      }}
                      className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="ch-thread-id"
                      style={{ color: "var(--text-secondary)" }}
                      className="block text-[12px] font-medium"
                    >
                      话题 ID（选填）
                    </label>
                    <input
                      id="ch-thread-id"
                      type="number"
                      value={chThreadId}
                      onChange={(e) => setChThreadId(e.target.value)}
                      placeholder="留空默认主群"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-subtle)",
                      }}
                      className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <label
                    htmlFor="ch-webhook-url"
                    style={{ color: "var(--text-secondary)" }}
                    className="block text-[12px] font-medium"
                  >
                    Webhook 地址
                  </label>
                  <input
                    id="ch-webhook-url"
                    type="url"
                    required
                    value={chWebhookUrl}
                    onChange={(e) => setChWebhookUrl(e.target.value)}
                    placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                    }}
                    className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="ch-webhook-secret"
                    style={{ color: "var(--text-secondary)" }}
                    className="block text-[12px] font-medium"
                  >
                    签名密钥（选填）
                  </label>
                  <input
                    id="ch-webhook-secret"
                    type="password"
                    value={chWebhookSecret}
                    onChange={(e) => setChWebhookSecret(e.target.value)}
                    placeholder="留空则不附带签名"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                    }}
                    className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                  />
                </div>
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={savingChannel}
              onClick={() => setChannelModalOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={savingChannel}
              icon={
                savingChannel ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : undefined
              }
            >
              {savingChannel ? "保存中..." : "保存渠道"}
            </Button>
          </div>
        </form>
      </NativeDialog>

      {/* Delete Rule / Channel Confirmation Modal */}
      <NativeDialog
        open={pendingDelete !== null}
        onClose={() => {
          if (!deletingItem) setPendingDelete(null);
        }}
        titleId={deleteConfirmTitleId}
        maxWidthClass="max-w-[380px]"
      >
        {pendingDelete && (
          <div className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h3
                id={deleteConfirmTitleId}
                style={{ color: "var(--text-primary)" }}
                className="text-[15px] font-semibold"
              >
                确认删除
              </h3>
              <IconCloseButton
                onClick={() => {
                  if (!deletingItem) setPendingDelete(null);
                }}
              />
            </div>

            <p
              style={{ color: "var(--text-secondary)" }}
              className="text-[13px] leading-relaxed"
            >
              确认删除
              {pendingDelete.kind === "rule" ? "触发规则 " : "通知渠道 "}
              <strong style={{ color: "var(--text-primary)" }}>
                {pendingDelete.item.name}
              </strong>
              ？
            </p>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={deletingItem}
                onClick={() => setPendingDelete(null)}
              >
                取消
              </Button>
              <Button
                autoFocus
                variant="danger"
                size="sm"
                disabled={deletingItem}
                icon={
                  deletingItem ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : undefined
                }
                onClick={() => void handleConfirmDelete()}
              >
                {deletingItem ? "删除中..." : "确认删除"}
              </Button>
            </div>
          </div>
        )}
      </NativeDialog>
    </div>
  );
}

export default AlertsCenterView;
