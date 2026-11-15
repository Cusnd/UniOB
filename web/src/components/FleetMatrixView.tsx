import React, { useMemo } from "react";
import {
  MetricBar,
  ObservabilityChart,
  StatusDot,
  formatBytesPerSec,
  type StatusDotTone,
} from "./ui/Primitives";
import type { DensityMode, HorizonNode, InspectorTab } from "../types";
import {
  getDiskUsagePct,
  getMemUsagePct,
  getRootDisk,
  getTrafficUsagePct,
} from "../utils/format";

export interface FleetMatrixViewProps {
  nodes: HorizonNode[];
  density?: DensityMode;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
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

function getTrafficPct(node: HorizonNode): number {
  if (node.traffic.limit_bytes && node.traffic.limit_bytes > 0) {
    return getTrafficUsagePct(node.traffic);
  }
  const fiveTb = 5 * 1024 * 1024 * 1024 * 1024;
  return Math.min(100, (node.traffic.counted_bytes / fiveTb) * 100);
}

export function FleetMatrixView({
  nodes,
  onSelectNode,
}: FleetMatrixViewProps): React.JSX.Element {
  const clusters = useMemo(() => {
    const map = new Map<string, HorizonNode[]>();
    for (const n of nodes) {
      const key = n.group_name?.trim() || "默认分组";
      const list = map.get(key) ?? [];
      list.push(n);
      map.set(key, list);
    }
    return Array.from(map.entries()).map(([title, list]) => ({
      title,
      list,
      onlineCount: list.filter((n) => n.online).length,
    }));
  }, [nodes]);

  return (
    <div className="space-y-4">
      {clusters.map((cluster) => (
        <section
          key={cluster.title}
          aria-label={cluster.title}
          className="atelier-card p-5"
        >
          <div className="mb-3.5 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold">{cluster.title}</h3>
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="font-mono-num text-[12px]"
            >
              {cluster.onlineCount} / {cluster.list.length}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cluster.list.map((node) => {
              const tone = getNodeStatusTone(node);
              const cpuPct =
                node.online && node.metrics ? node.metrics.cpu.all : 0;
              const memPct = node.online ? getMemUsagePct(node) : 0;
              const diskPct = getDiskUsagePct(getRootDisk(node.metrics?.disks));
              const trafficPct = getTrafficPct(node);

              const rxData =
                node.online && node.sparkline_rx.length > 0
                  ? node.sparkline_rx.slice(-24)
                  : node.online && node.metrics
                    ? [node.metrics.net.rx_bps, node.metrics.net.rx_bps]
                    : [0, 0];

              const txData =
                node.online && node.sparkline_tx.length > 0
                  ? node.sparkline_tx.slice(-24)
                  : node.online && node.metrics
                    ? [node.metrics.net.tx_bps, node.metrics.net.tx_bps]
                    : [0, 0];

              return (
                <div
                  key={node.id}
                  role="button"
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
                  style={{
                    backgroundColor: "var(--bg-card)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="min-w-0 cursor-pointer space-y-3 rounded-[9px] p-3.5 transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusDot tone={tone} />
                      <span className="truncate text-[13px] font-semibold">
                        {node.name}
                      </span>
                    </div>
                    <span
                      style={{ color: "var(--text-tertiary)" }}
                      className="shrink-0 text-[11.5px]"
                    >
                      {node.region_code}
                    </span>
                  </div>

                  {/* Full-Width Live RX/TX Header + Compact ObservabilityChart */}
                  <div className="min-w-0 space-y-1">
                    <div className="font-mono-num flex items-center justify-between gap-2 text-[11px] font-medium">
                      {node.online && node.metrics ? (
                        <>
                          <span style={{ color: "var(--accent-ink)" }}>
                            ↓ {formatBytesPerSec(node.metrics.net.rx_bps)}
                          </span>
                          <span style={{ color: "var(--status-ok-ink)" }}>
                            ↑ {formatBytesPerSec(node.metrics.net.tx_bps)}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>离线</span>
                      )}
                    </div>

                    {node.online ? (
                      <ObservabilityChart
                        height={56}
                        isRateBps
                        ariaLabel={`${node.name} 实时网速`}
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
                    ) : (
                      <div
                        style={{ height: 56 }}
                        className="relative flex items-center justify-center"
                        aria-label={`${node.name} 离线`}
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
                          className="relative px-2 text-[11px]"
                        >
                          离线
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <MetricBar
                      label="CPU"
                      valueLabel={
                        node.online && node.metrics
                          ? `${cpuPct.toFixed(0)}%`
                          : "—"
                      }
                      valuePct={cpuPct}
                      thickness={3}
                    />
                    <MetricBar
                      label="内存"
                      valueLabel={
                        node.online && node.metrics
                          ? `${memPct.toFixed(0)}%`
                          : "—"
                      }
                      valuePct={memPct}
                      thickness={3}
                    />
                    <MetricBar
                      label="磁盘"
                      valueLabel={`${diskPct.toFixed(0)}%`}
                      valuePct={diskPct}
                      thickness={3}
                    />
                    <MetricBar
                      label="流量"
                      valueLabel={`${trafficPct.toFixed(0)}%`}
                      valuePct={trafficPct}
                      thickness={3}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
