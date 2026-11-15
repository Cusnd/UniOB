import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  Download,
  FileJson,
  Loader2,
  Radio,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  Wand2,
  Zap,
} from "lucide-react";
import type {
  HubMode,
  HubStatusResponse,
  NotificationChannel,
  PrototypeNode,
  WatchdogConfig,
  WatchdogHealthStatus,
} from "../types";
import { formatDurationZh, formatRelativeTime } from "../utils/format";

export interface HubMigrationStudioProps {
  nodes: PrototypeNode[];
  hubStatus: HubStatusResponse;
  watchdogConfig: WatchdogConfig;
  channels: NotificationChannel[];
  onSwitchHubModePreview: (mode: HubMode) => void;
  onSaveWatchdog: (cfg: WatchdogConfig) => void;
  onNotify: (
    tone: "success" | "info" | "warning" | "danger",
    title: string,
    description?: string,
  ) => void;
}

type MigrationTab = "outbound" | "inbound";
type OutboundMethod = "existing" | "install";
type CutoverPhase = "idle" | "handshake" | "syncing" | "cutover" | "done";

const WATCHDOG_TIMEOUT_PRESETS = [
  { sec: 600, label: "10 分钟" },
  { sec: 900, label: "15 分钟（推荐）" },
  { sec: 1800, label: "30 分钟" },
] as const;

function randomHex(byteLen: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < byteLen * 2; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function generateMigrationCode(): string {
  return `uobm1_${randomHex(18)}`;
}

function getWatchdogBadge(status: WatchdogHealthStatus): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "healthy":
      return {
        label: "守护健康",
        cls: "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
      };
    case "waiting":
      return {
        label: "等待首帧心跳",
        cls: "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
      };
    case "stale":
      return {
        label: "失联告警中",
        cls: "border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300",
      };
    case "disabled":
    default:
      return {
        label: "未启用",
        cls: "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
      };
  }
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

function StudioCopyButton({
  text,
  label,
  ariaLabel,
}: {
  text: string;
  label: string;
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);
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
    setStatusMsg(ok ? `${label}已复制` : "复制失败，请手动复制");
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setStatusMsg("");
      timerRef.current = null;
    }, 2000);
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

export function HubMigrationStudio({
  nodes,
  hubStatus,
  watchdogConfig,
  channels,
  onSwitchHubModePreview,
  onSaveWatchdog,
  onNotify,
}: HubMigrationStudioProps): React.JSX.Element {
  const baseId = useId();
  const outboundTabId = `${baseId}-tab-outbound`;
  const inboundTabId = `${baseId}-tab-inbound`;
  const outboundPanelId = `${baseId}-panel-outbound`;
  const inboundPanelId = `${baseId}-panel-inbound`;
  const codeInputId = `${baseId}-code-input`;
  const canaryCheckId = `${baseId}-canary-check`;
  const canarySelectId = `${baseId}-canary-select`;
  const targetUrlId = `${baseId}-target-url`;
  const wdEnabledId = `${baseId}-wd-enabled`;
  const wdLabelId = `${baseId}-wd-label`;
  const wdCooldownId = `${baseId}-wd-cooldown`;
  const wdSecretId = `${baseId}-wd-secret`;
  const backupFileId = `${baseId}-backup-file`;

  const outboundTabRef = useRef<HTMLButtonElement | null>(null);
  const inboundTabRef = useRef<HTMLButtonElement | null>(null);

  const [activeTab, setActiveTab] = useState<MigrationTab>("outbound");
  const [outboundMethod, setOutboundMethod] =
    useState<OutboundMethod>("existing");

  // Outbound migration form state
  const [migrationCode, setMigrationCode] = useState(
    "uobm1_7f4a92c18e3b05d19a4c6e2f801b3d7a",
  );
  const [codeError, setCodeError] = useState<string | null>(null);
  const [targetOriginInput, setTargetOriginInput] = useState(
    "https://hub-sgp.uniob.internal",
  );
  const [installCmdPreview, setInstallCmdPreview] = useState<string | null>(
    null,
  );
  const [useCanary, setUseCanary] = useState(true);
  const onlineNodes = useMemo(() => nodes.filter((n) => n.online), [nodes]);
  const orderedNodes = useMemo(
    () => [...onlineNodes, ...nodes.filter((n) => !n.online)],
    [nodes, onlineNodes],
  );
  const [canaryNodeId, setCanaryNodeId] = useState(
    () => orderedNodes[0]?.id ?? "",
  );

  // 3-Stage live cutover simulation state
  const [phase, setPhase] = useState<CutoverPhase>("idle");
  const [progressPct, setProgressPct] = useState(0);
  const [dispatchedCount, setDispatchedCount] = useState(0);
  const [switchedCount, setSwitchedCount] = useState(0);
  const [lastMigratedMode, setLastMigratedMode] = useState<"canary" | "full">(
    "canary",
  );
  const cutoverTimerRef = useRef<number | null>(null);

  // Inbound migration state
  const [receiveCode, setReceiveCode] = useState<string | null>(null);
  const [inboundArrived, setInboundArrived] = useState(0);

  // Watchdog draft form synced from props
  const [wdDraft, setWdDraft] = useState<WatchdogConfig>(watchdogConfig);
  useEffect(() => {
    setWdDraft(watchdogConfig);
  }, [watchdogConfig]);

  // Backup restore feedback
  const [importSummary, setImportSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!canaryNodeId && orderedNodes.length > 0) {
      setCanaryNodeId(orderedNodes[0].id);
    }
  }, [canaryNodeId, orderedNodes]);

  useEffect(() => {
    return () => {
      if (cutoverTimerRef.current !== null) {
        window.clearInterval(cutoverTimerRef.current);
      }
    };
  }, []);

  const stopCutoverTimer = () => {
    if (cutoverTimerRef.current !== null) {
      window.clearInterval(cutoverTimerRef.current);
      cutoverTimerRef.current = null;
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      e.key !== "ArrowLeft" &&
      e.key !== "ArrowRight" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    const nextTab: MigrationTab =
      e.key === "Home"
        ? "outbound"
        : e.key === "End"
          ? "inbound"
          : activeTab === "outbound"
            ? "inbound"
            : "outbound";
    setActiveTab(nextTab);
    const targetRef = nextTab === "outbound" ? outboundTabRef : inboundTabRef;
    targetRef.current?.focus();
  };

  const startCutoverSimulation = (forceFullFleet = false) => {
    const isCanaryRun = !forceFullFleet && outboundMethod === "existing" && useCanary;

    if (outboundMethod === "existing") {
      const trimmed = migrationCode.trim();
      if (!trimmed.startsWith("uobm1_") || trimmed.length < 16) {
        setCodeError("迁移口令必须以 uobm1_ 开头且长度有效，可点击右侧按钮填入演示口令");
        return;
      }
    } else if (!targetOriginInput.trim()) {
      setCodeError("请填写目标自建面板域名或 IP 地址");
      return;
    }

    if (isCanaryRun && !canaryNodeId) {
      setCodeError("请选择 1 台用于金丝雀试路的节点");
      return;
    }

    setCodeError(null);
    stopCutoverTimer();

    const targetCount = isCanaryRun ? 1 : Math.max(1, onlineNodes.length);
    setLastMigratedMode(isCanaryRun ? "canary" : "full");
    setDispatchedCount(targetCount);
    setSwitchedCount(0);
    setProgressPct(10);
    setPhase("handshake");

    let tick = 0;
    cutoverTimerRef.current = window.setInterval(() => {
      tick += 1;
      if (tick <= 3) {
        setPhase("handshake");
        setProgressPct(12 + tick * 7);
      } else if (tick <= 6) {
        setPhase("syncing");
        setProgressPct(35 + (tick - 3) * 10);
      } else if (tick <= 10) {
        setPhase("cutover");
        const frac = (tick - 6) / 4;
        setSwitchedCount(Math.max(1, Math.round(targetCount * frac)));
        setProgressPct(Math.round(66 + frac * 32));
      } else {
        stopCutoverTimer();
        setPhase("done");
        setSwitchedCount(targetCount);
        setProgressPct(100);
        onNotify(
          "success",
          isCanaryRun
            ? "金丝雀试路节点切流完成"
            : `全量 ${targetCount} 台在线节点热迁移完成`,
          isCanaryRun
            ? "首台探针已在新面板稳定心跳，无丢帧与断连，可继续全量切换"
            : "全部节点账本、规则与通道已对齐，60s 自动回滚护栏已就绪",
        );
      }
    }, 280);
  };

  const handleGenerateInstallTicket = () => {
    const token = randomHex(12);
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://edge.uniob.demo";
    const cmd = `curl -fsSL ${origin}/install-hub.sh | sudo bash -s -- --sync-from ${origin} --ticket uobm1_${token} --watchdog-url ${origin}/api/watchdog/ping`;
    setInstallCmdPreview(cmd);
    onNotify(
      "info",
      "已生成自建 uniob-hub 一键迁移安装命令",
      "含自动状态 Bundle 拉取与 Cloudflare 看门狗凭据注入",
    );
  };

  const handleGenerateReceiveTicket = () => {
    const code = generateMigrationCode();
    setReceiveCode(code);
    setInboundArrived(0);
    onNotify("info", "已签发 30 分钟有效接收口令", code);
  };

  const handleExportJsonBackup = () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const bundle = {
      version: 2,
      exported_at: nowSec,
      hub_mode: hubStatus.mode,
      nodes: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        group_name: n.group_name,
        tags: n.tags,
        sort_order: n.sort_order,
        proc_enabled: n.proc_enabled,
        traffic: n.traffic,
      })),
      notification_channels: channels,
      watchdog: wdDraft,
    };

    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const fname = `uniob-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    onNotify(
      "success",
      `已导出全量备份 ${fname}`,
      `包含 ${nodes.length} 台节点配置、流量账本与 ${channels.length} 个通知渠道`,
    );
  };

  const handleImportJsonBackup = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        nodes?: unknown[];
        notification_channels?: unknown[];
      };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("无效的 JSON 结构");
      }
      const nCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
      const cCount = Array.isArray(parsed.notification_channels)
        ? parsed.notification_channels.length
        : 0;
      const msg = `已通过校验：${file.name}（含 ${nCount} 台节点、${cCount} 个通知渠道）`;
      setImportSummary(msg);
      onNotify("success", "备份快照校验成功（演练模式）", msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "解析备份文件失败";
      onNotify("danger", "备份文件格式校验失败", msg);
    }
  };

  const handleSaveWatchdogSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextCfg: WatchdogConfig = {
      ...wdDraft,
      secret:
        wdDraft.secret.trim() ||
        (wdDraft.enabled ? randomHex(24) : ""),
      timeout_sec: Math.max(60, Math.round(wdDraft.timeout_sec || 900)),
      cooldown_sec: Math.max(60, Math.round(wdDraft.cooldown_sec || 1800)),
      hub_label: wdDraft.hub_label.trim() || "自建备用面板",
    };
    setWdDraft(nextCfg);
    onSaveWatchdog(nextCfg);
  };

  const isCloudflare = hubStatus.mode === "cloudflare-worker";
  const wdBadge = getWatchdogBadge(hubStatus.watchdog.status);
  const watchdogPingUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/watchdog/ping`
      : "https://edge.uniob.demo/api/watchdog/ping";
  const manualFlags = `--watchdog-url ${watchdogPingUrl} --watchdog-secret ${wdDraft.secret || "<未生成密钥>"}`;

  const previewJsonSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          version: 2,
          mode: hubStatus.mode,
          nodes_count: nodes.length,
          channels_count: channels.length,
          traffic_ledgers_count: nodes.length,
          watchdog_enabled: wdDraft.enabled,
          sample_node: nodes[0]
            ? {
                id: nodes[0].id,
                name: nodes[0].name,
                counted_bytes: nodes[0].traffic.counted_bytes,
                cycle_key: nodes[0].traffic.cycle_key,
              }
            : null,
        },
        null,
        2,
      ),
    [hubStatus.mode, nodes, channels.length, wdDraft.enabled],
  );

  return (
    <section className="space-y-5">
      {/* Page Title & Live Engine Status */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-[var(--text-primary)]">
              双模控制面架构与无感热迁移工作台
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono-num font-medium bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              {hubStatus.version}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            在 Cloudflare Workers SCCH（$0/月 边缘休眠）与自建 Rust uniob-hub（SQLite WAL）之间无损迁移全部节点、账本与告警路由。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num">
            <Radio
              className="w-3.5 h-3.5 text-emerald-500 animate-status-pulse"
              aria-hidden="true"
            />
            <span>
              在线探针 {hubStatus.connected_agents} / {hubStatus.total_nodes}
            </span>
          </span>
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-medium ${wdBadge.cls}`}
          >
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            <span>看门狗：{wdBadge.label}</span>
          </span>
        </div>
      </div>

      {/* 1. Dual-Mode Architecture Comparison Topology Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Card B: Cloudflare Workers SCCH */}
        <article
          className={`surface-card rounded-2xl p-5 space-y-4 transition-all ${
            isCloudflare ? "ring-1" : "opacity-90"
          }`}
          style={
            isCloudflare
              ? {
                  borderColor: "var(--accent-ring)",
                  boxShadow: "0 0 0 1px var(--accent-ring)",
                }
              : undefined
          }
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-500/35 flex items-center justify-center shrink-0">
                <Cloud
                  className="w-5 h-5 text-sky-600 dark:text-sky-400"
                  aria-hidden="true"
                />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-bold text-[var(--text-primary)]">
                    方向 B · Cloudflare Workers SCCH
                  </h2>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono-num font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    $0.00 / 月 边缘休眠
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Co-Located 单例 FleetHubDO + Ring-Slab 分块环存 + 5m UTC Cohort 批
                </p>
              </div>
            </div>

            {isCloudflare ? (
              <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/35">
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                运行中
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSwitchHubModePreview("cloudflare-worker")}
                className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] transition-colors"
              >
                切换预览此模式
              </button>
            )}
          </div>

          {/* Mini Topology Flow */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
            <span className="px-2 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
              uniob-agent v2
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden="true" />
            <span className="px-2 py-1 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-700 dark:text-sky-300">
              CF Edge Auth (0 DO唤醒)
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden="true" />
            <span className="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
              FleetHubDO (1×128MB)
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center font-mono-num">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 p-2">
              <div className="text-[10px] text-[var(--text-muted)]">D1 写降幅</div>
              <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                -93.4%
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 p-2">
              <div className="text-[10px] text-[var(--text-muted)]">Free 承载力</div>
              <div className="text-xs font-bold text-[var(--text-primary)] mt-0.5">
                ≤ 112 台 Idle
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 p-2">
              <div className="text-[10px] text-[var(--text-muted)]">水位滞回冲刷</div>
              <div className="text-xs font-bold text-sky-600 dark:text-sky-400 mt-0.5">
                0s 危急告警
              </div>
            </div>
          </div>
        </article>

        {/* Card A: Self-hosted uniob-hub */}
        <article
          className={`surface-card rounded-2xl p-5 space-y-4 transition-all ${
            !isCloudflare ? "ring-1" : "opacity-90"
          }`}
          style={
            !isCloudflare
              ? {
                  borderColor: "var(--accent-ring)",
                  boxShadow: "0 0 0 1px var(--accent-ring)",
                }
              : undefined
          }
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/35 flex items-center justify-center shrink-0">
                <Server
                  className="w-5 h-5 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-bold text-[var(--text-primary)]">
                    方向 A · 自建 uniob-hub 节点中枢
                  </h2>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono-num font-semibold bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30">
                    Rust axum + SQLite WAL
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  独立 VPS 零云端 DO 配额限制 + 本机 /proc 自采集 + CF 看门狗守卫
                </p>
              </div>
            </div>

            {!isCloudflare ? (
              <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/35">
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                运行中
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSwitchHubModePreview("self-hosted-hub")}
                className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] transition-colors"
              >
                切换预览此模式
              </button>
            )}
          </div>

          {/* Mini Topology Flow */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
            <span className="px-2 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
              uniob-agent v2
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden="true" />
            <span className="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
              uniob-hub (SQLite WAL)
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden="true" />
            <span className="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300">
              300s Watchdog Ping
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center font-mono-num">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 p-2">
              <div className="text-[10px] text-[var(--text-muted)]">DO 计算账单</div>
              <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                0 GB-s ($0)
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 p-2">
              <div className="text-[10px] text-[var(--text-muted)]">大盘并发规模</div>
              <div className="text-xs font-bold text-[var(--text-primary)] mt-0.5">
                24×7 无上限
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 p-2">
              <div className="text-[10px] text-[var(--text-muted)]">看门狗 Cron</div>
              <div className="text-xs font-bold text-amber-600 dark:text-amber-400 mt-0.5">
                每 5 分钟巡检
              </div>
            </div>
          </div>
        </article>
      </div>

      {/* 2. Two-Step Zero-Downtime Canary Live Migration Studio */}
      <div className="surface-card rounded-2xl overflow-hidden">
        <div className="px-5 pt-5 pb-0 border-b border-[var(--border-subtle)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ArrowLeftRight
                className="w-4 h-4 text-[var(--accent-primary)]"
                aria-hidden="true"
              />
              <h2 className="text-sm font-bold text-[var(--text-primary)]">
                无感金丝雀热迁移演练台（2-Phase Canary Cutover）
              </h2>
            </div>
            <span className="text-[11px] text-[var(--text-muted)]">
              基于 HMAC-SHA256 签名迁移指令 · 异常 60s 自动切回
            </span>
          </div>

          <div
            role="tablist"
            aria-label="迁移方向切换"
            className="flex gap-6"
          >
            <button
              ref={outboundTabRef}
              id={outboundTabId}
              type="button"
              role="tab"
              aria-selected={activeTab === "outbound"}
              aria-controls={outboundPanelId}
              tabIndex={activeTab === "outbound" ? 0 : -1}
              onClick={() => setActiveTab("outbound")}
              onKeyDown={handleTabKeyDown}
              className={`pb-3 text-xs font-medium transition-colors ${
                activeTab === "outbound"
                  ? "text-[var(--accent-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              迁往其他面板（Outbound）
            </button>
            <button
              ref={inboundTabRef}
              id={inboundTabId}
              type="button"
              role="tab"
              aria-selected={activeTab === "inbound"}
              aria-controls={inboundPanelId}
              tabIndex={activeTab === "inbound" ? 0 : -1}
              onClick={() => setActiveTab("inbound")}
              onKeyDown={handleTabKeyDown}
              className={`pb-3 text-xs font-medium transition-colors ${
                activeTab === "inbound"
                  ? "text-[var(--accent-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              迁入到此面板（Inbound）
            </button>
          </div>
        </div>

        <div className="p-5 text-xs">
          {/* TabPanel 1: Outbound */}
          <div
            id={outboundPanelId}
            role="tabpanel"
            aria-labelledby={outboundTabId}
            hidden={activeTab !== "outbound"}
            className="space-y-4"
          >
            <fieldset className="space-y-2">
              <legend className="font-semibold text-[var(--text-primary)]">
                第 1 步：选择目标面板准备方式
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label
                  className={`flex items-start gap-2.5 rounded-xl border p-3.5 cursor-pointer transition-colors ${
                    outboundMethod === "existing"
                      ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)]"
                  }`}
                >
                  <input
                    type="radio"
                    name={`${baseId}-outbound-method`}
                    checked={outboundMethod === "existing"}
                    onChange={() => {
                      setOutboundMethod("existing");
                      setCodeError(null);
                    }}
                    className="mt-0.5 accent-emerald-600"
                  />
                  <div>
                    <div className="font-semibold text-[var(--text-primary)]">
                      已有目标面板（粘贴 `uobm1_...` 迁移口令）
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                      目标 Cloudflare 或自建面板已启动，支持单节点金丝雀先导试路。
                    </p>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-2.5 rounded-xl border p-3.5 cursor-pointer transition-colors ${
                    outboundMethod === "install"
                      ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-card-hover)]"
                  }`}
                >
                  <input
                    type="radio"
                    name={`${baseId}-outbound-method`}
                    checked={outboundMethod === "install"}
                    onChange={() => {
                      setOutboundMethod("install");
                      setCodeError(null);
                    }}
                    className="mt-0.5 accent-emerald-600"
                  />
                  <div>
                    <div className="font-semibold text-[var(--text-primary)]">
                      全新安装一台自建 uniob-hub 并接管
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                      生成含一次性同步票据与看门狗参数的一键部署命令。
                    </p>
                  </div>
                </label>
              </div>
            </fieldset>

            {outboundMethod === "existing" ? (
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4 space-y-4">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <label
                      htmlFor={codeInputId}
                      className="font-medium text-[var(--text-primary)]"
                    >
                      目标面板迁移口令 (`uobm1_...`)
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setMigrationCode(generateMigrationCode());
                        setCodeError(null);
                      }}
                      className="text-[11px] font-medium text-[var(--accent-primary)] hover:underline"
                    >
                      随机生成演示口令
                    </button>
                  </div>
                  <input
                    id={codeInputId}
                    type="text"
                    value={migrationCode}
                    onChange={(e) => {
                      setMigrationCode(e.target.value);
                      if (codeError) setCodeError(null);
                    }}
                    spellCheck={false}
                    placeholder="uobm1_..."
                    className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-xs text-[var(--text-primary)]"
                  />
                  {codeError && (
                    <p className="mt-1.5 text-[11px] text-rose-600 dark:text-rose-400 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{codeError}</span>
                    </p>
                  )}
                </div>

                {/* Canary Trial Toggle */}
                <div className="space-y-2.5 pt-2 border-t border-[var(--border-subtle)]">
                  <label
                    htmlFor={canaryCheckId}
                    className="inline-flex items-center gap-2 cursor-pointer font-medium text-[var(--text-primary)]"
                  >
                    <input
                      id={canaryCheckId}
                      type="checkbox"
                      checked={useCanary}
                      onChange={(e) => setUseCanary(e.target.checked)}
                      className="rounded accent-emerald-600"
                    />
                    <span>
                      启用金丝雀试路（先切流 1 台节点验证 WSS 握手与心跳，再全量放行）
                    </span>
                  </label>

                  {useCanary && (
                    <div className="pl-6 flex flex-col sm:flex-row sm:items-center gap-2">
                      <label
                        htmlFor={canarySelectId}
                        className="text-[11px] text-[var(--text-secondary)] shrink-0"
                      >
                        金丝雀试路节点：
                      </label>
                      <select
                        id={canarySelectId}
                        value={canaryNodeId}
                        onChange={(e) => setCanaryNodeId(e.target.value)}
                        className="w-full sm:max-w-xs px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] text-xs"
                      >
                        {orderedNodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.region_flag} {n.name}（{n.online ? "在线" : "离线"}）
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[var(--text-primary)]">
                      生成自建 uniob-hub 一键安装与同步票据
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                      部署时自动拉取当前所有节点哈希、月流量账本、告警规则与管理员密码。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateInstallTicket}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent-primary)] font-semibold"
                  >
                    <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{installCmdPreview ? "刷新安装命令" : "生成安装命令"}</span>
                  </button>
                </div>

                {installCmdPreview && (
                  <div className="rounded-xl bg-[#070b14] border border-slate-800 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono-num text-slate-400">
                        在新 VPS 终端执行（30 分钟有效）
                      </span>
                      <StudioCopyButton
                        text={installCmdPreview}
                        label="复制命令"
                        ariaLabel="复制自建面板安装命令"
                      />
                    </div>
                    <pre className="font-mono-num text-[11px] text-emerald-300 break-all whitespace-pre-wrap">
                      {installCmdPreview}
                    </pre>
                  </div>
                )}

                <div>
                  <label
                    htmlFor={targetUrlId}
                    className="block font-medium text-[var(--text-primary)] mb-1"
                  >
                    新自建面板访问地址（部署完成后点击下方启动切流）
                  </label>
                  <input
                    id={targetUrlId}
                    type="url"
                    value={targetOriginInput}
                    onChange={(e) => setTargetOriginInput(e.target.value)}
                    placeholder="https://hub.example.com"
                    className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-xs text-[var(--text-primary)]"
                  />
                </div>
              </div>
            )}

            {/* Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] text-[var(--text-muted)]">
                第 2 步：下发切流指令后，探针将持久化 `/var/lib/uniob/endpoint_override.toml`
              </span>
              <button
                type="button"
                disabled={phase !== "idle" && phase !== "done"}
                onClick={() => startCutoverSimulation(false)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm disabled:opacity-60"
                style={{ backgroundColor: "var(--accent-solid)" }}
              >
                {phase !== "idle" && phase !== "done" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>
                  {outboundMethod === "existing" && useCanary
                    ? "启动金丝雀试路演练"
                    : "启动全量无感热迁移演练"}
                </span>
              </button>
            </div>

            {/* Live 3-Phase Cutover Progress Tracker */}
            {phase !== "idle" && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/65 p-4 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                    <Sparkles
                      className="w-4 h-4 text-[var(--accent-primary)]"
                      aria-hidden="true"
                    />
                    <span>
                      实时 3 阶段切流遥测（
                      {lastMigratedMode === "canary" ? "金丝雀试路" : "全量集群"}
                      ）
                    </span>
                  </div>
                  <span className="font-mono-num text-[11px] font-semibold text-[var(--accent-primary)]">
                    {progressPct}%
                  </span>
                </div>

                {/* Progress Bar */}
                <div className="h-2 w-full rounded-full bg-[var(--bg-inset)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${progressPct}%`,
                      backgroundColor: "var(--accent-primary)",
                    }}
                  />
                </div>

                <ol className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <li
                    className={`rounded-xl border p-3 ${
                      phase === "handshake"
                        ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                        : "border-emerald-500/30 bg-emerald-500/10"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                      {phase === "handshake" ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin text-[var(--accent-primary)]"
                          aria-hidden="true"
                        />
                      ) : (
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-emerald-500"
                          aria-hidden="true"
                        />
                      )}
                      <span>1. 目标端 TLS 握手校验</span>
                    </div>
                    <p className="mt-1 text-[11px] font-mono-num text-[var(--text-secondary)]">
                      epoch = 14 · HMAC-SHA256 验证通过
                    </p>
                  </li>

                  <li
                    className={`rounded-xl border p-3 ${
                      phase === "handshake"
                        ? "border-[var(--border-subtle)] bg-[var(--bg-surface)] opacity-70"
                        : phase === "syncing"
                          ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                          : "border-emerald-500/30 bg-emerald-500/10"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                      {phase === "syncing" ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin text-[var(--accent-primary)]"
                          aria-hidden="true"
                        />
                      ) : phase === "cutover" || phase === "done" ? (
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-emerald-500"
                          aria-hidden="true"
                        />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-current opacity-40" />
                      )}
                      <span>2. 全量状态 Bundle 同步</span>
                    </div>
                    <p className="mt-1 text-[11px] font-mono-num text-[var(--text-secondary)]">
                      {nodes.length} 台节点 · {channels.length} 个渠道 · 月流量账本
                    </p>
                  </li>

                  <li
                    className={`rounded-xl border p-3 ${
                      phase === "done"
                        ? "border-emerald-500/40 bg-emerald-500/12"
                        : phase === "cutover"
                          ? "border-sky-500/40 bg-sky-500/12"
                          : "border-[var(--border-subtle)] bg-[var(--bg-surface)] opacity-70"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                      {phase === "cutover" ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin text-sky-500"
                          aria-hidden="true"
                        />
                      ) : phase === "done" ? (
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-emerald-500"
                          aria-hidden="true"
                        />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-current opacity-40" />
                      )}
                      <span>3. 平滑切流与回滚护栏</span>
                    </div>
                    <p className="mt-1 text-[11px] font-mono-num text-[var(--text-secondary)]">
                      已切流 {switchedCount} / {dispatchedCount} 台 · 60s 回滚护栏
                    </p>
                  </li>
                </ol>

                {phase === "done" && lastMigratedMode === "canary" && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)]">
                    <span className="text-[11px] text-emerald-700 dark:text-emerald-300 font-medium">
                      金丝雀节点已在目标面板恢复毫秒级心跳！是否立即将剩余全部节点切流？
                    </span>
                    <button
                      type="button"
                      onClick={() => startCutoverSimulation(true)}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      升级为全量集群切流 ({onlineNodes.length} 台)
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* TabPanel 2: Inbound */}
          <div
            id={inboundPanelId}
            role="tabpanel"
            aria-labelledby={inboundTabId}
            hidden={activeTab !== "inbound"}
            className="space-y-4"
          >
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-[var(--text-primary)]">
                    签发一次性接收口令，从旧面板拉取完整状态 Bundle
                  </div>
                  <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                    自动接收原面板的节点密钥哈希、通知渠道、告警规则与本账期已累计流量。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleGenerateReceiveTicket}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm"
                  style={{ backgroundColor: "var(--accent-solid)" }}
                >
                  <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{receiveCode ? "重新生成口令" : "生成 uobm1_ 接收口令"}</span>
                </button>
              </div>

              {receiveCode && (
                <div className="space-y-3 pt-3 border-t border-[var(--border-subtle)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 py-2.5">
                    <code className="font-mono-num text-xs font-semibold text-[var(--accent-primary)] break-all">
                      {receiveCode}
                    </code>
                    <StudioCopyButton
                      text={receiveCode}
                      label="复制口令"
                      ariaLabel="复制 uobm1 迁移接收口令"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/35 bg-sky-500/10 px-3.5 py-2.5 text-sky-900 dark:text-sky-200">
                    <div className="flex items-center gap-2 font-mono-num">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" aria-hidden="true" />
                      <span>
                        等待原面板推送 Bundle · 已确认接入 {inboundArrived} / {nodes.length} 台
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setInboundArrived(nodes.length);
                        onNotify(
                          "success",
                          "模拟迁移接入完成",
                          `已同步 ${nodes.length} 台节点配置与 ${channels.length} 个告警渠道`,
                        );
                      }}
                      className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold"
                    >
                      模拟原面板推送完成
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Cloudflare Cloud Watchdog Configuration Form */}
      <form
        onSubmit={handleSaveWatchdogSubmit}
        className="surface-card rounded-2xl p-5 space-y-4 text-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
              <ShieldAlert
                className="w-4 h-4 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[var(--text-primary)]">
                Cloudflare 云端看门狗掉线守护（5m Cron Dead-Man’s Switch）
              </h2>
              <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                迁移到自建 uniob-hub 后保留 Cloudflare Workers Free 独立值守；若自建服务器断电或失联超过阈值，云端立即推送告警。
              </p>
            </div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium border ${wdBadge.cls}`}
          >
            {wdBadge.label}
            {hubStatus.watchdog.last_ping_ts
              ? ` · ${formatRelativeTime(hubStatus.watchdog.last_ping_ts)}`
              : ""}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-1">
          <label
            htmlFor={wdEnabledId}
            className="inline-flex items-center gap-2 cursor-pointer font-semibold text-[var(--text-primary)]"
          >
            <input
              id={wdEnabledId}
              type="checkbox"
              checked={wdDraft.enabled}
              onChange={(e) =>
                setWdDraft((prev) => ({
                  ...prev,
                  enabled: e.target.checked,
                  secret:
                    prev.secret || (e.target.checked ? randomHex(24) : ""),
                }))
              }
              className="rounded accent-emerald-600"
            />
            <span>启用 Cloudflare 云端掉线看门狗</span>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <fieldset className="space-y-1.5">
            <legend className="font-medium text-[var(--text-secondary)]">
              失联判定超时阈值
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {WATCHDOG_TIMEOUT_PRESETS.map((p) => {
                const active = wdDraft.timeout_sec === p.sec;
                return (
                  <button
                    key={p.sec}
                    type="button"
                    onClick={() =>
                      setWdDraft((prev) => ({ ...prev, timeout_sec: p.sec }))
                    }
                    className={`px-2.5 py-1.5 rounded-xl border text-[11px] font-medium transition-colors ${
                      active
                        ? "text-[var(--accent-primary)] font-semibold"
                        : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)]"
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
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] font-mono-num text-[var(--text-muted)]">
              当前设置：{formatDurationZh(wdDraft.timeout_sec)}
            </div>
          </fieldset>

          <div>
            <label
              htmlFor={wdLabelId}
              className="block font-medium text-[var(--text-secondary)] mb-1"
            >
              自建面板标识名（告警正文展示）
            </label>
            <input
              id={wdLabelId}
              type="text"
              value={wdDraft.hub_label}
              onChange={(e) =>
                setWdDraft((prev) => ({ ...prev, hub_label: e.target.value }))
              }
              placeholder="例如：新加坡主力 uniob-hub"
              className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]"
            />
          </div>

          <div>
            <label
              htmlFor={wdCooldownId}
              className="block font-medium text-[var(--text-secondary)] mb-1"
            >
              失联复发提醒冷却 (秒)
            </label>
            <input
              id={wdCooldownId}
              type="number"
              min="60"
              value={wdDraft.cooldown_sec}
              onChange={(e) =>
                setWdDraft((prev) => ({
                  ...prev,
                  cooldown_sec: Number.parseInt(e.target.value, 10) || 1800,
                }))
              }
              className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)] font-mono-num"
            />
          </div>
        </div>

        {/* Target Channels */}
        <div className="space-y-1.5">
          <span className="block font-medium text-[var(--text-secondary)]">
            看门狗告警通知路由渠道（不勾选默认推往全部已启用渠道）
          </span>
          <div className="flex flex-wrap gap-2">
            {channels.map((ch) => {
              const checked = (wdDraft.channel_ids ?? []).includes(ch.id);
              return (
                <label
                  key={ch.id}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border cursor-pointer text-xs ${
                    checked
                      ? "border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent-primary)] font-medium"
                      : "border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setWdDraft((prev) => {
                        const list = prev.channel_ids ?? [];
                        return {
                          ...prev,
                          channel_ids: list.includes(ch.id)
                            ? list.filter((id) => id !== ch.id)
                            : [...list, ch.id],
                        };
                      })
                    }
                    className="rounded accent-emerald-600"
                  />
                  <span>{ch.name}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--border-subtle)]">
          <details className="flex-1 min-w-[16rem] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3.5 py-2">
            <summary className="cursor-pointer font-medium text-[var(--text-primary)] select-none">
              查看或轮换看门狗 HMAC 通信密钥与 CLI 参数
            </summary>
            <div className="mt-3 space-y-2.5 pt-2.5 border-t border-[var(--border-subtle)]">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={wdSecretId} className="sr-only">
                  看门狗通信密钥
                </label>
                <input
                  id={wdSecretId}
                  type="text"
                  value={wdDraft.secret}
                  onChange={(e) =>
                    setWdDraft((prev) => ({ ...prev, secret: e.target.value }))
                  }
                  className="min-w-0 flex-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[11px]"
                />
                <button
                  type="button"
                  onClick={() =>
                    setWdDraft((prev) => ({ ...prev, secret: randomHex(24) }))
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium hover:bg-[var(--bg-card-hover)]"
                >
                  <Wand2 className="w-3 h-3" aria-hidden="true" />
                  <span>生成随机密钥</span>
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950 p-2.5 text-[11px] font-mono-num text-emerald-300">
                <code className="break-all flex-1">{manualFlags}</code>
                <StudioCopyButton
                  text={manualFlags}
                  label="复制参数"
                  ariaLabel="复制看门狗 CLI 启动参数"
                />
              </div>
            </div>
          </details>

          <button
            type="submit"
            className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm"
            style={{ backgroundColor: "var(--accent-solid)" }}
          >
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            <span>保存看门狗配置</span>
          </button>
        </div>
      </form>

      {/* 4. Native <details> Collapsible Full Backup & Ledger JSON Export/Restore */}
      <details className="surface-card rounded-2xl px-5 py-4 text-xs">
        <summary className="cursor-pointer flex flex-wrap items-center justify-between gap-2 font-semibold text-sm text-[var(--text-primary)] select-none">
          <span className="inline-flex items-center gap-2">
            <FileJson
              className="w-4 h-4 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>全量配置与账本 JSON 备份 / 导出恢复模拟</span>
          </span>
          <span className="text-[11px] font-mono-num font-normal text-[var(--text-muted)]">
            {nodes.length} 节点 · {channels.length} 渠道 · 含当期月流量账本
          </span>
        </summary>

        <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] space-y-4">
          <p className="text-xs text-[var(--text-secondary)]">
            支持一键导出完整的 UniOB v2 JSON 快照（包含节点密钥哈希、分组标签、计费口径、当月流量账本与告警路由），用于离线灾备或跨云环境冷迁移。
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-5 space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleExportJsonBackup}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] font-semibold"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>导出全量 JSON 备份</span>
                </button>

                <label
                  htmlFor={backupFileId}
                  className="inline-flex cursor-pointer items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent-primary)] font-semibold"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>导入备份 JSON 校验</span>
                </label>
                <input
                  id={backupFileId}
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => void handleImportJsonBackup(e)}
                  className="sr-only"
                />
              </div>

              {importSummary && (
                <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/12 px-3 py-2 text-emerald-700 dark:text-emerald-300">
                  {importSummary}
                </div>
              )}
            </div>

            <div className="lg:col-span-7 rounded-xl bg-[#070b14] border border-slate-800 p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono-num text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>ExportBundle v2 结构预览</span>
                </span>
                <StudioCopyButton
                  text={previewJsonSnippet}
                  label="复制预览"
                  ariaLabel="复制 JSON 备份结构预览"
                />
              </div>
              <pre className="font-mono-num text-[11px] text-slate-300 overflow-x-auto leading-relaxed">
                {previewJsonSnippet}
              </pre>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}
