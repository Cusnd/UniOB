import React, { useEffect, useId, useMemo, useState } from "react";
import { Loader2, RefreshCw, ArrowUpCircle } from "lucide-react";
import { api } from "../api/client";
import type {
  AgentLatestRelease,
  AgentUpdateChannel,
  AgentUpdateConfig,
  HorizonNode,
  ToastTone,
  UpdateNodePayload,
} from "../types";
import {
  countUpdateEligibleNodes,
  formatAgentUpdateState,
  formatVersionTag,
  hasUpdateCap,
  resolveEffectiveAutoUpdate,
} from "../utils/autoUpdate";
import {
  Badge,
  Button,
  IconCloseButton,
  NativeDialog,
  SegmentedControl,
  StatusDot,
  Switch,
} from "./ui/Primitives";

export interface AgentUpdateModalProps {
  open: boolean;
  onClose: () => void;
  nodes: HorizonNode[];
  onUpdateNode: (id: string, patch: UpdateNodePayload) => Promise<void>;
  onNotify?: (tone: ToastTone, title: string, description?: string) => void;
}

const DEFAULT_CONFIG: AgentUpdateConfig = {
  auto_update_enabled: false,
  channel: "stable",
  check_interval_sec: 3600,
  custom_base_url: null,
};

function formatReleaseSource(source: AgentLatestRelease["source"]): string {
  switch (source) {
    case "assets":
    case "local":
      return "内置/托管源";
    case "github":
      return "GitHub Releases";
    case "custom":
      return "自定义镜像源";
    default:
      return source;
  }
}

export function AgentUpdateModal({
  open,
  onClose,
  nodes,
  onUpdateNode,
  onNotify,
}: AgentUpdateModalProps): React.JSX.Element {
  const titleId = useId();
  const intervalInputId = useId();
  const baseUrlInputId = useId();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<AgentUpdateConfig>(DEFAULT_CONFIG);
  const [checkIntervalInput, setCheckIntervalInput] = useState("3600");
  const [customUrlInput, setCustomUrlInput] = useState("");
  const [bundledVersion, setBundledVersion] = useState<string>("0.3.1");
  const [latestRelease, setLatestRelease] = useState<AgentLatestRelease | null>(
    null,
  );
  const [savingConfig, setSavingConfig] = useState(false);
  const [checking, setChecking] = useState(false);
  const [triggeringBatch, setTriggeringBatch] = useState(false);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedFlag, setSavedFlag] = useState(false);
  const [triggerMessage, setTriggerMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setSavedFlag(false);
    setTriggerMessage(null);
    void api
      .getAgentUpdateConfig(abort.signal)
      .then((res) => {
        if (abort.signal.aborted) return;
        const cfg = res.config ?? DEFAULT_CONFIG;
        setConfig(cfg);
        setCheckIntervalInput(String(cfg.check_interval_sec || 3600));
        setCustomUrlInput(cfg.custom_base_url ?? "");
        setBundledVersion(res.bundled_version || "0.3.1");
        setLatestRelease(res.latest_release ?? null);
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          setLoadError(
            err instanceof Error ? err.message : "加载自动更新配置失败",
          );
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [open]);

  const targetVersion = latestRelease?.version ?? null;
  const eligibleCount = useMemo(
    () => countUpdateEligibleNodes(nodes, targetVersion),
    [nodes, targetVersion],
  );
  const onlineCount = useMemo(
    () => nodes.filter((n) => n.online).length,
    [nodes],
  );

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingConfig) return;
    const parsedInterval = Number(checkIntervalInput.trim());
    if (
      !Number.isInteger(parsedInterval) ||
      parsedInterval < 60 ||
      parsedInterval > 604800
    ) {
      setActionError("检查间隔需为 60 ~ 604800 秒的整数");
      return;
    }
    const trimmedUrl = customUrlInput.trim();
    if (trimmedUrl && !/^https?:\/\/.+/i.test(trimmedUrl)) {
      setActionError("自定义源地址需以 http:// 或 https:// 开头");
      return;
    }

    setSavingConfig(true);
    setActionError(null);
    setSavedFlag(false);
    try {
      const payload: AgentUpdateConfig = {
        auto_update_enabled: config.auto_update_enabled,
        channel: config.channel,
        check_interval_sec: parsedInterval,
        custom_base_url: trimmedUrl || null,
      };
      const res = await api.updateAgentUpdateConfig(payload);
      setConfig(res.config);
      setCheckIntervalInput(String(res.config.check_interval_sec));
      setCustomUrlInput(res.config.custom_base_url ?? "");
      setLatestRelease(res.latest_release ?? latestRelease);
      if (res.bundled_version) setBundledVersion(res.bundled_version);
      setSavedFlag(true);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "保存自动更新配置失败",
      );
    } finally {
      setSavingConfig(false);
    }
  };

  const handleCheckUpdates = async () => {
    if (checking) return;
    setChecking(true);
    setActionError(null);
    setTriggerMessage(null);
    try {
      const res = await api.checkAgentUpdates();
      setLatestRelease(res.latest_release ?? null);
      if (res.bundled_version) setBundledVersion(res.bundled_version);
      if (res.error) {
        setActionError(res.error);
      } else if (res.latest_release) {
        setTriggerMessage(
          `已检测到可用版本 ${formatVersionTag(res.latest_release.version)}`,
        );
      } else {
        setTriggerMessage("已完成检查，暂未发现新版本资产");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "检查更新失败");
    } finally {
      setChecking(false);
    }
  };

  const handleTriggerUpdate = async (nodeId?: string, force = false) => {
    if (nodeId) {
      setBusyNodeId(nodeId);
    } else {
      setTriggeringBatch(true);
    }
    setActionError(null);
    setTriggerMessage(null);
    try {
      const res = await api.triggerAgentUpdate(
        nodeId ? { node_ids: [nodeId], force: true } : { force },
      );
      const summary = `已下发 ${res.dispatched}/${res.targeted} 台节点${res.version ? ` (${formatVersionTag(res.version)})` : ""}`;
      setTriggerMessage(summary);
      onNotify?.(
        res.dispatched > 0 ? "success" : "info",
        nodeId ? "已下发节点更新指令" : "已触发批量更新",
        summary,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "下发更新失败");
    } finally {
      setBusyNodeId(null);
      setTriggeringBatch(false);
    }
  };

  const handleNodeOverrideChange = async (
    node: HorizonNode,
    raw: "inherit" | "on" | "off",
  ) => {
    const nextOverride = raw === "inherit" ? null : raw === "on";
    setBusyNodeId(node.id);
    setActionError(null);
    try {
      await onUpdateNode(node.id, { auto_update_override: nextOverride });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `更新 ${node.name} 策略失败`,
      );
    } finally {
      setBusyNodeId(null);
    }
  };

  return (
    <NativeDialog
      open={open}
      onClose={onClose}
      titleId={titleId}
      maxWidthClass="max-w-[700px]"
    >
      {open && (
        <div className="space-y-5 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <h2 id={titleId} className="text-[15.5px] font-semibold">
                Agent 自动更新
              </h2>
              <Badge tone="neutral">内置 {formatVersionTag(bundledVersion)}</Badge>
            </div>
            <IconCloseButton onClick={onClose} />
          </div>

          {loading ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-[var(--text-secondary)]"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              正在加载更新策略…
            </div>
          ) : loadError ? (
            <div
              role="alert"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                border: "1px solid var(--status-danger-border)",
                color: "var(--status-danger-ink)",
              }}
              className="rounded-[8px] px-3 py-2.5 text-[12px]"
            >
              {loadError}
            </div>
          ) : (
            <>
              {(actionError || triggerMessage) && (
                <div
                  role={actionError ? "alert" : "status"}
                  style={
                    actionError
                      ? {
                          backgroundColor: "var(--status-danger-bg)",
                          border: "1px solid var(--status-danger-border)",
                          color: "var(--status-danger-ink)",
                        }
                      : {
                          backgroundColor: "var(--bg-subtle)",
                          border: "1px solid var(--border-subtle)",
                          color: "var(--text-primary)",
                        }
                  }
                  className="rounded-[8px] px-3 py-2 text-[12px]"
                >
                  {actionError ?? triggerMessage}
                </div>
              )}

              {/* 1. Latest Release Card & Batch Trigger */}
              <div
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                }}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[9px] px-4 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-medium">最新发行版</span>
                    {latestRelease ? (
                      <>
                        <Badge tone="accent">
                          {formatVersionTag(latestRelease.version)}
                        </Badge>
                        <span className="text-[11.5px] text-[var(--text-tertiary)]">
                          {formatReleaseSource(latestRelease.source)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[12px] text-[var(--text-tertiary)]">
                        暂未检测到可用版本
                      </span>
                    )}
                  </div>
                  {latestRelease && (
                    <div className="font-mono-num flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-tertiary)]">
                      {latestRelease.assets.amd64 && (
                        <span>
                          amd64 · {latestRelease.assets.amd64.sha256.slice(0, 12)}
                        </span>
                      )}
                      {latestRelease.assets.arm64 && (
                        <span>
                          arm64 · {latestRelease.assets.arm64.sha256.slice(0, 12)}
                        </span>
                      )}
                      {eligibleCount > 0 && (
                        <span className="text-[var(--status-warn-ink)]">
                          {eligibleCount} 台在线节点待升级
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={checking}
                    onClick={() => void handleCheckUpdates()}
                    icon={
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`}
                        aria-hidden="true"
                      />
                    }
                  >
                    {checking ? "检查中…" : "检查更新"}
                  </Button>
                  <Button
                    size="xs"
                    variant="primary"
                    disabled={triggeringBatch || onlineCount === 0}
                    onClick={() => void handleTriggerUpdate(undefined, false)}
                    icon={
                      triggeringBatch ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      )
                    }
                  >
                    {triggeringBatch
                      ? "下发中…"
                      : eligibleCount > 0
                        ? `立即更新 (${eligibleCount})`
                        : "立即更新"}
                  </Button>
                </div>
              </div>

              {/* 2. Global Auto-Update Policy Form */}
              <form
                onSubmit={(e) => void handleSaveConfig(e)}
                className="space-y-3 border-b border-[var(--border-hairline)] pb-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="text-[12.5px] font-medium">全局自动更新</div>
                    <p className="text-[11.5px] text-[var(--text-tertiary)]">
                      对选择「跟随全局」的在线节点自动拉取并安全替换二进制
                    </p>
                  </div>
                  <Switch
                    checked={config.auto_update_enabled}
                    ariaLabel="开启全局自动更新"
                    onChange={(auto_update_enabled) => {
                      setSavedFlag(false);
                      setConfig((prev) => ({ ...prev, auto_update_enabled }));
                    }}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                  <div className="space-y-1 sm:col-span-5">
                    <span className="block text-[11.5px] font-medium text-[var(--text-secondary)]">
                      发布通道
                    </span>
                    <SegmentedControl<AgentUpdateChannel>
                      ariaLabel="更新通道"
                      value={config.channel}
                      onChange={(channel) => {
                        setSavedFlag(false);
                        setConfig((prev) => ({ ...prev, channel }));
                      }}
                      options={[
                        { value: "stable", label: "稳定源" },
                        { value: "github", label: "GitHub" },
                      ]}
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-3">
                    <label
                      htmlFor={intervalInputId}
                      className="block text-[11.5px] font-medium text-[var(--text-secondary)]"
                    >
                      检查间隔（秒）
                    </label>
                    <input
                      id={intervalInputId}
                      type="number"
                      min={60}
                      max={604800}
                      value={checkIntervalInput}
                      onChange={(e) => {
                        setSavedFlag(false);
                        setCheckIntervalInput(e.target.value);
                      }}
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-primary)",
                      }}
                      className="font-mono-num h-9 w-full rounded-[8px] px-2.5 text-[12px] outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-4">
                    <label
                      htmlFor={baseUrlInputId}
                      className="block text-[11.5px] font-medium text-[var(--text-secondary)]"
                    >
                      自定义源 Base URL（可选）
                    </label>
                    <input
                      id={baseUrlInputId}
                      type="url"
                      value={customUrlInput}
                      placeholder="https://..."
                      onChange={(e) => {
                        setSavedFlag(false);
                        setCustomUrlInput(e.target.value);
                      }}
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-primary)",
                      }}
                      className="h-9 w-full rounded-[8px] px-2.5 text-[12px] outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-1">
                  {savedFlag && (
                    <span
                      role="status"
                      className="text-[12px] text-[var(--status-ok-ink)]"
                    >
                      已保存策略
                    </span>
                  )}
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={savingConfig}
                    icon={
                      savingConfig ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : undefined
                    }
                  >
                    {savingConfig ? "保存中…" : "保存更新策略"}
                  </Button>
                </div>
              </form>

              {/* 3. Per-Node Version, Status & Override Table */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-[12.5px] font-semibold">节点版本与覆盖策略</h3>
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    在线 {onlineCount} / {nodes.length}
                  </span>
                </div>

                {nodes.length === 0 ? (
                  <p className="py-4 text-center text-[12px] text-[var(--text-tertiary)]">
                    暂无节点
                  </p>
                ) : (
                  <div className="max-h-[260px] divide-y divide-[var(--border-hairline)] overflow-y-auto thin-scrollbar border-t border-b border-[var(--border-hairline)]">
                    {nodes.map((node) => {
                      const stateBadge = formatAgentUpdateState(
                        node.update_status,
                        node.agent_version,
                        targetVersion,
                      );
                      const overrideVal =
                        node.auto_update_override === true
                          ? "on"
                          : node.auto_update_override === false
                            ? "off"
                            : "inherit";
                      const effective = resolveEffectiveAutoUpdate(
                        node.auto_update_override,
                        config.auto_update_enabled,
                      );
                      const busy = busyNodeId === node.id;

                      return (
                        <div
                          key={node.id}
                          className="flex flex-wrap items-center justify-between gap-2.5 py-2.5"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <StatusDot tone={node.online ? "ok" : "danger"} />
                              <span className="truncate text-[12.5px] font-medium">
                                {node.name}
                              </span>
                              <span className="font-mono-num text-[11px] text-[var(--text-tertiary)]">
                                {formatVersionTag(node.agent_version)}
                              </span>
                              <Badge tone={stateBadge.tone}>
                                {stateBadge.label}
                              </Badge>
                              {Array.isArray(node.caps) &&
                                node.caps.length > 0 &&
                                !hasUpdateCap(node.caps) && (
                                  <Badge tone="subtle">不支持自动更新</Badge>
                                )}
                            </div>
                            {stateBadge.detail && (
                              <p
                                className={`text-[11px] ${
                                  node.update_status?.state === "error"
                                    ? "text-[var(--status-danger-ink)]"
                                    : "text-[var(--text-tertiary)]"
                                }`}
                              >
                                {stateBadge.detail}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <select
                              aria-label={`${node.name} 自动更新策略（当前：${effective.label}）`}
                              value={overrideVal}
                              disabled={busy}
                              onChange={(e) =>
                                void handleNodeOverrideChange(
                                  node,
                                  e.target.value as "inherit" | "on" | "off",
                                )
                              }
                              style={{
                                backgroundColor: "var(--bg-subtle)",
                                border: "1px solid var(--border-subtle)",
                                color: "var(--text-secondary)",
                              }}
                              className="h-7 cursor-pointer rounded-[6px] px-2 text-[11.5px] outline-none"
                            >
                              <option value="inherit">跟随全局</option>
                              <option value="on">强制开启</option>
                              <option value="off">禁用</option>
                            </select>

                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={!node.online || busy}
                              onClick={() => void handleTriggerUpdate(node.id, true)}
                            >
                              {busy ? "处理中…" : "更新"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </NativeDialog>
  );
}
