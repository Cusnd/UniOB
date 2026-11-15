import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import {
  Activity,
  AlertTriangle,
  Clock,
  Cpu,
  Database,
  Flame,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import type {
  HorizonNode,
  MetricsRange,
  NodeMetricsHistoryResponse,
} from "../types";
import type {
  LiveMetricSample,
  WsConnectionStatus,
} from "../hooks/useFleetSocket";
import { api } from "../api/client";
import {
  formatBytes,
  formatRate,
  formatRelativeTime,
  getMemTotalBytes,
  getMemUsagePct,
} from "../utils/format";

export interface TelemetryChartsPanelProps {
  node: HorizonNode;
  resolvedTheme: "dark" | "light";
  liveSeries: LiveMetricSample[];
  chartMode: "live" | MetricsRange;
  onChartModeChange: (mode: "live" | MetricsRange) => void;
  wsStatus: WsConnectionStatus;
}

type ChartMode = "live" | MetricsRange;

interface RangeMeta {
  key: ChartMode;
  label: string;
  granularity: string;
  description: string;
}

const TIME_RANGES: RangeMeta[] = [
  {
    key: "live",
    label: "实时 2s",
    granularity: "2s WebSocket",
    description: "内存环形缓冲直推",
  },
  {
    key: "1h",
    label: "1 小时",
    granularity: "30s 环形分块",
    description: "高频 30 秒分块采样",
  },
  {
    key: "24h",
    label: "24 小时",
    granularity: "30s 环形分块",
    description: "全天 30 秒分块曲线",
  },
  {
    key: "7d",
    label: "7 天",
    granularity: "5m Welford",
    description: "5 分钟均值 + 峰值包络",
  },
  {
    key: "30d",
    label: "30 天",
    granularity: "1h 归档",
    description: "小时级 Welford 均值与峰值",
  },
  {
    key: "1y",
    label: "1 年",
    granularity: "1h 归档",
    description: "年度冷数据长期趋势",
  },
];

interface ChartSeriesConfig {
  label: string;
  color: string;
  fill?: string;
  width?: number;
  dash?: number[];
}

interface TelemetryUPlotCardProps {
  title: string;
  icon: React.ReactNode;
  headerMeta?: React.ReactNode;
  footerMeta?: React.ReactNode;
  timestamps: number[];
  seriesData: (number | null)[][];
  seriesConfig: ChartSeriesConfig[];
  formatValue: (val: number) => string;
  formatAxisTick?: (val: number) => string;
  resolvedTheme: "dark" | "light";
  height?: number;
  yMin?: number;
  yMax?: number;
  allowExceedYMax?: boolean;
  minPoints?: number;
  emptyText?: string;
}

function TelemetryUPlotCard({
  title,
  icon,
  headerMeta,
  footerMeta,
  timestamps,
  seriesData,
  seriesConfig,
  formatValue,
  formatAxisTick,
  resolvedTheme,
  height = 190,
  yMin,
  yMax,
  allowExceedYMax = false,
  minPoints = 1,
  emptyText = "等待采样数据...",
}: TelemetryUPlotCardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<uPlot | null>(null);
  const formatValueRef = useRef(formatValue);
  formatValueRef.current = formatValue;
  const formatTickRef = useRef(formatAxisTick ?? formatValue);
  formatTickRef.current = formatAxisTick ?? formatValue;

  const dataTuple = useMemo<uPlot.AlignedData>(() => {
    return [timestamps, ...seriesData] as uPlot.AlignedData;
  }, [timestamps, seriesData]);

  const seriesKey = useMemo(
    () =>
      JSON.stringify(
        seriesConfig.map((s) => [
          s.label,
          s.color,
          s.fill ?? "",
          s.width ?? 1.75,
          s.dash ?? [],
        ]),
      ),
    [seriesConfig],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const isDark = resolvedTheme === "dark";
    const axisStroke = isDark ? "#94a3b8" : "#475569";
    const gridStroke = isDark
      ? "rgba(148, 163, 184, 0.11)"
      : "rgba(15, 23, 42, 0.08)";
    const tickStroke = isDark
      ? "rgba(148, 163, 184, 0.18)"
      : "rgba(15, 23, 42, 0.14)";

    const measureWidth = () => {
      const rectW = Math.floor(el.getBoundingClientRect().width);
      const clientW = Math.floor(el.clientWidth);
      return rectW > 40 ? rectW : clientW;
    };

    const initialWidth = Math.max(240, measureWidth() || 360);

    const opts: uPlot.Options = {
      width: initialWidth,
      height,
      padding: [10, 10, 0, 0],
      cursor: {
        drag: { x: false, y: false },
        points: {
          size: 6,
        },
      },
      scales: {
        x: { time: true },
        y: {
          auto: true,
          range: (_u, min, max) => {
            const safeMin = Number.isFinite(min) ? min : 0;
            const safeMax = Number.isFinite(max) ? max : 0;
            const lo = yMin !== undefined ? yMin : Math.min(0, safeMin);
            let hi: number;
            if (yMax !== undefined) {
              hi = allowExceedYMax ? Math.max(yMax, safeMax * 1.05) : yMax;
            } else {
              hi = safeMax;
            }
            if (hi <= lo) {
              hi = lo + 1;
            } else if (yMax === undefined) {
              hi = hi * 1.12;
            }
            return [lo, hi];
          },
        },
      },
      axes: [
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: tickStroke, width: 1 },
          font: '10px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          values: (u, vals) => {
            const minX = u.scales.x.min ?? 0;
            const maxX = u.scales.x.max ?? 0;
            const spanSec = maxX - minX;
            const pad = (n: number) => String(n).padStart(2, "0");
            return vals.map((v) => {
              const d = new Date(v * 1000);
              if (spanSec > 180 * 86400) {
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
              }
              if (spanSec > 2 * 86400) {
                return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
              }
              if (spanSec > 3600) {
                return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
              }
              return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            });
          },
        },
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: tickStroke, width: 1 },
          size: 66,
          font: '10px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          values: (_u, vals) =>
            vals.map((v) =>
              v === null || v === undefined ? "" : formatTickRef.current(v),
            ),
        },
      ],
      series: [
        {
          label: "时间",
          value: (_u, rawVal) => {
            if (rawVal === null || rawVal === undefined) return "—";
            const d = new Date(rawVal * 1000);
            const pad = (n: number) => String(n).padStart(2, "0");
            return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          },
        },
        ...seriesConfig.map((s) => ({
          label: s.label,
          stroke: s.color,
          fill: s.fill,
          width: s.width ?? 1.75,
          dash: s.dash,
          spanGaps: true,
          value: (_u: uPlot, rawVal: number | null) =>
            rawVal === null || rawVal === undefined
              ? "—"
              : formatValueRef.current(rawVal),
        })),
      ],
    };

    const instance = new uPlot(opts, dataTuple, el);
    chartRef.current = instance;

    let lastWidth = initialWidth;
    const syncSize = () => {
      const w = measureWidth();
      if (w > 40 && w !== lastWidth && chartRef.current === instance) {
        lastWidth = w;
        instance.setSize({ width: w, height });
      }
    };

    const raf1 = window.requestAnimationFrame(() => {
      syncSize();
    });

    const ro = new ResizeObserver(() => {
      syncSize();
    });
    ro.observe(el);

    return () => {
      window.cancelAnimationFrame(raf1);
      ro.disconnect();
      instance.destroy();
      if (chartRef.current === instance) {
        chartRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme, height, yMin, yMax, allowExceedYMax, seriesKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart && dataTuple.length === chart.series.length) {
      chart.setData(dataTuple);
    }
  }, [dataTuple]);

  const hasData = timestamps.length >= minPoints;

  return (
    <section className="surface-card rounded-xl p-3.5 min-w-0 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          {icon}
          <span>{title}</span>
        </h3>
        {headerMeta && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
            {headerMeta}
          </div>
        )}
      </div>

      <div className="relative min-w-0">
        <div
          ref={containerRef}
          className={
            hasData
              ? "w-full min-w-0 overflow-hidden"
              : "w-full min-w-0 overflow-hidden opacity-20 pointer-events-none"
          }
        />
        {!hasData && (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            {emptyText}
          </div>
        )}
      </div>

      {footerMeta && (
        <div className="pt-1.5 border-t border-slate-200/70 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
          {footerMeta}
        </div>
      )}
    </section>
  );
}

function getCoreCellStyle(pct: number): {
  boxClass: string;
  barClass: string;
  levelLabel: string;
} {
  if (pct >= 90) {
    return {
      boxClass:
        "bg-rose-500/12 border-rose-500/35 text-rose-700 dark:text-rose-300",
      barClass: "bg-rose-500",
      levelLabel: "饱和",
    };
  }
  if (pct >= 70) {
    return {
      boxClass:
        "bg-amber-500/12 border-amber-500/35 text-amber-700 dark:text-amber-300",
      barClass: "bg-amber-500",
      levelLabel: "高载",
    };
  }
  if (pct >= 40) {
    return {
      boxClass:
        "bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-300",
      barClass: "bg-sky-500",
      levelLabel: "中载",
    };
  }
  return {
    boxClass:
      "bg-emerald-500/10 border-emerald-500/25 text-emerald-700 dark:text-emerald-300",
    barClass: "bg-emerald-500",
    levelLabel: "空闲",
  };
}

export function TelemetryChartsPanel({
  node,
  resolvedTheme,
  liveSeries,
  chartMode,
  onChartModeChange,
  wsStatus,
}: TelemetryChartsPanelProps): React.JSX.Element {
  const [historyData, setHistoryData] =
    useState<NodeMetricsHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRefreshSeq, setHistoryRefreshSeq] = useState(0);

  const rangeMeta = useMemo(
    () => TIME_RANGES.find((r) => r.key === chartMode) ?? TIME_RANGES[0],
    [chartMode],
  );

  useEffect(() => {
    if (chartMode === "live") {
      setHistoryLoading(false);
      setHistoryError(null);
      return;
    }

    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);

    api
      .getNodeMetrics(node.id, chartMode)
      .then((res) => {
        if (cancelled) return;
        setHistoryData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setHistoryError(
          err instanceof Error ? err.message : "加载历史遥测数据失败",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [node.id, chartMode, historyRefreshSeq]);

  const isCurrentHistory =
    chartMode !== "live" &&
    historyData !== null &&
    historyData.node_id === node.id &&
    historyData.range === chartMode;

  const activeHistory = isCurrentHistory ? historyData : null;

  const granularityLabel = useMemo(() => {
    if (chartMode === "live") return rangeMeta.granularity;
    const res = activeHistory?.resolution;
    if (res === "30s") return "30s 环形分块";
    if (res === "5m") return "5m Welford";
    if (res === "1h") return "1h 归档";
    return rangeMeta.granularity;
  }, [chartMode, activeHistory?.resolution, rangeMeta.granularity]);

  // Seed / merge live series with current snapshot while avoiding duplicates
  const effectiveLive = useMemo<LiveMetricSample[]>(() => {
    const list = [...liveSeries];
    if (node.metrics && (list.length < 2 || node.metrics.ts >= list[0].ts)) {
      if (!list.some((s) => s.ts === node.metrics!.ts)) {
        list.push({ ts: node.metrics.ts, metrics: node.metrics });
      }
    }
    list.sort((a, b) => a.ts - b.ts);
    return list;
  }, [liveSeries, node.metrics]);

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

  const historyArrays = useMemo(() => {
    const rawPts = activeHistory?.points ?? [];
    const pts = [...rawPts].sort((a, b) => a.ts - b.ts);
    const resolution =
      activeHistory?.resolution ??
      (chartMode === "1h" || chartMode === "24h"
        ? "30s"
        : chartMode === "7d"
          ? "5m"
          : "1h");

    const ts: number[] = [];
    const cpu: number[] = [];
    const cpuMax: (number | null)[] = [];
    const steal: (number | null)[] = [];
    const memUsed: number[] = [];
    const memMax: (number | null)[] = [];
    const swapUsed: (number | null)[] = [];
    const diskUsed: number[] = [];
    const diskR: (number | null)[] = [];
    const diskW: (number | null)[] = [];
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
      diskR.push(p.disk_r_bps ?? null);
      diskW.push(p.disk_w_bps ?? null);
      netRx.push(p.net_rx_bps);
      netTx.push(p.net_tx_bps);
      tcpEst.push(p.tcp_est ?? null);
      load1.push(p.load1 ?? null);
    }

    const hasCpuMax =
      resolution !== "30s" && pts.some((p) => p.cpu_max != null);
    const hasMemMax =
      resolution !== "30s" && pts.some((p) => p.mem_max != null);
    const hasSteal =
      resolution === "30s" ||
      resolution === "5m" ||
      pts.some((p) => (p.steal ?? 0) > 0);
    const hasSwap =
      resolution === "30s" || pts.some((p) => (p.swap_used ?? 0) > 0);
    const hasDiskIo =
      resolution === "30s" ||
      pts.some((p) => (p.disk_r_bps ?? 0) > 0 || (p.disk_w_bps ?? 0) > 0);
    const hasTcp =
      resolution === "30s" || pts.some((p) => (p.tcp_est ?? 0) > 0);
    const hasLoad =
      resolution === "30s" ||
      resolution === "5m" ||
      pts.some((p) => (p.load1 ?? 0) > 0);

    const lastPt = pts.length > 0 ? pts[pts.length - 1] : null;
    const peakCpuMax = hasCpuMax
      ? Math.max(...pts.map((p) => p.cpu_max ?? p.cpu))
      : pts.length > 0
        ? Math.max(...pts.map((p) => p.cpu))
        : 0;
    const peakNetRx =
      pts.length > 0 ? Math.max(...pts.map((p) => p.net_rx_bps)) : 0;
    const peakNetTx =
      pts.length > 0 ? Math.max(...pts.map((p) => p.net_tx_bps)) : 0;

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
      hasCpuMax,
      hasSteal,
      hasMemMax,
      hasSwap,
      hasDiskIo,
      hasTcp,
      hasLoad,
      lastPt,
      peakCpuMax,
      peakNetRx,
      peakNetTx,
    };
  }, [activeHistory, chartMode]);

  const memTotal = getMemTotalBytes(node);
  const memPct = getMemUsagePct(node);
  const m = node.metrics;
  const cores = m?.cpu.cores ?? [];

  const coreStats = useMemo(() => {
    if (cores.length === 0) return null;
    let maxVal = 0;
    let maxIdx = 0;
    let hotCount = 0;
    cores.forEach((v, idx) => {
      if (v > maxVal) {
        maxVal = v;
        maxIdx = idx;
      }
      if (v >= 80) hotCount++;
    });
    return { maxVal, maxIdx, hotCount };
  }, [cores]);

  const latestLiveDiskR =
    liveArrays.diskR.length > 0
      ? liveArrays.diskR[liveArrays.diskR.length - 1]
      : 0;
  const latestLiveDiskW =
    liveArrays.diskW.length > 0
      ? liveArrays.diskW[liveArrays.diskW.length - 1]
      : 0;

  const liveWaiting = chartMode === "live" && liveArrays.ts.length < 2;
  const liveEmptyText = node.online
    ? "正在接收实时遥测采样点…"
    : "节点离线，暂无实时波形";

  return (
    <div className="space-y-4">
      {/* Time Range Switch & Sampling Granularity Bar */}
      <div className="surface-card rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-2.5">
        <div
          role="group"
          aria-label="遥测时间跨度"
          className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-100/80 dark:bg-slate-900/70 p-1 border border-slate-200/80 dark:border-slate-800/80"
        >
          {TIME_RANGES.map((r) => {
            const active = chartMode === r.key;
            return (
              <button
                key={r.key}
                type="button"
                aria-pressed={active}
                onClick={() => onChartModeChange(r.key)}
                className={`px-2.5 py-1 rounded-md text-xs font-mono-num font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                  active
                    ? "bg-[var(--accent-primary)] text-white shadow-xs"
                    : "text-slate-600 dark:text-slate-300 hover:bg-white/80 dark:hover:bg-slate-800/80"
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-mono-num">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700/80 bg-slate-50 dark:bg-slate-900/60 text-slate-700 dark:text-slate-200">
            <Clock
              className="w-3.5 h-3.5 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>粒度：{granularityLabel}</span>
            <span className="text-slate-400 dark:text-slate-500">·</span>
            <span className="text-slate-500 dark:text-slate-400">
              {chartMode === "live"
                ? `${liveArrays.ts.length} 点`
                : historyLoading && !isCurrentHistory
                  ? "加载中..."
                  : `${historyArrays.ts.length} 点`}
            </span>
          </span>

          {chartMode === "live" ? (
            !node.online ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-500/12 text-rose-700 dark:text-rose-300 border border-rose-500/30">
                <WifiOff className="w-3.5 h-3.5" aria-hidden="true" />
                <span>离线 · {formatRelativeTime(node.last_seen_ts)}</span>
              </span>
            ) : wsStatus === "connected" ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                <Activity className="w-3.5 h-3.5" aria-hidden="true" />
                <span>WebSocket 实时流</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                <span>
                  {wsStatus === "reconnecting"
                    ? "WS 重连中..."
                    : wsStatus === "connecting"
                      ? "WS 连接中..."
                      : "WS 已断开"}
                </span>
              </span>
            )
          ) : (
            <button
              type="button"
              disabled={historyLoading}
              onClick={() => setHistoryRefreshSeq((n) => n + 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/70 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${historyLoading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              <span>{historyLoading ? "查询中..." : "刷新归档"}</span>
            </button>
          )}
        </div>
      </div>

      {/* Per-Core CPU Real-time Heatmap Matrix */}
      <section className="surface-card rounded-xl p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <Cpu
                className="w-4 h-4 text-[var(--accent-primary)]"
                aria-hidden="true"
              />
              <span>多核处理器实时热力矩阵</span>
            </h3>
            {node.cpu_model && (
              <span className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400 truncate max-w-[320px]">
                {node.cpu_model}
              </span>
            )}
          </div>

          {m && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
              <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700/80">
                均值 {m.cpu.all.toFixed(1)}%
              </span>
              {m.cpu.steal >= 1.5 ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35 font-semibold">
                  <Flame className="w-3 h-3" aria-hidden="true" />
                  Steal {m.cpu.steal.toFixed(1)}%
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700/80">
                  Steal {m.cpu.steal.toFixed(1)}%
                </span>
              )}
              <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700/80">
                I/O Wait {m.cpu.iowait.toFixed(1)}%
              </span>
              {coreStats && (
                <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700/80">
                  峰值 C{coreStats.maxIdx} ({coreStats.maxVal.toFixed(1)}%)
                </span>
              )}
            </div>
          )}
        </div>

        {cores.length > 0 ? (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
              {cores.map((pct, idx) => {
                const clamped = Math.max(0, Math.min(100, pct));
                const style = getCoreCellStyle(clamped);
                return (
                  <div
                    key={idx}
                    className={`rounded-lg border px-2.5 py-2 transition-colors ${style.boxClass}`}
                  >
                    <div className="flex items-center justify-between gap-1 text-[10px] font-mono-num">
                      <span className="font-semibold opacity-80">
                        C{String(idx).padStart(2, "0")}
                      </span>
                      <span className="opacity-75">{style.levelLabel}</span>
                    </div>
                    <div className="mt-1 text-sm font-bold font-mono-num leading-none">
                      {clamped.toFixed(1)}%
                    </div>
                    <div className="mt-1.5 h-1.5 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${style.barClass}`}
                        style={{ width: `${Math.max(3, clamped)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-slate-500 dark:text-slate-400 pt-0.5">
              <span>
                共 {cores.length} 个逻辑核心
                {coreStats && coreStats.hotCount > 0
                  ? ` · ${coreStats.hotCount} 个核心高负载 (>=80%)`
                  : " · 调度均衡"}
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <span
                    className="w-2 h-2 rounded-xs bg-emerald-500"
                    aria-hidden="true"
                  />
                  &lt;40% 空闲
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    className="w-2 h-2 rounded-xs bg-sky-500"
                    aria-hidden="true"
                  />
                  40-70% 中载
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    className="w-2 h-2 rounded-xs bg-amber-500"
                    aria-hidden="true"
                  />
                  70-90% 高载
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    className="w-2 h-2 rounded-xs bg-rose-500"
                    aria-hidden="true"
                  />
                  &gt;=90% 饱和
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 py-5 px-4 text-center text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            {node.online
              ? "暂未收到各逻辑核心采样数据..."
              : `服务器离线，暂无实时分核负载快照${node.cpu_cores ? `（配置规格：${node.cpu_cores} 核）` : ""}`}
          </div>
        )}
      </section>

      {/* Live Waiting Banner when < 2 points */}
      {liveWaiting && node.online && (
        <div className="surface-card rounded-xl px-4 py-3 border border-sky-500/30 bg-sky-500/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-sky-800 dark:text-sky-200">
            <Loader2
              className="w-4 h-4 animate-spin text-sky-500 shrink-0"
              aria-hidden="true"
            />
            <span>
              正在接收实时遥测采样点…（当前 {liveArrays.ts.length} / 2 点，通常 2 秒内绘制完整波形）
            </span>
          </div>
          <span className="text-[11px] font-mono-num text-sky-700/80 dark:text-sky-300/80">
            2s 按需单节点推流已激活
          </span>
        </div>
      )}

      {/* Historical Error Banner */}
      {chartMode !== "live" && historyError && (
        <div
          role="alert"
          className="surface-card rounded-xl p-4 border border-rose-500/40 bg-rose-500/10 flex flex-wrap items-center justify-between gap-3 text-xs"
        >
          <div className="flex items-center gap-2 text-rose-700 dark:text-rose-300">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>加载 {rangeMeta.label} 历史遥测失败：{historyError}</span>
          </div>
          <button
            type="button"
            onClick={() => setHistoryRefreshSeq((n) => n + 1)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>重试</span>
          </button>
        </div>
      )}

      {/* 4 High-Density uPlot Bento Charts OR Historical Loading/Empty State */}
      {chartMode === "live" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 1. Processor Utilization */}
          <TelemetryUPlotCard
            title="处理器利用率"
            icon={
              <Cpu className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
            }
            headerMeta={
              m ? (
                <>
                  <span>总占用 {m.cpu.all.toFixed(1)}%</span>
                  {m.cpu.steal >= 1.5 && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 font-semibold">
                      <Flame className="w-3 h-3" aria-hidden="true" />
                      Steal {m.cpu.steal.toFixed(1)}%
                    </span>
                  )}
                </>
              ) : (
                <span>离线</span>
              )
            }
            footerMeta={
              m && (
                <>
                  <span>
                    Load: {m.cpu.load.map((v) => v.toFixed(2)).join(" / ")}
                  </span>
                  <span>
                    Steal {m.cpu.steal.toFixed(1)}% · I/O Wait{" "}
                    {m.cpu.iowait.toFixed(1)}%
                  </span>
                </>
              )
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
                color: "#10b981",
                fill: "rgba(16, 185, 129, 0.16)",
              },
              {
                label: "CPU Steal %",
                color: "#f59e0b",
                fill: "rgba(245, 158, 11, 0.13)",
              },
              {
                label: "I/O Wait %",
                color: "#8b5cf6",
                width: 1.5,
              },
            ]}
            formatValue={(v) => `${v.toFixed(1)}%`}
            formatAxisTick={(v) => `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`}
            resolvedTheme={resolvedTheme}
            yMin={0}
            yMax={100}
            minPoints={2}
            emptyText={liveEmptyText}
          />

          {/* 2. Memory & Swap */}
          <TelemetryUPlotCard
            title="内存与交换空间"
            icon={
              <MemoryStick
                className="w-3.5 h-3.5 text-sky-500"
                aria-hidden="true"
              />
            }
            headerMeta={
              m ? (
                <span>
                  {formatBytes(m.mem.used)} / {formatBytes(memTotal)} (
                  {memPct.toFixed(1)}%)
                </span>
              ) : undefined
            }
            footerMeta={
              m && (
                <>
                  <span>Page Cache: {formatBytes(m.mem.cached)}</span>
                  <span>
                    Swap: {formatBytes(m.mem.swap_used)}
                    {node.swap_total ? ` / ${formatBytes(node.swap_total)}` : ""}
                  </span>
                </>
              )
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
                color: "#0ea5e9",
                fill: "rgba(14, 165, 233, 0.16)",
              },
              {
                label: "Page Cache",
                color: "#06b6d4",
                dash: [4, 4],
                width: 1.5,
              },
              {
                label: "Swap 已用",
                color: "#a855f7",
                fill: "rgba(168, 85, 247, 0.10)",
              },
            ]}
            formatValue={(v) => formatBytes(v)}
            resolvedTheme={resolvedTheme}
            yMin={0}
            yMax={memTotal > 0 ? memTotal : undefined}
            allowExceedYMax
            minPoints={2}
            emptyText={liveEmptyText}
          />

          {/* 3. Network Throughput */}
          <TelemetryUPlotCard
            title="网络实时吞吐"
            icon={
              <Network className="w-3.5 h-3.5 text-cyan-500" aria-hidden="true" />
            }
            headerMeta={
              m ? (
                <span>
                  RX {formatRate(m.net.rx_bps)} · TX {formatRate(m.net.tx_bps)}
                </span>
              ) : undefined
            }
            footerMeta={
              m && (
                <>
                  <span>累计收包 {formatBytes(m.net.rx_tot)}</span>
                  <span>累计发包 {formatBytes(m.net.tx_tot)}</span>
                </>
              )
            }
            timestamps={liveArrays.ts}
            seriesData={[liveArrays.netRx, liveArrays.netTx]}
            seriesConfig={[
              {
                label: "下行 RX",
                color: "#06b6d4",
                fill: "rgba(6, 182, 212, 0.16)",
              },
              {
                label: "上行 TX",
                color: "#6366f1",
                fill: "rgba(99, 102, 241, 0.14)",
              },
            ]}
            formatValue={(v) => formatRate(v)}
            resolvedTheme={resolvedTheme}
            yMin={0}
            minPoints={2}
            emptyText={liveEmptyText}
          />

          {/* 4. Disk I/O & TCP Connection State */}
          <TelemetryUPlotCard
            title="磁盘 I/O 与连接态"
            icon={
              <HardDrive
                className="w-3.5 h-3.5 text-orange-500"
                aria-hidden="true"
              />
            }
            headerMeta={
              m ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-semibold">
                  TCP Established: {m.net.tcp_est}
                </span>
              ) : undefined
            }
            footerMeta={
              m && (
                <>
                  <span>
                    Read {formatRate(latestLiveDiskR)} · Write{" "}
                    {formatRate(latestLiveDiskW)}
                  </span>
                  <span>
                    TIME_WAIT {m.net.tcp_tw} · UDP {m.net.udp}
                  </span>
                </>
              )
            }
            timestamps={liveArrays.ts}
            seriesData={[liveArrays.diskR, liveArrays.diskW]}
            seriesConfig={[
              {
                label: "磁盘 Read",
                color: "#22c55e",
                fill: "rgba(34, 197, 94, 0.14)",
              },
              {
                label: "磁盘 Write",
                color: "#f97316",
                fill: "rgba(249, 115, 22, 0.14)",
              },
            ]}
            formatValue={(v) => formatRate(v)}
            resolvedTheme={resolvedTheme}
            yMin={0}
            minPoints={2}
            emptyText={liveEmptyText}
          />
        </div>
      ) : historyLoading && !isCurrentHistory ? (
        <div className="surface-card rounded-xl p-10 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
          <Loader2
            className="w-6 h-6 animate-spin text-[var(--accent-primary)]"
            aria-hidden="true"
          />
          <p className="font-semibold text-slate-700 dark:text-slate-200">
            正在加载 {rangeMeta.label} 历史遥测归档...
          </p>
          <p className="text-[11px] opacity-80">
            采样方案：{rangeMeta.granularity} · {rangeMeta.description}
          </p>
        </div>
      ) : !isCurrentHistory ? (
        historyError ? null : (
          <div className="surface-card rounded-xl p-10 text-center text-xs text-slate-500 dark:text-slate-400">
            等待查询历史遥测归档...
          </div>
        )
      ) : historyArrays.ts.length === 0 ? (
        <div className="surface-card rounded-xl p-8 text-center space-y-2.5">
          <Database
            className="w-7 h-7 mx-auto text-slate-400"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            当前 {rangeMeta.label} 时间窗口暂无归档数据
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            新接入节点或刚完成重启后，探针将按 {granularityLabel} 自动聚合写入持久化时序表。
          </p>
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setHistoryRefreshSeq((n) => n + 1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/70 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>重新查询</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 1. History CPU */}
          <TelemetryUPlotCard
            title={
              historyArrays.hasCpuMax
                ? "处理器利用率与峰值包络"
                : "处理器利用率趋势"
            }
            icon={
              <Cpu className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
            }
            headerMeta={
              historyArrays.lastPt ? (
                <span>
                  最新 {historyArrays.lastPt.cpu.toFixed(1)}% · 区间峰值{" "}
                  {historyArrays.peakCpuMax.toFixed(1)}%
                </span>
              ) : undefined
            }
            footerMeta={
              <span>
                采样方案：{activeHistory?.resolution ?? "—"} ·{" "}
                {rangeMeta.description}
              </span>
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
                : historyArrays.hasSteal
                  ? [historyArrays.cpu, historyArrays.steal]
                  : [historyArrays.cpu]
            }
            seriesConfig={
              historyArrays.hasCpuMax
                ? historyArrays.hasSteal
                  ? [
                      {
                        label: "平均 CPU %",
                        color: "#10b981",
                        fill: "rgba(16, 185, 129, 0.16)",
                      },
                      {
                        label: "峰值 cpu_max %",
                        color: "#f43f5e",
                        dash: [5, 4],
                        width: 1.5,
                      },
                      {
                        label: "CPU Steal %",
                        color: "#f59e0b",
                        width: 1.5,
                      },
                    ]
                  : [
                      {
                        label: "平均 CPU %",
                        color: "#10b981",
                        fill: "rgba(16, 185, 129, 0.16)",
                      },
                      {
                        label: "峰值 cpu_max %",
                        color: "#f43f5e",
                        dash: [5, 4],
                        width: 1.5,
                      },
                    ]
                : historyArrays.hasSteal
                  ? [
                      {
                        label: "总占用 CPU %",
                        color: "#10b981",
                        fill: "rgba(16, 185, 129, 0.16)",
                      },
                      {
                        label: "CPU Steal %",
                        color: "#f59e0b",
                        width: 1.5,
                      },
                    ]
                  : [
                      {
                        label: "平均 CPU %",
                        color: "#10b981",
                        fill: "rgba(16, 185, 129, 0.16)",
                      },
                    ]
            }
            formatValue={(v) => `${v.toFixed(1)}%`}
            formatAxisTick={(v) => `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`}
            resolvedTheme={resolvedTheme}
            yMin={0}
            yMax={100}
          />

          {/* 2. History Memory & Swap */}
          <TelemetryUPlotCard
            title="内存与交换空间趋势"
            icon={
              <MemoryStick
                className="w-3.5 h-3.5 text-sky-500"
                aria-hidden="true"
              />
            }
            headerMeta={
              historyArrays.lastPt ? (
                <span>
                  最新 {formatBytes(historyArrays.lastPt.mem_used)}
                  {memTotal > 0 ? ` / ${formatBytes(memTotal)}` : ""}
                </span>
              ) : undefined
            }
            footerMeta={
              <span>
                {historyArrays.hasMemMax
                  ? "含长周期峰值包络 mem_max"
                  : historyArrays.hasSwap
                    ? "含物理内存与 Swap 使用轨迹"
                    : "物理内存平均占用趋势"}
              </span>
            }
            timestamps={historyArrays.ts}
            seriesData={
              historyArrays.hasMemMax
                ? historyArrays.hasSwap
                  ? [
                      historyArrays.memUsed,
                      historyArrays.memMax,
                      historyArrays.swapUsed,
                    ]
                  : [historyArrays.memUsed, historyArrays.memMax]
                : historyArrays.hasSwap
                  ? [historyArrays.memUsed, historyArrays.swapUsed]
                  : [historyArrays.memUsed]
            }
            seriesConfig={
              historyArrays.hasMemMax
                ? historyArrays.hasSwap
                  ? [
                      {
                        label: "平均已用",
                        color: "#0ea5e9",
                        fill: "rgba(14, 165, 233, 0.16)",
                      },
                      {
                        label: "峰值 mem_max",
                        color: "#f43f5e",
                        dash: [5, 4],
                        width: 1.5,
                      },
                      {
                        label: "Swap 已用",
                        color: "#a855f7",
                        width: 1.5,
                      },
                    ]
                  : [
                      {
                        label: "平均已用",
                        color: "#0ea5e9",
                        fill: "rgba(14, 165, 233, 0.16)",
                      },
                      {
                        label: "峰值 mem_max",
                        color: "#f43f5e",
                        dash: [5, 4],
                        width: 1.5,
                      },
                    ]
                : historyArrays.hasSwap
                  ? [
                      {
                        label: "已用内存",
                        color: "#0ea5e9",
                        fill: "rgba(14, 165, 233, 0.16)",
                      },
                      {
                        label: "Swap 已用",
                        color: "#a855f7",
                        width: 1.5,
                      },
                    ]
                  : [
                      {
                        label: "已用内存",
                        color: "#0ea5e9",
                        fill: "rgba(14, 165, 233, 0.16)",
                      },
                    ]
            }
            formatValue={(v) => formatBytes(v)}
            resolvedTheme={resolvedTheme}
            yMin={0}
            yMax={memTotal > 0 ? memTotal : undefined}
            allowExceedYMax
          />

          {/* 3. History Network Throughput */}
          <TelemetryUPlotCard
            title="网络实时吞吐趋势"
            icon={
              <Network className="w-3.5 h-3.5 text-cyan-500" aria-hidden="true" />
            }
            headerMeta={
              historyArrays.ts.length > 0 ? (
                <span>
                  峰值 RX {formatRate(historyArrays.peakNetRx)} · TX{" "}
                  {formatRate(historyArrays.peakNetTx)}
                </span>
              ) : undefined
            }
            footerMeta={
              historyArrays.lastPt && (
                <span>
                  末点速率：RX {formatRate(historyArrays.lastPt.net_rx_bps)} · TX{" "}
                  {formatRate(historyArrays.lastPt.net_tx_bps)}
                </span>
              )
            }
            timestamps={historyArrays.ts}
            seriesData={[historyArrays.netRx, historyArrays.netTx]}
            seriesConfig={[
              {
                label: "下行 RX",
                color: "#06b6d4",
                fill: "rgba(6, 182, 212, 0.16)",
              },
              {
                label: "上行 TX",
                color: "#6366f1",
                fill: "rgba(99, 102, 241, 0.14)",
              },
            ]}
            formatValue={(v) => formatRate(v)}
            resolvedTheme={resolvedTheme}
            yMin={0}
          />

          {/* 4. History Disk I/O or Disk Usage & TCP Established */}
          <TelemetryUPlotCard
            title={
              historyArrays.hasDiskIo
                ? "磁盘 I/O 与连接态"
                : "磁盘占用趋势与连接态"
            }
            icon={
              <HardDrive
                className="w-3.5 h-3.5 text-orange-500"
                aria-hidden="true"
              />
            }
            headerMeta={
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-semibold">
                TCP Established:{" "}
                {historyArrays.hasTcp
                  ? (historyArrays.lastPt?.tcp_est ?? m?.net.tcp_est ?? "—")
                  : (m?.net.tcp_est ?? "—")}
              </span>
            }
            footerMeta={
              historyArrays.lastPt && (
                <>
                  <span>
                    {historyArrays.hasDiskIo
                      ? `末点 Read ${formatRate(historyArrays.lastPt.disk_r_bps ?? 0)} · Write ${formatRate(historyArrays.lastPt.disk_w_bps ?? 0)}`
                      : `主磁盘已用 ${formatBytes(historyArrays.lastPt.disk_used)}`}
                  </span>
                  {historyArrays.hasLoad &&
                    historyArrays.lastPt.load1 !== undefined && (
                      <span>Load1: {historyArrays.lastPt.load1.toFixed(2)}</span>
                    )}
                </>
              )
            }
            timestamps={historyArrays.ts}
            seriesData={
              historyArrays.hasDiskIo
                ? [historyArrays.diskR, historyArrays.diskW]
                : [historyArrays.diskUsed]
            }
            seriesConfig={
              historyArrays.hasDiskIo
                ? [
                    {
                      label: "磁盘 Read",
                      color: "#22c55e",
                      fill: "rgba(34, 197, 94, 0.14)",
                    },
                    {
                      label: "磁盘 Write",
                      color: "#f97316",
                      fill: "rgba(249, 115, 22, 0.14)",
                    },
                  ]
                : [
                    {
                      label: "主磁盘已用",
                      color: "#f97316",
                      fill: "rgba(249, 115, 22, 0.14)",
                    },
                  ]
            }
            formatValue={(v) =>
              historyArrays.hasDiskIo ? formatRate(v) : formatBytes(v)
            }
            resolvedTheme={resolvedTheme}
            yMin={0}
          />
        </div>
      )}
    </div>
  );
}
