import {
  ArrowDown,
  ArrowUp,
  BellOff,
  Flame,
  HardDrive,
  Server,
} from "lucide-react";
import type { NodeSummary } from "../types";
import {
  formatBytes,
  formatRate,
  formatRelativeTime,
  formatUptime,
  getDiskUsagePct,
  getMemTotalBytes,
  getMemUsagePct,
  getMetricBarColor,
  getMetricTextColor,
  getRootDisk,
  getTrafficUsagePct,
  isNodeMuted,
  parseOsBadge,
} from "../utils/format";

interface FleetGridProps {
  nodes: NodeSummary[];
  onSelectNode: (node: NodeSummary) => void;
}

export function FleetGrid({ nodes, onSelectNode }: FleetGridProps) {
  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-12 text-center">
        <Server className="w-8 h-8 mx-auto text-slate-400 mb-2" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
          暂无匹配的服务器
        </p>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
          尝试切换分组筛选，或点击右上角「添加服务器」添加 Linux 服务器。
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {nodes.map((node) => {
        const m = node.metrics;
        const cpuPct = m?.cpu.all ?? 0;
        const stealPct = m?.cpu.steal ?? 0;
        const memPct = getMemUsagePct(node);
        const memTotal = getMemTotalBytes(node);
        const rootDisk = getRootDisk(m?.disks);
        const diskPct = getDiskUsagePct(rootDisk);
        const osBadge = parseOsBadge(node.os);
        const muted = isNodeMuted(node);
        const trafficLimit = node.traffic.limit_bytes;
        const trafficPct = getTrafficUsagePct(node.traffic);

        return (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node)}
            className={`group text-left rounded-xl border transition-[border-color,box-shadow] p-4 flex flex-col gap-3.5 focus:outline-none focus:ring-2 focus:ring-sky-500/40 ${
              node.online
                ? "border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] hover:border-sky-500/50 dark:hover:border-sky-500/50 shadow-xs"
                : "border-rose-500/25 dark:border-rose-500/30 bg-white/80 dark:bg-[#0f1623]/75 hover:border-rose-500/50 opacity-85"
            }`}
          >
            {/* Card Header */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    {node.online && (
                      <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                    )}
                    <span
                      className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                        node.online ? "bg-emerald-500" : "bg-rose-500"
                      }`}
                    />
                  </span>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-sky-600 dark:group-hover:text-sky-400">
                    {node.name}
                  </h3>
                  {muted && (
                    <span title="告警已静默">
                      <BellOff className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-hidden="true" />
                      <span className="sr-only">告警已静默</span>
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono-num truncate">
                  <span className="truncate">{node.hostname || "等待首次连接"}</span>
                  <span>·</span>
                  <span>{node.cpu_cores ? `${node.cpu_cores} 核` : "—"}</span>
                  <span>·</span>
                  <span>{node.arch || "linux"}</span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 shrink-0">
                <div className="flex items-center gap-1">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                    {node.group_name}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${osBadge.colorClass}`}
                  >
                    {osBadge.short}
                  </span>
                </div>
                <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                  {node.online ? (
                    <>
                      运行 {formatUptime(m?.up)} · 负载{" "}
                      <span className="text-slate-700 dark:text-slate-200">
                        {m ? m.cpu.load[0].toFixed(2) : "—"}
                      </span>
                    </>
                  ) : (
                    <span className="text-rose-500 dark:text-rose-400 font-medium">
                      离线 · {formatRelativeTime(node.last_seen_ts)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Metric Progress Bars */}
            <div className="space-y-2.5 text-xs">
              {/* CPU */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-500 dark:text-slate-400 font-medium">
                      处理器
                    </span>
                    {stealPct >= 1.5 && (
                      <span
                        title="宿主机资源争抢较高"
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-mono-num font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/35"
                      >
                        <Flame className="w-2.5 h-2.5" aria-hidden="true" />
                        CPU 争抢 {stealPct.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <span
                    className={`font-mono-num font-semibold ${
                      m ? getMetricTextColor(cpuPct) : "text-slate-400"
                    }`}
                  >
                    {m ? `${cpuPct.toFixed(1)}%` : "—"}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      m ? getMetricBarColor(cpuPct) : "bg-slate-400"
                    }`}
                    style={{ width: `${m ? Math.min(100, cpuPct) : 0}%` }}
                  />
                </div>
              </div>

              {/* Memory */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-slate-500 dark:text-slate-400 font-medium">
                    内存
                  </span>
                  <span className="font-mono-num text-slate-700 dark:text-slate-200">
                    {m ? (
                      <>
                        {formatBytes(m.mem.used)} / {formatBytes(memTotal)}{" "}
                        <span className={`font-semibold ${getMetricTextColor(memPct)}`}>
                          ({memPct.toFixed(0)}%)
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      m ? getMetricBarColor(memPct) : "bg-slate-400"
                    }`}
                    style={{ width: `${m ? Math.min(100, memPct) : 0}%` }}
                  />
                </div>
              </div>

              {/* Root Disk */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-slate-500 dark:text-slate-400 font-medium inline-flex items-center gap-1">
                    <HardDrive className="w-3 h-3" aria-hidden="true" />
                    磁盘 {rootDisk?.mp ?? "/"}
                  </span>
                  <span className="font-mono-num text-slate-700 dark:text-slate-200">
                    {rootDisk ? (
                      <>
                        {formatBytes(rootDisk.used)} / {formatBytes(rootDisk.total)}{" "}
                        <span className={`font-semibold ${getMetricTextColor(diskPct)}`}>
                          ({diskPct.toFixed(0)}%)
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      rootDisk ? getMetricBarColor(diskPct) : "bg-slate-400"
                    }`}
                    style={{ width: `${rootDisk ? Math.min(100, diskPct) : 0}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Footer: Net Speed + Monthly Traffic Quota */}
            <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800/80 space-y-2">
              <div className="flex items-center justify-between text-xs font-mono-num">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                    <ArrowUp className="w-3 h-3" aria-hidden="true" />
                    {m ? formatRate(m.net.tx_bps) : "0 B/s"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                    <ArrowDown className="w-3 h-3" aria-hidden="true" />
                    {m ? formatRate(m.net.rx_bps) : "0 B/s"}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                  连接数 {m ? m.net.tcp_est : 0}
                </span>
              </div>

              {/* Monthly Traffic Quota Progress */}
              <div>
                <div className="flex items-center justify-between text-[11px] font-mono-num mb-1">
                  <span className="text-slate-500 dark:text-slate-400">月度流量</span>
                  {trafficLimit !== null && trafficLimit > 0 ? (
                    <span className="text-slate-700 dark:text-slate-300">
                      {formatBytes(node.traffic.counted_bytes)} /{" "}
                      {formatBytes(trafficLimit)} · 剩 {node.traffic.days_remaining} 天
                    </span>
                  ) : (
                    <span className="text-slate-500 dark:text-slate-400">
                      已用 {formatBytes(node.traffic.counted_bytes)} · 不限额 · 剩{" "}
                      {node.traffic.days_remaining} 天
                    </span>
                  )}
                </div>
                <div className="h-1 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      trafficLimit !== null && trafficLimit > 0
                        ? trafficPct >= 95
                          ? "bg-rose-500"
                          : trafficPct >= 80
                            ? "bg-amber-500"
                            : "bg-sky-500"
                        : "bg-sky-500/50"
                    }`}
                    style={{
                      width: `${
                        trafficLimit !== null && trafficLimit > 0
                          ? Math.min(100, trafficPct)
                          : Math.min(100, node.traffic.counted_bytes > 0 ? 18 : 0)
                      }%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
