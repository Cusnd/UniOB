import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  X,
  ZoomOut,
} from "lucide-react";
import { api } from "../api/client";
import { usePageVisible } from "../hooks/usePageVisible";
import type { HorizonNode, MetricsRange } from "../types";
import type {
  LatencyPiecewiseConfig,
  LatencyScaleMode,
  NetworkDisplaySpan,
  NetworkQualityConfigResponse,
  NetworkQualityPoint,
  NetworkQualityQuery,
  NetworkQualityRange,
  NetworkTarget,
  NetworkTargetId,
  NetworkTimeWindow,
  PiecewiseSizingMode,
} from "../types/network-quality";
import {
  chartModeToNetworkSpan,
  clampNetworkTimeWindow,
  computeLatencyAxis,
  defaultPiecewiseConfig,
  formatQualityValue,
  getTargetColor,
  type LatencyAxisModel,
  loadNetworkHistory,
  MAX_NETWORK_RETENTION_SEC,
  MAX_PIECEWISE_THRESHOLDS,
  NETWORK_DISPLAY_SPAN_OPTIONS,
  NETWORK_RESULTS,
  NETWORK_SPAN_SECONDS,
  networkMeasurementKey,
  networkStatus,
  normalizeIntervalSec,
  normalizePiecewiseConfig,
  panNetworkTimeWindow,
  parseLatencyScaleMode,
  qualityPlotRuns,
  resolveNetworkFetchRange,
  slicePointsForWindow,
  subdivideRunAtThresholds,
  zoomOutNetworkTimeWindow,
} from "../utils/networkQuality";
import { Badge, Button, Card, SegmentedControl } from "./ui/Primitives";
import { NetworkQualitySettings } from "./NetworkQualitySettings";

const LATENCY_SCALE_STORAGE_KEY = "uniob-nq-latency-scale";
const PIECEWISE_GLOBAL_STORAGE_KEY = "uniob-nq-piecewise-config";
const PIECEWISE_NODE_STORAGE_PREFIX = "uniob-nq-piecewise-node:";

function loadPiecewisePref(nodeId: string): {
  config: LatencyPiecewiseConfig;
  perNode: boolean;
} {
  try {
    const nodeRaw = localStorage.getItem(
      `${PIECEWISE_NODE_STORAGE_PREFIX}${nodeId}`,
    );
    if (nodeRaw !== null) {
      return {
        config: normalizePiecewiseConfig(JSON.parse(nodeRaw)),
        perNode: true,
      };
    }
  } catch {
    // ignore invalid node override
  }
  try {
    const globalRaw = localStorage.getItem(PIECEWISE_GLOBAL_STORAGE_KEY);
    if (globalRaw !== null) {
      return {
        config: normalizePiecewiseConfig(JSON.parse(globalRaw)),
        perNode: false,
      };
    }
  } catch {
    // ignore invalid global config
  }
  return { config: defaultPiecewiseConfig(), perNode: false };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function sameLocalCalendarDay(aSec: number, bSec: number): boolean {
  const a = new Date(aSec * 1000);
  const b = new Date(bSec * 1000);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatMonthDayTime(ts: number, includeSeconds: boolean): string {
  const d = new Date(ts * 1000);
  const base = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return includeSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

function formatClockTime(ts: number, includeSeconds: boolean): string {
  const d = new Date(ts * 1000);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return includeSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

function formatTooltipTime(ts: number, includeSeconds: boolean): string {
  return formatMonthDayTime(ts, includeSeconds);
}

function formatChartAxisTick(
  ts: number,
  window: NetworkTimeWindow,
  nowSec: number,
  resolutionSec: number,
): string {
  const spanSec = window.end - window.start;
  const multiDayOrPast =
    spanSec > 86400 ||
    !sameLocalCalendarDay(window.start, window.end) ||
    !sameLocalCalendarDay(window.end, nowSec);
  if (multiDayOrPast) {
    return formatMonthDayTime(ts, spanSec <= 3600 && resolutionSec < 300);
  }
  return formatClockTime(ts, spanSec <= 7200 && resolutionSec < 300);
}

function formatWindowSummary(window: NetworkTimeWindow, nowSec: number): string {
  const spanSec = window.end - window.start;
  const includeSeconds = spanSec <= 900;
  const sameDay = sameLocalCalendarDay(window.start, window.end);
  const startStr =
    sameDay && sameLocalCalendarDay(window.end, nowSec)
      ? formatMonthDayTime(window.start, includeSeconds)
      : formatMonthDayTime(window.start, includeSeconds);
  const endStr = sameDay
    ? formatClockTime(window.end, includeSeconds)
    : formatMonthDayTime(window.end, includeSeconds);
  return `${startStr} – ${endStr}`;
}

function nearestIndex(times: number[], value: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 &&
    Math.abs(times[lo - 1] - value) <= Math.abs(times[lo] - value)
    ? lo - 1
    : lo;
}

interface PiecewiseScaleEditorProps {
  config: LatencyPiecewiseConfig;
  perNode: boolean;
  axis: LatencyAxisModel;
  onChange: (nextConfig: LatencyPiecewiseConfig, nextPerNode: boolean) => void;
}

function PiecewiseScaleEditor({
  config,
  perNode,
  axis,
  onChange,
}: PiecewiseScaleEditorProps): React.JSX.Element {
  const [thresholdDrafts, setThresholdDrafts] = useState<string[]>(() =>
    config.thresholds.map(String),
  );
  const [weightDrafts, setWeightDrafts] = useState<string[]>(() =>
    (config.sizingMode === "share" ? config.shares : config.scales).map(String),
  );

  useEffect(() => {
    setThresholdDrafts(config.thresholds.map(String));
  }, [config.thresholds]);

  useEffect(() => {
    setWeightDrafts(
      (config.sizingMode === "share" ? config.shares : config.scales).map(
        String,
      ),
    );
  }, [config.sizingMode, config.shares, config.scales]);

  const parseDraftThresholds = (drafts: readonly string[]): number[] =>
    drafts.map((s, idx) => {
      const trimmed = s.trim();
      if (!trimmed) return config.thresholds[idx] ?? 250;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : (config.thresholds[idx] ?? 250);
    });

  const commitThresholds = (drafts: readonly string[]) => {
    const next = normalizePiecewiseConfig({
      ...config,
      thresholds: parseDraftThresholds(drafts),
    });
    setThresholdDrafts(next.thresholds.map(String));
    onChange(next, perNode);
  };

  const commitWeights = (drafts: readonly string[]) => {
    const currentList =
      config.sizingMode === "share" ? config.shares : config.scales;
    const parsed = drafts.map((s, idx) => {
      const trimmed = s.trim();
      if (!trimmed) return currentList[idx] ?? 1;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : (currentList[idx] ?? 1);
    });
    const next = normalizePiecewiseConfig({
      ...config,
      ...(config.sizingMode === "share"
        ? { shares: parsed }
        : { scales: parsed }),
    });
    setWeightDrafts(
      (next.sizingMode === "share" ? next.shares : next.scales).map(String),
    );
    onChange(next, perNode);
  };

  const handleAddThreshold = () => {
    const current = parseDraftThresholds(thresholdDrafts);
    if (current.length >= MAX_PIECEWISE_THRESHOLDS) return;
    const lastT = current[current.length - 1] ?? 250;
    const nextT = Math.min(60000, Math.round(lastT + 100));
    const next = normalizePiecewiseConfig({
      ...config,
      thresholds: [...current, nextT],
      shares: [...config.shares, 15],
      scales: [...config.scales, 0.08],
    });
    onChange(next, perNode);
  };

  const handleRemoveThreshold = (idx: number) => {
    const current = parseDraftThresholds(thresholdDrafts);
    if (current.length <= 1) return;
    const next = normalizePiecewiseConfig({
      ...config,
      thresholds: current.filter((_, i) => i !== idx),
      shares: config.shares.filter((_, i) => i !== idx + 1),
      scales: config.scales.filter((_, i) => i !== idx + 1),
    });
    onChange(next, perNode);
  };

  return (
    <div className="mb-2 space-y-2.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-subtle)] p-2.5 text-[11.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<"auto" | "custom">
            size="xs"
            ariaLabel="分段折点模式"
            value={config.auto ? "auto" : "custom"}
            onChange={(mode) =>
              onChange({ ...config, auto: mode === "auto" }, perNode)
            }
            options={[
              { value: "auto", label: "自动折点" },
              { value: "custom", label: "自定义折点" },
            ]}
          />
          {!config.auto && (
            <SegmentedControl<PiecewiseSizingMode>
              size="xs"
              ariaLabel="分段缩放方式"
              value={config.sizingMode}
              onChange={(sizingMode) =>
                onChange({ ...config, sizingMode }, perNode)
              }
              options={[
                { value: "share", label: "高度占比 %" },
                { value: "scale", label: "缩放倍率 ×" },
              ]}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={perNode}
              onChange={(event) => onChange(config, event.target.checked)}
              className="accent-[var(--accent)]"
            />
            仅当前节点
          </label>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onChange(defaultPiecewiseConfig(), false)}
          >
            重置
          </Button>
        </div>
      </div>

      {config.auto ? (
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {axis.bands.length > 1
            ? `已自动按正常延迟上界 ${axis.thresholds[0]} ms 分段：0–${axis.thresholds[0]} ms 占 76% 高度，>${axis.thresholds[0]} ms 压缩至顶部 24%（最高 ${formatQualityValue(axis.rawPeak, " ms")}）。切换到「自定义折点」可手动指定阈值与各段比例。`
            : "当前窗口无显著离群尖峰，保持全量等距线性展示；切换到「自定义折点」可强制按指定阈值分段。"}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 text-[11px] font-medium text-[var(--text-secondary)]">
              阈值点
            </span>
            {thresholdDrafts.map((draft, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-1.5 py-0.5"
              >
                <input
                  type="number"
                  min={1}
                  max={60000}
                  step="any"
                  aria-label={`阈值 ${idx + 1} (ms)`}
                  value={draft}
                  onChange={(event) => {
                    const next = [...thresholdDrafts];
                    next[idx] = event.target.value;
                    setThresholdDrafts(next);
                  }}
                  onBlur={() => commitThresholds(thresholdDrafts)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="font-mono-num min-h-6 w-14 bg-transparent text-right text-[11.5px] text-[var(--text-primary)] focus:outline-none"
                />
                <span className="text-[10.5px] text-[var(--text-tertiary)]">
                  ms
                </span>
                {thresholdDrafts.length > 1 && (
                  <button
                    type="button"
                    aria-label={`删除阈值 ${draft} ms`}
                    onClick={() => handleRemoveThreshold(idx)}
                    className="inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
            {thresholdDrafts.length < MAX_PIECEWISE_THRESHOLDS && (
              <Button
                size="xs"
                variant="secondary"
                onClick={handleAddThreshold}
                icon={<Plus aria-hidden="true" className="h-3 w-3" />}
              >
                添加阈值
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium text-[var(--text-secondary)]">
              区间缩放
            </span>
            {axis.bands.map((band, idx) => {
              const rangeLabel =
                idx === axis.bands.length - 1
                  ? `>${band.fromMs} ms`
                  : `${band.fromMs}~${band.toMs} ms`;
              const pct = Math.round((band.endRatio - band.startRatio) * 100);
              const slopeText =
                band.relativeSlope < 0.1
                  ? band.relativeSlope.toFixed(2)
                  : band.relativeSlope.toFixed(1);
              return (
                <label
                  key={idx}
                  className="inline-flex flex-wrap items-center gap-1.5 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-card)] px-2 py-1"
                >
                  <span className="font-mono-num text-[11px] text-[var(--text-secondary)]">
                    {rangeLabel}
                  </span>
                  <input
                    type="number"
                    min={config.sizingMode === "share" ? 5 : 0.01}
                    max={config.sizingMode === "share" ? 100 : 10}
                    step={config.sizingMode === "share" ? 5 : 0.05}
                    value={weightDrafts[idx] ?? ""}
                    onChange={(event) => {
                      const next = [...weightDrafts];
                      next[idx] = event.target.value;
                      setWeightDrafts(next);
                    }}
                    onBlur={() => commitWeights(weightDrafts)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    className="font-mono-num min-h-6 w-12 rounded border border-[var(--border-hairline)] bg-[var(--bg-subtle)] px-1 text-right text-[11.5px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  <span className="text-[10.5px] text-[var(--text-tertiary)]">
                    {config.sizingMode === "share" ? "%" : "×"}
                  </span>
                  <span className="font-mono-num text-[10px] text-[var(--text-tertiary)]">
                    占 {pct}% · {slopeText}×
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface QualityChartProps {
  data: NetworkQualityQuery;
  metric: "latency_ms" | "failure_rate_pct";
  title: string;
  targetMeta: Map<NetworkTargetId, { label: string; color: string }>;
  window: NetworkTimeWindow;
  nowSec: number;
  latencyScale?: LatencyScaleMode;
  onLatencyScaleChange?: (mode: LatencyScaleMode) => void;
  piecewiseConfig?: LatencyPiecewiseConfig;
  piecewisePerNode?: boolean;
  onPiecewiseChange?: (
    nextConfig: LatencyPiecewiseConfig,
    nextPerNode: boolean,
  ) => void;
  onSelectWindow?: (next: NetworkTimeWindow) => void;
  onResetWindow?: () => void;
  isCustomWindow?: boolean;
}

function QualityChart({
  data,
  metric,
  title,
  targetMeta,
  window: timeWindow,
  nowSec,
  latencyScale,
  onLatencyScaleChange,
  piecewiseConfig,
  piecewisePerNode = false,
  onPiecewiseChange,
  onSelectWindow,
  onResetWindow,
  isCustomWindow = false,
}: QualityChartProps): React.JSX.Element {
  const id = useId();
  const safeClipId = `${id.replace(/[^a-zA-Z0-9_-]/g, "")}-plot-clip`;
  const [hover, setHover] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [brushPx, setBrushPx] = useState<[number, number] | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startPx: number;
    active: boolean;
  } | null>(null);
  const [width, setWidth] = useState(650);

  const activePiecewiseConfig = piecewiseConfig ?? defaultPiecewiseConfig();
  const effectiveLatencyScale = latencyScale ?? "piecewise";

  useEffect(() => {
    if (effectiveLatencyScale !== "piecewise") {
      setEditorOpen(false);
    }
  }, [effectiveLatencyScale]);

  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.max(220, Math.floor(next)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const prepared = useMemo(() => {
    const series = data.series.map((s, idx) => {
      const { contextPoints, visiblePoints } = slicePointsForWindow(
        s.points,
        timeWindow,
      );
      const runs = qualityPlotRuns(
        contextPoints,
        metric,
        data.resolution_sec,
      ).filter(
        (run) =>
          run.length > 0 &&
          run[run.length - 1]!.ts >= timeWindow.start &&
          run[0]!.ts <= timeWindow.end,
      );
      return {
        ...s,
        color:
          targetMeta.get(s.target_id)?.color ?? getTargetColor(s.target_id, idx),
        label:
          s.points.at(-1)?.target.label ??
          targetMeta.get(s.target_id)?.label ??
          s.target_id,
        times: s.points.map((p) => p.ts),
        visiblePoints,
        visibleTimes: visiblePoints.map((p) => p.ts),
        runs,
      };
    });
    const times = [...new Set(series.flatMap((s) => s.visibleTimes))].sort(
      (a, b) => a - b,
    );
    const axis: LatencyAxisModel =
      metric === "failure_rate_pct"
        ? {
            mode: "linear",
            min: 0,
            max: 100,
            rawPeak: 100,
            outlierCount: 0,
            thresholds: [],
            bands: [
              {
                fromMs: 0,
                toMs: 100,
                startRatio: 0,
                endRatio: 1,
                compressed: false,
                relativeSlope: 1,
              },
            ],
            ticks: [
              { value: 0, isThreshold: false },
              { value: 50, isThreshold: false },
              { value: 100, isThreshold: false },
            ],
            toRatio: (v) => Math.max(0, Math.min(1, v / 100)),
          }
        : computeLatencyAxis(
            series.map((s) =>
              s.visiblePoints.flatMap((p) =>
                p.latency_ms != null && Number.isFinite(p.latency_ms)
                  ? [p.latency_ms]
                  : [],
              ),
            ),
            effectiveLatencyScale,
            activePiecewiseConfig,
          );

    return {
      series,
      times,
      axis,
    };
  }, [
    data,
    metric,
    targetMeta,
    timeWindow,
    effectiveLatencyScale,
    activePiecewiseConfig,
  ]);

  useEffect(() => {
    setHover(null);
    dragRef.current = null;
    setBrushPx(null);
  }, [data.node_id, data.range, timeWindow.start, timeWindow.end]);

  const height = 178;
  const left = 42;
  const right = 9;
  const top = 12;
  const bottom = 31;
  const start = timeWindow.start;
  const end = timeWindow.end;
  const span = Math.max(1, end - start);
  const x = (ts: number) =>
    left + ((ts - start) / span) * (width - left - right);
  const y = (value: number) =>
    top + (1 - prepared.axis.toRatio(value)) * (height - top - bottom);
  const unit = metric === "latency_ms" ? "ms" : "%";
  const selectedTime =
    hover === null
      ? null
      : (prepared.times[Math.min(hover, prepared.times.length - 1)] ?? null);
  const selected: {
    id: NetworkTargetId;
    color: string;
    label: string;
    point: NetworkQualityPoint | null;
  }[] = prepared.series.map((s) => {
    const nearest =
      selectedTime === null || !s.times.length
        ? undefined
        : s.points[nearestIndex(s.times, selectedTime)];
    return {
      id: s.target_id,
      color: s.color,
      label: s.label,
      point:
        nearest &&
        Math.abs(nearest.ts - selectedTime!) <=
          (data.resolution_sec < 300 ? 8 : 0)
          ? nearest
          : null,
    };
  });

  const tooltipOpen = selectedTime !== null;

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const plot = plotRef.current;
    if (!tooltip || !plot || selectedTime === null) return;
    if (!tooltip.matches(":popover-open")) tooltip.showPopover();
    const bounds = tooltip.getBoundingClientRect();
    const rect = plot.getBoundingClientRect();
    const anchorX =
      pointer?.x ?? rect.left + (x(selectedTime) / width) * rect.width;
    const anchorY = pointer?.y ?? rect.top + 24;
    const maxX = Math.max(12, window.innerWidth - bounds.width - 12);
    const maxY = Math.max(12, window.innerHeight - bounds.height - 12);
    const nextX =
      anchorX + 14 <= maxX ? anchorX + 14 : anchorX - bounds.width - 14;
    const nextY =
      anchorY + 14 <= maxY ? anchorY + 14 : anchorY - bounds.height - 14;
    tooltip.style.left = `${Math.max(12, Math.min(maxX, nextX))}px`;
    tooltip.style.top = `${Math.max(12, Math.min(maxY, nextY))}px`;
  }, [selectedTime, pointer, width, data, metric, start, end]);

  useEffect(() => {
    if (!tooltipOpen) return;
    const dismiss = () => setHover(null);
    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !plotRef.current?.contains(event.target)
      ) {
        dismiss();
      }
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [tooltipOpen]);

  const pxToClampedPlotX = (clientX: number, rect: DOMRect): number => {
    const rawPx = ((clientX - rect.left) / Math.max(1, rect.width)) * width;
    return Math.max(left, Math.min(width - right, rawPx));
  };

  const pxToTimestamp = (px: number): number => {
    const plotWidth = Math.max(1, width - left - right);
    const ratio = Math.max(0, Math.min(1, (px - left) / plotWidth));
    return start + ratio * span;
  };

  const selectAt = (clientX: number, clientY: number, rect: DOMRect) => {
    if (!prepared.times.length) return;
    const px = pxToClampedPlotX(clientX, rect);
    const ts = pxToTimestamp(px);
    setPointer({ x: clientX, y: clientY });
    setHover(nearestIndex(prepared.times, ts));
  };

  const visibleTickLabels = useMemo(() => {
    const ticks = prepared.axis.ticks;
    const priorityOrder = [
      ...ticks.filter(
        (t) => t.value === prepared.axis.min || t.value === prepared.axis.max,
      ),
      ...ticks.filter(
        (t) =>
          t.isThreshold &&
          t.value !== prepared.axis.min &&
          t.value !== prepared.axis.max,
      ),
      ...ticks.filter(
        (t) =>
          !t.isThreshold &&
          t.value !== prepared.axis.min &&
          t.value !== prepared.axis.max,
      ),
    ];
    const acceptedYs: number[] = [];
    const shown = new Set<number>();
    for (const tick of priorityOrder) {
      const py =
        top +
        (1 - prepared.axis.toRatio(tick.value)) * (height - top - bottom);
      if (acceptedYs.every((existing) => Math.abs(existing - py) >= 11)) {
        acceptedYs.push(py);
        shown.add(tick.value);
      }
    }
    return shown;
  }, [prepared.axis, height, top, bottom]);

  const accessibleValue =
    selectedTime === null
      ? "使用左右方向键查看测量"
      : `${formatTooltipTime(selectedTime, data.resolution_sec < 300)}，${selected
          .map(
            (s) =>
              `${s.point?.target.label ?? s.label} ${formatQualityValue(s.point?.[metric], unit)}`,
          )
          .join("，")}`;

  return (
    <div className="min-w-0 rounded-[9px] border border-[var(--border-hairline)] bg-[var(--bg-card)] p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id={id} className="text-[12px] font-medium">
            {title}{" "}
            <span className="font-normal text-[var(--text-tertiary)]">{unit}</span>
          </h4>
          {metric === "latency_ms" &&
            effectiveLatencyScale === "piecewise" &&
            onPiecewiseChange && (
              <button
                type="button"
                aria-expanded={editorOpen}
                onClick={() => setEditorOpen((open) => !open)}
                title="点击配置分段折点与各段缩放比例"
                style={
                  !activePiecewiseConfig.auto
                    ? {
                        backgroundColor: "var(--accent-soft)",
                        color: "var(--accent-ink)",
                        border: "1px solid var(--accent-border)",
                      }
                    : prepared.axis.bands.length > 1
                      ? {
                          backgroundColor: "var(--status-warn-bg)",
                          color: "var(--status-warn-ink)",
                          border: "1px solid var(--status-warn-border)",
                        }
                      : {
                          backgroundColor: "var(--bg-subtle)",
                          color: "var(--text-secondary)",
                          border: "1px solid var(--border-subtle)",
                        }
                }
                className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] font-medium transition-opacity hover:opacity-85"
              >
                <SlidersHorizontal aria-hidden="true" className="h-3 w-3 shrink-0" />
                {!activePiecewiseConfig.auto ? (
                  <span>
                    折点 {prepared.axis.thresholds.join(" / ")} ms
                  </span>
                ) : prepared.axis.bands.length > 1 ? (
                  <span>
                    折点 &gt;{prepared.axis.thresholds[0]}ms 已压缩 (
                    {prepared.axis.outlierCount} 尖峰 · 最高{" "}
                    {formatQualityValue(prepared.axis.rawPeak, " ms")})
                  </span>
                ) : (
                  <span>折点设置</span>
                )}
              </button>
            )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <div className="flex flex-wrap gap-3">
            {prepared.series.map((s) => (
              <span
                key={s.target_id}
                style={{ color: s.color }}
                className="inline-flex items-center gap-1"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-3"
                  style={{ backgroundColor: s.color }}
                />
                {s.label}
              </span>
            ))}
          </div>
          {metric === "latency_ms" && onLatencyScaleChange && (
            <SegmentedControl<LatencyScaleMode>
              size="xs"
              ariaLabel="TCP 延迟纵轴刻度"
              value={effectiveLatencyScale}
              onChange={onLatencyScaleChange}
              options={[
                { value: "piecewise", label: "分段" },
                { value: "linear", label: "全量" },
                { value: "log", label: "对数" },
              ]}
            />
          )}
        </div>
      </div>

      {metric === "latency_ms" &&
        effectiveLatencyScale === "piecewise" &&
        editorOpen &&
        onPiecewiseChange && (
          <PiecewiseScaleEditor
            config={activePiecewiseConfig}
            perNode={piecewisePerNode}
            axis={prepared.axis}
            onChange={onPiecewiseChange}
          />
        )}

      <div
        ref={plotRef}
        role="slider"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, prepared.times.length - 1)}
        aria-valuenow={hover ?? Math.max(0, prepared.times.length - 1)}
        aria-valuetext={accessibleValue}
        aria-describedby={tooltipOpen ? `${id}-tooltip` : undefined}
        tabIndex={0}
        className={`min-w-0 touch-pan-y select-none rounded focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
          onSelectWindow && prepared.times.length > 0 ? "cursor-crosshair" : ""
        }`}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) {
            const px = pxToClampedPlotX(event.clientX, rect);
            if (!drag.active && Math.abs(event.clientX - drag.startClientX) >= 6) {
              drag.active = true;
              try {
                event.currentTarget.setPointerCapture?.(event.pointerId);
              } catch {
                // ignore if pointer capture is unavailable
              }
              setHover(null);
            }
            if (drag.active) {
              setBrushPx([
                Math.min(drag.startPx, px),
                Math.max(drag.startPx, px),
              ]);
              return;
            }
          }
          selectAt(event.clientX, event.clientY, rect);
        }}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (onSelectWindow && event.button === 0 && prepared.times.length > 0) {
            dragRef.current = {
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startPx: pxToClampedPlotX(event.clientX, rect),
              active: false,
            };
          }
          selectAt(event.clientX, event.clientY, rect);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const px = pxToClampedPlotX(event.clientX, rect);
          const wasActive = drag.active;
          const minPx = Math.min(drag.startPx, px);
          const maxPx = Math.max(drag.startPx, px);
          dragRef.current = null;
          setBrushPx(null);
          try {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          } catch {
            // ignore
          }
          if (wasActive && maxPx - minPx >= 8 && onSelectWindow) {
            const t1 = pxToTimestamp(minPx);
            const t2 = pxToTimestamp(maxPx);
            onSelectWindow(
              clampNetworkTimeWindow(
                { start: t1, end: t2 },
                nowSec,
                data.resolution_sec,
              ),
            );
          }
        }}
        onPointerLeave={(event) => {
          if (dragRef.current?.active) return;
          dragRef.current = null;
          if (event.pointerType !== "touch") setHover(null);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setBrushPx(null);
          setHover(null);
        }}
        onDoubleClick={() => {
          if (isCustomWindow) {
            onResetWindow?.();
          }
        }}
        onFocus={(event) => {
          if (
            prepared.times.length &&
            event.currentTarget.matches(":focus-visible")
          ) {
            setPointer(null);
            setHover(prepared.times.length - 1);
          }
        }}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (dragRef.current || brushPx || tooltipOpen) {
              event.preventDefault();
              event.stopPropagation();
              dragRef.current = null;
              setBrushPx(null);
              setHover(null);
            }
            return;
          }
          if (
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
            !prepared.times.length
          ) {
            return;
          }
          event.preventDefault();
          setPointer(null);
          setHover((index) =>
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? prepared.times.length - 1
                : Math.max(
                    0,
                    Math.min(
                      prepared.times.length - 1,
                      (index ?? prepared.times.length - 1) +
                        (event.key === "ArrowLeft" ? -1 : 1),
                    ),
                  ),
          );
        }}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block w-full"
          aria-hidden="true"
        >
          <defs>
            <clipPath id={safeClipId}>
              <rect
                x={left}
                y={top - 5}
                width={Math.max(0, width - left - right)}
                height={height - top - bottom + 9}
              />
            </clipPath>
          </defs>
          <g clipPath={`url(#${safeClipId})`}>
            {prepared.axis.bands.map((band, idx) => {
              if (!band.compressed) return null;
              const yTop = y(band.toMs);
              const yBottom = y(band.fromMs);
              const bandH = Math.max(0, yBottom - yTop);
              const slopeLabel =
                band.relativeSlope < 0.1
                  ? band.relativeSlope.toFixed(2)
                  : band.relativeSlope.toFixed(1);
              return (
                <g key={`compressed-band-${idx}`}>
                  <rect
                    x={left}
                    y={yTop}
                    width={Math.max(0, width - left - right)}
                    height={bandH}
                    fill="var(--status-warn-bg)"
                    opacity="0.45"
                  />
                  {bandH >= 16 && (
                    <text
                      x={width - right - 4}
                      y={yTop + 11}
                      textAnchor="end"
                      fill="var(--text-tertiary)"
                      fontSize="9.5"
                    >
                      压缩 {slopeLabel}×
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          {prepared.axis.ticks.map((tick, idx) => {
            const py = y(tick.value);
            const showLabel = visibleTickLabels.has(tick.value);
            return (
              <g key={`${idx}-${tick.value}`}>
                <line
                  x1={left}
                  x2={width - right}
                  y1={py}
                  y2={py}
                  stroke={
                    tick.isThreshold
                      ? "var(--status-warn-border)"
                      : "var(--border-hairline)"
                  }
                  strokeWidth={tick.isThreshold ? 1 : undefined}
                  strokeDasharray={tick.isThreshold ? "4 3" : "3 4"}
                />
                {showLabel && (
                  <text
                    x={left - 7}
                    y={py + 3}
                    textAnchor="end"
                    fill={
                      tick.isThreshold
                        ? "var(--status-warn-ink)"
                        : "var(--text-tertiary)"
                    }
                    fontWeight={tick.isThreshold ? 600 : undefined}
                    fontSize="10"
                  >
                    {Math.round(tick.value)}
                  </text>
                )}
              </g>
            );
          })}
          <g clipPath={`url(#${safeClipId})`}>
            {prepared.series.map((s) => (
              <g
                key={s.target_id}
                fill="none"
                stroke={s.color}
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {s.runs.map((run, i) => {
                  if (run.length === 1) {
                    return (
                      <circle
                        key={i}
                        cx={x(run[0]!.ts)}
                        cy={y(run[0]!.value)}
                        r="2"
                        fill={s.color}
                        stroke="none"
                      />
                    );
                  }
                  const pathPoints =
                    prepared.axis.thresholds.length > 0
                      ? subdivideRunAtThresholds(run, prepared.axis.thresholds)
                      : run;
                  return (
                    <path
                      key={i}
                      d={pathPoints
                        .map(
                          (p, j) =>
                            `${j ? "L" : "M"}${x(p.ts).toFixed(2)},${y(p.value).toFixed(2)}`,
                        )
                        .join(" ")}
                    />
                  );
                })}
              </g>
            ))}
            {brushPx && (
              <rect
                x={brushPx[0]}
                y={top}
                width={Math.max(1, brushPx[1] - brushPx[0])}
                height={height - top - bottom}
                fill="var(--accent-soft)"
                stroke="var(--accent)"
                strokeWidth="1"
              />
            )}
          </g>
          {selectedTime !== null && (
            <line
              x1={x(selectedTime)}
              x2={x(selectedTime)}
              y1={top}
              y2={height - bottom}
              stroke="var(--text-muted)"
              strokeDasharray="3 3"
            />
          )}
          {[start, (start + end) / 2, end].map((ts, i) => (
            <text
              key={i}
              x={x(ts)}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              fill="var(--text-tertiary)"
              fontSize="10"
            >
              {formatChartAxisTick(
                ts,
                timeWindow,
                nowSec,
                data.resolution_sec,
              )}
            </text>
          ))}
          {!prepared.times.length && (
            <text
              x={width / 2}
              y={height / 2}
              textAnchor="middle"
              fill="var(--text-tertiary)"
              fontSize="12"
            >
              此范围内暂无测量
            </text>
          )}
        </svg>
      </div>

      {selectedTime !== null && (
        <div
          ref={tooltipRef}
          id={`${id}-tooltip`}
          role="tooltip"
          popover="manual"
          aria-live="polite"
          className="pointer-events-none fixed inset-auto m-0 w-[320px] max-w-[calc(100vw-24px)] space-y-1.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-sheet)] p-3 text-[11px] text-[var(--text-primary)] shadow-[var(--shadow-popover)]"
        >
          <div className="font-mono-num text-[var(--text-secondary)]">
            {formatTooltipTime(selectedTime, data.resolution_sec < 300)}
          </div>
          {selected.map(({ id: targetId, color, label, point }) => (
            <div key={targetId} className="flex flex-wrap gap-x-2 gap-y-0.5">
              <span style={{ color }} className="font-medium">
                {point?.target.label ?? label}
              </span>
              <span className="font-mono-num">
                {formatQualityValue(point?.[metric], unit)}
              </span>
              {point ? (
                <span className="text-[var(--text-secondary)]">
                  {[
                    point.target.region?.trim() || null,
                    point.result ? NETWORK_RESULTS[point.result] : "5 分钟统计",
                    `${point.failures}/${point.attempts} 次失败`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : (
                <span className="text-[var(--text-tertiary)]">缺测</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function targetGridClass(count: number): string {
  if (count <= 1) return "grid grid-cols-1 gap-2";
  if (count === 2 || count === 4) return "grid grid-cols-1 gap-2 sm:grid-cols-2";
  return "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3";
}

export function NetworkQualityPanel({
  node,
  chartMode,
  active,
  live,
  refreshKey = 0,
}: {
  node: HorizonNode;
  chartMode: "live" | MetricsRange;
  active: boolean;
  live: boolean;
  refreshKey?: number;
}): React.JSX.Element {
  const visible = usePageVisible();
  const [span, setSpan] = useState<NetworkDisplaySpan | "1y">(() =>
    chartModeToNetworkSpan(chartMode),
  );
  const [customWindow, setCustomWindow] = useState<NetworkTimeWindow | null>(
    null,
  );
  const [latencyScale, setLatencyScale] = useState<LatencyScaleMode>(() => {
    try {
      return parseLatencyScaleMode(
        localStorage.getItem(LATENCY_SCALE_STORAGE_KEY),
      );
    } catch {
      return "piecewise";
    }
  });
  const [piecewisePref, setPiecewisePref] = useState<{
    nodeId: string;
    config: LatencyPiecewiseConfig;
    perNode: boolean;
  }>(() => ({ nodeId: node.id, ...loadPiecewisePref(node.id) }));
  const [cacheEntry, setCacheEntry] = useState<{
    nodeId: string;
    byRange: Partial<
      Record<NetworkQualityRange, { query: NetworkQualityQuery; gen: string }>
    >;
  }>(() => ({ nodeId: node.id, byRange: {} }));
  const [configEntry, setConfigEntry] = useState<{
    nodeId: string;
    response: NetworkQualityConfigResponse;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [clock, setClock] = useState(() => Date.now() / 1000);
  const refreshHistory = useRef<() => void>(() => {});
  const measurementKey = networkMeasurementKey(node.metrics?.network_quality);
  const currentMeasurementKey = useRef(measurementKey);
  currentMeasurementKey.current = measurementKey;
  const running = active && visible;
  const config = configEntry?.nodeId === node.id ? configEntry.response : null;

  const currentGen = `${node.id}:${refreshKey}:${retry}`;
  const { activeByRange, cachedFreshRanges, latestServerTime } = useMemo(() => {
    const raw = cacheEntry.nodeId === node.id ? cacheEntry.byRange : {};
    const byRange: Partial<Record<NetworkQualityRange, NetworkQualityQuery>> = {};
    const fresh = new Set<NetworkQualityRange>();
    let maxServerTime = 0;
    for (const r of ["1h", "24h", "7d", "30d"] as const) {
      const item = raw[r];
      if (item) {
        byRange[r] = item.query;
        maxServerTime = Math.max(maxServerTime, item.query.server_time);
        if (item.gen === currentGen) {
          fresh.add(r);
        }
      }
    }
    return {
      activeByRange: byRange,
      cachedFreshRanges: fresh,
      latestServerTime: maxServerTime,
    };
  }, [cacheEntry, node.id, currentGen]);

  const anchorNow = latestServerTime > 0 ? latestServerTime : Math.floor(clock);

  const fetchRange = useMemo<NetworkQualityRange | null>(() => {
    if (span === "1y") return null;
    const candidate = resolveNetworkFetchRange(
      span,
      customWindow,
      anchorNow,
      cachedFreshRanges,
    );
    if (customWindow !== null) {
      if (
        candidate === "1h" &&
        cachedFreshRanges.has("24h") &&
        activeByRange["24h"] &&
        customWindow.start >= activeByRange["24h"].server_time - 86400 &&
        (!activeByRange["1h"] ||
          !cachedFreshRanges.has("1h") ||
          activeByRange["1h"].server_time < customWindow.end)
      ) {
        return "24h";
      }
      if (
        candidate === "7d" &&
        cachedFreshRanges.has("30d") &&
        activeByRange["30d"] &&
        customWindow.start >= activeByRange["30d"].server_time - 2592000 &&
        (!activeByRange["7d"] ||
          !cachedFreshRanges.has("7d") ||
          activeByRange["7d"].server_time < customWindow.end)
      ) {
        return "30d";
      }
    }
    return candidate;
  }, [span, customWindow, anchorNow, cachedFreshRanges, activeByRange]);

  const current = fetchRange ? (activeByRange[fetchRange] ?? null) : null;
  const isCustomWindow = customWindow !== null;
  const cachedFreshRangesRef = useRef(cachedFreshRanges);
  cachedFreshRangesRef.current = cachedFreshRanges;

  const handleLatencyScaleChange = (next: LatencyScaleMode) => {
    setLatencyScale(next);
    try {
      localStorage.setItem(LATENCY_SCALE_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  };

  const activePiecewise =
    piecewisePref.nodeId === node.id
      ? piecewisePref
      : { nodeId: node.id, ...loadPiecewisePref(node.id) };

  const handlePiecewiseChange = (
    nextConfig: LatencyPiecewiseConfig,
    nextPerNode: boolean,
  ) => {
    const normalized = normalizePiecewiseConfig(nextConfig);
    setPiecewisePref({
      nodeId: node.id,
      config: normalized,
      perNode: nextPerNode,
    });
    try {
      if (nextPerNode) {
        localStorage.setItem(
          `${PIECEWISE_NODE_STORAGE_PREFIX}${node.id}`,
          JSON.stringify(normalized),
        );
      } else {
        localStorage.removeItem(`${PIECEWISE_NODE_STORAGE_PREFIX}${node.id}`);
        localStorage.setItem(
          PIECEWISE_GLOBAL_STORAGE_KEY,
          JSON.stringify(normalized),
        );
      }
    } catch {
      // ignore storage errors
    }
  };

  useEffect(() => {
    setPiecewisePref({ nodeId: node.id, ...loadPiecewisePref(node.id) });
  }, [node.id]);

  useEffect(() => {
    setSettingsOpen(false);
  }, [node.id]);

  useEffect(() => {
    setSpan(chartModeToNetworkSpan(chartMode));
    setCustomWindow(null);
  }, [node.id, chartMode]);

  useEffect(() => {
    if (!running) return;
    setClock(Date.now() / 1000);
    const timer = window.setInterval(() => setClock(Date.now() / 1000), 15000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const abort = new AbortController();
    setConfigError(null);
    void api
      .getNodeNetworkQualityConfig(node.id, abort.signal)
      .then((response) => {
        if (!abort.signal.aborted) setConfigEntry({ nodeId: node.id, response });
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          setConfigError(err instanceof Error ? err.message : "配置加载失败");
        }
      });
    return () => abort.abort();
  }, [node.id, running, retry]);

  const probeEnabled = Boolean(config?.effective_config.enabled);
  const probeSupported = config?.supported !== false;
  const intervalSec = normalizeIntervalSec(config?.effective_config.interval_sec);

  useEffect(() => {
    if (
      !running ||
      !config ||
      !probeEnabled ||
      !probeSupported ||
      fetchRange === null
    ) {
      setLoading(false);
      if (config && !probeEnabled) {
        setCacheEntry({ nodeId: node.id, byRange: {} });
        setHistoryError(null);
      }
      return;
    }

    if (isCustomWindow && cachedFreshRangesRef.current.has(fetchRange)) {
      setLoading(false);
      setHistoryError(null);
      refreshHistory.current = () => {};
      return;
    }

    const abort = new AbortController();
    let timer: number | undefined;
    let lastStarted = 0;
    let fetchedKey = "";
    let inFlight = false;
    let pending = false;

    const start = () => {
      if (abort.signal.aborted) return;
      timer = undefined;
      lastStarted = Date.now();
      fetchedKey = currentMeasurementKey.current;
      inFlight = true;
      setLoading(true);
      setHistoryError(null);
      void loadNetworkHistory(
        (cursor) =>
          api.getNodeNetworkQuality(node.id, fetchRange, cursor, abort.signal),
        abort.signal,
      )
        .then((result) => {
          if (!abort.signal.aborted) {
            setCacheEntry((prev) => ({
              nodeId: node.id,
              byRange: {
                ...(prev.nodeId === node.id ? prev.byRange : {}),
                [fetchRange]: { query: result, gen: currentGen },
              },
            }));
          }
        })
        .catch((err) => {
          if (!abort.signal.aborted) {
            setHistoryError(
              err instanceof Error ? err.message : "网络历史加载失败",
            );
          }
        })
        .finally(() => {
          inFlight = false;
          if (abort.signal.aborted) return;
          setLoading(false);
          if (pending) {
            pending = false;
            requestRefresh();
          }
        });
    };

    const requestRefresh = () => {
      if (
        abort.signal.aborted ||
        isCustomWindow ||
        currentMeasurementKey.current === fetchedKey
      ) {
        return;
      }
      if (inFlight) {
        pending = true;
        return;
      }
      if (timer === undefined) {
        timer = window.setTimeout(
          start,
          Math.max(
            0,
            Math.max(10000, intervalSec * 1000) - (Date.now() - lastStarted),
          ),
        );
      }
    };

    refreshHistory.current = isCustomWindow ? () => {} : requestRefresh;
    start();
    return () => {
      window.clearTimeout(timer);
      abort.abort();
      refreshHistory.current = () => {};
    };
  }, [
    node.id,
    fetchRange,
    isCustomWindow,
    running,
    config,
    probeEnabled,
    probeSupported,
    intervalSec,
    refreshKey,
    retry,
    currentGen,
  ]);

  useEffect(() => {
    if (running && probeEnabled && probeSupported && !isCustomWindow) {
      refreshHistory.current();
    }
  }, [measurementKey, running, probeEnabled, probeSupported, isCustomWindow]);

  const effectiveWindow = useMemo<NetworkTimeWindow | null>(() => {
    if (!current || span === "1y") return null;
    if (customWindow === null) {
      return {
        start: current.server_time - NETWORK_SPAN_SECONDS[span],
        end: current.server_time,
      };
    }
    return clampNetworkTimeWindow(
      customWindow,
      current.server_time,
      current.resolution_sec,
    );
  }, [current, span, customWindow]);

  const displayWindow = effectiveWindow ?? customWindow;

  const canPanEarlier =
    span !== "1y" &&
    current !== null &&
    effectiveWindow !== null &&
    effectiveWindow.start > current.server_time - MAX_NETWORK_RETENTION_SEC + 5;

  const canPanLater =
    span !== "1y" && current !== null && customWindow !== null;

  const handlePan = (direction: -1 | 1) => {
    if (!current || !effectiveWindow || span === "1y") return;
    const next = panNetworkTimeWindow(
      effectiveWindow,
      direction,
      current.server_time,
      current.resolution_sec,
      NETWORK_SPAN_SECONDS[span],
    );
    setCustomWindow(next);
  };

  const streamState = node.metrics?.network_quality;
  const queryState = current?.state;
  const streamTime = Math.max(
    0,
    ...(streamState?.latest.map((p) => p.measured_at) ?? []),
  );
  const queryTime = Math.max(
    0,
    ...(queryState?.latest.map((p) => p.measured_at) ?? []),
  );
  const state =
    streamState &&
    (streamTime >= queryTime ||
      (streamState.applied_config_id === config?.config_id &&
        queryState?.applied_config_id !== config.config_id))
      ? streamState
      : (queryState ?? streamState);

  const status = networkStatus(state, config, node.online, clock, live);
  const targets: NetworkTarget[] = useMemo(() => {
    if (config?.effective_config.targets?.length) {
      return config.effective_config.targets;
    }
    if (state?.latest?.length) {
      return state.latest.map((item) => item.target);
    }
    return [];
  }, [config, state]);

  const targetMeta = useMemo(() => {
    const map = new Map<NetworkTargetId, { label: string; color: string }>();
    targets.forEach((t, idx) => {
      map.set(t.id, {
        label: t.label,
        color: getTargetColor(t.id, idx),
      });
    });
    return map;
  }, [targets]);

  const staleAfter = live
    ? Math.max(60, intervalSec * 3)
    : Math.max(390, 330 + intervalSec * 3);

  return (
    <Card className="min-w-0 space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold">TCP 延迟监控</h3>
          <Badge tone={status.tone}>{status.label}</Badge>
          {probeEnabled && (
            <span className="text-[11px] text-[var(--text-tertiary)]">
              每 {intervalSec} 秒测量
            </span>
          )}
        </div>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
          icon={<Settings2 aria-hidden="true" className="h-3.5 w-3.5" />}
        >
          配置
        </Button>
      </div>

      {settingsOpen && (
        <div className="border-t border-[var(--border-hairline)] pt-4">
          <NetworkQualitySettings
            key={node.id}
            nodeId={node.id}
            active={running}
            state={state}
            onSaved={(response) => {
              setConfigEntry({ nodeId: node.id, response });
              setRetry((n) => n + 1);
            }}
          />
        </div>
      )}

      {!config && !configError ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 py-6 text-[12px] text-[var(--text-secondary)]"
        >
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          正在读取探测配置…
        </div>
      ) : config && !probeSupported ? (
        <div className="py-5 text-center text-[12px] text-[var(--text-secondary)]">
          当前节点 Agent 暂不支持 TCP 延迟探测
        </div>
      ) : config && !probeEnabled ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-[12.5px] font-medium text-[var(--text-secondary)]">
            TCP 延迟探测未启用
          </p>
          <p className="text-[11.5px] text-[var(--text-tertiary)]">
            可在节点「配置」或「节点管理 → 网络检测」中开启目标探测与采样周期
          </p>
        </div>
      ) : (
        <>
          {targets.length > 0 && (
            <div className={targetGridClass(targets.length)}>
              {targets.map((target, idx) => {
                const latest = state?.latest.find(
                  (p) =>
                    p.target_id === target.id &&
                    (!("target_revision" in target) ||
                      p.target_revision === target.target_revision),
                );
                const outdated =
                  latest && (!node.online || clock - latest.measured_at > staleAfter);
                const targetStatus = !target.enabled
                  ? "目标已停用"
                  : !latest
                    ? "等待样本"
                    : outdated
                      ? "数据过期"
                      : NETWORK_RESULTS[latest.result];
                const color = getTargetColor(target.id, idx);

                return (
                  <details
                    key={target.id}
                    className="min-w-0 rounded-[8px] border border-[var(--border-hairline)] px-3 py-2"
                  >
                    <summary className="cursor-pointer list-none space-y-1.5 focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
                      <div className="flex flex-wrap items-center justify-between gap-1 text-[12px]">
                        <span style={{ color }} className="truncate font-medium">
                          {target.label}
                        </span>
                        {target.region?.trim() && (
                          <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                            {target.region}
                          </span>
                        )}
                      </div>
                      <div className="font-mono-num flex flex-wrap items-baseline justify-between gap-1 text-[14px] font-medium">
                        <span>
                          {formatQualityValue(latest?.latency_median_ms, " ms")}
                        </span>
                        <span className="text-[12px]">
                          {formatQualityValue(latest?.failure_rate_pct, "%")}
                        </span>
                      </div>
                      <div
                        className={`text-[10px] ${
                          latest &&
                          latest.result !== "ok" &&
                          target.enabled &&
                          !outdated
                            ? "text-[var(--status-danger-ink)]"
                            : "text-[var(--text-tertiary)]"
                        }`}
                      >
                        {targetStatus}
                      </div>
                    </summary>
                    <div className="mt-2 space-y-1 border-t border-[var(--border-hairline)] pt-2 text-[11px] text-[var(--text-secondary)]">
                      {latest && (
                        <>
                          <p>最后测量 {formatTooltipTime(latest.measured_at, true)}</p>
                          <p>
                            最近统计：{latest.attempts} 次，失败 {latest.failures}{" "}
                            次；延迟为成功样本中位数。
                          </p>
                        </>
                      )}
                      <p className="break-all">
                        {latest?.target.host ?? target.host}:
                        {latest?.target.port ?? target.port}
                      </p>
                      <p>IPv4 {latest?.remote_ip ?? "—"}</p>
                    </div>
                  </details>
                );
              })}
            </div>
          )}

          {state?.config_error && (
            <p
              role="alert"
              className="break-all text-[12px] text-[var(--status-danger-ink)]"
            >
              {state.config_error}
            </p>
          )}
          {state && state.dropped_samples > 0 && (
            <p className="text-[11px] text-[var(--text-tertiary)]">
              探针缓存已丢弃 {state.dropped_samples} 个样本
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="thin-scrollbar max-w-full overflow-x-auto">
              <SegmentedControl<NetworkDisplaySpan | "__custom__">
                size="xs"
                ariaLabel="网络延迟显示时间跨度"
                value={
                  customWindow === null && span !== "1y" ? span : "__custom__"
                }
                onChange={(next) => {
                  if (next !== "__custom__") {
                    setSpan(next);
                    setCustomWindow(null);
                  }
                }}
                options={[...NETWORK_DISPLAY_SPAN_OPTIONS]}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {customWindow !== null && displayWindow ? (
                <>
                  <span className="font-mono-num rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                    {formatWindowSummary(displayWindow, anchorNow)}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={
                      !current ||
                      displayWindow.end - displayWindow.start >=
                        MAX_NETWORK_RETENTION_SEC
                    }
                    onClick={() => {
                      if (!current) return;
                      setCustomWindow(
                        zoomOutNetworkTimeWindow(
                          displayWindow,
                          current.server_time,
                          current.resolution_sec,
                        ),
                      );
                    }}
                    icon={<ZoomOut aria-hidden="true" className="h-3 w-3" />}
                  >
                    缩小
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setCustomWindow(null)}
                    icon={<RotateCcw aria-hidden="true" className="h-3 w-3" />}
                  >
                    回到最新
                  </Button>
                </>
              ) : span !== "1y" ? (
                <span className="hidden text-[11px] text-[var(--text-tertiary)] sm:inline">
                  拖拽图表可框选放大
                </span>
              ) : null}

              {span !== "1y" && (
                <div
                  role="group"
                  aria-label="平移显示时间段"
                  className="inline-flex items-center gap-0.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-muted)] p-0.5"
                >
                  <button
                    type="button"
                    aria-label="查看更早时间段"
                    title="查看更早时间段"
                    disabled={!canPanEarlier}
                    onClick={() => handlePan(-1)}
                    className="inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sheet)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="查看更晚时间段"
                    title="查看更晚时间段"
                    disabled={!canPanLater}
                    onClick={() => handlePan(1)}
                    className="inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sheet)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {span === "1y" ? (
            <div className="flex flex-col items-center gap-2.5 py-5 text-center">
              <p className="text-[12px] text-[var(--text-secondary)]">
                网络质量历史保留 30 天
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    setSpan("30d");
                    setCustomWindow(null);
                  }}
                >
                  查看最近 30 天
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setSpan("1h");
                    setCustomWindow(null);
                  }}
                >
                  查看最近 1 小时
                </Button>
              </div>
            </div>
          ) : (
            <>
              {loading && !current && (
                <div
                  role="status"
                  className="flex items-center justify-center gap-2 py-8 text-[12px] text-[var(--text-secondary)]"
                >
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                  加载网络历史…
                </div>
              )}
              {current && effectiveWindow && (
                <div className="space-y-3" aria-busy={loading}>
                  <QualityChart
                    data={current}
                    metric="latency_ms"
                    title={
                      current.resolution_sec === 300 ? "TCP 平均延迟" : "TCP 延迟"
                    }
                    targetMeta={targetMeta}
                    window={effectiveWindow}
                    nowSec={current.server_time}
                    latencyScale={latencyScale}
                    onLatencyScaleChange={handleLatencyScaleChange}
                    piecewiseConfig={activePiecewise.config}
                    piecewisePerNode={activePiecewise.perNode}
                    onPiecewiseChange={handlePiecewiseChange}
                    onSelectWindow={(next) => setCustomWindow(next)}
                    onResetWindow={() => setCustomWindow(null)}
                    isCustomWindow={isCustomWindow}
                  />
                  <QualityChart
                    data={current}
                    metric="failure_rate_pct"
                    title="探测失败率"
                    targetMeta={targetMeta}
                    window={effectiveWindow}
                    nowSec={current.server_time}
                    onSelectWindow={(next) => setCustomWindow(next)}
                    onResetWindow={() => setCustomWindow(null)}
                    isCustomWindow={isCustomWindow}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}

      {(historyError || configError) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-[12px] text-[var(--status-danger-ink)]"
        >
          <span>
            {historyError ?? configError}
            {historyError && current ? "（保留上次加载的历史）" : ""}
          </span>
          <Button size="xs" disabled={loading} onClick={() => setRetry((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
    </Card>
  );
}
