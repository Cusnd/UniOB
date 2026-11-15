import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";

export interface ChartSeriesConfig {
  label: string;
  color: string;
  fill?: string;
  width?: number;
  dash?: number[];
}

interface TimeChartProps {
  title: string;
  subtitle?: string;
  timestamps: number[];
  seriesData: (number | null)[][];
  seriesConfig: ChartSeriesConfig[];
  formatValue: (val: number) => string;
  resolvedTheme: "dark" | "light";
  height?: number;
  yMin?: number;
  yMax?: number;
}

export function TimeChart({
  title,
  subtitle,
  timestamps,
  seriesData,
  seriesConfig,
  formatValue,
  resolvedTheme,
  height = 175,
  yMin,
  yMax,
}: TimeChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<uPlot | null>(null);
  const formatRef = useRef(formatValue);
  formatRef.current = formatValue;

  const dataTuple = useMemo<uPlot.AlignedData>(() => {
    return [timestamps, ...seriesData] as uPlot.AlignedData;
  }, [timestamps, seriesData]);

  const seriesKey = useMemo(
    () =>
      JSON.stringify(
        seriesConfig.map((s) => [s.label, s.color, s.fill ?? "", s.width ?? 1.75]),
      ),
    [seriesConfig],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const isDark = resolvedTheme === "dark";
    const axisStroke = isDark ? "#94a3b8" : "#475569";
    const gridStroke = isDark ? "rgba(148, 163, 184, 0.1)" : "rgba(15, 23, 42, 0.08)";
    const initialWidth = Math.max(260, el.clientWidth || 320);

    const opts: uPlot.Options = {
      width: initialWidth,
      height,
      padding: [10, 12, 0, 0],
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
            const lo = yMin !== undefined ? yMin : Math.min(0, min);
            let hi = yMax !== undefined ? yMax : max;
            if (hi <= lo) {
              hi = lo + 1;
            } else if (yMax === undefined) {
              hi = hi * 1.1;
            }
            return [lo, hi];
          },
        },
      },
      axes: [
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { stroke: gridStroke, width: 1 },
          font: "10px ui-monospace, SFMono-Regular, Menlo, monospace",
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
          ticks: { stroke: gridStroke, width: 1 },
          size: 64,
          font: "10px ui-monospace, SFMono-Regular, Menlo, monospace",
          values: (_u, vals) =>
            vals.map((v) => (v === null || v === undefined ? "" : formatRef.current(v))),
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
            rawVal === null || rawVal === undefined ? "—" : formatRef.current(rawVal),
        })),
      ],
    };

    const instance = new uPlot(opts, dataTuple, el);
    chartRef.current = instance;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        if (w > 100 && chartRef.current) {
          chartRef.current.setSize({ width: w, height });
        }
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      instance.destroy();
      if (chartRef.current === instance) {
        chartRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme, height, yMin, yMax, seriesKey]);

  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.setData(dataTuple);
    }
  }, [dataTuple]);

  const hasData = timestamps.length > 0;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h4 className="text-xs font-semibold tracking-wide text-slate-700 dark:text-slate-200">
          {title}
        </h4>
        {subtitle && (
          <span className="text-[11px] font-mono-num text-slate-400 dark:text-slate-500">
            {subtitle}
          </span>
        )}
      </div>
      <div className="relative">
        <div
          ref={containerRef}
          className={hasData ? "w-full overflow-hidden" : "w-full opacity-20 pointer-events-none"}
        />
        {!hasData && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400 dark:text-slate-500 font-mono-num">
            等待采样数据...
          </div>
        )}
      </div>
    </div>
  );
}
