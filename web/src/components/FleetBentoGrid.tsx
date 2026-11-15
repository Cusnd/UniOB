import { useId, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Flame,
  HardDrive,
  Lock,
  Server,
  Terminal,
  WifiOff,
} from "lucide-react";
import type { DensityMode, HorizonNode, InspectorTab } from "../types";
import {
  formatBytes,
  formatBytesCompact,
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

export interface FleetBentoGridProps {
  nodes: HorizonNode[];
  density: DensityMode;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onMuteNode: (nodeId: string, seconds: number | null) => void | Promise<void>;
}

interface CpuSparklineProps {
  samples: number[];
  online: boolean;
  cpuPct: number;
}

function getSparklineColor(cpuPct: number, online: boolean): string {
  if (!online) return "#64748b";
  if (cpuPct >= 90) return "#f43f5e";
  if (cpuPct >= 70) return "#f59e0b";
  return "var(--accent-primary, #10b981)";
}

function CpuSparkline({ samples, online, cpuPct }: CpuSparklineProps) {
  const gradId = useId();
  const width = 220;
  const height = 28;
  const padY = 3;
  const strokeColor = getSparklineColor(cpuPct, online);

  if (!online || samples.length < 2) {
    return (
      <div
        className="h-7 w-full rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 flex items-center justify-center text-[10px] font-mono-num text-[var(--text-muted,var(--text-secondary))]"
        aria-hidden="true"
      >
        {online ? "采集样本中…" : "探针离线 · 无实时曲线"}
      </div>
    );
  }

  const pts = samples.slice(-24);
  const maxVal = Math.max(25, ...pts);
  const stepX = width / Math.max(1, pts.length - 1);

  const coords = pts.map((val, idx) => {
    const x = idx * stepX;
    const norm = Math.max(0, Math.min(1, val / maxVal));
    const y = height - padY - norm * (height - padY * 2);
    return { x, y };
  });

  const linePath = coords
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
  const last = coords[coords.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-7 w-full overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {last && (
        <circle
          cx={last.x}
          cy={last.y}
          r="2.4"
          fill={strokeColor}
          stroke="var(--bg-surface)"
          strokeWidth="1.2"
        />
      )}
    </svg>
  );
}

/**
 * Bento 卡片视图：使用 CSS Grid + subgrid 对齐跨列卡片内部 4 个信息带，
 * 并提供显式 grid-template-rows 同级回退以保障旧环境一致性。
 */
export function FleetBentoGrid({
  nodes,
  density,
  onSelectNode,
  onMuteNode,
}: FleetBentoGridProps): React.JSX.Element {
  const isCompact = density === "compact";
  const [mutingIds, setMutingIds] = useState<Record<string, boolean>>({});

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
        <p className="text-xs text-[var(--text-secondary)] mt-1">
          尝试切换分组筛选、清空搜索条件，或点击右上角「部署探针」新增服务器。
        </p>
      </div>
    );
  }

  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 items-stretch ${
        isCompact ? "gap-3" : "gap-4"
      }`}
    >
      {nodes.map((node) => {
        const m = node.metrics;
        const cpuPct = m?.cpu.all ?? 0;
        const stealPct = m?.cpu.steal ?? 0;
        const memPct = getMemUsagePct(node);
        const memTotal = getMemTotalBytes(node);
        const memCachePct =
          m && memTotal > 0
            ? Math.max(0, Math.min(100 - memPct, (m.mem.cached / memTotal) * 100))
            : 0;
        const rootDisk = getRootDisk(m?.disks);
        const diskPct = getDiskUsagePct(rootDisk);
        const osBadge = parseOsBadge(node.os);
        const muted = isNodeMuted(node);
        const isMuting = Boolean(mutingIds[node.id]);
        const trafficLimit = node.traffic.limit_bytes;
        const trafficPct = getTrafficUsagePct(node.traffic);
        const metaLine =
          formatNodeMetaLine(node, { includeHostnameFallback: true }) ||
          "Linux 节点";

        const isHot =
          !node.online ||
          stealPct >= 1.5 ||
          memPct >= 85 ||
          (trafficLimit !== null && trafficLimit > 0 && trafficPct >= 85);

        return (
          <article
            key={node.id}
            onClick={() => onSelectNode(node, "charts")}
            className={`group relative cursor-pointer rounded-2xl surface-card grid grid-rows-[auto_auto_1fr_auto] supports-[grid-template-rows:subgrid]:row-span-4 supports-[grid-template-rows:subgrid]:grid-rows-subgrid transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 ${
              isCompact ? "p-3.5 gap-y-2.5" : "p-4 sm:p-5 gap-y-3"
            } ${
              !node.online
                ? "border-rose-500/35 opacity-90 hover:border-rose-500/60"
                : isHot
                  ? "border-amber-500/30 hover:border-amber-500/55"
                  : "hover:border-[var(--accent-ring)]"
            }`}
          >
            {/* Track 1: Node Identity & Status Header */}
            <div className="min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-2 text-[11px] font-mono-num text-[var(--text-secondary)]">
                <div className="flex items-center gap-1.5 min-w-0 truncate">
                  {node.region_flag && (
                    <span aria-hidden="true" className="shrink-0">
                      {node.region_flag}
                    </span>
                  )}
                  <span className="truncate font-medium text-[var(--text-secondary)]">
                    {metaLine}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                    {node.group_name}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${osBadge.colorClass}`}
                  >
                    {osBadge.short}
                  </span>
                </div>
              </div>

              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {node.online ? (
                      <span
                        className="relative flex h-2.5 w-2.5 shrink-0"
                        title="探针在线"
                      >
                        <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                        <span className="sr-only">在线</span>
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/35 shrink-0"
                        title="服务器离线"
                      >
                        <WifiOff className="w-2.5 h-2.5" aria-hidden="true" />
                        离线
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectNode(node, "charts");
                      }}
                      className="text-left text-sm font-bold tracking-tight text-[var(--text-primary)] truncate hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:underline"
                    >
                      {node.name}
                    </button>

                    {muted && (
                      <span
                        title="告警已静默"
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/30 shrink-0"
                      >
                        <BellOff className="w-2.5 h-2.5" aria-hidden="true" />
                        静默
                      </span>
                    )}
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-mono-num text-[var(--text-secondary)]">
                    <span className="truncate max-w-[160px]">
                      {node.hostname || "等待首次握手"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{node.cpu_cores ? `${node.cpu_cores} 核` : "—"}</span>
                    <span aria-hidden="true">·</span>
                    <span>{node.arch || "linux"}</span>
                  </div>
                </div>

                <div className="text-right text-[11px] font-mono-num text-[var(--text-secondary)] shrink-0">
                  {node.online ? (
                    <>
                      <div className="text-[var(--text-primary)] font-medium">
                        {formatUptime(m?.up)}
                      </div>
                      <div>
                        负载 {m ? m.cpu.load[0].toFixed(2) : "—"}
                      </div>
                    </>
                  ) : (
                    <span className="text-rose-600 dark:text-rose-400 font-medium">
                      {formatRelativeTime(node.last_seen_ts)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Track 2: CPU + Mini SVG Sparkline + Steal Flame Tag */}
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[var(--text-secondary)] font-medium">
                    处理器
                  </span>
                  {node.online && stealPct >= 1.5 && (
                    <span
                      title="检测到宿主机 CPU 资源争抢"
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono-num font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35"
                    >
                      <Flame className="w-2.5 h-2.5" aria-hidden="true" />
                      争抢 {stealPct.toFixed(1)}%
                    </span>
                  )}
                </div>
                <span
                  className={`font-mono-num font-bold ${
                    m && node.online
                      ? getMetricTextColor(cpuPct)
                      : "text-[var(--text-muted,var(--text-secondary))]"
                  }`}
                >
                  {m && node.online ? `${cpuPct.toFixed(1)}%` : "—"}
                </span>
              </div>

              <CpuSparkline
                samples={node.sparkline_cpu}
                online={node.online}
                cpuPct={cpuPct}
              />

              <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    m && node.online
                      ? getMetricBarColor(cpuPct)
                      : "bg-slate-400/50"
                  }`}
                  style={{ width: `${m && node.online ? Math.min(100, cpuPct) : 0}%` }}
                />
              </div>
            </div>

            {/* Track 3: Memory Segmented Bar + Root Disk */}
            <div className="space-y-2.5 text-xs self-start">
              {/* Memory Segmented Bar */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 mb-1">
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[var(--text-secondary)] font-medium whitespace-nowrap shrink-0">
                      内存
                    </span>
                    {m && node.online && m.mem.swap_used > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-num bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 border border-indigo-500/25 whitespace-nowrap shrink-0">
                        Swap {formatBytesCompact(m.mem.swap_used)}
                      </span>
                    )}
                  </div>
                  <span className="font-mono-num text-[var(--text-primary)] whitespace-nowrap shrink-0">
                    {m && node.online ? (
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
                <div
                  className="h-2 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden flex"
                  title={
                    m && node.online
                      ? `已用 ${formatBytes(m.mem.used)} · 页缓存 ${formatBytes(m.mem.cached)}`
                      : undefined
                  }
                >
                  <div
                    className={`h-full transition-all duration-300 ${
                      m && node.online
                        ? getMetricBarColor(memPct)
                        : "bg-slate-400/50"
                    }`}
                    style={{
                      width: `${m && node.online ? Math.min(100, memPct) : 0}%`,
                    }}
                  />
                  {m && node.online && memCachePct > 0.5 && (
                    <div
                      className="h-full bg-sky-400/55 dark:bg-sky-400/45 transition-all duration-300"
                      style={{ width: `${memCachePct}%` }}
                    />
                  )}
                </div>
              </div>

              {/* Root Disk */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 mb-1">
                  <span className="text-[var(--text-secondary)] font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0">
                    <HardDrive className="w-3 h-3 shrink-0" aria-hidden="true" />
                    磁盘 {rootDisk?.mp ?? "/"}
                  </span>
                  <span className="font-mono-num text-[var(--text-primary)] whitespace-nowrap shrink-0">
                    {rootDisk && node.online ? (
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
                <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      rootDisk && node.online
                        ? getMetricBarColor(diskPct)
                        : "bg-slate-400/50"
                    }`}
                    style={{
                      width: `${rootDisk && node.online ? Math.min(100, diskPct) : 0}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Track 4: Real-time TX/RX + Monthly Traffic + Quick Action Pills */}
            <div className="pt-2.5 border-t border-[var(--border-subtle)] space-y-2.5">
              <div className="flex items-center justify-between gap-2 text-xs font-mono-num">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                    <ArrowUp className="w-3 h-3 shrink-0" aria-hidden="true" />
                    {m && node.online ? formatRate(m.net.tx_bps) : "0 B/s"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                    <ArrowDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                    {m && node.online ? formatRate(m.net.rx_bps) : "0 B/s"}
                  </span>
                </div>
                <span className="text-[11px] text-[var(--text-secondary)] shrink-0">
                  TCP {m && node.online ? m.net.tcp_est : 0}
                </span>
              </div>

              {/* Monthly Traffic Quota */}
              <div>
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono-num mb-1">
                  <span className="text-[var(--text-secondary)]">月度流量</span>
                  {trafficLimit !== null && trafficLimit > 0 ? (
                    <span className="text-[var(--text-primary)] truncate">
                      {formatBytes(node.traffic.counted_bytes)} /{" "}
                      {formatBytes(trafficLimit)} · 剩 {node.traffic.days_remaining} 天
                    </span>
                  ) : (
                    <span className="text-[var(--text-secondary)] truncate">
                      已用 {formatBytes(node.traffic.counted_bytes)} · 不限额
                    </span>
                  )}
                </div>
                <div className="h-1 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      trafficLimit !== null && trafficLimit > 0
                        ? trafficPct >= 95
                          ? "bg-rose-500"
                          : trafficPct >= 80
                            ? "bg-amber-500"
                            : "bg-sky-500"
                        : "bg-sky-500/45"
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

              {/* Quick Action Pills: visible on rest/hover/focus/touch */}
              <div
                className="flex items-center justify-between gap-1.5 pt-1 opacity-85 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onSelectNode(node, "charts")}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent-ring)] hover:text-[var(--accent-primary)] transition-colors"
                  >
                    <Activity className="w-3 h-3" aria-hidden="true" />
                    曲线
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectNode(node, "procs")}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent-ring)] hover:text-[var(--accent-primary)] transition-colors"
                  >
                    {node.proc_enabled ? (
                      <Terminal className="w-3 h-3" aria-hidden="true" />
                    ) : (
                      <Lock className="w-3 h-3 text-amber-500" aria-hidden="true" />
                    )}
                    进程
                  </button>
                </div>

                <button
                  type="button"
                  disabled={isMuting}
                  aria-busy={isMuting || undefined}
                  onClick={() => void handleMuteToggle(node.id, muted ? null : 3600)}
                  aria-pressed={muted}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    muted
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25"
                      : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {muted ? (
                    <>
                      <Bell className="w-3 h-3" aria-hidden="true" />
                      取消静默
                    </>
                  ) : (
                    <>
                      <BellOff className="w-3 h-3" aria-hidden="true" />
                      静默
                    </>
                  )}
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
