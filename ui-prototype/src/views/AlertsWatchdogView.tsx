import React, { useId, useState } from "react";
import {
  Bell,
  Check,
  Mail,
  MessageSquare,
  Plus,
  Send,
  Smartphone,
  Volume2,
  VolumeX,
  Webhook,
} from "lucide-react";
import type {
  AlertChannel,
  AlertIncidentItem,
  AlertMetricKind,
  AlertsWatchdogViewProps,
  WatermarkRule,
} from "../types";
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
} from "../components/ui/Primitives";

type AlertSubTab = "timeline" | "rules" | "channels";
type IncidentFilter = "all" | "firing" | "resolved";

const SHORT_INCIDENT_TAG: Record<AlertMetricKind, string> = {
  cpu: "CPU 过高",
  cpu_spike: "CPU 突增",
  steal: "CPU 争抢",
  mem: "内存告警",
  swap: "交换区高",
  disk: "磁盘不足",
  traffic_pct: "流量超限",
  offline: "离线",
};

const CLEAN_RULE_NAME: Record<AlertMetricKind, string> = {
  cpu: "CPU 使用率",
  cpu_spike: "CPU 突增幅度",
  steal: "邻居争抢率",
  mem: "内存使用率",
  swap: "交换区占用",
  disk: "磁盘使用率",
  traffic_pct: "月流量占比",
  offline: "离线时长",
};

function parsePercentValue(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

function formatDurationShort(sec: number): string {
  if (sec <= 0) return "立即触发";
  if (sec < 60) return `${sec} 秒`;
  return `${Math.round(sec / 60)} 分钟`;
}

function ChannelTypeIcon({
  type,
}: {
  type: AlertChannel["type"];
}): React.JSX.Element {
  switch (type) {
    case "telegram":
      return <MessageSquare className="h-4 w-4" aria-hidden="true" />;
    case "bark":
      return <Smartphone className="h-4 w-4" aria-hidden="true" />;
    case "feishu":
      return <Webhook className="h-4 w-4" aria-hidden="true" />;
    case "email":
      return <Mail className="h-4 w-4" aria-hidden="true" />;
  }
}

export function AlertsWatchdogView(
  props: AlertsWatchdogViewProps,
): React.JSX.Element {
  const {
    incidents,
    rules,
    channels,
    onToggleRule,
    onToggleChannel,
    onInspectNode,
    onNotify,
  } = props;

  const ruleModalTitleId = useId();
  const channelModalTitleId = useId();

  const [activeTab, setActiveTab] = useState<AlertSubTab>("timeline");
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>("all");
  const [mutedIds, setMutedIds] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    incidents.forEach((item) => {
      if (item.muted) map[item.id] = true;
    });
    return map;
  });

  // Interactive rule threshold overrides & newly created rules/channels
  const [thresholdOverrides, setThresholdOverrides] = useState<
    Record<string, number>
  >({});
  const [customRules, setCustomRules] = useState<WatermarkRule[]>([]);
  const [customChannels, setCustomChannels] = useState<AlertChannel[]>([]);
  const [testedChannelIds, setTestedChannelIds] = useState<
    Record<string, boolean>
  >({});
  const [liveStatus, setLiveStatus] = useState("");

  // Add Rule Modal
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [newRuleMetric, setNewRuleMetric] = useState<AlertMetricKind>("cpu");
  const [newRuleThreshold, setNewRuleThreshold] = useState(90);
  const [newRuleMinutes, setNewRuleMinutes] = useState(3);

  // Add Channel Modal
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [newChannelType, setNewChannelType] =
    useState<AlertChannel["type"]>("telegram");
  const [newChannelName, setNewChannelName] = useState("运维通知群");
  const [newChannelTarget, setNewChannelTarget] = useState("@uniob_alerts");

  const allRules = [...customRules, ...rules];
  const allChannels = [...channels, ...customChannels];

  const firingCount = incidents.filter((i) => i.status === "firing").length;
  const filteredIncidents = incidents.filter((item) => {
    if (incidentFilter === "firing") return item.status === "firing";
    if (incidentFilter === "resolved") return item.status === "resolved";
    return true;
  });

  const handleToggleMute = (item: AlertIncidentItem) => {
    const next = !mutedIds[item.id];
    setMutedIds((prev) => ({ ...prev, [item.id]: next }));
    const text = next
      ? `已静音 ${item.nodeName} 告警`
      : `已恢复 ${item.nodeName} 告警通知`;
    setLiveStatus(text);
    onNotify?.(text, "info");
  };

  const handleTestChannel = (ch: AlertChannel) => {
    setTestedChannelIds((prev) => ({ ...prev, [ch.id]: true }));
    setLiveStatus(`测试通知已发送至 ${ch.name}`);
    onNotify?.(`测试消息已送达 ${ch.name}`, "success");
    window.setTimeout(() => {
      setTestedChannelIds((prev) => ({ ...prev, [ch.id]: false }));
    }, 2200);
  };

  const handleCreateRule = (e: React.FormEvent) => {
    e.preventDefault();
    const created: WatermarkRule = {
      id: `rule_local_${Date.now()}`,
      name: CLEAN_RULE_NAME[newRuleMetric],
      scope: "全部服务器",
      metric: newRuleMetric,
      conditionText: `${newRuleThreshold}%`,
      triggerPct: newRuleMetric === "offline" ? null : newRuleThreshold,
      recoverPct:
        newRuleMetric === "offline" ? null : Math.max(10, newRuleThreshold - 3),
      sustainSec: newRuleMinutes * 60,
      cooldownSec: 300,
      edgeZeroDelay: false,
      channels: ["Telegram"],
      enabled: true,
    };
    setCustomRules((prev) => [created, ...prev]);
    setRuleModalOpen(false);
    onNotify?.(`已新建规则：${created.name}`, "success");
  };

  const handleCreateChannel = (e: React.FormEvent) => {
    e.preventDefault();
    const created: AlertChannel = {
      id: `ch_local_${Date.now()}`,
      name: newChannelName.trim() || "通知渠道",
      type: newChannelType,
      targetMasked: newChannelTarget.trim() || "@alerts",
      detailNote: "",
      enabled: true,
      lastDeliveredLabel: "刚刚",
      latencyMs: 120,
    };
    setCustomChannels((prev) => [...prev, created]);
    setChannelModalOpen(false);
    onNotify?.(`已添加通知渠道：${created.name}`, "success");
  };

  return (
    <div className="space-y-5">
      <div role="status" aria-live="polite" className="sr-only">
        {liveStatus}
      </div>

      {/* Clean Header */}
      <SectionHeader
        title="告警通知"
        badge={
          firingCount > 0 ? (
            <Badge tone="danger">{firingCount} 项告警中</Badge>
          ) : (
            <Badge tone="ok">全部正常</Badge>
          )
        }
        actions={
          activeTab === "timeline" ? (
            <SegmentedControl<IncidentFilter>
              ariaLabel="筛选告警状态"
              value={incidentFilter}
              onChange={setIncidentFilter}
              options={[
                { value: "all", label: "全部", badge: incidents.length },
                { value: "firing", label: "告警中", badge: firingCount },
                {
                  value: "resolved",
                  label: "已恢复",
                  badge: incidents.length - firingCount,
                },
              ]}
            />
          ) : activeTab === "rules" ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => setRuleModalOpen(true)}
            >
              新建规则
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => setChannelModalOpen(true)}
            >
              添加渠道
            </Button>
          )
        }
      />

      {/* Sub-view Tabs */}
      <TabBar<AlertSubTab>
        ariaLabel="告警模块切换"
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: "timeline", label: "告警记录", count: incidents.length },
          { id: "rules", label: "触发规则", count: allRules.length },
          { id: "channels", label: "通知渠道", count: allChannels.length },
        ]}
      />

      {/* Tab 1: 告警记录 (Single clean visual row per item, zero prose) */}
      <div role="tabpanel" hidden={activeTab !== "timeline"}>
        <Card padded={false} className="overflow-hidden">
          {filteredIncidents.length === 0 ? (
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="flex flex-col items-center justify-center gap-2 py-12 text-[13px]"
            >
              <Bell className="h-5 w-5 opacity-50" aria-hidden="true" />
              <span>当前没有匹配的告警记录</span>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-hairline)]">
              {filteredIncidents.map((inc) => {
                const isFiring = inc.status === "firing";
                const isMuted = Boolean(mutedIds[inc.id]);
                const pct = parsePercentValue(inc.triggerValueText);
                const shortTag = SHORT_INCIDENT_TAG[inc.metric];

                return (
                  <div
                    key={inc.id}
                    className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    {/* Left: Status dot + Server name + Short tag */}
                    <div className="flex min-w-[220px] items-center gap-3">
                      <StatusDot
                        tone={isFiring ? "danger" : "ok"}
                        pulse={isFiring && !isMuted}
                      />
                      <span
                        style={{ color: "var(--text-primary)" }}
                        className="text-[13.5px] font-semibold"
                      >
                        {inc.nodeName}
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
                      {isMuted && <Badge tone="subtle">已静音</Badge>}
                    </div>

                    {/* Middle: Compact visual meter + crisp reading */}
                    <div className="flex flex-1 items-center justify-end gap-5 sm:justify-center">
                      {pct !== null ? (
                        <div className="flex w-44 items-center gap-2.5">
                          <MetricBar
                            valuePct={pct}
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
                            className="font-mono-num w-12 text-right text-[13px] font-semibold"
                          >
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      ) : (
                        <span
                          style={{
                            color: isFiring
                              ? "var(--status-danger-ink)"
                              : "var(--text-secondary)",
                          }}
                          className="font-mono-num text-[13px] font-semibold"
                        >
                          {inc.metric === "offline" ? "连接中断" : inc.triggerValueText}
                        </span>
                      )}
                    </div>

                    {/* Right: Relative time + 查看 / 静音 */}
                    <div className="flex items-center gap-2.5">
                      <span
                        style={{ color: "var(--text-tertiary)" }}
                        className="font-mono-num mr-1 text-[12px]"
                      >
                        {inc.startedAtLabel}
                      </span>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onInspectNode(inc.nodeId)}
                      >
                        查看
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon={
                          isMuted ? (
                            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                          )
                        }
                        onClick={() => handleToggleMute(inc)}
                      >
                        {isMuted ? "取消静音" : "静音"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Tab 2: 触发规则 (Clean compact cards: Name, big threshold/slider, duration, switch) */}
      <div role="tabpanel" hidden={activeTab !== "rules"}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allRules.map((rule) => {
            const currentPct =
              thresholdOverrides[rule.id] ?? rule.triggerPct ?? null;
            const isCustom = rule.id.startsWith("rule_local_");

            return (
              <Card
                key={rule.id}
                className="flex flex-col justify-between gap-4 p-5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    style={{ color: "var(--text-primary)" }}
                    className="text-[14px] font-semibold"
                  >
                    {CLEAN_RULE_NAME[rule.metric]}
                  </span>
                  <Switch
                    checked={rule.enabled}
                    onChange={() => {
                      if (isCustom) {
                        setCustomRules((prev) =>
                          prev.map((r) =>
                            r.id === rule.id
                              ? { ...r, enabled: !r.enabled }
                              : r,
                          ),
                        );
                      } else {
                        onToggleRule(rule.id);
                      }
                    }}
                    ariaLabel={`切换${CLEAN_RULE_NAME[rule.metric]}规则`}
                  />
                </div>

                {currentPct !== null ? (
                  <div className="space-y-2.5">
                    <div
                      style={{ color: "var(--text-primary)" }}
                      className="font-mono-num text-[26px] leading-none font-semibold tracking-[-0.02em]"
                    >
                      {currentPct}%
                    </div>
                    <input
                      type="range"
                      min={40}
                      max={98}
                      value={currentPct}
                      aria-label={`${CLEAN_RULE_NAME[rule.metric]}阈值`}
                      onChange={(e) =>
                        setThresholdOverrides((prev) => ({
                          ...prev,
                          [rule.id]: Number(e.target.value),
                        }))
                      }
                      style={{ accentColor: "var(--ink-primary)" }}
                      className="h-1.5 w-full cursor-pointer"
                    />
                  </div>
                ) : (
                  <div
                    style={{ color: "var(--text-primary)" }}
                    className="font-mono-num py-1 text-[26px] leading-none font-semibold tracking-[-0.02em]"
                  >
                    {formatDurationShort(rule.sustainSec || 180)}
                  </div>
                )}

                <div
                  style={{ color: "var(--text-tertiary)" }}
                  className="flex items-center justify-between text-[12px]"
                >
                  <span>持续 {formatDurationShort(rule.sustainSec)}</span>
                  <Badge tone="neutral">
                    {rule.metric === "swap" ? "轻量机器" : "全部服务器"}
                  </Badge>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Tab 3: 通知渠道 (Icon + Name + Target + Switch + 测试) */}
      <div role="tabpanel" hidden={activeTab !== "channels"}>
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          {allChannels.map((ch) => {
            const isTested = Boolean(testedChannelIds[ch.id]);
            const isCustom = ch.id.startsWith("ch_local_");

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
                    <ChannelTypeIcon type={ch.type} />
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
                      {ch.targetMasked}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <Button
                    size="xs"
                    variant={isTested ? "accent" : "secondary"}
                    disabled={!ch.enabled}
                    icon={
                      isTested ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      )
                    }
                    onClick={() => handleTestChannel(ch)}
                  >
                    {isTested ? "已送达" : "测试"}
                  </Button>
                  <Switch
                    checked={ch.enabled}
                    onChange={() => {
                      if (isCustom) {
                        setCustomChannels((prev) =>
                          prev.map((c) =>
                            c.id === ch.id ? { ...c, enabled: !c.enabled } : c,
                          ),
                        );
                      } else {
                        onToggleChannel(ch.id);
                      }
                    }}
                    ariaLabel={`启用${ch.name}`}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Add Rule Modal */}
      <NativeDialog
        open={ruleModalOpen}
        onClose={() => setRuleModalOpen(false)}
        titleId={ruleModalTitleId}
        maxWidthClass="max-w-[420px]"
      >
        <form onSubmit={handleCreateRule} className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h3
              id={ruleModalTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              新建触发规则
            </h3>
            <IconCloseButton onClick={() => setRuleModalOpen(false)} />
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor="new-rule-metric"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                监控项
              </label>
              <select
                id="new-rule-metric"
                value={newRuleMetric}
                onChange={(e) =>
                  setNewRuleMetric(e.target.value as AlertMetricKind)
                }
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
                <option value="traffic_pct">月流量占比</option>
                <option value="offline">离线时长</option>
              </select>
            </div>

            {newRuleMetric !== "offline" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[12px]">
                  <span style={{ color: "var(--text-secondary)" }}>阈值</span>
                  <span
                    style={{ color: "var(--text-primary)" }}
                    className="font-mono-num font-semibold"
                  >
                    {newRuleThreshold}%
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={98}
                  value={newRuleThreshold}
                  onChange={(e) => setNewRuleThreshold(Number(e.target.value))}
                  style={{ accentColor: "var(--ink-primary)" }}
                  className="w-full cursor-pointer"
                />
              </div>
            )}

            <div className="space-y-1">
              <label
                htmlFor="new-rule-mins"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                持续时间（分钟）
              </label>
              <input
                id="new-rule-mins"
                type="number"
                min={1}
                max={60}
                value={newRuleMinutes}
                onChange={(e) =>
                  setNewRuleMinutes(Math.max(1, Number(e.target.value) || 1))
                }
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px]"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRuleModalOpen(false)}
            >
              取消
            </Button>
            <Button autoFocus type="submit" variant="primary" size="sm">
              保存规则
            </Button>
          </div>
        </form>
      </NativeDialog>

      {/* Add Channel Modal */}
      <NativeDialog
        open={channelModalOpen}
        onClose={() => setChannelModalOpen(false)}
        titleId={channelModalTitleId}
        maxWidthClass="max-w-[420px]"
      >
        <form onSubmit={handleCreateChannel} className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h3
              id={channelModalTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              添加通知渠道
            </h3>
            <IconCloseButton onClick={() => setChannelModalOpen(false)} />
          </div>

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
                value={newChannelType}
                onChange={(e) =>
                  setNewChannelType(e.target.value as AlertChannel["type"])
                }
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-9 w-full rounded-[8px] px-3 text-[13px]"
              >
                <option value="telegram">Telegram</option>
                <option value="bark">Bark</option>
                <option value="feishu">飞书 / Webhook</option>
                <option value="email">邮件</option>
              </select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="ch-name"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                名称
              </label>
              <input
                id="ch-name"
                type="text"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-9 w-full rounded-[8px] px-3 text-[13px]"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="ch-target"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                接收地址
              </label>
              <input
                id="ch-target"
                type="text"
                value={newChannelTarget}
                onChange={(e) => setNewChannelTarget(e.target.value)}
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px]"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChannelModalOpen(false)}
            >
              取消
            </Button>
            <Button autoFocus type="submit" variant="primary" size="sm">
              保存渠道
            </Button>
          </div>
        </form>
      </NativeDialog>
    </div>
  );
}

export default AlertsWatchdogView;
