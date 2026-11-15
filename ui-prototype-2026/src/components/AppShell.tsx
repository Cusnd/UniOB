import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Bell,
  Check,
  Cloud,
  CornerDownLeft,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import type {
  AccentPreset,
  AppRoute,
  DensityMode,
  HubMode,
  InspectorTab,
  PrototypeNode,
  SimSpeed,
  ThemeMode,
} from "../types";
import { formatRate } from "../utils/format";

export interface AppShellProps {
  route: AppRoute;
  onRouteChange: (route: AppRoute) => void;
  nodes: PrototypeNode[];
  activeAlertsCount: number;
  wsConnected: boolean;
  hubMode: HubMode;
  onToggleHubMode: () => void;
  themeMode: ThemeMode;
  resolvedTheme: "dark" | "light";
  onCycleTheme: () => void;
  accent: AccentPreset;
  onAccentChange: (a: AccentPreset) => void;
  density: DensityMode;
  onDensityChange: (d: DensityMode) => void;
  simSpeed: SimSpeed;
  onSimSpeedChange: (s: SimSpeed) => void;
  onOpenAddServer: () => void;
  onOpenAuthPreview: () => void;
  onSelectNode: (node: PrototypeNode, initialTab?: InspectorTab) => void;
  children: React.ReactNode;
}

interface CommandItem {
  id: string;
  group: "node" | "route" | "action";
  title: string;
  subtitle: string;
  keywords: string;
  node?: PrototypeNode;
  run: () => void;
}

const ROUTE_ITEMS: Array<{
  key: AppRoute;
  label: string;
  shortDesc: string;
  icon: typeof LayoutDashboard;
}> = [
  {
    key: "dashboard",
    label: "机群总览",
    shortDesc: "驾驶舱与实时三态拓扑",
    icon: LayoutDashboard,
  },
  {
    key: "nodes",
    label: "服务器台账",
    shortDesc: "资产配额、标签与批量管理",
    icon: Server,
  },
  {
    key: "migration",
    label: "双模热迁移",
    shortDesc: "SCCH ⇄ uniob-hub 金丝雀切流",
    icon: ArrowLeftRight,
  },
  {
    key: "alerts",
    label: "告警中心",
    shortDesc: "事件时间线、规则与通知路由",
    icon: Bell,
  },
];

const ACCENT_PRESETS: Array<{
  key: AccentPreset;
  label: string;
  swatch: string;
}> = [
  { key: "emerald", label: "翡翠绿", swatch: "#10b981" },
  { key: "indigo", label: "深邃靛", swatch: "#6366f1" },
  { key: "cyan", label: "极光青", swatch: "#06b6d4" },
];

function isPointerOutsideElement(
  e: React.PointerEvent<HTMLElement>,
  el: HTMLElement | null,
): boolean {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

/**
 * UniOB Horizon 2026 应用壳层：可折叠导航轨、原型工作台、52px 玻璃顶栏与 ⌘K 命令中心。
 */
export function AppShell({
  route,
  onRouteChange,
  nodes,
  activeAlertsCount,
  wsConnected,
  hubMode,
  onToggleHubMode,
  themeMode,
  resolvedTheme,
  onCycleTheme,
  accent,
  onAccentChange,
  density,
  onDensityChange,
  simSpeed,
  onSimSpeedChange,
  onOpenAddServer,
  onOpenAuthPreview,
  onSelectNode,
  children,
}: AppShellProps): React.JSX.Element {
  const mobileTitleId = useId();
  const cmdTitleId = useId();
  const cmdInputId = useId();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdActiveIdx, setCmdActiveIdx] = useState(0);

  const mobileDialogRef = useRef<HTMLDialogElement | null>(null);
  const mobilePanelRef = useRef<HTMLDivElement | null>(null);
  const mobilePointerDownOutRef = useRef(false);

  const cmdDialogRef = useRef<HTMLDialogElement | null>(null);
  const cmdPanelRef = useRef<HTMLDivElement | null>(null);
  const cmdInputRef = useRef<HTMLInputElement | null>(null);
  const cmdPointerDownOutRef = useRef(false);

  // Sync mobile drawer <dialog>
  useEffect(() => {
    const dlg = mobileDialogRef.current;
    if (!dlg) return;
    if (mobileOpen && !dlg.open) {
      dlg.showModal();
    } else if (!mobileOpen && dlg.open) {
      dlg.close();
    }
  }, [mobileOpen]);

  // Sync Command Center <dialog>
  useEffect(() => {
    const dlg = cmdDialogRef.current;
    if (!dlg) return;
    if (cmdOpen && !dlg.open) {
      dlg.showModal();
      window.requestAnimationFrame(() => {
        cmdInputRef.current?.focus();
      });
    } else if (!cmdOpen && dlg.open) {
      dlg.close();
    }
  }, [cmdOpen]);

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((prev) => {
          const next = !prev;
          if (next) {
            setCmdQuery("");
            setCmdActiveIdx(0);
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openCommandCenter = useCallback(() => {
    setCmdQuery("");
    setCmdActiveIdx(0);
    setCmdOpen(true);
  }, []);

  const fleetStats = useMemo(() => {
    let onlineCount = 0;
    let totalTxBps = 0;
    let totalRxBps = 0;
    for (const n of nodes) {
      if (n.online) {
        onlineCount += 1;
        if (n.metrics) {
          totalTxBps += n.metrics.net.tx_bps;
          totalRxBps += n.metrics.net.rx_bps;
        }
      }
    }
    const onlinePct =
      nodes.length > 0 ? Math.round((onlineCount / nodes.length) * 100) : 0;
    return { onlineCount, totalTxBps, totalRxBps, onlinePct };
  }, [nodes]);

  const ThemeIcon =
    themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor;
  const themeText =
    themeMode === "dark" ? "深色" : themeMode === "light" ? "浅色" : "跟随系统";

  const currentRouteMeta =
    ROUTE_ITEMS.find((r) => r.key === route) ?? ROUTE_ITEMS[0];

  const commandItems = useMemo<CommandItem[]>(() => {
    const nodeItems: CommandItem[] = nodes.map((node) => ({
      id: `node-${node.id}`,
      group: "node",
      title: `${node.region_flag} ${node.name}`,
      subtitle: `${node.group_name} · ${node.provider} · ${
        node.online
          ? `CPU ${(node.metrics?.cpu.all ?? 0).toFixed(1)}%`
          : "离线"
      }`,
      keywords: [
        node.name,
        node.hostname ?? "",
        node.group_name,
        node.region_code,
        node.provider,
        node.ipv4_masked,
        node.os ?? "",
        ...node.tags,
      ]
        .join(" ")
        .toLowerCase(),
      node,
      run: () => {
        onSelectNode(node, "charts");
        setCmdOpen(false);
      },
    }));

    const routeItems: CommandItem[] = ROUTE_ITEMS.map((item) => ({
      id: `route-${item.key}`,
      group: "route",
      title: `前往：${item.label}`,
      subtitle: item.shortDesc,
      keywords: `${item.label} ${item.key} ${item.shortDesc}`.toLowerCase(),
      run: () => {
        onRouteChange(item.key);
        setCmdOpen(false);
      },
    }));

    const actionItems: CommandItem[] = [
      {
        id: "action-add-server",
        group: "action",
        title: "+ 部署新服务器探针",
        subtitle: "打开一键部署向导并生成 Agent 安装命令",
        keywords: "部署 添加 服务器 探针 add server agent".toLowerCase(),
        run: () => {
          setCmdOpen(false);
          onOpenAddServer();
        },
      },
      {
        id: "action-toggle-hub",
        group: "action",
        title: `切换运行模式（当前：${
          hubMode === "cloudflare-worker" ? "Cloudflare SCCH" : "Rust uniob-hub"
        }）`,
        subtitle: "在边缘零热路径与自建 SQLite WAL 模式间切换预览",
        keywords: "模式 cloudflare scch rust uniob-hub 迁移".toLowerCase(),
        run: () => {
          onToggleHubMode();
          setCmdOpen(false);
        },
      },
      {
        id: "action-theme",
        group: "action",
        title: `切换外观主题（当前：${themeText}）`,
        subtitle: "循环切换 Obsidian Dark / Porcelain Light / 跟随系统",
        keywords: "主题 深色 浅色 theme dark light system".toLowerCase(),
        run: () => {
          onCycleTheme();
        },
      },
      {
        id: "action-auth-preview",
        group: "action",
        title: "预览登录与 Cloudflare Zero Trust 页面",
        subtitle: "体验密码登录、首次初始化、SSO 与 403 拦截态",
        keywords: "登录 zero trust sso 403 鉴权 auth".toLowerCase(),
        run: () => {
          setCmdOpen(false);
          onOpenAuthPreview();
        },
      },
      ...ACCENT_PRESETS.map((preset) => ({
        id: `action-accent-${preset.key}`,
        group: "action" as const,
        title: `切换强调色：${preset.label}`,
        subtitle: `设置 Horizon 商业主色为 ${preset.key}`,
        keywords: `强调色 accent color ${preset.label} ${preset.key}`.toLowerCase(),
        run: () => {
          onAccentChange(preset.key);
        },
      })),
      {
        id: "action-density",
        group: "action",
        title: `切换排版密度为「${density === "comfortable" ? "紧凑" : "舒适"}」`,
        subtitle: "调整卡片与表格视图信息密度",
        keywords: "密度 紧凑 舒适 density compact comfortable".toLowerCase(),
        run: () => {
          onDensityChange(density === "comfortable" ? "compact" : "comfortable");
        },
      },
    ];

    const q = cmdQuery.trim().toLowerCase();
    const all = [...nodeItems, ...routeItems, ...actionItems];
    if (!q) return all.slice(0, 12);
    return all.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.keywords.includes(q),
    );
  }, [
    nodes,
    cmdQuery,
    hubMode,
    themeText,
    density,
    onSelectNode,
    onRouteChange,
    onOpenAddServer,
    onToggleHubMode,
    onCycleTheme,
    onAccentChange,
    onDensityChange,
    onOpenAuthPreview,
  ]);

  const safeActiveIdx =
    commandItems.length === 0
      ? 0
      : Math.min(cmdActiveIdx, commandItems.length - 1);

  const handleCmdInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (commandItems.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCmdActiveIdx((prev) => (prev + 1) % commandItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCmdActiveIdx(
        (prev) => (prev - 1 + commandItems.length) % commandItems.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      commandItems[safeActiveIdx]?.run();
    }
  };

  const renderSidebarBody = (isCollapsed: boolean, isMobile = false) => (
    <>
      {/* Brand Row */}
      <div
        className={`h-[52px] shrink-0 border-b border-[var(--border-subtle)] flex items-center ${
          isCollapsed ? "justify-center px-2" : "justify-between px-3.5"
        }`}
      >
        {!isCollapsed && (
          <button
            type="button"
            onClick={() => {
              onRouteChange("dashboard");
              if (isMobile) setMobileOpen(false);
            }}
            className="flex items-center gap-2.5 text-left min-w-0"
          >
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center border shrink-0"
              style={{
                backgroundColor: "var(--accent-soft)",
                borderColor: "var(--accent-ring)",
              }}
            >
              <Activity
                className="w-4 h-4 text-[var(--accent-primary)]"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold tracking-tight text-[var(--text-primary)]">
                  UniOB
                </span>
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-mono-num font-semibold border"
                  style={{
                    backgroundColor: "var(--accent-soft)",
                    borderColor: "var(--accent-ring)",
                    color: "var(--accent-primary)",
                  }}
                >
                  2026
                </span>
              </div>
              <div className="text-[10px] text-[var(--text-secondary)] truncate">
                Horizon 可观测台
              </div>
            </div>
          </button>
        )}

        {isMobile ? (
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭导航抽屉"
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setSidebarCollapsed((c) => !c)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? "展开左侧导航栏" : "收起左侧导航栏"}
            title={isCollapsed ? "展开侧栏" : "收起侧栏"}
            className="p-1.5 rounded-lg border border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:border-[var(--border-subtle)] hover:text-[var(--text-primary)] transition-colors"
          >
            {isCollapsed ? (
              <PanelLeftOpen className="w-4 h-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      {/* Primary Navigation */}
      <nav
        aria-label={isMobile ? "移动端主导航" : "主导航"}
        className={`flex-1 overflow-y-auto py-3 ${
          isCollapsed ? "px-2 space-y-1.5" : "px-3 space-y-1"
        }`}
      >
        {!isCollapsed && (
          <div className="px-2 pb-1.5 text-[10px] font-mono-num uppercase tracking-wider text-[var(--text-muted,var(--text-secondary))]">
            控制面导航
          </div>
        )}

        {ROUTE_ITEMS.map(({ key, label, icon: Icon }) => {
          const active = route === key;
          return (
            <button
              key={key}
              type="button"
              aria-current={active ? "page" : undefined}
              title={isCollapsed ? label : undefined}
              aria-label={isCollapsed ? label : undefined}
              onClick={() => {
                onRouteChange(key);
                if (isMobile) setMobileOpen(false);
              }}
              className={`w-full flex items-center rounded-xl text-xs font-medium transition-colors border ${
                isCollapsed
                  ? "justify-center p-2.5"
                  : "justify-between px-3 py-2.5"
              } ${
                active
                  ? "text-[var(--accent-primary)] font-semibold"
                  : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
              }`}
              style={
                active
                  ? {
                      backgroundColor: "var(--accent-soft)",
                      borderColor: "var(--accent-ring)",
                    }
                  : undefined
              }
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                {!isCollapsed && <span className="truncate">{label}</span>}
              </span>

              {!isCollapsed && key === "nodes" && (
                <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono-num bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                  {nodes.length}
                </span>
              )}

              {!isCollapsed && key === "migration" && (
                <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono-num bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                  {hubMode === "cloudflare-worker" ? "SCCH" : "HUB"}
                </span>
              )}

              {!isCollapsed && key === "alerts" && activeAlertsCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono-num font-bold bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/35">
                  {activeAlertsCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom Prototype Studio Panel */}
      <div
        className={`shrink-0 border-t border-[var(--border-subtle)] ${
          isCollapsed ? "p-2 space-y-1.5" : "p-3"
        }`}
      >
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={onCycleTheme}
              title={`主题模式：${themeText}`}
              aria-label={`切换主题，当前 ${themeText}`}
              className="w-10 h-9 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <ThemeIcon className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => {
                const order: AccentPreset[] = ["emerald", "indigo", "cyan"];
                const next = order[(order.indexOf(accent) + 1) % order.length];
                onAccentChange(next);
              }}
              title="切换商业强调色"
              aria-label="切换强调色"
              className="w-10 h-9 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-center"
            >
              <span
                className="w-3.5 h-3.5 rounded-full border border-white/40"
                style={{ backgroundColor: "var(--accent-primary)" }}
              />
            </button>
            <button
              type="button"
              onClick={() =>
                onSimSpeedChange(
                  simSpeed === "1s" ? "2s" : simSpeed === "2s" ? "paused" : "1s",
                )
              }
              title={`仿真流速率：${simSpeed}`}
              aria-label={`切换仿真速度，当前 ${simSpeed}`}
              className="w-10 h-9 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {simSpeed === "paused" ? (
                <Pause className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={onOpenAuthPreview}
              title="预览登录 / Zero Trust 页面"
              aria-label="预览登录与 Zero Trust 页面"
              className="w-10 h-9 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent-primary)]"
            >
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/85 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
                <Sparkles
                  className="w-3.5 h-3.5 text-[var(--accent-primary)]"
                  aria-hidden="true"
                />
                原型工作台
              </span>
              <span className="text-[9px] font-mono-num uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                Studio
              </span>
            </div>

            {/* Theme switcher */}
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[var(--text-secondary)]">外观主题</span>
              <button
                type="button"
                onClick={onCycleTheme}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] font-medium hover:border-[var(--accent-ring)] transition-colors"
              >
                <ThemeIcon className="w-3 h-3 text-[var(--accent-primary)]" aria-hidden="true" />
                <span>{themeText}</span>
                <span className="text-[10px] font-mono-num text-[var(--text-secondary)]">
                  ({resolvedTheme === "dark" ? "暗" : "亮"})
                </span>
              </button>
            </div>

            {/* Accent switcher */}
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[var(--text-secondary)]">强调色系</span>
              <div className="flex items-center gap-1.5" role="group" aria-label="选择强调色">
                {ACCENT_PRESETS.map((item) => {
                  const selected = accent === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onAccentChange(item.key)}
                      aria-pressed={selected}
                      aria-label={item.label}
                      title={item.label}
                      className={`w-6 h-6 rounded-lg flex items-center justify-center border transition-transform ${
                        selected
                          ? "scale-105 border-[var(--text-primary)] shadow-xs"
                          : "border-[var(--border-subtle)] opacity-80 hover:opacity-100"
                      }`}
                      style={{ backgroundColor: item.swatch }}
                    >
                      {selected && (
                        <Check className="w-3.5 h-3.5 text-white" aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Density toggle */}
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[var(--text-secondary)]">排版密度</span>
              <div
                className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5"
                role="group"
                aria-label="切换排版密度"
              >
                {(
                  [
                    { key: "comfortable", label: "舒适" },
                    { key: "compact", label: "紧凑" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => onDensityChange(opt.key)}
                    aria-pressed={density === opt.key}
                    className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                      density === opt.key
                        ? "bg-[var(--accent-solid)] text-white"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Simulation Speed */}
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-[var(--text-secondary)]">仿真流</span>
              <div
                className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5 font-mono-num"
                role="group"
                aria-label="切换遥测仿真流速度"
              >
                {(
                  [
                    { key: "1s", label: "1s" },
                    { key: "2s", label: "2s" },
                    { key: "paused", label: "暂停" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => onSimSpeedChange(opt.key)}
                    aria-pressed={simSpeed === opt.key}
                    className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                      simSpeed === opt.key
                        ? "bg-[var(--accent-solid)] text-white"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Auth / Zero Trust Preview Trigger */}
            <button
              type="button"
              onClick={() => {
                if (isMobile) setMobileOpen(false);
                onOpenAuthPreview();
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-ring)] hover:text-[var(--accent-primary)] transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
              <span>预览登录 / Zero Trust 页面</span>
            </button>
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="min-h-dvh flex bg-[var(--bg-canvas)] text-[var(--text-primary)] horizon-grid-bg">
      {/* Desktop Collapsible Navigation Rail */}
      <aside
        aria-label="桌面侧边导航"
        className={`hidden lg:flex flex-col sticky top-0 h-dvh shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-surface)]/95 backdrop-blur-md transition-[width] duration-200 ${
          sidebarCollapsed ? "w-[72px]" : "w-[252px]"
        }`}
      >
        {renderSidebarBody(sidebarCollapsed, false)}
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top 52px Floating Glass Status Bar */}
        <header className="sticky top-0 z-30 h-[52px] shrink-0 bg-[var(--bg-glass)] backdrop-blur-xl border-b border-[var(--border-subtle)]">
          <div className="h-full max-w-[1600px] mx-auto px-3 sm:px-5 flex items-center justify-between gap-2">
            {/* Left: Mobile Drawer Trigger + Route Title + WS Status */}
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-label="打开导航菜单"
                className="lg:hidden p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)]"
              >
                <Menu className="w-4 h-4" aria-hidden="true" />
              </button>

              <div className="flex items-center gap-2 min-w-0">
                <h1 className="text-sm font-bold tracking-tight text-[var(--text-primary)] truncate">
                  {currentRouteMeta.label}
                </h1>
                <span className="hidden md:inline text-xs text-[var(--text-muted,var(--text-secondary))] truncate">
                  / {currentRouteMeta.shortDesc}
                </span>
              </div>

              <div
                className={`hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-mono-num font-medium shrink-0 ${
                  simSpeed === "paused"
                    ? "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300"
                    : !wsConnected
                      ? "border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300"
                      : "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                }`}
              >
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  {wsConnected && simSpeed !== "paused" && (
                    <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                  )}
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      simSpeed === "paused"
                        ? "bg-amber-500"
                        : !wsConnected
                          ? "bg-rose-500"
                          : "bg-emerald-500"
                    }`}
                  />
                </span>
                <span>
                  {simSpeed === "paused"
                    ? "流已暂停"
                    : !wsConnected
                      ? "连接中断"
                      : `${simSpeed} 实时流`}
                </span>
              </div>
            </div>

            {/* Right: Telemetry Capsules + Mode Toggle + Command Center + CTA */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              {/* Aggregate TX / RX Capsule */}
              <div
                className="hidden xl:inline-flex items-center gap-2 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-mono-num"
                title="全网在线节点实时聚合吞吐"
              >
                <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                  <ArrowUp className="w-3 h-3" aria-hidden="true" />
                  {formatRate(fleetStats.totalTxBps)}
                </span>
                <span className="text-[var(--border-strong)]">|</span>
                <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                  <ArrowDown className="w-3 h-3" aria-hidden="true" />
                  {formatRate(fleetStats.totalRxBps)}
                </span>
              </div>

              {/* Online Rate Capsule */}
              <div
                className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-mono-num"
                title={`在线 ${fleetStats.onlineCount} / ${nodes.length} 台`}
              >
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {fleetStats.onlineCount}
                </span>
                <span className="text-[var(--text-secondary)]">/ {nodes.length}</span>
                <span className="text-[var(--text-muted,var(--text-secondary))]">
                  ({fleetStats.onlinePct}%)
                </span>
              </div>

              {/* Active Alerts Pulse Badge */}
              <button
                type="button"
                onClick={() => onRouteChange("alerts")}
                aria-label={`当前活跃告警 ${activeAlertsCount} 条，点击进入告警中心`}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-[11px] font-mono-num font-semibold transition-colors ${
                  activeAlertsCount > 0
                    ? "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300 hover:bg-rose-500/25"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  {activeAlertsCount > 0 && (
                    <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-rose-500" />
                  )}
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      activeAlertsCount > 0 ? "bg-rose-500" : "bg-slate-400"
                    }`}
                  />
                </span>
                <Bell className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">告警</span>
                <span>{activeAlertsCount}</span>
              </button>

              {/* Hub Mode Switch Capsule */}
              <button
                type="button"
                onClick={onToggleHubMode}
                title="点击切换运行模式预览（Cloudflare SCCH ⇄ Rust uniob-hub）"
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-ring)] transition-colors"
              >
                {hubMode === "cloudflare-worker" ? (
                  <>
                    <Cloud className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
                    <span className="hidden lg:inline">Cloudflare SCCH</span>
                    <span className="font-mono-num text-[10px] px-1 rounded bg-sky-500/12 text-sky-700 dark:text-sky-300">
                      $0/月
                    </span>
                  </>
                ) : (
                  <>
                    <Server className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
                    <span className="hidden lg:inline">Rust uniob-hub</span>
                    <span className="font-mono-num text-[10px] px-1 rounded bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                      WAL
                    </span>
                  </>
                )}
                <ArrowLeftRight
                  className="w-3 h-3 text-[var(--text-secondary)]"
                  aria-hidden="true"
                />
              </button>

              {/* Command Center Trigger */}
              <button
                type="button"
                onClick={openCommandCenter}
                aria-label="打开全局命令中心 (Cmd+K / Ctrl+K)"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors"
              >
                <Search className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden md:inline">命令中心</span>
                <kbd className="hidden sm:inline-block px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] font-mono-num text-[var(--text-primary)]">
                  ⌘K
                </kbd>
              </button>

              {/* Primary CTA: + Deploy Agent */}
              <button
                type="button"
                onClick={onOpenAddServer}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[var(--accent-solid)] hover:bg-[var(--accent-primary)] text-white shadow-xs transition-colors"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>部署探针</span>
              </button>
            </div>
          </div>
        </header>

        {/* Workspace Main Content */}
        <main
          className={`flex-1 w-full max-w-[1600px] mx-auto ${
            density === "compact" ? "px-3 sm:px-4 py-3.5" : "px-3 sm:px-5 py-5"
          }`}
        >
          {children}
        </main>
      </div>

      {/* Mobile Navigation Drawer (<dialog>) */}
      <dialog
        ref={mobileDialogRef}
        {...({ closedby: "any" } as Record<string, string>)}
        aria-labelledby={mobileTitleId}
        onCancel={(e) => {
          e.preventDefault();
          setMobileOpen(false);
        }}
        onClose={() => setMobileOpen(false)}
        onPointerDown={(e) => {
          mobilePointerDownOutRef.current = isPointerOutsideElement(
            e,
            mobilePanelRef.current,
          );
        }}
        onPointerUp={(e) => {
          if (
            mobilePointerDownOutRef.current &&
            isPointerOutsideElement(e, mobilePanelRef.current)
          ) {
            setMobileOpen(false);
          }
          mobilePointerDownOutRef.current = false;
        }}
        className="m-0 h-dvh max-h-dvh w-fit bg-transparent p-0"
      >
        <div
          ref={mobilePanelRef}
          className="flex flex-col h-full w-[276px] max-w-[85vw] bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] shadow-2xl"
        >
          <span id={mobileTitleId} className="sr-only">
            UniOB 导航菜单与工作台
          </span>
          {renderSidebarBody(false, true)}
        </div>
      </dialog>

      {/* Global Command Center Modal (<dialog>) */}
      <dialog
        ref={cmdDialogRef}
        {...({ closedby: "any" } as Record<string, string>)}
        aria-labelledby={cmdTitleId}
        onCancel={(e) => {
          e.preventDefault();
          setCmdOpen(false);
        }}
        onClose={() => setCmdOpen(false)}
        onPointerDown={(e) => {
          cmdPointerDownOutRef.current = isPointerOutsideElement(
            e,
            cmdPanelRef.current,
          );
        }}
        onPointerUp={(e) => {
          if (
            cmdPointerDownOutRef.current &&
            isPointerOutsideElement(e, cmdPanelRef.current)
          ) {
            setCmdOpen(false);
          }
          cmdPointerDownOutRef.current = false;
        }}
        className="m-auto w-[min(660px,calc(100vw-1.5rem))] max-h-[min(560px,84dvh)] bg-transparent p-0"
      >
        <div
          ref={cmdPanelRef}
          className="flex flex-col max-h-[min(560px,84dvh)] overflow-hidden rounded-2xl surface-card shadow-2xl"
        >
          <h2 id={cmdTitleId} className="sr-only">
            UniOB 全局命令中心
          </h2>

          {/* Search Input Header */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <Search
              className="w-4 h-4 text-[var(--accent-primary)] shrink-0"
              aria-hidden="true"
            />
            <label htmlFor={cmdInputId} className="sr-only">
              搜索服务器、页面或快捷动作
            </label>
            <input
              ref={cmdInputRef}
              id={cmdInputId}
              type="text"
              value={cmdQuery}
              onChange={(e) => {
                setCmdQuery(e.target.value);
                setCmdActiveIdx(0);
              }}
              onKeyDown={handleCmdInputKeyDown}
              placeholder="搜索节点名 / IP / 分组，或输入主题、迁移、告警..."
              className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted,var(--text-secondary))] focus:outline-none"
            />
            {cmdQuery && (
              <button
                type="button"
                onClick={() => {
                  setCmdQuery("");
                  setCmdActiveIdx(0);
                  cmdInputRef.current?.focus();
                }}
                aria-label="清空搜索"
                className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setCmdOpen(false)}
              className="px-2 py-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] font-mono-num text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              ESC
            </button>
          </div>

          {/* Results List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {commandItems.length === 0 ? (
              <div className="py-12 text-center text-xs text-[var(--text-secondary)]">
                未找到匹配的服务器或指令，尝试输入服务器名称或「迁移」「主题」。
              </div>
            ) : (
              commandItems.map((item, idx) => {
                const active = idx === safeActiveIdx;
                return (
                  <div
                    key={item.id}
                    onMouseEnter={() => setCmdActiveIdx(idx)}
                    className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)] border-[var(--accent-ring)]"
                        : "border-transparent hover:bg-[var(--bg-elevated)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={item.run}
                      className="flex-1 min-w-0 flex items-center gap-2.5 text-left focus-visible:outline-none"
                    >
                      <span className="w-7 h-7 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                        {item.group === "node" && item.node ? (
                          item.node.online ? (
                            <Server
                              className="w-3.5 h-3.5 text-emerald-500"
                              aria-hidden="true"
                            />
                          ) : (
                            <WifiOff
                              className="w-3.5 h-3.5 text-rose-500"
                              aria-hidden="true"
                            />
                          )
                        ) : item.group === "route" ? (
                          <LayoutDashboard
                            className="w-3.5 h-3.5 text-[var(--accent-primary)]"
                            aria-hidden="true"
                          />
                        ) : (
                          <Zap
                            className="w-3.5 h-3.5 text-amber-500"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-[var(--text-primary)] truncate">
                          {item.title}
                        </div>
                        <div className="text-[11px] font-mono-num text-[var(--text-secondary)] truncate">
                          {item.subtitle}
                        </div>
                      </div>
                    </button>

                    {(() => {
                      const targetNode = item.node;
                      if (!targetNode) {
                        return (
                          <span className="text-[10px] font-mono-num text-[var(--text-secondary)] shrink-0">
                            {item.group === "route" ? "页面" : "动作"}
                          </span>
                        );
                      }
                      return (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              onSelectNode(targetNode, "charts");
                              setCmdOpen(false);
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-ring)] hover:text-[var(--accent-primary)]"
                          >
                            <Activity className="w-3 h-3" aria-hidden="true" />
                            曲线
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onSelectNode(targetNode, "procs");
                              setCmdOpen(false);
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-ring)] hover:text-[var(--accent-primary)]"
                          >
                            <Terminal className="w-3 h-3" aria-hidden="true" />
                            进程
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer Hints */}
          <div className="px-4 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-between text-[11px] font-mono-num text-[var(--text-secondary)]">
            <div className="flex items-center gap-3">
              <span>↑↓ 选择</span>
              <span className="inline-flex items-center gap-1">
                <CornerDownLeft className="w-3 h-3" aria-hidden="true" />
                直达详情 / 执行
              </span>
            </div>
            <span>共 {nodes.length} 台受管服务器</span>
          </div>
        </div>
      </dialog>
    </div>
  );
}
