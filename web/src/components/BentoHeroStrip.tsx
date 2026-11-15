import { useId, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  Cloud,
  Cpu,
  Flame,
  Gauge,
  Network,
  Server,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import type {
  AppRoute,
  HorizonNode,
  HubStatusResponse,
  InspectorTab,
  WatchdogHealthStatus,
} from "../types";
import {
  formatRate,
  formatRelativeTime,
  getMemUsagePct,
  getTrafficUsagePct,
  isNodeMuted,
} from "../utils/format";

export interface BentoHeroStripProps {
  nodes: HorizonNode[];
  activeAlertsCount: number;
  hubStatus: HubStatusResponse | null;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onNavigate: (route: AppRoute) => void;
}

interface HotspotItem {
  node: HorizonNode;
  kind: "offline" | "steal" | "mem" | "traffic";
  label: string;
  valueText: string;
  severity: "critical" | "warning";
}

function getWatchdogMeta(status?: WatchdogHealthStatus | null): {
  label: string;
  badgeCls: string;
} {
  if (!status) {
    return {
      label: "检测中",
      badgeCls:
        "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
    };
  }
  switch (status) {
    case "healthy":
      return {
        label: "守护中",
        badgeCls:
          "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
      };
    case "waiting":
      return {
        label: "等待心跳",
        badgeCls:
          "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
      };
    case "stale":
      return {
        label: "失联告警",
        badgeCls:
          "border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300",
      };
    case "disabled":
    default:
      return {
        label: "未启用",
        badgeCls:
          "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
      };
  }
}

function buildAreaPaths(
  values: number[],
  maxVal: number,
  width: number,
  height: number,
): { line: string; area: string; lastX: number; lastY: number } {
  const padY = 4;
  const pts = values.length >= 2 ? values : [0, 0];
  const stepX = width / Math.max(1, pts.length - 1);
  const coords = pts.map((val, idx) => {
    const x = idx * stepX;
    const norm = maxVal > 0 ? Math.max(0, Math.min(1, val / maxVal)) : 0;
    const y = height - padY - norm * (height - padY * 2);
    return { x, y };
  });

  const line = coords
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = coords[coords.length - 1] ?? { x: width, y: height - padY };
  return { line, area, lastX: last.x, lastY: last.y };
}

/**
 * 4 格 Bento 驾驶舱条带：在线晶格矩阵、全网双线吞吐微图、异常热点雷达与控制面配额卡。
 */
export function BentoHeroStrip({
  nodes,
  activeAlertsCount,
  hubStatus,
  onSelectNode,
  onNavigate,
}: BentoHeroStripProps): React.JSX.Element {
  const rxGradId = useId();
  const txGradId = useId();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const summary = useMemo(() => {
    let onlineCount = 0;
    let warnCount = 0;
    let mutedCount = 0;
    let totalTxBps = 0;
    let totalRxBps = 0;
    let totalTcpEst = 0;
    let totalUdp = 0;

    const seriesLen = 24;
    const aggRx = new Array<number>(seriesLen).fill(0);
    const aggTx = new Array<number>(seriesLen).fill(0);
    const hotspots: HotspotItem[] = [];

    for (const node of nodes) {
      const m = node.metrics;
      const muted = isNodeMuted(node);
      if (muted) mutedCount += 1;

      const memPct = getMemUsagePct(node);
      const stealPct = m?.cpu.steal ?? 0;
      const trafficLimit = node.traffic.limit_bytes;
      const trafficPct = getTrafficUsagePct(node.traffic);

      if (!node.online) {
        hotspots.push({
          node,
          kind: "offline",
          label: "离线失联",
          valueText: formatRelativeTime(node.last_seen_ts),
          severity: "critical",
        });
      } else {
        onlineCount += 1;
        let nodeWarn = false;

        if (stealPct >= 1.5) {
          nodeWarn = true;
          hotspots.push({
            node,
            kind: "steal",
            label: "CPU 争抢",
            valueText: `${stealPct.toFixed(1)}%`,
            severity: stealPct >= 5 ? "critical" : "warning",
          });
        }
        if (memPct >= 85) {
          nodeWarn = true;
          hotspots.push({
            node,
            kind: "mem",
            label: "内存高压",
            valueText: `${memPct.toFixed(0)}%`,
            severity: memPct >= 92 ? "critical" : "warning",
          });
        }
        if (trafficLimit !== null && trafficLimit > 0 && trafficPct >= 85) {
          nodeWarn = true;
          hotspots.push({
            node,
            kind: "traffic",
            label: "月流量告急",
            valueText: `${trafficPct.toFixed(0)}%`,
            severity: trafficPct >= 95 ? "critical" : "warning",
          });
        }
        if (nodeWarn) warnCount += 1;

        if (m) {
          totalTxBps += m.net.tx_bps;
          totalRxBps += m.net.rx_bps;
          totalTcpEst += m.net.tcp_est;
          totalUdp += m.net.udp;
        }

        const rxPts = node.sparkline_rx.slice(-seriesLen);
        const txPts = node.sparkline_tx.slice(-seriesLen);
        for (let i = 0; i < seriesLen; i++) {
          const rxIdx = i - (seriesLen - rxPts.length);
          const txIdx = i - (seriesLen - txPts.length);
          if (rxIdx >= 0) aggRx[i] += rxPts[rxIdx] ?? 0;
          if (txIdx >= 0) aggTx[i] += txPts[txIdx] ?? 0;
        }
      }
    }

    // Ensure latest sample matches live total if sparkline was slightly behind
    if (onlineCount > 0) {
      aggRx[seriesLen - 1] = totalRxBps;
      aggTx[seriesLen - 1] = totalTxBps;
    }

    hotspots.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      if (a.kind === "offline" && b.kind !== "offline") return -1;
      if (b.kind === "offline" && a.kind !== "offline") return 1;
      return 0;
    });

    const onlinePct = nodes.length > 0 ? (onlineCount / nodes.length) * 100 : 0;
    const healthyCount = Math.max(0, onlineCount - warnCount);

    return {
      onlineCount,
      offlineCount: Math.max(0, nodes.length - onlineCount),
      healthyCount,
      warnCount,
      mutedCount,
      onlinePct,
      totalTxBps,
      totalRxBps,
      totalTcpEst,
      totalUdp,
      aggRx,
      aggTx,
      hotspots,
    };
  }, [nodes]);

  const hoveredNode = useMemo(
    () => nodes.find((n) => n.id === hoveredNodeId) ?? null,
    [nodes, hoveredNodeId],
  );

  const svgWidth = 260;
  const svgHeight = 64;
  const netMax = Math.max(
    1024 * 1024,
    ...summary.aggRx,
    ...summary.aggTx,
  );
  const rxPaths = buildAreaPaths(summary.aggRx, netMax, svgWidth, svgHeight);
  const txPaths = buildAreaPaths(summary.aggTx, netMax, svgWidth, svgHeight);

  const isCloudflare = hubStatus?.mode === "cloudflare-worker";
  const watchdogMeta = getWatchdogMeta(hubStatus?.watchdog.status);
  const estimatedD1QuotaPct = hubStatus
    ? Math.min(88, Math.max(4, Math.round(hubStatus.total_nodes * 1.35)))
    : 0;

  return (
    <section
      aria-label="机群实时驾驶舱"
      className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5"
    >
      {/* Card 1: Fleet Availability + Clickable Waffle Matrix */}
      <div className="surface-card rounded-2xl p-4 flex flex-col justify-between gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
              <Server className="w-3.5 h-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
              <span>机群在线率与健康晶格</span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-2 font-mono-num">
              <span className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                {summary.onlineCount}
                <span className="text-sm font-medium text-[var(--text-secondary)]">
                  /{nodes.length}
                </span>
              </span>
              <span
                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                  nodes.length === 0
                    ? "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                    : summary.offlineCount === 0
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}
              >
                {summary.onlinePct.toFixed(1)}%
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 text-[10px] font-mono-num text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-500" aria-hidden="true" />
              健康 {summary.healthyCount}
            </span>
            {summary.warnCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300">
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                预警 {summary.warnCount}
              </span>
            )}
            {summary.mutedCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <BellOff className="w-3 h-3 text-slate-400" aria-hidden="true" />
                静默 {summary.mutedCount}
              </span>
            )}
          </div>
        </div>

        {/* Clickable Waffle Matrix */}
        <div>
          {nodes.length === 0 ? (
            <div className="h-14 rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 flex items-center justify-center px-3 text-center text-[11px] text-[var(--text-secondary)]">
              暂无服务器，点击右上角新增探针
            </div>
          ) : (
            <div
              className={`grid grid-cols-6 sm:grid-cols-8 xl:grid-cols-6 gap-1.5 ${
                nodes.length > 36 ? "max-h-28 overflow-y-auto pr-0.5" : ""
              }`}
              role="group"
              aria-label="节点健康状态快捷矩阵"
            >
              {nodes.map((node) => {
                const m = node.metrics;
                const steal = m?.cpu.steal ?? 0;
                const memPct = getMemUsagePct(node);
                const cpuPct = m?.cpu.all ?? 0;
                const trafficPct = getTrafficUsagePct(node.traffic);
                const isWarn =
                  node.online &&
                  (steal >= 1.5 ||
                    memPct >= 85 ||
                    cpuPct >= 85 ||
                    (node.traffic.limit_bytes !== null &&
                      node.traffic.limit_bytes > 0 &&
                      trafficPct >= 85));
                const muted = isNodeMuted(node);

                const tileStateLabel = !node.online
                  ? "离线"
                  : isWarn
                    ? "资源预警"
                    : "运行正常";

                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onSelectNode(node, "charts")}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                    onFocus={() => setHoveredNodeId(node.id)}
                    onBlur={() => setHoveredNodeId(null)}
                    title={`${node.name} (${tileStateLabel})`}
                    aria-label={`${node.name}，${tileStateLabel}，点击查看详情`}
                    className={`h-6 rounded-md border flex items-center justify-center text-[10px] font-mono-num transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                      !node.online
                        ? "border-rose-500/60 bg-rose-500/20 text-rose-600 dark:text-rose-300"
                        : isWarn
                          ? "border-amber-500/60 bg-amber-500/20 text-amber-700 dark:text-amber-300"
                          : "border-emerald-500/45 bg-emerald-500/18 text-emerald-700 dark:text-emerald-300"
                    } ${muted ? "border-dashed" : ""}`}
                  >
                    {!node.online ? (
                      <WifiOff className="w-3 h-3" aria-hidden="true" />
                    ) : isWarn ? (
                      <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                    ) : (
                      <span className="text-[9px] font-bold">
                        {(node.region_code || node.name).slice(0, 2).toUpperCase()}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-2 h-4 flex items-center justify-between text-[11px] font-mono-num text-[var(--text-secondary)] truncate">
            {hoveredNode ? (
              <span className="truncate text-[var(--text-primary)]">
                {[hoveredNode.region_flag, hoveredNode.name].filter(Boolean).join(" ")} ·{" "}
                {hoveredNode.online
                  ? `CPU ${(hoveredNode.metrics?.cpu.all ?? 0).toFixed(1)}%`
                  : `离线 ${formatRelativeTime(hoveredNode.last_seen_ts)}`}
              </span>
            ) : (
              <span>
                {nodes.length === 0
                  ? "等待接入首台服务器探针"
                  : "点击任意晶格直达服务器遥测"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Card 2: Aggregate TX/RX Dual-Line Area Microchart + TCP/UDP */}
      <div className="surface-card rounded-2xl p-4 flex flex-col justify-between gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
              <Activity className="w-3.5 h-3.5 text-cyan-500" aria-hidden="true" />
              <span>全网聚合实时吞吐</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono-num">
              <span className="inline-flex items-center gap-1 font-bold text-indigo-600 dark:text-indigo-400">
                <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
                {formatRate(summary.totalTxBps)}
              </span>
              <span className="inline-flex items-center gap-1 font-bold text-cyan-600 dark:text-cyan-400">
                <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
                {formatRate(summary.totalRxBps)}
              </span>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono-num border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] whitespace-nowrap shrink-0">
            24 点聚合
          </span>
        </div>

        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          preserveAspectRatio="none"
          className="w-full h-16 overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={rxGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.30" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={txGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity="0.26" />
              <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={rxPaths.area} fill={`url(#${rxGradId})`} />
          <path d={txPaths.area} fill={`url(#${txGradId})`} />
          <path
            d={rxPaths.line}
            fill="none"
            stroke="#06b6d4"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={txPaths.line}
            fill="none"
            stroke="#6366f1"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            cx={rxPaths.lastX}
            cy={rxPaths.lastY}
            r="2.6"
            fill="#06b6d4"
            stroke="var(--bg-surface)"
            strokeWidth="1.2"
          />
          <circle
            cx={txPaths.lastX}
            cy={txPaths.lastY}
            r="2.6"
            fill="#6366f1"
            stroke="var(--bg-surface)"
            strokeWidth="1.2"
          />
        </svg>

        <div className="flex items-center justify-between text-[11px] font-mono-num text-[var(--text-secondary)] pt-1 border-t border-[var(--border-subtle)]">
          <span className="inline-flex items-center gap-1">
            <Network className="w-3 h-3 text-[var(--text-secondary)]" aria-hidden="true" />
            TCP Estab{" "}
            <strong className="text-[var(--text-primary)]">
              {summary.totalTcpEst.toLocaleString()}
            </strong>
          </span>
          <span>
            UDP{" "}
            <strong className="text-[var(--text-primary)]">
              {summary.totalUdp.toLocaleString()}
            </strong>
          </span>
        </div>
      </div>

      {/* Card 3: Anomaly Hotspot Radar */}
      <div className="surface-card rounded-2xl p-4 flex flex-col justify-between gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            <Flame className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
            <span>异常热点雷达</span>
          </div>

          <button
            type="button"
            onClick={() => onNavigate("alerts")}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono-num font-semibold border transition-colors ${
              activeAlertsCount > 0
                ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-300 hover:bg-rose-500/25"
                : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            <Bell className="w-2.5 h-2.5" aria-hidden="true" />
            告警 {activeAlertsCount}
          </button>
        </div>

        {summary.hotspots.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-3 text-center">
            <ShieldCheck className="w-6 h-6 text-emerald-500 mb-1" aria-hidden="true" />
            <div className="text-xs font-semibold text-[var(--text-primary)]">
              全机群运行平稳
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              无离线、CPU 争抢或高水位节点
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {summary.hotspots.slice(0, 3).map((item, idx) => {
              const Icon =
                item.kind === "offline"
                  ? WifiOff
                  : item.kind === "steal"
                    ? Flame
                    : item.kind === "mem"
                      ? Cpu
                      : Gauge;
              return (
                <button
                  key={`${item.node.id}-${item.kind}-${idx}`}
                  type="button"
                  onClick={() => onSelectNode(item.node, "charts")}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl border text-left text-[11px] transition-colors ${
                    item.severity === "critical"
                      ? "border-rose-500/30 bg-rose-500/[0.07] hover:border-rose-500/55"
                      : "border-amber-500/30 bg-amber-500/[0.07] hover:border-amber-500/55"
                  }`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <Icon
                      className={`w-3.5 h-3.5 shrink-0 ${
                        item.severity === "critical"
                          ? "text-rose-500"
                          : "text-amber-500"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="font-semibold text-[var(--text-primary)] truncate">
                      {item.node.name}
                    </span>
                  </span>

                  <span className="flex items-center gap-1.5 font-mono-num shrink-0">
                    <span
                      className={
                        item.severity === "critical"
                          ? "text-rose-600 dark:text-rose-300"
                          : "text-amber-700 dark:text-amber-300"
                      }
                    >
                      {item.label}
                    </span>
                    <strong className="text-[var(--text-primary)]">
                      {item.valueText}
                    </strong>
                  </span>
                </button>
              );
            })}
            {summary.hotspots.length > 3 && (
              <div className="text-[10px] font-mono-num text-right text-[var(--text-secondary)]">
                另有 {summary.hotspots.length - 3} 项异常阈值预警
              </div>
            )}
          </div>
        )}
      </div>

      {/* Card 4: Control Plane Architecture & Edge Quota */}
      <div className="surface-card rounded-2xl p-4 flex flex-col justify-between gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
              {!hubStatus ? (
                <Server
                  className="w-3.5 h-3.5 text-[var(--text-secondary)]"
                  aria-hidden="true"
                />
              ) : isCloudflare ? (
                <Cloud className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
              ) : (
                <Server className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
              )}
              <span>控制面架构与配额</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-bold text-[var(--text-primary)] whitespace-nowrap shrink-0">
                {!hubStatus
                  ? "连接控制面中…"
                  : isCloudflare
                    ? "Cloudflare SCCH"
                    : "Rust uniob-hub"}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono-num font-semibold border whitespace-nowrap shrink-0 ${
                  !hubStatus
                    ? "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                    : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                }`}
              >
                {!hubStatus
                  ? "同步中"
                  : isCloudflare
                    ? "$0/月"
                    : `v${hubStatus.version}`}
              </span>
            </div>
          </div>

          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium border whitespace-nowrap shrink-0 ${watchdogMeta.badgeCls}`}
          >
            看门狗: {watchdogMeta.label}
          </span>
        </div>

        {!hubStatus ? (
          <div className="space-y-2 text-[11px] font-mono-num">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">运行架构</span>
              <span className="text-[var(--text-secondary)] whitespace-nowrap shrink-0">
                正在获取拓扑…
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">探针连接</span>
              <span className="text-[var(--text-primary)] font-semibold whitespace-nowrap shrink-0">
                {summary.onlineCount} / {nodes.length} 在线
              </span>
            </div>
          </div>
        ) : isCloudflare ? (
          <div className="space-y-2 text-[11px] font-mono-num">
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[var(--text-secondary)]">
                  D1 日行写入配额 (Zero-Hot-Path)
                </span>
                <span className="font-semibold text-[var(--text-primary)] whitespace-nowrap shrink-0">
                  ~{estimatedD1QuotaPct}% / 100k
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-sky-500 transition-all duration-300"
                  style={{ width: `${estimatedD1QuotaPct}%` }}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--text-secondary)]">
              <span className="whitespace-nowrap">DO 环形分块 TSDB</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold whitespace-nowrap shrink-0">
                30s 热片 · 0 D1 压力
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-[11px] font-mono-num">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">存储与持久化</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold whitespace-nowrap shrink-0">
                SQLite WAL 毫秒落盘
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">探针直连会话</span>
              <span className="text-[var(--text-primary)] font-semibold whitespace-nowrap shrink-0">
                {hubStatus.connected_agents} / {hubStatus.total_nodes} 通道就绪
              </span>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => onNavigate("migration")}
          className="w-full inline-flex items-center justify-between px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-ring)] hover:text-[var(--accent-primary)] transition-colors"
        >
          <span>双模热迁移与架构切换</span>
          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
