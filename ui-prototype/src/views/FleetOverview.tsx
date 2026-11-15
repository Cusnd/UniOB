import React, { useId, useMemo, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Grid3x3,
  LayoutGrid,
  Plus,
  Search,
  Server,
  Table2,
  X,
} from "lucide-react";
import {
  Button,
  Card,
  MetricBar,
  ObservabilityChart,
  SegmentedControl,
  Sparkline,
  StatusDot,
  formatRateKbps,
  type StatusDotTone,
} from "../components/ui/Primitives";
import type {
  FleetDisplayMode,
  FleetNode,
  FleetOverviewProps,
} from "../types";

type SimpleGroupFilter = "ALL" | "PROD" | "APAC" | "WEST" | "LIGHT";

type SortColumn =
  | "name"
  | "region"
  | "net"
  | "cpu"
  | "mem"
  | "disk"
  | "traffic";
type SortDirection = "asc" | "desc";

const COLLATOR = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

const SORT_LABELS: Record<SortColumn, string> = {
  name: "服务器",
  region: "地域",
  net: "实时网速",
  cpu: "CPU",
  mem: "内存",
  disk: "磁盘",
  traffic: "流量",
};

function formatRamGb(usedMb: number, totalMb: number): string {
  const totalGb = totalMb / 1024;
  const usedGb = usedMb / 1024;
  const totalStr = Number.isInteger(totalGb)
    ? `${totalGb}`
    : totalGb.toFixed(1);
  return `${usedGb.toFixed(1)} / ${totalStr} GB`;
}

function formatTrafficText(usedGb: number, limitGb: number | null): string {
  const fmt = (gb: number) =>
    gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${Math.round(gb)} GB`;
  if (!limitGb || limitGb <= 0) {
    return fmt(usedGb);
  }
  return `${fmt(usedGb)} / ${fmt(limitGb)}`;
}

function getMemPct(node: FleetNode): number {
  if (!node.online || node.memTotalMb <= 0) return 0;
  return (node.memUsedMb / node.memTotalMb) * 100;
}

function getRootMount(node: FleetNode) {
  return (
    node.mounts.find((m) => m.mountpoint === "/") ??
    node.mounts[0] ?? {
      mountpoint: "/",
      fsType: "ext4",
      totalGb: 20,
      usedGb: 0,
      readKbps: 0,
      writeKbps: 0,
    }
  );
}

function getDiskPct(node: FleetNode): number {
  const root = getRootMount(node);
  if (root.totalGb <= 0) return 0;
  return (root.usedGb / root.totalGb) * 100;
}

function getTrafficPct(node: FleetNode): number {
  if (!node.monthlyTrafficLimitGb || node.monthlyTrafficLimitGb <= 0) {
    return Math.min(100, (node.monthlyTrafficUsedGb / 5000) * 100);
  }
  return (node.monthlyTrafficUsedGb / node.monthlyTrafficLimitGb) * 100;
}

function getStatusTone(
  node: FleetNode,
  firingNodeIds: Set<string>,
): StatusDotTone {
  if (!node.online) return "danger";
  if (firingNodeIds.has(node.id) || node.cpuPct >= 88 || getMemPct(node) >= 88) {
    return "warn";
  }
  return "ok";
}

export function FleetOverview({
  nodes,
  incidents,
  selectedNodeId,
  onSelectNode,
  onOpenProvision,
  onNavigate,
}: FleetOverviewProps): React.JSX.Element {
  const searchId = useId();
  const tableCaptionId = useId();

  const [displayMode, setDisplayMode] = useState<FleetDisplayMode>("cards");
  const [groupFilter, setGroupFilter] = useState<SimpleGroupFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  const [sortCol, setSortCol] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [sortAnnouncement, setSortAnnouncement] = useState("");

  const firingIncidents = useMemo(
    () => incidents.filter((inc) => inc.status === "firing"),
    [incidents],
  );

  const firingNodeIds = useMemo(
    () => new Set(firingIncidents.map((inc) => inc.nodeId)),
    [firingIncidents],
  );

  const summary = useMemo(() => {
    const onlineNodes = nodes.filter((n) => n.online);
    const onlineCount = onlineNodes.length;
    const onlinePct = nodes.length > 0 ? (onlineCount / nodes.length) * 100 : 0;

    const totalRxKbps = onlineNodes.reduce((s, n) => s + n.netRxKbps, 0);
    const totalTxKbps = onlineNodes.reduce((s, n) => s + n.netTxKbps, 0);

    const avgCpu =
      onlineCount > 0
        ? onlineNodes.reduce((s, n) => s + n.cpuPct, 0) / onlineCount
        : 0;

    const totalMem = onlineNodes.reduce((s, n) => s + n.memTotalMb, 0);
    const usedMem = onlineNodes.reduce((s, n) => s + n.memUsedMb, 0);
    const avgMemPct = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

    const len = 24;
    const fleetCpuSeries = Array.from({ length: len }, (_, idx) => {
      if (onlineCount === 0) return 0;
      let sum = 0;
      for (const n of onlineNodes) {
        const ptIdx = Math.max(0, n.series.length - len + idx);
        sum += n.series[ptIdx]?.cpu ?? n.cpuPct;
      }
      return Number((sum / onlineCount).toFixed(1));
    });

    return {
      onlineCount,
      onlinePct,
      totalRxKbps,
      totalTxKbps,
      avgCpu,
      avgMemPct,
      fleetCpuSeries,
      alertCount: firingIncidents.length,
    };
  }, [nodes, firingIncidents.length]);

  const groupChips: Array<{ id: SimpleGroupFilter; label: string }> = [
    { id: "ALL", label: "全部" },
    { id: "PROD", label: "生产" },
    { id: "APAC", label: "亚太" },
    { id: "WEST", label: "欧美" },
    { id: "LIGHT", label: "轻量" },
  ];

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return nodes.filter((node) => {
      if (groupFilter === "PROD") {
        if (node.group !== "生产核心" && node.group !== "中枢本机") return false;
      } else if (groupFilter === "APAC") {
        if (node.group !== "亚太边缘") return false;
      } else if (groupFilter === "WEST") {
        if (node.group !== "欧美枢纽") return false;
      } else if (groupFilter === "LIGHT") {
        if (node.group !== "1G 小鸡" && !node.isTinyVps) return false;
      }

      if (!q) return true;
      return (
        node.name.toLowerCase().includes(q) ||
        node.regionCode.toLowerCase().includes(q) ||
        node.regionShort.toLowerCase().includes(q) ||
        node.ipv4.toLowerCase().includes(q) ||
        node.os.toLowerCase().includes(q)
      );
    });
  }, [nodes, groupFilter, searchQuery]);

  const sortedNodes = useMemo(() => {
    if (!sortCol) return filteredNodes;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filteredNodes].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case "name":
          cmp = COLLATOR.compare(a.name, b.name);
          break;
        case "region":
          cmp = COLLATOR.compare(a.regionCode, b.regionCode);
          break;
        case "net":
          cmp =
            (a.online ? a.netRxKbps + a.netTxKbps : -1) -
            (b.online ? b.netRxKbps + b.netTxKbps : -1);
          break;
        case "cpu":
          cmp = (a.online ? a.cpuPct : -1) - (b.online ? b.cpuPct : -1);
          break;
        case "mem":
          cmp = (a.online ? getMemPct(a) : -1) - (b.online ? getMemPct(b) : -1);
          break;
        case "disk":
          cmp = getDiskPct(a) - getDiskPct(b);
          break;
        case "traffic":
          cmp = getTrafficPct(a) - getTrafficPct(b);
          break;
      }
      if (cmp === 0) cmp = COLLATOR.compare(a.name, b.name);
      return cmp * dir;
    });
  }, [filteredNodes, sortCol, sortDir]);

  const matrixGroups = useMemo(() => {
    const order: Array<{ key: FleetNode["group"]; title: string }> = [
      { key: "生产核心", title: "生产" },
      { key: "亚太边缘", title: "亚太" },
      { key: "欧美枢纽", title: "欧美" },
      { key: "1G 小鸡", title: "轻量" },
      { key: "中枢本机", title: "本机" },
    ];
    return order
      .map((g) => {
        const list = filteredNodes.filter((n) => n.group === g.key);
        const onlineCount = list.filter((n) => n.online).length;
        return { ...g, list, onlineCount };
      })
      .filter((g) => g.list.length > 0);
  }, [filteredNodes]);

  const handleSort = (col: SortColumn) => {
    const nextDir: SortDirection =
      sortCol === col
        ? sortDir === "asc"
          ? "desc"
          : "asc"
        : col === "name" || col === "region"
          ? "asc"
          : "desc";
    setSortCol(col);
    setSortDir(nextDir);
    setSortAnnouncement(
      `已按${SORT_LABELS[col]}${nextDir === "asc" ? "升序" : "降序"}排列`,
    );
  };

  const renderSortIcon = (col: SortColumn) => {
    if (sortCol !== col) {
      return (
        <ArrowUpDown
          style={{ color: "var(--text-muted)" }}
          className="h-3 w-3 shrink-0"
          aria-hidden="true"
        />
      );
    }
    return sortDir === "asc" ? (
      <ChevronUp
        style={{ color: "var(--accent)" }}
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
    ) : (
      <ChevronDown
        style={{ color: "var(--accent)" }}
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
    );
  };

  const hasFilter = groupFilter !== "ALL" || searchQuery.trim().length > 0;

  return (
    <div className="min-w-0 space-y-5">
      {/* ====================================================================
       * 1. Top 5-Cell Hairline Summary Strip
       * ==================================================================== */}
      <section aria-label="机群概览指标" className="atelier-card px-5 py-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5 xl:gap-0">
          {/* Cell 1: Online Nodes */}
          <div
            style={{ borderColor: "var(--border-hairline)" }}
            className="flex min-w-0 flex-col justify-between gap-2 xl:border-r xl:pr-5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="text-[12px] font-medium"
              >
                在线节点
              </span>
              <div className="font-mono-num flex items-baseline gap-1 text-[20px] leading-none font-semibold tracking-[-0.02em]">
                <span>{summary.onlineCount}</span>
                <span
                  style={{ color: "var(--text-tertiary)" }}
                  className="text-[13px] font-normal"
                >
                  / {nodes.length}
                </span>
              </div>
            </div>
            <MetricBar
              valuePct={summary.onlinePct}
              toneOverride={
                summary.onlineCount === nodes.length ? "ok" : "warn"
              }
              thickness={3}
            />
          </div>

          {/* Cell 2: Live Total Network Speed */}
          <div
            style={{ borderColor: "var(--border-hairline)" }}
            className="flex min-w-0 flex-col justify-between gap-1.5 xl:border-r xl:px-5"
          >
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px] font-medium"
            >
              实时总网速
            </span>
            <div className="font-mono-num flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13.5px] leading-tight font-semibold">
              <span style={{ color: "var(--accent-ink)" }}>
                ↓ {formatRateKbps(summary.totalRxKbps)}
              </span>
              <span style={{ color: "var(--status-ok-ink)" }}>
                ↑ {formatRateKbps(summary.totalTxKbps)}
              </span>
            </div>
          </div>

          {/* Cell 3: Average CPU + Mini Observability Sparkline */}
          <div
            style={{ borderColor: "var(--border-hairline)" }}
            className="flex min-w-0 items-center justify-between gap-3 xl:border-r xl:px-5"
          >
            <div className="shrink-0 space-y-1.5">
              <div
                style={{ color: "var(--text-tertiary)" }}
                className="text-[12px] font-medium"
              >
                平均 CPU
              </div>
              <div className="font-mono-num text-[20px] leading-none font-semibold tracking-[-0.02em]">
                {summary.avgCpu.toFixed(0)}%
              </div>
            </div>
            <div className="min-w-[68px] flex-1 max-w-[110px]">
              <Sparkline
                data={summary.fleetCpuSeries}
                height={28}
                max={100}
                tone="accent"
              />
            </div>
          </div>

          {/* Cell 4: Average Memory */}
          <div
            style={{ borderColor: "var(--border-hairline)" }}
            className="flex min-w-0 flex-col justify-between gap-2 xl:border-r xl:px-5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                style={{ color: "var(--text-tertiary)" }}
                className="text-[12px] font-medium"
              >
                平均内存
              </span>
              <span className="font-mono-num text-[20px] leading-none font-semibold tracking-[-0.02em]">
                {summary.avgMemPct.toFixed(0)}%
              </span>
            </div>
            <MetricBar valuePct={summary.avgMemPct} thickness={3} />
          </div>

          {/* Cell 5: Active Alerts */}
          <button
            type="button"
            onClick={() => onNavigate("alerts")}
            className="flex min-w-0 cursor-pointer flex-col justify-between gap-1.5 text-left transition-opacity hover:opacity-80 xl:pl-5"
          >
            <span
              style={{ color: "var(--text-tertiary)" }}
              className="text-[12px] font-medium"
            >
              活跃告警
            </span>
            <div className="flex items-baseline gap-2">
              <span
                style={{
                  color:
                    summary.alertCount > 0
                      ? "var(--status-danger-ink)"
                      : "var(--text-primary)",
                }}
                className="font-mono-num text-[20px] leading-none font-semibold tracking-[-0.02em]"
              >
                {summary.alertCount}
              </span>
              <span
                style={{
                  color:
                    summary.alertCount > 0
                      ? "var(--status-danger-ink)"
                      : "var(--text-tertiary)",
                }}
                className="text-[12px]"
              >
                {summary.alertCount > 0 ? "待处理" : "全部正常"}
              </span>
            </div>
          </button>
        </div>
      </section>

      {/* ====================================================================
       * 2. Clean Single-Row Toolbar: Group Chips + Search + View Switcher
       * ==================================================================== */}
      <search
        aria-label="筛选服务器"
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div
          role="group"
          aria-label="分组"
          className="flex flex-wrap items-center gap-1.5"
        >
          {groupChips.map((chip) => {
            const active = groupFilter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={active}
                onClick={() => setGroupFilter(chip.id)}
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
                {chip.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 sm:flex-nowrap">
          <div className="relative min-w-[180px] flex-1 sm:w-[220px] sm:flex-initial">
            <label htmlFor={searchId} className="sr-only">
              搜索服务器
            </label>
            <Search
              style={{ color: "var(--text-tertiary)" }}
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2"
              strokeWidth={1.65}
              aria-hidden="true"
            />
            <input
              id={searchId}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索名称、地域或 IP…"
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
                onClick={() => setSearchQuery("")}
                aria-label="清空搜索"
                style={{ color: "var(--text-tertiary)" }}
                className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          <SegmentedControl<FleetDisplayMode>
            ariaLabel="视图布局"
            value={displayMode}
            onChange={setDisplayMode}
            options={[
              {
                value: "cards",
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

      {/* ====================================================================
       * 3. Views: Cards / List / Matrix
       * ==================================================================== */}
      {filteredNodes.length === 0 ? (
        <Card className="py-14 text-center">
          <Server
            style={{ color: "var(--text-muted)" }}
            className="mx-auto mb-3 h-7 w-7"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <p className="text-[13.5px] font-medium">没有匹配的服务器</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            {hasFilter && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setGroupFilter("ALL");
                  setSearchQuery("");
                }}
              >
                重置筛选
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={onOpenProvision}
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              添加服务器
            </Button>
          </div>
        </Card>
      ) : displayMode === "cards" ? (
        /* ==================================================================
         * VIEW 1: 卡片 (Live Dual-Series RX/TX Observability + 2x2 Bars)
         * ================================================================== */
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredNodes.map((node) => {
            const isSelected = node.id === selectedNodeId;
            const memPct = getMemPct(node);
            const diskPct = getDiskPct(node);
            const rootMount = getRootMount(node);
            const trafficPct = getTrafficPct(node);
            const statusTone = getStatusTone(node, firingNodeIds);
            const recentSeries = node.series.slice(-30);

            return (
              <article
                key={node.id}
                tabIndex={0}
                onClick={() => onSelectNode(node.id, "telemetry")}
                onKeyDown={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    (e.key === "Enter" || e.key === " ")
                  ) {
                    e.preventDefault();
                    onSelectNode(node.id, "telemetry");
                  }
                }}
                aria-label={`${node.name}，${node.regionCode}`}
                style={
                  isSelected
                    ? {
                        borderColor: "var(--accent)",
                        boxShadow:
                          "0 0 0 1px var(--accent-border), var(--shadow-card-hover)",
                      }
                    : undefined
                }
                className="atelier-card atelier-card-interactive flex min-w-0 cursor-pointer flex-col gap-4 p-5"
              >
                {/* Header: Status Dot + Name + Region */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusDot tone={statusTone} />
                    <h3 className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">
                      {node.name}
                    </h3>
                  </div>
                  <span
                    style={{
                      color: node.online
                        ? "var(--text-tertiary)"
                        : "var(--status-danger-ink)",
                    }}
                    className="shrink-0 text-[12px]"
                  >
                    {node.online ? node.regionCode : `${node.regionCode} · 离线`}
                  </span>
                </div>

                {/* Live Network RX/TX Observability Chart */}
                <div
                  style={{
                    backgroundColor: "var(--bg-card)",
                    borderTop: "1px solid var(--border-hairline)",
                    borderBottom: "1px solid var(--border-hairline)",
                  }}
                  className="min-w-0 py-2.5"
                >
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span
                      style={{ color: "var(--text-tertiary)" }}
                      className="text-[11.5px]"
                    >
                      实时网络
                    </span>
                    {node.online ? (
                      <div className="font-mono-num flex items-center gap-2.5 text-[12px] font-medium">
                        <span style={{ color: "var(--accent-ink)" }}>
                          ↓ {formatRateKbps(node.netRxKbps)}
                        </span>
                        <span style={{ color: "var(--status-ok-ink)" }}>
                          ↑ {formatRateKbps(node.netTxKbps)}
                        </span>
                      </div>
                    ) : (
                      <span
                        style={{ color: "var(--text-muted)" }}
                        className="font-mono-num text-[12px]"
                      >
                        —
                      </span>
                    )}
                  </div>

                  <ObservabilityChart
                    height={82}
                    isRateKbps
                    ariaLabel={`${node.name} 实时网络吞吐`}
                    series={[
                      {
                        label: "↓",
                        color: "var(--accent)",
                        data: node.online
                          ? recentSeries.map((p) => p.rxKbps)
                          : [0, 0],
                      },
                      {
                        label: "↑",
                        color: "var(--status-ok)",
                        data: node.online
                          ? recentSeries.map((p) => p.txKbps)
                          : [0, 0],
                      },
                    ]}
                  />
                </div>

                {/* 4 Clean Visual Bars: CPU / 内存 / 磁盘 / 流量 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <MetricBar
                    label="CPU"
                    valueLabel={node.online ? `${node.cpuPct.toFixed(0)}%` : "—"}
                    valuePct={node.online ? node.cpuPct : 0}
                    thickness={3}
                  />
                  <MetricBar
                    label="内存"
                    valueLabel={
                      node.online
                        ? formatRamGb(node.memUsedMb, node.memTotalMb)
                        : "—"
                    }
                    valuePct={memPct}
                    thickness={3}
                  />
                  <MetricBar
                    label="磁盘"
                    valueLabel={`${rootMount.usedGb.toFixed(0)} / ${rootMount.totalGb} GB`}
                    valuePct={diskPct}
                    thickness={3}
                  />
                  <MetricBar
                    label="流量"
                    valueLabel={formatTrafficText(
                      node.monthlyTrafficUsedGb,
                      node.monthlyTrafficLimitGb,
                    )}
                    valuePct={trafficPct}
                    thickness={3}
                  />
                </div>
              </article>
            );
          })}
        </div>
      ) : displayMode === "table" ? (
        /* ==================================================================
         * VIEW 2: 列表 (Clean Linear-Style Table with Sortable 实时网速)
         * ================================================================== */
        <div className="atelier-card overflow-hidden">
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={tableCaptionId}
            className="table-scroll-region thin-scrollbar"
          >
            <table className="uniob-table">
              <caption id={tableCaptionId} className="sr-only">
                服务器列表
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    aria-sort={
                      sortCol === "name"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("name")}>
                      <span>服务器</span>
                      {renderSortIcon("name")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortCol === "region"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("region")}>
                      <span>地域</span>
                      {renderSortIcon("region")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortCol === "net"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("net")}>
                      <span>实时网速</span>
                      {renderSortIcon("net")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortCol === "cpu"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("cpu")}>
                      <span>CPU</span>
                      {renderSortIcon("cpu")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortCol === "mem"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("mem")}>
                      <span>内存</span>
                      {renderSortIcon("mem")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortCol === "disk"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("disk")}>
                      <span>磁盘</span>
                      {renderSortIcon("disk")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortCol === "traffic"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("traffic")}>
                      <span>流量</span>
                      {renderSortIcon("traffic")}
                    </button>
                  </th>
                </tr>
              </thead>

              <tbody>
                {sortedNodes.map((node) => {
                  const isSelected = node.id === selectedNodeId;
                  const memPct = getMemPct(node);
                  const diskPct = getDiskPct(node);
                  const rootMount = getRootMount(node);
                  const trafficPct = getTrafficPct(node);
                  const statusTone = getStatusTone(node, firingNodeIds);

                  return (
                    <tr
                      key={node.id}
                      onClick={() => onSelectNode(node.id, "telemetry")}
                      style={
                        isSelected
                          ? { backgroundColor: "var(--accent-soft)" }
                          : undefined
                      }
                      className="cursor-pointer"
                    >
                      <td className="min-w-[164px]">
                        <div className="flex items-center gap-2.5">
                          <StatusDot tone={statusTone} />
                          <span className="truncate font-semibold">
                            {node.name}
                          </span>
                        </div>
                      </td>

                      <td
                        style={{
                          color: node.online
                            ? "var(--text-secondary)"
                            : "var(--status-danger-ink)",
                        }}
                        className="whitespace-nowrap text-[12.5px]"
                      >
                        {node.online ? node.regionCode : "离线"}
                      </td>

                      <td className="min-w-[168px]">
                        {node.online ? (
                          <div className="font-mono-num flex items-center gap-2.5 whitespace-nowrap text-[12px] font-medium">
                            <span style={{ color: "var(--accent-ink)" }}>
                              ↓ {formatRateKbps(node.netRxKbps)}
                            </span>
                            <span style={{ color: "var(--status-ok-ink)" }}>
                              ↑ {formatRateKbps(node.netTxKbps)}
                            </span>
                          </div>
                        ) : (
                          <span
                            style={{ color: "var(--text-muted)" }}
                            className="font-mono-num text-[12px]"
                          >
                            —
                          </span>
                        )}
                      </td>

                      <td className="min-w-[106px]">
                        <MetricBar
                          valueLabel={
                            node.online ? `${node.cpuPct.toFixed(0)}%` : "—"
                          }
                          valuePct={node.online ? node.cpuPct : 0}
                          thickness={3}
                        />
                      </td>

                      <td className="min-w-[132px]">
                        <MetricBar
                          valueLabel={
                            node.online
                              ? formatRamGb(node.memUsedMb, node.memTotalMb)
                              : "—"
                          }
                          valuePct={memPct}
                          thickness={3}
                        />
                      </td>

                      <td className="min-w-[126px]">
                        <MetricBar
                          valueLabel={`${rootMount.usedGb.toFixed(0)} / ${rootMount.totalGb} GB`}
                          valuePct={diskPct}
                          thickness={3}
                        />
                      </td>

                      <td className="min-w-[136px]">
                        <MetricBar
                          valueLabel={formatTrafficText(
                            node.monthlyTrafficUsedGb,
                            node.monthlyTrafficLimitGb,
                          )}
                          valuePct={trafficPct}
                          thickness={3}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div role="status" className="sr-only">
            {sortAnnouncement}
          </div>
        </div>
      ) : (
        /* ==================================================================
         * VIEW 3: 矩阵 (100% Full-Width Compact Network Chart + 2x2 Bars)
         * ================================================================== */
        <div className="space-y-4">
          {matrixGroups.map((cluster) => (
            <section
              key={cluster.key}
              aria-label={cluster.title}
              className="atelier-card p-5"
            >
              <div className="mb-3.5 flex items-center justify-between">
                <h3 className="text-[14px] font-semibold">{cluster.title}</h3>
                <span
                  style={{ color: "var(--text-tertiary)" }}
                  className="font-mono-num text-[12px]"
                >
                  {cluster.onlineCount} / {cluster.list.length}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {cluster.list.map((node) => {
                  const memPct = getMemPct(node);
                  const diskPct = getDiskPct(node);
                  const trafficPct = getTrafficPct(node);
                  const tone = getStatusTone(node, firingNodeIds);
                  const recent = node.series.slice(-24);

                  return (
                    <div
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectNode(node.id, "telemetry")}
                      onKeyDown={(e) => {
                        if (
                          e.target === e.currentTarget &&
                          (e.key === "Enter" || e.key === " ")
                        ) {
                          e.preventDefault();
                          onSelectNode(node.id, "telemetry");
                        }
                      }}
                      style={{
                        backgroundColor: "var(--bg-card)",
                        border: `1px solid ${
                          node.id === selectedNodeId
                            ? "var(--accent)"
                            : "var(--border-subtle)"
                        }`,
                      }}
                      className="min-w-0 cursor-pointer space-y-3 rounded-[9px] p-3.5 transition-colors hover:border-[var(--border-strong)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <StatusDot tone={tone} />
                          <span className="truncate text-[13px] font-semibold">
                            {node.name}
                          </span>
                        </div>
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="shrink-0 text-[11.5px]"
                        >
                          {node.regionCode}
                        </span>
                      </div>

                      {/* Full-Width Live RX/TX Header + Compact ObservabilityChart */}
                      <div className="min-w-0 space-y-1">
                        <div className="font-mono-num flex items-center justify-between gap-2 text-[11px] font-medium">
                          {node.online ? (
                            <>
                              <span style={{ color: "var(--accent-ink)" }}>
                                ↓ {formatRateKbps(node.netRxKbps)}
                              </span>
                              <span style={{ color: "var(--status-ok-ink)" }}>
                                ↑ {formatRateKbps(node.netTxKbps)}
                              </span>
                            </>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>
                              离线
                            </span>
                          )}
                        </div>

                        <ObservabilityChart
                          height={56}
                          isRateKbps
                          ariaLabel={`${node.name} 实时网速`}
                          series={[
                            {
                              label: "↓",
                              color: "var(--accent)",
                              data: node.online
                                ? recent.map((p) => p.rxKbps)
                                : [0, 0],
                            },
                            {
                              label: "↑",
                              color: "var(--status-ok)",
                              data: node.online
                                ? recent.map((p) => p.txKbps)
                                : [0, 0],
                            },
                          ]}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <MetricBar
                          label="CPU"
                          valueLabel={
                            node.online ? `${node.cpuPct.toFixed(0)}%` : "—"
                          }
                          valuePct={node.online ? node.cpuPct : 0}
                          thickness={3}
                        />
                        <MetricBar
                          label="内存"
                          valueLabel={
                            node.online ? `${memPct.toFixed(0)}%` : "—"
                          }
                          valuePct={memPct}
                          thickness={3}
                        />
                        <MetricBar
                          label="磁盘"
                          valueLabel={`${diskPct.toFixed(0)}%`}
                          valuePct={diskPct}
                          thickness={3}
                        />
                        <MetricBar
                          label="流量"
                          valueLabel={`${trafficPct.toFixed(0)}%`}
                          valuePct={trafficPct}
                          thickness={3}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default FleetOverview;
