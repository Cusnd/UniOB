import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  Loader2,
  Network,
  RefreshCw,
} from "lucide-react";
import {
  Button,
  Card,
  ObservabilityChart,
  SegmentedControl,
  formatBytesPerSec,
  type ObservabilitySeries,
} from "./ui/Primitives";
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
import { formatBytes, getMemTotalBytes } from "../utils/format";

export interface TelemetryChartsPanelProps {
  node: HorizonNode;
  resolvedTheme?: "dark" | "light";
  liveSeries: LiveMetricSample[];
  chartMode: "live" | MetricsRange;
  onChartModeChange: (mode: "live" | MetricsRange) => void;
  wsStatus: WsConnectionStatus;
}

type ChartMode = "live" | MetricsRange;

function computeStats(
  primary: number[],
  secondary?: number[],
): { current: number; avg: number; peak: number } {
  if (primary.length === 0) {
    return { current: 0, avg: 0, peak: 0 };
  }
  const current = primary[primary.length - 1] ?? 0;
  const sum = primary.reduce((acc, v) => acc + v, 0);
  const avg = sum / primary.length;
  const peak = Math.max(0, ...primary, ...(secondary ?? []));
  return { current, avg, peak };
}

function formatAxisTime(unixSec: number, mode: ChartMode): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (mode === "live") {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  if (mode === "1h" || mode === "24h") {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (mode === "1y") {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

interface TelemetryPanelCardProps {
  title: string;
  icon: React.ReactNode;
  series: ObservabilitySeries[];
  stats: { current: string; avg: string; peak: string };
  yMax?: number;
  yUnit?: string;
  isRateBps?: boolean;
  formatValue?: (val: number) => string;
  formatYTick?: (val: number) => string;
  timeLabels: string[];
  hoverIndex: number | null;
  onHoverIndexChange: (idx: number | null) => void;
}

function TelemetryPanelCard({
  title,
  icon,
  series,
  stats,
  yMax,
  yUnit,
  isRateBps = false,
  formatValue,
  formatYTick,
  timeLabels,
  hoverIndex,
  onHoverIndexChange,
}: TelemetryPanelCardProps): React.JSX.Element {
  return (
    <Card className="min-w-0 p-4">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <span
              style={{ color: "var(--accent)" }}
              className="inline-flex shrink-0"
            >
              {icon}
            </span>
            <h3 className="text-[13px] font-semibold">{title}</h3>
          </div>

          {series.length > 1 && (
            <div className="flex items-center gap-2.5 text-[11px]">
              {series.map((s) => (
                <span
                  key={s.label}
                  style={{ color: "var(--text-secondary)" }}
                  className="inline-flex items-center gap-1"
                >
                  <span
                    style={{ backgroundColor: s.color }}
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    aria-hidden="true"
                  />
                  <span>{s.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="font-mono-num flex flex-wrap items-center gap-3 text-[11.5px]">
          <span>
            <span style={{ color: "var(--text-tertiary)" }}>当前 </span>
            <span className="font-semibold">{stats.current}</span>
          </span>
          <span>
            <span style={{ color: "var(--text-tertiary)" }}>均值 </span>
            <span style={{ color: "var(--text-secondary)" }}>{stats.avg}</span>
          </span>
          <span>
            <span style={{ color: "var(--text-tertiary)" }}>峰值 </span>
            <span style={{ color: "var(--text-secondary)" }}>{stats.peak}</span>
          </span>
        </div>
      </div>

      <ObservabilityChart
        series={series}
        height={142}
        yMax={yMax}
        yUnit={yUnit}
        isRateBps={isRateBps}
        formatValue={formatValue}
        formatYTick={formatYTick}
        showYAxis
        yAxisPlacement="left"
        showXAxisTicks
        timeLabels={timeLabels}
        hoverIndex={hoverIndex}
        onHoverIndexChange={onHoverIndexChange}
        ariaLabel={title}
      />
    </Card>
  );
}

export function TelemetryChartsPanel({
  node,
  liveSeries,
  chartMode,
  onChartModeChange,
}: TelemetryChartsPanelProps): React.JSX.Element {
  const [historyData, setHistoryData] =
    useState<NodeMetricsHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    setHoverIdx(null);
  }, [node.id, chartMode]);

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
          err instanceof Error ? err.message : "加载历史数据失败",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [node.id, chartMode, refreshSeq]);

  const effectiveLive = useMemo<LiveMetricSample[]>(() => {
    const list = [...liveSeries];
    if (node.metrics && !list.some((s) => s.ts === node.metrics!.ts)) {
      list.push({ ts: node.metrics.ts, metrics: node.metrics });
    }
    list.sort((a, b) => a.ts - b.ts);
    return list.slice(-90);
  }, [liveSeries, node.metrics]);

  const isCurrentHistory =
    chartMode !== "live" &&
    historyData !== null &&
    historyData.node_id === node.id &&
    historyData.range === chartMode;

  const memTotal = getMemTotalBytes(node);
  const swapTotal = node.swap_total ?? 0;

  const aligned = useMemo(() => {
    if (chartMode === "live") {
      if (!node.online && effectiveLive.length === 0) {
        return {
          hasSamples: false,
          timeLabels: ["-2m", "现在"],
          netRx: [0, 0],
          netTx: [0, 0],
          cpu: [0, 0],
          cpuPeak: null as number[] | null,
          memPct: [0, 0],
          swapPct: null as number[] | null,
          diskPrimary: [0, 0],
          diskSecondary: [0, 0] as number[] | null,
          diskIsBytesUsed: false,
        };
      }

      const labels: string[] = [];
      const netRx: number[] = [];
      const netTx: number[] = [];
      const cpu: number[] = [];
      const memPct: number[] = [];
      const swapPct: number[] = [];
      const diskR: number[] = [];
      const diskW: number[] = [];

      for (const s of effectiveLive) {
        labels.push(formatAxisTime(s.ts, "live"));
        netRx.push(s.metrics.net.rx_bps);
        netTx.push(s.metrics.net.tx_bps);
        cpu.push(s.metrics.cpu.all);
        const tot =
          memTotal > 0 ? memTotal : s.metrics.mem.used + s.metrics.mem.avail;
        memPct.push(
          tot > 0
            ? Number(
                Math.min(100, (s.metrics.mem.used / tot) * 100).toFixed(1),
              )
            : 0,
        );
        swapPct.push(
          swapTotal > 0
            ? Number(
                Math.min(100, (s.metrics.mem.swap_used / swapTotal) * 100).toFixed(
                  1,
                ),
              )
            : 0,
        );

        let rSum = 0;
        let wSum = 0;
        for (const d of s.metrics.disks) {
          rSum += d.r_bps;
          wSum += d.w_bps;
        }
        diskR.push(rSum);
        diskW.push(wSum);
      }

      if (labels.length > 0) {
        labels[labels.length - 1] = "现在";
      }

      return {
        hasSamples: effectiveLive.length > 0,
        timeLabels: labels.length >= 2 ? labels : [labels[0] ?? "-2s", "现在"],
        netRx: netRx.length > 0 ? netRx : [0, 0],
        netTx: netTx.length > 0 ? netTx : [0, 0],
        cpu: cpu.length > 0 ? cpu : [0, 0],
        cpuPeak: null as number[] | null,
        memPct: memPct.length > 0 ? memPct : [0, 0],
        swapPct: swapTotal > 0 && swapPct.length > 0 ? swapPct : null,
        diskPrimary: diskR.length > 0 ? diskR : [0, 0],
        diskSecondary: diskW.length > 0 ? diskW : [0, 0],
        diskIsBytesUsed: false,
      };
    }

    const pts = isCurrentHistory
      ? [...historyData.points].sort((a, b) => a.ts - b.ts)
      : [];

    if (pts.length === 0) {
      return {
        hasSamples: false,
        timeLabels: ["—", "现在"],
        netRx: [0, 0],
        netTx: [0, 0],
        cpu: [0, 0],
        cpuPeak: null as number[] | null,
        memPct: [0, 0],
        swapPct: null as number[] | null,
        diskPrimary: [0, 0],
        diskSecondary: [0, 0] as number[] | null,
        diskIsBytesUsed: false,
      };
    }

    const labels = pts.map((p) => formatAxisTime(p.ts, chartMode));
    const netRx = pts.map((p) => p.net_rx_bps);
    const netTx = pts.map((p) => p.net_tx_bps);
    const cpu = pts.map((p) => Number(p.cpu.toFixed(1)));
    const hasCpuPeak = pts.some((p) => p.cpu_max != null);
    const cpuPeak = hasCpuPeak
      ? pts.map((p) => Number((p.cpu_max ?? p.cpu).toFixed(1)))
      : null;

    const maxObservedMem = Math.max(memTotal, ...pts.map((p) => p.mem_used), 1);
    const memPct = pts.map((p) =>
      Number(Math.min(100, (p.mem_used / maxObservedMem) * 100).toFixed(1)),
    );

    const hasSwap = swapTotal > 0 && pts.some((p) => (p.swap_used ?? 0) > 0);
    const swapPct = hasSwap
      ? pts.map((p) =>
          Number(
            Math.min(100, ((p.swap_used ?? 0) / swapTotal) * 100).toFixed(1),
          ),
        )
      : null;

    const hasDiskIo = pts.some(
      (p) => p.disk_r_bps != null || p.disk_w_bps != null,
    );

    return {
      hasSamples: true,
      timeLabels: labels,
      netRx,
      netTx,
      cpu,
      cpuPeak,
      memPct,
      swapPct,
      diskPrimary: hasDiskIo
        ? pts.map((p) => p.disk_r_bps ?? 0)
        : pts.map((p) => p.disk_used),
      diskSecondary: hasDiskIo ? pts.map((p) => p.disk_w_bps ?? 0) : null,
      diskIsBytesUsed: !hasDiskIo,
    };
  }, [
    chartMode,
    effectiveLive,
    historyData,
    isCurrentHistory,
    memTotal,
    node.online,
    swapTotal,
  ]);

  const netStats = useMemo(
    () => computeStats(aligned.netRx, aligned.netTx),
    [aligned.netRx, aligned.netTx],
  );
  const cpuStats = useMemo(
    () => computeStats(aligned.cpu, aligned.cpuPeak ?? undefined),
    [aligned.cpu, aligned.cpuPeak],
  );
  const memStats = useMemo(
    () => computeStats(aligned.memPct, aligned.swapPct ?? undefined),
    [aligned.memPct, aligned.swapPct],
  );
  const diskStats = useMemo(
    () => computeStats(aligned.diskPrimary, aligned.diskSecondary ?? undefined),
    [aligned.diskPrimary, aligned.diskSecondary],
  );

  const rangeOptions: Array<{ value: ChartMode; label: string }> = [
    { value: "live", label: "实时" },
    { value: "1h", label: "1 小时" },
    { value: "24h", label: "24 小时" },
    { value: "7d", label: "7 天" },
    { value: "30d", label: "30 天" },
  ];
  if (chartMode === "1y") {
    rangeOptions.push({ value: "1y", label: "1 年" });
  }

  return (
    <div className="min-w-0 space-y-4">
      {/* Top Toolbar: Range Switcher + Load / Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<ChartMode>
          ariaLabel="时间范围"
          value={chartMode}
          onChange={onChartModeChange}
          options={rangeOptions}
        />

        <div className="flex items-center gap-2.5">
          {chartMode === "live" ? (
            node.online && node.metrics ? (
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[12px]"
              >
                负载 {node.metrics.cpu.load[0].toFixed(2)} /{" "}
                {node.metrics.cpu.load[1].toFixed(2)} /{" "}
                {node.metrics.cpu.load[2].toFixed(2)}
              </span>
            ) : null
          ) : (
            <Button
              variant="secondary"
              size="xs"
              disabled={historyLoading}
              onClick={() => setRefreshSeq((s) => s + 1)}
              icon={
                historyLoading ? (
                  <Loader2
                    className="h-3 w-3 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                )
              }
            >
              刷新
            </Button>
          )}
        </div>
      </div>

      {historyError && chartMode !== "live" && (
        <div
          role="alert"
          style={{
            backgroundColor: "var(--status-danger-bg)",
            border: "1px solid var(--status-danger-border)",
            color: "var(--status-danger-ink)",
          }}
          className="flex items-center justify-between gap-3 rounded-[9px] px-3.5 py-2 text-[12px]"
        >
          <span>{historyError}</span>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setRefreshSeq((s) => s + 1)}
          >
            重试
          </Button>
        </div>
      )}

      {chartMode !== "live" && historyLoading && !isCurrentHistory ? (
        <Card className="flex items-center justify-center gap-2 py-14 text-[13px]">
          <Loader2
            style={{ color: "var(--accent)" }}
            className="h-4 w-4 animate-spin"
            aria-hidden="true"
          />
          <span style={{ color: "var(--text-secondary)" }}>
            正在加载历史监控图表…
          </span>
        </Card>
      ) : (
        <div className="min-w-0 space-y-3.5">
          {/* Panel 1: 实时网络吞吐 */}
          <TelemetryPanelCard
            title="实时网络吞吐"
            icon={<Network className="h-3.5 w-3.5" aria-hidden="true" />}
            isRateBps
            timeLabels={aligned.timeLabels}
            hoverIndex={hoverIdx}
            onHoverIndexChange={setHoverIdx}
            series={[
              {
                label: "↓ 下行",
                color: "var(--accent)",
                data: aligned.netRx,
              },
              {
                label: "↑ 上行",
                color: "var(--status-ok)",
                data: aligned.netTx,
              },
            ]}
            stats={{
              current: `↓ ${formatBytesPerSec(netStats.current)} · ↑ ${formatBytesPerSec(aligned.netTx[aligned.netTx.length - 1] ?? 0)}`,
              avg: formatBytesPerSec(netStats.avg),
              peak: formatBytesPerSec(netStats.peak),
            }}
          />

          {/* Panel 2: CPU 使用率 */}
          <TelemetryPanelCard
            title="CPU 使用率"
            icon={<Cpu className="h-3.5 w-3.5" aria-hidden="true" />}
            yMax={100}
            yUnit="%"
            timeLabels={aligned.timeLabels}
            hoverIndex={hoverIdx}
            onHoverIndexChange={setHoverIdx}
            series={
              aligned.cpuPeak
                ? [
                    {
                      label: "CPU",
                      color: "var(--accent)",
                      data: aligned.cpu,
                    },
                    {
                      label: "峰值",
                      color: "var(--status-warn)",
                      data: aligned.cpuPeak,
                      dashed: true,
                    },
                  ]
                : [
                    {
                      label: "CPU",
                      color: "var(--accent)",
                      data: aligned.cpu,
                    },
                  ]
            }
            stats={{
              current: `${cpuStats.current.toFixed(1)}%`,
              avg: `${cpuStats.avg.toFixed(1)}%`,
              peak: `${cpuStats.peak.toFixed(1)}%`,
            }}
          />

          {/* Panel 3: 内存与交换区 */}
          <TelemetryPanelCard
            title="内存与交换区"
            icon={<Activity className="h-3.5 w-3.5" aria-hidden="true" />}
            yMax={100}
            yUnit="%"
            timeLabels={aligned.timeLabels}
            hoverIndex={hoverIdx}
            onHoverIndexChange={setHoverIdx}
            series={
              aligned.swapPct
                ? [
                    {
                      label: "内存",
                      color: "var(--accent)",
                      data: aligned.memPct,
                    },
                    {
                      label: "交换区",
                      color: "var(--status-warn)",
                      data: aligned.swapPct,
                      dashed: true,
                    },
                  ]
                : [
                    {
                      label: "内存",
                      color: "var(--accent)",
                      data: aligned.memPct,
                    },
                  ]
            }
            stats={{
              current: `${memStats.current.toFixed(1)}%`,
              avg: `${memStats.avg.toFixed(1)}%`,
              peak: `${memStats.peak.toFixed(1)}%`,
            }}
          />

          {/* Panel 4: 磁盘读写吞吐 / 磁盘占用 */}
          {aligned.diskIsBytesUsed ? (
            <TelemetryPanelCard
              title="磁盘占用趋势"
              icon={<HardDrive className="h-3.5 w-3.5" aria-hidden="true" />}
              timeLabels={aligned.timeLabels}
              hoverIndex={hoverIdx}
              onHoverIndexChange={setHoverIdx}
              formatValue={(v) => formatBytes(v)}
              formatYTick={(v) => (v <= 0 ? "0" : formatBytes(v, 0))}
              series={[
                {
                  label: "已用",
                  color: "var(--accent)",
                  data: aligned.diskPrimary,
                },
              ]}
              stats={{
                current: formatBytes(diskStats.current),
                avg: formatBytes(diskStats.avg),
                peak: formatBytes(diskStats.peak),
              }}
            />
          ) : (
            <TelemetryPanelCard
              title="磁盘读写吞吐"
              icon={<HardDrive className="h-3.5 w-3.5" aria-hidden="true" />}
              isRateBps
              timeLabels={aligned.timeLabels}
              hoverIndex={hoverIdx}
              onHoverIndexChange={setHoverIdx}
              series={[
                {
                  label: "读",
                  color: "var(--accent)",
                  data: aligned.diskPrimary,
                },
                {
                  label: "写",
                  color: "var(--status-ok)",
                  data: aligned.diskSecondary ?? [0, 0],
                },
              ]}
              stats={{
                current: `${formatBytesPerSec(diskStats.current)} / ${formatBytesPerSec(aligned.diskSecondary?.[aligned.diskSecondary.length - 1] ?? 0)}`,
                avg: formatBytesPerSec(diskStats.avg),
                peak: formatBytesPerSec(diskStats.peak),
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
