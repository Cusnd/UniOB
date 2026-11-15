import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Loader2, Server, Sparkles, Terminal, X } from "lucide-react";
import type {
  CreateNodeResponse,
  NodeSummary,
  TrafficCountMode,
} from "../types";
import { api } from "../api/client";
import { formatTrafficMode } from "../utils/format";
import { CopyButton } from "./CopyButton";

interface AddNodeModalProps {
  open: boolean;
  nodes: NodeSummary[];
  existingGroups: string[];
  onClose: () => void;
  onNodeCreated: (node: NodeSummary) => void;
  onInspectNode?: (node: NodeSummary) => void;
}

export function AddNodeModal({
  open,
  nodes,
  existingGroups,
  onClose,
  onNodeCreated,
  onInspectNode,
}: AddNodeModalProps) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const nameId = `${baseId}-name`;
  const groupId = `${baseId}-group`;
  const tagsId = `${baseId}-tags`;
  const sortId = `${baseId}-sort`;
  const limitId = `${baseId}-limit`;
  const resetDayId = `${baseId}-reset-day`;
  const countModeId = `${baseId}-count-mode`;
  const commOnlyId = `${baseId}-comm-only`;
  const disableProcId = `${baseId}-disable-proc`;

  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("Default");
  const [tagsText, setTagsText] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [limitGb, setLimitGb] = useState("");
  const [resetDay, setResetDay] = useState("1");
  const [countMode, setCountMode] = useState<TrafficCountMode>("both");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateNodeResponse | null>(null);

  const [cmdlineCommOnly, setCmdlineCommOnly] = useState(false);
  const [disableProc, setDisableProc] = useState(false);

  const liveNode = useMemo(() => {
    if (!created) return null;
    return nodes.find((n) => n.id === created.node.id) ?? created.node;
  }, [created, nodes]);

  const finalInstallCmd = useMemo(() => {
    if (!created) return "";
    let cmd = created.install_cmd.trim();
    if (cmdlineCommOnly) {
      cmd += " --cmdline comm_only";
    }
    if (disableProc) {
      cmd += " --disable-proc";
    }
    return cmd;
  }, [created, cmdlineCommOnly, disableProc]);

  const resetAndClose = useCallback(() => {
    setName("");
    setGroupName("Default");
    setTagsText("");
    setSortOrder("0");
    setLimitGb("");
    setResetDay("1");
    setCountMode("both");
    setError(null);
    setCreated(null);
    setCmdlineCommOnly(false);
    setDisableProc(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resetAndClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, resetAndClose]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("请输入服务器名称");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const parsedLimitGb = limitGb.trim() ? Number(limitGb) : null;
      const limitBytes =
        parsedLimitGb !== null && Number.isFinite(parsedLimitGb) && parsedLimitGb > 0
          ? Math.round(parsedLimitGb * 1024 * 1024 * 1024)
          : null;

      const parsedResetDay = Math.max(
        1,
        Math.min(31, Number.parseInt(resetDay, 10) || 1)
      );
      const parsedSort = Number.parseInt(sortOrder, 10) || 0;
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await api.createNode({
        name: name.trim(),
        group_name: groupName.trim() || "Default",
        tags,
        sort_order: parsedSort,
        traffic_limit_bytes: limitBytes,
        traffic_reset_day: parsedResetDay,
        traffic_count_mode: countMode,
      });

      setCreated(res);
      onNodeCreated(res.node);
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加服务器失败");
    } finally {
      setSubmitting(false);
    }
  };

  const isOnlineNow = liveNode?.online === true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-slate-950/65 backdrop-blur-[2px]"
        onClick={resetAndClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 w-full max-w-xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1623] shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-sky-500" aria-hidden="true" />
            <h3
              id={titleId}
              className="text-sm font-bold text-slate-900 dark:text-slate-50"
            >
              {created ? "安装监控客户端并等待上线" : "添加 Linux 服务器"}
            </h3>
          </div>
          <button
            type="button"
            onClick={resetAndClose}
            aria-label="关闭窗口"
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {!created ? (
          <form noValidate onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-600 dark:text-rose-300"
              >
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label
                  htmlFor={nameId}
                  className="block font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  服务器名称 *
                </label>
                <input
                  id={nameId}
                  type="text"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="例如：香港 BGP 1 号机"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>

              <div>
                <label
                  htmlFor={groupId}
                  className="block font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  分组
                </label>
                <input
                  id={groupId}
                  type="text"
                  list="uniob-groups"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Default"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
                <datalist id="uniob-groups">
                  {existingGroups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label
                  htmlFor={tagsId}
                  className="block font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  标签（逗号分隔）
                </label>
                <input
                  id={tagsId}
                  type="text"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="例如：香港, debian, 1G带宽"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>

              <div>
                <label
                  htmlFor={sortId}
                  className="block font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  排序序号（越小越靠前）
                </label>
                <input
                  id={sortId}
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 font-mono-num focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="font-semibold text-slate-700 dark:text-slate-200 mb-2.5">
                月度流量统计
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label
                    htmlFor={limitId}
                    className="block text-slate-500 dark:text-slate-400 mb-1"
                  >
                    每月流量上限 (GB，留空不限)
                  </label>
                  <input
                    id={limitId}
                    type="number"
                    min="0"
                    step="any"
                    value={limitGb}
                    onChange={(e) => setLimitGb(e.target.value)}
                    placeholder="如 500"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 font-mono-num focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  />
                </div>
                <div>
                  <label
                    htmlFor={resetDayId}
                    className="block text-slate-500 dark:text-slate-400 mb-1"
                  >
                    每月重置日 (1–31 号)
                  </label>
                  <input
                    id={resetDayId}
                    type="number"
                    min="1"
                    max="31"
                    value={resetDay}
                    onChange={(e) => setResetDay(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 font-mono-num focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  />
                </div>
                <div>
                  <label
                    htmlFor={countModeId}
                    className="block text-slate-500 dark:text-slate-400 mb-1"
                  >
                    流量统计方式
                  </label>
                  <select
                    id={countModeId}
                    value={countMode}
                    onChange={(e) => setCountMode(e.target.value as TrafficCountMode)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#090d14] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  >
                    <option value="both">{formatTrafficMode("both")}</option>
                    <option value="tx_only">{formatTrafficMode("tx_only")}</option>
                    <option value="max">{formatTrafficMode("max")}</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetAndClose}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold disabled:opacity-50"
              >
                {submitting && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                )}
                生成安装命令
              </button>
            </div>
          </form>
        ) : (
          <div className="p-5 space-y-4 text-xs">
            {/* Live Handshake Detection Banner */}
            {isOnlineNow ? (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 p-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Sparkles className="w-5 h-5 text-emerald-500 shrink-0" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-bold text-emerald-700 dark:text-emerald-300">
                      服务器已成功上线！
                    </div>
                    <div className="text-xs text-emerald-600 dark:text-emerald-400 font-mono-num mt-0.5">
                      {liveNode?.hostname || liveNode?.name} ·{" "}
                      {liveNode?.os || "Linux"} · {liveNode?.arch || ""}
                    </div>
                  </div>
                </div>
                {liveNode && onInspectNode && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = liveNode;
                      resetAndClose();
                      onInspectNode(target);
                    }}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                  >
                    查看服务器详情
                  </button>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3.5 flex items-center gap-3">
                <Loader2 className="w-4 h-4 text-sky-500 animate-spin shrink-0" aria-hidden="true" />
                <div>
                  <div className="font-semibold text-sky-700 dark:text-sky-300">
                    正在等待服务器连线...
                  </div>
                  <div className="text-[11px] text-sky-600/80 dark:text-sky-400/80 mt-0.5">
                    在目标 Linux 服务器执行下方命令后，页面会自动感知上线。
                  </div>
                </div>
              </div>
            )}

            {/* Install Options */}
            <div className="space-y-2">
              <div className="font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-sky-500" aria-hidden="true" />
                隐私与安全选项
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label
                  htmlFor={commOnlyId}
                  className="flex items-start gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#090d14] cursor-pointer"
                >
                  <input
                    id={commOnlyId}
                    type="checkbox"
                    checked={cmdlineCommOnly}
                    onChange={(e) => setCmdlineCommOnly(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                  <div>
                    <div className="font-semibold text-slate-800 dark:text-slate-200">
                      仅记录程序名
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      隐藏命令行启动参数，保护参数中的敏感信息
                    </div>
                  </div>
                </label>

                <label
                  htmlFor={disableProcId}
                  className="flex items-start gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#090d14] cursor-pointer"
                >
                  <input
                    id={disableProcId}
                    type="checkbox"
                    checked={disableProc}
                    onChange={(e) => setDisableProc(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                  <div>
                    <div className="font-semibold text-slate-800 dark:text-slate-200">
                      禁用进程列表查看
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      完全不允许从面板读取服务器上的进程列表
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* One-line command */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  Linux 一键安装命令
                </span>
                <CopyButton
                  text={finalInstallCmd}
                  label="复制安装命令"
                  ariaLabel="复制 Linux 一键安装命令"
                />
              </div>
              <pre className="rounded-xl bg-slate-950 border border-slate-800 p-3.5 font-mono-num text-[11px] text-emerald-300 leading-relaxed break-all whitespace-pre-wrap select-all">
                {finalInstallCmd}
              </pre>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                提示：安装命令中包含的连接密钥仅在此处完整显示一次，如丢失可在「服务器管理」中重置连接密钥。
              </p>
            </div>

            <div className="pt-2 flex items-center justify-end">
              <button
                type="button"
                onClick={resetAndClose}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 dark:hover:bg-slate-700 text-white font-medium"
              >
                {isOnlineNow ? "完成" : "后台继续等待"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
