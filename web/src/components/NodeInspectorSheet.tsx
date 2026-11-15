import { useEffect, useId, useRef, useState } from "react";
import {
  Activity,
  BellOff,
  Cpu,
  Globe,
  HardDrive,
  Lock,
  Terminal,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
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
  formatBytes,
  formatNodeMetaLine,
  formatRelativeTime,
  formatUptime,
  getDiskUsagePct,
  getMemTotalBytes,
  getMemUsagePct,
  getRootDisk,
  isNodeMuted,
  parseOsBadge,
} from "../utils/format";
import { TelemetryChartsPanel } from "./TelemetryChartsPanel";
import { ProcessExplorer } from "./ProcessExplorer";
import { HardwareSecurityPanel } from "./HardwareSecurityPanel";

export interface NodeInspectorSheetProps {
  node: HorizonNode | null;
  initialTab: InspectorTab;
  resolvedTheme: "dark" | "light";
  liveSeries: LiveMetricSample[];
  procsPacket: ProcsPacket | null;
  wsStatus: WsConnectionStatus;
  subNode: (nodeId: string, proc: boolean) => void;
  unsubNode: (nodeId: string) => void;
  onClose: () => void;
  onMuteNode: (nodeId: string, seconds: number | null) => Promise<void>;
  onRotateToken: (nodeId: string) => Promise<RotateTokenResponse>;
  onDeleteNode: (nodeId: string) => Promise<void>;
}

type ChartMode = "live" | MetricsRange;

const INSPECTOR_TABS: {
  key: InspectorTab;
  label: string;
  icon: typeof Activity;
}[] = [
  { key: "charts", label: "实时与历史遥测", icon: Activity },
  { key: "procs", label: "按需进程透视", icon: Terminal },
  { key: "hardware", label: "系统分区与安全", icon: HardDrive },
];

function isOutsideDialogBounds(
  e: React.PointerEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement,
): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

interface NodeInspectorContentProps {
  node: HorizonNode;
  initialTab: InspectorTab;
  resolvedTheme: "dark" | "light";
  liveSeries: LiveMetricSample[];
  procsPacket: ProcsPacket | null;
  wsStatus: WsConnectionStatus;
  activeTab: InspectorTab;
  chartMode: ChartMode;
  onTabChange: (tab: InspectorTab) => void;
  onChartModeChange: (mode: ChartMode) => void;
  titleId: string;
  onClose: () => void;
  onMuteNode: (nodeId: string, seconds: number | null) => Promise<void>;
  onRotateToken: (nodeId: string) => Promise<RotateTokenResponse>;
  onDeleteNode: (nodeId: string) => Promise<void>;
}

function NodeInspectorContent({
  node,
  resolvedTheme,
  liveSeries,
  procsPacket,
  wsStatus,
  activeTab,
  chartMode,
  onTabChange,
  onChartModeChange,
  titleId,
  onClose,
  onMuteNode,
  onRotateToken,
  onDeleteNode,
}: NodeInspectorContentProps): React.JSX.Element {
  const baseId = useId();
  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({
    charts: null,
    procs: null,
    hardware: null,
  });

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    const order: InspectorTab[] = ["charts", "procs", "hardware"];
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % order.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (idx - 1 + order.length) % order.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = order.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const nextTab = order[nextIdx];
    onTabChange(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const osBadge = parseOsBadge(node.os);
  const muted = isNodeMuted(node);
  const m = node.metrics;
  const memPct = getMemUsagePct(node);
  const memTotal = getMemTotalBytes(node);
  const rootDisk = getRootDisk(m?.disks);
  const diskPct = getDiskUsagePct(rootDisk);
  const metaLine = formatNodeMetaLine(node, { includeHostnameFallback: true });

  return (
    <>
      {/* Frosted Glass Summary Header */}
      <header className="shrink-0 surface-glass border-x-0 border-t-0 px-4 sm:px-6 pt-4 pb-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            {/* Title & Identity Row */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                  node.online
                    ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/35"
                    : "bg-rose-500/12 text-rose-700 dark:text-rose-300 border-rose-500/35"
                }`}
              >
                <span
                  className="relative flex h-2 w-2 shrink-0"
                  aria-hidden="true"
                >
                  {node.online && (
                    <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                  )}
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      node.online ? "bg-emerald-500" : "bg-rose-500"
                    }`}
                  />
                </span>
                {node.online ? (
                  <Wifi className="w-3 h-3 shrink-0" aria-hidden="true" />
                ) : (
                  <WifiOff className="w-3 h-3 shrink-0" aria-hidden="true" />
                )}
                <span>{node.online ? "在线实时" : "离线告警"}</span>
              </span>

              <h2
                id={titleId}
                className="text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50 truncate"
              >
                {node.name}
              </h2>

              {node.group_name && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 dark:bg-slate-800/90 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                  {node.group_name}
                </span>
              )}

              <span
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium border ${osBadge.colorClass}`}
              >
                {osBadge.short}
              </span>

              {muted && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35">
                  <BellOff className="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span>告警静默中</span>
                </span>
              )}
            </div>

            {/* Geo / Provider / Agent / Uptime / Load Capsules */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-mono-num text-slate-600 dark:text-slate-300">
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <Globe
                  className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0"
                  aria-hidden="true"
                />
                <span className="truncate">
                  {node.region_flag ? `${node.region_flag} ` : ""}
                  {metaLine || "Linux 节点"}
                </span>
              </span>

              <span
                className="text-slate-300 dark:text-slate-700"
                aria-hidden="true"
              >
                |
              </span>

              <span>
                探针{" "}
                <strong className="text-slate-800 dark:text-slate-100">
                  {node.agent_version ? `v${node.agent_version}` : "未连接"}
                </strong>
              </span>

              <span>
                {node.online
                  ? `Uptime ${formatUptime(m?.up)}`
                  : `离线 ${formatRelativeTime(node.last_seen_ts)}`}
              </span>

              {m && (
                <>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100/90 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 text-[11px]">
                    <Cpu
                      className="w-3 h-3 text-[var(--accent-primary)]"
                      aria-hidden="true"
                    />
                    <span>
                      Load {m.cpu.load.map((v) => v.toFixed(2)).join(" / ")}
                    </span>
                  </span>

                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    CPU {m.cpu.all.toFixed(1)}% · 内存 {formatBytes(m.mem.used)}/
                    {formatBytes(memTotal)} ({memPct.toFixed(0)}%)
                    {rootDisk ? ` · 根分区 ${diskPct.toFixed(0)}%` : ""}
                  </span>
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭节点详情透视面板"
            className="shrink-0 p-2 rounded-lg border border-slate-200 dark:border-slate-700/90 bg-white/80 dark:bg-slate-900/70 text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Single-Row Accessible Tablist */}
        <div
          role="tablist"
          aria-label="节点透视视图"
          className="mt-3.5 flex items-center gap-1 border-t border-slate-200/70 dark:border-slate-800/80 pt-1"
        >
          {INSPECTOR_TABS.map((tab, idx) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                ref={(el) => {
                  tabRefs.current[tab.key] = el;
                }}
                id={`${baseId}-tab-${tab.key}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`${baseId}-panel-${tab.key}`}
                tabIndex={active ? 0 : -1}
                onClick={() => onTabChange(tab.key)}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold transition-colors rounded-t-md ${
                  active
                    ? "text-[var(--accent-primary)]"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>{tab.label}</span>
                {tab.key === "procs" && node.proc_enabled === false && (
                  <Lock
                    className="w-3 h-3 text-amber-500 shrink-0"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      </header>

      {/* Scrollable Body */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div
          role="tabpanel"
          id={`${baseId}-panel-charts`}
          aria-labelledby={`${baseId}-tab-charts`}
          hidden={activeTab !== "charts"}
        >
          {activeTab === "charts" && (
            <div className="p-4 sm:p-6">
              <TelemetryChartsPanel
                node={node}
                resolvedTheme={resolvedTheme}
                liveSeries={liveSeries}
                chartMode={chartMode}
                onChartModeChange={onChartModeChange}
                wsStatus={wsStatus}
              />
            </div>
          )}
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel-procs`}
          aria-labelledby={`${baseId}-tab-procs`}
          hidden={activeTab !== "procs"}
        >
          {activeTab === "procs" && (
            <div className="p-4 sm:p-6">
              <ProcessExplorer
                node={node}
                procsPacket={procsPacket}
                wsStatus={wsStatus}
              />
            </div>
          )}
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel-hardware`}
          aria-labelledby={`${baseId}-tab-hardware`}
          hidden={activeTab !== "hardware"}
        >
          {activeTab === "hardware" && (
            <div className="p-4 sm:p-6">
              <HardwareSecurityPanel
                node={node}
                onMuteNode={onMuteNode}
                onRotateToken={onRotateToken}
                onDeleteNode={onDeleteNode}
                onClose={onClose}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function NodeInspectorSheet({
  node,
  initialTab,
  resolvedTheme,
  liveSeries,
  procsPacket,
  wsStatus,
  subNode,
  unsubNode,
  onClose,
  onMuteNode,
  onRotateToken,
  onDeleteNode,
}: NodeInspectorSheetProps): React.JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pointerDownBackdropRef = useRef(false);
  const syncingCloseRef = useRef(false);

  const [activeTab, setActiveTab] = useState<InspectorTab>(initialTab);
  const [chartMode, setChartMode] = useState<ChartMode>("live");
  const prevNodeIdRef = useRef<string | null>(node?.id ?? null);

  const currentNodeId = node?.id ?? null;
  if (prevNodeIdRef.current !== currentNodeId) {
    prevNodeIdRef.current = currentNodeId;
    setChartMode("live");
    if (currentNodeId !== null) {
      setActiveTab(initialTab);
    }
  }

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Strict SCCH Zero-Hot-Path WebSocket Subscription Guardrail
  const nodeId = node?.id ?? null;
  const procEnabled = node?.proc_enabled !== false;

  useEffect(() => {
    if (nodeId === null) return;

    if (activeTab === "procs" && procEnabled) {
      subNode(nodeId, true);
    } else if (activeTab === "charts" && chartMode === "live") {
      subNode(nodeId, false);
    } else {
      unsubNode(nodeId);
    }
  }, [nodeId, activeTab, chartMode, procEnabled, subNode, unsubNode]);

  useEffect(() => {
    if (nodeId === null) return;
    return () => {
      unsubNode(nodeId);
    };
  }, [nodeId, unsubNode]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (node) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      syncingCloseRef.current = true;
      dialog.close();
      syncingCloseRef.current = false;
    }
  }, [node]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      pointerDownBackdropRef.current =
        e.target === dialog && isOutsideDialogBounds(e, dialog);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const dialog = dialogRef.current;
      const startedOnBackdrop = pointerDownBackdropRef.current;
      pointerDownBackdropRef.current = false;
      if (!dialog || !startedOnBackdrop) return;
      if (e.target === dialog && isOutsideDialogBounds(e, dialog)) {
        onClose();
      }
    }
  };

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    onClose();
  };

  const handleNativeClose = () => {
    if (!syncingCloseRef.current && node !== null) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby={node ? titleId : undefined}
      aria-label={node ? undefined : "节点详情透视面板"}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onCancel={handleCancel}
      onClose={handleNativeClose}
      className="ml-auto mr-0 my-0 h-[100dvh] max-h-[100dvh] w-full max-w-5xl overflow-hidden overscroll-contain border-l border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-primary)] shadow-2xl"
    >
      {/* Flex layout strictly inside single inner wrapper so <dialog> stays display:none when closed */}
      <div className="flex flex-col h-full w-full min-h-0 bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        {node && (
          <NodeInspectorContent
            key={node.id}
            node={node}
            initialTab={initialTab}
            resolvedTheme={resolvedTheme}
            liveSeries={liveSeries}
            procsPacket={procsPacket}
            wsStatus={wsStatus}
            activeTab={activeTab}
            chartMode={chartMode}
            onTabChange={setActiveTab}
            onChartModeChange={setChartMode}
            titleId={titleId}
            onClose={onClose}
            onMuteNode={onMuteNode}
            onRotateToken={onRotateToken}
            onDeleteNode={onDeleteNode}
          />
        )}
      </div>
    </dialog>
  );
}
