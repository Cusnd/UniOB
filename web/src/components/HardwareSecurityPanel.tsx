import React, { useEffect, useState } from "react";
import { BellOff, KeyRound, Loader2, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  MetricBar,
  formatBytesPerSec,
} from "./ui/Primitives";
import type { HorizonNode, RotateTokenResponse } from "../types";
import { formatAgentUpdateState, formatVersionTag } from "../utils/autoUpdate";
import {
  formatBytes,
  formatRelativeTime,
  formatTrafficMode,
  formatUptime,
  getDiskUsagePct,
  getMemTotalBytes,
  getTrafficUsagePct,
  isNodeMuted,
} from "../utils/format";

export interface HardwareSecurityPanelProps {
  node: HorizonNode;
  onMuteNode: (nodeId: string, seconds: number | null) => Promise<void>;
  onRotateToken: (nodeId: string) => Promise<RotateTokenResponse>;
  onDeleteNode: (nodeId: string) => Promise<void>;
  onClose: () => void;
}

function TrafficProgressRing({ valuePct }: { valuePct: number }): React.JSX.Element {
  const size = 60;
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, valuePct));
  const dashOffset = circumference * (1 - clamped / 100);

  const color =
    clamped >= 88
      ? "var(--status-danger)"
      : clamped >= 75
        ? "var(--status-warn)"
        : "var(--accent)";

  return (
    <div className="relative inline-flex h-[60px] w-[60px] shrink-0 items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-muted)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
      </svg>
      <span className="font-mono-num absolute text-[12px] font-semibold">
        {clamped.toFixed(0)}%
      </span>
    </div>
  );
}

export function HardwareSecurityPanel({
  node,
  onMuteNode,
  onRotateToken,
  onDeleteNode,
  onClose,
}: HardwareSecurityPanelProps): React.JSX.Element {
  const [mutingTarget, setMutingTarget] = useState<
    "30m" | "2h" | "unmute" | null
  >(null);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<RotateTokenResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const busy = mutingTarget !== null || rotating || deleting;

  useEffect(() => {
    setRotated(null);
    setConfirmDelete(false);
    setError(null);
  }, [node.id]);

  const muted = isNodeMuted(node);
  const memTotal = getMemTotalBytes(node);
  const disks = node.metrics?.disks ?? [];
  const traffic = node.traffic;
  const hasLimit = traffic.limit_bytes !== null && traffic.limit_bytes > 0;
  const fiveTb = 5 * 1024 * 1024 * 1024 * 1024;
  const trafficPct = hasLimit
    ? getTrafficUsagePct(traffic)
    : Math.min(100, (traffic.counted_bytes / fiveTb) * 100);

  const handleMute = async (
    seconds: number | null,
    target: "30m" | "2h" | "unmute",
  ) => {
    if (busy) return;
    setMutingTarget(target);
    setError(null);
    try {
      await onMuteNode(node.id, seconds);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setMutingTarget(null);
    }
  };

  const handleRotate = async () => {
    if (busy) return;
    setRotating(true);
    setError(null);
    try {
      const res = await onRotateToken(node.id);
      setRotated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置密钥失败");
    } finally {
      setRotating(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (busy) return;
    setDeleting(true);
    setError(null);
    try {
      await onDeleteNode(node.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          style={{
            backgroundColor: "var(--status-danger-bg)",
            border: "1px solid var(--status-danger-border)",
            color: "var(--status-danger-ink)",
          }}
          className="flex items-center justify-between gap-3 rounded-[9px] px-3.5 py-2 text-[12px]"
        >
          <span>{error}</span>
          <Button variant="ghost" size="xs" onClick={() => setError(null)}>
            关闭
          </Button>
        </div>
      )}

      {/* 1. Clean 4-Item Hardware Summary */}
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px]"
            >
              操作系统
            </div>
            <div className="text-[13.5px] font-medium">
              {[node.os || "Linux", node.arch].filter(Boolean).join(" · ")}
            </div>
          </div>

          <div className="space-y-1">
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px]"
            >
              处理器
            </div>
            <div
              className="truncate text-[13.5px] font-medium"
              title={node.cpu_model ?? undefined}
            >
              {node.cpu_model
                ? `${node.cpu_model}${node.cpu_cores ? ` (${node.cpu_cores} 核)` : ""}`
                : node.cpu_cores
                  ? `${node.cpu_cores} 核`
                  : "—"}
            </div>
          </div>

          <div className="space-y-1">
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px]"
            >
              内存容量
            </div>
            <div className="font-mono-num text-[13.5px] font-medium">
              {memTotal > 0 ? formatBytes(memTotal) : "—"}
              {node.swap_total !== null && node.swap_total > 0
                ? ` · 交换 ${formatBytes(node.swap_total)}`
                : ""}
            </div>
          </div>

          <div className="space-y-1">
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px]"
            >
              在线时长
            </div>
            <div className="font-mono-num text-[13.5px] font-medium">
              {node.online
                ? formatUptime(node.metrics?.up)
                : `离线 · ${formatRelativeTime(node.last_seen_ts)}`}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px]"
            >
              Agent 版本与更新状态
            </div>
            {(() => {
              const upd = formatAgentUpdateState(
                node.update_status,
                node.agent_version,
              );
              return (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono-num text-[13.5px] font-medium">
                    {formatVersionTag(node.agent_version)}
                  </span>
                  {node.update_status && node.update_status.state !== "idle" && (
                    <Badge tone={upd.tone}>{upd.label}</Badge>
                  )}
                  {upd.detail && (
                    <span
                      style={{
                        color:
                          node.update_status?.state === "error"
                            ? "var(--status-danger-ink)"
                            : "var(--text-tertiary)",
                      }}
                      className="text-[12px]"
                    >
                      {upd.detail}
                    </span>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </Card>

      {/* 2. Monthly Traffic Ring + Bar */}
      <Card className="p-5">
        <div className="flex items-center gap-4">
          <TrafficProgressRing valuePct={trafficPct} />
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-[13.5px] font-semibold">月度流量</h3>
                <Badge tone="subtle">
                  {formatTrafficMode(traffic.count_mode)}
                </Badge>
              </div>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[12px]"
              >
                剩余 {traffic.days_remaining} 天
              </span>
            </div>

            <MetricBar
              valuePct={trafficPct}
              valueLabel={
                hasLimit
                  ? `${formatBytes(traffic.counted_bytes)} / ${formatBytes(traffic.limit_bytes)}`
                  : formatBytes(traffic.counted_bytes)
              }
              thickness={4}
            />

            <div
              style={{ color: "var(--text-tertiary)" }}
              className="font-mono-num flex flex-wrap items-center gap-3 text-[11.5px]"
            >
              <span>↓ {formatBytes(traffic.rx_bytes)}</span>
              <span>↑ {formatBytes(traffic.tx_bytes)}</span>
            </div>
          </div>
        </div>
      </Card>

      {/* 3. Visual Disk Mount Bars */}
      <Card className="space-y-4 p-5">
        <h3 className="text-[13.5px] font-semibold">磁盘空间</h3>
        {disks.length === 0 ? (
          <p
            style={{ color: "var(--text-tertiary)" }}
            className="text-[12.5px]"
          >
            暂无磁盘分区数据
          </p>
        ) : (
          <div className="space-y-3.5">
            {disks.map((d, idx) => {
              const pct = getDiskUsagePct(d);
              return (
                <div key={`${d.mp}-${d.fs}-${idx}`} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{d.mp}</span>
                      <Badge tone="subtle">{d.fs}</Badge>
                    </div>
                    <div className="font-mono-num flex items-center gap-3">
                      {(d.r_bps > 0 || d.w_bps > 0) && (
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="text-[11.5px]"
                        >
                          读 {formatBytesPerSec(d.r_bps)} · 写{" "}
                          {formatBytesPerSec(d.w_bps)}
                        </span>
                      )}
                      <span className="font-medium">
                        {formatBytes(d.used)} / {formatBytes(d.total)}
                      </span>
                    </div>
                  </div>
                  <MetricBar valuePct={pct} thickness={4} />
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 4. Compact Node Management Actions */}
      <Card className="space-y-3.5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[13.5px] font-semibold">快捷操作</h3>
            {muted && <Badge tone="warn">告警静音中</Badge>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="xs"
              disabled={busy}
              onClick={() => void handleMute(1800, "30m")}
              icon={
                mutingTarget === "30m" ? (
                  <Loader2
                    className="h-3 w-3 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <BellOff className="h-3 w-3" aria-hidden="true" />
                )
              }
            >
              静音 30 分钟
            </Button>

            <Button
              variant="secondary"
              size="xs"
              disabled={busy}
              onClick={() => void handleMute(7200, "2h")}
            >
              静音 2 小时
            </Button>

            {muted && (
              <Button
                variant="accent"
                size="xs"
                disabled={busy}
                onClick={() => void handleMute(null, "unmute")}
              >
                取消静音
              </Button>
            )}

            <Button
              variant="secondary"
              size="xs"
              disabled={busy}
              onClick={() => void handleRotate()}
              icon={
                rotating ? (
                  <Loader2
                    className="h-3 w-3 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <KeyRound className="h-3 w-3" aria-hidden="true" />
                )
              }
            >
              重置密钥
            </Button>

            <Button
              variant="danger"
              size="xs"
              disabled={busy || confirmDelete}
              onClick={() => setConfirmDelete(true)}
              icon={<Trash2 className="h-3 w-3" aria-hidden="true" />}
            >
              删除
            </Button>
          </div>
        </div>

        {rotated && (
          <div
            style={{
              backgroundColor: "var(--bg-subtle)",
              border: "1px solid var(--border-subtle)",
            }}
            className="space-y-2.5 rounded-[8px] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium">新安装命令</span>
              <CopyButton
                value={rotated.install_cmd}
                label="复制命令"
                copiedLabel="已复制"
              />
            </div>
            <code
              style={{ color: "var(--text-secondary)" }}
              className="block font-mono text-[11px] break-all"
            >
              {rotated.install_cmd}
            </code>
          </div>
        )}

        {confirmDelete && (
          <div
            style={{
              backgroundColor: "var(--status-danger-bg)",
              border: "1px solid var(--status-danger-border)",
            }}
            className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] px-3.5 py-2.5"
          >
            <span
              style={{ color: "var(--status-danger-ink)" }}
              className="text-[12.5px] font-medium"
            >
              确认永久删除 {node.name}？
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                disabled={deleting}
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                size="xs"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
                icon={
                  deleting ? (
                    <Loader2
                      className="h-3 w-3 animate-spin"
                      aria-hidden="true"
                    />
                  ) : undefined
                }
              >
                确认删除
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
