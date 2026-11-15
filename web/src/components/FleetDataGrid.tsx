import React, { useId, useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import {
  Badge,
  MetricBar,
  StatusDot,
  formatBytesPerSec,
  type StatusDotTone,
} from "./ui/Primitives";
import type { DensityMode, HorizonNode, InspectorTab } from "../types";
import {
  formatBytes,
  getDiskUsagePct,
  getMemTotalBytes,
  getMemUsagePct,
  getRootDisk,
  getTrafficUsagePct,
  isNodeMuted,
} from "../utils/format";

export interface FleetDataGridProps {
  nodes: HorizonNode[];
  density?: DensityMode;
  onSelectNode: (node: HorizonNode, initialTab?: InspectorTab) => void;
  onMuteNode?: (nodeId: string, seconds: number | null) => void | Promise<void>;
}

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
  region: "分组",
  net: "实时网速",
  cpu: "CPU",
  mem: "内存",
  disk: "磁盘",
  traffic: "流量",
};

function getNodeStatusTone(node: HorizonNode): StatusDotTone {
  if (!node.online) return "danger";
  const cpuPct = node.metrics?.cpu.all ?? 0;
  const memPct = getMemUsagePct(node);
  const trafficPct = getTrafficUsagePct(node.traffic);
  if (
    cpuPct >= 88 ||
    memPct >= 88 ||
    (node.traffic.limit_bytes && trafficPct >= 90)
  ) {
    return "warn";
  }
  return "ok";
}

function getTrafficSortValue(node: HorizonNode): number {
  if (node.traffic.limit_bytes && node.traffic.limit_bytes > 0) {
    return getTrafficUsagePct(node.traffic);
  }
  const fiveTb = 5 * 1024 * 1024 * 1024 * 1024;
  return Math.min(100, (node.traffic.counted_bytes / fiveTb) * 100);
}

export function FleetDataGrid({
  nodes,
  onSelectNode,
}: FleetDataGridProps): React.JSX.Element {
  const captionId = useId();
  const [sortCol, setSortCol] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [sortAnnouncement, setSortAnnouncement] = useState("");

  const sortedNodes = useMemo(() => {
    if (!sortCol) return nodes;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...nodes].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case "name":
          cmp = COLLATOR.compare(a.name, b.name);
          break;
        case "region":
          cmp = COLLATOR.compare(
            a.group_name || a.region_code,
            b.group_name || b.region_code,
          );
          break;
        case "net": {
          const netA =
            a.online && a.metrics
              ? a.metrics.net.rx_bps + a.metrics.net.tx_bps
              : -1;
          const netB =
            b.online && b.metrics
              ? b.metrics.net.rx_bps + b.metrics.net.tx_bps
              : -1;
          cmp = netA - netB;
          break;
        }
        case "cpu":
          cmp =
            (a.online && a.metrics ? a.metrics.cpu.all : -1) -
            (b.online && b.metrics ? b.metrics.cpu.all : -1);
          break;
        case "mem":
          cmp =
            (a.online ? getMemUsagePct(a) : -1) -
            (b.online ? getMemUsagePct(b) : -1);
          break;
        case "disk":
          cmp =
            getDiskUsagePct(getRootDisk(a.metrics?.disks)) -
            getDiskUsagePct(getRootDisk(b.metrics?.disks));
          break;
        case "traffic":
          cmp = getTrafficSortValue(a) - getTrafficSortValue(b);
          break;
      }
      if (cmp === 0) cmp = COLLATOR.compare(a.name, b.name);
      return cmp * dir;
    });
  }, [nodes, sortCol, sortDir]);

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

  return (
    <div className="atelier-card overflow-hidden">
      <div
        tabIndex={0}
        role="region"
        aria-labelledby={captionId}
        className="table-scroll-region thin-scrollbar"
      >
        <table className="uniob-table">
          <caption id={captionId} className="sr-only">
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
                  <span>分组</span>
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
              const statusTone = getNodeStatusTone(node);
              const cpuPct =
                node.online && node.metrics ? node.metrics.cpu.all : 0;
              const memPct = node.online ? getMemUsagePct(node) : 0;
              const memTotal = getMemTotalBytes(node);
              const rootDisk = getRootDisk(node.metrics?.disks);
              const diskPct = getDiskUsagePct(rootDisk);
              const trafficPct = getTrafficSortValue(node);
              const hasLimit =
                node.traffic.limit_bytes !== null &&
                node.traffic.limit_bytes > 0;
              const muted = isNodeMuted(node);

              return (
                <tr
                  key={node.id}
                  onClick={() => onSelectNode(node, "charts")}
                  className="cursor-pointer"
                >
                  <td className="min-w-[168px]">
                    <div className="flex items-center gap-2.5">
                      <StatusDot tone={statusTone} />
                      <span className="truncate font-semibold">{node.name}</span>
                      {muted && <Badge tone="subtle">静音</Badge>}
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
                    {node.online
                      ? node.group_name || node.region_code
                      : "离线"}
                  </td>

                  <td className="min-w-[168px]">
                    {node.online && node.metrics ? (
                      <div className="font-mono-num flex items-center gap-3.5 whitespace-nowrap text-[12px] font-medium">
                        <span
                          style={{ color: "var(--accent-ink)" }}
                          className="inline-flex items-center gap-1"
                        >
                          <span>↓</span>
                          <span>{formatBytesPerSec(node.metrics.net.rx_bps)}</span>
                        </span>
                        <span
                          style={{ color: "var(--status-ok-ink)" }}
                          className="inline-flex items-center gap-1"
                        >
                          <span>↑</span>
                          <span>{formatBytesPerSec(node.metrics.net.tx_bps)}</span>
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

                  <td className="min-w-[108px]">
                    <MetricBar
                      valueLabel={
                        node.online && node.metrics
                          ? `${cpuPct.toFixed(0)}%`
                          : "—"
                      }
                      valuePct={cpuPct}
                      thickness={3}
                    />
                  </td>

                  <td className="min-w-[136px]">
                    <MetricBar
                      valueLabel={
                        node.online && node.metrics && memTotal > 0
                          ? `${formatBytes(node.metrics.mem.used)} / ${formatBytes(memTotal)}`
                          : "—"
                      }
                      valuePct={memPct}
                      thickness={3}
                    />
                  </td>

                  <td className="min-w-[132px]">
                    <MetricBar
                      valueLabel={
                        rootDisk
                          ? `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}`
                          : "—"
                      }
                      valuePct={diskPct}
                      thickness={3}
                    />
                  </td>

                  <td className="min-w-[138px]">
                    <MetricBar
                      valueLabel={
                        hasLimit
                          ? `${formatBytes(node.traffic.counted_bytes)} / ${formatBytes(node.traffic.limit_bytes)}`
                          : formatBytes(node.traffic.counted_bytes)
                      }
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
  );
}
