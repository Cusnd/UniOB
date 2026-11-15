import React, { useId, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import type {
  HorizonNode,
  InspectorTab,
  RotateTokenResponse,
  TrafficCountMode,
  UpdateNodePayload,
} from "../types";
import {
  formatBytes,
  formatBytesCompact,
  formatBytesPerSec,
  getMemTotalBytes,
  getMemUsagePct,
  getTrafficUsagePct,
  isNodeMuted,
  parseOsBadge,
} from "../utils/format";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  IconCloseButton,
  MetricBar,
  NativeDialog,
  SectionHeader,
  SegmentedControl,
  StatusDot,
} from "./ui/Primitives";

export interface NodesOpsViewProps {
  nodes: HorizonNode[];
  groups: string[];
  onInspectNode: (node: HorizonNode, tab?: InspectorTab) => void;
  onOpenAddServer: () => void;
  onUpdateNode: (id: string, patch: UpdateNodePayload) => Promise<void>;
  onMuteNode: (id: string, seconds: number | null) => Promise<void>;
  onRotateToken: (id: string) => Promise<RotateTokenResponse>;
  onDeleteNode: (id: string) => Promise<void>;
  onNavigateMigration: () => void;
}

type SortColumn = "name" | "group" | "net" | "cpu" | "mem" | "traffic";
type SortDirection = "ascending" | "descending";
type QuickStatusFilter = "all" | "online" | "offline" | "muted";

const GB_BYTES = 1024 * 1024 * 1024;
const zhCollator = new Intl.Collator("zh-CN", { numeric: true });

export function NodesOpsView(props: NodesOpsViewProps): React.JSX.Element {
  const {
    nodes,
    groups,
    onInspectNode,
    onOpenAddServer,
    onUpdateNode,
    onMuteNode,
    onRotateToken,
    onDeleteNode,
    onNavigateMigration,
  } = props;

  const tableCaptionId = useId();
  const editTitleId = useId();
  const tokenTitleId = useId();
  const deleteTitleId = useId();
  const groupDatalistId = useId();

  // Filter & Sort state
  const [groupFilter, setGroupFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<QuickStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [sortCol, setSortCol] = useState<SortColumn>("name");
  const [sortDir, setSortDir] = useState<SortDirection>("ascending");
  const [sortAnnouncement, setSortAnnouncement] = useState("");
  const [busyMuteId, setBusyMuteId] = useState<string | null>(null);

  // Edit Server Modal state
  const [editingNode, setEditingNode] = useState<HorizonNode | null>(null);
  const [editName, setEditName] = useState("");
  const [editGroup, setEditGroup] = useState("");
  const [editTagsText, setEditTagsText] = useState("");
  const [editSortOrder, setEditSortOrder] = useState(0);
  const [editLimitGb, setEditLimitGb] = useState("");
  const [editResetDay, setEditResetDay] = useState(1);
  const [editCountMode, setEditCountMode] = useState<TrafficCountMode>("both");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Rotate Token Modal state
  const [tokenNode, setTokenNode] = useState<HorizonNode | null>(null);
  const [rotatingToken, setRotatingToken] = useState(false);
  const [rotatedResult, setRotatedResult] =
    useState<RotateTokenResponse | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Delete Server Confirmation Modal state
  const [deletingNode, setDeletingNode] = useState<HorizonNode | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const onlineCount = useMemo(
    () => nodes.filter((n) => n.online).length,
    [nodes],
  );

  const filteredAndSorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = nodes.filter((node) => {
      if (groupFilter !== "ALL" && node.group_name !== groupFilter) {
        return false;
      }
      if (statusFilter === "online" && !node.online) return false;
      if (statusFilter === "offline" && node.online) return false;
      if (statusFilter === "muted" && !isNodeMuted(node)) return false;

      if (!q) return true;
      const haystacks = [
        node.name,
        node.group_name,
        node.hostname ?? "",
        node.ipv4_masked,
        node.region_code,
        node.provider,
        node.os ?? "",
        ...node.tags,
      ];
      return haystacks.some((item) => item.toLowerCase().includes(q));
    });

    const mult = sortDir === "ascending" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortCol) {
        case "name":
          return zhCollator.compare(a.name, b.name) * mult;
        case "group":
          return (
            zhCollator.compare(a.group_name || "", b.group_name || "") * mult
          );
        case "net": {
          const nA =
            a.online && a.metrics
              ? a.metrics.net.rx_bps + a.metrics.net.tx_bps
              : -1;
          const nB =
            b.online && b.metrics
              ? b.metrics.net.rx_bps + b.metrics.net.tx_bps
              : -1;
          return (nA - nB) * mult;
        }
        case "cpu": {
          const cA = a.online && a.metrics ? a.metrics.cpu.all : -1;
          const cB = b.online && b.metrics ? b.metrics.cpu.all : -1;
          return (cA - cB) * mult;
        }
        case "mem": {
          const mA = a.online ? getMemUsagePct(a) : -1;
          const mB = b.online ? getMemUsagePct(b) : -1;
          return (mA - mB) * mult;
        }
        case "traffic":
          return (a.traffic.counted_bytes - b.traffic.counted_bytes) * mult;
      }
    });
  }, [nodes, groupFilter, statusFilter, query, sortCol, sortDir]);

  const handleSort = (col: SortColumn, label: string) => {
    const nextDir: SortDirection =
      sortCol === col && sortDir === "ascending" ? "descending" : "ascending";
    setSortCol(col);
    setSortDir(nextDir);
    setSortAnnouncement(
      `已按${label}${nextDir === "ascending" ? "升序" : "降序"}排列`,
    );
  };

  const openEditModal = (node: HorizonNode) => {
    setEditingNode(node);
    setEditName(node.name);
    setEditGroup(node.group_name);
    setEditTagsText(node.tags.join(", "));
    setEditSortOrder(node.sort_order);
    setEditLimitGb(
      node.traffic.limit_bytes && node.traffic.limit_bytes > 0
        ? String(Math.round((node.traffic.limit_bytes / GB_BYTES) * 10) / 10)
        : "",
    );
    setEditResetDay(node.traffic.reset_day || 1);
    setEditCountMode(node.traffic.count_mode || "both");
    setEditError(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingNode || savingEdit) return;
    const trimmedName = editName.trim();
    if (!trimmedName) {
      setEditError("请填写服务器名称");
      return;
    }

    const parsedGb = Number(editLimitGb.trim());
    const limitBytes =
      editLimitGb.trim() === "" || !Number.isFinite(parsedGb) || parsedGb <= 0
        ? null
        : Math.round(parsedGb * GB_BYTES);

    const parsedTags = editTagsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);

    setSavingEdit(true);
    setEditError(null);
    try {
      await onUpdateNode(editingNode.id, {
        name: trimmedName,
        group_name: editGroup.trim(),
        tags: parsedTags,
        sort_order: Number.isFinite(editSortOrder) ? editSortOrder : 0,
        traffic_limit_bytes: limitBytes,
        traffic_reset_day: Math.min(28, Math.max(1, Math.round(editResetDay))),
        traffic_count_mode: editCountMode,
      });
      setEditingNode(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "保存失败，请稍后重试");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleQuickMuteToggle = async (node: HorizonNode) => {
    if (busyMuteId === node.id) return;
    setBusyMuteId(node.id);
    try {
      const muted = isNodeMuted(node);
      await onMuteNode(node.id, muted ? null : 3600);
    } catch {
      // Toast handled by App
    } finally {
      setBusyMuteId(null);
    }
  };

  const handleConfirmRotateToken = async () => {
    if (!tokenNode || rotatingToken) return;
    setRotatingToken(true);
    setTokenError(null);
    try {
      const res = await onRotateToken(tokenNode.id);
      setRotatedResult(res);
    } catch (err) {
      setTokenError(
        err instanceof Error ? err.message : "重置连接密钥失败，请重试",
      );
    } finally {
      setRotatingToken(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingNode || deletingBusy) return;
    setDeletingBusy(true);
    setDeleteError(null);
    try {
      await onDeleteNode(deletingNode.id);
      setDeletingNode(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "移除服务器失败");
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div role="status" aria-live="polite" className="sr-only">
        {sortAnnouncement}
      </div>

      {/* Clean Header (Topbar already owns the global + 添加服务器 CTA) */}
      <SectionHeader
        title="服务器"
        badge={
          <Badge tone="neutral">
            在线 {onlineCount} / {nodes.length}
          </Badge>
        }
        actions={
          nodes.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={onNavigateMigration}
            >
              服务与迁移
            </Button>
          ) : undefined
        }
      />

      {/* Filter & Search Toolbar */}
      <search className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={groupFilter === "ALL"}
            onClick={() => setGroupFilter("ALL")}
            style={
              groupFilter === "ALL"
                ? {
                    backgroundColor: "var(--ink-primary)",
                    color: "var(--ink-on-primary)",
                  }
                : {
                    backgroundColor: "var(--bg-card)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-hairline)",
                  }
            }
            className="h-8 cursor-pointer rounded-[8px] px-3 text-[12.5px] font-medium transition-colors"
          >
            全部
          </button>

          {groups.map((grp) => {
            const active = groupFilter === grp;
            return (
              <button
                key={grp}
                type="button"
                aria-pressed={active}
                onClick={() => setGroupFilter(grp)}
                style={
                  active
                    ? {
                        backgroundColor: "var(--ink-primary)",
                        color: "var(--ink-on-primary)",
                      }
                    : {
                        backgroundColor: "var(--bg-card)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border-hairline)",
                      }
                }
                className="h-8 cursor-pointer rounded-[8px] px-3 text-[12.5px] font-medium transition-colors"
              >
                {grp}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl<QuickStatusFilter>
            ariaLabel="服务器状态筛选"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "all", label: "全部" },
              { value: "online", label: "在线" },
              { value: "offline", label: "离线" },
              { value: "muted", label: "已静音" },
            ]}
          />

          <div className="relative w-full sm:w-60">
            <Search
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5"
              style={{
                color: "var(--text-tertiary)",
                top: "50%",
                transform: "translateY(-50%)",
              }}
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称、分组或地址..."
              aria-label="搜索服务器"
              style={{
                backgroundColor: "var(--bg-card)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
              }}
              className="h-8 w-full rounded-[8px] pr-3 pl-8 text-[12.5px] outline-none"
            />
          </div>
        </div>
      </search>

      {/* Clean Server Inventory Table */}
      <Card padded={false} className="overflow-hidden">
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
                  aria-sort={sortCol === "name" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("name", "名称")}
                  >
                    <span>服务器</span>
                    {sortCol === "name" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "group" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("group", "分组")}
                  >
                    <span>分组</span>
                    {sortCol === "group" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th scope="col">地址 / 规格</th>

                <th
                  scope="col"
                  aria-sort={sortCol === "net" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("net", "实时网速")}
                  >
                    <span>实时网速</span>
                    {sortCol === "net" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "cpu" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("cpu", "CPU")}
                  >
                    <span>CPU</span>
                    {sortCol === "cpu" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "mem" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("mem", "内存")}
                  >
                    <span>内存</span>
                    {sortCol === "mem" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th
                  scope="col"
                  aria-sort={sortCol === "traffic" ? sortDir : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("traffic", "月流量")}
                  >
                    <span>月流量</span>
                    {sortCol === "traffic" ? (
                      sortDir === "ascending" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown
                        className="h-3 w-3 opacity-40"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </th>

                <th scope="col" className="text-right">
                  操作
                </th>
              </tr>
            </thead>

            <tbody>
              {filteredAndSorted.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-14 text-center">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <span
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[13px]"
                      >
                        {nodes.length === 0
                          ? "暂未接入服务器"
                          : "没有匹配筛选条件的服务器"}
                      </span>
                      {nodes.length === 0 && (
                        <Button
                          size="sm"
                          variant="primary"
                          icon={
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                          }
                          onClick={onOpenAddServer}
                        >
                          添加第一台服务器
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredAndSorted.map((node) => {
                  const muted = isNodeMuted(node);
                  const cpuPct =
                    node.online && node.metrics ? node.metrics.cpu.all : 0;
                  const memPct = node.online ? getMemUsagePct(node) : 0;
                  const memTotalBytes = getMemTotalBytes(node);
                  const osInfo = parseOsBadge(node.os);
                  const hasLimit =
                    node.traffic.limit_bytes !== null &&
                    node.traffic.limit_bytes > 0;
                  const trafficPct = hasLimit
                    ? Math.min(100, getTrafficUsagePct(node.traffic))
                    : 12;

                  const specText =
                    node.cpu_cores && memTotalBytes > 0
                      ? `${node.cpu_cores}C · ${formatBytesCompact(memTotalBytes)}`
                      : osInfo.short;

                  const metaSubline = [node.region_code, node.provider]
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .join(" · ");

                  return (
                    <tr key={node.id}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <StatusDot
                            tone={
                              !node.online
                                ? "danger"
                                : cpuPct >= 88 || memPct >= 88
                                  ? "warn"
                                  : "ok"
                            }
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => onInspectNode(node, "charts")}
                                style={{ color: "var(--text-primary)" }}
                                className="cursor-pointer truncate text-left text-[13px] font-semibold hover:underline"
                              >
                                {node.name}
                              </button>
                              {muted && <Badge tone="subtle">已静音</Badge>}
                            </div>
                            {metaSubline && (
                              <div
                                style={{ color: "var(--text-tertiary)" }}
                                className="truncate text-[11.5px]"
                              >
                                {metaSubline}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      <td>
                        {groups.length > 0 ? (
                          <select
                            aria-label={`${node.name} 分组`}
                            value={node.group_name}
                            onChange={(e) => {
                              void onUpdateNode(node.id, {
                                group_name: e.target.value,
                              });
                            }}
                            style={{
                              backgroundColor: "var(--bg-subtle)",
                              color: "var(--text-secondary)",
                              border: "1px solid var(--border-hairline)",
                            }}
                            className="h-7 max-w-[132px] cursor-pointer truncate rounded-[6px] px-2 text-[12px]"
                          >
                            <option value="">未分组</option>
                            {groups.map((grp) => (
                              <option key={grp} value={grp}>
                                {grp}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Badge tone="neutral">
                            {node.group_name || "未分组"}
                          </Badge>
                        )}
                      </td>

                      <td>
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <span
                            style={{ color: "var(--text-primary)" }}
                            className="font-mono-num tabular-nums text-[12.5px]"
                          >
                            {node.ipv4_masked || node.hostname || "—"}
                          </span>
                          <Badge tone="neutral">{specText}</Badge>
                        </div>
                      </td>

                      <td className="whitespace-nowrap">
                        {node.online && node.metrics ? (
                          <div className="font-mono-num tabular-nums flex flex-col gap-0.5 text-[12px] leading-tight">
                            <span style={{ color: "var(--accent-ink)" }}>
                              ↓ {formatBytesPerSec(node.metrics.net.rx_bps)}
                            </span>
                            <span style={{ color: "var(--status-ok-ink)" }}>
                              ↑ {formatBytesPerSec(node.metrics.net.tx_bps)}
                            </span>
                          </div>
                        ) : (
                          <span
                            style={{ color: "var(--text-tertiary)" }}
                            className="font-mono-num tabular-nums text-[12px]"
                          >
                            —
                          </span>
                        )}
                      </td>

                      <td>
                        <div className="w-28">
                          <MetricBar
                            valueLabel={
                              node.online && node.metrics
                                ? `${cpuPct.toFixed(0)}%`
                                : "离线"
                            }
                            valuePct={cpuPct}
                            thickness={3}
                          />
                        </div>
                      </td>

                      <td>
                        <div className="w-28">
                          <MetricBar
                            valueLabel={
                              node.online && node.metrics
                                ? `${Math.round(memPct)}%`
                                : "—"
                            }
                            valuePct={memPct}
                            thickness={3}
                          />
                        </div>
                      </td>

                      <td>
                        <div className="w-32">
                          <MetricBar
                            valueLabel={
                              hasLimit
                                ? `${formatBytesCompact(node.traffic.counted_bytes)} / ${formatBytesCompact(node.traffic.limit_bytes)}`
                                : formatBytes(node.traffic.counted_bytes)
                            }
                            valuePct={trafficPct}
                            thickness={3}
                          />
                        </div>
                      </td>

                      <td className="text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            size="xs"
                            variant="secondary"
                            icon={
                              <SlidersHorizontal
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            }
                            onClick={() => openEditModal(node)}
                          >
                            编辑
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busyMuteId === node.id}
                            aria-label={
                              muted
                                ? `取消静音 ${node.name}`
                                : `静音 ${node.name}`
                            }
                            icon={
                              muted ? (
                                <VolumeX
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Volume2
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              )
                            }
                            onClick={() => void handleQuickMuteToggle(node)}
                          />
                          <Button
                            size="xs"
                            variant="ghost"
                            icon={
                              <KeyRound className="h-3 w-3" aria-hidden="true" />
                            }
                            onClick={() => {
                              setTokenNode(node);
                              setRotatedResult(null);
                              setTokenError(null);
                            }}
                          >
                            密钥
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label={`移除 ${node.name}`}
                            icon={
                              <Trash2
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                            }
                            onClick={() => {
                              setDeletingNode(node);
                              setDeleteError(null);
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 1. Edit Server Modal */}
      <NativeDialog
        open={editingNode !== null}
        onClose={() => {
          if (!savingEdit) setEditingNode(null);
        }}
        titleId={editTitleId}
        maxWidthClass="max-w-[460px]"
      >
        {editingNode && (
          <form onSubmit={(e) => void handleSaveEdit(e)} className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h3
                id={editTitleId}
                style={{ color: "var(--text-primary)" }}
                className="text-[15px] font-semibold"
              >
                编辑服务器
              </h3>
              <IconCloseButton
                onClick={() => {
                  if (!savingEdit) setEditingNode(null);
                }}
              />
            </div>

            {editError && (
              <div
                role="alert"
                style={{
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--status-danger-ink)",
                }}
                className="rounded-[8px] px-3 py-2 text-[12px]"
              >
                {editError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <label
                  htmlFor="edit-node-name"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  服务器名称
                </label>
                <input
                  id="edit-node-name"
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="edit-node-group"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  分组
                </label>
                <input
                  id="edit-node-group"
                  type="text"
                  list={groupDatalistId}
                  value={editGroup}
                  onChange={(e) => setEditGroup(e.target.value)}
                  placeholder="例如：亚太生产"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
                <datalist id={groupDatalistId}>
                  {groups.map((grp) => (
                    <option key={grp} value={grp} />
                  ))}
                </datalist>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="edit-node-sort"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  排序权重
                </label>
                <input
                  id="edit-node-sort"
                  type="number"
                  value={editSortOrder}
                  onChange={(e) => setEditSortOrder(Number(e.target.value) || 0)}
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>

              <div className="space-y-1 sm:col-span-2">
                <label
                  htmlFor="edit-node-tags"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  标签（逗号分隔）
                </label>
                <input
                  id="edit-node-tags"
                  type="text"
                  value={editTagsText}
                  onChange={(e) => setEditTagsText(e.target.value)}
                  placeholder="边缘, 东京, CN2"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="edit-node-limit"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  月流量配额（GB，留空不限）
                </label>
                <input
                  id="edit-node-limit"
                  type="number"
                  min={0}
                  step="any"
                  value={editLimitGb}
                  onChange={(e) => setEditLimitGb(e.target.value)}
                  placeholder="不限流量"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="edit-node-reset-day"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  每月重置日（1-28）
                </label>
                <input
                  id="edit-node-reset-day"
                  type="number"
                  min={1}
                  max={28}
                  value={editResetDay}
                  onChange={(e) =>
                    setEditResetDay(
                      Math.min(28, Math.max(1, Number(e.target.value) || 1)),
                    )
                  }
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="font-mono-num h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                />
              </div>

              <div className="space-y-1 sm:col-span-2">
                <label
                  htmlFor="edit-node-mode"
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  流量计费方式
                </label>
                <select
                  id="edit-node-mode"
                  value={editCountMode}
                  onChange={(e) =>
                    setEditCountMode(e.target.value as TrafficCountMode)
                  }
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
                >
                  <option value="both">双向计费（上传 + 下载）</option>
                  <option value="tx_only">仅计上传（出向流量）</option>
                  <option value="max">双向取大（较高一侧）</option>
                </select>
              </div>
            </div>

            {/* Quick Mute Actions */}
            <div
              style={{
                backgroundColor: "var(--bg-subtle)",
                border: "1px solid var(--border-hairline)",
              }}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] px-3 py-2.5"
            >
              <span
                style={{ color: "var(--text-secondary)" }}
                className="text-[12px] font-medium"
              >
                告警通知静音
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => void onMuteNode(editingNode.id, 3600)}
                >
                  静音 1 小时
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => void onMuteNode(editingNode.id, 86400)}
                >
                  静音 24 小时
                </Button>
                {isNodeMuted(editingNode) && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void onMuteNode(editingNode.id, null)}
                  >
                    恢复通知
                  </Button>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={savingEdit}
                onClick={() => setEditingNode(null)}
              >
                取消
              </Button>
              <Button
                autoFocus
                type="submit"
                variant="primary"
                size="sm"
                disabled={savingEdit}
                icon={
                  savingEdit ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : undefined
                }
              >
                {savingEdit ? "保存中..." : "保存"}
              </Button>
            </div>
          </form>
        )}
      </NativeDialog>

      {/* 2. Rotate Connection Key Modal */}
      <NativeDialog
        open={tokenNode !== null}
        onClose={() => {
          if (!rotatingToken) {
            setTokenNode(null);
            setRotatedResult(null);
          }
        }}
        titleId={tokenTitleId}
        maxWidthClass="max-w-[440px]"
      >
        {tokenNode && (
          <div className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h3
                id={tokenTitleId}
                style={{ color: "var(--text-primary)" }}
                className="text-[15px] font-semibold"
              >
                重置连接密钥 · {tokenNode.name}
              </h3>
              <IconCloseButton
                onClick={() => {
                  if (!rotatingToken) {
                    setTokenNode(null);
                    setRotatedResult(null);
                  }
                }}
              />
            </div>

            {tokenError && (
              <div
                role="alert"
                style={{
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--status-danger-ink)",
                }}
                className="rounded-[8px] px-3 py-2 text-[12px]"
              >
                {tokenError}
              </div>
            )}

            {rotatedResult ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div
                    style={{ color: "var(--text-secondary)" }}
                    className="text-[12px] font-medium"
                  >
                    更新安装命令
                  </div>
                  <div
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      border: "1px solid var(--border-subtle)",
                    }}
                    className="space-y-2.5 rounded-[8px] p-3"
                  >
                    <code
                      style={{ color: "var(--text-primary)" }}
                      className="block break-all font-mono text-[12px] leading-relaxed"
                    >
                      {rotatedResult.install_cmd}
                    </code>
                    <div className="flex justify-end">
                      <CopyButton
                        value={rotatedResult.install_cmd}
                        label="复制命令"
                      />
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-hairline)",
                  }}
                  className="flex items-center justify-between gap-2 rounded-[8px] px-3 py-2"
                >
                  <code
                    style={{ color: "var(--text-secondary)" }}
                    className="truncate font-mono text-[12px]"
                  >
                    {rotatedResult.agent_token}
                  </code>
                  <CopyButton
                    value={rotatedResult.agent_token}
                    label="复制密钥"
                  />
                </div>
              </div>
            ) : (
              <div
                style={{ color: "var(--text-secondary)" }}
                className="text-[13px] leading-relaxed"
              >
                生成新密钥后，原连接密钥将立即失效，需在目标服务器上重新执行安装命令以恢复连接。
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={rotatingToken}
                onClick={() => {
                  setTokenNode(null);
                  setRotatedResult(null);
                }}
              >
                关闭
              </Button>
              {!rotatedResult && (
                <Button
                  autoFocus
                  variant="primary"
                  size="sm"
                  disabled={rotatingToken}
                  icon={
                    rotatingToken ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    )
                  }
                  onClick={() => void handleConfirmRotateToken()}
                >
                  {rotatingToken ? "生成中..." : "生成新密钥"}
                </Button>
              )}
            </div>
          </div>
        )}
      </NativeDialog>

      {/* 3. Delete Server Confirmation Modal */}
      <NativeDialog
        open={deletingNode !== null}
        onClose={() => {
          if (!deletingBusy) setDeletingNode(null);
        }}
        titleId={deleteTitleId}
        maxWidthClass="max-w-[400px]"
      >
        {deletingNode && (
          <div className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h3
                id={deleteTitleId}
                style={{ color: "var(--text-primary)" }}
                className="text-[15px] font-semibold"
              >
                移除服务器
              </h3>
              <IconCloseButton
                onClick={() => {
                  if (!deletingBusy) setDeletingNode(null);
                }}
              />
            </div>

            {deleteError && (
              <div
                role="alert"
                style={{
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--status-danger-ink)",
                }}
                className="rounded-[8px] px-3 py-2 text-[12px]"
              >
                {deleteError}
              </div>
            )}

            <p
              style={{ color: "var(--text-secondary)" }}
              className="text-[13px] leading-relaxed"
            >
              确认移除{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {deletingNode.name}
              </strong>{" "}
              及其历史监控记录？此操作不可撤销。
            </p>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={deletingBusy}
                onClick={() => setDeletingNode(null)}
              >
                取消
              </Button>
              <Button
                autoFocus
                variant="danger"
                size="sm"
                disabled={deletingBusy}
                icon={
                  deletingBusy ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : undefined
                }
                onClick={() => void handleConfirmDelete()}
              >
                {deletingBusy ? "移除中..." : "确认移除"}
              </Button>
            </div>
          </div>
        )}
      </NativeDialog>
    </div>
  );
}

export default NodesOpsView;
