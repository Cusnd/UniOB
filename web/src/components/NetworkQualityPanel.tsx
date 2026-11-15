import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2, Settings2 } from "lucide-react";
import { api } from "../api/client";
import { usePageVisible } from "../hooks/usePageVisible";
import type { HorizonNode, MetricsRange } from "../types";
import type {
  NetworkQualityConfigResponse,
  NetworkQualityPoint,
  NetworkQualityQuery,
  NetworkQualityRange,
  NetworkTarget,
  NetworkTargetId,
} from "../types/network-quality";
import {
  formatQualityValue,
  getTargetColor,
  loadNetworkHistory,
  NETWORK_RESULTS,
  networkMeasurementKey,
  networkStatus,
  normalizeIntervalSec,
  qualityPlotRuns,
} from "../utils/networkQuality";
import { Badge, Button, Card } from "./ui/Primitives";
import { NetworkQualitySettings } from "./NetworkQualitySettings";

const RANGE_SECONDS: Record<NetworkQualityRange, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};

const timeLabel = (ts: number, long: boolean) =>
  new Date(ts * 1000).toLocaleString(
    "zh-CN",
    long
      ? {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  );

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

interface QualityChartProps {
  data: NetworkQualityQuery;
  metric: "latency_ms" | "failure_rate_pct";
  title: string;
  targetMeta: Map<NetworkTargetId, { label: string; color: string }>;
}

function QualityChart({
  data,
  metric,
  title,
  targetMeta,
}: QualityChartProps): React.JSX.Element {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(650);

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
    const series = data.series.map((s, idx) => ({
      ...s,
      color: targetMeta.get(s.target_id)?.color ?? getTargetColor(s.target_id, idx),
      label:
        s.points.at(-1)?.target.label ??
        targetMeta.get(s.target_id)?.label ??
        s.target_id,
      times: s.points.map((p) => p.ts),
      runs: qualityPlotRuns(s.points, metric, data.resolution_sec),
    }));
    const times = [...new Set(series.flatMap((s) => s.times))].sort(
      (a, b) => a - b,
    );
    let peak = 1;
    for (const s of series) {
      for (const p of s.points) {
        if (p[metric] != null) peak = Math.max(peak, p[metric]!);
      }
    }
    return {
      series,
      times,
      max: metric === "failure_rate_pct" ? 100 : Math.ceil(peak * 1.1),
    };
  }, [data, metric, targetMeta]);

  useEffect(() => setHover(null), [data.node_id, data.range]);

  const height = 178;
  const left = 42;
  const right = 9;
  const top = 12;
  const bottom = 31;
  const start = data.server_time - RANGE_SECONDS[data.range];
  const end = data.server_time;
  const x = (ts: number) =>
    left + ((ts - start) / (end - start)) * (width - left - right);
  const y = (value: number) =>
    top + (1 - value / prepared.max) * (height - top - bottom);
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
  }, [selectedTime, pointer, width, data, metric]);

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

  const selectAt = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!prepared.times.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const ts =
      start +
      Math.max(0, Math.min(1, (px - left) / (width - left - right))) *
        (end - start);
    setPointer({ x: event.clientX, y: event.clientY });
    setHover(nearestIndex(prepared.times, ts));
  };

  const accessibleValue =
    selectedTime === null
      ? "使用左右方向键查看测量"
      : `${timeLabel(selectedTime, true)}，${selected
          .map(
            (s) =>
              `${s.point?.target.label ?? s.label} ${formatQualityValue(s.point?.[metric], unit)}`,
          )
          .join("，")}`;

  return (
    <div className="min-w-0 rounded-[9px] border border-[var(--border-hairline)] bg-[var(--bg-card)] p-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h4 id={id} className="text-[12px] font-medium">
          {title}{" "}
          <span className="font-normal text-[var(--text-tertiary)]">{unit}</span>
        </h4>
        <div className="flex flex-wrap gap-3 text-[11px]">
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
      </div>

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
        className="min-w-0 rounded focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onPointerMove={selectAt}
        onPointerDown={selectAt}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") setHover(null);
        }}
        onPointerCancel={() => setHover(null)}
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
          if (event.key === "Escape" && tooltipOpen) {
            event.preventDefault();
            event.stopPropagation();
            setHover(null);
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
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line
                x1={left}
                x2={width - right}
                y1={y(prepared.max * fraction)}
                y2={y(prepared.max * fraction)}
                stroke="var(--border-hairline)"
                strokeDasharray="3 4"
              />
              <text
                x={left - 7}
                y={y(prepared.max * fraction) + 3}
                textAnchor="end"
                fill="var(--text-tertiary)"
                fontSize="10"
              >
                {Math.round(prepared.max * fraction)}
              </text>
            </g>
          ))}
          {prepared.series.map((s) => (
            <g
              key={s.target_id}
              fill="none"
              stroke={s.color}
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {s.runs.map((run, i) =>
                run.length === 1 ? (
                  <circle
                    key={i}
                    cx={x(run[0].ts)}
                    cy={y(run[0].value)}
                    r="2"
                    fill={s.color}
                    stroke="none"
                  />
                ) : (
                  <path
                    key={i}
                    d={run
                      .map(
                        (p, j) =>
                          `${j ? "L" : "M"}${x(p.ts).toFixed(2)},${y(p.value).toFixed(2)}`,
                      )
                      .join(" ")}
                  />
                ),
              )}
            </g>
          ))}
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
              {timeLabel(ts, data.resolution_sec === 300)}
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
            {timeLabel(selectedTime, true)}
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
  const [history, setHistory] = useState<NetworkQualityQuery | null>(null);
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
  const range = chartMode === "live" ? "1h" : chartMode;
  const measurementKey = networkMeasurementKey(node.metrics?.network_quality);
  const currentMeasurementKey = useRef(measurementKey);
  currentMeasurementKey.current = measurementKey;
  const running = active && visible;
  const config = configEntry?.nodeId === node.id ? configEntry.response : null;
  const current =
    history?.node_id === node.id && history.range === range ? history : null;

  useEffect(() => {
    setSettingsOpen(false);
  }, [node.id]);

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
    if (!running || !config || !probeEnabled || !probeSupported || range === "1y") {
      setLoading(false);
      if (config && !probeEnabled) {
        setHistory(null);
        setHistoryError(null);
      }
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
          api.getNodeNetworkQuality(node.id, range, cursor, abort.signal),
        abort.signal,
      )
        .then((result) => {
          if (!abort.signal.aborted) setHistory(result);
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
          Math.max(0, Math.max(10000, intervalSec * 1000) - (Date.now() - lastStarted)),
        );
      }
    };

    refreshHistory.current = requestRefresh;
    start();
    return () => {
      window.clearTimeout(timer);
      abort.abort();
      refreshHistory.current = () => {};
    };
  }, [
    node.id,
    range,
    running,
    config,
    probeEnabled,
    probeSupported,
    intervalSec,
    refreshKey,
    retry,
  ]);

  useEffect(() => {
    if (running && probeEnabled && probeSupported) {
      refreshHistory.current();
    }
  }, [measurementKey, running, probeEnabled, probeSupported]);

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
                          <p>最后测量 {timeLabel(latest.measured_at, true)}</p>
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

          {range === "1y" ? (
            <p className="py-5 text-center text-[12px] text-[var(--text-secondary)]">
              网络质量历史保留 30 天
            </p>
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
              {current && (
                <div className="space-y-3" aria-busy={loading}>
                  <QualityChart
                    data={current}
                    metric="latency_ms"
                    title={current.resolution_sec === 300 ? "TCP 平均延迟" : "TCP 延迟"}
                    targetMeta={targetMeta}
                  />
                  <QualityChart
                    data={current}
                    metric="failure_rate_pct"
                    title="探测失败率"
                    targetMeta={targetMeta}
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
