import React, { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  Badge,
  CopyButton,
  NativeDialog,
  StatusDot,
  formatBytesPerSec,
  type StatusDotTone,
} from "./ui/Primitives";
import type {
  HorizonNode,
  InspectorTab,
  MetricsRange,
  RotateTokenResponse,
} from "../types";
import type {
  LiveMetricSample,
  ProcsPacket,
  WsConnectionStatus,
} from "../hooks/useFleetSocket";
import {
  getMemTotalBytes,
  getMemUsagePct,
  isNodeMuted,
} from "../utils/format";
import { TelemetryChartsPanel } from "./TelemetryChartsPanel";
import { ProcessExplorer, type ProcDisplayGear } from "./ProcessExplorer";
import { HardwareSecurityPanel } from "./HardwareSecurityPanel";

export interface NodeInspectorSheetProps {
  node: HorizonNode | null;
  initialTab: InspectorTab;
  resolvedTheme: "dark" | "light";
  liveSeries: LiveMetricSample[];
  procsPacket: ProcsPacket | null;
  wsStatus: WsConnectionStatus;
  liveNodeId: string | null;
  subNode: (nodeId: string, proc: boolean) => void;
  unsubNode: (nodeId: string) => void;
  onClose: () => void;
  onMuteNode: (nodeId: string, seconds: number | null) => Promise<void>;
  onRotateToken: (nodeId: string) => Promise<RotateTokenResponse>;
  onDeleteNode: (nodeId: string) => Promise<void>;
}

type ChartMode = "live" | MetricsRange;

const LEASE_TOTAL_SECONDS = 90;

function formatShortOs(os: string | null | undefined): string {
  if (!os) return "Linux";
  return os
    .replace(/\s+(Bookworm|Bullseye|Trixie|Noble|Jammy|Focal|LTS)$/i, "")
    .trim();
}

function formatSpecLine(node: HorizonNode): string {
  const osPart = formatShortOs(node.os);
  const memTotal = getMemTotalBytes(node);
  const gb = memTotal > 0 ? memTotal / (1024 * 1024 * 1024) : 0;
  const gbText =
    gb > 0 ? `${gb >= 1 && Number.isInteger(Math.round(gb * 10) / 10) ? Math.round(gb) : gb.toFixed(1)}G` : "";
  const coreText = node.cpu_cores ? `${node.cpu_cores}C` : "";
  const spec = [coreText, gbText].filter(Boolean).join(" ");
  return [osPart, spec].filter(Boolean).join(" · ");
}

export function NodeInspectorSheet({
  node,
  initialTab,
  resolvedTheme,
  liveSeries,
  procsPacket,
  wsStatus,
  liveNodeId,
  subNode,
  unsubNode,
  onClose,
  onMuteNode,
  onRotateToken,
  onDeleteNode,
}: NodeInspectorSheetProps): React.JSX.Element {
  const baseId = useId();
  const titleId = `${baseId}-inspector-title`;

  // Preserve last active node during smooth <dialog> exit animation
  const lastNodeRef = useRef<HorizonNode | null>(node);
  if (node) {
    lastNodeRef.current = node;
  }
  const activeNode = node ?? lastNodeRef.current;

  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({
    charts: null,
    procs: null,
    hardware: null,
  });

  const [activeTab, setActiveTab] = useState<InspectorTab>(initialTab);
  const [chartMode, setChartMode] = useState<ChartMode>("live");
  const [procGear, setProcGear] = useState<ProcDisplayGear>("top15");
  const [leaseSec, setLeaseSec] = useState<number>(LEASE_TOTAL_SECONDS);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!node) return;
    setChartMode("live");
    setActiveTab(initialTab);
    if (node.online && node.proc_enabled !== false) {
      setProcGear("top15");
      setLeaseSec(LEASE_TOTAL_SECONDS);
    } else {
      setProcGear("off");
      setLeaseSec(0);
    }
  }, [node?.id]);

  // Real WebSocket node subscription lifecycle
  const currentNodeId = node?.id ?? null;
  const procEnabled = node?.proc_enabled !== false;

  useEffect(() => {
    if (currentNodeId === null) return;

    if (activeTab === "procs" && procEnabled && procGear !== "off") {
      subNode(currentNodeId, true);
    } else if (activeTab === "charts" && chartMode === "live") {
      subNode(currentNodeId, false);
    } else {
      unsubNode(currentNodeId);
    }
  }, [
    currentNodeId,
    activeTab,
    chartMode,
    procEnabled,
    procGear,
    subNode,
    unsubNode,
  ]);

  useEffect(() => {
    if (currentNodeId === null) return;
    return () => {
      unsubNode(currentNodeId);
    };
  }, [currentNodeId, unsubNode]);

  // Live 90s auto-close countdown when Process tab stream is active
  useEffect(() => {
    if (
      !node ||
      !node.online ||
      !procEnabled ||
      activeTab !== "procs" ||
      procGear === "off"
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setLeaseSec((prev) => {
        if (prev <= 1) {
          setProcGear("off");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [node?.id, node?.online, procEnabled, activeTab, procGear]);

  const handleProcGearChange = (next: ProcDisplayGear) => {
    setProcGear(next);
    setLeaseSec(next !== "off" ? LEASE_TOTAL_SECONDS : 0);
  };

  const handleRenewLease = () => {
    if (procGear === "off") {
      setProcGear("top15");
    }
    setLeaseSec(LEASE_TOTAL_SECONDS);
    if (currentNodeId && procEnabled) {
      subNode(currentNodeId, true);
    }
  };

  const tabOrder: InspectorTab[] = ["charts", "procs", "hardware"];
  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabOrder.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (idx - 1 + tabOrder.length) % tabOrder.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabOrder.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const target = tabOrder[nextIdx];
    if (target) {
      setActiveTab(target);
      tabRefs.current[target]?.focus();
    }
  };

  const statusTone: StatusDotTone = !activeNode
    ? "idle"
    : !activeNode.online
      ? "danger"
      : (activeNode.metrics?.cpu.all ?? 0) >= 88 ||
          getMemUsagePct(activeNode) >= 88
        ? "warn"
        : "ok";

  const copyTarget = activeNode
    ? activeNode.ipv4_masked || activeNode.hostname || ""
    : "";

  return (
    <NativeDialog
      open={node !== null}
      onClose={onClose}
      titleId={titleId}
      variant="drawer"
      maxWidthClass="max-w-[780px]"
    >
      {activeNode ? (
        <>
          {/* 1. Clean Drawer Header */}
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
                  {isNodeMuted(activeNode) && <Badge tone="subtle">静音</Badge>}
                </div>

                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
                  {copyTarget && (
                    <CopyButton
                      value={copyTarget}
                      label={copyTarget}
                      copiedLabel="已复制"
                      className="font-mono-num"
                    />
                  )}
                  <span style={{ color: "var(--text-secondary)" }}>
                    {formatSpecLine(activeNode)}
                  </span>
                  <span style={{ color: "var(--text-tertiary)" }}>
                    · {activeNode.group_name || activeNode.region_code}
                  </span>
                  {activeNode.online && activeNode.metrics && (
                    <span className="font-mono-num inline-flex items-center gap-2 text-[12px] font-medium">
                      <span style={{ color: "var(--text-muted)" }}>·</span>
                      <span style={{ color: "var(--accent-ink)" }}>
                        ↓ {formatBytesPerSec(activeNode.metrics.net.rx_bps)}
                      </span>
                      <span style={{ color: "var(--status-ok-ink)" }}>
                        ↑ {formatBytesPerSec(activeNode.metrics.net.tx_bps)}
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

            {/* 3 Clean Accessible Tabs */}
            <div
              role="tablist"
              aria-label="服务器详情视图"
              className="uniob-tablist border-b-0"
            >
              {(
                [
                  { id: "charts" as const, label: "监控图表" },
                  { id: "procs" as const, label: "进程" },
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
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(e) => handleTabKeyDown(e, idx)}
                    className="uniob-tab"
                  >
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </header>

          {/* 2. Scrollable Tab Panels */}
          <div
            style={{ backgroundColor: "var(--bg-subtle)" }}
            className="thin-scrollbar min-w-0 flex-1 overflow-y-auto px-6 py-5"
          >
            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-charts`}
              hidden={activeTab !== "charts"}
            >
              {activeTab === "charts" && (
                <TelemetryChartsPanel
                  node={activeNode}
                  active={node !== null && activeTab === "charts"}
                  networkLive={liveNodeId === node?.id}
                  resolvedTheme={resolvedTheme}
                  liveSeries={liveSeries}
                  chartMode={chartMode}
                  onChartModeChange={setChartMode}
                  wsStatus={wsStatus}
                />
              )}
            </div>

            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-procs`}
              hidden={activeTab !== "procs"}
            >
              {activeTab === "procs" && (
                <ProcessExplorer
                  node={activeNode}
                  procsPacket={procsPacket}
                  wsStatus={wsStatus}
                  displayGear={procGear}
                  onDisplayGearChange={handleProcGearChange}
                  leaseSec={leaseSec}
                  leaseTotalSec={LEASE_TOTAL_SECONDS}
                  onRenewLease={handleRenewLease}
                />
              )}
            </div>

            <div
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-hardware`}
              hidden={activeTab !== "hardware"}
            >
              {activeTab === "hardware" && (
                <HardwareSecurityPanel
                  node={activeNode}
                  onMuteNode={onMuteNode}
                  onRotateToken={onRotateToken}
                  onDeleteNode={onDeleteNode}
                  onClose={onClose}
                />
              )}
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
