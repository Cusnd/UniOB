import { useMemo } from "react";
import {
  ArrowDown,
  ArrowUp,
  BellOff,
  Cpu,
  Flame,
  Gauge,
  Layers,
  Server,
  Terminal,
  WifiOff,
} from "lucide-react";
import type { DensityMode, HorizonNode, InspectorTab } from "../types";
import {
  formatNodeMetaLine,
  formatRate,
  formatRelativeTime,
  getMemUsagePct,
  getMetricBarColor,
  getMetricTextColor,
  getTrafficUsagePct,
  isNodeMuted,
} from "../utils/format";

export interface FleetMatrixViewProps {
  nodes: HorizonNode[];
  density: DensityMode;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
}

interface GroupCluster {
  name: string;
  nodes: HorizonNode[];
  onlineCount: number;
  onlinePct: number;
  totalTxBps: number;
  totalRxBps: number;
  avgCpuPct: number;
  avgLoad1: number;
  hotspotCount: number;
}

/**
 * 分组矩阵拓扑视图：按业务集群聚合在线率、全组吞吐、平均 CPU/Load 与高密度状态砖。
 */
export function FleetMatrixView({
  nodes,
  density,
  onSelectNode,
}: FleetMatrixViewProps): React.JSX.Element {
  const isCompact = density === "compact";

  const clusters = useMemo<GroupCluster[]>(() => {
    const map = new Map<string, HorizonNode[]>();
    for (const node of nodes) {
      const grp = node.group_name || "未分组";
      const list = map.get(grp);
      if (list) {
        list.push(node);
      } else {
        map.set(grp, [node]);
      }
    }

    const result: GroupCluster[] = [];
    for (const [name, list] of map.entries()) {
      let onlineCount = 0;
      let totalTxBps = 0;
      let totalRxBps = 0;
      let cpuSum = 0;
      let loadSum = 0;
      let metricCount = 0;
      let hotspotCount = 0;

      for (const n of list) {
        const m = n.metrics;
        const memPct = getMemUsagePct(n);
        const trafficPct = getTrafficUsagePct(n.traffic);
        const isHot =
          !n.online ||
          (m?.cpu.steal ?? 0) >= 1.5 ||
          memPct >= 85 ||
          (n.traffic.limit_bytes !== null &&
            n.traffic.limit_bytes > 0 &&
            trafficPct >= 85);
        if (isHot) hotspotCount += 1;

        if (n.online) {
          onlineCount += 1;
          if (m) {
            totalTxBps += m.net.tx_bps;
            totalRxBps += m.net.rx_bps;
            cpuSum += m.cpu.all;
            loadSum += m.cpu.load[0];
            metricCount += 1;
          }
        }
      }

      result.push({
        name,
        nodes: list,
        onlineCount,
        onlinePct: list.length > 0 ? (onlineCount / list.length) * 100 : 0,
        totalTxBps,
        totalRxBps,
        avgCpuPct: metricCount > 0 ? cpuSum / metricCount : 0,
        avgLoad1: metricCount > 0 ? loadSum / metricCount : 0,
        hotspotCount,
      });
    }
    return result;
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="surface-card rounded-2xl border-dashed p-12 text-center">
        <Server
          className="w-8 h-8 mx-auto mb-2.5 text-[var(--text-muted,var(--text-secondary))]"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-[var(--text-primary)]">
          暂无匹配的服务器分组
        </p>
      </div>
    );
  }

  return (
    <div className={isCompact ? "space-y-3" : "space-y-4"}>
      {clusters.map((cluster) => {
        const allOnline = cluster.onlineCount === cluster.nodes.length;

        return (
          <section
            key={cluster.name}
            aria-label={`${cluster.name} 集群矩阵`}
            className={`surface-card rounded-2xl ${isCompact ? "p-3.5" : "p-4 sm:p-5"}`}
          >
            {/* Cluster Aggregate Header */}
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-3.5 mb-3.5 border-b border-[var(--border-subtle)]">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent-primary)]">
                  <Layers className="w-4 h-4" aria-hidden="true" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-[var(--text-primary)]">
                      {cluster.name}
                    </h3>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-mono-num font-semibold border ${
                        allOnline
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      }`}
                    >
                      在线 {cluster.onlineCount}/{cluster.nodes.length} (
                      {cluster.onlinePct.toFixed(0)}%)
                    </span>
                    {cluster.hotspotCount > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-mono-num font-medium border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300">
                        {cluster.hotspotCount} 异常关注
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1.5 w-44 max-w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        allOnline ? "bg-emerald-500" : "bg-amber-500"
                      }`}
                      style={{ width: `${cluster.onlinePct}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Cluster Telemetry KPIs */}
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono-num">
                <div className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
                  <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                    <ArrowUp className="w-3 h-3" aria-hidden="true" />
                    {formatRate(cluster.totalTxBps)}
                  </span>
                  <span className="text-[var(--border-subtle)]" aria-hidden="true">
                    |
                  </span>
                  <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                    <ArrowDown className="w-3 h-3" aria-hidden="true" />
                    {formatRate(cluster.totalRxBps)}
                  </span>
                </div>

                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
                  <Cpu
                    className="w-3.5 h-3.5 text-[var(--text-secondary)]"
                    aria-hidden="true"
                  />
                  <span className="text-[var(--text-secondary)]">均 CPU</span>
                  <span
                    className={`font-semibold ${getMetricTextColor(cluster.avgCpuPct)}`}
                  >
                    {cluster.avgCpuPct.toFixed(1)}%
                  </span>
                </div>

                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
                  <Gauge
                    className="w-3.5 h-3.5 text-[var(--text-secondary)]"
                    aria-hidden="true"
                  />
                  <span className="text-[var(--text-secondary)]">均 Load1</span>
                  <span className="font-semibold text-[var(--text-primary)]">
                    {cluster.avgLoad1.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            {/* Compact Node Bricks */}
            <div
              className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${
                isCompact ? "gap-2.5" : "gap-3"
              }`}
            >
              {cluster.nodes.map((node) => {
                const m = node.metrics;
                const cpuPct = m?.cpu.all ?? 0;
                const stealPct = m?.cpu.steal ?? 0;
                const memPct = getMemUsagePct(node);
                const trafficPct = getTrafficUsagePct(node.traffic);
                const muted = isNodeMuted(node);
                const hasTrafficWarn =
                  node.traffic.limit_bytes !== null &&
                  node.traffic.limit_bytes > 0 &&
                  trafficPct >= 85;
                const hasWarn =
                  node.online && (stealPct >= 1.5 || memPct >= 85 || hasTrafficWarn);
                const metaLine =
                  formatNodeMetaLine(node, { includeHostnameFallback: true }) || "—";

                return (
                  <div
                    key={node.id}
                    onClick={() => onSelectNode(node, "charts")}
                    className={`group cursor-pointer rounded-xl border transition-[border-color,background-color] ${
                      isCompact ? "p-2.5" : "p-3"
                    } ${
                      !node.online
                        ? "border-rose-500/35 bg-rose-500/[0.04] hover:border-rose-500/60"
                        : hasWarn
                          ? "border-amber-500/35 bg-amber-500/[0.03] hover:border-amber-500/60"
                          : "border-[var(--border-subtle)] bg-[var(--bg-elevated)]/65 hover:border-[var(--accent-ring)] hover:bg-[var(--bg-elevated)]"
                    }`}
                  >
                    {/* Brick Header */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {node.online ? (
                            <span
                              className="h-2 w-2 rounded-full bg-emerald-500 shrink-0"
                              title="在线"
                            />
                          ) : (
                            <WifiOff
                              className="w-3 h-3 text-rose-500 shrink-0"
                              aria-label="离线"
                            />
                          )}
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
                            className="text-xs font-bold text-[var(--text-primary)] truncate hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:underline"
                          >
                            {node.name}
                          </button>
                        </div>
                        <div className="mt-0.5 text-[10px] font-mono-num text-[var(--text-secondary)] truncate">
                          {metaLine}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {muted && (
                          <BellOff
                            className="w-3 h-3 text-amber-500"
                            aria-label="告警已静默"
                          />
                        )}
                        {node.online && stealPct >= 1.5 && (
                          <span
                            title={`CPU 争抢 ${stealPct.toFixed(1)}%`}
                            className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-mono-num font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          >
                            <Flame className="w-2.5 h-2.5" aria-hidden="true" />
                            {stealPct.toFixed(1)}%
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectNode(node, "procs");
                          }}
                          title="查看进程"
                          aria-label={`查看 ${node.name} 进程`}
                          className="p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--accent-primary)] hover:bg-[var(--bg-surface)] transition-colors"
                        >
                          <Terminal className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    {/* Brick Metrics */}
                    {node.online && m ? (
                      <div className="space-y-1.5 text-[11px] font-mono-num">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-[10px] text-[var(--text-secondary)]">
                                CPU
                              </span>
                              <span className={`font-semibold ${getMetricTextColor(cpuPct)}`}>
                                {cpuPct.toFixed(0)}%
                              </span>
                            </div>
                            <div className="h-1 rounded-full bg-[var(--bg-surface)] overflow-hidden">
                              <div
                                className={`h-full rounded-full ${getMetricBarColor(cpuPct)}`}
                                style={{ width: `${Math.min(100, cpuPct)}%` }}
                              />
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-[10px] text-[var(--text-secondary)]">
                                MEM
                              </span>
                              <span className={`font-semibold ${getMetricTextColor(memPct)}`}>
                                {memPct.toFixed(0)}%
                              </span>
                            </div>
                            <div className="h-1 rounded-full bg-[var(--bg-surface)] overflow-hidden">
                              <div
                                className={`h-full rounded-full ${getMetricBarColor(memPct)}`}
                                style={{ width: `${Math.min(100, memPct)}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-[var(--text-secondary)] pt-0.5">
                          <span className="text-indigo-600 dark:text-indigo-400">
                            ↑{formatRate(m.net.tx_bps)}
                          </span>
                          <span className="text-cyan-600 dark:text-cyan-400">
                            ↓{formatRate(m.net.rx_bps)}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="pt-1 flex items-center justify-between text-[11px] font-mono-num text-rose-600 dark:text-rose-400">
                        <span>探针离线</span>
                        <span>{formatRelativeTime(node.last_seen_ts)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
