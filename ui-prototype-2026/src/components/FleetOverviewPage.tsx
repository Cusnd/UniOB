import { useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  LayoutGrid,
  Layers,
  Plus,
  Search,
  Server,
  Table2,
  X,
} from "lucide-react";
import type {
  AppRoute,
  DensityMode,
  FleetViewMode,
  HubStatusResponse,
  InspectorTab,
  PrototypeNode,
} from "../types";
import { getMemUsagePct, getTrafficUsagePct } from "../utils/format";
import { BentoHeroStrip } from "./BentoHeroStrip";
import { FleetBentoGrid } from "./FleetBentoGrid";
import { FleetDataGrid } from "./FleetDataGrid";
import { FleetMatrixView } from "./FleetMatrixView";

export interface FleetOverviewPageProps {
  nodes: PrototypeNode[];
  groups: string[];
  selectedGroup: string;
  onGroupChange: (group: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  viewMode: FleetViewMode;
  onViewModeChange: (mode: FleetViewMode) => void;
  activeAlertsCount: number;
  hubStatus: HubStatusResponse;
  density: DensityMode;
  onSelectNode: (node: PrototypeNode, initialTab?: InspectorTab) => void;
  onMuteNode: (nodeId: string, seconds: number | null) => void;
  onOpenAddServer: () => void;
  onNavigate: (route: AppRoute) => void;
}

type HealthFilter = "all" | "online" | "attention" | "offline";

function isAttentionNode(node: PrototypeNode): boolean {
  if (!node.online) return true;
  const steal = node.metrics?.cpu.steal ?? 0;
  const memPct = getMemUsagePct(node);
  const trafficPct = getTrafficUsagePct(node.traffic);
  const hasTrafficWarn =
    node.traffic.limit_bytes !== null &&
    node.traffic.limit_bytes > 0 &&
    trafficPct >= 85;
  return steal >= 1.5 || memPct >= 85 || hasTrafficWarn;
}

/**
 * 机群总览主视图：整合 4 格 Bento 驾驶舱与 Bento卡片 / 精密表格 / 分组矩阵三态视图。
 */
export function FleetOverviewPage({
  nodes,
  groups,
  selectedGroup,
  onGroupChange,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  activeAlertsCount,
  hubStatus,
  density,
  onSelectNode,
  onMuteNode,
  onOpenAddServer,
  onNavigate,
}: FleetOverviewPageProps): React.JSX.Element {
  const searchInputId = useId();
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      counts.set(n.group_name, (counts.get(n.group_name) ?? 0) + 1);
    }
    return counts;
  }, [nodes]);

  const attentionCount = useMemo(
    () => nodes.filter(isAttentionNode).length,
    [nodes],
  );
  const offlineCount = useMemo(
    () => nodes.filter((n) => !n.online).length,
    [nodes],
  );

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return nodes.filter((n) => {
      if (selectedGroup && selectedGroup !== "ALL" && n.group_name !== selectedGroup) {
        return false;
      }
      if (healthFilter === "online" && !n.online) return false;
      if (healthFilter === "offline" && n.online) return false;
      if (healthFilter === "attention" && !isAttentionNode(n)) return false;

      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        (n.hostname ?? "").toLowerCase().includes(q) ||
        n.group_name.toLowerCase().includes(q) ||
        n.provider.toLowerCase().includes(q) ||
        n.region_code.toLowerCase().includes(q) ||
        n.ipv4_masked.toLowerCase().includes(q) ||
        (n.os ?? "").toLowerCase().includes(q) ||
        (Array.isArray(n.tags) && n.tags.some((t) => t.toLowerCase().includes(q)))
      );
    });
  }, [nodes, selectedGroup, healthFilter, searchQuery]);

  const hasActiveFilters =
    (selectedGroup !== "ALL" && selectedGroup !== "") ||
    healthFilter !== "all" ||
    searchQuery.trim().length > 0;

  const resetFilters = () => {
    onGroupChange("ALL");
    onSearchChange("");
    setHealthFilter("all");
  };

  return (
    <div className={density === "compact" ? "space-y-3.5" : "space-y-5"}>
      {/* Top 4-card Cockpit */}
      <BentoHeroStrip
        nodes={nodes}
        activeAlertsCount={activeAlertsCount}
        hubStatus={hubStatus}
        onSelectNode={onSelectNode}
        onNavigate={onNavigate}
      />

      {/* Filter & View Switcher Toolbar */}
      <div className="surface-card rounded-2xl p-3 sm:p-3.5 space-y-2.5">
        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
          {/* Group Pills */}
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="按业务分组筛选"
          >
            <button
              type="button"
              onClick={() => onGroupChange("ALL")}
              aria-pressed={selectedGroup === "ALL" || selectedGroup === ""}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                selectedGroup === "ALL" || selectedGroup === ""
                  ? "bg-[var(--accent-solid)] text-white border-[var(--accent-solid)] shadow-xs"
                  : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-[var(--text-primary)]"
              }`}
            >
              全部 ({nodes.length})
            </button>

            {groups.map((grp) => {
              const count = groupCounts.get(grp) ?? 0;
              const active = selectedGroup === grp;
              return (
                <button
                  key={grp}
                  type="button"
                  onClick={() => onGroupChange(grp)}
                  aria-pressed={active}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                    active
                      ? "bg-[var(--accent-solid)] text-white border-[var(--accent-solid)] shadow-xs"
                      : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {grp}{" "}
                  <span className={active ? "opacity-85" : "opacity-70"}>
                    ({count})
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search + View Switcher */}
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
            <div className="relative flex-1 sm:w-64">
              <label htmlFor={searchInputId} className="sr-only">
                搜索服务器
              </label>
              <Search
                className="w-3.5 h-3.5 text-[var(--text-secondary)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id={searchInputId}
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="搜索名称、地区、服务商、标签..."
                className="w-full pl-8 pr-8 py-1.5 text-xs rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] placeholder:text-[var(--text-muted,var(--text-secondary))] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  aria-label="清空搜索"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            <div
              className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-0.5 shrink-0"
              role="group"
              aria-label="切换机群视图模式"
            >
              {(
                [
                  { key: "bento", label: "Bento 卡片", icon: LayoutGrid },
                  { key: "table", label: "精密表格", icon: Table2 },
                  { key: "matrix", label: "分组矩阵", icon: Layers },
                ] as const
              ).map(({ key, label, icon: Icon }) => {
                const active = viewMode === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onViewModeChange(key)}
                    aria-pressed={active}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      active
                        ? "bg-[var(--bg-surface)] text-[var(--accent-primary)] shadow-xs"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Sub-row: Health quick filter + result summary */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)] text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { key: "all", label: "全部状态" },
                { key: "online", label: "仅在线" },
                {
                  key: "attention",
                  label: `需关注 (${attentionCount})`,
                  highlight: attentionCount > 0,
                },
                {
                  key: "offline",
                  label: `离线 (${offlineCount})`,
                  critical: offlineCount > 0,
                },
              ] as const
            ).map((item) => {
              const active = healthFilter === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setHealthFilter(item.key)}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border transition-colors font-medium ${
                    active
                      ? "border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent-primary)]"
                      : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {"highlight" in item && item.highlight && (
                    <AlertTriangle className="w-3 h-3 text-amber-500" aria-hidden="true" />
                  )}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 font-mono-num text-[var(--text-secondary)]">
            <span>
              显示 <strong className="text-[var(--text-primary)]">{filteredNodes.length}</strong> /{" "}
              {nodes.length} 台服务器
            </span>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="text-[var(--accent-primary)] hover:underline font-sans font-medium"
              >
                重置筛选
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Fleet View */}
      {filteredNodes.length === 0 ? (
        <div className="surface-card rounded-2xl border-dashed p-12 text-center space-y-3">
          <Server
            className="w-9 h-9 mx-auto text-[var(--text-muted,var(--text-secondary))]"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              没有符合当前条件的服务器
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              可尝试放宽分组、状态或关键词过滤，或直接部署一台新节点探针。
            </p>
          </div>
          <div className="flex items-center justify-center gap-2">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="px-3.5 py-1.5 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent-ring)]"
              >
                重置筛选
              </button>
            )}
            <button
              type="button"
              onClick={onOpenAddServer}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-[var(--accent-solid)] hover:bg-[var(--accent-primary)] text-white shadow-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              部署探针
            </button>
          </div>
        </div>
      ) : viewMode === "bento" ? (
        <FleetBentoGrid
          nodes={filteredNodes}
          density={density}
          onSelectNode={onSelectNode}
          onMuteNode={onMuteNode}
        />
      ) : viewMode === "table" ? (
        <FleetDataGrid
          nodes={filteredNodes}
          density={density}
          onSelectNode={onSelectNode}
          onMuteNode={onMuteNode}
        />
      ) : (
        <FleetMatrixView
          nodes={filteredNodes}
          density={density}
          onSelectNode={onSelectNode}
        />
      )}
    </div>
  );
}
