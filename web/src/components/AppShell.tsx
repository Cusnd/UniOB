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
  Lock,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
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
  AuthStatus,
  DensityMode,
  HorizonNode,
  HubStatusResponse,
  InspectorTab,
  ThemeMode,
} from "../types";
import type { WsConnectionStatus } from "../hooks/useFleetSocket";
import { formatNodeMetaLine, formatRate } from "../utils/format";

export interface AppShellProps {
  route: AppRoute;
  onRouteChange: (route: AppRoute) => void;
  nodes: HorizonNode[];
  activeAlertsCount: number;
  wsStatus: WsConnectionStatus;
  onReconnectWs?: () => void;
  hubStatus: HubStatusResponse | null;
  auth: AuthStatus;
  onLogout: () => Promise<void> | void;
  themeMode: ThemeMode;
  resolvedTheme: "dark" | "light";
  onCycleTheme: () => void;
  accent: AccentPreset;
  onAccentChange: (a: AccentPreset) => void;
  density: DensityMode;
  onDensityChange: (d: DensityMode) => void;
  onOpenAddServer: () => void;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  children: React.ReactNode;
}

interface CommandItem {
  id: string;
  group: "node" | "route" | "action";
  title: string;
  subtitle: string;
  keywords: string;
  node?: HorizonNode;
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
 * UniOB Horizon 2026 应用壳层：可折叠导航轨、界面外观设置、52px 玻璃顶栏与 ⌘K 命令中心。
 */
export function AppShell({
  route,
  onRouteChange,
  nodes,
  activeAlertsCount,
  wsStatus,
  onReconnectWs,
  hubStatus,
  auth,
  onLogout,
  themeMode,
  resolvedTheme,
  onCycleTheme,
  accent,
  onAccentChange,
  density,
  onDensityChange,
  onOpenAddServer,
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
  const [loggingOut, setLoggingOut] = useState(false);

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

  const handleLogoutClick = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut, onLogout]);

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

  const wsBadge =
    wsStatus === "connected"
      ? {
          cls: "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
          dot: "bg-emerald-500",
          ring: true,
          label: "实时流已连接",
        }
      : wsStatus === "connecting" || wsStatus === "reconnecting"
        ? {
            cls: "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
            dot: "bg-amber-500",
            ring: false,
            label: wsStatus === "connecting" ? "正在连接…" : "重连中…",
          }
        : {
            cls: "border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300",
            dot: "bg-rose-500",
            ring: false,
            label: "连接已断开",
          };

  const authAccountLabel =
    auth.mode === "cf_access"
      ? auth.email || "Cloudflare Access"
      : "管理员已认证";

  const commandItems = useMemo<CommandItem[]>(() => {
    const nodeItems: CommandItem[] = nodes.map((node) => {
      const metaLine = formatNodeMetaLine(node, {
        includeHostnameFallback: true,
      });
      const statusText = node.online
        ? `CPU ${(node.metrics?.cpu.all ?? 0).toFixed(1)}%`
        : "离线";
      const subtitle = [node.group_name, metaLine, statusText]
        .filter(Boolean)
        .join(" · ");

      return {
        id: `node-${node.id}`,
        group: "node",
        title: `${node.region_flag} ${node.name}`,
        subtitle,
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
      };
    });

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
        id: "action-theme",
        group: "action",
        title: `切换外观主题（当前：${themeText}）`,
        subtitle: "循环切换 Obsidian Dark / Porcelain Light / 跟随系统",
        keywords: "主题 深色 浅色 theme dark light system".toLowerCase(),
        run: () => {
          onCycleTheme();
        },
      },
      ...ACCENT_PRESETS.map((preset) => ({
        id: `action-accent-${preset.key}`,
        group: "action" as const,
        title: `切换强调色：${preset.label}`,
        subtitle: `设置 Horizon 主题强调色为 ${preset.key}`,
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
      {
        id: "action-logout",
        group: "action",
        title: "退出当前管理员会话",
        subtitle: `当前账号：${authAccountLabel}`,
        keywords: "退出 登录 注销 logout signout".toLowerCase(),
        run: () => {
          setCmdOpen(false);
          void handleLogoutClick();
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
    themeText,
    density,
    authAccountLabel,
    onSelectNode,
    onRouteChange,
    onOpenAddServer,
    onCycleTheme,
    onAccentChange,
    onDensityChange,
    handleLogoutClick,
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
                  {hubStatus
                    ? hubStatus.mode === "cloudflare-worker"
                      ? "SCCH"
                      : "HUB"
                    : "…"}
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

      {/* Bottom Appearance & Session Panel */}
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
              onClick={() => void handleLogoutClick()}
              disabled={loggingOut}
              title={`退出登录（${authAccountLabel}）`}
              aria-label="退出登录"
              className="w-10 h-9 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--text-secondary)] hover:text-rose-500 disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
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
                界面外观设置
              </span>
              <span className="text-[9px] font-mono-num uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                Horizon
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

            {/* Authenticated Account Badge & Logout */}
            <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2">
              <div
                className="flex items-center gap-1.5 min-w-0 text-[11px] text-[var(--text-secondary)]"
                title={authAccountLabel}
              >
                {auth.mode === "cf_access" ? (
                  <ShieldCheck
                    className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0"
                    aria-hidden="true"
                  />
                ) : (
                  <Lock
                    className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate font-mono-num">{authAccountLabel}</span>
              </div>

              <button
                type="button"
                onClick={() => void handleLogoutClick()}
                disabled={loggingOut}
                aria-label="退出登录"
                title="退出当前登录会话"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium text-[var(--text-secondary)] hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-500/40 whitespace-nowrap shrink-0 transition-colors disabled:opacity-50"
              >
                <LogOut className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span>退出</span>
              </button>
            </div>
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
                <h1 className="text-sm font-bold tracking-tight text-[var(--text-primary)] whitespace-nowrap shrink-0">
                  {currentRouteMeta.label}
                </h1>
                <span className="hidden xl:inline text-xs text-[var(--text-muted,var(--text-secondary))] truncate">
                  / {currentRouteMeta.shortDesc}
                </span>
              </div>

              {wsStatus === "disconnected" && onReconnectWs ? (
                <button
                  type="button"
                  onClick={onReconnectWs}
                  title="点击重连实时遥测流"
                  className={`hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-mono-num font-medium whitespace-nowrap shrink-0 hover:opacity-85 transition-opacity ${wsBadge.cls}`}
                >
                  <span className="relative flex h-2 w-2" aria-hidden="true">
                    <span
                      className={`relative inline-flex rounded-full h-2 w-2 ${wsBadge.dot}`}
                    />
                  </span>
                  <span>{wsBadge.label}</span>
                </button>
              ) : (
                <div
                  className={`hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-mono-num font-medium whitespace-nowrap shrink-0 ${wsBadge.cls}`}
                >
                  <span className="relative flex h-2 w-2" aria-hidden="true">
                    {wsBadge.ring && (
                      <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                    )}
                    <span
                      className={`relative inline-flex rounded-full h-2 w-2 ${wsBadge.dot}`}
                    />
                  </span>
                  <span>{wsBadge.label}</span>
                </div>
              )}
            </div>

            {/* Right: Telemetry Capsules + Hub Mode Badge + Command Center + CTA */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              {/* Aggregate TX / RX Capsule */}
              <div
                className="hidden xl:inline-flex items-center gap-2 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-mono-num whitespace-nowrap shrink-0"
                title="全网在线节点实时聚合吞吐"
              >
                <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                  <ArrowUp className="w-3 h-3 shrink-0" aria-hidden="true" />
                  {formatRate(fleetStats.totalTxBps)}
                </span>
                <span className="text-[var(--border-strong)]">|</span>
                <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                  <ArrowDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                  {formatRate(fleetStats.totalRxBps)}
                </span>
              </div>

              {/* Online Rate Capsule */}
              <div
                className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-mono-num whitespace-nowrap shrink-0"
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
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-[11px] font-mono-num font-semibold whitespace-nowrap shrink-0 transition-colors ${
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
                <Bell className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline whitespace-nowrap">告警</span>
                <span>{activeAlertsCount}</span>
              </button>

              {/* Real Hub Mode Capsule (click navigates to migration studio) */}
              <button
                type="button"
                onClick={() => onRouteChange("migration")}
                title="点击打开双模热迁移控制面"
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium text-[var(--text-primary)] whitespace-nowrap shrink-0 hover:border-[var(--accent-ring)] transition-colors"
              >
                {hubStatus?.mode === "cloudflare-worker" ? (
                  <>
                    <Cloud className="w-3.5 h-3.5 text-sky-500 shrink-0" aria-hidden="true" />
                    <span className="hidden lg:inline whitespace-nowrap">
                      Cloudflare SCCH
                    </span>
                    <span className="font-mono-num text-[10px] px-1 rounded bg-sky-500/12 text-sky-700 dark:text-sky-300 whitespace-nowrap shrink-0">
                      $0/月
                    </span>
                  </>
                ) : hubStatus?.mode === "self-hosted-hub" ? (
                  <>
                    <Server className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
                    <span className="hidden lg:inline whitespace-nowrap">
                      Rust uniob-hub
                    </span>
                    <span className="font-mono-num text-[10px] px-1 rounded bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 whitespace-nowrap shrink-0">
                      WAL
                    </span>
                  </>
                ) : (
                  <>
                    <Activity className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" aria-hidden="true" />
                    <span className="hidden lg:inline whitespace-nowrap text-[var(--text-secondary)]">
                      双模控制面
                    </span>
                  </>
                )}
                <ArrowLeftRight
                  className="w-3 h-3 text-[var(--text-secondary)] shrink-0"
                  aria-hidden="true"
                />
              </button>

              {/* Command Center Trigger */}
              <button
                type="button"
                onClick={openCommandCenter}
                aria-label="打开全局命令中心 (Cmd+K / Ctrl+K)"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs text-[var(--text-secondary)] whitespace-nowrap shrink-0 hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors"
              >
                <Search className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden md:inline whitespace-nowrap">命令中心</span>
                <kbd className="hidden sm:inline-block px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] font-mono-num text-[var(--text-primary)]">
                  ⌘K
                </kbd>
              </button>

              {/* Primary CTA: + Deploy Agent */}
              <button
                type="button"
                onClick={onOpenAddServer}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[var(--accent-solid)] hover:bg-[var(--accent-primary)] text-white shadow-xs whitespace-nowrap shrink-0 transition-colors"
              >
                <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
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
          if (!("closedBy" in HTMLDialogElement.prototype)) {
            mobilePointerDownOutRef.current = isPointerOutsideElement(
              e,
              mobilePanelRef.current,
            );
          }
        }}
        onPointerUp={(e) => {
          if (!("closedBy" in HTMLDialogElement.prototype)) {
            if (
              mobilePointerDownOutRef.current &&
              isPointerOutsideElement(e, mobilePanelRef.current)
            ) {
              setMobileOpen(false);
            }
            mobilePointerDownOutRef.current = false;
          }
        }}
        className="m-0 h-dvh max-h-dvh w-fit bg-transparent p-0"
      >
        <div
          ref={mobilePanelRef}
          className="flex flex-col h-full w-[276px] max-w-[85vw] bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] shadow-2xl"
        >
          <span id={mobileTitleId} className="sr-only">
            UniOB 导航菜单与外观设置
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
          if (!("closedBy" in HTMLDialogElement.prototype)) {
            cmdPointerDownOutRef.current = isPointerOutsideElement(
              e,
              cmdPanelRef.current,
            );
          }
        }}
        onPointerUp={(e) => {
          if (!("closedBy" in HTMLDialogElement.prototype)) {
            if (
              cmdPointerDownOutRef.current &&
              isPointerOutsideElement(e, cmdPanelRef.current)
            ) {
              setCmdOpen(false);
            }
            cmdPointerDownOutRef.current = false;
          }
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
