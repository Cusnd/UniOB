import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Cpu,
  Pause,
  Play,
  Search,
  ShieldAlert,
} from "lucide-react";
import type { ProcEntry } from "../types";
import type { ProcsPacket } from "../hooks/useFleetSocket";
import { formatBytes } from "../utils/format";

type SortKey = "cpu" | "rss" | "pid";

interface ProcessTableProps {
  nodeId: string;
  online: boolean;
  procEnabled: boolean;
  procsPacket: ProcsPacket | null;
}

function getProcessStateBadge(state: string) {
  const code = (state || "?").trim().charAt(0).toUpperCase();
  if (code === "Z") {
    return (
      <span
        title="僵尸进程"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono-num font-semibold border bg-purple-500/15 text-purple-600 dark:text-purple-300 border-purple-500/40"
      >
        僵尸
      </span>
    );
  }
  if (code === "D") {
    return (
      <span
        title="磁盘读写阻塞中"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono-num font-semibold border bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/40"
      >
        阻塞
      </span>
    );
  }
  if (code === "R") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono-num font-medium border bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
        运行中
      </span>
    );
  }
  if (code === "T" || code === "t") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono-num font-medium border bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30">
        已暂停
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono-num border bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-slate-700">
      休眠
    </span>
  );
}

export function ProcessTable({
  nodeId,
  online,
  procEnabled,
  procsPacket,
}: ProcessTableProps) {
  const [sortBy, setSortBy] = useState<SortKey>("cpu");
  const [sortDesc, setSortDesc] = useState<boolean>(true);
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozenSnapshot, setFrozenSnapshot] = useState<{
    ts: number;
    procs: ProcEntry[];
  } | null>(null);

  useEffect(() => {
    setPaused(false);
    setFrozenSnapshot(null);
    setSearch("");
  }, [nodeId]);

  const livePacket =
    procsPacket && procsPacket.nodeId === nodeId ? procsPacket : null;

  const togglePause = () => {
    if (!paused) {
      setFrozenSnapshot(
        livePacket
          ? { ts: livePacket.ts, procs: livePacket.procs }
          : { ts: Math.floor(Date.now() / 1000), procs: [] },
      );
      setPaused(true);
    } else {
      setPaused(false);
      setFrozenSnapshot(null);
    }
  };

  const activeData = paused && frozenSnapshot ? frozenSnapshot : livePacket;

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDesc((prev) => !prev);
    } else {
      setSortBy(key);
      setSortDesc(key !== "pid");
    }
  };

  const filteredProcs = useMemo(() => {
    const list = activeData?.procs ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (p) =>
            String(p.pid).includes(q) ||
            p.user.toLowerCase().includes(q) ||
            p.comm.toLowerCase().includes(q) ||
            p.cmd.toLowerCase().includes(q) ||
            p.st.toLowerCase().includes(q),
        )
      : list;

    return [...filtered].sort((a, b) => {
      const cmp =
        sortBy === "cpu"
          ? a.cpu - b.cpu
          : sortBy === "rss"
            ? a.rss - b.rss
            : a.pid - b.pid;
      return sortDesc ? -cmp : cmp;
    });
  }, [activeData, search, sortBy, sortDesc]);

  const anomalyCounts = useMemo(() => {
    const list = activeData?.procs ?? [];
    let zombie = 0;
    let diskSleep = 0;
    for (const p of list) {
      const st = (p.st || "").trim().charAt(0).toUpperCase();
      if (st === "Z") zombie++;
      if (st === "D") diskSleep++;
    }
    return { zombie, diskSleep };
  }, [activeData]);

  if (!procEnabled) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5 text-amber-500" aria-hidden="true" />
        <div className="space-y-1.5">
          <p className="font-semibold">该服务器已启用隐私保护，未开放进程列表查看</p>
          <p className="text-xs leading-relaxed opacity-90">
            服务器上 <code className="font-mono-num px-1 py-0.5 rounded bg-black/10 dark:bg-white/10">/etc/uniob/agent.toml</code> 已禁用进程信息上报。为保护本地隐私安全，监控面板不会拉取该服务器的运行进程。
          </p>
        </div>
      </div>
    );
  }

  const formatSnapTime = (ts?: number) => {
    if (!ts) return "等待采集...";
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour12: false });
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="relative flex-1 min-w-[200px]">
          <label htmlFor="process-filter-input" className="sr-only">
            搜索进程
          </label>
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          <input
            id="process-filter-input"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索进程名、用户、命令或 PID..."
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0b101b] p-0.5 text-xs">
            {(
              [
                { key: "cpu", label: "处理器占用" },
                { key: "rss", label: "内存占用" },
                { key: "pid", label: "PID" },
              ] as const
            ).map((opt) => {
              const active = sortBy === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => handleSort(opt.key)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-colors ${
                    active
                      ? "bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 shadow-xs"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                  }`}
                >
                  {opt.label}
                  {active &&
                    (sortDesc ? (
                      <ArrowDown className="w-3 h-3" aria-hidden="true" />
                    ) : (
                      <ArrowUp className="w-3 h-3" aria-hidden="true" />
                    ))}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={togglePause}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              paused
                ? "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-300 hover:bg-amber-500/25"
                : "border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1623] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            }`}
          >
            {paused ? (
              <>
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                恢复实时
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                暂停刷新
              </>
            )}
          </button>
        </div>
      </div>

      {/* Status strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0b101b]">
        <div className="flex flex-wrap items-center gap-3 text-slate-500 dark:text-slate-400 font-mono-num">
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
            刷新：<strong className="text-slate-700 dark:text-slate-200">每 2 秒自动更新（只读）</strong>
          </span>
          <span>
            时间：<strong className="text-slate-700 dark:text-slate-200">{formatSnapTime(activeData?.ts)}</strong>
          </span>
          <span>
            显示：<strong className="text-slate-700 dark:text-slate-200">{filteredProcs.length}</strong> /{" "}
            {activeData?.procs.length ?? 0}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {anomalyCounts.zombie > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-500/15 text-purple-600 dark:text-purple-300 border border-purple-500/30">
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              僵尸进程：{anomalyCounts.zombie}
            </span>
          )}
          {anomalyCounts.diskSleep > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30">
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              磁盘阻塞进程：{anomalyCounts.diskSleep}
            </span>
          )}
          {paused && (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/30">
              已暂停更新
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      {!online && !activeData ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          服务器当前离线，重新连线后会自动恢复实时进程列表。
        </div>
      ) : !activeData ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          正在向服务器请求进程列表，请稍候（约 2 秒）...
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] overflow-hidden">
          <div className="overflow-x-auto max-h-[58vh]">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-[#131c2e] border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
                <tr>
                  <th scope="col" className="py-2 px-3">PID</th>
                  <th scope="col" className="py-2 px-3">用户</th>
                  <th scope="col" className="py-2 px-3">状态</th>
                  <th scope="col" className="py-2 px-3 text-right">处理器占用</th>
                  <th scope="col" className="py-2 px-3 text-right">内存占用</th>
                  <th scope="col" className="py-2 px-3 text-right">线程数</th>
                  <th scope="col" className="py-2 px-3">程序 / 启动命令</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
                {filteredProcs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="py-8 text-center text-slate-400 dark:text-slate-500"
                    >
                      没有匹配的进程记录
                    </td>
                  </tr>
                ) : (
                  filteredProcs.map((proc) => {
                    const stCode = (proc.st || "").trim().charAt(0).toUpperCase();
                    const rowHighlight =
                      stCode === "D"
                        ? "bg-rose-500/[0.06]"
                        : stCode === "Z"
                          ? "bg-purple-500/[0.06]"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/40";
                    return (
                      <tr key={proc.pid} className={`${rowHighlight} transition-colors`}>
                        <td className="py-2 px-3 font-mono-num text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {proc.pid}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-slate-600 dark:text-slate-300 whitespace-nowrap max-w-[100px] truncate">
                          {proc.user}
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap">
                          {getProcessStateBadge(proc.st)}
                        </td>
                        <td
                          className={`py-2 px-3 font-mono-num text-right whitespace-nowrap font-semibold ${
                            proc.cpu >= 50
                              ? "text-rose-500 dark:text-rose-400"
                              : proc.cpu >= 15
                                ? "text-amber-500 dark:text-amber-400"
                                : "text-slate-700 dark:text-slate-200"
                          }`}
                        >
                          {proc.cpu.toFixed(1)}%
                        </td>
                        <td className="py-2 px-3 font-mono-num text-right whitespace-nowrap text-slate-700 dark:text-slate-200">
                          {formatBytes(proc.rss)}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-right whitespace-nowrap text-slate-500 dark:text-slate-400">
                          {proc.thr}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-slate-700 dark:text-slate-200 min-w-[260px] max-w-[440px]">
                          <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                            {proc.comm}
                          </div>
                          {proc.cmd && proc.cmd !== proc.comm && (
                            <div
                              className="text-[11px] text-slate-500 dark:text-slate-400 break-all whitespace-normal mt-0.5 leading-snug"
                              title={proc.cmd}
                            >
                              {proc.cmd}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
