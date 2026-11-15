import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowLeftRight,
  Bell,
  Check,
  ChevronDown,
  Layers,
  LogOut,
  Moon,
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
  NativeDialog,
  StatusDot,
  type StatusDotTone,
} from "./ui/Primitives";
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
import { formatBytesPerSec, formatNodeMetaLine } from "../utils/format";

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
  onThemeModeChange?: (mode: ThemeMode) => void;
  onCycleTheme: () => void;
  accent: AccentPreset;
  onAccentChange: (a: AccentPreset) => void;
  density: DensityMode;
  onDensityChange: (d: DensityMode) => void;
  onOpenAddServer: () => void;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  children: React.ReactNode;
}

const ACCENT_OPTIONS: Array<{
  id: AccentPreset;
  label: string;
  hex: string;
}> = [
  { id: "cobalt", label: "鸢尾钴蓝", hex: "#3D5AFE" },
  { id: "vermilion", label: "朱砂珊瑚", hex: "#E5484D" },
  { id: "jade", label: "草木翡翠", hex: "#16A34A" },
];

export function AppShell({
  route,
  onRouteChange,
  nodes,
  activeAlertsCount,
  wsStatus,
  hubStatus,
  auth,
  onLogout,
  resolvedTheme,
  onThemeModeChange,
  onCycleTheme,
  accent,
  onAccentChange,
  onOpenAddServer,
  onSelectNode,
  children,
}: AppShellProps): React.JSX.Element {
  const cmdTitleId = useId();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [stylePopoverOpen, setStylePopoverOpen] = useState(false);
  const [workspacePopoverOpen, setWorkspacePopoverOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const stylePopoverRef = useRef<HTMLDivElement | null>(null);
  const workspacePopoverRef = useRef<HTMLDivElement | null>(null);

  const onlineCount = useMemo(
    () => nodes.filter((n) => n.online).length,
    [nodes],
  );

  const hubModeLabel =
    hubStatus?.mode === "self-hosted-hub" ? "自建服务端" : "云端托管";

  const wsIndicator = useMemo<{
    tone: StatusDotTone;
    label: string;
    pulse: boolean;
  }>(() => {
    if (wsStatus === "connected") {
      return { tone: "ok", label: "实时已连接", pulse: false };
    }
    if (wsStatus === "connecting" || wsStatus === "reconnecting") {
      return { tone: "warn", label: "连接中…", pulse: true };
    }
    return { tone: "idle", label: "待连接", pulse: false };
  }, [wsStatus]);

  const authAccountLabel =
    auth.mode === "cf_access" ? auth.email || "已登录" : "管理员";

  const handleLogoutClick = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut, onLogout]);

  const setDirectTheme = useCallback(
    (target: "light" | "dark") => {
      if (onThemeModeChange) {
        onThemeModeChange(target);
      } else if (resolvedTheme !== target) {
        onCycleTheme();
      }
    },
    [onThemeModeChange, resolvedTheme, onCycleTheme],
  );

  // Global Cmd+K / Ctrl+K shortcut
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

  // Close popovers on outside pointerdown or Escape
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

  const navItems = useMemo<
    Array<{
      id: AppRoute;
      label: string;
      icon: React.ReactNode;
      badge?: string | number;
      badgeTone?: "neutral" | "danger";
    }>
  >(
    () => [
      {
        id: "dashboard",
        label: "机群总览",
        icon: (
          <Activity className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        ),
        badge: `${onlineCount}/${nodes.length}`,
        badgeTone: "neutral",
      },
      {
        id: "nodes",
        label: "服务器",
        icon: (
          <Server className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        ),
        badge: nodes.length,
        badgeTone: "neutral",
      },
      {
        id: "alerts",
        label: "告警通知",
        icon: <Bell className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
        badge: activeAlertsCount > 0 ? activeAlertsCount : undefined,
        badgeTone: "danger",
      },
      {
        id: "migration",
        label: "服务与迁移",
        icon: (
          <ArrowLeftRight
            className="h-4 w-4"
            strokeWidth={1.6}
            aria-hidden="true"
          />
        ),
      },
    ],
    [onlineCount, nodes.length, activeAlertsCount],
  );

  const currentNav =
    navItems.find((item) => item.id === route) ?? navItems[0]!;

  const commandItems = useMemo(() => {
    const items: Array<{
      id: string;
      group: string;
      title: string;
      subtitle: string;
      keywords: string;
      icon: React.ReactNode;
      action: () => void;
    }> = [
      ...navItems.map((nav) => ({
        id: `nav-${nav.id}`,
        group: "页面",
        title: nav.label,
        subtitle: "",
        keywords: `${nav.label} ${nav.id}`,
        icon: nav.icon,
        action: () => onRouteChange(nav.id),
      })),
      {
        id: "act-add-server",
        group: "操作",
        title: "添加服务器",
        subtitle: "",
        keywords: "添加 部署 服务器 add server",
        icon: <Plus className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />,
        action: onOpenAddServer,
      },
      {
        id: "act-theme",
        group: "外观",
        title: resolvedTheme === "light" ? "切换深色模式" : "切换浅色模式",
        subtitle: "",
        keywords: "主题 深色 浅色 theme dark light",
        icon:
          resolvedTheme === "light" ? (
            <Moon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
          ) : (
            <Sun className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
          ),
        action: () =>
          setDirectTheme(resolvedTheme === "light" ? "dark" : "light"),
      },
      ...ACCENT_OPTIONS.map((sw) => ({
        id: `act-accent-${sw.id}`,
        group: "主题色",
        title: sw.label,
        subtitle: "",
        keywords: `主题色 accent ${sw.label} ${sw.id}`,
        icon: (
          <span
            style={{ backgroundColor: sw.hex }}
            className="inline-block h-3 w-3 rounded-full"
            aria-hidden="true"
          />
        ),
        action: () => onAccentChange(sw.id),
      })),
      ...nodes.map((node) => {
        const meta = formatNodeMetaLine(node, {
          includeHostnameFallback: true,
        });
        const liveRate =
          node.online && node.metrics
            ? `↓${formatBytesPerSec(node.metrics.net.rx_bps)}`
            : node.online
              ? "在线"
              : "离线";
        return {
          id: `node-${node.id}`,
          group: "服务器",
          title: node.name,
          subtitle: [meta, liveRate].filter(Boolean).join(" · "),
          keywords: [
            node.name,
            node.hostname ?? "",
            node.group_name,
            node.region_code,
            node.provider,
            node.ipv4_masked,
            ...node.tags,
          ]
            .join(" ")
            .toLowerCase(),
          icon: (
            <Terminal
              className="h-4 w-4"
              strokeWidth={1.6}
              aria-hidden="true"
            />
          ),
          action: () => onSelectNode(node, "charts"),
        };
      }),
      {
        id: "act-logout",
        group: "会话",
        title: "退出登录",
        subtitle: authAccountLabel,
        keywords: "退出 注销 logout",
        icon: (
          <LogOut className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        ),
        action: () => {
          void handleLogoutClick();
        },
      },
    ];

    const q = cmdQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.subtitle.toLowerCase().includes(q) ||
        i.keywords.toLowerCase().includes(q) ||
        i.group.toLowerCase().includes(q),
    );
  }, [
    navItems,
    resolvedTheme,
    nodes,
    authAccountLabel,
    cmdQuery,
    onRouteChange,
    onOpenAddServer,
    setDirectTheme,
    onAccentChange,
    onSelectNode,
    handleLogoutClick,
  ]);

  useEffect(() => {
    setCmdIndex(0);
  }, [cmdQuery, cmdOpen]);

  return (
    <div
      style={{
        backgroundColor: "var(--bg-shell)",
        color: "var(--text-primary)",
      }}
      className="flex h-dvh w-full max-w-full overflow-hidden select-none sm:select-auto"
    >
      {/* Left Unified Sidebar (224px on Warm Paper) */}
      <aside
        aria-label="主侧栏"
        className="hidden w-[224px] shrink-0 flex-col justify-between px-3.5 py-4 md:flex"
      >
        <div className="space-y-5">
          {/* Workspace / Hub Mode Popover */}
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
                  <Layers
                    className="h-3.5 w-3.5"
                    strokeWidth={1.9}
                    aria-hidden="true"
                  />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] leading-tight font-semibold tracking-[-0.01em]">
                    UniOB
                  </div>
                  <div
                    style={{ color: "var(--text-tertiary)" }}
                    className="truncate text-[11px] leading-tight"
                  >
                    {hubModeLabel}
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
                className="absolute top-full left-0 z-30 mt-1.5 w-[204px] space-y-2 rounded-[10px] p-2.5"
              >
                <div className="space-y-1 px-1 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span style={{ color: "var(--text-tertiary)" }}>当前模式</span>
                    <span className="font-medium">{hubModeLabel}</span>
                  </div>
                  {hubStatus?.version && (
                    <div className="flex items-center justify-between">
                      <span style={{ color: "var(--text-tertiary)" }}>版本</span>
                      <span className="font-mono-num text-[11.5px]">
                        v{hubStatus.version.replace(/^v/, "")}
                      </span>
                    </div>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="xs"
                  className="w-full"
                  onClick={() => {
                    setWorkspacePopoverOpen(false);
                    onRouteChange("migration");
                  }}
                >
                  前往服务与迁移
                </Button>
              </div>
            )}
          </div>

          {/* Primary Navigation */}
          <nav aria-label="主导航" className="space-y-1">
            {navItems.map((item) => {
              const active = item.id === route;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onRouteChange(item.id)}
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

        {/* Bottom Connection & Session Footer */}
        <div
          style={{
            backgroundColor: "var(--bg-sheet)",
            border: "1px solid var(--border-hairline)",
          }}
          className="space-y-2.5 rounded-[10px] p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <StatusDot
              tone={wsIndicator.tone}
              label={wsIndicator.label}
              pulse={wsIndicator.pulse}
            />
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="font-mono-num text-[11px]"
            >
              {onlineCount}/{nodes.length}
            </span>
          </div>

          <div
            style={{ borderTop: "1px solid var(--border-hairline)" }}
            className="flex items-center justify-between gap-2 pt-2"
          >
            <span
              title={authAccountLabel}
              style={{ color: "var(--text-secondary)" }}
              className="truncate text-[11.5px]"
            >
              {authAccountLabel}
            </span>
            <button
              type="button"
              onClick={() => void handleLogoutClick()}
              disabled={loggingOut}
              aria-label="退出登录"
              style={{ color: "var(--text-tertiary)" }}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11.5px] font-medium transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--status-danger-ink)] disabled:opacity-45"
            >
              <LogOut className="h-3 w-3" aria-hidden="true" />
              <span>退出</span>
            </button>
          </div>
        </div>
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
                value={route}
                onChange={(e) => onRouteChange(e.target.value as AppRoute)}
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
                onClick={() => {
                  setCmdQuery("");
                  setCmdOpen(true);
                }}
                aria-label="打开搜索面板 (Ctrl+K)"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-hairline)",
                  color: "var(--text-secondary)",
                }}
                className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-[8px] px-2.5 text-[12px] whitespace-nowrap transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <Search
                  className="h-3.5 w-3.5 shrink-0"
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
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
                        onClick={() => setDirectTheme("light")}
                        style={{
                          border: `1px solid ${
                            resolvedTheme === "light"
                              ? "var(--accent)"
                              : "var(--border-subtle)"
                          }`,
                          backgroundColor:
                            resolvedTheme === "light"
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
                        onClick={() => setDirectTheme("dark")}
                        style={{
                          border: `1px solid ${
                            resolvedTheme === "dark"
                              ? "var(--accent)"
                              : "var(--border-subtle)"
                          }`,
                          backgroundColor:
                            resolvedTheme === "dark"
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
                            onClick={() => onAccentChange(sw.id)}
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
                onClick={onOpenAddServer}
                icon={
                  <Plus
                    className="h-3.5 w-3.5"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                }
              >
                添加服务器
              </Button>
            </div>
          </header>

          {/* Generous Airy Sheet Canvas */}
          <div className="thin-scrollbar min-w-0 flex-1 overflow-y-auto px-5 py-6 md:px-8 md:py-7">
            <div className="mx-auto min-w-0 max-w-[1360px]">{children}</div>
          </div>
        </main>
      </div>

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
