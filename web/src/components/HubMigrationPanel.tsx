import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Loader2,
  RefreshCw,
  Server,
  X,
} from "lucide-react";
import type {
  HubStatusResponse,
  MigrationTicketResponse,
  NodeSummary,
  NotificationChannel,
  SmartMigrateResponse,
  WatchdogConfig,
  WatchdogHealthStatus,
} from "../types";
import { api } from "../api/client";
import { BackupRestoreSection } from "./BackupRestoreSection";
import { CopyButton } from "./CopyButton";
import {
  MigrationProgressTracker,
  type MigrationProgressStep,
} from "./MigrationProgressTracker";
import { WatchdogSettingsSection } from "./WatchdogSettingsSection";

interface HubMigrationPanelProps {
  nodes: NodeSummary[];
  onBundleImported?: () => Promise<void> | void;
}

type MigrationTab = "outbound" | "inbound";
type OutboundMethod = "existing" | "install";

function getWatchdogStatusBadge(status?: WatchdogHealthStatus): {
  label: string;
  tone: string;
} {
  switch (status) {
    case "healthy":
      return {
        label: "守护中",
        tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "waiting":
      return {
        label: "等待首次连接",
        tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "stale":
      return {
        label: "失联告警中",
        tone: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      };
    case "disabled":
    default:
      return {
        label: "未开启",
        tone: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
      };
  }
}

export function HubMigrationPanel({
  nodes,
  onBundleImported,
}: HubMigrationPanelProps) {
  const baseId = useId();
  const dialogTitleId = `${baseId}-dialog-title`;
  const outboundTabId = `${baseId}-tab-outbound`;
  const inboundTabId = `${baseId}-tab-inbound`;
  const outboundPanelId = `${baseId}-panel-outbound`;
  const inboundPanelId = `${baseId}-panel-inbound`;
  const codeInputId = `${baseId}-code-input`;
  const codeHelpId = `${baseId}-code-help`;
  const codeErrorId = `${baseId}-code-error`;
  const canaryCheckId = `${baseId}-canary-check`;
  const canarySelectId = `${baseId}-canary-select`;
  const urlInputId = `${baseId}-url-input`;
  const urlHelpId = `${baseId}-url-help`;
  const urlErrorId = `${baseId}-url-error`;
  const insecureWsId = `${baseId}-insecure-ws`;

  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<MigrationTab>("outbound");

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const outboundTabRef = useRef<HTMLButtonElement | null>(null);
  const inboundTabRef = useRef<HTMLButtonElement | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [status, setStatus] = useState<HubStatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Outbound migration state
  const [outboundMethod, setOutboundMethod] =
    useState<OutboundMethod>("existing");
  const [migrationCodeInput, setMigrationCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [useCanary, setUseCanary] = useState(false);
  const [canaryNodeId, setCanaryNodeId] = useState("");

  const [installTicket, setInstallTicket] =
    useState<MigrationTicketResponse | null>(null);
  const [generatingInstall, setGeneratingInstall] = useState(false);
  const [newPanelUrlInput, setNewPanelUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [allowInsecureWs, setAllowInsecureWs] = useState(false);

  const [migrating, setMigrating] = useState(false);
  const [migrationStep, setMigrationStep] =
    useState<MigrationProgressStep>("idle");
  const [migrationResult, setMigrationResult] =
    useState<SmartMigrateResponse | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [baselineConnected, setBaselineConnected] = useState(0);
  const [livePollStatus, setLivePollStatus] =
    useState<HubStatusResponse | null>(null);
  const [pollElapsedSec, setPollElapsedSec] = useState(0);
  const outboundPollTimerRef = useRef<number | null>(null);

  // Inbound migration state
  const [receiveTicket, setReceiveTicket] =
    useState<MigrationTicketResponse | null>(null);
  const [generatingReceive, setGeneratingReceive] = useState(false);
  const [receiveBaseTotal, setReceiveBaseTotal] = useState(0);
  const [receiveBaseConnected, setReceiveBaseConnected] = useState(0);
  const inboundPollTimerRef = useRef<number | null>(null);

  // Watchdog state (Cloudflare mode only)
  const [watchdogConfig, setWatchdogConfig] = useState<WatchdogConfig>({
    enabled: false,
    secret: "",
    timeout_sec: 900,
    cooldown_sec: 1800,
    hub_label: "自建备用面板",
    channel_ids: [],
  });
  const [channels, setChannels] = useState<NotificationChannel[]>([]);

  const onlineNodes = useMemo(() => nodes.filter((n) => n.online), [nodes]);
  const orderedCanaryNodes = useMemo(
    () => [...onlineNodes, ...nodes.filter((n) => !n.online)],
    [nodes, onlineNodes]
  );

  useEffect(() => {
    if (!canaryNodeId && orderedCanaryNodes.length > 0) {
      setCanaryNodeId(orderedCanaryNodes[0].id);
    }
  }, [canaryNodeId, orderedCanaryNodes]);

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

  const loadHubData = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const hubStatus = await api.getHubStatus();
      setStatus(hubStatus);
      if (hubStatus.mode === "cloudflare-worker") {
        const [wdRes, chRes] = await Promise.allSettled([
          api.getWatchdogConfig(),
          api.getChannels(),
        ]);
        if (wdRes.status === "fulfilled") {
          setWatchdogConfig(wdRes.value);
        }
        if (chRes.status === "fulfilled") {
          setChannels(chRes.value.channels);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载面板运行状态失败");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadHubData();
  }, [loadHubData]);

  const openModal = (
    tab: MigrationTab,
    triggerEl: HTMLButtonElement | null
  ) => {
    lastTriggerRef.current = triggerEl;
    setActiveTab(tab);
    setError(null);
    setNotice(null);
    setIsOpen(true);
    void loadHubData();
  };

  const closeModal = useCallback(() => {
    stopOutboundPolling();
    stopInboundPolling();
    setIsOpen(false);
    const trigger = lastTriggerRef.current;
    window.requestAnimationFrame(() => {
      trigger?.focus();
    });
  }, [stopInboundPolling, stopOutboundPolling]);

  // Modal focus management, Escape & Tab trap
  useEffect(() => {
    if (!isOpen) return;

    const raf = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => {
          const panel = el.closest('[role="tabpanel"][hidden]');
          return !panel && el.offsetParent !== null;
        });
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, closeModal]);

  // Tablist keyboard navigation (ArrowLeft / ArrowRight / Home / End)
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
    const ref = nextTab === "outbound" ? outboundTabRef : inboundTabRef;
    ref.current?.focus();
  };

  // Inbound live server arrival counter polling (every 2s while active)
  useEffect(() => {
    stopInboundPolling();
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !isOpen ||
      activeTab !== "inbound" ||
      !receiveTicket ||
      receiveTicket.expires_at <= nowSec
    ) {
      return;
    }

    inboundPollTimerRef.current = window.setInterval(async () => {
      const currentSec = Math.floor(Date.now() / 1000);
      if (currentSec >= receiveTicket.expires_at) {
        stopInboundPolling();
        return;
      }
      try {
        const nextStatus = await api.getHubStatus();
        setStatus((prev) => {
          if (
            prev &&
            (nextStatus.total_nodes !== prev.total_nodes ||
              nextStatus.connected_agents !== prev.connected_agents)
          ) {
            void onBundleImported?.();
          }
          return nextStatus;
        });
      } catch {
        // Silent retry on transient network hiccup
      }
    }, 2000);

    return () => stopInboundPolling();
  }, [isOpen, activeTab, receiveTicket, onBundleImported, stopInboundPolling]);

  const startOutboundPolling = useCallback(
    (dispatchedCount: number, initialConnected: number) => {
      stopOutboundPolling();
      setPollElapsedSec(0);
      if (dispatchedCount <= 0) {
        setMigrationStep("done");
        return;
      }

      setMigrationStep("polling");
      let elapsed = 0;
      outboundPollTimerRef.current = window.setInterval(async () => {
        elapsed += 2;
        setPollElapsedSec(elapsed);
        try {
          const next = await api.getHubStatus();
          setLivePollStatus(next);
          setStatus(next);
          const switched = Math.max(0, initialConnected - next.connected_agents);
          if (switched >= dispatchedCount || elapsed >= 30) {
            stopOutboundPolling();
            setMigrationStep("done");
          }
        } catch {
          if (elapsed >= 30) {
            stopOutboundPolling();
            setMigrationStep("done");
          }
        }
      }, 2000);
    },
    [stopOutboundPolling]
  );

  const validateCodeValue = (raw: string, required: boolean): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return required ? "请填写目标面板的迁移口令" : null;
    }
    if (!trimmed.startsWith("uobm1_")) {
      return "迁移口令格式不正确，请粘贴以 uobm1_ 开头的口令";
    }
    return null;
  };

  const validateUrlValue = (raw: string, required: boolean): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return required ? "请填写新面板的域名或访问地址" : null;
    }
    if (trimmed.startsWith("uobm1_")) {
      return "这里需要填写新面板网址，如果已有口令请切换到上方第一种方式";
    }
    return null;
  };

  const runSmartMigration = async (targetInput: string) => {
    if (useCanary && outboundMethod === "existing" && !canaryNodeId) {
      setError("请选择 1 台用于试路的服务器");
      return;
    }

    stopOutboundPolling();
    const startConnected = status?.connected_agents ?? onlineNodes.length;
    setBaselineConnected(startConnected);
    setLivePollStatus(status);
    setMigrating(true);
    setError(null);
    setMigrationError(null);
    setMigrationResult(null);
    setMigrationStep("connecting");

    try {
      const res = await api.smartMigrateHub({
        target_input: targetInput,
        ...(outboundMethod === "existing" && useCanary && canaryNodeId
          ? { node_ids: [canaryNodeId] }
          : {}),
        ...(allowInsecureWs && targetInput.toLowerCase().startsWith("http://")
          ? { allow_insecure_ws: true }
          : {}),
      });
      setMigrationResult(res);
      startOutboundPolling(res.dispatched, startConnected);
    } catch (err) {
      setMigrationStep("error");
      const msg = err instanceof Error ? err.message : "迁移失败，请检查网络或目标地址";
      setMigrationError(msg);
      setError(msg);
    } finally {
      setMigrating(false);
    }
  };

  const handleExistingMigrateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateCodeValue(migrationCodeInput, true);
    setCodeError(err);
    if (err) return;
    await runSmartMigration(migrationCodeInput.trim());
  };

  const handleNewPanelMigrateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateUrlValue(newPanelUrlInput, true);
    setUrlError(err);
    if (err) return;
    await runSmartMigration(newPanelUrlInput.trim());
  };

  const handleCreateInstallTicket = async () => {
    setGeneratingInstall(true);
    setError(null);
    try {
      const res = await api.createMigrationTicket({
        purpose: "install",
        enable_watchdog: true,
      });
      setInstallTicket(res);
      if (status?.mode === "cloudflare-worker") {
        void loadHubData();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成安装命令失败");
    } finally {
      setGeneratingInstall(false);
    }
  };

  const handleCreateReceiveTicket = async () => {
    setGeneratingReceive(true);
    setError(null);
    try {
      const res = await api.createMigrationTicket({ purpose: "receive" });
      setReceiveBaseTotal(status?.total_nodes ?? nodes.length);
      setReceiveBaseConnected(status?.connected_agents ?? onlineNodes.length);
      setReceiveTicket(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成迁移口令失败");
    } finally {
      setGeneratingReceive(false);
    }
  };

  const handleRestored = async () => {
    await onBundleImported?.();
    await loadHubData();
  };

  const isCloudflare = status?.mode === "cloudflare-worker";
  const runningModeText = status
    ? isCloudflare
      ? "当前运行在 Cloudflare 云端"
      : "当前运行在自建服务器"
    : loadingStatus
      ? "正在读取运行环境..."
      : "运行环境";

  const connectedAgents = status?.connected_agents ?? onlineNodes.length;
  const totalNodes = status?.total_nodes ?? nodes.length;
  const watchdogBadge = getWatchdogStatusBadge(status?.watchdog.status);

  const currentLiveConnected = livePollStatus?.connected_agents ?? connectedAgents;
  const dispatchedCount = migrationResult?.dispatched ?? 0;
  const switchedEstimate =
    dispatchedCount > 0
      ? Math.max(
          0,
          Math.min(dispatchedCount, baselineConnected - currentLiveConnected)
        )
      : 0;
  const progressPct =
    migrationStep === "done"
      ? 100
      : dispatchedCount > 0
        ? Math.min(95, Math.max(15, Math.round((switchedEstimate / dispatchedCount) * 100)))
        : 0;

  const arrivedTotalDelta = Math.max(0, totalNodes - receiveBaseTotal);
  const arrivedConnectedDelta = Math.max(
    0,
    connectedAgents - receiveBaseConnected
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {/* Compact Inline Summary Card */}
      <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
              <ArrowLeftRight
                className="h-4 w-4 text-emerald-500"
                aria-hidden="true"
              />
              面板迁移与运行模式
            </h3>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {isCloudflare ? (
                <Cloud className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
              ) : (
                <Server
                  className="h-3.5 w-3.5 text-emerald-500"
                  aria-hidden="true"
                />
              )}
              {runningModeText}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-slate-300">
            <span className="font-mono-num">
              已连接服务器 {connectedAgents} / {totalNodes} 台
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span>掉线提醒状态：</span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${watchdogBadge.tone}`}
              >
                {watchdogBadge.label}
              </span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadHubData()}
            disabled={loadingStatus}
            aria-label="刷新面板运行状态"
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loadingStatus ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            刷新状态
          </button>
          <button
            type="button"
            onClick={(e) => openModal("inbound", e.currentTarget)}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            迁入到此面板
          </button>
          <button
            type="button"
            onClick={(e) => openModal("outbound", e.currentTarget)}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-500"
          >
            迁往其他面板
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Accessible Migration & Mode Modal Dialog */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          >
            {/* Dialog Header */}
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <div>
                <h2
                  id={dialogTitleId}
                  className="text-base font-semibold text-slate-900 dark:text-slate-50"
                >
                  面板迁移与运行模式
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  在 Cloudflare 云端与自建服务器之间平滑切换，自动同步全部服务器与月度流量统计。
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeModal}
                aria-label="关闭窗口"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* Concise Status Bar inside Dialog */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3 dark:border-slate-800 dark:bg-slate-950/40">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-100">
                  {isCloudflare ? (
                    <Cloud
                      className="h-3.5 w-3.5 text-sky-500"
                      aria-hidden="true"
                    />
                  ) : (
                    <Server
                      className="h-3.5 w-3.5 text-emerald-500"
                      aria-hidden="true"
                    />
                  )}
                  {runningModeText}
                </span>
                <span className="font-mono-num text-slate-600 dark:text-slate-300">
                  已连接服务器 {connectedAgents} / {totalNodes} 台
                </span>
                <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                  <span>掉线提醒状态：</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${watchdogBadge.tone}`}
                  >
                    {watchdogBadge.label}
                  </span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => void loadHubData()}
                disabled={loadingStatus}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200"
              >
                <RefreshCw
                  className={`h-3 w-3 ${loadingStatus ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                刷新
              </button>
            </div>

            {/* Dialog Scrollable Body */}
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{error}</span>
                </div>
              )}

              {notice && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-700 dark:text-emerald-300"
                >
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{notice}</span>
                </div>
              )}

              {/* Accessible 2-Tab Switcher */}
              <div>
                <div
                  role="tablist"
                  aria-label="面板迁移方向"
                  className="flex gap-6 border-b border-slate-200 dark:border-slate-800"
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
                    className={`-mb-px border-b-2 pb-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                      activeTab === "outbound"
                        ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
                        : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    迁往其他面板
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
                    className={`-mb-px border-b-2 pb-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                      activeTab === "inbound"
                        ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
                        : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    迁入到此面板
                  </button>
                </div>

                {/* Tab 1: Outbound */}
                <div
                  id={outboundPanelId}
                  role="tabpanel"
                  aria-labelledby={outboundTabId}
                  hidden={activeTab !== "outbound"}
                  className="space-y-4 pt-4"
                >
                  <fieldset className="space-y-2.5">
                    <legend className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                      选择目标面板准备情况
                    </legend>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label
                        className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3.5 transition ${
                          outboundMethod === "existing"
                            ? "border-emerald-500 bg-emerald-500/5 dark:bg-emerald-500/10"
                            : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                        }`}
                      >
                        <input
                          type="radio"
                          name="outbound-method"
                          value="existing"
                          checked={outboundMethod === "existing"}
                          onChange={() => {
                            setOutboundMethod("existing");
                            setError(null);
                          }}
                          className="mt-0.5 h-4 w-4 accent-emerald-600"
                        />
                        <span className="space-y-0.5">
                          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                            已有目标面板（用迁移口令一键搬家）
                          </span>
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            新的 Cloudflare 或自建面板已在运行，粘贴口令即可搬家。
                          </span>
                        </span>
                      </label>

                      <label
                        className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3.5 transition ${
                          outboundMethod === "install"
                            ? "border-emerald-500 bg-emerald-500/5 dark:bg-emerald-500/10"
                            : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                        }`}
                      >
                        <input
                          type="radio"
                          name="outbound-method"
                          value="install"
                          checked={outboundMethod === "install"}
                          onChange={() => {
                            setOutboundMethod("install");
                            setError(null);
                          }}
                          className="mt-0.5 h-4 w-4 accent-emerald-600"
                        />
                        <span className="space-y-0.5">
                          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                            新装一台自建服务器并搬过去
                          </span>
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            一键生成安装命令，部署完成并自动同步全部历史数据。
                          </span>
                        </span>
                      </label>
                    </div>
                  </fieldset>

                  {outboundMethod === "existing" ? (
                    <form
                      noValidate
                      onSubmit={(e) => void handleExistingMigrateSubmit(e)}
                      className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/30"
                    >
                      <div>
                        <label
                          htmlFor={codeInputId}
                          className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-200"
                        >
                          目标面板迁移口令
                        </label>
                        <input
                          id={codeInputId}
                          type="text"
                          value={migrationCodeInput}
                          onChange={(e) => {
                            setMigrationCodeInput(e.target.value);
                            if (codeError) setCodeError(null);
                          }}
                          onBlur={() =>
                            setCodeError(
                              validateCodeValue(migrationCodeInput, false)
                            )
                          }
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          placeholder="粘贴新面板生成的 uobm1_ 开头迁移口令"
                          aria-invalid={Boolean(codeError)}
                          aria-describedby={codeError ? codeErrorId : codeHelpId}
                          className={`w-full rounded-lg border bg-white px-3 py-2 font-mono text-sm text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:ring-2 dark:bg-slate-900 dark:text-slate-100 ${
                            codeError
                              ? "border-rose-500 focus:ring-rose-500/30"
                              : "border-slate-300 focus:border-emerald-500 focus:ring-emerald-500/30 dark:border-slate-700"
                          }`}
                        />
                        {codeError ? (
                          <p
                            id={codeErrorId}
                            className="mt-1.5 text-xs text-rose-600 dark:text-rose-400"
                          >
                            {codeError}
                          </p>
                        ) : (
                          <p
                            id={codeHelpId}
                            className="mt-1.5 text-xs text-slate-500 dark:text-slate-400"
                          >
                            在目标面板打开「迁入到此面板」即可一键生成口令（30 分钟内有效）。
                          </p>
                        )}
                      </div>

                      <div className="space-y-2.5">
                        <label
                          htmlFor={canaryCheckId}
                          className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700 dark:text-slate-300"
                        >
                          <input
                            id={canaryCheckId}
                            type="checkbox"
                            checked={useCanary}
                            onChange={(e) => setUseCanary(e.target.checked)}
                            className="h-4 w-4 rounded accent-emerald-600"
                          />
                          <span>先用 1 台在线服务器试路，确认无误后再全部切换</span>
                        </label>

                        {useCanary && (
                          <div className="pl-6">
                            <label
                              htmlFor={canarySelectId}
                              className="mb-1 block text-xs text-slate-600 dark:text-slate-400"
                            >
                              选择试路服务器
                            </label>
                            {orderedCanaryNodes.length === 0 ? (
                              <p className="text-xs text-amber-600 dark:text-amber-400">
                                当前没有可选服务器，取消勾选可直接同步全局配置。
                              </p>
                            ) : (
                              <select
                                id={canarySelectId}
                                value={canaryNodeId}
                                onChange={(e) => setCanaryNodeId(e.target.value)}
                                className="w-full max-w-sm rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                              >
                                {orderedCanaryNodes.map((n) => (
                                  <option key={n.id} value={n.id}>
                                    {n.name}（{n.online ? "在线" : "离线"}）
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          过程不断线，若新面板异常 1 分钟内自动切回。
                        </span>
                        <button
                          type="submit"
                          disabled={migrating}
                          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-60"
                        >
                          {migrating && (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          一键同步并切换
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/30">
                      {/* Step 1: Generate one-line install command */}
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                              第 1 步：在新服务器部署自建面板
                            </h3>
                            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                              命令会自动同步全部服务器、流量统计、登录密码，并开启 Cloudflare 云端掉线提醒。
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleCreateInstallTicket()}
                            disabled={generatingInstall}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-500/20 disabled:opacity-60 dark:text-emerald-300"
                          >
                            {generatingInstall && (
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin"
                                aria-hidden="true"
                              />
                            )}
                            {installTicket ? "重新生成命令" : "生成一键安装命令"}
                          </button>
                        </div>

                        {installTicket?.install_cmd && (
                          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                在新 Linux 服务器终端执行（30 分钟内有效）
                              </span>
                              <CopyButton
                                text={installTicket.install_cmd}
                                label="复制命令"
                                ariaLabel="复制新服务器一键安装命令"
                              />
                            </div>
                            <pre className="overflow-x-auto rounded bg-slate-950 p-2.5 font-mono text-xs leading-relaxed text-emerald-300">
                              {installTicket.install_cmd}
                            </pre>
                          </div>
                        )}
                      </div>

                      {/* Step 2: Detect new panel & switch */}
                      <form
                        noValidate
                        onSubmit={(e) => void handleNewPanelMigrateSubmit(e)}
                        className="space-y-3 border-t border-slate-200 pt-3.5 dark:border-slate-800"
                      >
                        <div>
                          <label
                            htmlFor={urlInputId}
                            className="mb-1 block text-xs font-semibold text-slate-800 dark:text-slate-100"
                          >
                            第 2 步：输入新面板访问地址并切换
                          </label>
                          <input
                            id={urlInputId}
                            type="text"
                            value={newPanelUrlInput}
                            onChange={(e) => {
                              setNewPanelUrlInput(e.target.value);
                              if (urlError) setUrlError(null);
                            }}
                            onBlur={() =>
                              setUrlError(
                                validateUrlValue(newPanelUrlInput, false)
                              )
                            }
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            placeholder="例如：hub.example.com 或 https://hub.example.com"
                            aria-invalid={Boolean(urlError)}
                            aria-describedby={urlError ? urlErrorId : urlHelpId}
                            className={`w-full rounded-lg border bg-white px-3 py-2 font-mono text-sm text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:ring-2 dark:bg-slate-900 dark:text-slate-100 ${
                              urlError
                                ? "border-rose-500 focus:ring-rose-500/30"
                                : "border-slate-300 focus:border-emerald-500 focus:ring-emerald-500/30 dark:border-slate-700"
                            }`}
                          />
                          {urlError ? (
                            <p
                              id={urlErrorId}
                              className="mt-1.5 text-xs text-rose-600 dark:text-rose-400"
                            >
                              {urlError}
                            </p>
                          ) : (
                            <p
                              id={urlHelpId}
                              className="mt-1.5 text-xs text-slate-500 dark:text-slate-400"
                            >
                              新服务器部署完成后，填写分配给新面板的域名或访问地址（未写协议默认按 HTTPS 连接）。
                            </p>
                          )}
                        </div>

                        {newPanelUrlInput.trim().toLowerCase().startsWith("http://") && (
                          <label
                            htmlFor={insecureWsId}
                            className="inline-flex cursor-pointer items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
                          >
                            <input
                              id={insecureWsId}
                              type="checkbox"
                              checked={allowInsecureWs}
                              onChange={(e) => setAllowInsecureWs(e.target.checked)}
                              className="h-4 w-4 rounded accent-amber-600"
                            />
                            <span>允许非 HTTPS 明文连接（仅内网或测试环境使用）</span>
                          </label>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            过程不断线，若新面板异常 1 分钟内自动切回。
                          </span>
                          <button
                            type="submit"
                            disabled={migrating}
                            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-60"
                          >
                            {migrating && (
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin"
                                aria-hidden="true"
                              />
                            )}
                            检测新面板并切换
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {/* 3-Step Visual Progress Tracker */}
                  <MigrationProgressTracker
                    step={migrationStep}
                    error={migrationError}
                    result={migrationResult}
                    dispatchedCount={dispatchedCount}
                    switchedEstimate={switchedEstimate}
                    currentLiveConnected={currentLiveConnected}
                    pollElapsedSec={pollElapsedSec}
                    progressPct={progressPct}
                  />
                </div>

                {/* Tab 2: Inbound */}
                <div
                  id={inboundPanelId}
                  role="tabpanel"
                  aria-labelledby={inboundTabId}
                  hidden={activeTab !== "inbound"}
                  className="space-y-4 pt-4"
                >
                  <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/30">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                          生成迁移口令接收原面板数据
                        </h3>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          自动接收原面板的全部服务器、通知渠道、告警规则与历史流量统计。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCreateReceiveTicket()}
                        disabled={generatingReceive}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-60"
                      >
                        {generatingReceive && (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        {receiveTicket ? "重新生成口令" : "生成迁移口令"}
                      </button>
                    </div>

                    {receiveTicket?.migration_code && (
                      <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900">
                          <code className="break-all font-mono text-xs text-emerald-700 dark:text-emerald-300">
                            {receiveTicket.migration_code}
                          </code>
                          <CopyButton
                            text={receiveTicket.migration_code}
                            label="复制口令"
                            ariaLabel="复制迁移口令"
                          />
                        </div>

                        <ol className="list-inside list-decimal space-y-1 text-xs text-slate-600 dark:text-slate-300">
                          <li>复制上方迁移口令（30 分钟内有效）。</li>
                          <li>
                            打开原面板的「服务器管理 → 面板迁移与运行模式 → 迁往其他面板」，粘贴口令并点击「一键同步并切换」。
                          </li>
                        </ol>

                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-800 dark:text-sky-200">
                          <span className="flex items-center gap-2">
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin text-sky-500"
                              aria-hidden="true"
                            />
                            <span className="font-mono-num">
                              实时等待接入中 · 当前已连接服务器 {connectedAgents} /{" "}
                              {totalNodes} 台
                            </span>
                          </span>
                          {(arrivedTotalDelta > 0 || arrivedConnectedDelta > 0) && (
                            <span className="font-medium text-emerald-700 dark:text-emerald-300">
                              新迁入 {arrivedTotalDelta} 台配置 · 在线 +{arrivedConnectedDelta} 台
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Cloudflare-only: Self-hosted Watchdog Configuration */}
              {isCloudflare && (
                <WatchdogSettingsSection
                  config={watchdogConfig}
                  channels={channels}
                  badge={watchdogBadge}
                  onChangeConfig={setWatchdogConfig}
                  onError={setError}
                  onReloadStatus={loadHubData}
                />
              )}

              {/* Collapsible Backup & Restore */}
              <BackupRestoreSection
                onError={setError}
                onNotice={setNotice}
                onRestored={handleRestored}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
