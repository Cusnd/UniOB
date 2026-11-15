import React, { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { Button, Card, SegmentedControl } from "./ui/Primitives";
import type { HorizonNode, ProcEntry } from "../types";
import type { ProcsPacket, WsConnectionStatus } from "../hooks/useFleetSocket";
import { formatBytes } from "../utils/format";

export type ProcDisplayGear = "off" | "top15" | "all";

export interface ProcessExplorerProps {
  node: HorizonNode;
  procsPacket: ProcsPacket | null;
  wsStatus: WsConnectionStatus;
  displayGear?: ProcDisplayGear;
  onDisplayGearChange?: (next: ProcDisplayGear) => void;
  leaseSec?: number;
  leaseTotalSec?: number;
  onRenewLease?: () => void;
}

type SortKey = "pid" | "comm" | "cpu" | "rss" | "cmd";

const TEXT_COLLATOR = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

const SORT_LABELS: Record<SortKey, string> = {
  pid: "PID",
  comm: "进程名",
  cpu: "CPU",
  rss: "内存",
  cmd: "命令",
};

function renderCleanCommand(cmd: string): React.ReactNode {
  const pattern =
    /(--[a-zA-Z0-9_-]+=\*\*\*|--requirepass\s+\*\*\*|[A-Z0-9_]+=\*\*\*|[a-zA-Z0-9+.-]+:\/\/[^\s:@]+:\*\*\*@[^\s]+|\*\*\*)/g;
  const parts = cmd.split(pattern);
  if (parts.length <= 1) return cmd;

  return parts.map((segment, idx) => {
    if (!segment) return null;
    if (segment.includes("***")) {
      return (
        <span
          key={idx}
          style={{
            backgroundColor: "var(--bg-muted)",
            color: "var(--text-secondary)",
          }}
          className="mx-0.5 inline-flex items-center rounded-[4px] px-1 py-[0.5px] font-mono text-[10.5px] leading-tight"
        >
          {segment}
        </span>
      );
    }
    return <React.Fragment key={idx}>{segment}</React.Fragment>;
  });
}

function LeaseCountdownRing({
  remainingSec,
  totalSec,
}: {
  remainingSec: number;
  totalSec: number;
}): React.JSX.Element {
  const size = 18;
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, remainingSec / Math.max(1, totalSec)));
  const dashOffset = circumference * (1 - pct);

  const ringColor =
    remainingSec <= 15
      ? "var(--status-danger)"
      : remainingSec <= 30
        ? "var(--status-warn)"
        : "var(--accent)";

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="-rotate-90 shrink-0"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border-subtle)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={ringColor}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ProcessExplorer({
  node,
  procsPacket,
  displayGear,
  onDisplayGearChange,
  leaseSec = 90,
  leaseTotalSec = 90,
  onRenewLease,
}: ProcessExplorerProps): React.JSX.Element {
  const baseId = useId();
  const captionId = `${baseId}-proc-caption`;
  const searchId = `${baseId}-proc-search`;

  const [internalGear, setInternalGear] = useState<ProcDisplayGear>("top15");
  const [sortBy, setSortBy] = useState<SortKey>("cpu");
  const [sortDesc, setSortDesc] = useState<boolean>(true);
  const [search, setSearch] = useState("");
  const [sortAnnouncement, setSortAnnouncement] = useState("");

  const gear = displayGear ?? internalGear;
  const setGear = (next: ProcDisplayGear) => {
    if (displayGear === undefined) setInternalGear(next);
    onDisplayGearChange?.(next);
  };

  useEffect(() => {
    setSearch("");
  }, [node.id]);

  const hasMatchedPacket = procsPacket?.nodeId === node.id;
  const rawProcs = useMemo<ProcEntry[]>(
    () => (procsPacket?.nodeId === node.id ? procsPacket.procs : []),
    [procsPacket, node.id],
  );

  const visibleProcs = useMemo(() => {
    if (gear === "off") return [];
    const base =
      gear === "top15"
        ? [...rawProcs]
            .sort((a, b) => b.cpu - a.cpu || b.rss - a.rss)
            .slice(0, 15)
        : rawProcs;

    const q = search.trim().toLowerCase();
    const filtered = q
      ? base.filter(
          (p) =>
            String(p.pid).includes(q) ||
            p.comm.toLowerCase().includes(q) ||
            p.cmd.toLowerCase().includes(q) ||
            p.user.toLowerCase().includes(q),
        )
      : base;

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "pid":
          cmp = a.pid - b.pid;
          break;
        case "comm":
          cmp = TEXT_COLLATOR.compare(a.comm, b.comm);
          break;
        case "cpu":
          cmp = a.cpu - b.cpu;
          break;
        case "rss":
          cmp = a.rss - b.rss;
          break;
        case "cmd":
          cmp = TEXT_COLLATOR.compare(a.cmd || a.comm, b.cmd || b.comm);
          break;
      }
      if (cmp === 0) cmp = a.pid - b.pid;
      return sortDesc ? -cmp : cmp;
    });
  }, [rawProcs, gear, search, sortBy, sortDesc]);

  const handleSort = (key: SortKey) => {
    const nextDesc =
      sortBy === key ? !sortDesc : key === "cpu" || key === "rss";
    setSortBy(key);
    setSortDesc(nextDesc);
    setSortAnnouncement(
      `已按${SORT_LABELS[key]}${nextDesc ? "降序" : "升序"}排列`,
    );
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortBy !== key) {
      return (
        <ArrowUpDown
          style={{ color: "var(--text-muted)" }}
          className="h-3 w-3 shrink-0"
          aria-hidden="true"
        />
      );
    }
    return sortDesc ? (
      <ChevronDown
        style={{ color: "var(--accent)" }}
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
    ) : (
      <ChevronUp
        style={{ color: "var(--accent)" }}
        className="h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
    );
  };

  if (node.proc_enabled === false) {
    return (
      <Card className="py-12 text-center">
        <p style={{ color: "var(--text-secondary)" }} className="text-[13px]">
          未开启进程查看
        </p>
      </Card>
    );
  }

  if (!node.online && !hasMatchedPacket) {
    return (
      <Card className="py-12 text-center">
        <p style={{ color: "var(--text-secondary)" }} className="text-[13px]">
          服务器当前离线
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Single Clean Control Row: Segmented Gear + Search + Compact 90s Ring Timer */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl<ProcDisplayGear>
            ariaLabel="进程显示数量"
            value={gear}
            onChange={setGear}
            options={[
              { value: "off", label: "关闭" },
              { value: "top15", label: "前 15" },
              {
                value: "all",
                label: "全部",
                badge: rawProcs.length > 0 ? rawProcs.length : undefined,
              },
            ]}
          />

          {gear !== "off" && (
            <div className="relative w-[176px]">
              <label htmlFor={searchId} className="sr-only">
                过滤进程
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
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索进程…"
                style={{
                  backgroundColor: "var(--bg-card)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-primary)",
                }}
                className="h-8 w-full rounded-[8px] pr-7 pl-8 text-[12px] transition-colors outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)]"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="清空搜索"
                  style={{ color: "var(--text-tertiary)" }}
                  className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer hover:text-[var(--text-primary)]"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>

        {gear !== "off" && onRenewLease && (
          <div
            style={{
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border-subtle)",
            }}
            className="inline-flex h-8 items-center gap-2 rounded-[8px] px-2.5"
          >
            <LeaseCountdownRing
              remainingSec={leaseSec}
              totalSec={leaseTotalSec}
            />
            <span className="font-mono-num text-[12px] font-medium">
              {leaseSec}s
            </span>
            <button
              type="button"
              onClick={onRenewLease}
              style={{ color: "var(--accent-ink)" }}
              className="inline-flex cursor-pointer items-center gap-1 pl-1 text-[12px] font-medium hover:opacity-80"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span>续期</span>
            </button>
          </div>
        )}
      </div>

      {gear === "off" ? (
        <Card className="py-12 text-center">
          <p
            style={{ color: "var(--text-secondary)" }}
            className="mb-3 text-[13px]"
          >
            进程查看已关闭
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setGear("top15")}
          >
            查看前 15
          </Button>
        </Card>
      ) : !hasMatchedPacket ? (
        <Card className="flex items-center justify-center gap-2 py-12 text-[13px]">
          <Loader2
            style={{ color: "var(--accent)" }}
            className="h-4 w-4 animate-spin"
            aria-hidden="true"
          />
          <span style={{ color: "var(--text-secondary)" }}>
            正在获取实时进程列表…
          </span>
        </Card>
      ) : (
        <div className="atelier-card overflow-hidden">
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={captionId}
            className="table-scroll-region thin-scrollbar max-h-[56vh]"
          >
            <table className="uniob-table">
              <caption id={captionId} className="sr-only">
                进程列表
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "pid"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("pid")}>
                      <span>PID</span>
                      {renderSortIcon("pid")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "comm"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("comm")}>
                      <span>进程名</span>
                      {renderSortIcon("comm")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "cpu"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
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
                      sortBy === "rss"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("rss")}>
                      <span>内存</span>
                      {renderSortIcon("rss")}
                    </button>
                  </th>

                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "cmd"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                  >
                    <button type="button" onClick={() => handleSort("cmd")}>
                      <span>命令</span>
                      {renderSortIcon("cmd")}
                    </button>
                  </th>
                </tr>
              </thead>

              <tbody>
                {visibleProcs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{ color: "var(--text-tertiary)" }}
                      className="py-10 text-center text-[12.5px]"
                    >
                      没有匹配的进程
                    </td>
                  </tr>
                ) : (
                  visibleProcs.map((proc) => (
                    <tr key={proc.pid}>
                      <td
                        style={{ color: "var(--text-secondary)" }}
                        className="font-mono-num w-[72px] text-[12px]"
                      >
                        {proc.pid}
                      </td>
                      <td className="min-w-[110px] font-medium">{proc.comm}</td>
                      <td className="font-mono-num w-[84px] text-[12.5px]">
                        {proc.cpu.toFixed(1)}%
                      </td>
                      <td className="font-mono-num w-[96px] text-[12.5px]">
                        {formatBytes(proc.rss)}
                      </td>
                      <td className="min-w-[240px]">
                        <div
                          style={{ color: "var(--text-secondary)" }}
                          className="max-w-[340px] truncate font-mono text-[11.5px]"
                          title={proc.cmd || proc.comm}
                        >
                          {renderCleanCommand(proc.cmd || proc.comm)}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div role="status" className="sr-only">
            {sortAnnouncement}
          </div>
        </div>
      )}
    </div>
  );
}
