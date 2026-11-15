import React from "react";
import {
  Badge,
  MetricBar,
  ObservabilityChart,
  StatusDot,
  formatBytesPerSec,
  type StatusDotTone,
} from "./ui/Primitives";
import type { DensityMode, HorizonNode, InspectorTab } from "../types";
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

export function FleetBentoGrid({
  nodes,
  density = "comfortable",
  onSelectNode,
}: FleetBentoGridProps): React.JSX.Element {
  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 ${
        density === "compact" ? "gap-3.5" : "gap-4"
      }`}
    >
      {nodes.map((node) => {
        const statusTone = getNodeStatusTone(node);
        const cpuPct = node.online && node.metrics ? node.metrics.cpu.all : 0;
        const memPct = node.online ? getMemUsagePct(node) : 0;
        const memTotal = getMemTotalBytes(node);
        const rootDisk = getRootDisk(node.metrics?.disks);
        const diskPct = getDiskUsagePct(rootDisk);
        const trafficBarPct = getTrafficBarPct(node);
        const hasLimit =
          node.traffic.limit_bytes !== null && node.traffic.limit_bytes > 0;
        const muted = isNodeMuted(node);
        const regionText = node.group_name || node.region_code;

        const rxData =
          node.online && node.sparkline_rx.length > 0
            ? node.sparkline_rx
            : node.online && node.metrics
              ? [node.metrics.net.rx_bps, node.metrics.net.rx_bps]
              : [0, 0];

        const txData =
          node.online && node.sparkline_tx.length > 0
            ? node.sparkline_tx
            : node.online && node.metrics
              ? [node.metrics.net.tx_bps, node.metrics.net.tx_bps]
              : [0, 0];

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
            className={`atelier-card atelier-card-interactive flex min-w-0 cursor-pointer flex-col gap-4 ${
              density === "compact" ? "p-4" : "p-5"
            }`}
          >
            {/* Header: Status Dot + Name + Region */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot tone={statusTone} />
                <h3 className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">
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
                className="shrink-0 text-[12px]"
              >
                {node.online ? regionText : `${regionText} · 离线`}
              </span>
            </div>

            {/* Live Network RX/TX Observability Chart */}
            <div
              style={{
                backgroundColor: "var(--bg-card)",
                borderTop: "1px solid var(--border-hairline)",
                borderBottom: "1px solid var(--border-hairline)",
              }}
              className="min-w-0 py-2.5"
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span
                  style={{ color: "var(--text-tertiary)" }}
                  className="text-[11.5px]"
                >
                  实时网络
                </span>
                {node.online && node.metrics ? (
                  <div className="font-mono-num flex items-center gap-2.5 text-[12px] font-medium">
                    <span style={{ color: "var(--accent-ink)" }}>
                      ↓ {formatBytesPerSec(node.metrics.net.rx_bps)}
                    </span>
                    <span style={{ color: "var(--status-ok-ink)" }}>
                      ↑ {formatBytesPerSec(node.metrics.net.tx_bps)}
                    </span>
                  </div>
                ) : (
                  <span
                    style={{ color: "var(--text-muted)" }}
                    className="font-mono-num text-[12px]"
                  >
                    —
                  </span>
                )}
              </div>

              <ObservabilityChart
                height={82}
                isRateBps
                ariaLabel={`${node.name} 实时网络吞吐`}
                series={[
                  {
                    label: "↓",
                    color: "var(--accent)",
                    data: rxData,
                  },
                  {
                    label: "↑",
                    color: "var(--status-ok)",
                    data: txData,
                  },
                ]}
              />
            </div>

            {/* 4 Clean Visual Bars: CPU / 内存 / 磁盘 / 流量 */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <MetricBar
                label="CPU"
                valueLabel={
                  node.online && node.metrics ? `${cpuPct.toFixed(0)}%` : "—"
                }
                valuePct={cpuPct}
                thickness={3}
              />
              <MetricBar
                label="内存"
                valueLabel={
                  node.online && node.metrics && memTotal > 0
                    ? `${formatBytes(node.metrics.mem.used)} / ${formatBytes(memTotal)}`
                    : "—"
                }
                valuePct={memPct}
                thickness={3}
              />
              <MetricBar
                label="磁盘"
                valueLabel={
                  rootDisk
                    ? `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}`
                    : "—"
                }
                valuePct={diskPct}
                thickness={3}
              />
              <MetricBar
                label="流量"
                valueLabel={
                  hasLimit
                    ? `${formatBytes(node.traffic.counted_bytes)} / ${formatBytes(node.traffic.limit_bytes)}`
                    : formatBytes(node.traffic.counted_bytes)
                }
                valuePct={trafficBarPct}
                thickness={3}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}
