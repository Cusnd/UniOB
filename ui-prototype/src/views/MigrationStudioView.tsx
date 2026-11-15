import React, { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Download,
  Play,
  RotateCcw,
  Server,
  Upload,
} from "lucide-react";
import type {
  CanaryNodeMigrationItem,
  HubArchitectureMode,
  MigrationStudioViewProps,
} from "../types";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  MetricBar,
  SectionHeader,
  StatusDot,
  Switch,
} from "../components/ui/Primitives";

const SELF_HOSTED_CMD =
  "curl -fsSL https://get.uniob.sh/server | sudo sh";

function getNodePhaseView(phase: CanaryNodeMigrationItem["phase"]): {
  label: string;
  dotTone: "idle" | "accent" | "warn" | "ok" | "danger";
  pct: number;
} {
  switch (phase) {
    case "queued":
      return { label: "待迁移", dotTone: "idle", pct: 12 };
    case "canary_probe":
      return { label: "连接校验", dotTone: "accent", pct: 48 };
    case "handshaking":
      return { label: "平滑切换", dotTone: "warn", pct: 76 };
    case "cutover_ok":
      return { label: "已完成", dotTone: "ok", pct: 100 };
    case "fallback_safe":
      return { label: "已回退", dotTone: "danger", pct: 100 };
  }
}

export function MigrationStudioView(
  props: MigrationStudioViewProps,
): React.JSX.Element {
  const { migrationState, scchQuota, nodes, onSwitchHubMode, onNotify } = props;
  const targetInputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const timerRefs = useRef<number[]>([]);

  const [showQuotaDetail, setShowQuotaDetail] = useState(false);
  const [targetUrl, setTargetUrl] = useState(migrationState.targetOrigin);
  const [nodeItems, setNodeItems] = useState<CanaryNodeMigrationItem[]>(
    () => migrationState.nodeStatuses,
  );
  const [migrating, setMigrating] = useState(false);
  const [stepIndex, setStepIndex] = useState<0 | 1 | 2>(1);
  const [rolledBack, setRolledBack] = useState(false);

  const [offlineAlertEnabled, setOfflineAlertEnabled] = useState(true);
  const [lastCheckLabel, setLastCheckLabel] = useState("2 分钟前");
  const [backupTimeLabel, setBackupTimeLabel] = useState("刚刚");
  const [liveStatusText, setLiveStatusText] = useState("");

  useEffect(() => {
    return () => {
      timerRefs.current.forEach((id) => window.clearTimeout(id));
      timerRefs.current = [];
    };
  }, []);

  const clearTimers = () => {
    timerRefs.current.forEach((id) => window.clearTimeout(id));
    timerRefs.current = [];
    setMigrating(false);
  };

  const isCloudMode = migrationState.activeMode === "scch-cloud";
  const quotaUsedPct = Math.max(
    1,
    Math.round(
      (scchQuota.dailyD1WritesUsed / scchQuota.dailyD1WritesLimit) * 100,
    ),
  );
  const onlineNodesCount = nodes.filter((n) => n.online).length;

  const doneCount = nodeItems.filter((n) => n.phase === "cutover_ok").length;
  const totalCount = nodeItems.length;

  const handleSelectMode = (mode: HubArchitectureMode) => {
    if (mode === migrationState.activeMode) return;
    onSwitchHubMode(mode);
    const modeLabel = mode === "scch-cloud" ? "Cloudflare 云端托管" : "自建服务端";
    setLiveStatusText(`已切换为${modeLabel}`);
    onNotify?.(`已切换运行模式：${modeLabel}`, "info");
  };

  const handleStartMigration = () => {
    clearTimers();
    setMigrating(true);
    setRolledBack(false);
    setStepIndex(0);
    setNodeItems((prev) =>
      prev.map((item, idx) => ({
        ...item,
        phase: idx % 2 === 0 ? "canary_probe" : "queued",
      })),
    );
    setLiveStatusText("正在执行连接校验");
    onNotify?.("正在校验目标地址并准备平滑切换", "info");

    const t1 = window.setTimeout(() => {
      setStepIndex(1);
      setNodeItems((prev) =>
        prev.map((item, idx) => ({
          ...item,
          phase: idx < Math.ceil(prev.length / 2) ? "cutover_ok" : "handshaking",
        })),
      );
      setLiveStatusText("正在分批平滑切换节点");
    }, 650);

    const t2 = window.setTimeout(() => {
      setStepIndex(2);
      setMigrating(false);
      setNodeItems((prev) =>
        prev.map((item) => ({
          ...item,
          phase: "cutover_ok",
        })),
      );
      setLiveStatusText("全部服务器已完成平滑迁移");
      onNotify?.("全部服务器已完成平滑切换", "success");
    }, 1350);

    timerRefs.current.push(t1, t2);
  };

  const handleSimulateFallback = () => {
    clearTimers();
    setRolledBack(true);
    setStepIndex(0);
    setNodeItems((prev) =>
      prev.map((item) => ({
        ...item,
        phase: "fallback_safe",
      })),
    );
    setLiveStatusText("连接异常，已自动回退至原地址");
    onNotify?.("目标地址无响应，所有节点已自动回退保护", "warning");
  };

  const handleResetMigration = () => {
    clearTimers();
    setRolledBack(false);
    setStepIndex(1);
    setNodeItems(migrationState.nodeStatuses);
    setLiveStatusText("已重置迁移状态");
  };

  const handleExportBackup = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    setBackupTimeLabel(`${hh}:${mm}`);
    setLiveStatusText("已导出配置与历史数据备份");
    onNotify?.(`备份文件已生成 (${migrationState.lastSnapshotSizeKb} KB)`, "success");
  };

  const handleImportRestore = () => {
    setBackupTimeLabel("已校验");
    setLiveStatusText("备份数据校验通过，可随时恢复");
    onNotify?.("备份文件校验通过，配置已同步", "success");
  };

  const steps = ["连接校验", "平滑切换", "完成"] as const;

  return (
    <div className="space-y-6">
      <div role="status" aria-live="polite" className="sr-only">
        {liveStatusText}
      </div>

      {/* Page Title */}
      <SectionHeader title="服务与迁移" />

      {/* Block 1: 运行模式 */}
      <section className="space-y-3">
        <h3
          style={{ color: "var(--text-secondary)" }}
          className="text-[13px] font-medium"
        >
          运行模式
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Card 1: Cloudflare 云端托管 */}
          <Card
            style={{
              borderColor: isCloudMode
                ? "var(--accent-border)"
                : "var(--border-hairline)",
            }}
            className="flex flex-col justify-between gap-5 p-5"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    style={{
                      backgroundColor: "var(--accent-soft)",
                      color: "var(--accent-ink)",
                      border: "1px solid var(--accent-border)",
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[8px]"
                  >
                    <Cloud className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span
                    style={{ color: "var(--text-primary)" }}
                    className="text-[15px] font-semibold"
                  >
                    Cloudflare 云端托管
                  </span>
                </div>

                {isCloudMode ? (
                  <Badge tone="accent">当前使用</Badge>
                ) : (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => handleSelectMode("scch-cloud")}
                  >
                    切换使用
                  </Button>
                )}
              </div>

              <MetricBar
                label="免费额度已用"
                valueLabel={`${quotaUsedPct}%`}
                valuePct={quotaUsedPct}
                thickness={4}
              />

              <div>
                <button
                  type="button"
                  aria-expanded={showQuotaDetail}
                  onClick={() => setShowQuotaDetail((v) => !v)}
                  style={{ color: "var(--text-tertiary)" }}
                  className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium hover:text-[var(--text-primary)]"
                >
                  <span>{showQuotaDetail ? "收起细项" : "查看细项"}</span>
                  {showQuotaDetail ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>

                {showQuotaDetail && (
                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    <div
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[8px] px-3 py-2"
                    >
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[11px]"
                      >
                        日写入量
                      </div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="font-mono-num mt-0.5 text-[13.5px] font-semibold"
                      >
                        {(scchQuota.dailyD1WritesUsed / 1000).toFixed(1)}k / 100k
                      </div>
                    </div>

                    <div
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[8px] px-3 py-2"
                    >
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[11px]"
                      >
                        在线节点
                      </div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="font-mono-num mt-0.5 text-[13.5px] font-semibold"
                      >
                        {onlineNodesCount} / {scchQuota.idleCapacityNodes}
                      </div>
                    </div>

                    <div
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[8px] px-3 py-2"
                    >
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[11px]"
                      >
                        月度账单
                      </div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="font-mono-num mt-0.5 text-[13.5px] font-semibold"
                      >
                        ${scchQuota.monthlyCostUsd}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Card 2: 自建服务端 */}
          <Card
            style={{
              borderColor: !isCloudMode
                ? "var(--status-ok-border)"
                : "var(--border-hairline)",
            }}
            className="flex flex-col justify-between gap-5 p-5"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-hairline)",
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[8px]"
                  >
                    <Server className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <div
                      style={{ color: "var(--text-primary)" }}
                      className="text-[15px] font-semibold"
                    >
                      自建服务端
                    </div>
                    <div
                      style={{ color: "var(--text-tertiary)" }}
                      className="text-[12px]"
                    >
                      无额度限制 · 本地存储
                    </div>
                  </div>
                </div>

                {!isCloudMode ? (
                  <Badge tone="ok">当前使用</Badge>
                ) : (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => handleSelectMode("self-hosted-rust")}
                  >
                    切换使用
                  </Button>
                )}
              </div>

              <div
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                }}
                className="flex items-center justify-between gap-2 rounded-[8px] px-3 py-2"
              >
                <code
                  style={{ color: "var(--text-secondary)" }}
                  className="truncate font-mono text-[12px]"
                >
                  {SELF_HOSTED_CMD}
                </code>
                <CopyButton
                  value={SELF_HOSTED_CMD}
                  label="复制安装命令"
                  onCopied={() =>
                    onNotify?.("已复制自建服务端安装命令", "success")
                  }
                />
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* Block 2: 平滑迁移 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3
              style={{ color: "var(--text-secondary)" }}
              className="text-[13px] font-medium"
            >
              平滑迁移
            </h3>
            <Badge tone="neutral">失败自动回退</Badge>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              onClick={handleSimulateFallback}
            >
              模拟自动回退
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={<RotateCcw className="h-3 w-3" aria-hidden="true" />}
              onClick={handleResetMigration}
            >
              重置
            </Button>
          </div>
        </div>

        <Card className="space-y-5 p-5">
          {/* Target URL + Action */}
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <label htmlFor={targetInputId} className="sr-only">
              目标服务地址
            </label>
            <input
              id={targetInputId}
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://monitor.example.com"
              style={{
                backgroundColor: "var(--bg-subtle)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
              }}
              className="font-mono-num h-9 flex-1 rounded-[8px] px-3 text-[13px] outline-none"
            />
            <Button
              size="md"
              variant="primary"
              disabled={migrating}
              icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={handleStartMigration}
            >
              {migrating ? "迁移中..." : "开始迁移"}
            </Button>
          </div>

          {/* 3-Step Visual Progress Bar */}
          <div
            style={{
              backgroundColor: "var(--bg-subtle)",
              border: "1px solid var(--border-hairline)",
            }}
            className="rounded-[10px] px-4 py-3.5"
          >
            <div className="flex items-center justify-between gap-2">
              {steps.map((label, idx) => {
                const completed =
                  !rolledBack && (stepIndex > idx || doneCount === totalCount);
                const current = !rolledBack && stepIndex === idx && doneCount < totalCount;
                return (
                  <React.Fragment key={label}>
                    <div className="flex items-center gap-2">
                      <span
                        style={
                          rolledBack && idx === 0
                            ? {
                                backgroundColor: "var(--status-danger-bg)",
                                color: "var(--status-danger-ink)",
                                border: "1px solid var(--status-danger-border)",
                              }
                            : completed
                              ? {
                                  backgroundColor: "var(--ink-primary)",
                                  color: "var(--ink-on-primary)",
                                }
                              : current
                                ? {
                                    backgroundColor: "var(--accent-soft)",
                                    color: "var(--accent-ink)",
                                    border: "1px solid var(--accent-border)",
                                  }
                                : {
                                    backgroundColor: "var(--bg-sheet)",
                                    color: "var(--text-tertiary)",
                                    border: "1px solid var(--border-subtle)",
                                  }
                        }
                        className="font-mono-num inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                      >
                        {completed ? (
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          idx + 1
                        )}
                      </span>
                      <span
                        style={{
                          color:
                            completed || current
                              ? "var(--text-primary)"
                              : "var(--text-tertiary)",
                        }}
                        className="text-[12.5px] font-medium whitespace-nowrap"
                      >
                        {label}
                      </span>
                    </div>

                    {idx < steps.length - 1 && (
                      <div
                        style={{
                          backgroundColor:
                            !rolledBack && stepIndex > idx
                              ? "var(--ink-primary)"
                              : "var(--border-subtle)",
                        }}
                        className="mx-2 h-[1.5px] flex-1 rounded-full transition-colors"
                      />
                    )}
                  </React.Fragment>
                );
              })}

              <span
                style={{
                  color: rolledBack
                    ? "var(--status-danger-ink)"
                    : "var(--text-secondary)",
                }}
                className="font-mono-num ml-3 text-[12px] font-medium whitespace-nowrap"
              >
                {rolledBack ? "已自动回退" : `${doneCount} / ${totalCount}`}
              </span>
            </div>
          </div>

          {/* Compact Visual Node Status Grid */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
            {nodeItems.map((item) => {
              const view = getNodePhaseView(item.phase);
              return (
                <button
                  key={item.nodeId}
                  type="button"
                  onClick={() =>
                    setNodeItems((prev) =>
                      prev.map((n) =>
                        n.nodeId === item.nodeId
                          ? {
                              ...n,
                              phase:
                                n.phase === "cutover_ok"
                                  ? "queued"
                                  : "cutover_ok",
                            }
                          : n,
                      ),
                    )
                  }
                  style={{
                    backgroundColor: "var(--bg-card)",
                    border: "1px solid var(--border-hairline)",
                  }}
                  className="flex cursor-pointer flex-col gap-2 rounded-[8px] p-3 text-left transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span
                      style={{ color: "var(--text-primary)" }}
                      className="truncate text-[12.5px] font-medium"
                    >
                      {item.nodeName}
                    </span>
                    <StatusDot
                      tone={view.dotTone}
                      pulse={
                        item.phase === "canary_probe" ||
                        item.phase === "handshaking"
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px]">
                    <span
                      style={{ color: "var(--text-tertiary)" }}
                      className="font-mono-num"
                    >
                      {item.regionShort}
                    </span>
                    <span style={{ color: "var(--text-secondary)" }}>
                      {view.label}
                    </span>
                  </div>

                  <MetricBar
                    valuePct={view.pct}
                    toneOverride={
                      item.phase === "cutover_ok"
                        ? "ok"
                        : item.phase === "fallback_safe"
                          ? "danger"
                          : "accent"
                    }
                    thickness={3}
                  />
                </button>
              );
            })}
          </div>
        </Card>
      </section>

      {/* Block 3: 辅助保障 */}
      <section className="space-y-3">
        <h3
          style={{ color: "var(--text-secondary)" }}
          className="text-[13px] font-medium"
        >
          辅助保障
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 掉线提醒 */}
          <Card className="flex items-center justify-between gap-4 p-5">
            <div className="space-y-1">
              <div
                style={{ color: "var(--text-primary)" }}
                className="text-[14px] font-semibold"
              >
                掉线提醒
              </div>
              <StatusDot
                tone={offlineAlertEnabled ? "ok" : "idle"}
                pulse={offlineAlertEnabled}
                label={
                  offlineAlertEnabled ? `正常 · ${lastCheckLabel}` : "已关闭"
                }
                className="font-mono-num"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                size="xs"
                variant="ghost"
                disabled={!offlineAlertEnabled}
                onClick={() => {
                  setLastCheckLabel("刚刚");
                  onNotify?.("连接检测正常", "success");
                }}
              >
                立即检测
              </Button>
              <Switch
                checked={offlineAlertEnabled}
                onChange={(next) => {
                  setOfflineAlertEnabled(next);
                  onNotify?.(
                    next ? "已开启掉线提醒" : "已关闭掉线提醒",
                    "info",
                  );
                }}
                ariaLabel="开启掉线提醒"
              />
            </div>
          </Card>

          {/* 数据备份 */}
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="space-y-1">
              <div
                style={{ color: "var(--text-primary)" }}
                className="text-[14px] font-semibold"
              >
                数据备份
              </div>
              <div
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[12px]"
              >
                {migrationState.lastSnapshotSizeKb} KB · {backupTimeLabel}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="sr-only"
                onChange={handleImportRestore}
              />
              <Button
                size="sm"
                variant="secondary"
                icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={handleExportBackup}
              >
                导出备份
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Upload className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={() => handleImportRestore()}
              >
                导入恢复
              </Button>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

export default MigrationStudioView;
