import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Sun,
  Table2,
} from "lucide-react";
import type {
  AppRoute,
  NodeSummary,
  ThemeMode,
  ViewMode,
} from "../types";
import type { WsConnectionStatus } from "../hooks/useFleetSocket";
import { formatRate } from "../utils/format";

interface GlobalStatusBarProps {
  nodes: NodeSummary[];
  activeAlertsCount: number;
  wsStatus: WsConnectionStatus;
  route: AppRoute;
  onRouteChange: (route: AppRoute) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  groups: string[];
  selectedGroup: string;
  onGroupChange: (group: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onOpenAddModal: () => void;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  authMode: "builtin" | "cf_access";
  authEmail?: string;
  onLogout: () => void;
}

export function GlobalStatusBar({
  nodes,
  activeAlertsCount,
  wsStatus,
  route,
  onRouteChange,
  viewMode,
  onViewModeChange,
  groups,
  selectedGroup,
  onGroupChange,
  searchQuery,
  onSearchChange,
  onOpenAddModal,
  themeMode,
  onCycleTheme,
  authMode,
  authEmail,
  onLogout,
}: GlobalStatusBarProps) {
  const totalCount = nodes.length;
  const onlineCount = nodes.filter((n) => n.online).length;

  let totalTxBps = 0;
  let totalRxBps = 0;
  for (const n of nodes) {
    if (n.online && n.metrics) {
      totalTxBps += n.metrics.net.tx_bps;
      totalRxBps += n.metrics.net.rx_bps;
    }
  }

  const wsLamp =
    wsStatus === "connected"
      ? {
          dot: "bg-emerald-500",
          ring: true,
          label: "已连接",
          cls: "text-emerald-600 dark:text-emerald-400 border-emerald-500/25 bg-emerald-500/10",
        }
      : wsStatus === "connecting" || wsStatus === "reconnecting"
        ? {
            dot: "bg-amber-500",
            ring: false,
            label: wsStatus === "connecting" ? "连接中" : "重连中",
            cls: "text-amber-600 dark:text-amber-400 border-amber-500/25 bg-amber-500/10",
          }
        : {
            dot: "bg-rose-500",
            ring: false,
            label: "已断开",
            cls: "text-rose-600 dark:text-rose-400 border-rose-500/25 bg-rose-500/10",
          };

  const ThemeIcon =
    themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor;
  const themeLabel =
    themeMode === "dark" ? "深色" : themeMode === "light" ? "浅色" : "系统";

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-[#0b111d]/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        {/* Top Row: Brand, Navigation, Telemetry Summary, Actions */}
        <div className="py-3 flex flex-wrap items-center justify-between gap-3">
          {/* Left: Brand + Nav */}
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => onRouteChange("dashboard")}
              className="flex items-center gap-2.5 text-left"
            >
              <div className="w-8 h-8 rounded-lg bg-slate-900 dark:bg-sky-500/15 border border-slate-700 dark:border-sky-500/30 flex items-center justify-center">
                <Activity className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              </div>
              <div>
                <div className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50 leading-none">
                  UniOB
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  服务器监控面板
                </div>
              </div>
            </button>

            <nav
              aria-label="主导航"
              className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#090d14] p-0.5 text-xs"
            >
              {(
                [
                  { key: "dashboard", label: "服务器总览" },
                  { key: "nodes", label: "服务器管理" },
                  { key: "alerts", label: "告警通知" },
                ] as const
              ).map((item) => {
                const active = route === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => onRouteChange(item.key)}
                    className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                      active
                        ? "bg-white dark:bg-[#161f30] text-slate-900 dark:text-slate-50 shadow-xs"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Right: Live Stats + Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Online/Total pill */}
            <div
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0f1623] text-xs font-mono-num"
              title={`在线 ${onlineCount} 台，共 ${totalCount} 台服务器`}
            >
              <Server className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                {onlineCount}
              </span>
              <span className="text-slate-400">/</span>
              <span className="text-slate-700 dark:text-slate-200">{totalCount}</span>
            </div>

            {/* Aggregate Fleet TX / RX */}
            <div className="hidden sm:inline-flex items-center gap-2.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0f1623] text-xs font-mono-num">
              <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                <ArrowUp className="w-3 h-3" aria-hidden="true" />
                {formatRate(totalTxBps)}
              </span>
              <span className="text-slate-300 dark:text-slate-700">|</span>
              <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                <ArrowDown className="w-3 h-3" aria-hidden="true" />
                {formatRate(totalRxBps)}
              </span>
            </div>

            {/* Clickable Active Alerts Badge */}
            <button
              type="button"
              onClick={() => onRouteChange("alerts")}
              aria-label={`告警 ${activeAlertsCount} 条，点击查看详情`}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-mono-num font-medium transition-colors ${
                activeAlertsCount > 0
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-300 hover:bg-rose-500/25"
                  : "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0f1623] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
              title="查看告警通知与历史记录"
            >
              <Bell
                className={`w-3.5 h-3.5 ${
                  activeAlertsCount > 0 ? "text-rose-500 animate-pulse" : "text-slate-400"
                }`}
                aria-hidden="true"
              />
              <span>告警 {activeAlertsCount}</span>
            </button>

            {/* Connection Status Lamp */}
            <div
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-medium ${wsLamp.cls}`}
            >
              <span className="relative flex h-2 w-2" aria-hidden="true">
                {wsLamp.ring && (
                  <span className="animate-status-ring absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${wsLamp.dot}`} />
              </span>
              <span className="hidden md:inline">{wsLamp.label}</span>
            </div>

            {/* + Add Server */}
            <button
              type="button"
              onClick={onOpenAddModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              添加服务器
            </button>

            {/* Theme toggle */}
            <button
              type="button"
              onClick={onCycleTheme}
              aria-label={`切换显示主题，当前：${themeLabel}`}
              title={`当前主题: ${themeLabel} (点击切换)`}
              className="inline-flex items-center gap-1 p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <ThemeIcon className="w-4 h-4" aria-hidden="true" />
            </button>

            {/* Auth / Logout */}
            {authMode === "builtin" ? (
              <button
                type="button"
                onClick={onLogout}
                aria-label="退出登录"
                title="退出登录"
                className="inline-flex items-center gap-1 p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] text-slate-600 dark:text-slate-300 hover:text-rose-500 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <LogOut className="w-4 h-4" aria-hidden="true" />
              </button>
            ) : (
              <div className="inline-flex items-center gap-1.5">
                <span
                  title={authEmail ? `Cloudflare 认证账号: ${authEmail}` : "Cloudflare 安全认证"}
                  className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[11px] font-mono-num"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
                  <span>{authEmail || "Cloudflare 认证"}</span>
                </span>
                <a
                  href="/cdn-cgi/access/logout"
                  title="退出登录"
                  aria-label="退出登录"
                  className="inline-flex items-center gap-1 p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] text-slate-600 dark:text-slate-300 hover:text-rose-500 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <LogOut className="w-4 h-4" aria-hidden="true" />
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Sub-bar (Dashboard filters & View Toggle) */}
        {route === "dashboard" && (
          <div className="pb-3 flex flex-wrap items-center justify-between gap-2.5">
            {/* Group Pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => onGroupChange("ALL")}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                  selectedGroup === "ALL"
                    ? "bg-slate-900 dark:bg-sky-500/20 text-white dark:text-sky-300 border-slate-900 dark:border-sky-500/40"
                    : "bg-slate-100 dark:bg-[#0f1623] text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:text-slate-900 dark:hover:text-slate-200"
                }`}
              >
                全部 ({nodes.length})
              </button>
              {groups.map((grp) => {
                const count = nodes.filter((n) => n.group_name === grp).length;
                const active = selectedGroup === grp;
                return (
                  <button
                    key={grp}
                    type="button"
                    onClick={() => onGroupChange(grp)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                      active
                        ? "bg-slate-900 dark:bg-sky-500/20 text-white dark:text-sky-300 border-slate-900 dark:border-sky-500/40"
                        : "bg-slate-100 dark:bg-[#0f1623] text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:text-slate-900 dark:hover:text-slate-200"
                    }`}
                  >
                    {grp} ({count})
                  </button>
                );
              })}
            </div>

            {/* Search + Grid/Table Toggle */}
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-56">
                <label htmlFor="fleet-search-input" className="sr-only">
                  搜索服务器
                </label>
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
                <input
                  id="fleet-search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="搜索服务器名称、域名或标签..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0f1623] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>

              <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#0f1623] p-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => onViewModeChange("grid")}
                  aria-label="卡片网格视图"
                  aria-pressed={viewMode === "grid"}
                  title="卡片视图"
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === "grid"
                      ? "bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 shadow-xs"
                      : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange("table")}
                  aria-label="紧凑表格视图"
                  aria-pressed={viewMode === "table"}
                  title="表格视图"
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === "table"
                      ? "bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 shadow-xs"
                      : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  <Table2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
