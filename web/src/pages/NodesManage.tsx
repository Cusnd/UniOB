import { useState } from "react";
import {
  BellOff,
  Edit3,
  Eye,
  KeyRound,
  Plus,
  Save,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import type {
  NodeSummary,
  RotateTokenResponse,
  TrafficCountMode,
} from "../types";
import { api } from "../api/client";
import {
  formatBytes,
  formatRelativeTime,
  formatTrafficMode,
  isNodeMuted,
  parseOsBadge,
} from "../utils/format";
import { CopyButton } from "../components/CopyButton";
import { HubMigrationPanel } from "../components/HubMigrationPanel";

interface NodesManageProps {
  nodes: NodeSummary[];
  onNodeUpdated: (node: NodeSummary) => void;
  onNodeDeleted: (id: string) => void;
  onInspectNode: (node: NodeSummary) => void;
  onOpenAddModal: () => void;
  onRefreshNodes?: () => Promise<void> | void;
}

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

export function NodesManage({
  nodes,
  onNodeUpdated,
  onNodeDeleted,
  onInspectNode,
  onOpenAddModal,
  onRefreshNodes,
}: NodesManageProps) {
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotatedInfo, setRotatedInfo] = useState<{
    nodeName: string;
    data: RotateTokenResponse;
  } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const startEdit = (node: NodeSummary) => {
    setEditing({
      id: node.id,
      name: node.name,
      group_name: node.group_name,
      tagsText: node.tags.join(", "),
      sort_order: String(node.sort_order),
      limitGb:
        node.traffic.limit_bytes && node.traffic.limit_bytes > 0
          ? String(
              Math.round((node.traffic.limit_bytes / (1024 * 1024 * 1024)) * 100) /
                100,
            )
          : "",
      reset_day: String(node.traffic.reset_day),
      count_mode: node.traffic.count_mode,
    });
    setError(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusyId(editing.id);
    setError(null);

    try {
      const parsedLimitGb = editing.limitGb.trim()
        ? Number(editing.limitGb)
        : null;
      const limitBytes =
        parsedLimitGb !== null &&
        Number.isFinite(parsedLimitGb) &&
        parsedLimitGb > 0
          ? Math.round(parsedLimitGb * 1024 * 1024 * 1024)
          : null;

      const res = await api.updateNode(editing.id, {
        name: editing.name.trim() || "Unnamed",
        group_name: editing.group_name.trim() || "Default",
        tags: editing.tagsText
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        sort_order: Number.parseInt(editing.sort_order, 10) || 0,
        traffic_limit_bytes: limitBytes,
        traffic_reset_day: Math.max(
          1,
          Math.min(31, Number.parseInt(editing.reset_day, 10) || 1),
        ),
        traffic_count_mode: editing.count_mode,
      });
      onNodeUpdated(res.node);
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleMuteToggle = async (node: NodeSummary, seconds: number | null) => {
    setBusyId(node.id);
    setError(null);
    try {
      const muteUntil =
        seconds === null ? null : Math.floor(Date.now() / 1000) + seconds;
      const res = await api.updateNode(node.id, { mute_until: muteUntil });
      onNodeUpdated(res.node);
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置静默失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleRotate = async (node: NodeSummary) => {
    setBusyId(node.id);
    setError(null);
    try {
      const res = await api.rotateNodeToken(node.id);
      setRotatedInfo({ nodeName: node.name, data: res });
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置连接密钥失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.deleteNode(id);
      onNodeDeleted(id);
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除服务器失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
            服务器管理
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            管理服务器分组、月度流量统计方式、重置连接密钥或迁移面板。
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenAddModal}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          添加服务器
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      {rotatedInfo && (
        <div className="rounded-xl border border-sky-500/40 bg-sky-500/10 p-4 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sky-700 dark:text-sky-300">
              服务器「{rotatedInfo.nodeName}」的连接密钥已更新（旧连接已失效，请在服务器上执行新命令）：
            </span>
            <button
              type="button"
              onClick={() => setRotatedInfo(null)}
              aria-label="关闭提示"
              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950 p-3 font-mono-num text-[11px] text-emerald-300">
            <code className="flex-1 break-all">{rotatedInfo.data.install_cmd}</code>
            <CopyButton
              text={rotatedInfo.data.install_cmd}
              label="复制命令"
              ariaLabel="复制更新连接命令"
            />
          </div>
        </div>
      )}

      {/* Edit Node Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setEditing(null)}
          />
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-node-dialog-title"
            onSubmit={handleSaveEdit}
            className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] p-5 space-y-4 text-xs shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3
                id="edit-node-dialog-title"
                className="text-sm font-bold text-slate-900 dark:text-slate-50"
              >
                编辑服务器配置
              </h3>
              <button
                type="button"
                onClick={() => setEditing(null)}
                aria-label="关闭窗口"
                className="p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="edit-node-name"
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  服务器名称
                </label>
                <input
                  id="edit-node-name"
                  type="text"
                  required
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-node-group"
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  分组
                </label>
                <input
                  id="edit-node-group"
                  type="text"
                  value={editing.group_name}
                  onChange={(e) =>
                    setEditing({ ...editing, group_name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-node-tags"
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  标签（逗号分隔）
                </label>
                <input
                  id="edit-node-tags"
                  type="text"
                  value={editing.tagsText}
                  onChange={(e) =>
                    setEditing({ ...editing, tagsText: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-node-sort"
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  排序序号
                </label>
                <input
                  id="edit-node-sort"
                  type="number"
                  value={editing.sort_order}
                  onChange={(e) =>
                    setEditing({ ...editing, sort_order: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 font-mono-num"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-node-limit"
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  每月流量上限 (GB，留空不限)
                </label>
                <input
                  id="edit-node-limit"
                  type="number"
                  min="0"
                  step="any"
                  value={editing.limitGb}
                  onChange={(e) =>
                    setEditing({ ...editing, limitGb: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 font-mono-num"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-node-reset-day"
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  每月重置日 (1–31 号)
                </label>
                <input
                  id="edit-node-reset-day"
                  type="number"
                  min="1"
                  max="31"
                  value={editing.reset_day}
                  onChange={(e) =>
                    setEditing({ ...editing, reset_day: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 font-mono-num"
                />
              </div>
              <div className="sm:col-span-2">
                <label
                  htmlFor="edit-node-count-mode"
                  className="block text-slate-600 dark:text-slate-300 mb-1"
                >
                  流量统计方式
                </label>
                <select
                  id="edit-node-count-mode"
                  value={editing.count_mode}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      count_mode: e.target.value as TrafficCountMode,
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100"
                >
                  <option value="both">{formatTrafficMode("both")}</option>
                  <option value="tx_only">{formatTrafficMode("tx_only")}</option>
                  <option value="max">{formatTrafficMode("max")}</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busyId === editing.id}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
                保存修改
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Nodes Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-50 dark:bg-[#131c2e] border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-mono-num">
              <tr>
                <th scope="col" className="py-2.5 px-3">排序</th>
                <th scope="col" className="py-2.5 px-3">服务器</th>
                <th scope="col" className="py-2.5 px-3">分组 / 系统</th>
                <th scope="col" className="py-2.5 px-3">客户端状态</th>
                <th scope="col" className="py-2.5 px-3">本月流量</th>
                <th scope="col" className="py-2.5 px-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {nodes.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="py-10 text-center text-slate-400 dark:text-slate-500"
                  >
                    暂无服务器，点击右上角「添加服务器」开始添加。
                  </td>
                </tr>
              ) : (
                nodes.map((node) => {
                  const osBadge = parseOsBadge(node.os);
                  const muted = isNodeMuted(node);
                  const busy = busyId === node.id;
                  return (
                    <tr
                      key={node.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/30"
                    >
                      <td className="py-2.5 px-3 font-mono-num text-slate-500">
                        {node.sort_order}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                          <span
                            className={`inline-block w-2 h-2 rounded-full ${
                              node.online ? "bg-emerald-500" : "bg-rose-500"
                            }`}
                            aria-hidden="true"
                          />
                          {node.name}
                          {muted && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/30">
                              静默
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono-num text-slate-400">
                          {node.hostname || "等待首次连接"}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                            {node.group_name}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] border ${osBadge.colorClass}`}
                          >
                            {osBadge.short}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono-num text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        <div>
                          {node.agent_version ? `v${node.agent_version}` : "未连接"} ·{" "}
                          {node.proc_enabled ? "支持进程查看" : "已禁用进程查看"}
                        </div>
                        <div className="text-slate-400">
                          {formatRelativeTime(node.last_seen_ts)}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono-num text-[11px] whitespace-nowrap">
                        <div>
                          {formatBytes(node.traffic.counted_bytes)} /{" "}
                          {node.traffic.limit_bytes
                            ? formatBytes(node.traffic.limit_bytes)
                            : "不限"}
                        </div>
                        <div className="text-slate-400">
                          {formatTrafficMode(node.traffic.count_mode)} · 每月{" "}
                          {node.traffic.reset_day} 号重置
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onInspectNode(node)}
                            title="查看服务器详情"
                            aria-label={`查看 ${node.name} 详情`}
                            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-sky-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(node)}
                            title="编辑服务器"
                            aria-label={`编辑 ${node.name}`}
                            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-sky-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              handleMuteToggle(node, muted ? null : 1800)
                            }
                            title={muted ? "取消静默" : "静默 30 分钟"}
                            aria-label={muted ? `取消 ${node.name} 告警静默` : `静默 ${node.name} 告警 30 分钟`}
                            className={`p-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 ${
                              muted
                                ? "text-amber-500"
                                : "text-slate-600 dark:text-slate-300"
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
                            disabled={busy}
                            onClick={() => handleRotate(node)}
                            title="重置连接密钥"
                            aria-label={`重置 ${node.name} 连接密钥`}
                            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>

                          {confirmDeleteId === node.id ? (
                            <div className="inline-flex items-center gap-1 ml-1">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleDelete(node.id)}
                                className="px-2 py-1 rounded bg-rose-600 text-white text-[11px] font-semibold"
                              >
                                确认移除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-1.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-[11px]"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDeleteId(node.id)}
                              title="移除服务器"
                              aria-label={`移除 ${node.name}`}
                              className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-rose-500 hover:bg-rose-500/10"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <HubMigrationPanel nodes={nodes} onBundleImported={onRefreshNodes} />
    </section>
  );
}
