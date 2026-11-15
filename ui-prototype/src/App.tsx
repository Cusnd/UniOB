import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeftRight,
  Bell,
  Check,
  ChevronDown,
  Layers,
  Moon,
  Palette,
  Plus,
  Search,
  Server,
  Sun,
  Terminal,
} from "lucide-react";
import {
  Badge,
  Button,
  IconCloseButton,
  Kbd,
  MetricBar,
  NativeDialog,
  StatusDot,
  type StatusDotTone,
} from "./components/ui/Primitives";
import {
  INITIAL_ALERT_CHANNELS,
  INITIAL_FLEET_NODES,
  INITIAL_INCIDENTS,
  INITIAL_MIGRATION_STATE,
  INITIAL_SCCH_QUOTA,
  INITIAL_WATERMARK_RULES,
} from "./data/mockFleet";
import type {
  AccentTheme,
  AlertChannel,
  AlertIncidentItem,
  DualHubMigrationState,
  FleetNode,
  HubArchitectureMode,
  InspectorTab,
  NavRoute,
  NodeWatermarkPolicy,
  NoticeTone,
  ProcessGear,
  TelemetryPoint,
  ThemeMode,
  WatermarkRule,
} from "./types";
import { AlertsWatchdogView } from "./views/AlertsWatchdogView";
import { FleetOverview } from "./views/FleetOverview";
import { MigrationStudioView } from "./views/MigrationStudioView";
import { NodeInspectorDrawer } from "./views/NodeInspectorDrawer";
import { ServersProvisionView } from "./views/ServersProvisionView";
import { StyleSystemView } from "./views/StyleSystemView";

interface NavItemConfig {
  id: NavRoute;
  label: string;
  icon: React.ReactNode;
  badge?: string | number;
  badgeTone?: "neutral" | "danger" | "accent";
}

const ACCENT_OPTIONS: Array<{
  id: AccentTheme;
  label: string;
  hex: string;
}> = [
  { id: "cobalt", label: "鸢尾钴蓝", hex: "#3D5AFE" },
  { id: "vermilion", label: "朱砂珊瑚", hex: "#E5484D" },
  { id: "jade", label: "草木翡翠", hex: "#16A34A" },
];

const TONE_TO_DOT: Record<NoticeTone, StatusDotTone> = {
  info: "accent",
  success: "ok",
  warning: "warn",
  danger: "danger",
};

function formatNowHms(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export default function App(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    }
    return "light";
  });

  const [accent, setAccent] = useState<AccentTheme>(() => {
    if (typeof document !== "undefined") {
      const a = document.documentElement.dataset.accent;
      if (a === "vermilion" || a === "jade") return a;
    }
    return "cobalt";
  });

  const [activeRoute, setActiveRoute] = useState<NavRoute>("fleet");
  const [nodes, setNodes] = useState<FleetNode[]>(INITIAL_FLEET_NODES);
  const [incidents] = useState<AlertIncidentItem[]>(INITIAL_INCIDENTS);
  const [rules, setRules] = useState<WatermarkRule[]>(INITIAL_WATERMARK_RULES);
  const [channels, setChannels] = useState<AlertChannel[]>(INITIAL_ALERT_CHANNELS);
  const [migrationState, setMigrationState] = useState<DualHubMigrationState>(
    INITIAL_MIGRATION_STATE,
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("telemetry");
  const [provisionModalOpen, setProvisionModalOpen] = useState(false);

  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [stylePopoverOpen, setStylePopoverOpen] = useState(false);
  const [workspacePopoverOpen, setWorkspacePopoverOpen] = useState(false);

  // Floating bottom-right toast state (keyed so repeat triggers re-animate cleanly)
  const [notice, setNotice] = useState<{
    seq: number;
    message: string;
    tone: NoticeTone;
  } | null>(null);

  const cmdTitleId = useId();
  const stylePopoverRef = useRef<HTMLDivElement | null>(null);
  const workspacePopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", theme);
    try {
      localStorage.setItem("uniob-proto-theme", theme);
    } catch {
      // Ignore storage restrictions
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try {
      localStorage.setItem("uniob-proto-accent", accent);
    } catch {
      // Ignore storage restrictions
    }
  }, [accent]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!stylePopoverOpen && !workspacePopoverOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        stylePopoverOpen &&
        stylePopoverRef.current &&
        target &&
        !stylePopoverRef.current.contains(target)
      ) {
        setStylePopoverOpen(false);
      }
      if (
        workspacePopoverOpen &&
        workspacePopoverRef.current &&
        target &&
        !workspacePopoverRef.current.contains(target)
      ) {
        setWorkspacePopoverOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setStylePopoverOpen(false);
        setWorkspacePopoverOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [stylePopoverOpen, workspacePopoverOpen]);

  // 2s live telemetry stream: shifts & appends real-time points into node.series
  useEffect(() => {
    const timer = window.setInterval(() => {
      const label = formatNowHms();
      const nowTs = Math.floor(Date.now() / 1000);

      setNodes((prev) =>
        prev.map((node, idx) => {
          if (!node.online) return node;

          const lastPt = node.series[node.series.length - 1];
          const baseCpu =
            node.protocolState === "edge_flush"
              ? 91.5
              : Math.max(4, Math.min(82, node.cpuPct));

          // Realistic mean-reverting jitter + occasional micro-bursts
          const burst = Math.random() > 0.85 ? 1.38 + Math.random() * 0.45 : 1.0;
          const cpuDelta =
            (Math.random() - 0.48) * 5.4 +
            (baseCpu - node.cpuPct) * 0.25 +
            (burst > 1 ? 4.5 : 0);
          const nextCpu = Number(
            Math.max(1.2, Math.min(99.2, node.cpuPct + cpuDelta)).toFixed(1),
          );

          const curMemPct =
            node.memTotalMb > 0 ? (node.memUsedMb / node.memTotalMb) * 100 : 40;
          const nextMemPct = Number(
            Math.max(
              8,
              Math.min(97.5, curMemPct + (Math.random() - 0.5) * 1.1),
            ).toFixed(1),
          );
          const nextMemUsedMb = Math.round((nextMemPct / 100) * node.memTotalMb);

          const curSwapPct =
            node.swapTotalMb > 0
              ? (node.swapUsedMb / node.swapTotalMb) * 100
              : 0;
          const nextSwapPct = Number(
            Math.max(
              0,
              Math.min(
                96,
                curSwapPct > 0 ? curSwapPct + (Math.random() - 0.5) * 0.6 : 0,
              ),
            ).toFixed(1),
          );

          // Asymmetric RX/TX traffic jitter & bursts
          const rxAnchor = Math.max(120, lastPt?.rxKbps ?? node.netRxKbps);
          const txAnchor = Math.max(100, lastPt?.txKbps ?? node.netTxKbps);
          const rxFactor =
            (0.76 + Math.random() * 0.48) * (Math.random() > 0.86 ? 1.45 : 1);
          const txFactor =
            (0.78 + Math.random() * 0.44) * (Math.random() > 0.88 ? 1.42 : 1);
          const nextRx = Math.max(
            24,
            Math.round(node.netRxKbps * 0.45 + rxAnchor * rxFactor * 0.55),
          );
          const nextTx = Math.max(
            20,
            Math.round(node.netTxKbps * 0.45 + txAnchor * txFactor * 0.55),
          );

          const prevDiskR = lastPt?.diskReadKbps ?? 64;
          const prevDiskW = lastPt?.diskWriteKbps ?? 140;
          const nextDiskR = Math.max(
            4,
            Math.round(prevDiskR * (0.65 + Math.random() * 0.72) * burst),
          );
          const nextDiskW = Math.max(
            8,
            Math.round(prevDiskW * (0.68 + Math.random() * 0.68) * burst),
          );
          const nextIops = Math.max(
            3,
            Math.round((nextDiskR + nextDiskW) / 9 + (idx % 5) * 2),
          );
          const nextSteal = Number(
            Math.max(
              0,
              Math.min(18, node.cpuStealPct * 0.7 + Math.random() * 0.6),
            ).toFixed(1),
          );
          const nextLoad1 = Number(
            Math.max(0.05, node.load[0] * 0.85 + (nextCpu / 100) * 0.35).toFixed(
              2,
            ),
          );
          const nextTcp = Math.max(
            6,
            Math.round(node.tcpEst + (Math.random() - 0.5) * 10),
          );

          const nextPoint: TelemetryPoint = {
            ts: nowTs,
            label,
            cpu: nextCpu,
            steal: nextSteal,
            load1: nextLoad1,
            memPct: nextMemPct,
            swapPct: nextSwapPct,
            rxKbps: nextRx,
            txKbps: nextTx,
            diskReadKbps: nextDiskR,
            diskWriteKbps: nextDiskW,
            iops: nextIops,
            tcpEst: nextTcp,
          };

          const updatedMounts =
            node.mounts.length > 0
              ? node.mounts.map((m, mIdx) =>
                  mIdx === 0
                    ? { ...m, readKbps: nextDiskR, writeKbps: nextDiskW }
                    : m,
                )
              : node.mounts;

          return {
            ...node,
            cpuPct: nextCpu,
            cpuStealPct: nextSteal,
            load: [nextLoad1, node.load[1], node.load[2]],
            memUsedMb: nextMemUsedMb,
            netRxKbps: nextRx,
            netTxKbps: nextTx,
            tcpEst: nextTcp,
            mounts: updatedMounts,
            series: [...node.series.slice(1), nextPoint],
          };
        }),
      );
    }, 2000);

    return () => window.clearInterval(timer);
  }, []);

  const notify = (message: string, tone: NoticeTone = "info") => {
    setNotice((prev) => ({
      seq: (prev?.seq ?? 0) + 1,
      message,
      tone,
    }));
  };

  // Auto-dismiss floating toast in 2400ms
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(id);
  }, [notice]);

  const onlineCount = useMemo(
    () => nodes.filter((n) => n.online).length,
    [nodes],
  );
  const firingCount = useMemo(
    () => incidents.filter((inc) => inc.status === "firing").length,
    [incidents],
  );

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const handleSelectNode = (nodeId: string, initialTab?: InspectorTab) => {
    setSelectedNodeId(nodeId);
    setInspectorTab(initialTab ?? "telemetry");
  };

  const handleOpenProvision = () => {
    setActiveRoute("servers");
    setProvisionModalOpen(true);
  };

  const handleAddNode = (newNode: FleetNode) => {
    setNodes((prev) => [newNode, ...prev]);
    notify(`已添加 ${newNode.name}`, "success");
  };

  const handleUpdateNodeWatermark = (
    nodeId: string,
    watermark: NodeWatermarkPolicy,
  ) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, watermark } : n)),
    );
    notify("告警阈值已保存", "success");
  };

  const handleGearChange = (nodeId: string, gear: ProcessGear) => {
    const targetName = nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
    notify(
      gear === 0 ? `${targetName} 已关闭进程刷新` : `${targetName} 进程已刷新`,
      "info",
    );
  };

  const handleToggleRule = (ruleId: string) => {
    setRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r)),
    );
  };

  const handleToggleChannel = (channelId: string) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, enabled: !c.enabled } : c)),
    );
  };

  const handleSwitchHubMode = (mode: HubArchitectureMode) => {
    setMigrationState((prev) => ({ ...prev, activeMode: mode }));
    notify(
      mode === "scch-cloud" ? "已切换为云端托管" : "已切换为自建服务端",
      "info",
    );
  };

  const navItems: NavItemConfig[] = [
    {
      id: "fleet",
      label: "机群总览",
      icon: <Activity className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
      badge: `${onlineCount}/${nodes.length}`,
      badgeTone: "neutral",
    },
    {
      id: "servers",
      label: "服务器",
      icon: <Server className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
      badge: nodes.length,
      badgeTone: "neutral",
    },
    {
      id: "alerts",
      label: "告警通知",
      icon: <Bell className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
      badge: firingCount > 0 ? firingCount : undefined,
      badgeTone: "danger",
    },
    {
      id: "migration",
      label: "服务与迁移",
      icon: (
        <ArrowLeftRight className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
      ),
    },
    {
      id: "style-spec",
      label: "设计规范",
      icon: <Palette className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
    },
  ];

  const currentNav =
    navItems.find((item) => item.id === activeRoute) ?? navItems[0]!;

  const quotaPct = Math.round(
    (INITIAL_SCCH_QUOTA.dailyD1WritesUsed /
      INITIAL_SCCH_QUOTA.dailyD1WritesLimit) *
      100,
  );

  const commandItems = useMemo(() => {
    const items: Array<{
      id: string;
      group: string;
      title: string;
      subtitle: string;
      icon: React.ReactNode;
      action: () => void;
    }> = [
      ...navItems.map((nav) => ({
        id: `nav-${nav.id}`,
        group: "页面",
        title: nav.label,
        subtitle: "",
        icon: nav.icon,
        action: () => setActiveRoute(nav.id),
      })),
      {
        id: "act-provision",
        group: "操作",
        title: "添加服务器",
        subtitle: "",
        icon: <Plus className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
        action: handleOpenProvision,
      },
      {
        id: "act-theme",
        group: "外观",
        title: theme === "light" ? "切换深色模式" : "切换浅色模式",
        subtitle: "",
        icon:
          theme === "light" ? (
            <Moon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
          ) : (
            <Sun className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
          ),
        action: () => setTheme((t) => (t === "light" ? "dark" : "light")),
      },
      ...ACCENT_OPTIONS.map((sw) => ({
        id: `act-accent-${sw.id}`,
        group: "主题色",
        title: sw.label,
        subtitle: "",
        icon: (
          <span
            style={{ backgroundColor: sw.hex }}
            className="inline-block h-3 w-3 rounded-full"
            aria-hidden="true"
          />
        ),
        action: () => setAccent(sw.id),
      })),
      ...nodes.map((node) => ({
        id: `node-${node.id}`,
        group: "服务器",
        title: node.name,
        subtitle: `${node.regionCode} · ${node.ipv4}`,
        icon: <Terminal className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
        action: () => handleSelectNode(node.id, "telemetry"),
      })),
    ];

    const q = cmdQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.subtitle.toLowerCase().includes(q) ||
        i.group.toLowerCase().includes(q),
    );
  }, [cmdQuery, nodes, theme, activeRoute]);

  useEffect(() => {
    setCmdIndex(0);
  }, [cmdQuery, cmdOpen]);

  return (
    <div
      style={{ backgroundColor: "var(--bg-shell)", color: "var(--text-primary)" }}
      className="flex h-dvh w-full max-w-full overflow-hidden select-none sm:select-auto"
    >
      {/* Left Unified Sidebar (224px) */}
      <aside
        aria-label="主侧栏"
        className="hidden w-[224px] shrink-0 flex-col justify-between px-3.5 py-4 md:flex"
      >
        <div className="space-y-5">
          {/* Workspace Switcher */}
          <div ref={workspacePopoverRef} className="relative">
            <button
              type="button"
              aria-expanded={workspacePopoverOpen}
              onClick={() => setWorkspacePopoverOpen((v) => !v)}
              className="flex w-full cursor-pointer items-center justify-between rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div
                  style={{
                    backgroundColor: "var(--ink-primary)",
                    color: "var(--ink-on-primary)",
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px]"
                >
                  <Layers className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] leading-tight font-semibold tracking-[-0.01em]">
                    UniOB
                  </div>
                  <div
                    style={{ color: "var(--text-tertiary)" }}
                    className="truncate text-[11px] leading-tight"
                  >
                    {migrationState.activeMode === "scch-cloud"
                      ? "云端托管"
                      : "自建服务端"}
                  </div>
                </div>
              </div>
              <ChevronDown
                style={{ color: "var(--text-tertiary)" }}
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
            </button>

            {workspacePopoverOpen && (
              <div
                style={{
                  backgroundColor: "var(--bg-sheet)",
                  border: "1px solid var(--border-subtle)",
                  boxShadow: "var(--shadow-popover)",
                }}
                className="absolute top-full left-0 z-30 mt-1.5 w-[204px] rounded-[10px] p-1.5"
              >
                {(
                  [
                    { mode: "scch-cloud" as const, title: "云端托管" },
                    { mode: "self-hosted-rust" as const, title: "自建服务端" },
                  ] as const
                ).map((opt) => {
                  const selected = migrationState.activeMode === opt.mode;
                  return (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => {
                        handleSwitchHubMode(opt.mode);
                        setWorkspacePopoverOpen(false);
                      }}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-[7px] px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <span>{opt.title}</span>
                      {selected && (
                        <Check
                          style={{ color: "var(--accent)" }}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Primary Navigation */}
          <nav aria-label="主导航" className="space-y-1">
            {navItems.map((item) => {
              const active = item.id === activeRoute;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setActiveRoute(item.id)}
                  style={
                    active
                      ? {
                          backgroundColor: "var(--bg-sheet)",
                          color: "var(--text-primary)",
                          border: "1px solid var(--border-hairline)",
                          boxShadow: "0 1px 2px rgba(24,24,27,0.03)",
                        }
                      : {
                          backgroundColor: "transparent",
                          color: "var(--text-secondary)",
                          border: "1px solid transparent",
                        }
                  }
                  className="group relative flex h-8 w-full cursor-pointer items-center justify-between rounded-[8px] px-2.5 text-[13px] font-medium transition-all duration-120 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      style={{
                        color: active ? "var(--accent)" : "var(--text-tertiary)",
                      }}
                      className="inline-flex shrink-0 transition-colors"
                    >
                      {item.icon}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.badge !== undefined && (
                    <span
                      style={
                        item.badgeTone === "danger"
                          ? {
                              backgroundColor: "var(--status-danger-bg)",
                              color: "var(--status-danger-ink)",
                            }
                          : {
                              color: "var(--text-tertiary)",
                            }
                      }
                      className="font-mono-num rounded-[5px] px-1.5 py-0.5 text-[11px] leading-none font-medium"
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Minimal Free Quota Widget */}
        <button
          type="button"
          onClick={() => setActiveRoute("migration")}
          style={{
            backgroundColor: "var(--bg-sheet)",
            border: "1px solid var(--border-hairline)",
          }}
          className="w-full cursor-pointer rounded-[10px] p-3 text-left transition-colors hover:border-[var(--border-strong)]"
        >
          <MetricBar
            valuePct={quotaPct}
            label="免费额度"
            valueLabel={`${quotaPct}%`}
            toneOverride="accent"
            thickness={3}
          />
        </button>
      </aside>

      {/* Main Content · Inset Crisp White Sheet (min-w-0 prevents flex overflow clipping) */}
      <div className="flex min-w-0 flex-1 flex-col p-2.5 md:pl-0">
        <main className="atelier-sheet flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Clean 52px Contextual Top Bar */}
          <header
            style={{ borderBottom: "1px solid var(--border-hairline)" }}
            className="flex h-[52px] min-w-0 shrink-0 items-center justify-between gap-3 px-4 sm:px-6"
          >
            <div className="flex min-w-0 items-center gap-3">
              <select
                aria-label="页面导航"
                value={activeRoute}
                onChange={(e) => setActiveRoute(e.target.value as NavRoute)}
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-8 max-w-[140px] rounded-[7px] px-2.5 text-[12.5px] font-medium md:hidden"
              >
                {navItems.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>

              <h1 className="hidden truncate text-[15px] font-semibold tracking-[-0.015em] md:block">
                {currentNav.label}
              </h1>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setCmdOpen(true)}
                aria-label="打开搜索面板 (Ctrl+K)"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                  color: "var(--text-secondary)",
                }}
                className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-[8px] px-2.5 text-[12px] whitespace-nowrap transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} aria-hidden="true" />
                <span className="hidden sm:inline">搜索</span>
                <Kbd>⌘K</Kbd>
              </button>

              {/* Theme & Accent Popover */}
              <div ref={stylePopoverRef} className="relative shrink-0">
                <button
                  type="button"
                  aria-expanded={stylePopoverOpen}
                  aria-label="切换主题与颜色"
                  onClick={() => setStylePopoverOpen((v) => !v)}
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-hairline)",
                    color: "var(--text-secondary)",
                  }}
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-[8px] px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <span
                    style={{ backgroundColor: "var(--accent)" }}
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    aria-hidden="true"
                  />
                  <span className="hidden sm:inline">外观</span>
                </button>

                {stylePopoverOpen && (
                  <div
                    style={{
                      backgroundColor: "var(--bg-sheet)",
                      border: "1px solid var(--border-subtle)",
                      boxShadow: "var(--shadow-popover)",
                    }}
                    className="absolute top-full right-0 z-30 mt-1.5 w-[216px] space-y-3 rounded-[12px] p-3"
                  >
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setTheme("light")}
                        style={{
                          border: `1px solid ${
                            theme === "light"
                              ? "var(--accent)"
                              : "var(--border-subtle)"
                          }`,
                          backgroundColor:
                            theme === "light"
                              ? "var(--accent-soft)"
                              : "var(--bg-subtle)",
                        }}
                        className="flex cursor-pointer items-center justify-center gap-1.5 rounded-[7px] py-1.5 text-[12px] font-medium"
                      >
                        <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>浅色</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setTheme("dark")}
                        style={{
                          border: `1px solid ${
                            theme === "dark"
                              ? "var(--accent)"
                              : "var(--border-subtle)"
                          }`,
                          backgroundColor:
                            theme === "dark"
                              ? "var(--accent-soft)"
                              : "var(--bg-subtle)",
                        }}
                        className="flex cursor-pointer items-center justify-center gap-1.5 rounded-[7px] py-1.5 text-[12px] font-medium"
                      >
                        <Moon className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>深色</span>
                      </button>
                    </div>

                    <div className="space-y-1">
                      {ACCENT_OPTIONS.map((sw) => {
                        const active = accent === sw.id;
                        return (
                          <button
                            key={sw.id}
                            type="button"
                            onClick={() => setAccent(sw.id)}
                            className="flex w-full cursor-pointer items-center justify-between rounded-[7px] px-2 py-1.5 text-left text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
                          >
                            <span className="flex items-center gap-2">
                              <span
                                style={{ backgroundColor: sw.hex }}
                                className="h-3 w-3 rounded-full"
                                aria-hidden="true"
                              />
                              <span>{sw.label}</span>
                            </span>
                            {active && (
                              <Check
                                style={{ color: "var(--accent)" }}
                                className="h-3.5 w-3.5 shrink-0"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Primary CTA: + 添加服务器 */}
              <Button
                variant="primary"
                size="sm"
                className="shrink-0"
                onClick={handleOpenProvision}
                icon={<Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
              >
                添加服务器
              </Button>
            </div>
          </header>

          {/* Generous Airy Sheet Canvas */}
          <div className="thin-scrollbar min-w-0 flex-1 overflow-y-auto px-6 py-6 md:px-9 md:py-8">
            <div className="mx-auto min-w-0 max-w-[1320px]">
              {activeRoute === "fleet" && (
                <FleetOverview
                  nodes={nodes}
                  scchQuota={INITIAL_SCCH_QUOTA}
                  incidents={incidents}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={handleSelectNode}
                  onOpenProvision={handleOpenProvision}
                  onNavigate={setActiveRoute}
                />
              )}

              {activeRoute === "servers" && (
                <ServersProvisionView
                  nodes={nodes}
                  provisionModalOpen={provisionModalOpen}
                  onOpenProvisionModal={() => setProvisionModalOpen(true)}
                  onCloseProvisionModal={() => setProvisionModalOpen(false)}
                  onAddNode={handleAddNode}
                  onUpdateNodeWatermark={handleUpdateNodeWatermark}
                  onInspectNode={handleSelectNode}
                  onNotify={notify}
                />
              )}

              {activeRoute === "alerts" && (
                <AlertsWatchdogView
                  incidents={incidents}
                  rules={rules}
                  channels={channels}
                  nodes={nodes}
                  onToggleRule={handleToggleRule}
                  onToggleChannel={handleToggleChannel}
                  onInspectNode={handleSelectNode}
                  onNotify={notify}
                />
              )}

              {activeRoute === "migration" && (
                <MigrationStudioView
                  migrationState={migrationState}
                  scchQuota={INITIAL_SCCH_QUOTA}
                  nodes={nodes}
                  onSwitchHubMode={handleSwitchHubMode}
                  onNotify={notify}
                />
              )}

              {activeRoute === "style-spec" && (
                <StyleSystemView
                  theme={theme}
                  accent={accent}
                  onThemeChange={setTheme}
                  onAccentChange={setAccent}
                  onNotify={notify}
                />
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Non-Intrusive Floating Auto-Dismiss Toast (Bottom-Right, Zero Layout Shift) */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-5 bottom-5 z-50"
      >
        {notice && (
          <div
            key={notice.seq}
            className="uniob-floating-toast pointer-events-auto flex items-center gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[13px] font-medium"
          >
            <StatusDot tone={TONE_TO_DOT[notice.tone]} />
            <span>{notice.message}</span>
          </div>
        )}
      </div>

      {/* Slide-Over Node Inspector Drawer */}
      <NodeInspectorDrawer
        node={selectedNode}
        open={selectedNode !== null}
        activeTab={inspectorTab}
        onTabChange={setInspectorTab}
        onClose={() => setSelectedNodeId(null)}
        onGearChange={handleGearChange}
        onNotify={notify}
      />

      {/* ⌘K Command Palette */}
      <NativeDialog
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        titleId={cmdTitleId}
        variant="modal"
        maxWidthClass="max-w-[500px]"
      >
        <div
          style={{ borderBottom: "1px solid var(--border-hairline)" }}
          className="flex items-center gap-2.5 px-4 py-3"
        >
          <Search
            style={{ color: "var(--text-tertiary)" }}
            className="h-4 w-4 shrink-0"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          <h2 id={cmdTitleId} className="sr-only">
            全局搜索
          </h2>
          <input
            type="search"
            autoFocus
            value={cmdQuery}
            onChange={(e) => setCmdQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCmdIndex((i) =>
                  commandItems.length ? (i + 1) % commandItems.length : 0,
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCmdIndex((i) =>
                  commandItems.length
                    ? (i - 1 + commandItems.length) % commandItems.length
                    : 0,
                );
              } else if (e.key === "Enter" && commandItems[cmdIndex]) {
                e.preventDefault();
                commandItems[cmdIndex].action();
                setCmdOpen(false);
              }
            }}
            placeholder="搜索服务器、IP 或页面…"
            aria-label="搜索关键词"
            className="h-7 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <IconCloseButton
            onClick={() => setCmdOpen(false)}
            ariaLabel="关闭搜索面板"
          />
        </div>

        <div className="thin-scrollbar max-h-[340px] overflow-y-auto p-2">
          {commandItems.length === 0 ? (
            <div
              style={{ color: "var(--text-tertiary)" }}
              className="py-8 text-center text-[12.5px]"
            >
              无匹配结果
            </div>
          ) : (
            <div className="space-y-0.5">
              {commandItems.map((item, idx) => {
                const active = idx === cmdIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setCmdIndex(idx)}
                    onClick={() => {
                      item.action();
                      setCmdOpen(false);
                    }}
                    style={
                      active
                        ? {
                            backgroundColor: "var(--bg-muted)",
                            color: "var(--text-primary)",
                          }
                        : {
                            backgroundColor: "transparent",
                            color: "var(--text-secondary)",
                          }
                    }
                    className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left transition-colors"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        style={{
                          color: active ? "var(--accent)" : "var(--text-tertiary)",
                        }}
                        className="inline-flex shrink-0"
                      >
                        {item.icon}
                      </span>
                      <span className="truncate text-[13px] font-medium">
                        {item.title}
                      </span>
                      {item.subtitle && (
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="font-mono-num truncate text-[11.5px]"
                        >
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                    <Badge tone="subtle">{item.group}</Badge>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </NativeDialog>
    </div>
  );
}
