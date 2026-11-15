import React from "react";
import {
  Badge,
  MetricBar,
  ObservabilityChart,
  StatusDot,
  type StatusDotTone,
} from "./ui/Primitives";
import type {
  CardPrimaryMetric,
  DensityMode,
  HorizonNode,
  InspectorTab,
} from "../types";
import {
  formatBytesPairCompact,
  formatCompactRate,
  resolvePrimaryMetricCard,
  type BottomMetricSlot,
} from "../utils/cardMetrics";
import {
  formatBytes,
  getDiskUsagePct,
  getMemTotalBytes,
  getMemUsagePct,
  getRootDisk,
  getTrafficUsagePct,
  isNodeMuted,
} from "../utils/format";

export interface FleetBentoGridProps {
  nodes: HorizonNode[];
  density?: DensityMode;
  primaryMetric?: CardPrimaryMetric;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onMuteNode?: (nodeId: string, seconds: number | null) => void | Promise<void>;
}

function getNodeStatusTone(node: HorizonNode): StatusDotTone {
  if (!node.online) return "danger";
  const cpuPct = node.metrics?.cpu.all ?? 0;
  const memPct = getMemUsagePct(node);
  const trafficPct = getTrafficUsagePct(node.traffic);
  if (
    cpuPct >= 88 ||
    memPct >= 88 ||
    (node.traffic.limit_bytes && trafficPct >= 90)
  ) {
    return "warn";
  }
  return "ok";
}

function getTrafficBarPct(node: HorizonNode): number {
  if (node.traffic.limit_bytes && node.traffic.limit_bytes > 0) {
    return getTrafficUsagePct(node.traffic);
  }
  const fiveTb = 5 * 1024 * 1024 * 1024 * 1024;
  return Math.min(100, (node.traffic.counted_bytes / fiveTb) * 100);
}

function AdaptiveText({
  long,
  short,
}: {
  long: string;
  short: string;
}): React.JSX.Element {
  if (long === short) {
    return <>{long}</>;
  }
  return (
    <>
      <span className="uniob-long">{long}</span>
      <span className="uniob-short" aria-hidden="true">
        {short}
      </span>
    </>
  );
}

function getBottomMetricProps(
  slot: BottomMetricSlot,
  node: HorizonNode,
): {
  label: React.ReactNode;
  labelText: string;
  valueLabel: React.ReactNode;
  valueText: string;
  valuePct: number;
} {
  const online = node.online;
  const m = node.metrics;
  switch (slot) {
    case "cpu": {
      const cpuPct = online && m ? m.cpu.all : 0;
      const text = online && m ? `${cpuPct.toFixed(0)}%` : "—";
      return {
        label: "CPU",
        labelText: "CPU",
        valueLabel: text,
        valueText: text,
        valuePct: cpuPct,
      };
    }
    case "mem": {
      const memPct = online ? getMemUsagePct(node) : 0;
      const memTotal = getMemTotalBytes(node);
      if (online && m && memTotal > 0) {
        const full = `${formatBytes(m.mem.used)} / ${formatBytes(memTotal)}`;
        const compact = formatBytesPairCompact(m.mem.used, memTotal);
        return {
          label: "内存",
          labelText: "内存",
          valueLabel: <AdaptiveText long={full} short={compact} />,
          valueText: full,
          valuePct: memPct,
        };
      }
      return {
        label: "内存",
        labelText: "内存",
        valueLabel: "—",
        valueText: "—",
        valuePct: memPct,
      };
    }
    case "net": {
      const rx = online && m ? m.net.rx_bps : 0;
      const tx = online && m ? m.net.tx_bps : 0;
      const total = rx + tx;
      // Scale rate activity softly on a 100 MiB/s reference bar
      const refBps = 100 * 1024 * 1024;
      const activityPct =
        online && m && total > 0
          ? Math.min(100, Math.max(4, (total / refBps) * 100))
          : 0;
      if (online && m) {
        const rxText = formatCompactRate(rx);
        const txText = formatCompactRate(tx);
        return {
          label: <AdaptiveText long="实时网络" short="网速" />,
          labelText: "实时网络",
          valueLabel: (
            <span className="uniob-net-pair inline-flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1">
                <span style={{ color: "var(--accent-ink)" }}>↓</span>
                <span>{rxText}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span style={{ color: "var(--status-ok-ink)" }}>↑</span>
                <span>{txText}</span>
              </span>
            </span>
          ),
          valueText: `↓ ${rxText} ↑ ${txText}`,
          valuePct: activityPct,
        };
      }
      return {
        label: <AdaptiveText long="实时网络" short="网速" />,
        labelText: "实时网络",
        valueLabel: "—",
        valueText: "—",
        valuePct: activityPct,
      };
    }
    case "disk": {
      const rootDisk = getRootDisk(m?.disks);
      if (rootDisk) {
        const full = `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}`;
        const compact = formatBytesPairCompact(rootDisk.used, rootDisk.total);
        return {
          label: "磁盘",
          labelText: "磁盘",
          valueLabel: <AdaptiveText long={full} short={compact} />,
          valueText: full,
          valuePct: getDiskUsagePct(rootDisk),
        };
      }
      return {
        label: "磁盘",
        labelText: "磁盘",
        valueLabel: "—",
        valueText: "—",
        valuePct: 0,
      };
    }
    case "traffic": {
      const hasLimit =
        node.traffic.limit_bytes !== null && node.traffic.limit_bytes > 0;
      if (hasLimit) {
        const full = `${formatBytes(node.traffic.counted_bytes)} / ${formatBytes(node.traffic.limit_bytes)}`;
        const compact = formatBytesPairCompact(
          node.traffic.counted_bytes,
          node.traffic.limit_bytes,
        );
        return {
          label: "流量",
          labelText: "流量",
          valueLabel: <AdaptiveText long={full} short={compact} />,
          valueText: full,
          valuePct: getTrafficBarPct(node),
        };
      }
      const single = formatBytes(node.traffic.counted_bytes);
      return {
        label: "流量",
        labelText: "流量",
        valueLabel: single,
        valueText: single,
        valuePct: getTrafficBarPct(node),
      };
    }
  }
}

export function FleetBentoGrid({
  nodes,
  density = "comfortable",
  primaryMetric = "net",
  onSelectNode,
}: FleetBentoGridProps): React.JSX.Element {
  return (
    <div
      className={`grid grid-cols-1 min-[880px]:grid-cols-2 xl:grid-cols-3 ${
        density === "compact" ? "gap-3.5" : "gap-4"
      }`}
    >
      {nodes.map((node) => {
        const statusTone = getNodeStatusTone(node);
        const muted = isNodeMuted(node);
        const regionText = node.group_name || node.region_code;
        const plot = resolvePrimaryMetricCard(node, primaryMetric);
        const barTone = node.online ? undefined : "muted";

        return (
          <article
            key={node.id}
            tabIndex={0}
            onClick={() => onSelectNode(node, "charts")}
            onKeyDown={(e) => {
              if (
                e.target === e.currentTarget &&
                (e.key === "Enter" || e.key === " ")
              ) {
                e.preventDefault();
                onSelectNode(node, "charts");
              }
            }}
            aria-label={`${node.name}，${regionText}`}
            className={`uniob-bento-card atelier-card atelier-card-interactive flex min-w-0 cursor-pointer flex-col gap-4 ${
              density === "compact" ? "p-4" : "p-5"
            }`}
          >
            {/* Header: Status Dot + Name + Region */}
            <div className="flex min-h-[22px] items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot tone={statusTone} />
                <h3
                  style={
                    node.online ? undefined : { color: "var(--text-secondary)" }
                  }
                  className="truncate text-[14.5px] font-semibold tracking-[-0.01em]"
                >
                  {node.name}
                </h3>
                {muted && <Badge tone="subtle">静音</Badge>}
              </div>
              <span
                style={{
                  color: node.online
                    ? "var(--text-tertiary)"
                    : "var(--status-danger-ink)",
                }}
                className="shrink-0 text-[12px] whitespace-nowrap"
              >
                {node.online ? regionText : `${regionText} · 离线`}
              </span>
            </div>

            {/* Primary Metric Observability Chart or Calm Offline Baseline */}
            <div
              style={{
                backgroundColor: "var(--bg-card)",
                borderTop: "1px solid var(--border-hairline)",
                borderBottom: "1px solid var(--border-hairline)",
              }}
              className="min-w-0 py-2.5"
            >
              <div className="mb-1.5 flex min-h-[18px] items-center justify-between gap-2">
                <span
                  style={{
                    color: node.online
                      ? "var(--text-tertiary)"
                      : "var(--text-muted)",
                  }}
                  className="shrink-0 text-[11.5px] whitespace-nowrap"
                >
                  {plot.heroLabel}
                </span>
                {plot.hasLiveChart ? (
                  plot.netRatePair ? (
                    <div className="font-mono-num flex min-w-0 items-center gap-3.5 text-[12px] font-medium whitespace-nowrap">
                      <span
                        style={{ color: "var(--accent-ink)" }}
                        className="inline-flex items-center gap-1"
                      >
                        <span>↓</span>
                        <span>{plot.netRatePair.rx}</span>
                      </span>
                      <span
                        style={{ color: "var(--status-ok-ink)" }}
                        className="inline-flex items-center gap-1"
                      >
                        <span>↑</span>
                        <span>{plot.netRatePair.tx}</span>
                      </span>
                    </div>
                  ) : (
                    <span
                      style={{ color: "var(--text-primary)" }}
                      className="font-mono-num text-[12px] font-medium whitespace-nowrap"
                    >
                      {plot.primaryValueText}
                    </span>
                  )
                ) : (
                  <span
                    style={{ color: "var(--text-muted)" }}
                    className="font-mono-num text-[12px] whitespace-nowrap"
                  >
                    {plot.primaryValueText}
                  </span>
                )}
              </div>

              {plot.hasLiveChart ? (
                <ObservabilityChart
                  height={82}
                  isRateBps={plot.unitKind === "bps"}
                  yMax={plot.yMax}
                  yUnit={plot.yUnit}
                  ariaLabel={`${node.name} ${plot.heroLabel}`}
                  series={plot.series}
                />
              ) : (
                <div
                  style={{ height: 82 }}
                  className="relative flex items-center justify-center"
                  aria-label={`${node.name} ${plot.placeholderText}`}
                >
                  <div
                    style={{ borderTop: "1px dashed var(--border-subtle)" }}
                    className="pointer-events-none absolute inset-x-0 top-1/2"
                  />
                  <span
                    style={{
                      backgroundColor: "var(--bg-card)",
                      color: "var(--text-muted)",
                    }}
                    className="relative px-2.5 text-[11.5px]"
                  >
                    {plot.placeholderText}
                  </span>
                </div>
              )}
            </div>

            {/* 4 Clean Visual Bars (primary metric dynamically swapped so it's never duplicated) */}
            <div
              style={node.online ? undefined : { opacity: 0.72 }}
              className="uniob-card-metrics mt-auto grid grid-cols-2 gap-x-4 gap-y-3"
            >
              {plot.bottomSlots.map((slot) => {
                const bar = getBottomMetricProps(slot, node);
                return (
                  <div key={slot} className="uniob-metric-cell flex flex-col">
                    <MetricBar
                      label={bar.label}
                      labelText={bar.labelText}
                      valueLabel={bar.valueLabel}
                      valueText={bar.valueText}
                      valuePct={bar.valuePct}
                      toneOverride={barTone}
                      thickness={3}
                      className="flex-1"
                    />
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
}
