import { useId, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Cpu,
  Eye,
  EyeOff,
  Moon,
  Pause,
  PauseCircle,
  Play,
  Search,
  ShieldAlert,
  Terminal,
  X,
} from "lucide-react";
import type { ProcEntry, PrototypeNode } from "../types";
import { formatBytes, getMemTotalBytes } from "../utils/format";

export interface ProcessExplorerProps {
  node: PrototypeNode;
  procs: ProcEntry[];
  onToggleProcPrivacyPreview?: (nodeId: string) => void;
}

type SortKey = "pid" | "user" | "st" | "cpu" | "rss" | "thr" | "comm";

const TEXT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const SORT_LABELS: Record<SortKey, string> = {
  pid: "PID",
  user: "用户",
  st: "状态",
  cpu: "CPU 占用",
  rss: "内存 RSS",
  thr: "线程数",
  comm: "进程名",
};

function renderStateBadge(state: string): React.JSX.Element {
  const code = (state || "?").trim().charAt(0).toUpperCase();
  if (code === "Z") {
    return (
      <span
        title="僵尸进程 (Z)"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono-num font-semibold border bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40"
      >
        <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span>僵尸 (Z)</span>
      </span>
    );
  }
  if (code === "D") {
    return (
      <span
        title="磁盘 I/O 不可中断阻塞 (D)"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono-num font-semibold border bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40"
      >
        <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span>阻塞 (D)</span>
      </span>
    );
  }
  if (code === "R") {
    return (
      <span
        title="正在运行 (R)"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono-num font-medium border bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/35"
      >
        <Activity className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span>运行中</span>
      </span>
    );
  }
  if (code === "T" || code === "t") {
    return (
      <span
        title="已暂停 / 调试跟踪 (T)"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono-num font-medium border bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/35"
      >
        <PauseCircle className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span>已暂停</span>
      </span>
    );
  }
  return (
    <span
      title={`休眠 (${code || "S"})`}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono-num border bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700"
    >
      <Moon className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span>休眠</span>
    </span>
  );
}

export function ProcessExplorer({
  node,
  procs,
  onToggleProcPrivacyPreview,
}: ProcessExplorerProps): React.JSX.Element {
  const baseId = useId();
  const captionId = `${baseId}-proc-caption`;
  const searchId = `${baseId}-proc-search`;

  const [sortBy, setSortBy] = useState<SortKey>("cpu");
  const [sortDesc, setSortDesc] = useState<boolean>(true);
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozenSnapshot, setFrozenSnapshot] = useState<{
    capturedAt: number;
    procs: ProcEntry[];
  } | null>(null);
  const [sortAnnouncement, setSortAnnouncement] = useState("");

  const activeProcs = paused && frozenSnapshot ? frozenSnapshot.procs : procs;
  const memTotal = getMemTotalBytes(node);

  const togglePause = () => {
    if (!paused) {
      setFrozenSnapshot({
        capturedAt: Math.floor(Date.now() / 1000),
        procs: [...procs],
      });
      setPaused(true);
    } else {
      setPaused(false);
      setFrozenSnapshot(null);
    }
  };

  const handleSort = (key: SortKey) => {
    let nextDesc: boolean;
    if (sortBy === key) {
      nextDesc = !sortDesc;
    } else {
      nextDesc = key === "cpu" || key === "rss" || key === "thr";
    }
    setSortBy(key);
    setSortDesc(nextDesc);
    setSortAnnouncement(
      `已按${SORT_LABELS[key]}${nextDesc ? "降序" : "升序"}排列`,
    );
  };

  const filteredProcs = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? activeProcs.filter(
          (p) =>
            String(p.pid).includes(q) ||
            p.user.toLowerCase().includes(q) ||
            p.comm.toLowerCase().includes(q) ||
            p.cmd.toLowerCase().includes(q) ||
            p.st.toLowerCase().includes(q),
        )
      : activeProcs;

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "pid":
          cmp = a.pid - b.pid;
          break;
        case "cpu":
          cmp = a.cpu - b.cpu;
          break;
        case "rss":
          cmp = a.rss - b.rss;
          break;
        case "thr":
          cmp = a.thr - b.thr;
          break;
        case "user":
          cmp = TEXT_COLLATOR.compare(a.user, b.user);
          break;
        case "st":
          cmp = TEXT_COLLATOR.compare(a.st, b.st);
          break;
        case "comm":
          cmp = TEXT_COLLATOR.compare(a.comm, b.comm);
          break;
      }
      if (cmp === 0) {
        cmp = a.pid - b.pid;
      }
      return sortDesc ? -cmp : cmp;
    });
  }, [activeProcs, search, sortBy, sortDesc]);

  const stats = useMemo(() => {
    let zombie = 0;
    let diskSleep = 0;
    let running = 0;
    let maxRss = 1;
    let maxCpu = 100;
    for (const p of activeProcs) {
      const code = (p.st || "").trim().charAt(0).toUpperCase();
      if (code === "Z") zombie++;
      else if (code === "D") diskSleep++;
      else if (code === "R") running++;
      if (p.rss > maxRss) maxRss = p.rss;
      if (p.cpu > maxCpu) maxCpu = p.cpu;
    }
    return { zombie, diskSleep, running, maxRss, maxCpu };
  }, [activeProcs]);

  if (!node.proc_enabled) {
    return (
      <div className="surface-card rounded-xl p-6 border border-amber-500/35 bg-amber-500/[0.06] space-y-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
            <ShieldAlert
              className="w-5 h-5 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
          </div>
          <div className="flex-1 min-w-[240px] space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                隐私保护已锁定 · 未开放 /proc 进程上报
              </h3>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-mono-num font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                proc_enabled = false
              </span>
            </div>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              目标服务器上的{" "}
              <code className="font-mono-num px-1.5 py-0.5 rounded bg-slate-900/10 dark:bg-white/10 text-slate-800 dark:text-slate-200">
                /etc/uniob/agent.toml
              </code>{" "}
              已配置禁用进程列表与命令行透视。遵循「默认隐私最小化」安全基线，控制面不会拉取或缓存该服务器的{" "}
              <code className="font-mono-num">/proc</code> 运行态快照。
            </p>
            <div className="pt-1 flex flex-wrap items-center gap-2.5">
              {onToggleProcPrivacyPreview && (
                <button
                  type="button"
                  onClick={() => onToggleProcPrivacyPreview(node.id)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-[var(--accent-primary)] text-white hover:opacity-95 transition-opacity shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                  <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>预览启用进程表效果</span>
                </button>
              )}
              <span className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                如需真实开启：在探针移除 --disable-proc 并重启 uniob-agent
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const snapTimeText = paused && frozenSnapshot
    ? new Date(frozenSnapshot.capturedAt * 1000).toLocaleTimeString([], {
        hour12: false,
      })
    : node.metrics?.ts
      ? new Date(node.metrics.ts * 1000).toLocaleTimeString([], {
          hour12: false,
        })
      : "实时推流";

  const renderSortIcon = (key: SortKey) => {
    if (sortBy !== key) {
      return (
        <ArrowUpDown
          className="w-3 h-3 opacity-40 shrink-0"
          aria-hidden="true"
        />
      );
    }
    return sortDesc ? (
      <ArrowDown
        className="w-3 h-3 text-[var(--accent-primary)] shrink-0"
        aria-hidden="true"
      />
    ) : (
      <ArrowUp
        className="w-3 h-3 text-[var(--accent-primary)] shrink-0"
        aria-hidden="true"
      />
    );
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="surface-card rounded-xl p-3 flex flex-wrap items-center justify-between gap-2.5">
        <div className="relative flex-1 min-w-[210px]">
          <label htmlFor={searchId} className="sr-only">
            搜索 PID、用户、进程名或命令行
          </label>
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            id={searchId}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="过滤 PID / 用户 / 进程名 / cmdline..."
            className="w-full pl-9 pr-8 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-slate-900/70 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="清空搜索条件"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Sort Pills */}
          <div
            role="group"
            aria-label="快捷排序字段"
            className="inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-700/80 bg-slate-100/80 dark:bg-slate-900/70 p-0.5 text-xs"
          >
            {(
              [
                { key: "cpu", label: "CPU" },
                { key: "rss", label: "内存 RSS" },
                { key: "pid", label: "PID" },
              ] as const
            ).map((opt) => {
              const active = sortBy === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleSort(opt.key)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-colors ${
                    active
                      ? "bg-white dark:bg-slate-800 text-[var(--accent-primary)] shadow-xs"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                  }`}
                >
                  <span>{opt.label}</span>
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

          {/* Pause / Resume Freeze */}
          <button
            type="button"
            aria-pressed={paused}
            onClick={togglePause}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              paused
                ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                : "border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900/70 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            }`}
          >
            {paused ? (
              <>
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                <span>恢复实时快照</span>
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                <span>冻结快照</span>
              </>
            )}
          </button>

          {/* Privacy Preview Toggle */}
          {onToggleProcPrivacyPreview && (
            <button
              type="button"
              onClick={() => onToggleProcPrivacyPreview(node.id)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700/80 bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="切换模拟 agent.toml 关闭进程上报的隐私保护效果"
            >
              <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
              <span>演示隐私保护禁用态</span>
            </button>
          )}
        </div>
      </div>

      {/* Status & Anomaly Capsule Strip */}
      <div className="surface-card rounded-xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3 text-slate-500 dark:text-slate-400 font-mono-num">
          <span className="inline-flex items-center gap-1.5">
            <Cpu
              className="w-3.5 h-3.5 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>模式：</span>
            <strong className="text-slate-800 dark:text-slate-200">
              只读 /proc 雷达（按需订阅）
            </strong>
          </span>
          <span>
            快照时间：
            <strong className="text-slate-800 dark:text-slate-200">
              {snapTimeText}
            </strong>
          </span>
          <span>
            命中：
            <strong className="text-slate-800 dark:text-slate-200">
              {filteredProcs.length}
            </strong>{" "}
            / {activeProcs.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono-num">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25">
            <Activity className="w-3 h-3" aria-hidden="true" />
            <span>运行中 (R): {stats.running}</span>
          </span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
              stats.zombie > 0
                ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/35 font-semibold"
                : "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700"
            }`}
          >
            <AlertTriangle className="w-3 h-3" aria-hidden="true" />
            <span>僵尸进程 (Z): {stats.zombie}</span>
          </span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
              stats.diskSleep > 0
                ? "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/35 font-semibold"
                : "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700"
            }`}
          >
            <AlertTriangle className="w-3 h-3" aria-hidden="true" />
            <span>磁盘阻塞 (D): {stats.diskSleep}</span>
          </span>
          {paused && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35">
              <Pause className="w-3 h-3" aria-hidden="true" />
              <span>已冻结</span>
            </span>
          )}
        </div>
      </div>

      {/* Screen-reader live announcement placed OUTSIDE <table> per sortable-table spec */}
      <div role="status" className="sr-only">
        {sortAnnouncement}
      </div>

      {/* Process Table */}
      {!node.online && activeProcs.length === 0 ? (
        <div className="surface-card rounded-xl p-8 text-center space-y-2">
          <Terminal
            className="w-7 h-7 mx-auto text-slate-400"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            服务器当前离线，暂无实时 /proc 进程快照
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            探针恢复连接后将自动恢复每 2 秒按需进程推流。
          </p>
        </div>
      ) : (
        <div className="surface-card rounded-xl overflow-hidden">
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={captionId}
            className="overflow-x-auto max-h-[56vh] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)]"
          >
            <table className="w-full text-left border-collapse text-xs">
              <caption id={captionId} className="sr-only">
                {node.name} 实时只读进程列表，按 {SORT_LABELS[sortBy]}{" "}
                {sortDesc ? "降序" : "升序"} 排列
              </caption>
              <thead className="sticky top-0 z-10 bg-slate-50/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 font-mono-num">
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
                    className="py-2 px-3 whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("pid")}
                      className="inline-flex items-center gap-1 font-semibold hover:text-slate-950 dark:hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      <span>PID</span>
                      {renderSortIcon("pid")}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "user"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                    className="py-2 px-3 whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("user")}
                      className="inline-flex items-center gap-1 font-semibold hover:text-slate-950 dark:hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      <span>用户</span>
                      {renderSortIcon("user")}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "st"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                    className="py-2 px-3 whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("st")}
                      className="inline-flex items-center gap-1 font-semibold hover:text-slate-950 dark:hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      <span>状态</span>
                      {renderSortIcon("st")}
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
                    className="py-2 px-3 text-right whitespace-nowrap min-w-[125px]"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("cpu")}
                      className="inline-flex items-center justify-end gap-1 ml-auto font-semibold hover:text-slate-950 dark:hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      <span>CPU %</span>
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
                    className="py-2 px-3 text-right whitespace-nowrap min-w-[135px]"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("rss")}
                      className="inline-flex items-center justify-end gap-1 ml-auto font-semibold hover:text-slate-950 dark:hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      <span>内存 RSS</span>
                      {renderSortIcon("rss")}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      sortBy === "thr"
                        ? sortDesc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                    className="py-2 px-3 text-right whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("thr")}
                      className="inline-flex items-center justify-end gap-1 ml-auto font-semibold hover:text-slate-950 dark:hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      <span>线程</span>
                      {renderSortIcon("thr")}
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
                    className="py-2 px-3 whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("comm")}
                      className="inline-flex items-center gap-1 font-semibold hover:text-slate-950 dark:hover:text-white focus-visible:outline-none focus-visible:underline"
                    >
                      <span>程序 / 启动命令行</span>
                      {renderSortIcon("comm")}
                    </button>
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/80">
                {filteredProcs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="py-10 text-center text-xs text-slate-500 dark:text-slate-400"
                    >
                      没有匹配当前过滤条件的运行进程
                    </td>
                  </tr>
                ) : (
                  filteredProcs.map((proc) => {
                    const code = (proc.st || "").trim().charAt(0).toUpperCase();
                    const rowTint =
                      code === "D"
                        ? "bg-rose-500/[0.06] hover:bg-rose-500/[0.10]"
                        : code === "Z"
                          ? "bg-purple-500/[0.06] hover:bg-purple-500/[0.10]"
                          : "hover:bg-slate-500/[0.05]";

                    const cpuBarPct = Math.min(
                      100,
                      Math.max(0, (proc.cpu / Math.max(100, stats.maxCpu)) * 100),
                    );
                    const cpuBarColor =
                      proc.cpu >= 50
                        ? "bg-rose-500"
                        : proc.cpu >= 15
                          ? "bg-amber-500"
                          : "bg-emerald-500";
                    const cpuTextColor =
                      proc.cpu >= 50
                        ? "text-rose-600 dark:text-rose-400 font-semibold"
                        : proc.cpu >= 15
                          ? "text-amber-600 dark:text-amber-400 font-semibold"
                          : "text-slate-800 dark:text-slate-200";

                    const rssPct =
                      memTotal > 0
                        ? Math.min(100, (proc.rss / memTotal) * 100)
                        : Math.min(100, (proc.rss / stats.maxRss) * 100);
                    const rssBarColor =
                      rssPct >= 60
                        ? "bg-rose-500"
                        : rssPct >= 25
                          ? "bg-amber-500"
                          : "bg-sky-500";

                    return (
                      <tr key={proc.pid} className={`${rowTint} transition-colors`}>
                        <td className="py-2.5 px-3 font-mono-num text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {proc.pid}
                        </td>
                        <td className="py-2.5 px-3 font-mono-num text-slate-600 dark:text-slate-300 whitespace-nowrap max-w-[100px] truncate">
                          {proc.user}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {renderStateBadge(proc.st)}
                        </td>
                        <td className="py-2.5 px-3 font-mono-num whitespace-nowrap">
                          <div className="flex flex-col items-end gap-1">
                            <span className={cpuTextColor}>
                              {proc.cpu.toFixed(1)}%
                            </span>
                            <div className="w-20 h-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${cpuBarColor}`}
                                style={{
                                  width: `${proc.cpu > 0 ? Math.max(3, cpuBarPct) : 0}%`,
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono-num whitespace-nowrap">
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-slate-800 dark:text-slate-200">
                              {formatBytes(proc.rss)}
                            </span>
                            <div className="w-20 h-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${rssBarColor}`}
                                style={{
                                  width: `${proc.rss > 0 ? Math.max(3, rssPct) : 0}%`,
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono-num text-right text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {proc.thr}
                        </td>
                        <td className="py-2.5 px-3 font-mono-num min-w-[260px] max-w-[420px]">
                          <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
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
