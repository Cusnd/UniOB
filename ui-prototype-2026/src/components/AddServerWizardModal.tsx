import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import type {
  CreateNodePayload,
  CreateNodeResponse,
  PrototypeNode,
  TrafficCountMode,
} from "../types";
import { formatTrafficMode } from "../utils/format";

export interface AddServerWizardModalProps {
  open: boolean;
  existingGroups: string[];
  nodes: PrototypeNode[];
  onClose: () => void;
  onCreateNode: (payload: CreateNodePayload) => CreateNodeResponse;
  onSimulateOnline: (nodeId: string) => void;
  onInspectNode: (node: PrototypeNode) => void;
}

const DIALOG_LIGHT_DISMISS_ATTRS: Record<string, string> = {
  closedby: "any",
};

const QUICK_TAG_SUGGESTIONS = ["Prod", "BGP", "Edge", "NVMe", "1G-VPS", "CN2-GIA"];

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

function WizardCopyButton({
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
    setStatusMsg(ok ? `${label}已复制到剪贴板` : "复制失败，请手动复制");
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
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          copied
            ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
            : failed
              ? "border-rose-500/50 bg-rose-500/20 text-rose-300"
              : "border-slate-700 bg-slate-800/90 text-slate-200 hover:bg-slate-700"
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

function renderHighlightedCommand(cmd: string): React.JSX.Element[] {
  const parts = cmd.split(/(\s+)/);
  let prevNonSpace = "";

  return parts.map((token, idx) => {
    if (/^\s+$/.test(token)) {
      return <span key={idx}>{token}</span>;
    }

    let cls = "text-slate-100";
    if (token === "curl" || token === "sudo" || token === "bash") {
      cls = "text-cyan-300 font-semibold";
    } else if (token === "|" || token === "--") {
      cls = "text-amber-400 font-semibold";
    } else if (token.startsWith("https://") || token.startsWith("http://")) {
      cls = "text-emerald-300 underline decoration-emerald-500/40 underline-offset-2";
    } else if (token === "--cmdline" || token === "--disable-proc") {
      cls = "text-fuchsia-300 font-semibold";
    } else if (token.startsWith("-")) {
      cls = "text-sky-300";
    } else if (prevNonSpace === "--token") {
      cls = "text-amber-300";
    } else if (prevNonSpace === "--id") {
      cls = "text-emerald-200";
    } else if (prevNonSpace === "--cmdline") {
      cls = "text-fuchsia-200 font-semibold";
    }

    prevNonSpace = token;
    return (
      <span key={idx} className={cls}>
        {token}
      </span>
    );
  });
}

export function AddServerWizardModal({
  open,
  existingGroups,
  nodes,
  onClose,
  onCreateNode,
  onSimulateOnline,
  onInspectNode,
}: AddServerWizardModalProps): React.JSX.Element {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const groupDatalistId = `${baseId}-groups`;
  const nameId = `${baseId}-name`;
  const groupId = `${baseId}-group`;
  const tagsId = `${baseId}-tags`;
  const sortId = `${baseId}-sort`;
  const limitId = `${baseId}-limit`;
  const resetDayId = `${baseId}-reset-day`;
  const countModeId = `${baseId}-count-mode`;
  const commOnlyId = `${baseId}-comm-only`;
  const disableProcId = `${baseId}-disable-proc`;

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pointerDownOutsideRef = useRef(false);
  const syncingCloseRef = useRef(false);

  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState(
    existingGroups[0] ?? "亚太核心 BGP",
  );
  const [tagsText, setTagsText] = useState("");
  const [sortOrder, setSortOrder] = useState(String(nodes.length + 1));
  const [limitGb, setLimitGb] = useState("2048");
  const [resetDay, setResetDay] = useState("1");
  const [countMode, setCountMode] = useState<TrafficCountMode>("both");
  const [formError, setFormError] = useState<string | null>(null);

  const [created, setCreated] = useState<CreateNodeResponse | null>(null);
  const [cmdlineCommOnly, setCmdlineCommOnly] = useState(false);
  const [disableProc, setDisableProc] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const simTimerRef = useRef<number | null>(null);

  const resetFormState = useCallback(() => {
    if (simTimerRef.current !== null) {
      window.clearTimeout(simTimerRef.current);
      simTimerRef.current = null;
    }
    setName("");
    setGroupName(existingGroups[0] ?? "亚太核心 BGP");
    setTagsText("");
    setSortOrder(String(nodes.length + 1));
    setLimitGb("2048");
    setResetDay("1");
    setCountMode("both");
    setFormError(null);
    setCreated(null);
    setCmdlineCommOnly(false);
    setDisableProc(false);
    setSimulating(false);
  }, [existingGroups, nodes.length]);

  const resetAndClose = useCallback(() => {
    resetFormState();
    onClose();
  }, [onClose, resetFormState]);

  useEffect(() => {
    return () => {
      if (simTimerRef.current !== null) {
        window.clearTimeout(simTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        setSortOrder(String(nodes.length + 1));
        dialog.showModal();
      }
    } else if (dialog.open) {
      syncingCloseRef.current = true;
      dialog.close();
      syncingCloseRef.current = false;
      resetFormState();
    }
  }, [open, nodes.length, resetFormState]);

  const matchedNode = useMemo<PrototypeNode | null>(() => {
    if (!created) return null;
    return nodes.find((n) => n.id === created.node.id) ?? null;
  }, [created, nodes]);

  const liveNode = matchedNode ?? created?.node ?? null;

  const finalInstallCmd = useMemo(() => {
    if (!created) return "";
    let cmd = created.install_cmd.trim();
    if (cmdlineCommOnly) cmd += " --cmdline comm_only";
    if (disableProc) cmd += " --disable-proc";
    return cmd;
  }, [created, cmdlineCommOnly, disableProc]);

  const highlightedCmdNodes = useMemo(
    () => renderHighlightedCommand(finalInstallCmd),
    [finalInstallCmd],
  );

  const isOnlineNow = liveNode?.online === true;

  const handleAppendTag = (tag: string) => {
    const existing = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (existing.includes(tag)) return;
    setTagsText([...existing, tag].join(", "));
  };

  const handleSubmitStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("请输入服务器标识名称（例如：sgp-edge-02）");
      return;
    }

    const parsedLimitGb = limitGb.trim() ? Number(limitGb) : null;
    if (
      parsedLimitGb !== null &&
      (!Number.isFinite(parsedLimitGb) || parsedLimitGb < 0)
    ) {
      setFormError("每月流量上限请输入有效的非负数字");
      return;
    }
    const limitBytes =
      parsedLimitGb !== null && parsedLimitGb > 0
        ? Math.round(parsedLimitGb * 1024 * 1024 * 1024)
        : null;

    const parsedResetDay = Math.max(
      1,
      Math.min(31, Number.parseInt(resetDay, 10) || 1),
    );
    const parsedSort = Number.parseInt(sortOrder, 10) || 0;
    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

    const res = onCreateNode({
      name: name.trim(),
      group_name: groupName.trim() || "Default",
      tags,
      sort_order: parsedSort,
      traffic_limit_bytes: limitBytes,
      traffic_reset_day: parsedResetDay,
      traffic_count_mode: countMode,
    });

    setFormError(null);
    setCreated(res);
  };

  const handleSimulateHandshake = () => {
    if (!created || simulating || isOnlineNow) return;
    setSimulating(true);
    simTimerRef.current = window.setTimeout(() => {
      onSimulateOnline(created.node.id);
      setSimulating(false);
      simTimerRef.current = null;
    }, 520);
  };

  return (
    <dialog
      ref={dialogRef}
      {...DIALOG_LIGHT_DISMISS_ATTRS}
      aria-labelledby={titleId}
      onPointerDown={(e) => {
        const d = dialogRef.current;
        if (!d) return;
        pointerDownOutsideRef.current =
          e.target === d && isOutsideDialogBounds(e, d);
      }}
      onPointerUp={(e) => {
        const d = dialogRef.current;
        const startedOutside = pointerDownOutsideRef.current;
        pointerDownOutsideRef.current = false;
        if (!d || !startedOutside) return;
        if (e.target === d && isOutsideDialogBounds(e, d)) {
          resetAndClose();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        resetAndClose();
      }}
      onClose={() => {
        if (!syncingCloseRef.current && open) {
          resetAndClose();
        }
      }}
      className="m-auto w-[min(44rem,calc(100vw-2rem))] max-h-[92dvh] overflow-hidden overscroll-contain rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xl"
    >
      {/* Layout strictly inside single inner wrapper */}
      <div className="flex flex-col max-h-[92dvh] w-full min-h-0 bg-[var(--bg-surface)] text-[var(--text-primary)]">
        {/* Header & 2-Step Indicator */}
        <div className="shrink-0 px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center border shrink-0"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  borderColor: "var(--accent-ring)",
                }}
              >
                <Server
                  className="w-4 h-4 text-[var(--accent-primary)]"
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0">
                <h2
                  id={titleId}
                  className="text-sm font-bold text-[var(--text-primary)] truncate"
                >
                  {created
                    ? `部署探针 · ${created.node.name}`
                    : "部署新 Linux 监控探针"}
                </h2>
                <p className="text-[11px] text-[var(--text-secondary)]">
                  纯静态 Rust musl 二进制 (3–6 MB RSS) · 出站 WSS 443 · 零入站端口暴露
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={resetAndClose}
              aria-label="关闭部署向导"
              className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          {/* 2-Step Wizard Bar */}
          <ol className="grid grid-cols-2 gap-2 text-[11px]">
            <li
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${
                !created
                  ? "font-semibold text-[var(--accent-primary)]"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              }`}
              style={
                !created
                  ? {
                      backgroundColor: "var(--accent-soft)",
                      borderColor: "var(--accent-ring)",
                    }
                  : undefined
              }
            >
              <span className="w-4 h-4 rounded-full bg-current/15 flex items-center justify-center font-mono-num text-[10px]">
                {created ? "✓" : "1"}
              </span>
              <span>第 1 步：节点元数据与流量配额</span>
            </li>

            <li
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border ${
                created
                  ? isOnlineNow
                    ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 font-semibold"
                    : "font-semibold text-[var(--accent-primary)]"
                  : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)]"
              }`}
              style={
                created && !isOnlineNow
                  ? {
                      backgroundColor: "var(--accent-soft)",
                      borderColor: "var(--accent-ring)",
                    }
                  : undefined
              }
            >
              <span className="w-4 h-4 rounded-full bg-current/15 flex items-center justify-center font-mono-num text-[10px]">
                {isOnlineNow ? "✓" : "2"}
              </span>
              <span>第 2 步：安全参数与一键上线</span>
            </li>
          </ol>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 text-xs">
          {!created ? (
            <form noValidate onSubmit={handleSubmitStep1} className="space-y-4">
              {formError && (
                <div
                  role="alert"
                  className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-rose-700 dark:text-rose-300"
                >
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label
                    htmlFor={nameId}
                    className="block font-medium text-[var(--text-secondary)] mb-1"
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
                      if (formError) setFormError(null);
                    }}
                    placeholder="例如：sgp-edge-02 或 hk-bgp-02"
                    className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                  />
                </div>

                <div>
                  <label
                    htmlFor={groupId}
                    className="block font-medium text-[var(--text-secondary)] mb-1"
                  >
                    所属分组
                  </label>
                  <input
                    id={groupId}
                    type="text"
                    list={groupDatalistId}
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="选择或输入新分组"
                    className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]"
                  />
                  <datalist id={groupDatalistId}>
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
                    className="block font-medium text-[var(--text-secondary)] mb-1"
                  >
                    标签（逗号分隔）
                  </label>
                  <input
                    id={tagsId}
                    type="text"
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="例如：Prod, BGP, NVMe"
                    className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]"
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {QUICK_TAG_SUGGESTIONS.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleAppendTag(tag)}
                        className="px-2 py-0.5 rounded-md text-[10px] font-mono-num border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      >
                        + {tag}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor={sortId}
                    className="block font-medium text-[var(--text-secondary)] mb-1"
                  >
                    列表排序序号（越小越靠前）
                  </label>
                  <input
                    id={sortId}
                    type="number"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                  />
                </div>
              </div>

              {/* Monthly Traffic Ledger Config */}
              <div className="pt-3 border-t border-[var(--border-subtle)] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--text-primary)]">
                    月度流量账本配置
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {[
                      { label: "不限", val: "" },
                      { label: "500 GB", val: "500" },
                      { label: "2 TB", val: "2048" },
                      { label: "10 TB", val: "10240" },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setLimitGb(preset.val)}
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
                      htmlFor={limitId}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      月流量上限 (GB，留空不限)
                    </label>
                    <input
                      id={limitId}
                      type="number"
                      min="0"
                      step="any"
                      value={limitGb}
                      onChange={(e) => setLimitGb(e.target.value)}
                      placeholder="留空不限"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={resetDayId}
                      className="block text-[var(--text-secondary)] mb-1"
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
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={countModeId}
                      className="block text-[var(--text-secondary)] mb-1"
                    >
                      计费口径
                    </label>
                    <select
                      id={countModeId}
                      value={countMode}
                      onChange={(e) =>
                        setCountMode(e.target.value as TrafficCountMode)
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

              <div className="pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
                <span className="text-[11px] text-[var(--text-muted)]">
                  注册后将生成一次性 `uob_live_...` 密钥，后端仅保存 SHA-256 哈希。
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={resetAndClose}
                    className="px-4 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm"
                    style={{ backgroundColor: "var(--accent-solid)" }}
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>生成一键部署命令</span>
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              {/* Step 2 Status Card: Online Success OR Waiting + One-Click Simulation */}
              {isOnlineNow && liveNode ? (
                <div className="rounded-2xl border border-emerald-500/45 bg-emerald-500/12 p-4 space-y-3 transition-all">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
                        <Sparkles
                          className="w-5 h-5 text-emerald-600 dark:text-emerald-300 animate-status-pulse"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-sm font-bold text-emerald-800 dark:text-emerald-200">
                          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                          <span>探针已成功上线并接入实时流！</span>
                        </div>
                        <div className="font-mono-num text-[11px] text-emerald-700 dark:text-emerald-300">
                          {liveNode.hostname || liveNode.name} ·{" "}
                          {liveNode.os || "Debian 12"} ·{" "}
                          {liveNode.arch || "x86_64"} ·{" "}
                          {liveNode.cpu_cores ?? 4} vCPU · agent v
                          {liveNode.agent_version || "2.4.1"}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={!matchedNode}
                      onClick={() => {
                        if (!matchedNode) return;
                        resetAndClose();
                        onInspectNode(matchedNode);
                      }}
                      className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold shadow-sm"
                    >
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>立即透视节点</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-sky-500/35 bg-sky-500/10 p-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="relative mt-0.5 shrink-0">
                        <span className="absolute inset-0 rounded-full bg-sky-400/50 animate-status-ring" />
                        <Loader2
                          className="relative w-4 h-4 text-sky-600 dark:text-sky-400 animate-spin"
                          aria-hidden="true"
                        />
                      </div>
                      <div>
                        <div className="font-semibold text-sky-900 dark:text-sky-200">
                          正在等待目标节点发起 outbound WSS 443 首帧握手...
                        </div>
                        <p className="text-[11px] text-sky-800/85 dark:text-sky-300/85 mt-0.5">
                          在目标 Linux 服务器执行下方命令后，控制面将在 1 秒内自动感知上线。在原型中可直接点击右侧按钮模拟执行。
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={simulating}
                      onClick={handleSimulateHandshake}
                      className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl font-semibold text-white shadow-md transition-all disabled:opacity-60"
                      style={{ backgroundColor: "var(--accent-solid)" }}
                    >
                      {simulating ? (
                        <Loader2
                          className="w-4 h-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Zap className="w-4 h-4" aria-hidden="true" />
                      )}
                      <span>
                        {simulating
                          ? "正在模拟 TLS 握手..."
                          : "⚡ 模拟目标服务器执行命令并上线"}
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* Security & Privacy Flags */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                    <Lock
                      className="w-3.5 h-3.5 text-[var(--accent-primary)]"
                      aria-hidden="true"
                    />
                    <span>安全边界与隐私开关（实时拼接安装参数）</span>
                  </span>
                  <span className="text-[11px] font-mono-num text-[var(--text-muted)]">
                    systemd: ProtectSystem=strict · MemoryMax=24M
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <label
                    htmlFor={commOnlyId}
                    className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${
                      cmdlineCommOnly
                        ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)]"
                    }`}
                  >
                    <input
                      id={commOnlyId}
                      type="checkbox"
                      checked={cmdlineCommOnly}
                      onChange={(e) => setCmdlineCommOnly(e.target.checked)}
                      className="mt-0.5 rounded accent-emerald-600"
                    />
                    <div>
                      <div className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                        <span>仅记录程序名</span>
                        <code className="text-[10px] font-mono-num px-1.5 py-0.2 rounded bg-slate-900/80 text-fuchsia-300">
                          --cmdline comm_only
                        </code>
                      </div>
                      <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                        隐藏进程启动参数，防止命令行中的 Token 或数据库密码泄露到控制面。
                      </p>
                    </div>
                  </label>

                  <label
                    htmlFor={disableProcId}
                    className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${
                      disableProc
                        ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)]"
                    }`}
                  >
                    <input
                      id={disableProcId}
                      type="checkbox"
                      checked={disableProc}
                      onChange={(e) => setDisableProc(e.target.checked)}
                      className="mt-0.5 rounded accent-emerald-600"
                    />
                    <div>
                      <div className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                        <span>禁用进程列表上报</span>
                        <code className="text-[10px] font-mono-num px-1.5 py-0.2 rounded bg-slate-900/80 text-fuchsia-300">
                          --disable-proc
                        </code>
                      </div>
                      <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                        写入 `/etc/uniob/agent.toml` 彻底锁死 `/proc` 采集，合规环境零泄露。
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Syntax-Highlighted One-Line Install Command */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                    <Terminal
                      className="w-3.5 h-3.5 text-[var(--accent-primary)]"
                      aria-hidden="true"
                    />
                    <span>Linux 一键安全安装命令</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono-num text-[var(--text-muted)]">
                      ID: {created.node.id}
                    </span>
                  </div>
                </div>

                <div className="rounded-2xl bg-[#070b14] border border-slate-800 overflow-hidden shadow-inner">
                  <div className="flex items-center justify-between px-3.5 py-2 border-b border-slate-800/90 bg-slate-900/70">
                    <div className="flex items-center gap-1.5 text-[11px] font-mono-num text-slate-400">
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                      <span className="ml-1.5">bash · root / sudo</span>
                    </div>
                    <WizardCopyButton
                      text={finalInstallCmd}
                      label="复制安装命令"
                      ariaLabel="复制 Linux 一键安装命令"
                    />
                  </div>
                  <pre className="p-4 font-mono-num text-[12px] leading-relaxed break-all whitespace-pre-wrap select-all">
                    <code>{highlightedCmdNodes}</code>
                  </pre>
                </div>

                {/* One-time Token Strip */}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <KeyRound
                      className="w-3.5 h-3.5 text-amber-500 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-[11px] text-[var(--text-secondary)] shrink-0">
                      一次性连接密钥：
                    </span>
                    <code className="font-mono-num text-[11px] text-[var(--text-primary)] truncate">
                      {created.agent_token}
                    </code>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <ShieldCheck className="w-3 h-3 text-emerald-500" aria-hidden="true" />
                    仅展示一次，丢失可在台账轮换
                  </span>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="px-4 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium hover:bg-[var(--bg-card-hover)]"
                >
                  {isOnlineNow ? "完成并关闭" : "后台保持等待"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
