import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Edit3,
  ExternalLink,
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
import { api } from "../api/client";
import type {
  AlertIncident,
  AlertMetric,
  AlertOperator,
  AlertRule,
  HorizonNode,
  InspectorTab,
  NotificationChannel,
} from "../types";
import {
  formatAlertCondition,
  formatAlertMetric,
  formatAlertStatus,
  formatDurationZh,
  formatRelativeTime,
  formatTimestamp,
  isNodeMuted,
} from "../utils/format";

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

type AlertsTab = "incidents" | "rules" | "channels";
type IncidentFilter = "all" | "firing" | "resolved";

const INCIDENTS_PAGE_SIZE = 50;

const METRIC_LABELS: Record<AlertMetric, string> = {
  offline: "服务器离线时长 (秒)",
  cpu: "处理器占用 (%)",
  steal: "CPU 宿主机争抢 (%)",
  mem: "内存占用 (%)",
  swap: "虚拟内存占用 (%)",
  disk: "磁盘空间占用 (%)",
  traffic_pct: "月流量使用率 (%)",
};

const DEFAULT_THRESHOLD_BY_METRIC: Record<AlertMetric, string> = {
  offline: "180",
  cpu: "90",
  steal: "25",
  mem: "90",
  swap: "80",
  disk: "85",
  traffic_pct: "85",
};

function maskToken(val?: string): string {
  if (!val) return "—";
  if (val.length <= 10) return "••••••••";
  return `${val.slice(0, 6)}••••${val.slice(-4)}`;
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

function formatMetricValue(metric: string, value: number): string {
  if (metric === "offline") {
    return formatDurationZh(value);
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

export function AlertsCenterView({
  nodes,
  alertVersion,
  onSelectNode,
  onMuteNode,
  onActiveCountChange,
  onNotify,
}: AlertsCenterViewProps) {
  const [activeTab, setActiveTab] = useState<AlertsTab>("incidents");
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>("all");
  const [incidentOffset, setIncidentOffset] = useState(0);

  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [incidents, setIncidents] = useState<AlertIncident[]>([]);
  const [incidentsTotal, setIncidentsTotal] = useState(0);
  const [firingCount, setFiringCount] = useState(0);

  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadingIncidents, setLoadingIncidents] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [incidentsError, setIncidentsError] = useState<string | null>(null);
  const [applyingPresets, setApplyingPresets] = useState(false);

  const [mutingNodeId, setMutingNodeId] = useState<string | null>(null);

  // Rule form state
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleNodeId, setRuleNodeId] = useState<string>("ALL");
  const [ruleMetric, setRuleMetric] = useState<AlertMetric>("cpu");
  const [ruleOperator, setRuleOperator] = useState<AlertOperator>("gt");
  const [ruleThreshold, setRuleThreshold] = useState("90");
  const [ruleDurationSec, setRuleDurationSec] = useState("120");
  const [ruleCooldownSec, setRuleCooldownSec] = useState("1800");
  const [ruleChannelIds, setRuleChannelIds] = useState<string[]>([]);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);
  const [confirmDeleteRuleId, setConfirmDeleteRuleId] = useState<string | null>(
    null,
  );
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  // Channel form state
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [chName, setChName] = useState("");
  const [chType, setChType] = useState<"telegram" | "webhook">("telegram");
  const [chBotToken, setChBotToken] = useState("");
  const [chChatId, setChChatId] = useState("");
  const [chThreadId, setChThreadId] = useState("");
  const [chWebhookUrl, setChWebhookUrl] = useState("");
  const [chWebhookSecret, setChWebhookSecret] = useState("");
  const [chError, setChError] = useState<string | null>(null);
  const [savingChannel, setSavingChannel] = useState(false);
  const [togglingChannelId, setTogglingChannelId] = useState<string | null>(
    null,
  );
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);
  const [confirmDeleteChannelId, setConfirmDeleteChannelId] = useState<
    string | null
  >(null);
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(
    null,
  );

  const tabRefs = useRef<Record<AlertsTab, HTMLButtonElement | null>>({
    incidents: null,
    rules: null,
    channels: null,
  });
  const onActiveCountChangeRef = useRef(onActiveCountChange);
  onActiveCountChangeRef.current = onActiveCountChange;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const incidentsReqIdRef = useRef(0);
  const metaReqIdRef = useRef(0);
  const testFeedbackTimerRef = useRef<number | null>(null);

  const loadMeta = useCallback(async () => {
    const reqId = ++metaReqIdRef.current;
    setLoadingMeta(true);
    setMetaError(null);
    try {
      const [channelsRes, rulesRes] = await Promise.all([
        api.getChannels(),
        api.getRules(),
      ]);
      if (reqId !== metaReqIdRef.current) return;
      setChannels(channelsRes.channels);
      setRules(rulesRes.rules);
    } catch (err) {
      if (reqId !== metaReqIdRef.current) return;
      setMetaError(getErrorMessage(err, "加载告警规则与通知渠道失败"));
    } finally {
      if (reqId === metaReqIdRef.current) {
        setLoadingMeta(false);
      }
    }
  }, []);

  const loadIncidents = useCallback(
    async (filter: IncidentFilter, offset: number) => {
      const reqId = ++incidentsReqIdRef.current;
      setLoadingIncidents(true);
      setIncidentsError(null);
      try {
        const res = await api.getIncidents({
          status: filter,
          limit: INCIDENTS_PAGE_SIZE,
          offset,
        });
        if (reqId !== incidentsReqIdRef.current) return;
        setIncidents(res.incidents);
        setIncidentsTotal(res.total);

        if (filter === "firing") {
          setFiringCount(res.total);
          onActiveCountChangeRef.current(res.total);
        } else if (
          filter === "all" &&
          offset === 0 &&
          res.total <= res.incidents.length
        ) {
          const active = res.incidents.filter(
            (inc) => inc.status.toLowerCase() === "firing",
          ).length;
          setFiringCount(active);
          onActiveCountChangeRef.current(active);
        } else {
          try {
            const firingRes = await api.getIncidents({
              status: "firing",
              limit: 1,
              offset: 0,
            });
            if (reqId !== incidentsReqIdRef.current) return;
            setFiringCount(firingRes.total);
            onActiveCountChangeRef.current(firingRes.total);
          } catch {
            // Keep previously synced firing count if auxiliary count check fails
          }
        }
      } catch (err) {
        if (reqId !== incidentsReqIdRef.current) return;
        setIncidentsError(getErrorMessage(err, "加载告警事件历史失败"));
      } finally {
        if (reqId === incidentsReqIdRef.current) {
          setLoadingIncidents(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    void loadIncidents(incidentFilter, incidentOffset);
  }, [alertVersion, incidentFilter, incidentOffset, loadIncidents]);

  useEffect(() => {
    return () => {
      if (testFeedbackTimerRef.current !== null) {
        window.clearTimeout(testFeedbackTimerRef.current);
      }
    };
  }, []);

  const nodeMap = useMemo(() => {
    const map = new Map<string, HorizonNode>();
    for (const node of nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);

  const ruleMap = useMemo(() => {
    const map = new Map<string, AlertRule>();
    for (const rule of rules) {
      map.set(rule.id, rule);
    }
    return map;
  }, [rules]);

  const enabledRulesCount = useMemo(
    () => rules.filter((r) => r.enabled).length,
    [rules],
  );
  const enabledChannelsCount = useMemo(
    () => channels.filter((c) => c.enabled).length,
    [channels],
  );
  const enabledChannelIds = useMemo(
    () => channels.filter((c) => c.enabled).map((c) => c.id),
    [channels],
  );

  const handleRefreshIncidents = () => {
    void loadIncidents(incidentFilter, incidentOffset);
    void loadMeta();
  };

  const handleIncidentFilterChange = (nextFilter: IncidentFilter) => {
    if (nextFilter === incidentFilter) return;
    setIncidentOffset(0);
    setIncidentFilter(nextFilter);
  };

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    current: AlertsTab,
  ) => {
    const order: AlertsTab[] = ["incidents", "rules", "channels"];
    const idx = order.indexOf(current);
    let nextIdx = -1;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % order.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (idx - 1 + order.length) % order.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = order.length - 1;
    if (nextIdx >= 0) {
      e.preventDefault();
      const target = order[nextIdx];
      setActiveTab(target);
      tabRefs.current[target]?.focus();
    }
  };

  const handleApplyPresets = async () => {
    if (applyingPresets) return;
    setApplyingPresets(true);
    try {
      const prevIds = new Set(rules.map((r) => r.id));
      const res = await api.applyRulePresets(enabledChannelIds);
      setRules(res.rules);
      const addedCount = res.rules.filter((r) => !prevIds.has(r.id)).length;
      if (addedCount > 0) {
        onNotifyRef.current(
          "success",
          `已启用 ${addedCount} 条黄金告警规则模板`,
          enabledChannelIds.length > 0
            ? `已自动绑定 ${enabledChannelIds.length} 个已启用通知渠道`
            : "当前暂无已启用通知渠道，稍后可在规则中勾选绑定渠道",
        );
      } else {
        onNotifyRef.current(
          "info",
          "6 项黄金规则模板已存在",
          "当前已有全部推荐规则，无需重复导入。",
        );
      }
      setActiveTab("rules");
    } catch (err) {
      onNotifyRef.current(
        "danger",
        "应用黄金规则模板失败",
        getErrorMessage(err, "请检查登录状态与网络后重试"),
      );
    } finally {
      setApplyingPresets(false);
    }
  };

  const handleMuteToggle = async (node: HorizonNode) => {
    if (mutingNodeId === node.id) return;
    const currentlyMuted = isNodeMuted(node);
    const nextSeconds = currentlyMuted ? null : 3600;
    setMutingNodeId(node.id);
    try {
      await onMuteNode(node.id, nextSeconds);
      onNotifyRef.current(
        "success",
        currentlyMuted ? "已恢复该节点告警通知" : "已静默该节点 1 小时",
        node.name,
      );
    } catch (err) {
      onNotifyRef.current(
        "danger",
        "节点静默设置失败",
        getErrorMessage(err, "请稍后重试"),
      );
    } finally {
      setMutingNodeId(null);
    }
  };

  // --- Rule CRUD handlers ---
  const openNewRuleForm = () => {
    setEditingRuleId(null);
    setRuleName("");
    setRuleNodeId("ALL");
    setRuleMetric("cpu");
    setRuleOperator("gt");
    setRuleThreshold(DEFAULT_THRESHOLD_BY_METRIC.cpu);
    setRuleDurationSec("120");
    setRuleCooldownSec("1800");
    setRuleChannelIds(enabledChannelIds);
    setRuleError(null);
    setShowRuleForm(true);
  };

  const openEditRuleForm = (rule: AlertRule) => {
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleNodeId(rule.node_id ?? "ALL");
    setRuleMetric(rule.metric);
    setRuleOperator(rule.operator);
    setRuleThreshold(String(rule.threshold));
    setRuleDurationSec(String(rule.duration_sec));
    setRuleCooldownSec(String(rule.cooldown_sec));
    setRuleChannelIds(rule.channel_ids);
    setRuleError(null);
    setShowRuleForm(true);
  };

  const toggleRuleChannel = (chId: string) => {
    setRuleChannelIds((prev) =>
      prev.includes(chId) ? prev.filter((id) => id !== chId) : [...prev, chId],
    );
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRule) return;
    const trimmedName = ruleName.trim();
    if (!trimmedName || trimmedName.length > 100) {
      setRuleError("请填写 1 至 100 个字符的规则名称");
      return;
    }
    const threshold = Number(ruleThreshold);
    const duration = Number(ruleDurationSec);
    const cooldown = Number(ruleCooldownSec);
    if (!Number.isFinite(threshold) || threshold < 0) {
      setRuleError("阈值必须为非负有效数值");
      return;
    }
    if (!Number.isFinite(duration) || duration < 0) {
      setRuleError("持续防抖时间必须为非负秒数");
      return;
    }
    if (!Number.isFinite(cooldown) || cooldown < 0) {
      setRuleError("冷却时间必须为非负秒数");
      return;
    }

    const payload = {
      name: trimmedName,
      node_id: ruleNodeId === "ALL" ? null : ruleNodeId,
      metric: ruleMetric,
      operator: ruleOperator,
      threshold,
      duration_sec: Math.round(duration),
      cooldown_sec: Math.round(cooldown),
      channel_ids: ruleChannelIds,
    };

    setSavingRule(true);
    setRuleError(null);
    try {
      if (editingRuleId) {
        const res = await api.updateRule(editingRuleId, payload);
        setRules((prev) =>
          prev.map((r) => (r.id === editingRuleId ? res.rule : r)),
        );
        onNotifyRef.current("success", "告警规则已更新", trimmedName);
      } else {
        const res = await api.createRule({ ...payload, enabled: true });
        setRules((prev) => [res.rule, ...prev]);
        onNotifyRef.current("success", "告警规则已创建", trimmedName);
      }
      setShowRuleForm(false);
      setEditingRuleId(null);
    } catch (err) {
      setRuleError(getErrorMessage(err, "保存告警规则失败"));
    } finally {
      setSavingRule(false);
    }
  };

  const handleToggleRuleEnabled = async (rule: AlertRule) => {
    if (togglingRuleId === rule.id) return;
    setTogglingRuleId(rule.id);
    try {
      const res = await api.updateRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? res.rule : r)));
      onNotifyRef.current(
        "info",
        res.rule.enabled ? "已启用规则" : "已停用规则",
        rule.name,
      );
    } catch (err) {
      onNotifyRef.current(
        "danger",
        "更新规则状态失败",
        getErrorMessage(err, "请稍后重试"),
      );
    } finally {
      setTogglingRuleId(null);
    }
  };

  const handleDeleteRule = async (rule: AlertRule) => {
    if (deletingRuleId === rule.id) return;
    setDeletingRuleId(rule.id);
    try {
      await api.deleteRule(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      setConfirmDeleteRuleId(null);
      if (editingRuleId === rule.id) {
        setShowRuleForm(false);
        setEditingRuleId(null);
      }
      onNotifyRef.current("info", "已删除告警规则", rule.name);
    } catch (err) {
      onNotifyRef.current(
        "danger",
        "删除告警规则失败",
        getErrorMessage(err, "请稍后重试"),
      );
    } finally {
      setDeletingRuleId(null);
    }
  };

  // --- Channel CRUD handlers ---
  const openNewChannelForm = () => {
    setEditingChannelId(null);
    setChName("");
    setChType("telegram");
    setChBotToken("");
    setChChatId("");
    setChThreadId("");
    setChWebhookUrl("");
    setChWebhookSecret("");
    setChError(null);
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
    setChWebhookUrl(ch.config.url ?? "");
    setChWebhookSecret(ch.config.secret ?? "");
    setChError(null);
    setShowChannelForm(true);
  };

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingChannel) return;
    const trimmedName = chName.trim();
    if (!trimmedName || trimmedName.length > 64) {
      setChError("请填写 1 至 64 个字符的渠道名称");
      return;
    }

    let config: NotificationChannel["config"];
    if (chType === "telegram") {
      if (!chBotToken.trim() || !chChatId.trim()) {
        setChError("Telegram 渠道必须提供 Bot Token 和 Chat ID");
        return;
      }
      const trimmedThread = chThreadId.trim();
      let parsedThread: number | null = null;
      if (trimmedThread) {
        const num = Number(trimmedThread);
        if (!Number.isInteger(num)) {
          setChError("Topic Thread ID 必须为整数");
          return;
        }
        parsedThread = num;
      }
      config = {
        bot_token: chBotToken.trim(),
        chat_id: chChatId.trim(),
        thread_id: parsedThread,
      };
    } else {
      const trimmedUrl = chWebhookUrl.trim();
      if (!trimmedUrl) {
        setChError("Webhook 渠道必须填写目标 URL");
        return;
      }
      try {
        const parsed = new URL(trimmedUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          setChError("Webhook URL 仅支持 http:// 或 https:// 协议");
          return;
        }
      } catch {
        setChError("Webhook URL 格式无效");
        return;
      }
      config = {
        url: trimmedUrl,
        secret: chWebhookSecret.trim() || undefined,
      };
    }

    setSavingChannel(true);
    setChError(null);
    try {
      if (editingChannelId) {
        const res = await api.updateChannel(editingChannelId, {
          name: trimmedName,
          type: chType,
          config,
        });
        setChannels((prev) =>
          prev.map((c) => (c.id === editingChannelId ? res.channel : c)),
        );
        onNotifyRef.current("success", "通知渠道已更新", trimmedName);
      } else {
        const res = await api.createChannel({
          name: trimmedName,
          type: chType,
          enabled: true,
          config,
        });
        setChannels((prev) => [res.channel, ...prev]);
        onNotifyRef.current("success", "通知渠道已添加", trimmedName);
      }
      setShowChannelForm(false);
      setEditingChannelId(null);
    } catch (err) {
      setChError(getErrorMessage(err, "保存通知渠道失败"));
    } finally {
      setSavingChannel(false);
    }
  };

  const handleToggleChannelEnabled = async (ch: NotificationChannel) => {
    if (togglingChannelId === ch.id) return;
    setTogglingChannelId(ch.id);
    try {
      const res = await api.updateChannel(ch.id, { enabled: !ch.enabled });
      setChannels((prev) =>
        prev.map((c) => (c.id === ch.id ? res.channel : c)),
      );
      onNotifyRef.current(
        "info",
        res.channel.enabled ? "已启用通知渠道" : "已停用通知渠道",
        ch.name,
      );
    } catch (err) {
      onNotifyRef.current(
        "danger",
        "更新渠道状态失败",
        getErrorMessage(err, "请稍后重试"),
      );
    } finally {
      setTogglingChannelId(null);
    }
  };

  const setTimedTestFeedback = (id: string, ok: boolean, message: string) => {
    setTestFeedback({ id, ok, message });
    if (testFeedbackTimerRef.current !== null) {
      window.clearTimeout(testFeedbackTimerRef.current);
    }
    testFeedbackTimerRef.current = window.setTimeout(() => {
      setTestFeedback((cur) => (cur?.id === id ? null : cur));
    }, 6000);
  };

  const handleTestChannel = async (ch: NotificationChannel) => {
    if (testingChannelId) return;
    setTestingChannelId(ch.id);
    setTestFeedback(null);
    try {
      const res = await api.testChannel(ch.id);
      if (res.ok) {
        setTimedTestFeedback(ch.id, true, "测试通知已送达");
        onNotifyRef.current(
          "success",
          "测试通知发送成功",
          `渠道「${ch.name}」已收到测试消息。`,
        );
      } else {
        const msg = res.error?.trim() || "目标渠道返回错误，测试消息未送达";
        setTimedTestFeedback(ch.id, false, msg);
        onNotifyRef.current("danger", "测试通知发送失败", msg);
      }
    } catch (err) {
      const msg = getErrorMessage(err, "测试通知请求失败");
      setTimedTestFeedback(ch.id, false, msg);
      onNotifyRef.current("danger", "测试通知发送失败", msg);
    } finally {
      setTestingChannelId(null);
    }
  };

  const handleDeleteChannel = async (ch: NotificationChannel) => {
    if (deletingChannelId === ch.id) return;
    setDeletingChannelId(ch.id);
    try {
      await api.deleteChannel(ch.id);
      setChannels((prev) => prev.filter((c) => c.id !== ch.id));
      setConfirmDeleteChannelId(null);
      if (editingChannelId === ch.id) {
        setShowChannelForm(false);
        setEditingChannelId(null);
      }
      // Keep rules synchronized in case deleted channel was bound
      setRules((prev) =>
        prev.map((r) =>
          r.channel_ids.includes(ch.id)
            ? { ...r, channel_ids: r.channel_ids.filter((id) => id !== ch.id) }
            : r,
        ),
      );
      onNotifyRef.current("info", "已删除通知渠道", ch.name);
    } catch (err) {
      onNotifyRef.current(
        "danger",
        "删除通知渠道失败",
        getErrorMessage(err, "请稍后重试"),
      );
    } finally {
      setDeletingChannelId(null);
    }
  };

  const totalPages = Math.max(
    1,
    Math.ceil(incidentsTotal / INCIDENTS_PAGE_SIZE),
  );
  const currentPage = Math.floor(incidentOffset / INCIDENTS_PAGE_SIZE) + 1;
  const hasPrevPage = incidentOffset > 0;
  const hasNextPage = incidentOffset + INCIDENTS_PAGE_SIZE < incidentsTotal;

  return (
    <section className="space-y-5">
      {/* Header + Quick Golden Presets CTA */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-[var(--text-primary)]">
              告警中心与通知路由
            </h1>
            {firingCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/35">
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                {firingCount} 项告警触发中
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/35">
                <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                当前无活跃告警
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            统一管理实时告警事件、防抖阈值规则引擎与 Telegram / Webhook 通知路由渠道。
          </p>
        </div>

        <button
          type="button"
          onClick={handleApplyPresets}
          disabled={applyingPresets || loadingMeta}
          className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-amber-500/40 bg-amber-500/12 text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 disabled:opacity-60 transition-colors"
        >
          {applyingPresets ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          {applyingPresets ? "应用中…" : "一键启用 6 项推荐黄金模板"}
        </button>
      </div>

      {/* Summary KPI Cards */}
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
                正在触发 · 当前筛选共 {incidentsTotal} 条
              </span>
            </div>
          </div>
          <AlertTriangle
            className={`w-5 h-5 ${
              firingCount > 0
                ? "text-rose-500"
                : "text-emerald-500 opacity-75"
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
                / {rules.length} 条已启用
              </span>
            </div>
          </div>
          <ShieldAlert className="w-5 h-5 text-amber-500" aria-hidden="true" />
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
                / {channels.length} 路已连通
              </span>
            </div>
          </div>
          <Bell
            className="w-5 h-5 text-[var(--accent-primary)]"
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Meta Load Error Banner */}
      {metaError && (
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between gap-3">
          <span>{metaError}</span>
          <button
            type="button"
            onClick={() => void loadMeta()}
            className="shrink-0 px-2.5 py-1 rounded-lg border border-rose-500/40 hover:bg-rose-500/15 font-medium"
          >
            重试
          </button>
        </div>
      )}

      {/* Main Card + Tablist */}
      <div className="surface-card rounded-2xl overflow-hidden">
        {/* Single-Row Tablist */}
        <div className="px-4 sm:px-5 pt-3 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40">
          <div
            role="tablist"
            aria-label="告警中心视图"
            className="flex gap-6 overflow-x-auto"
          >
            <button
              ref={(el) => {
                tabRefs.current.incidents = el;
              }}
              type="button"
              role="tab"
              id="tab-incidents"
              aria-selected={activeTab === "incidents"}
              aria-controls="panel-incidents"
              tabIndex={activeTab === "incidents" ? 0 : -1}
              onClick={() => setActiveTab("incidents")}
              onKeyDown={(e) => handleTabKeyDown(e, "incidents")}
              className={`pb-3 inline-flex items-center gap-2 text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === "incidents"
                  ? "border-b-2 border-[var(--accent-primary)] text-[var(--text-primary)]"
                  : "border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <History className="w-3.5 h-3.5" aria-hidden="true" />
              事件历史
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono-num bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                {incidentsTotal}
              </span>
            </button>

            <button
              ref={(el) => {
                tabRefs.current.rules = el;
              }}
              type="button"
              role="tab"
              id="tab-rules"
              aria-selected={activeTab === "rules"}
              aria-controls="panel-rules"
              tabIndex={activeTab === "rules" ? 0 : -1}
              onClick={() => setActiveTab("rules")}
              onKeyDown={(e) => handleTabKeyDown(e, "rules")}
              className={`pb-3 inline-flex items-center gap-2 text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === "rules"
                  ? "border-b-2 border-[var(--accent-primary)] text-[var(--text-primary)]"
                  : "border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
              告警规则
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono-num bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                {rules.length}
              </span>
            </button>

            <button
              ref={(el) => {
                tabRefs.current.channels = el;
              }}
              type="button"
              role="tab"
              id="tab-channels"
              aria-selected={activeTab === "channels"}
              aria-controls="panel-channels"
              tabIndex={activeTab === "channels" ? 0 : -1}
              onClick={() => setActiveTab("channels")}
              onKeyDown={(e) => handleTabKeyDown(e, "channels")}
              className={`pb-3 inline-flex items-center gap-2 text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === "channels"
                  ? "border-b-2 border-[var(--accent-primary)] text-[var(--text-primary)]"
                  : "border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Bell className="w-3.5 h-3.5" aria-hidden="true" />
              通知渠道
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono-num bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                {channels.length}
              </span>
            </button>
          </div>
        </div>

        {/* TAB 1: Incidents */}
        {activeTab === "incidents" && (
          <div
            role="tabpanel"
            id="panel-incidents"
            aria-labelledby="tab-incidents"
            className="p-4 sm:p-5 space-y-4 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-1">
                {(
                  [
                    { id: "all", label: "全部" },
                    { id: "firing", label: "告警中" },
                    { id: "resolved", label: "已恢复" },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleIncidentFilterChange(item.id)}
                    className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                      incidentFilter === item.id
                        ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono-num text-[var(--text-muted)]">
                  共 {incidentsTotal} 条事件
                  {incidentsTotal > INCIDENTS_PAGE_SIZE
                    ? ` · 第 ${currentPage}/${totalPages} 页`
                    : ""}
                </span>
                <button
                  type="button"
                  onClick={handleRefreshIncidents}
                  disabled={loadingIncidents}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60 transition-colors"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${
                      loadingIncidents ? "animate-spin" : ""
                    }`}
                    aria-hidden="true"
                  />
                  刷新
                </button>
              </div>
            </div>

            {incidentsError && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-rose-700 dark:text-rose-300 flex items-center justify-between gap-2">
                <span>{incidentsError}</span>
                <button
                  type="button"
                  onClick={() =>
                    void loadIncidents(incidentFilter, incidentOffset)
                  }
                  className="px-2 py-0.5 rounded-lg border border-rose-500/40 hover:bg-rose-500/15 font-medium"
                >
                  重试
                </button>
              </div>
            )}

            {loadingIncidents && incidents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-subtle)] py-12 text-center text-[var(--text-muted)] inline-flex w-full items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                正在加载告警事件…
              </div>
            ) : incidents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-subtle)] py-12 text-center text-[var(--text-muted)]">
                当前筛选下暂无告警事件记录。
              </div>
            ) : (
              <div className="space-y-3">
                {incidents.map((inc) => {
                  const isFiring = inc.status.toLowerCase() === "firing";
                  const linkedNode = nodeMap.get(inc.node_id);
                  const linkedRule = ruleMap.get(inc.rule_id);
                  const muted = linkedNode ? isNodeMuted(linkedNode) : false;
                  const muting = mutingNodeId === inc.node_id;
                  const thresholdValue =
                    inc.threshold ?? linkedRule?.threshold ?? null;
                  const ruleOperator = linkedRule?.operator ?? "gt";

                  return (
                    <div
                      key={inc.id}
                      className={`rounded-2xl border p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 transition-colors ${
                        isFiring
                          ? "border-rose-500/35 bg-rose-500/[0.04]"
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
                              <AlertTriangle
                                className="w-3 h-3"
                                aria-hidden="true"
                              />
                            ) : (
                              <CheckCircle2
                                className="w-3 h-3"
                                aria-hidden="true"
                              />
                            )}
                            {formatAlertStatus(inc.status)}
                          </span>

                          <span className="font-bold text-[var(--text-primary)]">
                            {linkedNode?.name ?? inc.node_name}
                          </span>

                          <span className="px-2 py-0.5 rounded-md font-mono-num text-[11px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                            {formatAlertMetric(inc.metric)}
                          </span>

                          {thresholdValue !== null && (
                            <span className="font-mono-num text-[11px] text-[var(--text-muted)]">
                              {formatAlertCondition(
                                inc.metric,
                                ruleOperator,
                                thresholdValue,
                              )}
                            </span>
                          )}

                          {inc.trigger_value !== null && (
                            <span className="font-mono-num text-[11px] text-[var(--text-secondary)]">
                              实测 {formatMetricValue(inc.metric, inc.trigger_value)}
                            </span>
                          )}
                        </div>

                        <p className="text-[var(--text-primary)] leading-relaxed break-words">
                          {inc.message}
                        </p>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono-num text-[var(--text-muted)]">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" aria-hidden="true" />
                            首次触发：{formatTimestamp(inc.started_at)}（
                            {formatRelativeTime(inc.started_at)}）
                          </span>
                          {!isFiring && inc.resolved_at !== null ? (
                            <span className="text-emerald-700 dark:text-emerald-400">
                              已恢复：{formatTimestamp(inc.resolved_at)}（持续{" "}
                              {formatDurationZh(
                                Math.max(0, inc.resolved_at - inc.started_at),
                              )}
                              ）
                            </span>
                          ) : (
                            <span className="text-rose-600 dark:text-rose-400 font-medium">
                              持续触发中
                              {inc.last_notified_at > 0
                                ? ` · 最近通知 ${formatRelativeTime(inc.last_notified_at)}`
                                : ""}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 self-start lg:self-center flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={!linkedNode}
                          title={
                            linkedNode
                              ? "打开节点实时监控与进程抽屉"
                              : "节点已移除或不在当前在线列表"
                          }
                          onClick={() => {
                            if (linkedNode) {
                              onSelectNode(linkedNode, "charts");
                            }
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:border-[var(--border-strong)] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                        >
                          <ExternalLink
                            className="w-3.5 h-3.5"
                            aria-hidden="true"
                          />
                          查看节点
                        </button>

                        {linkedNode && (
                          <button
                            type="button"
                            disabled={muting}
                            onClick={() => void handleMuteToggle(linkedNode)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-60 ${
                              muted
                                ? "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300 hover:bg-amber-500/25"
                                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            {muting ? (
                              <Loader2
                                className="w-3.5 h-3.5 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <BellOff
                                className="w-3.5 h-3.5"
                                aria-hidden="true"
                              />
                            )}
                            {muted ? "取消静默" : "静默 1h"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pagination Footer */}
            {incidentsTotal > INCIDENTS_PAGE_SIZE && (
              <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)] text-[11px] font-mono-num text-[var(--text-secondary)]">
                <span>
                  显示 {incidentOffset + 1} –{" "}
                  {Math.min(
                    incidentOffset + incidents.length,
                    incidentsTotal,
                  )}{" "}
                  / 共 {incidentsTotal} 条
                </span>
                <div className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!hasPrevPage || loadingIncidents}
                    onClick={() =>
                      setIncidentOffset((prev) =>
                        Math.max(0, prev - INCIDENTS_PAGE_SIZE),
                      )
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:opacity-45"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={!hasNextPage || loadingIncidents}
                    onClick={() =>
                      setIncidentOffset((prev) => prev + INCIDENTS_PAGE_SIZE)
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:opacity-45"
                  >
                    下一页
                    <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: Rules */}
        {activeTab === "rules" && (
          <div
            role="tabpanel"
            id="panel-rules"
            aria-labelledby="tab-rules"
            className="p-4 sm:p-5 space-y-4 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[var(--text-secondary)]">
                支持离线心跳、CPU、宿主机争抢 (Steal)、内存、Swap、磁盘与月流量阈值规则，支持持续防抖与冷却防轰炸。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleApplyPresets}
                  disabled={applyingPresets}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 font-semibold hover:bg-amber-500/20 disabled:opacity-60"
                >
                  {applyingPresets ? (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  一键启用黄金模板
                </button>
                <button
                  type="button"
                  onClick={openNewRuleForm}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-white font-semibold shadow-xs"
                  style={{ backgroundColor: "var(--accent-primary)" }}
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  新增告警规则
                </button>
              </div>
            </div>

            {showRuleForm && (
              <form
                onSubmit={handleSaveRule}
                className="rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-inset)] p-4 space-y-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[var(--text-primary)]">
                    {editingRuleId ? "编辑告警规则" : "新建告警规则"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowRuleForm(false);
                      setEditingRuleId(null);
                      setRuleError(null);
                    }}
                    className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    aria-label="关闭表单"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>

                {ruleError && (
                  <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-700 dark:text-rose-300">
                    {ruleError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="rule-name"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      规则名称
                    </label>
                    <input
                      id="rule-name"
                      type="text"
                      required
                      maxLength={100}
                      value={ruleName}
                      onChange={(e) => setRuleName(e.target.value)}
                      placeholder="例如：核心生产负载告警"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="rule-node"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      适用节点范围
                    </label>
                    <select
                      id="rule-node"
                      value={ruleNodeId}
                      onChange={(e) => setRuleNodeId(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    >
                      <option value="ALL">全部服务器节点</option>
                      {nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="rule-metric"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      监控指标
                    </label>
                    <select
                      id="rule-metric"
                      value={ruleMetric}
                      onChange={(e) => {
                        const m = e.target.value as AlertMetric;
                        setRuleMetric(m);
                        if (!editingRuleId) {
                          setRuleThreshold(DEFAULT_THRESHOLD_BY_METRIC[m]);
                        }
                      }}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    >
                      {(Object.keys(METRIC_LABELS) as AlertMetric[]).map((m) => (
                        <option key={m} value={m}>
                          {METRIC_LABELS[m]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="rule-threshold"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      触发条件
                    </label>
                    <div className="flex gap-2">
                      <select
                        aria-label="比较运算符"
                        value={ruleOperator}
                        onChange={(e) =>
                          setRuleOperator(e.target.value as AlertOperator)
                        }
                        className="w-28 px-2.5 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                      >
                        <option value="gt">&gt; 大于</option>
                        <option value="gte">&gt;= 达到</option>
                      </select>
                      <input
                        id="rule-threshold"
                        type="number"
                        step="any"
                        min={0}
                        required
                        value={ruleThreshold}
                        onChange={(e) => setRuleThreshold(e.target.value)}
                        className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="rule-duration"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      持续防抖时间 (秒)
                    </label>
                    <input
                      id="rule-duration"
                      type="number"
                      min={0}
                      step={30}
                      required
                      value={ruleDurationSec}
                      onChange={(e) => setRuleDurationSec(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="rule-cooldown"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      重复通知冷却 (秒)
                    </label>
                    <input
                      id="rule-cooldown"
                      type="number"
                      min={0}
                      step={60}
                      required
                      value={ruleCooldownSec}
                      onChange={(e) => setRuleCooldownSec(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                    />
                  </div>
                </div>

                {channels.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="block text-[var(--text-secondary)]">
                      触发后推送至以下渠道（可多选）：
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {channels.map((ch) => {
                        const checked = ruleChannelIds.includes(ch.id);
                        return (
                          <label
                            key={ch.id}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border cursor-pointer ${
                              checked
                                ? "border-emerald-500/45 bg-emerald-500/12 text-[var(--text-primary)]"
                                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRuleChannel(ch.id)}
                              className="rounded accent-emerald-600"
                            />
                            <span>{ch.name}</span>
                            {!ch.enabled && (
                              <span className="text-[10px] text-[var(--text-muted)]">
                                (已停用)
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowRuleForm(false);
                      setEditingRuleId(null);
                      setRuleError(null);
                    }}
                    className="px-3.5 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={savingRule}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-white font-semibold disabled:opacity-60"
                    style={{ backgroundColor: "var(--accent-primary)" }}
                  >
                    {savingRule && (
                      <Loader2
                        className="w-3.5 h-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    )}
                    {editingRuleId ? "保存修改" : "创建规则"}
                  </button>
                </div>
              </form>
            )}

            <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
                  <tr>
                    <th scope="col" className="py-2.5 px-3">
                      规则名称
                    </th>
                    <th scope="col" className="py-2.5 px-3">
                      适用范围
                    </th>
                    <th scope="col" className="py-2.5 px-3">
                      触发条件
                    </th>
                    <th scope="col" className="py-2.5 px-3">
                      防抖与冷却
                    </th>
                    <th scope="col" className="py-2.5 px-3">
                      路由渠道
                    </th>
                    <th scope="col" className="py-2.5 px-3">
                      状态
                    </th>
                    <th scope="col" className="py-2.5 px-3 text-right">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {loadingMeta && rules.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-10 text-center text-[var(--text-muted)]"
                      >
                        正在加载告警规则…
                      </td>
                    </tr>
                  ) : rules.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-10 text-center text-[var(--text-muted)]"
                      >
                        尚未创建规则，点击右上角「一键启用黄金模板」或「新增告警规则」。
                      </td>
                    </tr>
                  ) : (
                    rules.map((rule) => {
                      const targetNodeName = rule.node_id
                        ? (nodeMap.get(rule.node_id)?.name ?? rule.node_id)
                        : "全部节点";
                      const isToggling = togglingRuleId === rule.id;
                      const isDeleting = deletingRuleId === rule.id;
                      const channelNames = rule.channel_ids
                        .map(
                          (cid) => channels.find((c) => c.id === cid)?.name,
                        )
                        .filter(Boolean) as string[];

                      return (
                        <tr
                          key={rule.id}
                          className="hover:bg-[var(--bg-card-hover)] transition-colors"
                        >
                          <td className="py-3 px-3 font-semibold text-[var(--text-primary)]">
                            {rule.name}
                          </td>
                          <td className="py-3 px-3 text-[var(--text-secondary)]">
                            {targetNodeName}
                          </td>
                          <td className="py-3 px-3 font-mono-num text-[var(--text-primary)]">
                            {formatAlertCondition(
                              rule.metric,
                              rule.operator,
                              rule.threshold,
                            )}
                          </td>
                          <td className="py-3 px-3 font-mono-num text-[var(--text-muted)] whitespace-nowrap">
                            持续 {formatDurationZh(rule.duration_sec)} · 冷却{" "}
                            {formatDurationZh(rule.cooldown_sec)}
                          </td>
                          <td className="py-3 px-3 text-[var(--text-secondary)]">
                            {channelNames.length > 0 ? (
                              <span>{channelNames.join("、")}</span>
                            ) : (
                              <span className="text-[var(--text-muted)]">
                                未绑定
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3">
                            <button
                              type="button"
                              disabled={isToggling}
                              onClick={() => void handleToggleRuleEnabled(rule)}
                              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium border disabled:opacity-60 ${
                                rule.enabled
                                  ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                  : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)]"
                              }`}
                            >
                              {isToggling && (
                                <Loader2
                                  className="w-3 h-3 animate-spin"
                                  aria-hidden="true"
                                />
                              )}
                              {rule.enabled ? "已启用" : "已停用"}
                            </button>
                          </td>
                          <td className="py-3 px-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEditRuleForm(rule)}
                                title="编辑规则"
                                aria-label={`编辑规则 ${rule.name}`}
                                className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-sky-600 dark:hover:text-sky-400"
                              >
                                <Edit3
                                  className="w-3.5 h-3.5"
                                  aria-hidden="true"
                                />
                              </button>
                              {confirmDeleteRuleId === rule.id ? (
                                <span className="inline-flex items-center gap-1 ml-1">
                                  <button
                                    type="button"
                                    disabled={isDeleting}
                                    onClick={() => void handleDeleteRule(rule)}
                                    className="px-2 py-1 rounded-lg bg-rose-600 text-white text-[11px] font-semibold disabled:opacity-60"
                                  >
                                    {isDeleting ? "删除中…" : "确认删除"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isDeleting}
                                    onClick={() => setConfirmDeleteRuleId(null)}
                                    className="px-2 py-1 rounded-lg border border-[var(--border-subtle)] text-[11px]"
                                  >
                                    取消
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setConfirmDeleteRuleId(rule.id)
                                  }
                                  title="删除规则"
                                  aria-label={`删除规则 ${rule.name}`}
                                  className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-rose-600 dark:hover:text-rose-400"
                                >
                                  <Trash2
                                    className="w-3.5 h-3.5"
                                    aria-hidden="true"
                                  />
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
        )}

        {/* TAB 3: Channels */}
        {activeTab === "channels" && (
          <div
            role="tabpanel"
            id="panel-channels"
            aria-labelledby="tab-channels"
            className="p-4 sm:p-5 space-y-4 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[var(--text-secondary)]">
                支持 Telegram Bot（含群组 Topic Thread ID）与签名 HMAC Webhook 推送，支持真实在线发送测试验证连通性。
              </p>
              <button
                type="button"
                onClick={openNewChannelForm}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-white font-semibold shadow-xs"
                style={{ backgroundColor: "var(--accent-primary)" }}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                添加通知渠道
              </button>
            </div>

            {showChannelForm && (
              <form
                onSubmit={handleSaveChannel}
                className="rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-inset)] p-4 space-y-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[var(--text-primary)]">
                    {editingChannelId ? "编辑通知渠道" : "添加通知渠道"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowChannelForm(false);
                      setEditingChannelId(null);
                      setChError(null);
                    }}
                    className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    aria-label="关闭表单"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>

                {chError && (
                  <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-700 dark:text-rose-300">
                    {chError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="ch-name"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      渠道名称
                    </label>
                    <input
                      id="ch-name"
                      type="text"
                      required
                      maxLength={64}
                      value={chName}
                      onChange={(e) => setChName(e.target.value)}
                      placeholder="例如：运维 Telegram 告警群"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="ch-type"
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      推送协议类型
                    </label>
                    <select
                      id="ch-type"
                      value={chType}
                      onChange={(e) =>
                        setChType(e.target.value as "telegram" | "webhook")
                      }
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    >
                      <option value="telegram">Telegram Bot</option>
                      <option value="webhook">JSON Webhook (HMAC-SHA256)</option>
                    </select>
                  </div>

                  {chType === "telegram" ? (
                    <>
                      <div>
                        <label
                          htmlFor="ch-tg-token"
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          Bot Token
                        </label>
                        <input
                          id="ch-tg-token"
                          type="password"
                          autoComplete="off"
                          value={chBotToken}
                          onChange={(e) => setChBotToken(e.target.value)}
                          placeholder="123456:ABC-DEF..."
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="ch-tg-chat"
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          Chat ID
                        </label>
                        <input
                          id="ch-tg-chat"
                          type="text"
                          value={chChatId}
                          onChange={(e) => setChChatId(e.target.value)}
                          placeholder="-1001234567890"
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label
                          htmlFor="ch-tg-thread"
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          Topic Thread ID（可选，仅超级群组开启话题时填写）
                        </label>
                        <input
                          id="ch-tg-thread"
                          type="text"
                          value={chThreadId}
                          onChange={(e) => setChThreadId(e.target.value)}
                          placeholder="留空则发送到群组主会话"
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="sm:col-span-2">
                        <label
                          htmlFor="ch-wh-url"
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          Webhook 接收地址 (HTTPS)
                        </label>
                        <input
                          id="ch-wh-url"
                          type="url"
                          value={chWebhookUrl}
                          onChange={(e) => setChWebhookUrl(e.target.value)}
                          placeholder="https://example.com/webhooks/uniob"
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label
                          htmlFor="ch-wh-secret"
                          className="block text-[var(--text-secondary)] mb-1"
                        >
                          HMAC-SHA256 签名密钥（可选）
                        </label>
                        <input
                          id="ch-wh-secret"
                          type="password"
                          autoComplete="off"
                          value={chWebhookSecret}
                          onChange={(e) => setChWebhookSecret(e.target.value)}
                          placeholder="设置后请求头附带 X-UniOB-Signature"
                          className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[var(--text-primary)]"
                        />
                      </div>
                    </>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowChannelForm(false);
                      setEditingChannelId(null);
                      setChError(null);
                    }}
                    className="px-3.5 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={savingChannel}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-white font-semibold disabled:opacity-60"
                    style={{ backgroundColor: "var(--accent-primary)" }}
                  >
                    {savingChannel && (
                      <Loader2
                        className="w-3.5 h-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    )}
                    {editingChannelId ? "保存修改" : "添加渠道"}
                  </button>
                </div>
              </form>
            )}

            {loadingMeta && channels.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-subtle)] py-12 text-center text-[var(--text-muted)]">
                正在加载通知渠道…
              </div>
            ) : channels.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-subtle)] py-12 text-center text-[var(--text-muted)]">
                暂未配置通知渠道，点击右上角「添加通知渠道」。
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {channels.map((ch) => {
                  const testing = testingChannelId === ch.id;
                  const toggled = togglingChannelId === ch.id;
                  const deleting = deletingChannelId === ch.id;
                  const feedback =
                    testFeedback?.id === ch.id ? testFeedback : null;

                  return (
                    <div
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
                                  Chat ID: {ch.config.chat_id ?? "—"}
                                  {ch.config.thread_id != null
                                    ? ` · Topic #${ch.config.thread_id}`
                                    : ""}
                                </div>
                                <div>
                                  Bot Token: {maskToken(ch.config.bot_token)}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="truncate">
                                  URL: {ch.config.url ?? "—"}
                                </div>
                                <div>
                                  HMAC Secret:{" "}
                                  {ch.config.secret
                                    ? maskToken(ch.config.secret)
                                    : "未启用签名"}
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={toggled}
                          onClick={() => void handleToggleChannelEnabled(ch)}
                          title={ch.enabled ? "点击停用渠道" : "点击启用渠道"}
                          className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium border disabled:opacity-60 ${
                            ch.enabled
                              ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                              : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)]"
                          }`}
                        >
                          {toggled && (
                            <Loader2
                              className="w-3 h-3 animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          {ch.enabled ? "已启用" : "已停用"}
                        </button>
                      </div>

                      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={Boolean(testingChannelId)}
                            onClick={() => void handleTestChannel(ch)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-sky-500/35 bg-sky-500/12 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 disabled:opacity-60 font-medium transition-colors"
                          >
                            {testing ? (
                              <Loader2
                                className="w-3 h-3 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Send className="w-3 h-3" aria-hidden="true" />
                            )}
                            {testing ? "发送中…" : "发送测试通知"}
                          </button>

                          {feedback && (
                            <span
                              className={`text-[11px] font-mono-num font-semibold ${
                                feedback.ok
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-rose-600 dark:text-rose-400"
                              }`}
                            >
                              {feedback.ok ? "✓ " : "✕ "}
                              {feedback.message}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditChannelForm(ch)}
                            title="编辑渠道"
                            aria-label={`编辑渠道 ${ch.name}`}
                            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-sky-600 dark:hover:text-sky-400"
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          {confirmDeleteChannelId === ch.id ? (
                            <span className="inline-flex items-center gap-1 ml-1">
                              <button
                                type="button"
                                disabled={deleting}
                                onClick={() => void handleDeleteChannel(ch)}
                                className="px-2 py-1 rounded-lg bg-rose-600 text-white text-[11px] font-semibold disabled:opacity-60"
                              >
                                {deleting ? "删除中…" : "确认"}
                              </button>
                              <button
                                type="button"
                                disabled={deleting}
                                onClick={() => setConfirmDeleteChannelId(null)}
                                className="px-2 py-1 rounded-lg border border-[var(--border-subtle)] text-[11px]"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteChannelId(ch.id)}
                              title="删除渠道"
                              aria-label={`删除渠道 ${ch.name}`}
                              className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-rose-600 dark:hover:text-rose-400"
                            >
                              <Trash2
                                className="w-3.5 h-3.5"
                                aria-hidden="true"
                              />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
