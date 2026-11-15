import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  BellOff,
  Cpu,
  HardDrive,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import type {
  MetricsRange,
  NodeMetricsHistoryResponse,
  NodeSummary,
} from "../types";
import type { LiveMetricSample, ProcsPacket } from "../hooks/useFleetSocket";
import { api } from "../api/client";
import {
  formatBytes,
  formatRate,
  formatRelativeTime,
  formatUptime,
  getMemTotalBytes,
  getMemUsagePct,
  getRootDisk,
  isNodeMuted,
  parseOsBadge,
} from "../utils/format";
import { TimeChart } from "./TimeChart";
import { ProcessTable } from "./ProcessTable";
import { HardwareTab } from "./HardwareTab";

type DrawerTab = "charts" | "procs" | "hardware";
type ChartMode = "live" | MetricsRange;

interface NodeDrawerProps {
  node: NodeSummary | null;
  resolvedTheme: "dark" | "light";
  liveSeries: LiveMetricSample[];
  procsPacket: ProcsPacket | null;
  onClose: () => void;
  onSubNode: (nodeId: string, proc: boolean) => void;
  onUnsubNode: (nodeId: string) => void;
  onNodeUpdated: (node: NodeSummary) => void;
  onNodeDeleted: (id: string) => void;
}

const CHART_RANGES: { key: ChartMode; label: string }[] = [
  { key: "live", label: "实时（2秒）" },
  { key: "1h", label: "1 小时" },
  { key: "24h", label: "24 小时" },
  { key: "7d", label: "7 天" },
  { key: "30d", label: "30 天" },
  { key: "1y", label: "1 年" },
];

interface NodeDrawerContentProps extends Omit<NodeDrawerProps, "node"> {
  node: NodeSummary;
}

export function NodeDrawer(props: NodeDrawerProps) {
  if (!props.node) return null;
  return <NodeDrawerContent key={props.node.id} {...props} node={props.node} />;
}

function NodeDrawerContent({
  node,
  resolvedTheme,
  liveSeries,
  procsPacket,
  onClose,
  onSubNode,
  onUnsubNode,
  onNodeUpdated,
  onNodeDeleted,
}: NodeDrawerContentProps) {
  const baseId = useId();
  const drawerTitleId = `${baseId}-title`;
  const tabRefs = useRef<Record<DrawerTab, HTMLButtonElement | null>>({
    charts: null,
    procs: null,
    hardware: null,
  });

  const [activeTab, setActiveTab] = useState<DrawerTab>("charts");
  const [chartMode, setChartMode] = useState<ChartMode>("live");
  const [historyData, setHistoryData] =
    useState<NodeMetricsHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const handleDrawerTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    const order: DrawerTab[] = ["charts", "procs", "hardware"];
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % order.length;
    else if (e.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + order.length) % order.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = order.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const nextTab = order[nextIndex];
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Manage live / proc WebSocket subscription strictly based on active tab & mode
  useEffect(() => {
    if (activeTab === "procs") {
      onSubNode(node.id, true);
    } else if (activeTab === "charts" && chartMode === "live") {
      onSubNode(node.id, false);
    } else {
      onUnsubNode(node.id);
    }
  }, [node.id, activeTab, chartMode, onSubNode, onUnsubNode]);

  // Always unsubscribe on unmount (drawer close or node switch)
  useEffect(() => {
    const id = node.id;
    return () => {
      onUnsubNode(id);
    };
  }, [node.id, onUnsubNode]);

  const fetchHistory = useCallback(
    async (targetId: string, range: MetricsRange) => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const res = await api.getNodeMetrics(targetId, range);
        setHistoryData(res);
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : "加载历史曲线失败");
      } finally {
        setHistoryLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (activeTab !== "charts" || chartMode === "live") return;
    void fetchHistory(node.id, chartMode);
  }, [node.id, activeTab, chartMode, fetchHistory]);

  // Effective live points (seed with node.metrics if liveSeries has none yet)
  const effectiveLive = useMemo<LiveMetricSample[]>(() => {
    if (liveSeries.length > 0) return liveSeries;
    if (node.metrics) return [{ ts: node.metrics.ts, metrics: node.metrics }];
    return [];
  }, [node.metrics, liveSeries]);

  const liveArrays = useMemo(() => {
    const ts: number[] = [];
    const cpuAll: number[] = [];
    const cpuSteal: number[] = [];
    const cpuIowait: number[] = [];
    const memUsed: number[] = [];
    const memCached: number[] = [];
    const swapUsed: number[] = [];
    const diskR: number[] = [];
    const diskW: number[] = [];
    const netRx: number[] = [];
    const netTx: number[] = [];
    const tcpEst: number[] = [];
    const tcpTw: number[] = [];
    const udpCnt: number[] = [];

    for (const s of effectiveLive) {
      ts.push(s.ts);
      cpuAll.push(s.metrics.cpu.all);
      cpuSteal.push(s.metrics.cpu.steal);
      cpuIowait.push(s.metrics.cpu.iowait);
      memUsed.push(s.metrics.mem.used);
      memCached.push(s.metrics.mem.cached);
      swapUsed.push(s.metrics.mem.swap_used);
      let rSum = 0;
      let wSum = 0;
      for (const d of s.metrics.disks) {
        rSum += d.r_bps;
        wSum += d.w_bps;
      }
      diskR.push(rSum);
      diskW.push(wSum);
      netRx.push(s.metrics.net.rx_bps);
      netTx.push(s.metrics.net.tx_bps);
      tcpEst.push(s.metrics.net.tcp_est);
      tcpTw.push(s.metrics.net.tcp_tw);
      udpCnt.push(s.metrics.net.udp);
    }

    return {
      ts,
      cpuAll,
      cpuSteal,
      cpuIowait,
      memUsed,
      memCached,
      swapUsed,
      diskR,
      diskW,
      netRx,
      netTx,
      tcpEst,
      tcpTw,
      udpCnt,
    };
  }, [effectiveLive]);

  const historyResolution =
    historyData?.resolution ??
    (chartMode === "1h" || chartMode === "24h"
      ? "30s"
      : chartMode === "7d"
        ? "5m"
        : "1h");

  const historyArrays = useMemo(() => {
    const pts = historyData?.points ?? [];
    const ts: number[] = [];
    const cpu: number[] = [];
    const cpuMax: (number | null)[] = [];
    const steal: (number | null)[] = [];
    const memUsed: number[] = [];
    const memMax: (number | null)[] = [];
    const swapUsed: (number | null)[] = [];
    const diskUsed: number[] = [];
    const diskR: number[] = [];
    const diskW: number[] = [];
    const netRx: number[] = [];
    const netTx: number[] = [];
    const tcpEst: (number | null)[] = [];
    const load1: (number | null)[] = [];

    for (const p of pts) {
      ts.push(p.ts);
      cpu.push(p.cpu);
      cpuMax.push(p.cpu_max ?? null);
      steal.push(p.steal ?? null);
      memUsed.push(p.mem_used);
      memMax.push(p.mem_max ?? null);
      swapUsed.push(p.swap_used ?? null);
      diskUsed.push(p.disk_used);
      diskR.push(p.disk_r_bps ?? 0);
      diskW.push(p.disk_w_bps ?? 0);
      netRx.push(p.net_rx_bps);
      netTx.push(p.net_tx_bps);
      tcpEst.push(p.tcp_est ?? null);
      load1.push(p.load1 ?? null);
    }

    return {
      ts,
      cpu,
      cpuMax,
      steal,
      memUsed,
      memMax,
      swapUsed,
      diskUsed,
      diskR,
      diskW,
      netRx,
      netTx,
      tcpEst,
      load1,
      hasCpuMax: historyResolution !== "30s" && pts.some((p) => p.cpu_max !== undefined),
      hasMemMax: historyResolution !== "30s" && pts.some((p) => p.mem_max !== undefined),
      hasSteal: historyResolution === "30s" || historyResolution === "5m",
      hasSwap: historyResolution === "30s",
      hasTcp: historyResolution === "30s",
      hasLoad: historyResolution === "30s" || historyResolution === "5m",
    };
  }, [historyData, historyResolution]);

  const osBadge = parseOsBadge(node.os);
  const muted = isNodeMuted(node);
  const rootDisk = getRootDisk(node.metrics?.disks);
  const memPct = getMemUsagePct(node);
  const memTotal = getMemTotalBytes(node);
  const isLongHistory =
    chartMode === "7d" || chartMode === "30d" || chartMode === "1y";

  const liveMemMaxObserved = useMemo(() => {
    let maxVal = 0;
    for (const v of liveArrays.memUsed) {
      if (Number.isFinite(v) && v > maxVal) maxVal = v;
    }
    for (const v of liveArrays.memCached) {
      if (Number.isFinite(v) && v > maxVal) maxVal = v;
    }
    for (const v of liveArrays.swapUsed) {
      if (Number.isFinite(v) && v > maxVal) maxVal = v;
    }
    return maxVal;
  }, [liveArrays.memUsed, liveArrays.memCached, liveArrays.swapUsed]);

  const histMemMaxObserved = useMemo(() => {
    let maxVal = 0;
    for (const v of historyArrays.memUsed) {
      if (Number.isFinite(v) && v > maxVal) maxVal = v;
    }
    if (historyArrays.hasMemMax) {
      for (const v of historyArrays.memMax) {
        if (v !== null && Number.isFinite(v) && v > maxVal) maxVal = v;
      }
    }
    if (historyArrays.hasSwap) {
      for (const v of historyArrays.swapUsed) {
        if (v !== null && Number.isFinite(v) && v > maxVal) maxVal = v;
      }
    }
    return maxVal;
  }, [historyArrays]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
      />

      {/* Drawer Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={drawerTitleId}
        className="relative z-10 w-full max-w-4xl h-full bg-[#f3f6fa] dark:bg-[#090d14] border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
      >
        {/* Header */}
        <header className="shrink-0 bg-white dark:bg-[#0f1623] border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                  {node.online && (
                    <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                  )}
                  <span
                    className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                      node.online ? "bg-emerald-500" : "bg-rose-500"
                    }`}
                  />
                </span>
                <h2
                  id={drawerTitleId}
                  className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-50 truncate"
                >
                  {node.name}
                </h2>
                <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  {node.group_name}
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[11px] font-medium border ${osBadge.colorClass}`}
                >
                  {osBadge.short}
                </span>
                {muted && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/30">
                    <BellOff className="w-3 h-3" aria-hidden="true" />
                    告警静默中
                  </span>
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                <span>{node.hostname || "等待首次连接"}</span>
                <span>
                  {node.online
                    ? `运行 ${formatUptime(node.metrics?.up)}`
                    : `离线 (${formatRelativeTime(node.last_seen_ts)})`}
                </span>
                {node.metrics && (
                  <>
                    <span>
                      平均负载：{node.metrics.cpu.load[0].toFixed(2)} /{" "}
                      {node.metrics.cpu.load[1].toFixed(2)} /{" "}
                      {node.metrics.cpu.load[2].toFixed(2)}
                    </span>
                    <span>
                      内存：{formatBytes(node.metrics.mem.used)} / {formatBytes(memTotal)} (
                      {memPct.toFixed(1)}%)
                    </span>
                    {rootDisk && (
                      <span>
                        主磁盘：{formatBytes(rootDisk.used)} / {formatBytes(rootDisk.total)}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              aria-label="关闭窗口"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          {/* Drawer Tabs */}
          <div
            role="tablist"
            aria-label="服务器详情视图"
            className="mt-4 flex items-center gap-1 border-b border-transparent -mb-4"
          >
            {(
              [
                { key: "charts", label: "实时曲线与历史", icon: Activity },
                { key: "procs", label: "运行中进程", icon: Terminal },
                { key: "hardware", label: "系统与磁盘详情", icon: HardDrive },
              ] as const
            ).map((tab, idx) => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  ref={(el) => {
                    tabRefs.current[tab.key] = el;
                  }}
                  id={`${baseId}-tab-${tab.key}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`${baseId}-panel-${tab.key}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setActiveTab(tab.key)}
                  onKeyDown={(e) => handleDrawerTabKeyDown(e, idx)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                    active
                      ? "border-sky-500 text-sky-600 dark:text-sky-400"
                      : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          <div
            role="tabpanel"
            id={`${baseId}-panel-charts`}
            aria-labelledby={`${baseId}-tab-charts`}
            hidden={activeTab !== "charts"}
            className="space-y-4"
          >
            {activeTab === "charts" && (
              <>
                {/* Time Range Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex flex-wrap items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-1 gap-1">
                    {CHART_RANGES.map((r) => {
                      const active = chartMode === r.key;
                      return (
                        <button
                          key={r.key}
                          type="button"
                          onClick={() => setChartMode(r.key)}
                          className={`px-3 py-1 rounded-md text-xs font-mono-num font-medium transition-colors ${
                            active
                              ? "bg-sky-500 text-white shadow-xs"
                              : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                          }`}
                        >
                          {r.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                    {chartMode === "live" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                        <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
                        每 2 秒自动刷新（已采集 {effectiveLive.length} 条）
                      </span>
                    ) : (
                      <>
                        {historyData && (
                          <span>
                            采样间隔：{historyData.resolution} · 共 {historyData.points.length} 条
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void fetchHistory(node.id, chartMode)}
                          disabled={historyLoading}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 disabled:opacity-50"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 ${historyLoading ? "animate-spin" : ""}`}
                            aria-hidden="true"
                          />
                          刷新
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {chartMode !== "live" && historyError && (
                  <div
                    role="alert"
                    className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-300"
                  >
                    {historyError}
                  </div>
                )}

                {chartMode === "live" ? (
                  <div className="grid grid-cols-1 gap-4">
                    <TimeChart
                      title="处理器占用率 (%)"
                      subtitle={
                        node.metrics
                          ? `当前 ${node.metrics.cpu.all.toFixed(1)}% · CPU 争抢 ${node.metrics.cpu.steal.toFixed(1)}% · 磁盘等待 ${node.metrics.cpu.iowait.toFixed(1)}%`
                          : undefined
                      }
                      timestamps={liveArrays.ts}
                      seriesData={[
                        liveArrays.cpuAll,
                        liveArrays.cpuSteal,
                        liveArrays.cpuIowait,
                      ]}
                      seriesConfig={[
                        {
                          label: "总占用 %",
                          color: "#0ea5e9",
                          fill: "rgba(14, 165, 233, 0.16)",
                        },
                        {
                          label: "CPU 争抢 %",
                          color: "#f59e0b",
                          fill: "rgba(245, 158, 11, 0.14)",
                        },
                        {
                          label: "磁盘等待 %",
                          color: "#f43f5e",
                        },
                      ]}
                      formatValue={(v) => `${v.toFixed(1)}%`}
                      resolvedTheme={resolvedTheme}
                      yMin={0}
                      yMax={100}
                    />

                    <TimeChart
                      title="内存与虚拟内存使用量"
                      subtitle={
                        node.metrics
                          ? memTotal > 0
                            ? `已用 ${formatBytes(node.metrics.mem.used)} / ${formatBytes(memTotal)} · 虚拟内存 ${formatBytes(node.metrics.mem.swap_used)}`
                            : `已用 ${formatBytes(node.metrics.mem.used)} · 虚拟内存 ${formatBytes(node.metrics.mem.swap_used)}`
                          : undefined
                      }
                      timestamps={liveArrays.ts}
                      seriesData={[
                        liveArrays.memUsed,
                        liveArrays.memCached,
                        liveArrays.swapUsed,
                      ]}
                      seriesConfig={[
                        {
                          label: "已用内存",
                          color: "#10b981",
                          fill: "rgba(16, 185, 129, 0.15)",
                        },
                        {
                          label: "系统缓存",
                          color: "#38bdf8",
                          dash: [4, 4],
                        },
                        {
                          label: "虚拟内存已用",
                          color: "#a855f7",
                        },
                      ]}
                      formatValue={(v) => formatBytes(v)}
                      resolvedTheme={resolvedTheme}
                      yMin={0}
                      yMax={memTotal > 0 ? Math.max(memTotal, liveMemMaxObserved) : undefined}
                    />

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <TimeChart
                        title="磁盘读写速率"
                        timestamps={liveArrays.ts}
                        seriesData={[liveArrays.diskR, liveArrays.diskW]}
                        seriesConfig={[
                          {
                            label: "读取速率",
                            color: "#22c55e",
                            fill: "rgba(34, 197, 94, 0.14)",
                          },
                          {
                            label: "写入速率",
                            color: "#f97316",
                            fill: "rgba(249, 115, 22, 0.14)",
                          },
                        ]}
                        formatValue={(v) => formatRate(v)}
                        resolvedTheme={resolvedTheme}
                        yMin={0}
                      />

                      <TimeChart
                        title="网络实时速率"
                        timestamps={liveArrays.ts}
                        seriesData={[liveArrays.netRx, liveArrays.netTx]}
                        seriesConfig={[
                          {
                            label: "下载速率",
                            color: "#06b6d4",
                            fill: "rgba(6, 182, 212, 0.15)",
                          },
                          {
                            label: "上传速率",
                            color: "#6366f1",
                            fill: "rgba(99, 102, 241, 0.15)",
                          },
                        ]}
                        formatValue={(v) => formatRate(v)}
                        resolvedTheme={resolvedTheme}
                        yMin={0}
                      />
                    </div>

                    <TimeChart
                      title="网络连接状态"
                      timestamps={liveArrays.ts}
                      seriesData={[
                        liveArrays.tcpEst,
                        liveArrays.tcpTw,
                        liveArrays.udpCnt,
                      ]}
                      seriesConfig={[
                        {
                          label: "活跃连接",
                          color: "#10b981",
                          fill: "rgba(16, 185, 129, 0.12)",
                        },
                        {
                          label: "等待关闭连接",
                          color: "#f59e0b",
                        },
                        {
                          label: "UDP 连接",
                          color: "#64748b",
                        },
                      ]}
                      formatValue={(v) => `${Math.round(v)}`}
                      resolvedTheme={resolvedTheme}
                      yMin={0}
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    <TimeChart
                      title={
                        historyArrays.hasCpuMax
                          ? "处理器平均与峰值占用率 (%)"
                          : "处理器占用率 (%)"
                      }
                      timestamps={historyArrays.ts}
                      seriesData={
                        historyArrays.hasCpuMax
                          ? historyArrays.hasSteal
                            ? [
                                historyArrays.cpu,
                                historyArrays.cpuMax,
                                historyArrays.steal,
                              ]
                            : [historyArrays.cpu, historyArrays.cpuMax]
                          : [historyArrays.cpu, historyArrays.steal]
                      }
                      seriesConfig={
                        historyArrays.hasCpuMax
                          ? historyArrays.hasSteal
                            ? [
                                {
                                  label: "平均占用 %",
                                  color: "#0ea5e9",
                                  fill: "rgba(14, 165, 233, 0.15)",
                                },
                                {
                                  label: "峰值占用 %",
                                  color: "#f43f5e",
                                  dash: [4, 3],
                                },
                                {
                                  label: "争抢峰值 %",
                                  color: "#f59e0b",
                                },
                              ]
                            : [
                                {
                                  label: "平均占用 %",
                                  color: "#0ea5e9",
                                  fill: "rgba(14, 165, 233, 0.15)",
                                },
                                {
                                  label: "峰值占用 %",
                                  color: "#f43f5e",
                                  dash: [4, 3],
                                },
                              ]
                          : [
                              {
                                label: "总占用 %",
                                color: "#0ea5e9",
                                fill: "rgba(14, 165, 233, 0.15)",
                              },
                              {
                                label: "CPU 争抢 %",
                                color: "#f59e0b",
                              },
                            ]
                      }
                      formatValue={(v) => `${v.toFixed(1)}%`}
                      resolvedTheme={resolvedTheme}
                      yMin={0}
                      yMax={100}
                    />

                    <TimeChart
                      title="内存与虚拟内存趋势"
                      timestamps={historyArrays.ts}
                      seriesData={
                        historyArrays.hasMemMax
                          ? [historyArrays.memUsed, historyArrays.memMax]
                          : historyArrays.hasSwap
                            ? [historyArrays.memUsed, historyArrays.swapUsed]
                            : [historyArrays.memUsed]
                      }
                      seriesConfig={
                        historyArrays.hasMemMax
                          ? [
                              {
                                label: "平均已用",
                                color: "#10b981",
                                fill: "rgba(16, 185, 129, 0.15)",
                              },
                              {
                                label: "峰值已用",
                                color: "#38bdf8",
                                dash: [4, 3],
                              },
                            ]
                          : historyArrays.hasSwap
                            ? [
                                {
                                  label: "已用内存",
                                  color: "#10b981",
                                  fill: "rgba(16, 185, 129, 0.15)",
                                },
                                {
                                  label: "虚拟内存已用",
                                  color: "#a855f7",
                                },
                              ]
                            : [
                                {
                                  label: "已用内存",
                                  color: "#10b981",
                                  fill: "rgba(16, 185, 129, 0.15)",
                                },
                              ]
                      }
                      formatValue={(v) => formatBytes(v)}
                      resolvedTheme={resolvedTheme}
                      yMin={0}
                      yMax={memTotal > 0 ? Math.max(memTotal, histMemMaxObserved) : undefined}
                    />

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {isLongHistory ? (
                        <TimeChart
                          title="主磁盘已用空间趋势"
                          timestamps={historyArrays.ts}
                          seriesData={[historyArrays.diskUsed]}
                          seriesConfig={[
                            {
                              label: "磁盘已用",
                              color: "#f97316",
                              fill: "rgba(249, 115, 22, 0.14)",
                            },
                          ]}
                          formatValue={(v) => formatBytes(v)}
                          resolvedTheme={resolvedTheme}
                          yMin={0}
                        />
                      ) : (
                        <TimeChart
                          title="磁盘读写速率"
                          timestamps={historyArrays.ts}
                          seriesData={[historyArrays.diskR, historyArrays.diskW]}
                          seriesConfig={[
                            {
                              label: "读取速率",
                              color: "#22c55e",
                              fill: "rgba(34, 197, 94, 0.14)",
                            },
                            {
                              label: "写入速率",
                              color: "#f97316",
                              fill: "rgba(249, 115, 22, 0.14)",
                            },
                          ]}
                          formatValue={(v) => formatRate(v)}
                          resolvedTheme={resolvedTheme}
                          yMin={0}
                        />
                      )}

                      <TimeChart
                        title="网络速率趋势"
                        timestamps={historyArrays.ts}
                        seriesData={[historyArrays.netRx, historyArrays.netTx]}
                        seriesConfig={[
                          {
                            label: "下载速率",
                            color: "#06b6d4",
                            fill: "rgba(6, 182, 212, 0.15)",
                          },
                          {
                            label: "上传速率",
                            color: "#6366f1",
                            fill: "rgba(99, 102, 241, 0.15)",
                          },
                        ]}
                        formatValue={(v) => formatRate(v)}
                        resolvedTheme={resolvedTheme}
                        yMin={0}
                      />
                    </div>

                    {historyArrays.hasTcp ? (
                      <TimeChart
                        title="活跃网络连接趋势"
                        timestamps={historyArrays.ts}
                        seriesData={[historyArrays.tcpEst]}
                        seriesConfig={[
                          {
                            label: "活跃连接",
                            color: "#10b981",
                            fill: "rgba(16, 185, 129, 0.12)",
                          },
                        ]}
                        formatValue={(v) => `${Math.round(v)}`}
                        resolvedTheme={resolvedTheme}
                        yMin={0}
                      />
                    ) : historyArrays.hasLoad ? (
                      <TimeChart
                        title="系统平均负载"
                        timestamps={historyArrays.ts}
                        seriesData={[historyArrays.load1]}
                        seriesConfig={[
                          {
                            label: "1 分钟平均负载",
                            color: "#8b5cf6",
                            fill: "rgba(139, 92, 246, 0.14)",
                          },
                        ]}
                        formatValue={(v) => v.toFixed(2)}
                        resolvedTheme={resolvedTheme}
                        yMin={0}
                      />
                    ) : null}
                  </div>
                )}
              </>
            )}
          </div>

          <div
            role="tabpanel"
            id={`${baseId}-panel-procs`}
            aria-labelledby={`${baseId}-tab-procs`}
            hidden={activeTab !== "procs"}
          >
            {activeTab === "procs" && (
              <ProcessTable
                nodeId={node.id}
                online={node.online}
                procEnabled={node.proc_enabled}
                procsPacket={procsPacket}
              />
            )}
          </div>

          <div
            role="tabpanel"
            id={`${baseId}-panel-hardware`}
            aria-labelledby={`${baseId}-tab-hardware`}
            hidden={activeTab !== "hardware"}
          >
            {activeTab === "hardware" && (
              <HardwareTab
                node={node}
                onNodeUpdated={onNodeUpdated}
                onNodeDeleted={(id) => {
                  onNodeDeleted(id);
                  onClose();
                }}
              />
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
