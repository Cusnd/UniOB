import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  BellOff,
  Check,
  Cloud,
  Copy,
  Edit3,
  Eye,
  KeyRound,
  Lock,
  Plus,
  Save,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import type {
  InspectorTab,
  PrototypeNode,
  RotateTokenResponse,
  TrafficCountMode,
  UpdateNodePayload,
} from "../types";
import {
  formatBytes,
  formatRelativeTime,
  formatTrafficMode,
  getTrafficUsagePct,
  isNodeMuted,
  parseOsBadge,
} from "../utils/format";

export interface NodesOpsViewProps {
  nodes: PrototypeNode[];
  groups: string[];
  onInspectNode: (node: PrototypeNode, tab?: InspectorTab) => void;
  onOpenAddServer: () => void;
  onUpdateNode: (id: string, patch: UpdateNodePayload) => void;
  onMuteNode: (id: string, seconds: number | null) => void;
  onRotateToken: (id: string) => RotateTokenResponse;
  onDeleteNode: (id: string) => void;
  onNavigateMigration: () => void;
}

type SortKey = "sort_order" | "name" | "group" | "status" | "traffic";
type SortDir = "asc" | "desc";
type QuickFilter = "all" | "online" | "offline" | "muted" | "traffic_warn";

interface EditDraft {
  id: string;
  name: string;
  group_name: string;
  tagsText: string;
  sort_order: string;
  limitGb: string;
  reset_day: string;
  count_mode: TrafficCountMode;
}

const DIALOG_LIGHT_DISMISS_ATTRS: Record<string, string> = {
  closedby: "any",
};

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function isOutsideDialogBounds(
  e: React.PointerEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement,
): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

async function copyTextSafe(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}

function OpsCopyButton({
  text,
  label,
  ariaLabel,
}: {
  text: string;
  label: string;
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const ok = await copyTextSafe(text);
    setCopied(ok);
    setFailed(!ok);
    setStatusMsg(ok ? `${label}已复制到剪贴板` : "复制失败，请手动选中文本复制");
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
      setStatusMsg("");
      timerRef.current = null;
    }, 2200);
  };

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={ariaLabel}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          copied
            ? "border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : failed
              ? "border-rose-500/45 bg-rose-500/15 text-rose-700 dark:text-rose-300"
              : "border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)]"
        }`}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        )}
        <span>{copied ? "已复制" : label}</span>
      </button>
      <span role="status" className="sr-only">
        {statusMsg}
      </span>
    </span>
  );
}

export function NodesOpsView({
  nodes,
  groups,
  onInspectNode,
  onOpenAddServer,
  onUpdateNode,
  onMuteNode,
  onRotateToken,
  onDeleteNode,
  onNavigateMigration,
}: NodesOpsViewProps): React.JSX.Element {
  const baseId = useId();
  const tableCaptionId = `${baseId}-table-caption`;
  const groupListId = `${baseId}-group-datalist`;
  const editTitleId = `${baseId}-edit-title`;
  const deleteTitleId = `${baseId}-delete-title`;

  const [selectedGroup, setSelectedGroup] = useState<string>("ALL");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("sort_order");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [sortAnnouncement, setSortAnnouncement] = useState("");

  const [rotatedInfo, setRotatedInfo] = useState<{
    nodeId: string;
    nodeName: string;
    data: RotateTokenResponse;
  } | null>(null);

  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingDeleteNode, setPendingDeleteNode] =
    useState<PrototypeNode | null>(null);

  const editDialogRef = useRef<HTMLDialogElement | null>(null);
  const editPointerDownOutsideRef = useRef(false);
  const editSyncingRef = useRef(false);

  const deleteDialogRef = useRef<HTMLDialogElement | null>(null);
  const deletePointerDownOutsideRef = useRef(false);
  const deleteSyncingRef = useRef(false);

  useEffect(() => {
    const dialog = editDialogRef.current;
    if (!dialog) return;
    if (editing) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      editSyncingRef.current = true;
      dialog.close();
      editSyncingRef.current = false;
    }
  }, [editing]);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (pendingDeleteNode) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      deleteSyncingRef.current = true;
      dialog.close();
      deleteSyncingRef.current = false;
    }
  }, [pendingDeleteNode]);

  const stats = useMemo(() => {
    const total = nodes.length;
    const online = nodes.filter((n) => n.online).length;
    const mutedCount = nodes.filter((n) => isNodeMuted(n)).length;
    const privacyLocked = nodes.filter((n) => !n.proc_enabled).length;
    const trafficWarn = nodes.filter(
      (n) => getTrafficUsagePct(n.traffic) >= 85,
    ).length;
    return {
      total,
      online,
      offline: total - online,
      mutedCount,
      privacyLocked,
      trafficWarn,
    };
  }, [nodes]);

  const groupCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of nodes) {
      map.set(n.group_name, (map.get(n.group_name) ?? 0) + 1);
    }
    return map;
  }, [nodes]);

  const filteredAndSortedNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = nodes.filter((n) => {
      if (selectedGroup !== "ALL" && n.group_name !== selectedGroup) {
        return false;
      }
      if (quickFilter === "online" && !n.online) return false;
      if (quickFilter === "offline" && n.online) return false;
      if (quickFilter === "muted" && !isNodeMuted(n)) return false;
      if (
        quickFilter === "traffic_warn" &&
        getTrafficUsagePct(n.traffic) < 85
      ) {
        return false;
      }
      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        (n.hostname ?? "").toLowerCase().includes(q) ||
        n.provider.toLowerCase().includes(q) ||
        n.region_code.toLowerCase().includes(q) ||
        n.ipv4_masked.toLowerCase().includes(q) ||
        n.group_name.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      );
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "sort_order":
          return (a.sort_order - b.sort_order) * dir;
        case "name":
          return COLLATOR.compare(a.name, b.name) * dir;
        case "group":
          return COLLATOR.compare(a.group_name, b.group_name) * dir;
        case "status": {
          if (a.online !== b.online) {
            return (a.online ? -1 : 1) * dir;
          }
          return ((a.last_seen_ts ?? 0) - (b.last_seen_ts ?? 0)) * dir;
        }
        case "traffic":
          return (a.traffic.counted_bytes - b.traffic.counted_bytes) * dir;
        default:
          return 0;
      }
    });
  }, [nodes, selectedGroup, quickFilter, searchQuery, sortBy, sortDir]);

  const handleSort = (key: SortKey, label: string) => {
    const nextDir: SortDir =
      sortBy === key ? (sortDir === "asc" ? "desc" : "asc") : "asc";
    setSortBy(key);
    setSortDir(nextDir);
    setSortAnnouncement(
      `已按${label}${nextDir === "asc" ? "升序" : "降序"}排列，共 ${filteredAndSortedNodes.length} 台服务器`,
    );
  };

  const openEditModal = (node: PrototypeNode) => {
    setEditError(null);
    setEditing({
      id: node.id,
      name: node.name,
      group_name: node.group_name,
      tagsText: node.tags.join(", "),
      sort_order: String(node.sort_order),
      limitGb:
        node.traffic.limit_bytes && node.traffic.limit_bytes > 0
          ? String(
              Math.round(
                (node.traffic.limit_bytes / (1024 * 1024 * 1024)) * 100,
              ) / 100,
            )
          : "",
      reset_day: String(node.traffic.reset_day),
      count_mode: node.traffic.count_mode,
    });
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    if (!editing.name.trim()) {
      setEditError("服务器名称不能为空");
      return;
    }

    const parsedLimitGb = editing.limitGb.trim()
      ? Number(editing.limitGb)
      : null;
    if (
      parsedLimitGb !== null &&
      (!Number.isFinite(parsedLimitGb) || parsedLimitGb < 0)
    ) {
      setEditError("月流量上限请输入有效的非负数字");
      return;
    }
    const limitBytes =
      parsedLimitGb !== null && parsedLimitGb > 0
        ? Math.round(parsedLimitGb * 1024 * 1024 * 1024)
        : null;

    const resetDayNum = Number.parseInt(editing.reset_day, 10);
    const clampedResetDay = Number.isFinite(resetDayNum)
      ? Math.max(1, Math.min(31, resetDayNum))
      : 1;

    const sortNum = Number.parseInt(editing.sort_order, 10);

    onUpdateNode(editing.id, {
      name: editing.name.trim(),
      group_name: editing.group_name.trim() || "Default",
      tags: editing.tagsText
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      sort_order: Number.isFinite(sortNum) ? sortNum : 0,
      traffic_limit_bytes: limitBytes,
      traffic_reset_day: clampedResetDay,
      traffic_count_mode: editing.count_mode,
    });
    setEditing(null);
  };

  const handleRotate = (node: PrototypeNode) => {
    const res = onRotateToken(node.id);
    setRotatedInfo({
      nodeId: node.id,
      nodeName: node.name,
      data: res,
    });
  };

  const editingNodeObj = useMemo(() => {
    if (!editing) return null;
    return nodes.find((n) => n.id === editing.id) ?? null;
  }, [editing, nodes]);

  return (
    <section className="space-y-5">
      {/* Top Header & Primary Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-[var(--text-primary)]">
              服务器资产台账与探针运维
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono-num font-medium bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              {stats.total} 节点
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            统一管理节点分组、月度流量计费口径、维护告警静默窗、一次性密钥轮换与隐私边界策略。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onNavigateMigration}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors"
          >
            <ArrowLeftRight
              className="w-3.5 h-3.5 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>双模热迁移工作台</span>
          </button>
          <button
            type="button"
            onClick={onOpenAddServer}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-95"
            style={{ backgroundColor: "var(--accent-solid)" }}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>部署新探针</span>
          </button>
        </div>
      </div>

      {/* Dual-Mode Engine Status Banner */}
      <div className="surface-card rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border"
            style={{
              backgroundColor: "var(--accent-soft)",
              borderColor: "var(--accent-ring)",
            }}
          >
            <Cloud
              className="w-5 h-5 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                双模对等控制面引擎 · Cloudflare SCCH ⇄ 自建 uniob-hub
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono-num font-medium bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                <span>Protocol v2 金丝雀热切流就绪</span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-secondary)]">
              <span className="font-mono-num">
                在线率 {stats.online}/{stats.total} (
                {stats.total > 0
                  ? Math.round((stats.online / stats.total) * 100)
                  : 0}
                %)
              </span>
              <span className="font-mono-num">
                隐私锁定（禁用 /proc）：{stats.privacyLocked} 台
              </span>
              <span className="font-mono-num">
                维护静默中：{stats.mutedCount} 台
              </span>
              {stats.trafficWarn > 0 && (
                <span className="font-mono-num text-amber-700 dark:text-amber-300 font-medium">
                  流量高水位预警：{stats.trafficWarn} 台
                </span>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onNavigateMigration}
          className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold border transition-colors self-start lg:self-center"
          style={{
            backgroundColor: "var(--accent-soft)",
            borderColor: "var(--accent-ring)",
            color: "var(--accent-primary)",
          }}
        >
          <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" />
          <span>进入双模热迁移工作台</span>
        </button>
      </div>

      {/* Rotated Token Echo Banner */}
      {rotatedInfo && (
        <div
          role="region"
          aria-label="密钥轮换结果"
          className="rounded-2xl border border-sky-500/40 bg-sky-500/10 p-4 space-y-3 text-xs"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <KeyRound
                className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div>
                <div className="font-semibold text-sky-900 dark:text-sky-200">
                  节点「{rotatedInfo.nodeName}」连接密钥已轮换（旧密钥 SHA-256 哈希已立即吊销）
                </div>
                <p className="text-[11px] text-sky-800/90 dark:text-sky-300/90 mt-0.5">
                  一次性明文密钥仅在此处展示，请在目标服务器终端执行更新命令使探针重新接入。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRotatedInfo(null)}
              aria-label="关闭密钥轮换提示"
              className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5">
            <div className="lg:col-span-4 rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                  New Agent Token
                </div>
                <code className="block truncate font-mono-num text-[11px] text-amber-300 mt-0.5">
                  {rotatedInfo.data.agent_token}
                </code>
              </div>
              <OpsCopyButton
                text={rotatedInfo.data.agent_token}
                label="复制密钥"
                ariaLabel={`复制 ${rotatedInfo.nodeName} 的新连接密钥`}
              />
            </div>

            <div className="lg:col-span-8 rounded-xl bg-slate-950 border border-slate-800 p-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                  Re-Provision Command
                </div>
                <code className="block break-all font-mono-num text-[11px] text-emerald-300 mt-0.5">
                  {rotatedInfo.data.install_cmd}
                </code>
              </div>
              <OpsCopyButton
                text={rotatedInfo.data.install_cmd}
                label="复制安装命令"
                ariaLabel={`复制 ${rotatedInfo.nodeName} 的重连安装命令`}
              />
            </div>
          </div>
        </div>
      )}

      {/* Filter & Search Toolbar */}
      <div className="surface-card rounded-2xl p-3.5 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Group Filter Pills */}
          <div
            role="group"
            aria-label="按服务器分组筛选"
            className="flex flex-wrap items-center gap-1.5"
          >
            <button
              type="button"
              onClick={() => setSelectedGroup("ALL")}
              aria-pressed={selectedGroup === "ALL"}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                selectedGroup === "ALL"
                  ? "text-[var(--accent-primary)] font-semibold"
                  : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
              style={
                selectedGroup === "ALL"
                  ? {
                      backgroundColor: "var(--accent-soft)",
                      borderColor: "var(--accent-ring)",
                    }
                  : undefined
              }
            >
              全部分组 ({nodes.length})
            </button>
            {groups.map((grp) => {
              const active = selectedGroup === grp;
              return (
                <button
                  key={grp}
                  type="button"
                  onClick={() => setSelectedGroup(grp)}
                  aria-pressed={active}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    active
                      ? "text-[var(--accent-primary)] font-semibold"
                      : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
                  {grp} ({groupCounts.get(grp) ?? 0})
                </button>
              );
            })}
          </div>

          {/* Search Input */}
          <div className="relative w-full md:w-72 shrink-0">
            <Search
              className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索名称、主机名、服务商、标签..."
              aria-label="搜索台账中的服务器"
              className="w-full pl-8 pr-3 py-1.5 rounded-xl text-xs border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>

        {/* Status Quick Filters */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {(
              [
                { key: "all", label: "全部状态", count: stats.total },
                { key: "online", label: "在线中", count: stats.online },
                { key: "offline", label: "已离线", count: stats.offline },
                { key: "muted", label: "静默维护", count: stats.mutedCount },
                {
                  key: "traffic_warn",
                  label: "流量 >= 85%",
                  count: stats.trafficWarn,
                },
              ] as const
            ).map((opt) => {
              const active = quickFilter === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setQuickFilter(opt.key)}
                  aria-pressed={active}
                  className={`px-2.5 py-1 rounded-md border font-medium transition-colors ${
                    active
                      ? "bg-[var(--bg-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]"
                      : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-inset)]"
                  }`}
                >
                  {opt.label}{" "}
                  <span className="font-mono-num opacity-75">({opt.count})</span>
                </button>
              );
            })}
          </div>

          <span className="text-[11px] font-mono-num text-[var(--text-muted)]">
            当前显示 {filteredAndSortedNodes.length} / {nodes.length} 台
          </span>
        </div>
      </div>

      {/* Accessible Sortable & Responsive Asset Ledger Table */}
      <div className="surface-card rounded-2xl overflow-hidden">
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={tableCaptionId}
          className="overflow-x-auto"
        >
          <table className="w-full text-left border-collapse text-xs">
            <caption id={tableCaptionId} className="sr-only">
              UniOB 服务器资产运维台账，包含排序序号、节点身份、分组与系统、探针状态与隐私权限、月度流量计费进度及操作按钮
            </caption>
            <thead className="bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
              <tr>
                <th
                  scope="col"
                  aria-sort={
                    sortBy === "sort_order"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className="py-2.5 px-3 whitespace-nowrap"
                >
                  <button
                    type="button"
                    onClick={() => handleSort("sort_order", "排序序号")}
                    className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)]"
                  >
                    <span>#</span>
                    <ArrowUpDown className="w-3 h-3 opacity-60" aria-hidden="true" />
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortBy === "name"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className="py-2.5 px-3 whitespace-nowrap"
                >
                  <button
                    type="button"
                    onClick={() => handleSort("name", "服务器名称")}
                    className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)]"
                  >
                    <span>服务器资产</span>
                    <ArrowUpDown className="w-3 h-3 opacity-60" aria-hidden="true" />
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortBy === "group"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className="py-2.5 px-3 whitespace-nowrap"
                >
                  <button
                    type="button"
                    onClick={() => handleSort("group", "所属分组")}
                    className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)]"
                  >
                    <span>分组 / 发行版</span>
                    <ArrowUpDown className="w-3 h-3 opacity-60" aria-hidden="true" />
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortBy === "status"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className="py-2.5 px-3 whitespace-nowrap"
                >
                  <button
                    type="button"
                    onClick={() => handleSort("status", "探针连接状态")}
                    className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)]"
                  >
                    <span>探针状态与隐私边界</span>
                    <ArrowUpDown className="w-3 h-3 opacity-60" aria-hidden="true" />
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortBy === "traffic"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className="py-2.5 px-3 whitespace-nowrap"
                >
                  <button
                    type="button"
                    onClick={() => handleSort("traffic", "本月已计费流量")}
                    className="inline-flex items-center gap-1 font-semibold hover:text-[var(--text-primary)]"
                  >
                    <span>月流量计费账本</span>
                    <ArrowUpDown className="w-3 h-3 opacity-60" aria-hidden="true" />
                  </button>
                </th>
                <th scope="col" className="py-2.5 px-3 text-right whitespace-nowrap">
                  运维操作
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[var(--border-subtle)]">
              {filteredAndSortedNodes.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="py-12 px-4 text-center text-[var(--text-muted)]"
                  >
                    当前筛选条件下暂无匹配服务器，可清空筛选词或点击「部署新探针」注册节点。
                  </td>
                </tr>
              ) : (
                filteredAndSortedNodes.map((node) => {
                  const osBadge = parseOsBadge(node.os);
                  const muted = isNodeMuted(node);
                  const trafficPct = getTrafficUsagePct(node.traffic);
                  const hasLimit =
                    node.traffic.limit_bytes !== null &&
                    node.traffic.limit_bytes > 0;
                  const barTone =
                    trafficPct >= 90
                      ? "bg-rose-500"
                      : trafficPct >= 75
                        ? "bg-amber-500"
                        : "bg-emerald-500";

                  return (
                    <tr
                      key={node.id}
                      className="hover:bg-[var(--bg-card-hover)] transition-colors"
                    >
                      <td className="py-3 px-3 font-mono-num text-[var(--text-muted)] align-top">
                        {node.sort_order}
                      </td>

                      <td className="py-3 px-3 align-top">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${
                              node.online
                                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                                : "bg-rose-500/12 text-rose-700 dark:text-rose-300 border-rose-500/30"
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                node.online ? "bg-emerald-500" : "bg-rose-500"
                              }`}
                              aria-hidden="true"
                            />
                            {node.online ? "在线" : "离线"}
                          </span>

                          <button
                            type="button"
                            onClick={() => onInspectNode(node, "charts")}
                            className="font-semibold text-[var(--text-primary)] hover:text-[var(--accent-primary)] transition-colors text-left"
                          >
                            {node.region_flag} {node.name}
                          </button>

                          {muted && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                              <BellOff className="w-2.5 h-2.5" aria-hidden="true" />
                              静默中
                            </span>
                          )}
                        </div>

                        <div className="mt-1 font-mono-num text-[11px] text-[var(--text-muted)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span>{node.hostname || "等待首帧握手"}</span>
                          <span>·</span>
                          <span>{node.ipv4_masked}</span>
                          <span>·</span>
                          <span>{node.provider}</span>
                        </div>

                        {node.tags.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {node.tags.map((tag) => (
                              <span
                                key={tag}
                                className="px-1.5 py-0.2 rounded text-[10px] font-mono-num bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap align-top">
                        <div className="flex flex-col gap-1.5 items-start">
                          <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
                            {node.group_name}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${osBadge.colorClass}`}
                            >
                              {osBadge.short}
                            </span>
                            {node.arch && (
                              <span className="font-mono-num text-[10px] text-[var(--text-muted)]">
                                {node.arch}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3 whitespace-nowrap align-top">
                        <div className="space-y-1 font-mono-num text-[11px]">
                          <div className="flex items-center gap-1.5 text-[var(--text-primary)]">
                            <span>
                              {node.agent_version
                                ? `agent v${node.agent_version}`
                                : "未注册心跳"}
                            </span>
                            <span className="text-[var(--text-muted)]">·</span>
                            {node.proc_enabled ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                                <Terminal className="w-3 h-3" aria-hidden="true" />
                                /proc 开启
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                                <Lock className="w-3 h-3" aria-hidden="true" />
                                隐私锁定
                              </span>
                            )}
                          </div>
                          <div className="text-[var(--text-muted)]">
                            心跳：{formatRelativeTime(node.last_seen_ts)}
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3 min-w-[13rem] align-top">
                        <div className="space-y-1.5 font-mono-num text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[var(--text-primary)] font-medium">
                              {formatBytes(node.traffic.counted_bytes)} /{" "}
                              {hasLimit
                                ? formatBytes(node.traffic.limit_bytes)
                                : "不限配额"}
                            </span>
                            {hasLimit && (
                              <span
                                className={
                                  trafficPct >= 90
                                    ? "text-rose-600 dark:text-rose-400 font-semibold"
                                    : trafficPct >= 75
                                      ? "text-amber-600 dark:text-amber-400 font-semibold"
                                      : "text-[var(--text-secondary)]"
                                }
                              >
                                {trafficPct.toFixed(1)}%
                              </span>
                            )}
                          </div>

                          {hasLimit ? (
                            <div className="h-1.5 w-full rounded-full bg-[var(--bg-inset)] overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${barTone}`}
                                style={{
                                  width: `${Math.min(100, Math.max(2, trafficPct))}%`,
                                }}
                              />
                            </div>
                          ) : (
                            <div className="h-1.5 w-full rounded-full bg-[var(--bg-inset)] overflow-hidden">
                              <div
                                className="h-full rounded-full opacity-50"
                                style={{
                                  width: "24%",
                                  backgroundColor: "var(--accent-primary)",
                                }}
                              />
                            </div>
                          )}

                          <div className="text-[10px] text-[var(--text-muted)]">
                            {formatTrafficMode(node.traffic.count_mode)} · 每月{" "}
                            {node.traffic.reset_day} 日重置（剩{" "}
                            {node.traffic.days_remaining} 天）
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3 text-right whitespace-nowrap align-top">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onInspectNode(node, "charts")}
                            title="透视节点曲线与详情"
                            aria-label={`查看 ${node.name} 实时遥测`}
                            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] hover:border-[var(--accent-ring)] transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>

                          <button
                            type="button"
                            onClick={() => onInspectNode(node, "procs")}
                            title="按需查看 /proc 进程"
                            aria-label={`查看 ${node.name} 进程列表`}
                            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] hover:border-[var(--accent-ring)] transition-colors"
                          >
                            <Activity className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>

                          <button
                            type="button"
                            onClick={() => openEditModal(node)}
                            title="编辑节点配置与流量口径"
                            aria-label={`编辑 ${node.name} 配置`}
                            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-sky-600 dark:hover:text-sky-400 hover:border-sky-500/40 transition-colors"
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              onMuteNode(node.id, muted ? null : 1800)
                            }
                            title={muted ? "取消维护静默" : "快速静默 30 分钟"}
                            aria-label={
                              muted
                                ? `取消 ${node.name} 告警静默`
                                : `将 ${node.name} 静默 30 分钟`
                            }
                            className={`p-1.5 rounded-lg border transition-colors ${
                              muted
                                ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-amber-600 dark:hover:text-amber-400 hover:border-amber-500/40"
                            }`}
                          >
                            {muted ? (
                              <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                            ) : (
                              <BellOff className="w-3.5 h-3.5" aria-hidden="true" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => handleRotate(node)}
                            title="轮换连接密钥"
                            aria-label={`轮换 ${node.name} 的连接密钥`}
                            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-amber-600 dark:hover:text-amber-400 hover:border-amber-500/40 transition-colors"
                          >
                            <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>

                          <button
                            type="button"
                            onClick={() => setPendingDeleteNode(node)}
                            title="安全移除节点"
                            aria-label={`移除 ${node.name}`}
                            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-500/40 hover:bg-rose-500/10 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div role="status" className="sr-only">
          {sortAnnouncement}
        </div>
      </div>

      {/* Native <dialog> Node Edit Modal */}
      <dialog
        ref={editDialogRef}
        {...DIALOG_LIGHT_DISMISS_ATTRS}
        aria-labelledby={editing ? editTitleId : undefined}
        aria-label={editing ? undefined : "编辑服务器配置"}
        onPointerDown={(e) => {
          const d = editDialogRef.current;
          if (!d) return;
          editPointerDownOutsideRef.current =
            e.target === d && isOutsideDialogBounds(e, d);
        }}
        onPointerUp={(e) => {
          const d = editDialogRef.current;
          const startedOutside = editPointerDownOutsideRef.current;
          editPointerDownOutsideRef.current = false;
          if (!d || !startedOutside) return;
          if (e.target === d && isOutsideDialogBounds(e, d)) {
            setEditing(null);
          }
        }}
        onCancel={(e) => {
          e.preventDefault();
          setEditing(null);
        }}
        onClose={() => {
          if (!editSyncingRef.current && editing !== null) {
            setEditing(null);
          }
        }}
        className="m-auto w-[min(38rem,calc(100vw-2rem))] max-h-[90dvh] overflow-hidden overscroll-contain rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xl"
      >
        <div className="flex flex-col max-h-[90dvh] w-full min-h-0 bg-[var(--bg-surface)] text-[var(--text-primary)]">
          {editing && (
            <>
              <div className="shrink-0 px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Server
                    className="w-4 h-4 text-[var(--accent-primary)] shrink-0"
                    aria-hidden="true"
                  />
                  <h2
                    id={editTitleId}
                    className="text-sm font-bold text-[var(--text-primary)] truncate"
                  >
                    编辑节点配置 · {editing.name}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  aria-label="关闭编辑窗口"
                  className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <form
                noValidate
                onSubmit={handleSaveEdit}
                className="flex-1 overflow-y-auto p-5 space-y-4 text-xs"
              >
                {editError && (
                  <div
                    role="alert"
                    className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-rose-700 dark:text-rose-300"
                  >
                    {editError}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label
                      htmlFor={`${baseId}-edit-name`}
                      className="block font-medium text-[var(--text-secondary)] mb-1"
                    >
                      服务器名称 *
                    </label>
                    <input
                      id={`${baseId}-edit-name`}
                      type="text"
                      required
                      value={editing.name}
                      onChange={(e) => {
                        setEditing({ ...editing, name: e.target.value });
                        if (editError) setEditError(null);
                      }}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-edit-group`}
                      className="block font-medium text-[var(--text-secondary)] mb-1"
                    >
                      所属分组
                    </label>
                    <input
                      id={`${baseId}-edit-group`}
                      type="text"
                      list={groupListId}
                      value={editing.group_name}
                      onChange={(e) =>
                        setEditing({ ...editing, group_name: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]"
                    />
                    <datalist id={groupListId}>
                      {groups.map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-edit-tags`}
                      className="block font-medium text-[var(--text-secondary)] mb-1"
                    >
                      资产标签（逗号分隔）
                    </label>
                    <input
                      id={`${baseId}-edit-tags`}
                      type="text"
                      value={editing.tagsText}
                      onChange={(e) =>
                        setEditing({ ...editing, tagsText: e.target.value })
                      }
                      placeholder="BGP, Edge, Prod"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`${baseId}-edit-sort`}
                      className="block font-medium text-[var(--text-secondary)] mb-1"
                    >
                      排序序号（越小越靠前）
                    </label>
                    <input
                      id={`${baseId}-edit-sort`}
                      type="number"
                      value={editing.sort_order}
                      onChange={(e) =>
                        setEditing({ ...editing, sort_order: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                    />
                  </div>
                </div>

                {/* Traffic Billing Settings */}
                <div className="pt-3 border-t border-[var(--border-subtle)] space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-[var(--text-primary)]">
                      月度流量配额与计费口径
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {[
                        { label: "不限", val: "" },
                        { label: "1 TB", val: "1024" },
                        { label: "2 TB", val: "2048" },
                        { label: "10 TB", val: "10240" },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() =>
                            setEditing({ ...editing, limitGb: preset.val })
                          }
                          className="px-2 py-0.5 rounded-md text-[11px] font-mono-num border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label
                        htmlFor={`${baseId}-edit-limit`}
                        className="block text-[var(--text-secondary)] mb-1"
                      >
                        月流量上限 (GB，留空不限)
                      </label>
                      <input
                        id={`${baseId}-edit-limit`}
                        type="number"
                        min="0"
                        step="any"
                        value={editing.limitGb}
                        onChange={(e) =>
                          setEditing({ ...editing, limitGb: e.target.value })
                        }
                        placeholder="留空为不限"
                        className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`${baseId}-edit-reset`}
                        className="block text-[var(--text-secondary)] mb-1"
                      >
                        每月重置日 (1–31 号)
                      </label>
                      <input
                        id={`${baseId}-edit-reset`}
                        type="number"
                        min="1"
                        max="31"
                        value={editing.reset_day}
                        onChange={(e) =>
                          setEditing({ ...editing, reset_day: e.target.value })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`${baseId}-edit-mode`}
                        className="block text-[var(--text-secondary)] mb-1"
                      >
                        计费方式
                      </label>
                      <select
                        id={`${baseId}-edit-mode`}
                        value={editing.count_mode}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            count_mode: e.target.value as TrafficCountMode,
                          })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]"
                      >
                        <option value="both">{formatTrafficMode("both")}</option>
                        <option value="tx_only">
                          {formatTrafficMode("tx_only")}
                        </option>
                        <option value="max">{formatTrafficMode("max")}</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Quick Maintenance Mute Window Controls */}
                {editingNodeObj && (
                  <div className="pt-3 border-t border-[var(--border-subtle)] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-[var(--text-primary)]">
                        维护静默快捷设置
                      </span>
                      <span className="text-[11px] font-mono-num text-[var(--text-muted)]">
                        {isNodeMuted(editingNodeObj)
                          ? "当前处于静默状态"
                          : "当前告警正常触发"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { sec: 1800, label: "静默 30 分钟" },
                        { sec: 7200, label: "静默 2 小时" },
                        { sec: 86400, label: "静默 24 小时" },
                      ].map((opt) => (
                        <button
                          key={opt.sec}
                          type="button"
                          onClick={() => onMuteNode(editingNodeObj.id, opt.sec)}
                          className="px-2.5 py-1 rounded-lg text-[11px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          {opt.label}
                        </button>
                      ))}
                      {isNodeMuted(editingNodeObj) && (
                        <button
                          type="button"
                          onClick={() => onMuteNode(editingNodeObj.id, null)}
                          className="px-2.5 py-1 rounded-lg text-[11px] border border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 font-medium"
                        >
                          立即取消静默
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="pt-3 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="px-4 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm"
                    style={{ backgroundColor: "var(--accent-solid)" }}
                  >
                    <Save className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>保存配置变更</span>
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </dialog>

      {/* Native <dialog> Safe Two-Step Delete Confirmation Modal */}
      <dialog
        ref={deleteDialogRef}
        {...DIALOG_LIGHT_DISMISS_ATTRS}
        aria-labelledby={pendingDeleteNode ? deleteTitleId : undefined}
        aria-label={pendingDeleteNode ? undefined : "确认移除服务器"}
        onPointerDown={(e) => {
          const d = deleteDialogRef.current;
          if (!d) return;
          deletePointerDownOutsideRef.current =
            e.target === d && isOutsideDialogBounds(e, d);
        }}
        onPointerUp={(e) => {
          const d = deleteDialogRef.current;
          const startedOutside = deletePointerDownOutsideRef.current;
          deletePointerDownOutsideRef.current = false;
          if (!d || !startedOutside) return;
          if (e.target === d && isOutsideDialogBounds(e, d)) {
            setPendingDeleteNode(null);
          }
        }}
        onCancel={(e) => {
          e.preventDefault();
          setPendingDeleteNode(null);
        }}
        onClose={() => {
          if (!deleteSyncingRef.current && pendingDeleteNode !== null) {
            setPendingDeleteNode(null);
          }
        }}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] overflow-hidden overscroll-contain rounded-2xl border border-rose-500/35 bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xl"
      >
        <div className="flex flex-col w-full bg-[var(--bg-surface)] text-[var(--text-primary)] p-5 space-y-4">
          {pendingDeleteNode && (
            <>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/35 flex items-center justify-center shrink-0">
                  <ShieldAlert
                    className="w-5 h-5 text-rose-600 dark:text-rose-400"
                    aria-hidden="true"
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <h2
                    id={deleteTitleId}
                    className="text-sm font-bold text-[var(--text-primary)]"
                  >
                    确认从台账移除服务器？
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    即将移除{" "}
                    <span className="font-semibold text-[var(--text-primary)]">
                      {pendingDeleteNode.region_flag} {pendingDeleteNode.name}
                    </span>
                    （<span className="font-mono-num">{pendingDeleteNode.id}</span>
                    ）。节点配置、连接密钥哈希与关联事件将被清理，探针将立即失去接入权限。
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
                <button
                  type="button"
                  onClick={() => setPendingDeleteNode(null)}
                  className="px-4 py-2 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  取消保留
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDeleteNode(pendingDeleteNode.id);
                    setPendingDeleteNode(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-sm"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>确认永久移除</span>
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </section>
  );
}
