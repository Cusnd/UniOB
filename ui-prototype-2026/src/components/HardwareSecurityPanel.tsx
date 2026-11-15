import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  BellOff,
  Check,
  Copy,
  Gauge,
  HardDrive,
  KeyRound,
  Server,
  ShieldCheck,
  Trash2,
  Volume2,
} from "lucide-react";
import type { PrototypeNode, RotateTokenResponse } from "../types";
import {
  formatBytes,
  formatCycleMonth,
  formatRate,
  formatRelativeTime,
  formatTimestamp,
  formatTrafficMode,
  getDiskUsagePct,
  getMetricBarColor,
  getMetricTextColor,
  getTrafficUsagePct,
  isNodeMuted,
} from "../utils/format";

export interface HardwareSecurityPanelProps {
  node: PrototypeNode;
  onMuteNode: (nodeId: string, seconds: number | null) => void;
  onRotateToken: (nodeId: string) => RotateTokenResponse;
  onDeleteNode: (nodeId: string) => void;
  onClose: () => void;
}

async function copyToClipboardSafe(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}

function InlineCopyButton({
  text,
  label,
  ariaLabel,
}: {
  text: string;
  label: string;
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const ok = await copyToClipboardSafe(text);
    setCopied(ok);
    setFailed(!ok);
    setAnnouncement(ok ? `${label}成功` : "复制失败，请手动选中复制");
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
      setAnnouncement("");
      timerRef.current = null;
    }, 2200);
  };

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={ariaLabel}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
          copied
            ? "border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : failed
              ? "border-rose-500/45 bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
        }`}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        )}
        <span>{copied ? "已复制" : label}</span>
      </button>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </span>
  );
}

export function HardwareSecurityPanel({
  node,
  onMuteNode,
  onRotateToken,
  onDeleteNode,
  onClose,
}: HardwareSecurityPanelProps): React.JSX.Element {
  const baseId = useId();
  const diskCaptionId = `${baseId}-disk-caption`;

  const [rotated, setRotated] = useState<RotateTokenResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const muted = isNodeMuted(node);
  const disks = node.metrics?.disks ?? [];
  const traffic = node.traffic;
  const trafficPct = getTrafficUsagePct(traffic);
  const hasLimit = traffic.limit_bytes !== null && traffic.limit_bytes > 0;
  const remainingBytes = hasLimit
    ? Math.max(0, (traffic.limit_bytes ?? 0) - traffic.counted_bytes)
    : null;

  const handleRotate = () => {
    const res = onRotateToken(node.id);
    setRotated(res);
  };

  const handleConfirmDelete = () => {
    onDeleteNode(node.id);
    onClose();
  };

  return (
    <div className="space-y-4">
      {/* Bento 2-Column Hardware Specs & Traffic Billing Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Column 1: Hardware & System Spec Sheet */}
        <section className="surface-card rounded-xl p-4 space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <Server
                className="w-4 h-4 text-[var(--accent-primary)]"
                aria-hidden="true"
              />
              <span>硬件与系统规格清单</span>
            </h3>
            <span className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
              {node.region_flag} {node.region_code} · {node.provider}
            </span>
          </div>

          <dl className="grid grid-cols-1 gap-y-2 text-xs">
            <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
              <dt className="text-slate-500 dark:text-slate-400 shrink-0">
                主机名 / 掩码 IP
              </dt>
              <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right truncate">
                {node.hostname || "等待首次握手"} · {node.ipv4_masked}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
              <dt className="text-slate-500 dark:text-slate-400 shrink-0">
                操作系统
              </dt>
              <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right truncate">
                {node.os || "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
              <dt className="text-slate-500 dark:text-slate-400 shrink-0">
                内核版本 / 架构
              </dt>
              <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right truncate">
                {[node.kernel, node.arch].filter(Boolean).join(" · ") || "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
              <dt className="text-slate-500 dark:text-slate-400 shrink-0">
                处理器型号
              </dt>
              <dd
                className="font-mono-num text-slate-800 dark:text-slate-200 text-right truncate"
                title={node.cpu_model ?? undefined}
              >
                {node.cpu_model || "—"}
                {node.cpu_cores ? ` (${node.cpu_cores} 核)` : ""}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
              <dt className="text-slate-500 dark:text-slate-400 shrink-0">
                物理内存 / Swap
              </dt>
              <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right">
                {node.mem_total ? formatBytes(node.mem_total) : "—"} /{" "}
                {node.swap_total !== null ? formatBytes(node.swap_total) : "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
              <dt className="text-slate-500 dark:text-slate-400 shrink-0">
                探针版本 / /proc 权限
              </dt>
              <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right">
                {node.agent_version ? `v${node.agent_version}` : "未安装"} ·{" "}
                <span
                  className={
                    node.proc_enabled
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
                  }
                >
                  {node.proc_enabled ? "允许进程透视" : "隐私锁定已禁用"}
                </span>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-1">
              <dt className="text-slate-500 dark:text-slate-400 shrink-0">
                最近心跳时间
              </dt>
              <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right">
                {formatRelativeTime(node.last_seen_ts)} (
                {formatTimestamp(node.last_seen_ts)})
              </dd>
            </div>
          </dl>

          {node.tags.length > 0 && (
            <div className="pt-1 flex flex-wrap items-center gap-1.5">
              {node.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 rounded-md text-[11px] font-mono-num bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700/80"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Column 2: Monthly Traffic Billing Ledger */}
        <section className="surface-card rounded-xl p-4 space-y-3 min-w-0 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                <Gauge
                  className="w-4 h-4 text-[var(--accent-primary)]"
                  aria-hidden="true"
                />
                <span>月度流量计费账本明细</span>
              </h3>
              <span className="px-2 py-0.5 rounded-md text-[11px] font-mono-num font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                {formatTrafficMode(traffic.count_mode)}
              </span>
            </div>

            {/* Quota Progress Block */}
            <div className="rounded-lg border border-slate-200/80 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-900/50 p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2 font-mono-num">
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    本周期已计费流量
                  </div>
                  <div className="text-base font-bold text-slate-900 dark:text-slate-50">
                    {formatBytes(traffic.counted_bytes)}
                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                      {" "}
                      /{" "}
                      {hasLimit
                        ? formatBytes(traffic.limit_bytes)
                        : "无配额上限"}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  {hasLimit ? (
                    <span
                      className={`text-sm font-bold ${getMetricTextColor(trafficPct)}`}
                    >
                      {trafficPct.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      不限量
                    </span>
                  )}
                </div>
              </div>

              {hasLimit && (
                <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${getMetricBarColor(trafficPct)}`}
                    style={{ width: `${Math.min(100, trafficPct)}%` }}
                  />
                </div>
              )}
            </div>

            <dl className="grid grid-cols-1 gap-y-2 text-xs">
              <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
                <dt className="text-slate-500 dark:text-slate-400">账单周期</dt>
                <dd className="font-mono-num text-slate-800 dark:text-slate-200">
                  {formatCycleMonth(traffic.cycle_key)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
                <dt className="text-slate-500 dark:text-slate-400">
                  重置日与剩余天数
                </dt>
                <dd className="font-mono-num text-slate-800 dark:text-slate-200">
                  每月 {traffic.reset_day} 号重置 · 剩余{" "}
                  <strong>{traffic.days_remaining}</strong> 天
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-1 border-b border-slate-200/70 dark:border-slate-800/80">
                <dt className="text-slate-500 dark:text-slate-400">
                  本周期剩余可用配额
                </dt>
                <dd className="font-mono-num text-slate-800 dark:text-slate-200">
                  {remainingBytes !== null
                    ? formatBytes(remainingBytes)
                    : "无限制"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-1">
                <dt className="text-slate-500 dark:text-slate-400">
                  下行 / 上行累计明细
                </dt>
                <dd className="font-mono-num text-slate-800 dark:text-slate-200 flex items-center gap-3">
                  <span className="inline-flex items-center gap-1">
                    <ArrowDownToLine
                      className="w-3 h-3 text-cyan-500"
                      aria-hidden="true"
                    />
                    {formatBytes(traffic.rx_bytes)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ArrowUpFromLine
                      className="w-3 h-3 text-indigo-500"
                      aria-hidden="true"
                    />
                    {formatBytes(traffic.tx_bytes)}
                  </span>
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      {/* Mounted Disk Partitions Real-Time Throughput Table */}
      <section className="surface-card rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <HardDrive
              className="w-4 h-4 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>挂载磁盘分区与实时吞吐 ({disks.length})</span>
          </h3>
          <span className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
            实时块设备 I/O 速率
          </span>
        </div>

        {disks.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            {node.online
              ? "暂无挂载磁盘分区上报数据"
              : "节点离线，暂无挂载磁盘实时吞吐快照"}
          </div>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={diskCaptionId}
            className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)]"
          >
            <table className="w-full text-left border-collapse text-xs">
              <caption id={diskCaptionId} className="sr-only">
                {node.name} 挂载磁盘分区容量与实时读写吞吐表
              </caption>
              <thead className="bg-slate-50/90 dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
                <tr>
                  <th scope="col" className="py-2 px-3">
                    挂载路径
                  </th>
                  <th scope="col" className="py-2 px-3">
                    文件系统
                  </th>
                  <th scope="col" className="py-2 px-3 min-w-[150px]">
                    空间使用率
                  </th>
                  <th scope="col" className="py-2 px-3 text-right">
                    已用 / 总容量
                  </th>
                  <th scope="col" className="py-2 px-3 text-right">
                    读取速率
                  </th>
                  <th scope="col" className="py-2 px-3 text-right">
                    写入速率
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/80 font-mono-num">
                {disks.map((d) => {
                  const pct = getDiskUsagePct(d);
                  return (
                    <tr
                      key={`${d.mp}-${d.fs}`}
                      className="hover:bg-slate-500/[0.04]"
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {d.mp}
                      </td>
                      <td className="py-2.5 px-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {d.fs}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${getMetricBarColor(pct)}`}
                              style={{ width: `${Math.min(100, pct)}%` }}
                            />
                          </div>
                          <span
                            className={`w-12 text-right font-semibold ${getMetricTextColor(pct)}`}
                          >
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700 dark:text-slate-200 whitespace-nowrap">
                        {formatBytes(d.used)} / {formatBytes(d.total)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
                        {formatRate(d.r_bps)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-orange-600 dark:text-orange-400 whitespace-nowrap">
                        {formatRate(d.w_bps)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Maintenance Mute Panel */}
      <section className="surface-card rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              {muted ? (
                <BellOff
                  className="w-4 h-4 text-amber-500"
                  aria-hidden="true"
                />
              ) : (
                <Volume2
                  className="w-4 h-4 text-emerald-500"
                  aria-hidden="true"
                />
              )}
              <span>维护静默与告警抑制</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
              {muted && node.mute_until
                ? `维护静默生效中：所有告警推送将暂停至 ${formatTimestamp(node.mute_until)}`
                : "告警通知正常激活：达到阈值或离线时将实时触发路由通知。"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onMuteNode(node.id, 1800)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              静默 30 分钟
            </button>
            <button
              type="button"
              onClick={() => onMuteNode(node.id, 7200)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              静默 2 小时
            </button>
            <button
              type="button"
              disabled={!muted}
              onClick={() => onMuteNode(node.id, null)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              取消静默
            </button>
          </div>
        </div>
      </section>

      {/* Token Rotation Security Panel */}
      <section className="surface-card rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <ShieldCheck
                className="w-4 h-4 text-[var(--accent-primary)]"
                aria-hidden="true"
              />
              <span>连接密钥轮换与探针凭据安全</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              轮换后旧的 WebSocket Bearer Token 将立即吊销，仅一次性显示新密钥与重装命令。
            </p>
          </div>

          <button
            type="button"
            onClick={handleRotate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          >
            <KeyRound
              className="w-3.5 h-3.5 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>轮换连接密钥</span>
          </button>
        </div>

        {rotated && (
          <div className="rounded-lg border border-sky-500/35 bg-sky-500/[0.08] p-3.5 space-y-2.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-sky-800 dark:text-sky-300">
                已生成一次性新凭据（旧密钥已失效，请尽快在目标主机更新）：
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950 text-slate-100 p-2.5 border border-slate-800">
              <code className="flex-1 min-w-0 font-mono-num text-[11px] break-all">
                {rotated.install_cmd}
              </code>
              <InlineCopyButton
                text={rotated.install_cmd}
                label="复制重装命令"
                ariaLabel="复制一次性重装命令"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700/80 bg-white/80 dark:bg-slate-900/70 px-3 py-2">
              <span className="font-mono-num text-[11px] text-slate-700 dark:text-slate-300 break-all">
                新 Agent Token：
                <strong className="text-slate-900 dark:text-slate-100">
                  {rotated.agent_token}
                </strong>
              </span>
              <InlineCopyButton
                text={rotated.agent_token}
                label="复制密钥"
                ariaLabel="复制新连接密钥"
              />
            </div>
          </div>
        )}
      </section>

      {/* Stable Two-Step Remove Server Zone (Fixed trigger position prevents misclicks) */}
      <section className="surface-card rounded-xl p-4 border border-rose-500/25 bg-rose-500/[0.03] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h3 className="text-xs font-semibold text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>移除服务器（危险操作）</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              永久删除节点注册信息与关联遥测归档；此操作不可逆转。
            </p>
          </div>

          {/* Primary trigger stays anchored in the exact same position without jumping */}
          <button
            type="button"
            disabled={confirmDelete}
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-rose-500/45 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{confirmDelete ? "待下方二次确认" : "移除服务器"}</span>
          </button>
        </div>

        {/* Dedicated confirmation slot below; never replaces or moves the primary trigger */}
        {confirmDelete && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-rose-800 dark:text-rose-200">
              确认永久移除节点{" "}
              <strong className="font-mono-num">{node.name}</strong>{" "}
              并清空监控账本？
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1 rounded-md text-xs font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                取消操作
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-3 py-1 rounded-md text-xs font-semibold bg-rose-600 text-white hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              >
                确认永久移除
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
