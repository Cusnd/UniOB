import { useState } from "react";
import {
  BellOff,
  HardDrive,
  KeyRound,
  Server,
  Trash2,
  Volume2,
} from "lucide-react";
import type { NodeSummary, RotateTokenResponse } from "../types";
import { api } from "../api/client";
import {
  formatBytes,
  formatCycleMonth,
  formatRate,
  formatRelativeTime,
  formatTimestamp,
  formatTrafficMode,
  getDiskUsagePct,
  getMetricBarColor,
  isNodeMuted,
} from "../utils/format";
import { CopyButton } from "./CopyButton";

interface HardwareTabProps {
  node: NodeSummary;
  onNodeUpdated: (node: NodeSummary) => void;
  onNodeDeleted: (id: string) => void;
}

export function HardwareTab({
  node,
  onNodeUpdated,
  onNodeDeleted,
}: HardwareTabProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<RotateTokenResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const muted = isNodeMuted(node);
  const disks = node.metrics?.disks ?? [];

  const handleMute = async (seconds: number | null) => {
    setBusyAction("mute");
    setError(null);
    try {
      const muteUntil =
        seconds === null ? null : Math.floor(Date.now() / 1000) + seconds;
      const res = await api.updateNode(node.id, { mute_until: muteUntil });
      onNodeUpdated(res.node);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRotateToken = async () => {
    setBusyAction("rotate");
    setError(null);
    try {
      const res = await api.rotateNodeToken(node.id);
      setRotated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置连接密钥失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDelete = async () => {
    setBusyAction("delete");
    setError(null);
    try {
      await api.deleteNode(node.id);
      onNodeDeleted(node.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除服务器失败");
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* Maintenance Mute Controls */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
              {muted ? (
                <BellOff className="w-4 h-4 text-amber-500" aria-hidden="true" />
              ) : (
                <Volume2 className="w-4 h-4 text-emerald-500" aria-hidden="true" />
              )}
              临时静默告警
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {muted && node.mute_until
                ? `当前已开启静默，告警通知将暂停至 ${formatTimestamp(node.mute_until)}`
                : "正常提醒中：服务器触发异常或恢复时会正常发送告警通知。"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => handleMute(1800)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
            >
              静默 30 分钟
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => handleMute(7200)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
            >
              静默 2 小时
            </button>
            {muted && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => handleMute(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
              >
                取消静默
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hardware & System Specs */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-4">
        <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5 mb-3">
          <Server className="w-4 h-4 text-sky-500" aria-hidden="true" />
          系统配置与连接信息
        </h4>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 text-xs">
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">主机名</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              {node.hostname || "等待首次连接"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">操作系统</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right">
              {node.os || "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">内核 / 架构</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              {[node.kernel, node.arch].filter(Boolean).join(" · ") || "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">客户端版本 / 进程查看</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              {node.agent_version ? `v${node.agent_version}` : "未连接"} ·{" "}
              {node.proc_enabled ? "已开启" : "已禁用"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70 sm:col-span-2">
            <dt className="text-slate-500 dark:text-slate-400">处理器型号</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200 text-right">
              {node.cpu_model || "—"}
              {node.cpu_cores ? ` (${node.cpu_cores} 核)` : ""}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">物理内存 / 虚拟内存</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              {node.mem_total ? formatBytes(node.mem_total) : "—"} /{" "}
              {node.swap_total !== null ? formatBytes(node.swap_total) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">本月统计周期</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              {formatCycleMonth(node.traffic.cycle_key)}（每月 {node.traffic.reset_day} 号重置 · 剩余{" "}
              {node.traffic.days_remaining} 天）
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">统计方式 / 已用流量</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              {formatTrafficMode(node.traffic.count_mode)} · {formatBytes(node.traffic.counted_bytes)}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70">
            <dt className="text-slate-500 dark:text-slate-400">周期下载 / 上传</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              下载 {formatBytes(node.traffic.rx_bytes)} / 上传 {formatBytes(node.traffic.tx_bytes)}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/70 sm:col-span-2">
            <dt className="text-slate-500 dark:text-slate-400">最近连接时间</dt>
            <dd className="font-mono-num text-slate-800 dark:text-slate-200">
              {formatRelativeTime(node.last_seen_ts)} ({formatTimestamp(node.last_seen_ts)})
            </dd>
          </div>
        </dl>
      </div>

      {/* Mounted Filesystems Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <HardDrive className="w-4 h-4 text-sky-500" aria-hidden="true" />
            磁盘分区 ({disks.length})
          </h4>
        </div>
        {disks.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400 dark:text-slate-500">
            暂无磁盘分区数据
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-slate-50 dark:bg-[#131c2e] text-[11px] text-slate-500 dark:text-slate-400 font-mono-num border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th scope="col" className="py-2 px-3">挂载路径</th>
                  <th scope="col" className="py-2 px-3">文件系统</th>
                  <th scope="col" className="py-2 px-3">使用率</th>
                  <th scope="col" className="py-2 px-3 text-right">已用 / 总容量</th>
                  <th scope="col" className="py-2 px-3 text-right">读取速度</th>
                  <th scope="col" className="py-2 px-3 text-right">写入速度</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 font-mono-num">
                {disks.map((d) => {
                  const pct = getDiskUsagePct(d);
                  return (
                    <tr key={d.mp} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                      <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100">
                        {d.mp}
                      </td>
                      <td className="py-2.5 px-3 text-slate-500 dark:text-slate-400">
                        {d.fs}
                      </td>
                      <td className="py-2.5 px-3 min-w-[130px]">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${getMetricBarColor(pct)}`}
                              style={{ width: `${Math.min(100, pct)}%` }}
                            />
                          </div>
                          <span className="w-11 text-right text-slate-700 dark:text-slate-200">
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700 dark:text-slate-200 whitespace-nowrap">
                        {formatBytes(d.used)} / {formatBytes(d.total)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {formatRate(d.r_bps)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {formatRate(d.w_bps)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Token Rotation & Deletion */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-4 space-y-3">
        <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300">
          连接密钥与危险操作
        </h4>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleRotateToken}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <KeyRound className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
              重置连接密钥
            </button>
          </div>

          {!confirmDelete ? (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300 hover:bg-rose-500/20"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              移除服务器
            </button>
          ) : (
            <div className="inline-flex items-center gap-2">
              <span className="text-xs text-rose-500 font-medium">
                确定移除该服务器并清空历史监控数据？
              </span>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleDelete}
                className="px-2.5 py-1 rounded-md text-xs font-semibold bg-rose-600 text-white hover:bg-rose-500"
              >
                确认移除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-2.5 py-1 rounded-md text-xs border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                取消
              </button>
            </div>
          )}
        </div>

        {rotated && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sky-700 dark:text-sky-300">
                已生成新连接密钥（旧连接已失效，新命令仅显示一次）：
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 text-slate-100 rounded-md p-2.5 font-mono-num text-[11px] overflow-x-auto">
              <code className="flex-1 whitespace-pre-wrap break-all">
                {rotated.install_cmd}
              </code>
              <CopyButton
                text={rotated.install_cmd}
                label="复制命令"
                ariaLabel="复制重新安装命令"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono-num text-slate-600 dark:text-slate-300">
              <span>新密钥：{rotated.agent_token}</span>
              <CopyButton
                text={rotated.agent_token}
                label="复制密钥"
                ariaLabel="复制新连接密钥"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
