import React, { useId, useMemo } from "react";
import {
  Grid3x3,
  LayoutGrid,
  Plus,
  Search,
  Server,
  Table2,
  X,
} from "lucide-react";
import { Button, Card, SegmentedControl } from "./ui/Primitives";
import type {
  AppRoute,
  CardPrimaryMetric,
  DensityMode,
  FleetViewMode,
  HorizonNode,
  HubStatusResponse,
  InspectorTab,
} from "../types";
import { CARD_PRIMARY_METRIC_OPTIONS } from "../utils/cardMetrics";
import { BentoHeroStrip } from "./BentoHeroStrip";
import { FleetBentoGrid } from "./FleetBentoGrid";
import { FleetDataGrid } from "./FleetDataGrid";
import { FleetMatrixView } from "./FleetMatrixView";

export interface FleetOverviewPageProps {
  nodes: HorizonNode[];
  groups: string[];
  selectedGroup: string;
  onGroupChange: (g: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  viewMode: FleetViewMode;
  onViewModeChange: (m: FleetViewMode) => void;
  cardPrimaryMetric: CardPrimaryMetric;
  onCardPrimaryMetricChange: (m: CardPrimaryMetric) => void;
  activeAlertsCount: number;
  hubStatus: HubStatusResponse | null;
  density: DensityMode;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onMuteNode: (nodeId: string, seconds: number | null) => void | Promise<void>;
  onOpenAddServer: () => void;
  onNavigate: (route: AppRoute) => void;
}

export function FleetOverviewPage({
  nodes,
  groups,
  selectedGroup,
  onGroupChange,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  cardPrimaryMetric,
  onCardPrimaryMetricChange,
  activeAlertsCount,
  hubStatus,
  density,
  onSelectNode,
  onMuteNode,
  onOpenAddServer,
  onNavigate,
}: FleetOverviewPageProps): React.JSX.Element {
  const searchInputId = useId();

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return nodes.filter((n) => {
      if (
        selectedGroup &&
        selectedGroup !== "ALL" &&
        n.group_name !== selectedGroup
      ) {
        return false;
      }
      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        (n.hostname ?? "").toLowerCase().includes(q) ||
        (n.group_name ?? "").toLowerCase().includes(q) ||
        n.provider.toLowerCase().includes(q) ||
        n.region_code.toLowerCase().includes(q) ||
        n.ipv4_masked.toLowerCase().includes(q) ||
        (n.os ?? "").toLowerCase().includes(q) ||
        (Array.isArray(n.tags) &&
          n.tags.some((t) => t.toLowerCase().includes(q)))
      );
    });
  }, [nodes, selectedGroup, searchQuery]);

  const hasActiveFilters =
    (selectedGroup !== "ALL" && selectedGroup !== "") ||
    searchQuery.trim().length > 0;

  const resetFilters = () => {
    onGroupChange("ALL");
    onSearchChange("");
  };

  return (
    <div
      className={`min-w-0 ${density === "compact" ? "space-y-4" : "space-y-5"}`}
    >
      {/* 1. Top 5-Cell Hairline Summary Strip */}
      <BentoHeroStrip
        nodes={nodes}
        activeAlertsCount={activeAlertsCount}
        hubStatus={hubStatus}
        onSelectNode={onSelectNode}
        onNavigate={onNavigate}
      />

      {/* 2. Clean Single-Row Toolbar: Group Chips + Search + View Switcher */}
      <search
        aria-label="筛选服务器"
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div
          role="group"
          aria-label="分组"
          className="flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            aria-pressed={selectedGroup === "ALL" || selectedGroup === ""}
            onClick={() => onGroupChange("ALL")}
            style={
              selectedGroup === "ALL" || selectedGroup === ""
                ? {
                    backgroundColor: "var(--ink-primary)",
                    color: "var(--ink-on-primary)",
                    border: "1px solid transparent",
                  }
                : {
                    backgroundColor: "var(--bg-card)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-hairline)",
                  }
            }
            className="inline-flex h-8 cursor-pointer items-center rounded-[8px] px-3 text-[12.5px] font-medium transition-colors hover:border-[var(--border-strong)]"
          >
            全部
          </button>

          {groups.map((grp) => {
            const active = selectedGroup === grp;
            return (
              <button
                key={grp}
                type="button"
                aria-pressed={active}
                onClick={() => onGroupChange(grp)}
                style={
                  active
                    ? {
                        backgroundColor: "var(--ink-primary)",
                        color: "var(--ink-on-primary)",
                        border: "1px solid transparent",
                      }
                    : {
                        backgroundColor: "var(--bg-card)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border-hairline)",
                      }
                }
                className="inline-flex h-8 cursor-pointer items-center rounded-[8px] px-3 text-[12.5px] font-medium transition-colors hover:border-[var(--border-strong)]"
              >
                {grp}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[180px] flex-1 sm:w-[210px] sm:flex-initial">
            <label htmlFor={searchInputId} className="sr-only">
              搜索服务器
            </label>
            <Search
              style={{ color: "var(--text-tertiary)" }}
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2"
              strokeWidth={1.65}
              aria-hidden="true"
            />
            <input
              id={searchInputId}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索名称、分组或地域…"
              style={{
                backgroundColor: "var(--bg-card)",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-primary)",
              }}
              className="h-8 w-full rounded-[8px] pr-7 pl-8 text-[12.5px] transition-colors outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                aria-label="清空搜索"
                style={{ color: "var(--text-tertiary)" }}
                className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          {viewMode === "bento" && (
            <SegmentedControl<CardPrimaryMetric>
              ariaLabel="卡片主图表指标"
              value={cardPrimaryMetric}
              onChange={onCardPrimaryMetricChange}
              size="sm"
              options={CARD_PRIMARY_METRIC_OPTIONS}
            />
          )}

          <SegmentedControl<FleetViewMode>
            ariaLabel="视图布局"
            value={viewMode}
            onChange={onViewModeChange}
            options={[
              {
                value: "bento",
                label: "卡片",
                icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />,
              },
              {
                value: "table",
                label: "列表",
                icon: <Table2 className="h-3.5 w-3.5" aria-hidden="true" />,
              },
              {
                value: "matrix",
                label: "矩阵",
                icon: <Grid3x3 className="h-3.5 w-3.5" aria-hidden="true" />,
              },
            ]}
          />
        </div>
      </search>

      {/* 3. Fleet Views */}
      {filteredNodes.length === 0 ? (
        <Card className="py-14 text-center">
          <Server
            style={{ color: "var(--text-muted)" }}
            className="mx-auto mb-3 h-7 w-7"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <p className="text-[13.5px] font-medium">
            {nodes.length === 0 ? "暂无服务器" : "没有匹配的服务器"}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            {hasActiveFilters && (
              <Button variant="secondary" size="sm" onClick={resetFilters}>
                重置筛选
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={onOpenAddServer}
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              添加服务器
            </Button>
          </div>
        </Card>
      ) : viewMode === "bento" ? (
        <FleetBentoGrid
          nodes={filteredNodes}
          density={density}
          primaryMetric={cardPrimaryMetric}
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
