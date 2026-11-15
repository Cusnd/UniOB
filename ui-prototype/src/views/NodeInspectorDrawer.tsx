import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Cpu,
  HardDrive,
  Network,
  RotateCcw,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  MetricBar,
  NativeDialog,
  ObservabilityChart,
  SegmentedControl,
  StatusDot,
  formatRateKbps,
  type ObservabilitySeries,
  type StatusDotTone,
} from "../components/ui/Primitives";
import type {
  FleetNode,
  InspectorTab,
  NodeInspectorDrawerProps,
  ProcessGear,
  SanitizedProcess,
  TelemetryPoint,
  TelemetryRange,
} from "../types";

type ProcSortKey = "pid" | "comm" | "cpuPct" | "rssMb" | "cmd";

const PROC_COLLATOR = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

const PROC_SORT_LABELS: Record<ProcSortKey, string> = {
  pid: "PID",
  comm: "进程名",
  cpuPct: "CPU",
  rssMb: "内存",
  cmd: "命令",
};

const LEASE_TOTAL_SECONDS = 90;

function formatShortOs(os: string): string {
  return os
    .replace(/\s+(Bookworm|Bullseye|Trixie|Noble|Jammy|Focal|LTS)$/i, "")
    .trim();
}

function formatSpecGb(totalMb: number): string {
  const gb = totalMb / 1024;
  if (gb < 1) return `${gb.toFixed(1)}`;
  return Number.isInteger(gb) ? `${gb}` : gb.toFixed(1);
}

function formatMemAmount(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

function formatTrafficGb(gb: number): string {
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${Math.round(gb)} GB`;
}

function computeSeriesStats(
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

function renderCleanCommand(cmd: string): React.ReactNode {
  const pattern =
    /(--[a-zA-Z0-9_-]+=\*\*\*|--requirepass\s+\*\*\*|[A-Z0-9_]+=\*\*\*|[a-zA-Z0-9+.-]+:\/\/[^\s:@]+:\*\*\*@[^\s]+|\*\*\*)/g;
  const parts = cmd.split(pattern);
  if (parts.length <= 1) return cmd;

  return parts.map((segment, idx) => {
    if (!segment) return null;
    if (segment.includes("***")) {
      return (
        <span
          key={idx}
          style={{
            backgroundColor: "var(--bg-muted)",
            color: "var(--text-secondary)",
          }}
          className="mx-0.5 inline-flex items-center rounded-[4px] px-1 py-[0.5px] font-mono text-[10.5px] leading-tight"
        >
          {segment}
        </span>
      );
    }
    return <React.Fragment key={idx}>{segment}</React.Fragment>;
  });
}

/* ============================================================================
 * Clinical Observability Chart Panel (Title + Legend + 当前/均值/峰值 + Chart)
 * ============================================================================ */
interface TelemetryPanelProps {
  title: string;
  icon: React.ReactNode;
  series: ObservabilitySeries[];
  stats: { current: string; avg: string; peak: string };
  yMax?: number;
  yUnit?: string;
  isRateKbps?: boolean;
  timeLabels: string[];
  hoverIndex: number | null;
  onHoverIndexChange: (idx: number | null) => void;
}

function TelemetryPanel({
  title,
  icon,
  series,
  stats,
  yMax,
  yUnit,
  isRateKbps = false,
  timeLabels,
  hoverIndex,
  onHoverIndexChange,
}: TelemetryPanelProps): React.JSX.Element {
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

        {/* Tabular Stats: 当前 / 均值 / 峰值 */}
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
        isRateKbps={isRateKbps}
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

/* ============================================================================
 * Compact 90s Circular Countdown Timer
 * ============================================================================ */
function LeaseCountdownRing({
  remainingSec,
  totalSec,
}: {
  remainingSec: number;
  totalSec: number;
}): React.JSX.Element {
  const size = 18;
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, remainingSec / totalSec));
  const dashOffset = circumference * (1 - pct);

  const ringColor =
    remainingSec <= 15
      ? "var(--status-danger)"
      : remainingSec <= 30
        ? "var(--status-warn)"
        : "var(--accent)";

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="-rotate-90 shrink-0"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border-subtle)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={ringColor}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ============================================================================
 * Monthly Traffic Visual Ring
 * ============================================================================ */
function TrafficProgressRing({ valuePct }: { valuePct: number }): React.JSX.Element {
  const size = 60;
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, valuePct));
  const dashOffset = circumference * (1 - clamped / 100);

  const color =
    clamped >= 88
      ? "var(--status-danger)"
      : clamped >= 75
        ? "var(--status-warn)"
        : "var(--accent)";

  return (
    <div className="relative inline-flex h-[60px] w-[60px] shrink-0 items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-muted)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
      </svg>
      <span className="font-mono-num absolute text-[12px] font-semibold">
        {clamped.toFixed(0)}%
      </span>
    </div>
  );
}

/* ============================================================================
 * Main Slide-Over Node Inspector Drawer
 * ============================================================================ */
export function NodeInspectorDrawer({
  node,
  open,
  activeTab,
  onTabChange,
  onClose,
  onGearChange,
  onNotify,
}: NodeInspectorDrawerProps): React.JSX.Element {
  const baseId = useId();
  const titleId = `${baseId}-drawer-title`;
  const procCaptionId = `${baseId}-proc-caption`;

  // Preserve last active node during top-layer exit animation
  const lastNodeRef = useRef<FleetNode | null>(node);
  if (node) {
    lastNodeRef.current = node;
  }
  const activeNode = node ?? lastNodeRef.current;

  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({
    telemetry: null,
    processes: null,
    hardware: null,
  });

  // Tab 1: Time range + synchronized crosshair across all 4 panels
  const [range, setRange] = useState<TelemetryRange>("10m");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Tab 2: Process mode + live 90s countdown + table sort
  const [gear, setGear] = useState<ProcessGear>(1);
  const [leaseSec, setLeaseSec] = useState<number>(LEASE_TOTAL_SECONDS);
  const [procSortKey, setProcSortKey] = useState<ProcSortKey>("cpuPct");
  const [procSortDesc, setProcSortDesc] = useState<boolean>(true);
  const [procSortAnnouncement, setProcSortAnnouncement] = useState("");

  useEffect(() => {
    if (!node) return;
    setHoverIdx(null);
    if (node.online && node.procEnabled) {
      setGear(1);
      setLeaseSec(LEASE_TOTAL_SECONDS);
    } else {
      setGear(0);
      setLeaseSec(0);
    }
  }, [node?.id]);

  useEffect(() => {
    if (!open || !activeNode || !activeNode.online || !activeNode.procEnabled) {
      return;
    }
    if (gear === 0) return;

    const timer = window.setInterval(() => {
      setLeaseSec((prev) => {
        if (prev <= 1) {
          setGear(0);
          onGearChange?.(activeNode.id, 0);
          onNotify?.(`${activeNode.name} 进程查看已自动关闭`, "info");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [
    open,
    activeNode?.id,
    activeNode?.online,
    activeNode?.procEnabled,
    gear,
    onGearChange,
    onNotify,
  ]);

  const handleSelectGear = (nextGear: ProcessGear) => {
    if (!activeNode) return;
    setGear(nextGear);
    setLeaseSec(nextGear > 0 ? LEASE_TOTAL_SECONDS : 0);
    onGearChange?.(activeNode.id, nextGear);
  };

  const handleRenewLease = () => {
    if (!activeNode) return;
    if (gear === 0) {
      setGear(1);
      onGearChange?.(activeNode.id, 1);
    }
    setLeaseSec(LEASE_TOTAL_SECONDS);
    onNotify?.("已续期 90 秒", "success");
  };

  const projectedSeries = useMemo<TelemetryPoint[]>(() => {
    if (!activeNode) return [];
    const base = activeNode.series;
    const lastIdx = Math.max(1, base.length - 1);

    if (range === "10m") {
      return base.map((pt, idx) => {
        const secAgo = (lastIdx - idx) * 2;
        const label =
          idx === lastIdx
            ? "现在"
            : idx === 0
              ? "-2m"
              : idx === Math.floor(lastIdx / 2)
                ? "-1m"
                : `-${secAgo}s`;
        return {
          ...pt,
          cpu: activeNode.online ? pt.cpu : 0,
          memPct: activeNode.online ? pt.memPct : 0,
          swapPct: activeNode.online ? pt.swapPct : 0,
          rxKbps: activeNode.online ? pt.rxKbps : 0,
          txKbps: activeNode.online ? pt.txKbps : 0,
          diskReadKbps: activeNode.online ? pt.diskReadKbps : 0,
          diskWriteKbps: activeNode.online ? pt.diskWriteKbps : 0,
          label,
        };
      });
    }

    if (range === "1h") {
      return base.map((pt, idx) => {
        const minAgo = Math.round(((lastIdx - idx) / lastIdx) * 60);
        const jitter = ((idx * 17) % 7) - 3;
        return {
          ...pt,
          cpu: activeNode.online
            ? Number(Math.max(1, Math.min(99.5, pt.cpu * 0.94 + jitter)).toFixed(1))
            : 0,
          rxKbps: activeNode.online
            ? Math.max(0, Math.round(pt.rxKbps * (0.9 + ((idx * 13) % 5) * 0.05)))
            : 0,
          txKbps: activeNode.online
            ? Math.max(0, Math.round(pt.txKbps * (0.92 + ((idx * 11) % 5) * 0.04)))
            : 0,
          label: minAgo === 0 ? "现在" : `-${minAgo}m`,
        };
      });
    }

    return base.map((pt, idx) => {
      const hourAgo = Math.round(((lastIdx - idx) / lastIdx) * 24);
      const wave = Math.sin(idx * 0.65) * 5.4;
      return {
        ...pt,
        cpu: activeNode.online
          ? Number(Math.max(1, Math.min(99, pt.cpu * 0.9 + wave + 3)).toFixed(1))
          : 0,
        rxKbps: activeNode.online
          ? Math.max(0, Math.round(pt.rxKbps * (0.88 + Math.abs(Math.cos(idx * 0.7)) * 0.32)))
          : 0,
        txKbps: activeNode.online
          ? Math.max(0, Math.round(pt.txKbps * (0.86 + Math.abs(Math.sin(idx * 0.6)) * 0.3)))
          : 0,
        label: hourAgo === 0 ? "现在" : `-${hourAgo}h`,
      };
    });
  }, [activeNode, range]);

  const chartData = useMemo(() => {
    const timeLabels = projectedSeries.map((p) => p.label);
    const rxArr = projectedSeries.map((p) => p.rxKbps);
    const txArr = projectedSeries.map((p) => p.txKbps);
    const cpuArr = projectedSeries.map((p) => p.cpu);
    const memArr = projectedSeries.map((p) => p.memPct);
    const swapArr = projectedSeries.map((p) => p.swapPct);
    const diskReadArr = projectedSeries.map((p) => p.diskReadKbps);
    const diskWriteArr = projectedSeries.map((p) => p.diskWriteKbps);

    const netStats = computeSeriesStats(rxArr, txArr);
    const cpuStats = computeSeriesStats(cpuArr);
    const memStats = computeSeriesStats(memArr, swapArr);
    const diskStats = computeSeriesStats(diskReadArr, diskWriteArr);

    return {
      timeLabels,
      rxArr,
      txArr,
      cpuArr,
      memArr,
      swapArr,
      diskReadArr,
      diskWriteArr,
      netStats,
      cpuStats,
      memStats,
      diskStats,
    };
  }, [projectedSeries]);

  const sortedProcesses = useMemo<SanitizedProcess[]>(() => {
    if (!activeNode || gear === 0) return [];
    const base =
      gear === 1
        ? [...activeNode.processes]
            .sort((a, b) => b.cpuPct - a.cpuPct || b.rssMb - a.rssMb)
            .slice(0, 15)
        : activeNode.processes;

    return [...base].sort((a, b) => {
      let cmp = 0;
      switch (procSortKey) {
        case "pid":
          cmp = a.pid - b.pid;
          break;
        case "comm":
          cmp = PROC_COLLATOR.compare(a.comm, b.comm);
          break;
        case "cpuPct":
          cmp = a.cpuPct - b.cpuPct;
          break;
        case "rssMb":
          cmp = a.rssMb - b.rssMb;
          break;
        case "cmd":
          cmp = PROC_COLLATOR.compare(a.sanitizedCmd, b.sanitizedCmd);
          break;
      }
      if (cmp === 0) cmp = a.pid - b.pid;
      return procSortDesc ? -cmp : cmp;
    });
  }, [activeNode, gear, procSortKey, procSortDesc]);

  const handleProcSort = (key: ProcSortKey) => {
    const nextDesc =
      procSortKey === key ? !procSortDesc : key === "cpuPct" || key === "rssMb";
    setProcSortKey(key);
    setProcSortDesc(nextDesc);
    setProcSortAnnouncement(
      `已按${PROC_SORT_LABELS[key]}${nextDesc ? "降序" : "升序"}排列`,
    );
  };

  const renderProcSortIcon = (key: ProcSortKey) => {
    if (procSortKey !== key) {
      return (
        <ArrowUpDown
          style={{ color: "var(--text-muted)" }}
          className="h-3 w-3 shrink-0"
          aria-hidden="true"
        />
      );
    }
    return procSortDesc ? (
      <ChevronDown
        style={{ color: "var(--accent)" }}
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
    ) : (
      <ChevronUp
        style={{ color: "var(--accent)" }}
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
    );
  };

  const tabOrder: InspectorTab[] = ["telemetry", "processes", "hardware"];
  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabOrder.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (idx - 1 + tabOrder.length) % tabOrder.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabOrder.length - 1;

    if (nextIdx !== null) {
      e.preventDefault();
      const target = tabOrder[nextIdx];
      if (target) {
        onTabChange(target);
        tabRefs.current[target]?.focus();
      }
    }
  };

  const statusTone: StatusDotTone = !activeNode
    ? "idle"
    : !activeNode.online
      ? "danger"
      : activeNode.cpuPct >= 88 ||
          (activeNode.memTotalMb > 0 &&
            (activeNode.memUsedMb / activeNode.memTotalMb) * 100 >= 88)
        ? "warn"
        : "ok";

  const trafficPct = activeNode
    ? activeNode.monthlyTrafficLimitGb && activeNode.monthlyTrafficLimitGb > 0
      ? (activeNode.monthlyTrafficUsedGb / activeNode.monthlyTrafficLimitGb) * 100
      : Math.min(100, (activeNode.monthlyTrafficUsedGb / 5000) * 100)
    : 0;

  return (
    <NativeDialog
      open={open}
      onClose={onClose}
      titleId={titleId}
      variant="drawer"
      maxWidthClass="max-w-[760px]"
    >
      {activeNode ? (
        <>
          {/* ================================================================
           * 1. Clean Drawer Header: Name, IP Copy, Spec, Live RX/TX + Tabs
           * ================================================================ */}
          <header
            style={{
              backgroundColor: "var(--bg-sheet)",
              borderBottom: "1px solid var(--border-hairline)",
            }}
            className="shrink-0 px-6 pt-5"
          >
            <div className="flex items-start justify-between gap-4 pb-4">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <StatusDot tone={statusTone} pulse={activeNode.online} />
                  <h2
                    id={titleId}
                    className="truncate text-[17px] leading-tight font-semibold tracking-[-0.015em]"
                  >
                    {activeNode.name}
                  </h2>
                  {!activeNode.online && <Badge tone="danger">离线</Badge>}
                </div>

                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
                  <CopyButton
                    value={activeNode.ipv4}
                    label={activeNode.ipv4}
                    copiedLabel="已复制"
                    onCopied={() => onNotify?.("已复制 IP", "success")}
                    className="font-mono-num"
                  />
                  <span style={{ color: "var(--text-secondary)" }}>
                    {formatShortOs(activeNode.os)} · {activeNode.cpuCores}C{" "}
                    {formatSpecGb(activeNode.memTotalMb)}G
                  </span>
                  <span style={{ color: "var(--text-tertiary)" }}>
                    · {activeNode.regionCode}
                  </span>
                  {activeNode.online && (
                    <span className="font-mono-num inline-flex items-center gap-2 text-[12px] font-medium">
                      <span style={{ color: "var(--text-muted)" }}>·</span>
                      <span style={{ color: "var(--accent-ink)" }}>
                        ↓ {formatRateKbps(activeNode.netRxKbps)}
                      </span>
                      <span style={{ color: "var(--status-ok-ink)" }}>
                        ↑ {formatRateKbps(activeNode.netTxKbps)}
                      </span>
                    </span>
                  )}
                </div>
              </div>

              <button
                type="button"
                autoFocus
                aria-label="关闭详情"
                onClick={onClose}
                style={{ color: "var(--text-tertiary)" }}
                className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>

            {/* 3 Clean Tabs */}
            <div
              role="tablist"
              aria-label="服务器详情视图"
              className="uniob-tablist border-b-0"
            >
              {(
                [
                  { id: "telemetry" as const, label: "监控图表" },
                  { id: "processes" as const, label: "进程" },
                  { id: "hardware" as const, label: "系统信息" },
                ] as const
              ).map((tab, idx) => {
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(el) => {
                      tabRefs.current[tab.id] = el;
                    }}
                    id={`${baseId}-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onTabChange(tab.id)}
                    onKeyDown={(e) => handleTabKeyDown(e, idx)}
                    className="uniob-tab"
                  >
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </header>

          {/* ================================================================
           * 2. Scrollable Tab Panels
           * ================================================================ */}
          <div
            style={{ backgroundColor: "var(--bg-subtle)" }}
            className="thin-scrollbar min-w-0 flex-1 overflow-y-auto px-6 py-5"
          >
            {/* ==============================================================
             * TAB 1: 监控图表 (4 Clinical ObservabilityChart Panels)
             * ============================================================== */}
            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-telemetry`}
              hidden={activeTab !== "telemetry"}
            >
              <div className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <SegmentedControl<TelemetryRange>
                    ariaLabel="时间范围"
                    value={range}
                    onChange={setRange}
                    options={[
                      { value: "10m", label: "实时" },
                      { value: "1h", label: "1 小时" },
                      { value: "24h", label: "24 小时" },
                    ]}
                  />
                  {activeNode.online && (
                    <span
                      style={{ color: "var(--text-tertiary)" }}
                      className="font-mono-num text-[12px]"
                    >
                      负载 {activeNode.load[0].toFixed(2)} /{" "}
                      {activeNode.load[1].toFixed(2)} /{" "}
                      {activeNode.load[2].toFixed(2)}
                    </span>
                  )}
                </div>

                <div className="min-w-0 space-y-3.5">
                  {/* Panel 1: 实时网络吞吐 ↓/↑ */}
                  <TelemetryPanel
                    title="实时网络吞吐"
                    icon={
                      <Network className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    isRateKbps
                    timeLabels={chartData.timeLabels}
                    hoverIndex={hoverIdx}
                    onHoverIndexChange={setHoverIdx}
                    series={[
                      {
                        label: "↓ 下行",
                        color: "var(--accent)",
                        data: chartData.rxArr,
                      },
                      {
                        label: "↑ 上行",
                        color: "var(--status-ok)",
                        data: chartData.txArr,
                      },
                    ]}
                    stats={{
                      current: `↓ ${formatRateKbps(chartData.netStats.current)} · ↑ ${formatRateKbps(chartData.txArr[chartData.txArr.length - 1] ?? 0)}`,
                      avg: formatRateKbps(chartData.netStats.avg),
                      peak: formatRateKbps(chartData.netStats.peak),
                    }}
                  />

                  {/* Panel 2: CPU 使用率 */}
                  <TelemetryPanel
                    title="CPU 使用率"
                    icon={<Cpu className="h-3.5 w-3.5" aria-hidden="true" />}
                    yMax={100}
                    yUnit="%"
                    timeLabels={chartData.timeLabels}
                    hoverIndex={hoverIdx}
                    onHoverIndexChange={setHoverIdx}
                    series={[
                      {
                        label: "CPU",
                        color: "var(--accent)",
                        data: chartData.cpuArr,
                      },
                    ]}
                    stats={{
                      current: `${chartData.cpuStats.current.toFixed(1)}%`,
                      avg: `${chartData.cpuStats.avg.toFixed(1)}%`,
                      peak: `${chartData.cpuStats.peak.toFixed(1)}%`,
                    }}
                  />

                  {/* Panel 3: 内存与交换区 */}
                  <TelemetryPanel
                    title="内存与交换区"
                    icon={
                      <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    yMax={100}
                    yUnit="%"
                    timeLabels={chartData.timeLabels}
                    hoverIndex={hoverIdx}
                    onHoverIndexChange={setHoverIdx}
                    series={
                      activeNode.swapTotalMb > 0
                        ? [
                            {
                              label: "内存",
                              color: "var(--accent)",
                              data: chartData.memArr,
                            },
                            {
                              label: "交换区",
                              color: "var(--status-warn)",
                              data: chartData.swapArr,
                              dashed: true,
                            },
                          ]
                        : [
                            {
                              label: "内存",
                              color: "var(--accent)",
                              data: chartData.memArr,
                            },
                          ]
                    }
                    stats={{
                      current: `${chartData.memStats.current.toFixed(1)}%`,
                      avg: `${chartData.memStats.avg.toFixed(1)}%`,
                      peak: `${chartData.memStats.peak.toFixed(1)}%`,
                    }}
                  />

                  {/* Panel 4: 磁盘读写吞吐 */}
                  <TelemetryPanel
                    title="磁盘读写吞吐"
                    icon={
                      <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    isRateKbps
                    timeLabels={chartData.timeLabels}
                    hoverIndex={hoverIdx}
                    onHoverIndexChange={setHoverIdx}
                    series={[
                      {
                        label: "读",
                        color: "var(--accent)",
                        data: chartData.diskReadArr,
                      },
                      {
                        label: "写",
                        color: "var(--status-ok)",
                        data: chartData.diskWriteArr,
                      },
                    ]}
                    stats={{
                      current: `${formatRateKbps(chartData.diskStats.current)} / ${formatRateKbps(chartData.diskWriteArr[chartData.diskWriteArr.length - 1] ?? 0)}`,
                      avg: formatRateKbps(chartData.diskStats.avg),
                      peak: formatRateKbps(chartData.diskStats.peak),
                    }}
                  />
                </div>
              </div>
            </div>

            {/* ==============================================================
             * TAB 2: 进程
             * ============================================================== */}
            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-processes`}
              hidden={activeTab !== "processes"}
            >
              <div className="space-y-4">
                {!activeNode.online ? (
                  <Card className="py-12 text-center">
                    <p
                      style={{ color: "var(--text-secondary)" }}
                      className="text-[13px]"
                    >
                      服务器当前离线
                    </p>
                  </Card>
                ) : !activeNode.procEnabled ? (
                  <Card className="py-12 text-center">
                    <p
                      style={{ color: "var(--text-secondary)" }}
                      className="text-[13px]"
                    >
                      未开启进程查看
                    </p>
                  </Card>
                ) : (
                  <>
                    {/* Single Clean Control Row: Segmented Control + Compact 90s Ring Timer */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <SegmentedControl<"0" | "1" | "2">
                        ariaLabel="进程显示数量"
                        value={String(gear) as "0" | "1" | "2"}
                        onChange={(v) =>
                          handleSelectGear(Number(v) as ProcessGear)
                        }
                        options={[
                          { value: "0", label: "关闭" },
                          { value: "1", label: "前 15" },
                          {
                            value: "2",
                            label: "全部",
                            badge: activeNode.processes.length,
                          },
                        ]}
                      />

                      {gear > 0 && (
                        <div
                          style={{
                            backgroundColor: "var(--bg-card)",
                            border: "1px solid var(--border-subtle)",
                          }}
                          className="inline-flex h-8 items-center gap-2 rounded-[8px] px-2.5"
                        >
                          <LeaseCountdownRing
                            remainingSec={leaseSec}
                            totalSec={LEASE_TOTAL_SECONDS}
                          />
                          <span className="font-mono-num text-[12px] font-medium">
                            {leaseSec}s
                          </span>
                          <button
                            type="button"
                            onClick={handleRenewLease}
                            style={{ color: "var(--accent-ink)" }}
                            className="inline-flex cursor-pointer items-center gap-1 pl-1 text-[12px] font-medium hover:opacity-80"
                          >
                            <RotateCcw
                              className="h-3 w-3"
                              aria-hidden="true"
                            />
                            <span>续期</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {gear === 0 ? (
                      <Card className="py-12 text-center">
                        <p
                          style={{ color: "var(--text-secondary)" }}
                          className="mb-3 text-[13px]"
                        >
                          进程查看已关闭
                        </p>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleSelectGear(1)}
                        >
                          查看前 15
                        </Button>
                      </Card>
                    ) : (
                      <div className="atelier-card overflow-hidden">
                        <div
                          tabIndex={0}
                          role="region"
                          aria-labelledby={procCaptionId}
                          className="table-scroll-region thin-scrollbar"
                        >
                          <table className="uniob-table">
                            <caption id={procCaptionId} className="sr-only">
                              进程列表
                            </caption>
                            <thead>
                              <tr>
                                <th
                                  scope="col"
                                  aria-sort={
                                    procSortKey === "pid"
                                      ? procSortDesc
                                        ? "descending"
                                        : "ascending"
                                      : undefined
                                  }
                                >
                                  <button
                                    type="button"
                                    onClick={() => handleProcSort("pid")}
                                  >
                                    <span>PID</span>
                                    {renderProcSortIcon("pid")}
                                  </button>
                                </th>

                                <th
                                  scope="col"
                                  aria-sort={
                                    procSortKey === "comm"
                                      ? procSortDesc
                                        ? "descending"
                                        : "ascending"
                                      : undefined
                                  }
                                >
                                  <button
                                    type="button"
                                    onClick={() => handleProcSort("comm")}
                                  >
                                    <span>进程名</span>
                                    {renderProcSortIcon("comm")}
                                  </button>
                                </th>

                                <th
                                  scope="col"
                                  aria-sort={
                                    procSortKey === "cpuPct"
                                      ? procSortDesc
                                        ? "descending"
                                        : "ascending"
                                      : undefined
                                  }
                                >
                                  <button
                                    type="button"
                                    onClick={() => handleProcSort("cpuPct")}
                                  >
                                    <span>CPU</span>
                                    {renderProcSortIcon("cpuPct")}
                                  </button>
                                </th>

                                <th
                                  scope="col"
                                  aria-sort={
                                    procSortKey === "rssMb"
                                      ? procSortDesc
                                        ? "descending"
                                        : "ascending"
                                      : undefined
                                  }
                                >
                                  <button
                                    type="button"
                                    onClick={() => handleProcSort("rssMb")}
                                  >
                                    <span>内存</span>
                                    {renderProcSortIcon("rssMb")}
                                  </button>
                                </th>

                                <th
                                  scope="col"
                                  aria-sort={
                                    procSortKey === "cmd"
                                      ? procSortDesc
                                        ? "descending"
                                        : "ascending"
                                      : undefined
                                  }
                                >
                                  <button
                                    type="button"
                                    onClick={() => handleProcSort("cmd")}
                                  >
                                    <span>命令</span>
                                    {renderProcSortIcon("cmd")}
                                  </button>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortedProcesses.map((proc) => (
                                <tr key={proc.pid}>
                                  <td
                                    style={{ color: "var(--text-secondary)" }}
                                    className="font-mono-num w-[72px] text-[12px]"
                                  >
                                    {proc.pid}
                                  </td>
                                  <td className="min-w-[110px] font-medium">
                                    {proc.comm}
                                  </td>
                                  <td className="font-mono-num w-[84px] text-[12.5px]">
                                    {proc.cpuPct.toFixed(1)}%
                                  </td>
                                  <td className="font-mono-num w-[96px] text-[12.5px]">
                                    {formatMemAmount(proc.rssMb)}
                                  </td>
                                  <td className="min-w-[240px]">
                                    <div
                                      style={{ color: "var(--text-secondary)" }}
                                      className="max-w-[320px] truncate font-mono text-[11.5px]"
                                    >
                                      {renderCleanCommand(proc.sanitizedCmd)}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div role="status" className="sr-only">
                          {procSortAnnouncement}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* ==============================================================
             * TAB 3: 系统信息
             * ============================================================== */}
            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-hardware`}
              hidden={activeTab !== "hardware"}
            >
              <div className="space-y-4">
                {/* 1. Clean 4-Item Hardware Summary */}
                <Card className="p-5">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[12px]"
                      >
                        操作系统
                      </div>
                      <div className="text-[13.5px] font-medium">
                        {activeNode.os} · {activeNode.arch}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[12px]"
                      >
                        处理器
                      </div>
                      <div className="truncate text-[13.5px] font-medium">
                        {activeNode.cpuModel} ({activeNode.cpuCores} 核)
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[12px]"
                      >
                        内存容量
                      </div>
                      <div className="font-mono-num text-[13.5px] font-medium">
                        {formatMemAmount(activeNode.memTotalMb)}
                        {activeNode.swapTotalMb > 0
                          ? ` · 交换 ${formatMemAmount(activeNode.swapTotalMb)}`
                          : ""}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[12px]"
                      >
                        在线时长
                      </div>
                      <div className="font-mono-num text-[13.5px] font-medium">
                        {activeNode.online
                          ? `${activeNode.uptimeDays} 天`
                          : "离线"}
                      </div>
                    </div>
                  </div>
                </Card>

                {/* 2. Monthly Traffic Ring + Bar */}
                <Card className="p-5">
                  <div className="flex items-center gap-4">
                    <TrafficProgressRing valuePct={trafficPct} />
                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-[13.5px] font-semibold">
                          月度流量
                        </h3>
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="font-mono-num text-[12px]"
                        >
                          剩余 {activeNode.trafficDaysRemaining} 天
                        </span>
                      </div>
                      <MetricBar
                        valuePct={trafficPct}
                        valueLabel={
                          activeNode.monthlyTrafficLimitGb
                            ? `${formatTrafficGb(activeNode.monthlyTrafficUsedGb)} / ${formatTrafficGb(activeNode.monthlyTrafficLimitGb)}`
                            : formatTrafficGb(activeNode.monthlyTrafficUsedGb)
                        }
                        thickness={4}
                      />
                    </div>
                  </div>
                </Card>

                {/* 3. Visual Disk Mount Bars */}
                <Card className="space-y-4 p-5">
                  <h3 className="text-[13.5px] font-semibold">磁盘空间</h3>
                  <div className="space-y-3.5">
                    {activeNode.mounts.map((mount) => {
                      const pct =
                        mount.totalGb > 0
                          ? (mount.usedGb / mount.totalGb) * 100
                          : 0;
                      return (
                        <div key={mount.mountpoint} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-[12.5px]">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-medium">
                                {mount.mountpoint}
                              </span>
                              <Badge tone="subtle">{mount.fsType}</Badge>
                            </div>
                            <span className="font-mono-num font-medium">
                              {mount.usedGb.toFixed(1)} / {mount.totalGb} GB
                            </span>
                          </div>
                          <MetricBar valuePct={pct} thickness={4} />
                        </div>
                      );
                    })}
                  </div>
                </Card>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="p-6">
          <h2 id={titleId} className="text-[15px] font-semibold">
            服务器详情
          </h2>
        </div>
      )}
    </NativeDialog>
  );
}

export default NodeInspectorDrawer;
