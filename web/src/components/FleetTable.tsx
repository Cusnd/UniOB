import { ArrowDown, ArrowUp, BellOff, Flame, Server } from "lucide-react";
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
  getRootDisk,
  getTrafficUsagePct,
  isNodeMuted,
  parseOsBadge,
} from "../utils/format";

interface FleetTableProps {
  nodes: NodeSummary[];
  onSelectNode: (node: NodeSummary) => void;
}

export function FleetTable({ nodes, onSelectNode }: FleetTableProps) {
  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-12 text-center">
        <Server className="w-8 h-8 mx-auto text-slate-400 mb-2" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
          暂无匹配的服务器
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] overflow-hidden shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead className="bg-slate-50 dark:bg-[#131c2e] border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
            <tr>
              <th scope="col" className="py-2.5 px-3">服务器</th>
              <th scope="col" className="py-2.5 px-3">分组 / 系统</th>
              <th scope="col" className="py-2.5 px-3">运行时长 / 负载</th>
              <th scope="col" className="py-2.5 px-3 min-w-[140px]">处理器</th>
              <th scope="col" className="py-2.5 px-3 min-w-[145px]">内存</th>
              <th scope="col" className="py-2.5 px-3 min-w-[125px]">主磁盘</th>
              <th scope="col" className="py-2.5 px-3 text-right">实时网速（上传 / 下载）</th>
              <th scope="col" className="py-2.5 px-3 min-w-[175px]">本月流量</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
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
                <tr
                  key={node.id}
                  onClick={() => onSelectNode(node)}
                  className={`cursor-pointer transition-colors hover:bg-sky-500/[0.06] ${
                    node.online ? "" : "opacity-75"
                  }`}
                >
                  {/* Node */}
                  <td className="py-2.5 px-3 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2 shrink-0">
                        {node.online && (
                          <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                        )}
                        <span
                          className={`relative inline-flex rounded-full h-2 w-2 ${
                            node.online ? "bg-emerald-500" : "bg-rose-500"
                          }`}
                        />
                      </span>
                      <div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectNode(node);
                          }}
                          className="font-semibold text-left text-slate-900 dark:text-slate-100 flex items-center gap-1.5 hover:text-sky-600 dark:hover:text-sky-400 focus-visible:outline-none focus-visible:underline"
                        >
                          <span>{node.name}</span>
                          {muted && (
                            <>
                              <BellOff className="w-3 h-3 text-amber-500" aria-hidden="true" />
                              <span className="sr-only">告警已静默</span>
                            </>
                          )}
                        </button>
                        <div className="text-[11px] font-mono-num text-slate-400 dark:text-slate-500">
                          {node.hostname || "等待首次连接"}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Group / OS */}
                  <td className="py-2.5 px-3 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                        {node.group_name}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${osBadge.colorClass}`}
                      >
                        {osBadge.short}
                      </span>
                    </div>
                  </td>

                  {/* Uptime / Load1 */}
                  <td className="py-2.5 px-3 whitespace-nowrap font-mono-num">
                    {node.online ? (
                      <div>
                        <div className="text-slate-700 dark:text-slate-200">
                          {formatUptime(m?.up)}
                        </div>
                        <div className="text-[11px] text-slate-400 dark:text-slate-500">
                          负载：{m ? m.cpu.load[0].toFixed(2) : "—"}
                        </div>
                      </div>
                    ) : (
                      <span className="text-rose-500 dark:text-rose-400 font-medium">
                        离线 · {formatRelativeTime(node.last_seen_ts)}
                      </span>
                    )}
                  </td>

                  {/* CPU / Steal */}
                  <td className="py-2.5 px-3">
                    <div className="flex items-center justify-between gap-2 font-mono-num mb-1">
                      <span className="font-semibold text-slate-700 dark:text-slate-200">
                        {m ? `${cpuPct.toFixed(1)}%` : "—"}
                      </span>
                      {stealPct >= 1.5 && (
                        <span
                          title="宿主机资源争抢较高"
                          className="inline-flex items-center gap-0.5 px-1 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/35"
                        >
                          <Flame className="w-2.5 h-2.5" aria-hidden="true" />
                          CPU 争抢 {stealPct.toFixed(1)}%
                        </span>
                      )}
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          m ? getMetricBarColor(cpuPct) : "bg-slate-400"
                        }`}
                        style={{ width: `${m ? Math.min(100, cpuPct) : 0}%` }}
                      />
                    </div>
                  </td>

                  {/* Memory */}
                  <td className="py-2.5 px-3 font-mono-num">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-slate-700 dark:text-slate-200">
                        {m ? `${formatBytes(m.mem.used)} / ${formatBytes(memTotal)}` : "—"}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {m ? `${memPct.toFixed(0)}%` : ""}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          m ? getMetricBarColor(memPct) : "bg-slate-400"
                        }`}
                        style={{ width: `${m ? Math.min(100, memPct) : 0}%` }}
                      />
                    </div>
                  </td>

                  {/* Disk */}
                  <td className="py-2.5 px-3 font-mono-num">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-slate-700 dark:text-slate-200">
                        {rootDisk ? `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}` : "—"}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {rootDisk ? `${diskPct.toFixed(0)}%` : ""}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          rootDisk ? getMetricBarColor(diskPct) : "bg-slate-400"
                        }`}
                        style={{ width: `${rootDisk ? Math.min(100, diskPct) : 0}%` }}
                      />
                    </div>
                  </td>

                  {/* Net Speed */}
                  <td className="py-2.5 px-3 text-right font-mono-num whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1 text-indigo-600 dark:text-indigo-400">
                      <ArrowUp className="w-3 h-3" aria-hidden="true" />
                      {m ? formatRate(m.net.tx_bps) : "0 B/s"}
                    </div>
                    <div className="flex items-center justify-end gap-1 text-cyan-600 dark:text-cyan-400">
                      <ArrowDown className="w-3 h-3" aria-hidden="true" />
                      {m ? formatRate(m.net.rx_bps) : "0 B/s"}
                    </div>
                  </td>

                  {/* Traffic Quota */}
                  <td className="py-2.5 px-3 font-mono-num">
                    {trafficLimit !== null && trafficLimit > 0 ? (
                      <>
                        <div className="text-[11px] text-slate-700 dark:text-slate-300 mb-1 whitespace-nowrap">
                          {formatBytes(node.traffic.counted_bytes)} /{" "}
                          {formatBytes(trafficLimit)} · 剩{" "}
                          {node.traffic.days_remaining} 天
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              trafficPct >= 95
                                ? "bg-rose-500"
                                : trafficPct >= 80
                                  ? "bg-amber-500"
                                  : "bg-sky-500"
                            }`}
                            style={{ width: `${Math.min(100, trafficPct)}%` }}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        已用 {formatBytes(node.traffic.counted_bytes)} · 不限额 · 剩{" "}
                        {node.traffic.days_remaining} 天
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
