import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import type {
  CreateNodePayload,
  CreateNodeResponse,
  HorizonNode,
  TrafficCountMode,
} from "../types";
import type { WsConnectionStatus } from "../hooks/useFleetSocket";
import {
  Button,
  CopyButton,
  GroupCombobox,
  IconCloseButton,
  NativeDialog,
} from "./ui/Primitives";

export interface AddServerWizardModalProps {
  open: boolean;
  existingGroups: string[];
  nodes: HorizonNode[];
  wsStatus: WsConnectionStatus;
  onClose: () => void;
  onCreateNode: (payload: CreateNodePayload) => Promise<CreateNodeResponse>;
  onRefreshNodes: () => Promise<void>;
  onInspectNode: (node: HorizonNode) => void;
}

type QuotaPreset = "unlimited" | "500" | "1024" | "2048" | "custom";

const GB_BYTES = 1024 * 1024 * 1024;

const QUOTA_PRESETS: Array<{ id: QuotaPreset; label: string }> = [
  { id: "unlimited", label: "不限" },
  { id: "500", label: "500G" },
  { id: "1024", label: "1T" },
  { id: "2048", label: "2T" },
  { id: "custom", label: "自定义" },
];

export function AddServerWizardModal(
  props: AddServerWizardModalProps,
): React.JSX.Element {
  const {
    open,
    existingGroups,
    nodes,
    wsStatus,
    onClose,
    onCreateNode,
    onRefreshNodes,
    onInspectNode,
  } = props;

  const titleId = useId();
  const wasOpenRef = useRef(false);

  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [quotaPreset, setQuotaPreset] = useState<QuotaPreset>("unlimited");
  const [customGb, setCustomGb] = useState("1000");
  const [resetDay, setResetDay] = useState(1);
  const [countMode, setCountMode] = useState<TrafficCountMode>("both");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateNodeResponse | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Reset form cleanly only when the modal transitions from closed -> open
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setName("");
      setGroupName(existingGroups[0] ?? "");
      setTagsInput("");
      setQuotaPreset("unlimited");
      setCustomGb("1000");
      setResetDay(1);
      setCountMode("both");
      setSubmitting(false);
      setError(null);
      setCreated(null);
      setCopiedCmd(false);
      setRefreshing(false);
    }
    wasOpenRef.current = open;
  }, [open, existingGroups]);

  const liveNode = useMemo(() => {
    if (!created) return null;
    return nodes.find((n) => n.id === created.node.id) ?? null;
  }, [created, nodes]);

  const isOnline = Boolean(liveNode?.online);

  // Fallback polling every 3s if WebSocket is not actively connected while waiting
  useEffect(() => {
    if (!open || !created || isOnline || wsStatus === "connected") return;
    const timer = window.setInterval(() => {
      void onRefreshNodes();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [open, created, isOnline, wsStatus, onRefreshNodes]);

  const activeStep: 1 | 2 | 3 = !created
    ? 1
    : isOnline || copiedCmd
      ? 3
      : 2;

  const handleSubmitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const cleanName = name.trim();
    if (!cleanName) {
      setError("请填写服务器名称");
      return;
    }

    let limitBytes: number | null = null;
    if (quotaPreset === "custom") {
      const parsed = Number(customGb.trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("请填写有效的月流量配额（GB）");
        return;
      }
      limitBytes = Math.round(parsed * GB_BYTES);
    } else if (quotaPreset !== "unlimited") {
      limitBytes = Math.round(Number(quotaPreset) * GB_BYTES);
    }

    const tags = tagsInput
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: CreateNodePayload = {
      name: cleanName,
      group_name: groupName.trim(),
      tags,
      sort_order: nodes.length,
      traffic_limit_bytes: limitBytes,
      traffic_reset_day: Math.min(28, Math.max(1, Math.round(resetDay))),
      traffic_count_mode: countMode,
    };

    setSubmitting(true);
    setError(null);
    try {
      const res = await onCreateNode(payload);
      setCreated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建服务器失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  const handleManualRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshNodes();
    } finally {
      setRefreshing(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <NativeDialog
      open={open}
      onClose={handleClose}
      titleId={titleId}
      maxWidthClass="max-w-[480px]"
    >
      <div className="space-y-5 p-6">
        <div className="flex items-center justify-between">
          <h3
            id={titleId}
            style={{ color: "var(--text-primary)" }}
            className="text-[16px] font-semibold"
          >
            添加服务器
          </h3>
          <IconCloseButton onClick={handleClose} />
        </div>

        {/* Clean 3-Step Visual Progress */}
        <div className="flex items-center justify-between gap-2">
          {(
            [
              { step: 1, label: "填写信息" },
              { step: 2, label: "复制安装命令" },
              { step: 3, label: "等待上线" },
            ] as const
          ).map((item, idx) => {
            const done =
              activeStep > item.step || (item.step === 3 && isOnline);
            const active = activeStep === item.step && !done;
            return (
              <React.Fragment key={item.step}>
                <div className="flex items-center gap-2">
                  <span
                    style={
                      done
                        ? {
                            backgroundColor: "var(--ink-primary)",
                            color: "var(--ink-on-primary)",
                          }
                        : active
                          ? {
                              backgroundColor: "var(--accent-soft)",
                              color: "var(--accent-ink)",
                              border: "1px solid var(--accent-border)",
                            }
                          : {
                              backgroundColor: "var(--bg-subtle)",
                              color: "var(--text-tertiary)",
                              border: "1px solid var(--border-subtle)",
                            }
                    }
                    className="font-mono-num inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                  >
                    {done ? (
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      item.step
                    )}
                  </span>
                  <span
                    style={{
                      color:
                        active || done
                          ? "var(--text-primary)"
                          : "var(--text-tertiary)",
                    }}
                    className="text-[12.5px] font-medium whitespace-nowrap"
                  >
                    {item.label}
                  </span>
                </div>
                {idx < 2 && (
                  <div
                    style={{
                      backgroundColor: done
                        ? "var(--ink-primary)"
                        : "var(--border-subtle)",
                    }}
                    className="h-[1px] flex-1"
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {error && (
          <div
            role="alert"
            style={{
              backgroundColor: "var(--status-danger-bg)",
              border: "1px solid var(--status-danger-border)",
              color: "var(--status-danger-ink)",
            }}
            className="rounded-[8px] px-3 py-2 text-[12px]"
          >
            {error}
          </div>
        )}

        {!created ? (
          <form
            onSubmit={(e) => void handleSubmitCreate(e)}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="add-srv-name"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                服务器名称
              </label>
              <input
                id="add-srv-name"
                name="name"
                type="text"
                required
                autoFocus
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="例如：tokyo-edge-01"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="add-srv-group"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  分组
                </label>
                <GroupCombobox
                  id="add-srv-group"
                  name="group_name"
                  value={groupName}
                  onChange={setGroupName}
                  existingGroups={existingGroups}
                  placeholder="例如：亚太节点"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="add-srv-tags"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  标签（选填）
                </label>
                <input
                  id="add-srv-tags"
                  name="tags"
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="东京, BGP"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>
            </div>

            {/* Monthly Traffic Quota */}
            <div className="space-y-2">
              <span
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                月流量配额
              </span>
              <div className="grid grid-cols-5 gap-1.5">
                {QUOTA_PRESETS.map((item) => {
                  const selected = quotaPreset === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setQuotaPreset(item.id)}
                      style={
                        selected
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
                      className="font-mono-num h-8 cursor-pointer rounded-[7px] text-[12px] font-medium transition-colors"
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              {quotaPreset !== "unlimited" && (
                <div className="grid grid-cols-3 gap-2 pt-1">
                  {quotaPreset === "custom" && (
                    <div className="space-y-1">
                      <label
                        htmlFor="add-srv-custom-gb"
                        style={{ color: "var(--text-tertiary)" }}
                        className="block text-[11px]"
                      >
                        配额（GB）
                      </label>
                      <input
                        id="add-srv-custom-gb"
                        name="custom_gb"
                        type="number"
                        min={1}
                        step="any"
                        value={customGb}
                        onChange={(e) => {
                          setCustomGb(e.target.value);
                          if (error) setError(null);
                        }}
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          color: "var(--text-primary)",
                          border: "1px solid var(--border-subtle)",
                        }}
                        className="font-mono-num h-8 w-full rounded-[7px] px-2.5 text-[12.5px] outline-none"
                      />
                    </div>
                  )}

                  <div className="space-y-1">
                    <label
                      htmlFor="add-srv-reset-day"
                      style={{ color: "var(--text-tertiary)" }}
                      className="block text-[11px]"
                    >
                      重置日（1-28）
                    </label>
                    <input
                      id="add-srv-reset-day"
                      name="traffic_reset_day"
                      type="number"
                      min={1}
                      max={28}
                      value={resetDay}
                      onChange={(e) =>
                        setResetDay(
                          Math.min(28, Math.max(1, Number(e.target.value) || 1)),
                        )
                      }
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-subtle)",
                      }}
                      className="font-mono-num h-8 w-full rounded-[7px] px-2.5 text-[12.5px] outline-none"
                    />
                  </div>

                  <div
                    className={`space-y-1 ${quotaPreset === "custom" ? "" : "col-span-2"}`}
                  >
                    <label
                      htmlFor="add-srv-count-mode"
                      style={{ color: "var(--text-tertiary)" }}
                      className="block text-[11px]"
                    >
                      计费方向
                    </label>
                    <select
                      id="add-srv-count-mode"
                      name="traffic_count_mode"
                      value={countMode}
                      onChange={(e) =>
                        setCountMode(e.target.value as TrafficCountMode)
                      }
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-subtle)",
                      }}
                      className="h-8 w-full rounded-[7px] px-2 text-[12px] outline-none"
                    >
                      <option value="both">双向计费</option>
                      <option value="tx_only">仅计上传</option>
                      <option value="max">双向取大</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={handleClose}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={submitting}
                icon={
                  submitting ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : undefined
                }
              >
                {submitting ? "生成中..." : "下一步"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            {/* Step 2: Clean Copyable Install Command */}
            <div className="space-y-1.5">
              <div
                style={{ color: "var(--text-secondary)" }}
                className="text-[12px] font-medium"
              >
                在目标服务器终端执行一键安装命令
              </div>
              <div
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="space-y-3 rounded-[10px] p-3.5"
              >
                <code
                  style={{ color: "var(--text-primary)" }}
                  className="block break-all font-mono text-[12px] leading-relaxed"
                >
                  {created.install_cmd}
                </code>
                <div className="flex justify-end">
                  <CopyButton
                    value={created.install_cmd}
                    label="复制安装命令"
                    onCopied={() => setCopiedCmd(true)}
                  />
                </div>
              </div>
            </div>

            {/* Step 3: Live Connection Waiting / Online Confirmation */}
            <div
              role="status"
              aria-live="polite"
              style={{
                backgroundColor: isOnline
                  ? "var(--status-ok-bg)"
                  : "var(--bg-subtle)",
                border: `1px solid ${
                  isOnline
                    ? "var(--status-ok-border)"
                    : "var(--border-hairline)"
                }`,
              }}
              className="flex items-center justify-between gap-3 rounded-[10px] px-4 py-3.5"
            >
              {isOnline ? (
                <div className="flex items-center gap-2.5">
                  <span
                    style={{
                      backgroundColor: "var(--status-ok)",
                      color: "var(--bg-sheet)",
                    }}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <div>
                    <div
                      style={{ color: "var(--status-ok-ink)" }}
                      className="text-[13px] font-semibold"
                    >
                      {created.node.name} 已连接上线
                    </div>
                    {liveNode?.os && (
                      <div
                        style={{ color: "var(--text-secondary)" }}
                        className="font-mono-num text-[11.5px]"
                      >
                        {liveNode.os}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2.5">
                    <Loader2
                      style={{ color: "var(--accent)" }}
                      className="h-4 w-4 shrink-0 animate-spin"
                      aria-hidden="true"
                    />
                    <span
                      style={{ color: "var(--text-secondary)" }}
                      className="text-[12.5px]"
                    >
                      等待 {created.node.name} 首次连接...
                    </span>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={refreshing}
                    icon={
                      <RefreshCw
                        className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                        aria-hidden="true"
                      />
                    }
                    onClick={() => void handleManualRefresh()}
                  >
                    刷新状态
                  </Button>
                </>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCreated(null);
                  setName("");
                  setCopiedCmd(false);
                }}
              >
                继续添加下一台
              </Button>

              <div className="flex items-center gap-2">
                {isOnline && liveNode && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onInspectNode(liveNode)}
                  >
                    查看详情
                  </Button>
                )}
                <Button variant="primary" size="sm" onClick={handleClose}>
                  完成
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </NativeDialog>
  );
}

export default AddServerWizardModal;
