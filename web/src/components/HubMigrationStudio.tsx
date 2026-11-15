import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  Loader2,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import type {
  ExportBundle,
  HorizonNode,
  HubStatusResponse,
  ImportBundleResponse,
  MigrationTicketResponse,
  NotificationChannel,
  SmartMigrateResponse,
  WatchdogConfig,
  WatchdogHealthStatus,
} from "../types";
import { api } from "../api/client";
import {
  formatDurationZh,
  formatRelativeTime,
  formatTimestamp,
} from "../utils/format";

export interface HubMigrationStudioProps {
  nodes: HorizonNode[];
  hubStatus: HubStatusResponse | null;
  onDataChanged: () => Promise<void>;
  onNotify: (
    tone: "success" | "info" | "warning" | "danger",
    title: string,
    description?: string,
  ) => void;
}

type MigrationTab = "outbound" | "inbound";
type OutboundMethod = "existing" | "install";
type CutoverStep = "idle" | "connecting" | "polling" | "done" | "error";

interface PendingBackupImport {
  fileName: string;
  bundle: ExportBundle;
  counts: {
    nodes: number;
    channels: number;
    rules: number;
    traffic_ledgers: number;
  };
  exportedAt: number | null;
}

const WATCHDOG_TIMEOUT_PRESETS = [
  { sec: 600, label: "10 分钟" },
  { sec: 900, label: "15 分钟（推荐）" },
  { sec: 1800, label: "30 分钟" },
] as const;

function generateHexSecret(byteLen = 24): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function shellArg(val: string): string {
  if (/^[A-Za-z0-9_.:/@-]+$/.test(val)) return val;
  return `'${val.replace(/'/g, `'\\''`)}'`;
}

function formatRemainingCountdown(expiresAtSec: number, nowSec: number): string {
  const rem = Math.max(0, expiresAtSec - nowSec);
  if (rem === 0) return "已过期";
  const mins = Math.floor(rem / 60);
  const secs = rem % 60;
  return mins > 0
    ? `${mins} 分 ${String(secs).padStart(2, "0")} 秒`
    : `${secs} 秒`;
}

function getWatchdogBadge(status?: WatchdogHealthStatus): {
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
    setStatusMsg(ok ? `${label}已复制` : "复制失败，请手动复制");
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
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

function summarizeBundleForPreview(bundle: ExportBundle): string {
  const sampleNode =
    Array.isArray(bundle.nodes) &&
    bundle.nodes[0] &&
    typeof bundle.nodes[0] === "object"
      ? (bundle.nodes[0] as Record<string, unknown>)
      : null;

  return JSON.stringify(
    {
      version: bundle.version ?? 2,
      exported_at: bundle.exported_at ?? null,
      nodes_count: Array.isArray(bundle.nodes) ? bundle.nodes.length : 0,
      channels_count: Array.isArray(bundle.notification_channels)
        ? bundle.notification_channels.length
        : 0,
      rules_count: Array.isArray(bundle.alert_rules)
        ? bundle.alert_rules.length
        : 0,
      traffic_ledgers_count: Array.isArray(bundle.traffic_ledgers)
        ? bundle.traffic_ledgers.length
        : 0,
      sample_node: sampleNode
        ? {
            id: sampleNode.id ?? null,
            name: sampleNode.name ?? null,
            group_name: sampleNode.group_name ?? null,
          }
        : null,
    },
    null,
    2,
  );
}

export function HubMigrationStudio({
  nodes,
  hubStatus,
  onDataChanged,
  onNotify,
}: HubMigrationStudioProps) {
  const baseId = useId();
  const outboundTabId = `${baseId}-tab-outbound`;
  const inboundTabId = `${baseId}-tab-inbound`;
  const outboundPanelId = `${baseId}-panel-outbound`;
  const inboundPanelId = `${baseId}-panel-inbound`;
  const codeInputId = `${baseId}-code-input`;
  const canaryCheckId = `${baseId}-canary-check`;
  const canarySelectId = `${baseId}-canary-select`;
  const targetUrlId = `${baseId}-target-url`;
  const insecureWsId = `${baseId}-insecure-ws`;
  const wdEnabledId = `${baseId}-wd-enabled`;
  const wdLabelId = `${baseId}-wd-label`;
  const wdCooldownId = `${baseId}-wd-cooldown`;
  const wdSecretId = `${baseId}-wd-secret`;
  const backupFileId = `${baseId}-backup-file`;

  const outboundTabRef = useRef<HTMLButtonElement | null>(null);
  const inboundTabRef = useRef<HTMLButtonElement | null>(null);

  const [liveStatus, setLiveStatus] = useState<HubStatusResponse | null>(
    hubStatus,
  );
  const [refreshingStatus, setRefreshingStatus] = useState(false);

  useEffect(() => {
    if (hubStatus) {
      setLiveStatus(hubStatus);
    }
  }, [hubStatus]);

  useEffect(() => {
    if (hubStatus !== null) return;
    let cancelled = false;
    void api
      .getHubStatus()
      .then((res) => {
        if (!cancelled) setLiveStatus(res);
      })
      .catch(() => {
        // Parent manages top-level status; ignore transient mount miss
      });
    return () => {
      cancelled = true;
    };
  }, [hubStatus]);

  const effectiveStatus = liveStatus ?? hubStatus;
  const hubMode = effectiveStatus?.mode ?? null;
  const isCloudflare = hubMode === "cloudflare-worker";
  const isSelfHosted = hubMode === "self-hosted-hub";

  const [activeTab, setActiveTab] = useState<MigrationTab>("outbound");
  const [outboundMethod, setOutboundMethod] =
    useState<OutboundMethod>("existing");

  // Outbound migration form state (no fake defaults)
  const [migrationCodeInput, setMigrationCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [newPanelUrlInput, setNewPanelUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [allowInsecureWs, setAllowInsecureWs] = useState(false);
  const [installTicket, setInstallTicket] =
    useState<MigrationTicketResponse | null>(null);
  const [generatingInstall, setGeneratingInstall] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const onlineNodes = useMemo(() => nodes.filter((n) => n.online), [nodes]);
  const orderedNodes = useMemo(
    () => [...onlineNodes, ...nodes.filter((n) => !n.online)],
    [nodes, onlineNodes],
  );
  const [useCanary, setUseCanary] = useState(false);
  const [canaryNodeId, setCanaryNodeId] = useState(
    () => orderedNodes[0]?.id ?? "",
  );

  useEffect(() => {
    if (orderedNodes.length === 0) {
      if (canaryNodeId) setCanaryNodeId("");
      return;
    }
    if (!canaryNodeId || !orderedNodes.some((n) => n.id === canaryNodeId)) {
      setCanaryNodeId(orderedNodes[0].id);
    }
  }, [canaryNodeId, orderedNodes]);

  // Real cutover execution & 2s polling telemetry state
  const [migrating, setMigrating] = useState(false);
  const [cutoverStep, setCutoverStep] = useState<CutoverStep>("idle");
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] =
    useState<SmartMigrateResponse | null>(null);
  const [baselineConnected, setBaselineConnected] = useState(0);
  const [pollElapsedSec, setPollElapsedSec] = useState(0);
  const [lastMigratedMode, setLastMigratedMode] = useState<"canary" | "full">(
    "full",
  );
  const [lastMigrationTarget, setLastMigrationTarget] = useState("");
  const outboundPollTimerRef = useRef<number | null>(null);

  // Inbound migration state
  const [receiveTicket, setReceiveTicket] =
    useState<MigrationTicketResponse | null>(null);
  const [generatingReceive, setGeneratingReceive] = useState(false);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [receiveBaseTotal, setReceiveBaseTotal] = useState(0);
  const [receiveBaseConnected, setReceiveBaseConnected] = useState(0);
  const lastInboundStatsRef = useRef<{ total: number; connected: number }>({
    total: 0,
    connected: 0,
  });
  const inboundPollTimerRef = useRef<number | null>(null);

  // Countdown clock for active tickets
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const hasActiveTicket = Boolean(
    (installTicket && installTicket.expires_at > nowSec) ||
      (receiveTicket && receiveTicket.expires_at > nowSec),
  );

  useEffect(() => {
    if (!hasActiveTicket) return;
    const id = window.setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [hasActiveTicket]);

  // Cloudflare-only Watchdog state
  const [wdDraft, setWdDraft] = useState<WatchdogConfig>({
    enabled: false,
    secret: "",
    timeout_sec: 900,
    cooldown_sec: 1800,
    hub_label: "自建备用面板",
    channel_ids: [],
  });
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loadingWatchdog, setLoadingWatchdog] = useState(false);
  const [watchdogError, setWatchdogError] = useState<string | null>(null);
  const [savingWatchdog, setSavingWatchdog] = useState(false);

  // Backup & Restore state
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] =
    useState<PendingBackupImport | null>(null);
  const [importResult, setImportResult] = useState<ImportBundleResponse | null>(
    null,
  );
  const [bundlePreviewText, setBundlePreviewText] = useState<string | null>(
    null,
  );

  const stopOutboundPolling = useCallback(() => {
    if (outboundPollTimerRef.current !== null) {
      window.clearInterval(outboundPollTimerRef.current);
      outboundPollTimerRef.current = null;
    }
  }, []);

  const stopInboundPolling = useCallback(() => {
    if (inboundPollTimerRef.current !== null) {
      window.clearInterval(inboundPollTimerRef.current);
      inboundPollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopOutboundPolling();
      stopInboundPolling();
    };
  }, [stopOutboundPolling, stopInboundPolling]);

  // CRITICAL DUAL-MODE GUARD: Only fetch WatchdogConfig & channels in Cloudflare Worker mode
  const loadWatchdogAux = useCallback(async () => {
    if (hubMode !== "cloudflare-worker") return;
    setLoadingWatchdog(true);
    setWatchdogError(null);
    try {
      const [wdRes, chRes] = await Promise.all([
        api.getWatchdogConfig(),
        api.getChannels(),
      ]);
      setWdDraft(wdRes);
      setChannels(Array.isArray(chRes?.channels) ? chRes.channels : []);
    } catch (err) {
      setWatchdogError(
        err instanceof Error ? err.message : "加载 Cloudflare 看门狗配置失败",
      );
    } finally {
      setLoadingWatchdog(false);
    }
  }, [hubMode]);

  useEffect(() => {
    if (hubMode !== "cloudflare-worker") return;
    let cancelled = false;
    setLoadingWatchdog(true);
    setWatchdogError(null);
    void Promise.all([api.getWatchdogConfig(), api.getChannels()])
      .then(([wdRes, chRes]) => {
        if (cancelled) return;
        setWdDraft(wdRes);
        setChannels(Array.isArray(chRes?.channels) ? chRes.channels : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setWatchdogError(
          err instanceof Error
            ? err.message
            : "加载 Cloudflare 看门狗配置失败",
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingWatchdog(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hubMode]);

  // Keep latest callbacks in refs for async timers
  const onDataChangedRef = useRef(onDataChanged);
  onDataChangedRef.current = onDataChanged;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;

  // Inbound live 2s polling while inbound tab is active and ticket is valid
  useEffect(() => {
    stopInboundPolling();
    const currentSec = Math.floor(Date.now() / 1000);
    if (
      activeTab !== "inbound" ||
      !receiveTicket ||
      receiveTicket.expires_at <= currentSec
    ) {
      return;
    }

    inboundPollTimerRef.current = window.setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      setNowSec(now);
      if (now >= receiveTicket.expires_at) {
        stopInboundPolling();
        return;
      }
      try {
        const nextStatus = await api.getHubStatus();
        setLiveStatus(nextStatus);
        const prev = lastInboundStatsRef.current;
        if (
          nextStatus.total_nodes !== prev.total ||
          nextStatus.connected_agents !== prev.connected
        ) {
          lastInboundStatsRef.current = {
            total: nextStatus.total_nodes,
            connected: nextStatus.connected_agents,
          };
          await onDataChangedRef.current();
        }
      } catch {
        // Silent retry on transient network hiccup
      }
    }, 2000);

    return () => stopInboundPolling();
  }, [activeTab, receiveTicket, stopInboundPolling]);

  const handleRefreshHubStatus = async () => {
    setRefreshingStatus(true);
    try {
      const [nextStatus] = await Promise.all([
        api.getHubStatus(),
        onDataChanged(),
      ]);
      setLiveStatus(nextStatus);
      if (nextStatus.mode === "cloudflare-worker") {
        await loadWatchdogAux();
      }
    } catch (err) {
      onNotify(
        "danger",
        "刷新运行状态失败",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setRefreshingStatus(false);
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

  const startOutboundPolling = useCallback(
    (
      dispatchedCount: number,
      initialConnected: number,
      isCanaryRun: boolean,
    ) => {
      stopOutboundPolling();
      setPollElapsedSec(0);
      if (dispatchedCount <= 0) {
        setCutoverStep("done");
        void onDataChangedRef.current();
        onNotifyRef.current(
          "success",
          "配置已全量同步至目标面板",
          "当前源面板暂无在线节点需要实时切流",
        );
        return;
      }

      setCutoverStep("polling");
      let elapsed = 0;
      outboundPollTimerRef.current = window.setInterval(async () => {
        elapsed += 2;
        setPollElapsedSec(elapsed);
        try {
          const next = await api.getHubStatus();
          setLiveStatus(next);
          const switched = Math.max(0, initialConnected - next.connected_agents);
          if (switched >= dispatchedCount || elapsed >= 30) {
            stopOutboundPolling();
            setCutoverStep("done");
            void onDataChangedRef.current();
            onNotifyRef.current(
              "success",
              isCanaryRun
                ? "金丝雀试路节点切流完成"
                : `已完成 ${dispatchedCount} 台节点热迁移指令派发`,
              switched >= dispatchedCount
                ? "目标端探针已接管连接，原节点账本与规则已同步"
                : "30 秒切流观察窗结束，请前往目标面板核验最终接入状态",
            );
          }
        } catch {
          if (elapsed >= 30) {
            stopOutboundPolling();
            setCutoverStep("done");
            void onDataChangedRef.current();
          }
        }
      }, 2000);
    },
    [stopOutboundPolling],
  );

  const runSmartMigration = async (
    targetInput: string,
    forceFullFleet = false,
  ) => {
    const isCanaryRun =
      !forceFullFleet && outboundMethod === "existing" && useCanary;

    if (isCanaryRun && !canaryNodeId) {
      setCodeError("请选择 1 台用于金丝雀试路的节点，或取消勾选金丝雀试路");
      return;
    }

    stopOutboundPolling();
    const startConnected =
      effectiveStatus?.connected_agents ?? onlineNodes.length;
    setBaselineConnected(startConnected);
    setMigrating(true);
    setMigrationError(null);
    setMigrationResult(null);
    setLastMigratedMode(isCanaryRun ? "canary" : "full");
    setLastMigrationTarget(targetInput);
    setCutoverStep("connecting");

    try {
      const res = await api.smartMigrateHub({
        target_input: targetInput,
        ...(isCanaryRun ? { node_ids: [canaryNodeId] } : {}),
        ...(allowInsecureWs && targetInput.toLowerCase().startsWith("http://")
          ? { allow_insecure_ws: true }
          : {}),
      });
      setMigrationResult(res);
      startOutboundPolling(res.dispatched, startConnected, isCanaryRun);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "热迁移失败，请检查目标地址与网络";
      setCutoverStep("error");
      setMigrationError(msg);
      onNotify("danger", "热迁移执行失败", msg);
    } finally {
      setMigrating(false);
    }
  };

  const handleOutboundSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (migrating || cutoverStep === "polling") return;

    if (outboundMethod === "existing") {
      const trimmed = migrationCodeInput.trim();
      if (!trimmed) {
        setCodeError("请粘贴目标面板生成的 uobm1_ 迁移口令");
        return;
      }
      if (!trimmed.startsWith("uobm1_")) {
        setCodeError("迁移口令格式无效，必须以 uobm1_ 开头");
        return;
      }
      setCodeError(null);
      await runSmartMigration(trimmed, false);
      return;
    }

    const trimmedUrl = newPanelUrlInput.trim();
    if (!trimmedUrl) {
      setUrlError("请填写目标自建面板域名或访问地址");
      return;
    }
    if (trimmedUrl.startsWith("uobm1_")) {
      setUrlError("此处需填写新面板网址；若已有口令请切换到第一种方式");
      return;
    }
    setUrlError(null);
    await runSmartMigration(trimmedUrl, false);
  };

  const handleGenerateInstallTicket = async () => {
    if (generatingInstall) return;
    setGeneratingInstall(true);
    setInstallError(null);
    try {
      const res = await api.createMigrationTicket({
        purpose: "install",
        enable_watchdog: true,
      });
      setNowSec(Math.floor(Date.now() / 1000));
      setInstallTicket(res);
      onNotify(
        "info",
        "已签发自建 uniob-hub 一键安装命令",
        `有效期至 ${formatTimestamp(res.expires_at)}`,
      );
      if (isCloudflare) {
        void loadWatchdogAux();
      }
      void onDataChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "生成安装命令失败";
      setInstallError(msg);
      onNotify("danger", "生成安装命令失败", msg);
    } finally {
      setGeneratingInstall(false);
    }
  };

  const handleGenerateReceiveTicket = async () => {
    if (generatingReceive) return;
    setGeneratingReceive(true);
    setReceiveError(null);
    try {
      const baseTotal = effectiveStatus?.total_nodes ?? nodes.length;
      const baseConnected =
        effectiveStatus?.connected_agents ?? onlineNodes.length;
      const res = await api.createMigrationTicket({ purpose: "receive" });
      setNowSec(Math.floor(Date.now() / 1000));
      setReceiveBaseTotal(baseTotal);
      setReceiveBaseConnected(baseConnected);
      lastInboundStatsRef.current = {
        total: baseTotal,
        connected: baseConnected,
      };
      setReceiveTicket(res);
      onNotify(
        "info",
        "已签发一次性接收口令",
        `有效期至 ${formatTimestamp(res.expires_at)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "生成接收口令失败";
      setReceiveError(msg);
      onNotify("danger", "生成接收口令失败", msg);
    } finally {
      setGeneratingReceive(false);
    }
  };

  const handleSaveWatchdogSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isCloudflare || savingWatchdog) return;

    const trimmedSecret = wdDraft.secret.trim();
    if (trimmedSecret.length > 0 && trimmedSecret.length < 8) {
      setWatchdogError("看门狗通信密钥至少需要 8 个字符");
      return;
    }

    const nextCfg: WatchdogConfig = {
      enabled: Boolean(wdDraft.enabled),
      secret: trimmedSecret || (wdDraft.enabled ? generateHexSecret(24) : ""),
      timeout_sec: Math.max(60, Math.round(wdDraft.timeout_sec || 900)),
      cooldown_sec: Math.max(60, Math.round(wdDraft.cooldown_sec || 1800)),
      hub_label: wdDraft.hub_label.trim() || "自建备用面板",
      channel_ids: wdDraft.channel_ids ?? [],
    };

    setSavingWatchdog(true);
    setWatchdogError(null);
    try {
      const updated = await api.updateWatchdogConfig(nextCfg);
      setWdDraft(updated);
      const nextStatus = await api.getHubStatus();
      setLiveStatus(nextStatus);
      await onDataChanged();
      onNotify(
        "success",
        "Cloudflare 看门狗配置已保存",
        updated.enabled
          ? `超时阈值 ${formatDurationZh(updated.timeout_sec)}`
          : "云端掉线看门狗已关闭",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存看门狗配置失败";
      setWatchdogError(msg);
      onNotify("danger", "保存看门狗配置失败", msg);
    } finally {
      setSavingWatchdog(false);
    }
  };

  const handleExportJsonBackup = async () => {
    if (exporting) return;
    setExporting(true);
    setBackupError(null);
    try {
      const bundle = await api.exportBundle();
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

      setBundlePreviewText(summarizeBundleForPreview(bundle));
      onNotify(
        "success",
        `已导出全量备份 ${fname}`,
        `包含 ${Array.isArray(bundle.nodes) ? bundle.nodes.length : 0} 台节点与月度流量账本`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "导出全量备份失败";
      setBackupError(msg);
      onNotify("danger", "导出备份失败", msg);
    } finally {
      setExporting(false);
    }
  };

  const handleSelectBackupFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBackupError(null);
    setImportResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as ExportBundle;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Array.isArray(parsed.nodes)
      ) {
        throw new Error("备份文件缺少有效的 nodes 数组，请选择 UniOB 导出的 JSON 备份");
      }

      const counts = {
        nodes: parsed.nodes.length,
        channels: Array.isArray(parsed.notification_channels)
          ? parsed.notification_channels.length
          : 0,
        rules: Array.isArray(parsed.alert_rules) ? parsed.alert_rules.length : 0,
        traffic_ledgers: Array.isArray(parsed.traffic_ledgers)
          ? parsed.traffic_ledgers.length
          : 0,
      };

      setPendingImport({
        fileName: file.name,
        bundle: parsed,
        counts,
        exportedAt:
          typeof parsed.exported_at === "number" ? parsed.exported_at : null,
      });
      setBundlePreviewText(summarizeBundleForPreview(parsed));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "解析备份文件失败";
      setPendingImport(null);
      setBackupError(msg);
      onNotify("danger", "备份文件格式校验失败", msg);
    }
  };

  const handleConfirmImport = async () => {
    if (!pendingImport || importing) return;
    setImporting(true);
    setBackupError(null);
    try {
      const res = await api.importBundle(pendingImport.bundle);
      setImportResult(res);
      setPendingImport(null);
      await onDataChanged();
      if (isCloudflare) {
        void loadWatchdogAux();
      }
      onNotify(
        "success",
        "备份恢复成功",
        `已导入 ${res.imported.nodes} 台节点、${res.imported.channels} 个渠道、${res.imported.rules} 条规则、${res.imported.traffic_ledgers} 条流量账本`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "导入备份恢复失败";
      setBackupError(msg);
      onNotify("danger", "导入恢复失败", msg);
    } finally {
      setImporting(false);
    }
  };

  const connectedAgents = effectiveStatus?.connected_agents ?? onlineNodes.length;
  const totalNodes = effectiveStatus?.total_nodes ?? nodes.length;
  const wdBadge = getWatchdogBadge(effectiveStatus?.watchdog.status);

  const dispatchedCount = migrationResult?.dispatched ?? 0;
  const switchedEstimate =
    dispatchedCount > 0
      ? Math.max(0, Math.min(dispatchedCount, baselineConnected - connectedAgents))
      : 0;
  const progressPct =
    cutoverStep === "done"
      ? 100
      : cutoverStep === "connecting"
        ? 25
        : cutoverStep === "polling"
          ? dispatchedCount > 0
            ? Math.min(
                95,
                Math.max(40, Math.round((switchedEstimate / dispatchedCount) * 100)),
              )
            : 95
          : 0;

  const arrivedTotalDelta = Math.max(0, totalNodes - receiveBaseTotal);
  const arrivedConnectedDelta = Math.max(
    0,
    connectedAgents - receiveBaseConnected,
  );

  const watchdogPingUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/watchdog/ping`
      : "/api/watchdog/ping";
  const manualFlags = `--watchdog-url ${shellArg(watchdogPingUrl)} --watchdog-secret ${shellArg(
    wdDraft.secret || "<未生成密钥>",
  )}`;

  const defaultSummarySnippet = useMemo(
    () =>
      JSON.stringify(
        {
          version: 2,
          mode: hubMode ?? "loading",
          nodes_count: nodes.length,
          connected_agents: connectedAgents,
          ...(isCloudflare ? { channels_count: channels.length } : {}),
          note: "点击「导出全量 JSON 备份」以获取完整服务端快照，或选择本地备份文件校验导入",
        },
        null,
        2,
      ),
    [hubMode, nodes.length, connectedAgents, isCloudflare, channels.length],
  );

  const displayedPreviewJson = bundlePreviewText ?? defaultSummarySnippet;

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
              {effectiveStatus?.version ?? "状态读取中..."}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            在 Cloudflare Workers SCCH（边缘休眠）与自建 Rust uniob-hub（SQLite WAL）之间无损迁移全部节点、账本与告警路由。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num">
            <Radio
              className="w-3.5 h-3.5 text-emerald-500 animate-status-pulse"
              aria-hidden="true"
            />
            <span>
              在线探针 {connectedAgents} / {totalNodes}
            </span>
          </span>
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-medium ${wdBadge.cls}`}
          >
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            <span>看门狗：{wdBadge.label}</span>
          </span>
          <button
            type="button"
            disabled={refreshingStatus}
            onClick={() => void handleRefreshHubStatus()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshingStatus ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>刷新</span>
          </button>
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
              <span className="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                {effectiveStatus ? "备用对等端" : "检测中"}
              </span>
            )}
          </div>

          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
            <span className="px-2 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
              uniob-agent v2
            </span>
            <ArrowRight
              className="w-3.5 h-3.5 text-[var(--text-muted)]"
              aria-hidden="true"
            />
            <span className="px-2 py-1 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-700 dark:text-sky-300">
              CF Edge Auth (0 DO唤醒)
            </span>
            <ArrowRight
              className="w-3.5 h-3.5 text-[var(--text-muted)]"
              aria-hidden="true"
            />
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
            isSelfHosted ? "ring-1" : "opacity-90"
          }`}
          style={
            isSelfHosted
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

            {isSelfHosted ? (
              <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/35">
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                运行中
              </span>
            ) : (
              <span className="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                {effectiveStatus ? "备用对等端" : "检测中"}
              </span>
            )}
          </div>

          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
            <span className="px-2 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
              uniob-agent v2
            </span>
            <ArrowRight
              className="w-3.5 h-3.5 text-[var(--text-muted)]"
              aria-hidden="true"
            />
            <span className="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
              uniob-hub (SQLite WAL)
            </span>
            <ArrowRight
              className="w-3.5 h-3.5 text-[var(--text-muted)]"
              aria-hidden="true"
            />
            <span className="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300">
              Watchdog Ping
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

      {/* 2. Zero-Downtime Canary Live Migration Workspace */}
      <div className="surface-card rounded-2xl overflow-hidden">
        <div className="px-5 pt-5 pb-0 border-b border-[var(--border-subtle)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ArrowLeftRight
                className="w-4 h-4 text-[var(--accent-primary)]"
                aria-hidden="true"
              />
              <h2 className="text-sm font-bold text-[var(--text-primary)]">
                无感金丝雀热迁移工作台（2-Phase Canary Cutover）
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
                  ? "text-[var(--accent-primary)] border-b-2 border-[var(--accent-primary)]"
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
                  ? "text-[var(--accent-primary)] border-b-2 border-[var(--accent-primary)]"
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
            <form
              noValidate
              onSubmit={(e) => void handleOutboundSubmit(e)}
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
                        setUrlError(null);
                      }}
                      className="mt-0.5 accent-emerald-600"
                    />
                    <div>
                      <div className="font-semibold text-[var(--text-primary)]">
                        已有目标面板（粘贴 uobm1_... 迁移口令）
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
                        setUrlError(null);
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
                    <label
                      htmlFor={codeInputId}
                      className="block font-medium text-[var(--text-primary)] mb-1.5"
                    >
                      目标面板迁移口令（uobm1_...）
                    </label>
                    <input
                      id={codeInputId}
                      type="text"
                      value={migrationCodeInput}
                      onChange={(e) => {
                        setMigrationCodeInput(e.target.value);
                        if (codeError) setCodeError(null);
                      }}
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="粘贴目标面板生成的 uobm1_ 开头迁移口令"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-xs text-[var(--text-primary)]"
                    />
                    {codeError ? (
                      <p className="mt-1.5 text-[11px] text-rose-600 dark:text-rose-400 flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        <span>{codeError}</span>
                      </p>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                        在目标面板打开「双模热迁移工作台 → 迁入到此面板」即可一键生成口令（30 分钟内有效）。
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
                        启用金丝雀试路（先切流 1 台节点验证握手与心跳，再全量放行）
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
                        {orderedNodes.length === 0 ? (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400">
                            当前暂无服务器节点，取消勾选可直接同步全局配置。
                          </span>
                        ) : (
                          <select
                            id={canarySelectId}
                            value={canaryNodeId}
                            onChange={(e) => setCanaryNodeId(e.target.value)}
                            className="w-full sm:max-w-xs px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] text-xs"
                          >
                            {orderedNodes.map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.region_flag ? `${n.region_flag} ` : ""}
                                {n.name}（{n.online ? "在线" : "离线"}）
                              </option>
                            ))}
                          </select>
                        )}
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
                        部署时自动拉取当前所有节点哈希、月流量账本、告警规则与管理员密码，并配置看门狗心跳。
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={generatingInstall}
                      onClick={() => void handleGenerateInstallTicket()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent-primary)] font-semibold disabled:opacity-60"
                    >
                      {generatingInstall ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>
                        {installTicket ? "重新生成命令" : "生成安装命令"}
                      </span>
                    </button>
                  </div>

                  {installError && (
                    <div
                      role="alert"
                      className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300"
                    >
                      {installError}
                    </div>
                  )}

                  {installTicket?.install_cmd && (
                    <div className="rounded-xl bg-[#070b14] border border-slate-800 p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono-num text-slate-400">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" aria-hidden="true" />
                            <span>
                              有效期至 {formatTimestamp(installTicket.expires_at)}（剩余{" "}
                              {formatRemainingCountdown(
                                installTicket.expires_at,
                                nowSec,
                              )}
                              ）
                            </span>
                          </span>
                          {installTicket.watchdog_armed && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                              已自动注入看门狗参数
                            </span>
                          )}
                        </div>
                        <StudioCopyButton
                          text={installTicket.install_cmd}
                          label="复制命令"
                          ariaLabel="复制自建面板安装命令"
                        />
                      </div>
                      <pre className="font-mono-num text-[11px] text-emerald-300 break-all whitespace-pre-wrap">
                        {installTicket.install_cmd}
                      </pre>
                    </div>
                  )}

                  <div className="space-y-2">
                    <label
                      htmlFor={targetUrlId}
                      className="block font-medium text-[var(--text-primary)]"
                    >
                      新自建面板访问地址（部署完成后输入地址并点击下方启动切流）
                    </label>
                    <input
                      id={targetUrlId}
                      type="text"
                      value={newPanelUrlInput}
                      onChange={(e) => {
                        setNewPanelUrlInput(e.target.value);
                        if (urlError) setUrlError(null);
                      }}
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="例如：hub.example.com 或 https://hub.example.com"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-xs text-[var(--text-primary)]"
                    />
                    {urlError && (
                      <p className="text-[11px] text-rose-600 dark:text-rose-400 flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        <span>{urlError}</span>
                      </p>
                    )}

                    {newPanelUrlInput.trim().toLowerCase().startsWith("http://") && (
                      <label
                        htmlFor={insecureWsId}
                        className="inline-flex cursor-pointer items-center gap-2 pt-1 text-[11px] text-amber-700 dark:text-amber-300"
                      >
                        <input
                          id={insecureWsId}
                          type="checkbox"
                          checked={allowInsecureWs}
                          onChange={(e) => setAllowInsecureWs(e.target.checked)}
                          className="rounded accent-amber-600"
                        />
                        <span>
                          允许非 HTTPS 明文 WebSocket 连接（allow_insecure_ws，仅内网或测试环境使用）
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              )}

              {/* Action Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-[11px] text-[var(--text-muted)]">
                  第 2 步：下发切流指令后，探针将持久化 /var/lib/uniob/endpoint_override.toml
                </span>
                <button
                  type="submit"
                  disabled={migrating || cutoverStep === "polling"}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm disabled:opacity-60"
                  style={{ backgroundColor: "var(--accent-solid)" }}
                >
                  {migrating || cutoverStep === "polling" ? (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>
                    {migrating
                      ? "同步并下发切流中..."
                      : cutoverStep === "polling"
                        ? "实时观测切流状态..."
                        : outboundMethod === "existing" && useCanary
                          ? "启动金丝雀试路切流"
                          : "一键同步并启动全量切流"}
                  </span>
                </button>
              </div>
            </form>

            {/* Live 3-Phase Cutover Progress Telemetry */}
            {cutoverStep !== "idle" && (
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

                {cutoverStep === "error" && migrationError && (
                  <div
                    role="alert"
                    className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-rose-700 dark:text-rose-300 flex items-start gap-2"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{migrationError}</span>
                  </div>
                )}

                <div className="h-2 w-full rounded-full bg-[var(--bg-inset)] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      cutoverStep === "error" ? "bg-rose-500" : ""
                    }`}
                    style={{
                      width: `${cutoverStep === "error" ? 100 : progressPct}%`,
                      backgroundColor:
                        cutoverStep === "error"
                          ? undefined
                          : "var(--accent-primary)",
                    }}
                  />
                </div>

                <ol className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <li
                    className={`rounded-xl border p-3 ${
                      cutoverStep === "error"
                        ? "border-rose-500/40 bg-rose-500/10"
                        : cutoverStep === "connecting"
                          ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                          : "border-emerald-500/30 bg-emerald-500/10"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                      {cutoverStep === "connecting" ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin text-[var(--accent-primary)]"
                          aria-hidden="true"
                        />
                      ) : cutoverStep === "error" ? (
                        <AlertCircle
                          className="w-3.5 h-3.5 text-rose-500"
                          aria-hidden="true"
                        />
                      ) : (
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-emerald-500"
                          aria-hidden="true"
                        />
                      )}
                      <span>1. 目标端握手与校验</span>
                    </div>
                    <p className="mt-1 text-[11px] font-mono-num text-[var(--text-secondary)] break-all">
                      {migrationResult
                        ? `epoch = ${migrationResult.epoch} · ${migrationResult.target_origin}`
                        : cutoverStep === "error"
                          ? "握手或传输校验失败"
                          : "正在校验目标控制面与迁移凭据..."}
                    </p>
                  </li>

                  <li
                    className={`rounded-xl border p-3 ${
                      migrationResult
                        ? "border-emerald-500/30 bg-emerald-500/10"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface)] opacity-75"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                      {migrationResult ? (
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
                      {migrationResult
                        ? `节点 ${migrationResult.synced.nodes} · 渠道 ${migrationResult.synced.channels} · 规则 ${migrationResult.synced.rules} · 账本 ${migrationResult.synced.traffic_ledgers}`
                        : "等待状态快照写入目标端..."}
                    </p>
                  </li>

                  <li
                    className={`rounded-xl border p-3 ${
                      cutoverStep === "done"
                        ? "border-emerald-500/40 bg-emerald-500/12"
                        : cutoverStep === "polling"
                          ? "border-sky-500/40 bg-sky-500/12"
                          : "border-[var(--border-subtle)] bg-[var(--bg-surface)] opacity-75"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                      {cutoverStep === "polling" ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin text-sky-500"
                          aria-hidden="true"
                        />
                      ) : cutoverStep === "done" ? (
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-emerald-500"
                          aria-hidden="true"
                        />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-current opacity-40" />
                      )}
                      <span>3. 平滑切流与遥测确认</span>
                    </div>
                    <p className="mt-1 text-[11px] font-mono-num text-[var(--text-secondary)]">
                      {!migrationResult
                        ? "等待派发切流指令"
                        : dispatchedCount === 0
                          ? "当前无在线探针需要切流，配置已就绪"
                          : cutoverStep === "done"
                            ? `已派发 ${dispatchedCount} 台 · 本面板剩余在线 ${connectedAgents} 台`
                            : `已切离 ${switchedEstimate} / ${dispatchedCount} 台（轮询 ${pollElapsedSec}s / 30s）`}
                    </p>
                  </li>
                </ol>

                {migrationResult && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)]">
                    <div className="flex flex-wrap items-center gap-2">
                      {cutoverStep === "done" &&
                        lastMigratedMode === "canary" &&
                        lastMigrationTarget && (
                          <button
                            type="button"
                            disabled={migrating}
                            onClick={() =>
                              void runSmartMigration(lastMigrationTarget, true)
                            }
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-60"
                          >
                            <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>继续切流剩余节点</span>
                          </button>
                        )}
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        {cutoverStep === "done" && lastMigratedMode === "canary"
                          ? "金丝雀节点切流已完成，可点击右侧前往目标面板核验或一键全量放行。"
                          : "目标面板已接收状态同步，可打开新面板实时查看探针上线。"}
                      </span>
                    </div>

                    <a
                      href={migrationResult.target_origin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold border border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)]"
                    >
                      <span>打开新面板</span>
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    </a>
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
                  disabled={generatingReceive}
                  onClick={() => void handleGenerateReceiveTicket()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm disabled:opacity-60"
                  style={{ backgroundColor: "var(--accent-solid)" }}
                >
                  {generatingReceive ? (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>
                    {receiveTicket ? "重新生成口令" : "生成 uobm1_ 接收口令"}
                  </span>
                </button>
              </div>

              {receiveError && (
                <div
                  role="alert"
                  className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300"
                >
                  {receiveError}
                </div>
              )}

              {receiveTicket?.migration_code && (
                <div className="space-y-3 pt-3 border-t border-[var(--border-subtle)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 py-2.5">
                    <code className="font-mono-num text-xs font-semibold text-[var(--accent-primary)] break-all">
                      {receiveTicket.migration_code}
                    </code>
                    <StudioCopyButton
                      text={receiveTicket.migration_code}
                      label="复制口令"
                      ariaLabel="复制 uobm1 迁移接收口令"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        有效期至 {formatTimestamp(receiveTicket.expires_at)}（剩余{" "}
                        {formatRemainingCountdown(
                          receiveTicket.expires_at,
                          nowSec,
                        )}
                        ）
                      </span>
                    </span>
                    <span className="text-[var(--text-muted)]">
                      在原面板「迁往其他面板」粘贴此口令即可推送同步
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/35 bg-sky-500/10 px-3.5 py-2.5 text-sky-900 dark:text-sky-200">
                    <div className="flex items-center gap-2 font-mono-num">
                      {receiveTicket.expires_at > nowSec ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin text-sky-500"
                          aria-hidden="true"
                        />
                      ) : (
                        <AlertCircle
                          className="w-3.5 h-3.5 text-amber-500"
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {receiveTicket.expires_at > nowSec
                          ? `实时监听接入中（每 2 秒轮询）· 当前在线 ${connectedAgents} / ${totalNodes} 台`
                          : `接收口令已过期 · 当前在线 ${connectedAgents} / ${totalNodes} 台`}
                      </span>
                    </div>

                    {(arrivedTotalDelta > 0 || arrivedConnectedDelta > 0) && (
                      <span className="font-mono-num text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                        新增节点 +{arrivedTotalDelta} · 在线 +{arrivedConnectedDelta}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Dual-Mode Watchdog Section */}
      {isCloudflare ? (
        <form
          onSubmit={(e) => void handleSaveWatchdogSubmit(e)}
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
                  迁移到自建 uniob-hub 后保留 Cloudflare Workers 独立值守；若自建服务器断电或失联超过阈值，云端立即推送告警。
                </p>
              </div>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium border ${wdBadge.cls}`}
            >
              {wdBadge.label}
              {effectiveStatus?.watchdog.last_ping_ts
                ? ` · ${formatRelativeTime(effectiveStatus.watchdog.last_ping_ts)}`
                : ""}
            </span>
          </div>

          {watchdogError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-rose-700 dark:text-rose-300"
            >
              {watchdogError}
            </div>
          )}

          {loadingWatchdog ? (
            <div className="flex items-center gap-2 py-4 text-[var(--text-secondary)]">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              <span>正在加载 Cloudflare 看门狗配置...</span>
            </div>
          ) : (
            <>
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
                          prev.secret ||
                          (e.target.checked ? generateHexSecret(24) : ""),
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
                            setWdDraft((prev) => ({
                              ...prev,
                              timeout_sec: p.sec,
                            }))
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
                      setWdDraft((prev) => ({
                        ...prev,
                        hub_label: e.target.value,
                      }))
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
                        cooldown_sec:
                          Number.parseInt(e.target.value, 10) || 1800,
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
                {channels.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-muted)]">
                    暂未配置通知渠道，可前往「告警事件中心」添加 Telegram 或 Webhook 通道。
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {channels.map((ch) => {
                      const checked = (wdDraft.channel_ids ?? []).includes(
                        ch.id,
                      );
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
                )}
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
                          setWdDraft((prev) => ({
                            ...prev,
                            secret: e.target.value,
                          }))
                        }
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder="点击生成或输入至少 8 位通信密钥"
                        className="min-w-0 flex-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] font-mono-num text-[11px]"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setWdDraft((prev) => ({
                            ...prev,
                            secret: generateHexSecret(24),
                          }))
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[11px] font-medium hover:bg-[var(--bg-card-hover)]"
                      >
                        <Wand2 className="w-3 h-3" aria-hidden="true" />
                        <span>生成随机密钥</span>
                      </button>
                      {wdDraft.secret && (
                        <StudioCopyButton
                          text={wdDraft.secret}
                          label="复制密钥"
                          ariaLabel="复制看门狗通信密钥"
                        />
                      )}
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
                  disabled={savingWatchdog}
                  className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-semibold shadow-sm disabled:opacity-60"
                  style={{ backgroundColor: "var(--accent-solid)" }}
                >
                  {savingWatchdog ? (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>{savingWatchdog ? "保存中..." : "保存看门狗配置"}</span>
                </button>
              </div>
            </>
          )}
        </form>
      ) : isSelfHosted && effectiveStatus ? (
        <div className="surface-card rounded-2xl p-5 space-y-3 text-xs">
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
                  自建 uniob-hub 看门狗上报状态
                </h2>
                <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                  看门狗告警规则、失联超时阈值与通知路由均托管在 Cloudflare Workers 控制面；当前自建节点仅周期性发送 HMAC 签名心跳。
                </p>
              </div>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium border ${wdBadge.cls}`}
            >
              {wdBadge.label}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono-num">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
              <div className="text-[10px] text-[var(--text-muted)]">
                心跳客户端状态
              </div>
              <div className="mt-1 font-semibold text-[var(--text-primary)]">
                {effectiveStatus.watchdog.enabled
                  ? "已配置 --watchdog-url"
                  : "未配置看门狗参数"}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
              <div className="text-[10px] text-[var(--text-muted)]">
                最近一次心跳上报
              </div>
              <div className="mt-1 font-semibold text-[var(--text-primary)]">
                {effectiveStatus.watchdog.last_ping_ts
                  ? `${formatTimestamp(effectiveStatus.watchdog.last_ping_ts)}（${formatRelativeTime(effectiveStatus.watchdog.last_ping_ts)}）`
                  : "尚无心跳记录"}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
              <div className="text-[10px] text-[var(--text-muted)]">
                云端超时参考窗口
              </div>
              <div className="mt-1 font-semibold text-[var(--text-primary)]">
                {formatDurationZh(effectiveStatus.watchdog.timeout_sec)}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="surface-card rounded-2xl p-5 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          <span>正在获取控制面运行模式与看门狗状态...</span>
        </div>
      )}

      {/* 4. Native <details> Collapsible Full Backup & Ledger JSON Export/Restore */}
      <details className="surface-card rounded-2xl px-5 py-4 text-xs">
        <summary className="cursor-pointer flex flex-wrap items-center justify-between gap-2 font-semibold text-sm text-[var(--text-primary)] select-none">
          <span className="inline-flex items-center gap-2">
            <FileJson
              className="w-4 h-4 text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>全量配置与账本 JSON 备份 / 恢复</span>
          </span>
          <span className="text-[11px] font-mono-num font-normal text-[var(--text-muted)]">
            {nodes.length} 台节点 · 含通道、规则与当期月流量账本
          </span>
        </summary>

        <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] space-y-4">
          <p className="text-xs text-[var(--text-secondary)]">
            支持一键导出完整的 UniOB v2 JSON 快照（包含节点密钥哈希、分组标签、计费口径、当月流量账本与告警路由），用于离线灾备或跨云环境冷迁移。
          </p>

          {backupError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-rose-700 dark:text-rose-300"
            >
              {backupError}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-5 space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => void handleExportJsonBackup()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] font-semibold disabled:opacity-60"
                >
                  {exporting ? (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>{exporting ? "导出中..." : "导出全量 JSON 备份"}</span>
                </button>

                <label
                  htmlFor={backupFileId}
                  className="inline-flex cursor-pointer items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[var(--accent-ring)] bg-[var(--accent-soft)] text-[var(--accent-primary)] font-semibold"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>导入备份 JSON 恢复</span>
                </label>
                <input
                  id={backupFileId}
                  type="file"
                  accept="application/json,.json"
                  disabled={importing}
                  onChange={(e) => void handleSelectBackupFile(e)}
                  className="sr-only"
                />
              </div>

              {pendingImport && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 space-y-2.5">
                  <div className="font-semibold text-amber-900 dark:text-amber-200">
                    待确认恢复：{pendingImport.fileName}
                  </div>
                  <div className="text-[11px] font-mono-num text-amber-800 dark:text-amber-300 space-y-0.5">
                    <div>
                      节点 {pendingImport.counts.nodes} 台 · 渠道{" "}
                      {pendingImport.counts.channels} 个 · 规则{" "}
                      {pendingImport.counts.rules} 条 · 流量账本{" "}
                      {pendingImport.counts.traffic_ledgers} 条
                    </div>
                    {pendingImport.exportedAt && (
                      <div>
                        备份时间：{formatTimestamp(pendingImport.exportedAt)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={importing}
                      onClick={() => void handleConfirmImport()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-60"
                    >
                      {importing ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>{importing ? "正在恢复..." : "确认导入恢复"}</span>
                    </button>
                    <button
                      type="button"
                      disabled={importing}
                      onClick={() => setPendingImport(null)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                      <span>取消</span>
                    </button>
                  </div>
                </div>
              )}

              {importResult && (
                <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/12 px-3 py-2 text-emerald-700 dark:text-emerald-300">
                  已恢复 {importResult.imported.nodes} 台节点、
                  {importResult.imported.channels} 个通知渠道、
                  {importResult.imported.rules} 条告警规则、
                  {importResult.imported.traffic_ledgers} 条月度流量统计。
                </div>
              )}
            </div>

            <div className="lg:col-span-7 rounded-xl bg-[#070b14] border border-slate-800 p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono-num text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Database
                    className="w-3.5 h-3.5 text-emerald-400"
                    aria-hidden="true"
                  />
                  <span>ExportBundle v2 摘要预览</span>
                </span>
                <StudioCopyButton
                  text={displayedPreviewJson}
                  label="复制预览"
                  ariaLabel="复制 JSON 备份摘要预览"
                />
              </div>
              <pre className="font-mono-num text-[11px] text-slate-300 overflow-x-auto leading-relaxed">
                {displayedPreviewJson}
              </pre>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}
