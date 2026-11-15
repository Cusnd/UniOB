import React, { useMemo } from "react";
import {
  MetricBar,
  Sparkline,
  formatBytesPerSec,
} from "./ui/Primitives";
import type {
  AppRoute,
  HorizonNode,
  HubStatusResponse,
  InspectorTab,
} from "../types";
import { getMemTotalBytes } from "../utils/format";

export interface BentoHeroStripProps {
  nodes: HorizonNode[];
  activeAlertsCount: number;
  hubStatus?: HubStatusResponse | null;
  onSelectNode?: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onNavigate: (route: AppRoute) => void;
}

export function BentoHeroStrip({
  nodes,
  activeAlertsCount,
  onNavigate,
}: BentoHeroStripProps): React.JSX.Element {
  const summary = useMemo(() => {
    const onlineNodes = nodes.filter((n) => n.online);
    const onlineCount = onlineNodes.length;
    const onlinePct = nodes.length > 0 ? (onlineCount / nodes.length) * 100 : 0;

    let totalRxBps = 0;
    let totalTxBps = 0;
    let cpuSum = 0;
    let memUsedSum = 0;
    let memTotalSum = 0;

    for (const n of onlineNodes) {
      totalRxBps += n.metrics?.net.rx_bps ?? 0;
      totalTxBps += n.metrics?.net.tx_bps ?? 0;
      cpuSum += n.metrics?.cpu.all ?? 0;
      const tot = getMemTotalBytes(n);
      if (tot > 0 && n.metrics) {
        memTotalSum += tot;
        memUsedSum += n.metrics.mem.used;
      }
    }

    const avgCpu = onlineCount > 0 ? cpuSum / onlineCount : 0;
    const avgMemPct = memTotalSum > 0 ? (memUsedSum / memTotalSum) * 100 : 0;

    const maxLen = Math.max(
      2,
      ...onlineNodes.map((n) => n.sparkline_cpu.length),
    );
    const pointsCount = Math.min(24, maxLen);
    const fleetCpuSeries = Array.from({ length: pointsCount }, (_, idx) => {
      if (onlineCount === 0) return 0;
      let sum = 0;
      for (const n of onlineNodes) {
        const arr = n.sparkline_cpu;
        if (arr.length === 0) {
          sum += n.metrics?.cpu.all ?? 0;
        } else {
          const offset = arr.length - pointsCount + idx;
          const clampedIdx = Math.max(0, Math.min(arr.length - 1, offset));
          sum += arr[clampedIdx] ?? 0;
        }
      }
      return Number((sum / onlineCount).toFixed(1));
    });

    return {
      onlineCount,
      onlinePct,
      totalRxBps,
      totalTxBps,
      avgCpu,
      avgMemPct,
      fleetCpuSeries,
    };
  }, [nodes]);

  return (
    <section aria-label="机群概览指标" className="atelier-card px-5 py-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5 xl:gap-0">
        {/* Cell 1: Online Nodes */}
        <div
          style={{ borderColor: "var(--border-hairline)" }}
          className="flex min-w-0 flex-col justify-between gap-2 xl:border-r xl:pr-5"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px] font-medium"
            >
              在线节点
            </span>
            <div className="font-mono-num flex items-baseline gap-1 text-[20px] leading-none font-semibold tracking-[-0.02em]">
              <span>{summary.onlineCount}</span>
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="text-[13px] font-normal"
              >
                / {nodes.length}
              </span>
            </div>
          </div>
          <MetricBar
            valuePct={summary.onlinePct}
            toneOverride={
              nodes.length > 0 && summary.onlineCount === nodes.length
                ? "ok"
                : summary.onlineCount > 0
                  ? "warn"
                  : "danger"
            }
            thickness={3}
          />
        </div>

        {/* Cell 2: Live Fleet Total Network Speed */}
        <div
          style={{ borderColor: "var(--border-hairline)" }}
          className="flex min-w-0 flex-col justify-between gap-1.5 xl:border-r xl:px-5"
        >
          <span
            style={{ color: "var(--text-tertiary)" }}
            className="text-[12px] font-medium"
          >
            实时总网速
          </span>
          <div className="font-mono-num flex flex-wrap items-baseline gap-x-3.5 gap-y-1 text-[13.5px] leading-tight font-semibold">
            <span
              style={{ color: "var(--accent-ink)" }}
              className="inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>↓</span>
              <span>{formatBytesPerSec(summary.totalRxBps)}</span>
            </span>
            <span
              style={{ color: "var(--status-ok-ink)" }}
              className="inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>↑</span>
              <span>{formatBytesPerSec(summary.totalTxBps)}</span>
            </span>
          </div>
        </div>

        {/* Cell 3: Average CPU + Mini Observability Sparkline */}
        <div
          style={{ borderColor: "var(--border-hairline)" }}
          className="flex min-w-0 items-center justify-between gap-3 xl:border-r xl:px-5"
        >
          <div className="shrink-0 space-y-1.5">
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px] font-medium"
            >
              平均 CPU
            </div>
            <div className="font-mono-num text-[20px] leading-none font-semibold tracking-[-0.02em]">
              {summary.avgCpu.toFixed(0)}%
            </div>
          </div>
          <div className="min-w-[68px] max-w-[112px] flex-1">
            <Sparkline
              data={summary.fleetCpuSeries}
              height={28}
              max={100}
              tone="accent"
            />
          </div>
        </div>

        {/* Cell 4: Average Memory */}
        <div
          style={{ borderColor: "var(--border-hairline)" }}
          className="flex min-w-0 flex-col justify-between gap-2 xl:border-r xl:px-5"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px] font-medium"
            >
              平均内存
            </span>
            <span className="font-mono-num text-[20px] leading-none font-semibold tracking-[-0.02em]">
              {summary.avgMemPct.toFixed(0)}%
            </span>
          </div>
          <MetricBar valuePct={summary.avgMemPct} thickness={3} />
        </div>

        {/* Cell 5: Active Alerts */}
        <button
          type="button"
          onClick={() => onNavigate("alerts")}
          className="flex min-w-0 cursor-pointer flex-col justify-between gap-1.5 text-left transition-opacity hover:opacity-80 xl:pl-5"
        >
          <span
            style={{ color: "var(--text-tertiary)" }}
            className="text-[12px] font-medium"
          >
            活跃告警
          </span>
          <div className="flex items-baseline gap-2">
            <span
              style={{
                color:
                  activeAlertsCount > 0
                    ? "var(--status-danger-ink)"
                    : "var(--text-primary)",
              }}
              className="font-mono-num text-[20px] leading-none font-semibold tracking-[-0.02em]"
            >
              {activeAlertsCount}
            </span>
            <span
              style={{
                color:
                  activeAlertsCount > 0
                    ? "var(--status-danger-ink)"
                    : "var(--text-tertiary)",
              }}
              className="text-[12px]"
            >
              {activeAlertsCount > 0 ? "待处理" : "全部正常"}
            </span>
          </div>
        </button>
      </div>
    </section>
  );
}
