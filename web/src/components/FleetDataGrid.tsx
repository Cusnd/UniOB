import { useId, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Flame,
  Lock,
  Server,
  Terminal,
  WifiOff,
} from "lucide-react";
import type { DensityMode, HorizonNode, InspectorTab } from "../types";
import {
  formatBytes,
  formatNodeMetaLine,
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

export interface FleetDataGridProps {
  nodes: HorizonNode[];
  density: DensityMode;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onMuteNode: (nodeId: string, seconds: number | null) => void | Promise<void>;
}

type SortKey =
  | "name"
  | "group"
  | "uptime"
  | "cpu"
  | "mem"
  | "disk"
  | "net"
  | "traffic";
type SortDir = "asc" | "desc";

const SORT_COLUMN_LABELS: Record<SortKey, string> = {
  name: "服务器",
  group: "分组与系统",
  uptime: "在线状态与运行时长",
  cpu: "处理器利用率",
  mem: "内存占用率",
  disk: "主磁盘占用率",
  net: "实时聚合网速",
  traffic: "本月流量进度",
};

const TEXT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function InlineMiniSparkline({
  samples,
  online,
  cpuPct,
}: {
  samples: number[];
  online: boolean;
  cpuPct: number;
}) {
  if (!online || samples.length < 2) {
    return (
      <span
        className="inline-block w-14 h-4 border-b border-dashed border-[var(--border-subtle)]"
        aria-hidden="true"
      />
    );
  }
  const pts = samples.slice(-16);
  const w = 56;
  const h = 18;
  const maxVal = Math.max(25, ...pts);
  const stepX = w / Math.max(1, pts.length - 1);
  const d = pts
    .map((v, i) => {
      const x = i * stepX;
      const y = h - 2 - Math.max(0, Math.min(1, v / maxVal)) * (h - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const stroke =
    cpuPct >= 90
      ? "#f43f5e"
      : cpuPct >= 70
        ? "#f59e0b"
        : "var(--accent-primary, #10b981)";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-14 h-[18px] shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getNumericSortValue(node: HorizonNode, key: SortKey): number {
  const m = node.metrics;
  switch (key) {
    case "uptime":
      return node.online ? 1e12 + (m?.up ?? 0) : node.last_seen_ts ?? 0;
    case "cpu":
      return node.online && m ? m.cpu.all : -1;
    case "mem":
      return node.online && m ? getMemUsagePct(node) : -1;
    case "disk":
      return node.online && m ? getDiskUsagePct(getRootDisk(m.disks)) : -1;
    case "net":
      return node.online && m ? m.net.rx_bps + m.net.tx_bps : -1;
    case "traffic":
      return node.traffic.limit_bytes && node.traffic.limit_bytes > 0
        ? getTrafficUsagePct(node.traffic)
        : node.traffic.counted_bytes / 1e12;
    default:
      return 0;
  }
}

/**
 * 精密可排序机群表格视图：遵循 responsive-table 与 sortable-table 无障碍规范，
 * 含粘性首列、内联 Sparkline 微图、原始数值/Collator 排序与表外 status 播报。
 */
export function FleetDataGrid({
  nodes,
  density,
  onSelectNode,
  onMuteNode,
}: FleetDataGridProps): React.JSX.Element {
  const captionId = useId();
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [announcement, setAnnouncement] = useState("");
  const [mutingIds, setMutingIds] = useState<Record<string, boolean>>({});

  const isCompact = density === "compact";
  const cellPad = isCompact ? "py-2 px-3" : "py-2.5 px-3.5";

  const handleMuteToggle = async (nodeId: string, seconds: number | null) => {
    if (mutingIds[nodeId]) return;
    setMutingIds((prev) => ({ ...prev, [nodeId]: true }));
    try {
      await Promise.resolve(onMuteNode(nodeId, seconds));
    } catch {
      // Error feedback is handled by caller
    } finally {
      setMutingIds((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    }
  };

  const sortedNodes = useMemo(() => {
    if (!sortKey) return nodes;
    const factor = sortDir === "asc" ? 1 : -1;

    return [...nodes].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = TEXT_COLLATOR.compare(a.name, b.name);
      } else if (sortKey === "group") {
        cmp = TEXT_COLLATOR.compare(a.group_name, b.group_name);
        if (cmp === 0) cmp = TEXT_COLLATOR.compare(a.name, b.name);
      } else {
        cmp = getNumericSortValue(a, sortKey) - getNumericSortValue(b, sortKey);
        if (cmp === 0) cmp = TEXT_COLLATOR.compare(a.name, b.name);
      }
      return cmp * factor;
    });
  }, [nodes, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    const nextDir: SortDir =
      sortKey === key
        ? sortDir === "asc"
          ? "desc"
          : "asc"
        : key === "name" || key === "group"
          ? "asc"
          : "desc";
    setSortKey(key);
    setSortDir(nextDir);
    setAnnouncement(
      `已按${SORT_COLUMN_LABELS[key]}${nextDir === "asc" ? "升序" : "降序"}排列，共 ${nodes.length} 台服务器`,
    );
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) {
      return (
        <ChevronsUpDown
          className="w-3 h-3 opacity-45 shrink-0"
          aria-hidden="true"
        />
      );
    }
    return sortDir === "asc" ? (
      <ChevronUp
        className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0"
        aria-hidden="true"
      />
    ) : (
      <ChevronDown
        className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0"
        aria-hidden="true"
      />
    );
  };

  if (nodes.length === 0) {
    return (
      <div className="surface-card rounded-2xl border-dashed p-12 text-center">
        <Server
          className="w-8 h-8 mx-auto mb-2.5 text-[var(--text-muted,var(--text-secondary))]"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-[var(--text-primary)]">
          暂无匹配的服务器节点
        </p>
      </div>
    );
  }

  return (
    <div className="surface-card rounded-2xl overflow-hidden">
      <div
        tabIndex={0}
        role="region"
        aria-labelledby={captionId}
        className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      >
        <table className="w-full text-left border-collapse text-xs">
          <caption id={captionId} className="sr-only">
            机群服务器实时遥测表格视图，支持点击列标题排序
          </caption>

          <thead className="bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] font-mono-num">
            <tr>
              <th
                scope="col"
                aria-sort={
                  sortKey === "name"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`sticky left-0 z-20 bg-[var(--bg-elevated)] border-r border-[var(--border-subtle)] ${cellPad} min-w-[200px]`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("name")}
                  className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>服务器</span>
                  {renderSortIcon("name")}
                </button>
              </th>

              <th
                scope="col"
                aria-sort={
                  sortKey === "group"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`${cellPad} whitespace-nowrap`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("group")}
                  className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>分组 / 系统</span>
                  {renderSortIcon("group")}
                </button>
              </th>

              <th
                scope="col"
                aria-sort={
                  sortKey === "uptime"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`${cellPad} whitespace-nowrap`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("uptime")}
                  className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>运行时长 / 负载</span>
                  {renderSortIcon("uptime")}
                </button>
              </th>

              <th
                scope="col"
                aria-sort={
                  sortKey === "cpu"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`${cellPad} min-w-[185px]`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("cpu")}
                  className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>处理器 / 趋势</span>
                  {renderSortIcon("cpu")}
                </button>
              </th>

              <th
                scope="col"
                aria-sort={
                  sortKey === "mem"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`${cellPad} min-w-[155px]`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("mem")}
                  className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>内存</span>
                  {renderSortIcon("mem")}
                </button>
              </th>

              <th
                scope="col"
                aria-sort={
                  sortKey === "disk"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`${cellPad} min-w-[130px]`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("disk")}
                  className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>主磁盘</span>
                  {renderSortIcon("disk")}
                </button>
              </th>

              <th
                scope="col"
                aria-sort={
                  sortKey === "net"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`${cellPad} text-right whitespace-nowrap`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("net")}
                  className="inline-flex items-center justify-end gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>实时网速（↑ / ↓）</span>
                  {renderSortIcon("net")}
                </button>
              </th>

              <th
                scope="col"
                aria-sort={
                  sortKey === "traffic"
                    ? sortDir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`${cellPad} min-w-[175px]`}
              >
                <button
                  type="button"
                  onClick={() => handleSort("traffic")}
                  className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:underline"
                >
                  <span>本月流量</span>
                  {renderSortIcon("traffic")}
                </button>
              </th>

              <th scope="col" className={`${cellPad} text-right whitespace-nowrap`}>
                操作
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-[var(--border-subtle)]">
            {sortedNodes.map((node) => {
              const m = node.metrics;
              const cpuPct = m?.cpu.all ?? 0;
              const stealPct = m?.cpu.steal ?? 0;
              const memPct = getMemUsagePct(node);
              const memTotal = getMemTotalBytes(node);
              const rootDisk = getRootDisk(m?.disks);
              const diskPct = getDiskUsagePct(rootDisk);
              const osBadge = parseOsBadge(node.os);
              const muted = isNodeMuted(node);
              const isMuting = Boolean(mutingIds[node.id]);
              const trafficLimit = node.traffic.limit_bytes;
              const trafficPct = getTrafficUsagePct(node.traffic);
              const metaLine =
                formatNodeMetaLine(node, { includeHostnameFallback: true }) || "—";

              return (
                <tr
                  key={node.id}
                  onClick={() => onSelectNode(node, "charts")}
                  className={`group cursor-pointer transition-colors hover:bg-[var(--bg-elevated)]/75 ${
                    node.online ? "" : "opacity-80"
                  }`}
                >
                  {/* Sticky Column 1: Server */}
                  <td
                    className={`sticky left-0 z-10 bg-[var(--bg-surface)] group-hover:bg-[var(--bg-elevated)] border-r border-[var(--border-subtle)] ${cellPad} whitespace-nowrap transition-colors`}
                  >
                    <div className="flex items-center gap-2.5">
                      {node.online ? (
                        <span className="relative flex h-2.5 w-2.5 shrink-0" title="在线">
                          <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                          <span className="sr-only">在线</span>
                        </span>
                      ) : (
                        <WifiOff
                          className="w-3.5 h-3.5 text-rose-500 shrink-0"
                          aria-label="离线"
                        />
                      )}

                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {node.region_flag && (
                            <span aria-hidden="true" className="text-xs shrink-0">
                              {node.region_flag}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectNode(node, "charts");
                            }}
                            className="font-semibold text-[var(--text-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:underline truncate max-w-[140px]"
                          >
                            {node.name}
                          </button>
                          {muted && (
                            <span title="告警已静默">
                              <BellOff
                                className="w-3 h-3 text-amber-500 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="sr-only">已静默</span>
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono-num text-[var(--text-secondary)] truncate max-w-[190px]">
                          {metaLine}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Group / OS */}
                  <td className={`${cellPad} whitespace-nowrap`}>
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                        {node.group_name}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${osBadge.colorClass}`}
                      >
                        {osBadge.short}
                      </span>
                    </div>
                  </td>

                  {/* Uptime / Load */}
                  <td className={`${cellPad} whitespace-nowrap font-mono-num`}>
                    {node.online ? (
                      <div>
                        <div className="text-[var(--text-primary)] font-medium">
                          {formatUptime(m?.up)}
                        </div>
                        <div className="text-[11px] text-[var(--text-secondary)]">
                          负载 {m ? m.cpu.load[0].toFixed(2) : "—"}
                        </div>
                      </div>
                    ) : (
                      <span className="text-rose-600 dark:text-rose-400 font-medium">
                        离线 · {formatRelativeTime(node.last_seen_ts)}
                      </span>
                    )}
                  </td>

                  {/* CPU + Inline Sparkline */}
                  <td className={cellPad}>
                    <div className="flex items-center justify-between gap-2.5">
                      <div className="min-w-[84px] flex-1">
                        <div className="flex items-center justify-between gap-1 font-mono-num mb-1">
                          <span
                            className={`font-semibold ${
                              m && node.online
                                ? getMetricTextColor(cpuPct)
                                : "text-[var(--text-secondary)]"
                            }`}
                          >
                            {m && node.online ? `${cpuPct.toFixed(1)}%` : "—"}
                          </span>
                          {node.online && stealPct >= 1.5 && (
                            <span
                              title="宿主机 CPU 争抢"
                              className="inline-flex items-center gap-0.5 px-1 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35"
                            >
                              <Flame className="w-2.5 h-2.5" aria-hidden="true" />
                              {stealPct.toFixed(1)}%
                            </span>
                          )}
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              m && node.online
                                ? getMetricBarColor(cpuPct)
                                : "bg-slate-400/50"
                            }`}
                            style={{
                              width: `${m && node.online ? Math.min(100, cpuPct) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                      <InlineMiniSparkline
                        samples={node.sparkline_cpu}
                        online={node.online}
                        cpuPct={cpuPct}
                      />
                    </div>
                  </td>

                  {/* Memory */}
                  <td className={`${cellPad} font-mono-num`}>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[var(--text-primary)]">
                        {m && node.online
                          ? `${formatBytes(m.mem.used)} / ${formatBytes(memTotal)}`
                          : "—"}
                      </span>
                      <span className="text-[var(--text-secondary)]">
                        {m && node.online ? `${memPct.toFixed(0)}%` : ""}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          m && node.online
                            ? getMetricBarColor(memPct)
                            : "bg-slate-400/50"
                        }`}
                        style={{
                          width: `${m && node.online ? Math.min(100, memPct) : 0}%`,
                        }}
                      />
                    </div>
                  </td>

                  {/* Disk */}
                  <td className={`${cellPad} font-mono-num`}>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[var(--text-primary)]">
                        {rootDisk && node.online
                          ? `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}`
                          : "—"}
                      </span>
                      <span className="text-[var(--text-secondary)]">
                        {rootDisk && node.online ? `${diskPct.toFixed(0)}%` : ""}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          rootDisk && node.online
                            ? getMetricBarColor(diskPct)
                            : "bg-slate-400/50"
                        }`}
                        style={{
                          width: `${rootDisk && node.online ? Math.min(100, diskPct) : 0}%`,
                        }}
                      />
                    </div>
                  </td>

                  {/* Net Speed */}
                  <td className={`${cellPad} text-right font-mono-num whitespace-nowrap`}>
                    <div className="inline-flex items-center justify-end gap-1 text-indigo-600 dark:text-indigo-400">
                      <ArrowUp className="w-3 h-3" aria-hidden="true" />
                      {m && node.online ? formatRate(m.net.tx_bps) : "0 B/s"}
                    </div>
                    <div className="flex items-center justify-end gap-1 text-cyan-600 dark:text-cyan-400">
                      <ArrowDown className="w-3 h-3" aria-hidden="true" />
                      {m && node.online ? formatRate(m.net.rx_bps) : "0 B/s"}
                    </div>
                  </td>

                  {/* Monthly Traffic */}
                  <td className={`${cellPad} font-mono-num`}>
                    {trafficLimit !== null && trafficLimit > 0 ? (
                      <>
                        <div className="text-[11px] text-[var(--text-primary)] mb-1 whitespace-nowrap">
                          {formatBytes(node.traffic.counted_bytes)} /{" "}
                          {formatBytes(trafficLimit)} · 剩{" "}
                          {node.traffic.days_remaining} 天
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
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
                      <div className="text-[11px] text-[var(--text-secondary)] whitespace-nowrap">
                        已用 {formatBytes(node.traffic.counted_bytes)} · 不限额
                      </div>
                    )}
                  </td>

                  {/* Actions */}
                  <td
                    className={`${cellPad} whitespace-nowrap text-right`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectNode(node, "charts")}
                        title="打开实时与历史遥测曲线"
                        aria-label={`查看 ${node.name} 曲线`}
                        className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] hover:border-[var(--accent-ring)] transition-colors"
                      >
                        <Activity className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectNode(node, "procs")}
                        title={
                          node.proc_enabled
                            ? "打开按需进程透视"
                            : "已启用隐私保护，点击预览说明"
                        }
                        aria-label={`查看 ${node.name} 进程`}
                        className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] hover:border-[var(--accent-ring)] transition-colors"
                      >
                        {node.proc_enabled ? (
                          <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <Lock className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={isMuting}
                        aria-busy={isMuting || undefined}
                        onClick={() =>
                          void handleMuteToggle(node.id, muted ? null : 3600)
                        }
                        aria-pressed={muted}
                        title={muted ? "取消静默" : "静默告警 1 小时"}
                        aria-label={`${muted ? "取消静默" : "静默"} ${node.name}`}
                        className={`p-1.5 rounded-lg border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                          muted
                            ? "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-300"
                            : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        {muted ? (
                          <Bell className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <BellOff className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Live announcement placed OUTSIDE <table> per sortable-table spec */}
      <div role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
