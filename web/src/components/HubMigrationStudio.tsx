import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Download,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react";
import type {
  CfWorkersPlan,
  ExportBundle,
  HorizonNode,
  HubStatusResponse,
  MigrationTicketResponse,
  NotificationChannel,
  SmartMigrateResponse,
  WatchdogConfig,
} from "../types";
import { api } from "../api/client";
import {
  formatBytes,
  formatRelativeTime,
  formatTimestamp,
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
  Select,
  StatusDot,
  Switch,
} from "./ui/Primitives";

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

type MigrationDirection = "outbound" | "inbound";
type CutoverPhase = "idle" | "connecting" | "polling" | "done" | "error";

interface PendingBackupFile {
  fileName: string;
  bundle: ExportBundle;
  nodesCount: number;
  rulesCount: number;
  channelsCount: number;
  exportedAt: number | null;
}

const TIMEOUT_OPTIONS = [
  { sec: 600, label: "10 分钟" },
  { sec: 900, label: "15 分钟" },
  { sec: 1800, label: "30 分钟" },
] as const;

function generateRandomSecret(byteLen = 24): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const CF_MANUAL_PLAN_STORAGE_KEY = "uniob_cf_plan_manual";
const CF_PLAN_OPTIONS: Array<{ value: CfWorkersPlan; label: string }> = [
  { value: "free", label: "Free 免费版" },
  { value: "paid", label: "Workers Paid" },
];

function readLocalCfPlan(): CfWorkersPlan | null {
  try {
    const raw = window.localStorage.getItem(CF_MANUAL_PLAN_STORAGE_KEY);
    return raw === "paid" || raw === "free" ? raw : null;
  } catch {
    return null;
  }
}

function writeLocalCfPlan(plan: CfWorkersPlan): void {
  try {
    window.localStorage.setItem(CF_MANUAL_PLAN_STORAGE_KEY, plan);
  } catch {
    // Ignore storage restriction
  }
}

function formatQuotaCount(n: number): string {
  const safe = Math.max(0, Math.round(n));
  if (safe >= 1_000_000) {
    const m = safe / 1_000_000;
    return `${(m >= 10 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, "")}M`;
  }
  if (safe >= 10_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return safe.toLocaleString("en-US");
}

function formatQuotaPct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function formatCountdown(expiresAtSec: number, nowSec: number): string {
  const rem = Math.max(0, expiresAtSec - nowSec);
  if (rem === 0) return "已过期";
  const mins = Math.floor(rem / 60);
  const secs = rem % 60;
  return mins > 0
    ? `${mins}:${String(secs).padStart(2, "0")}`
    : `${secs}s`;
}

export function HubMigrationStudio(
  props: HubMigrationStudioProps,
): React.JSX.Element {
  const { nodes, hubStatus, onDataChanged, onNotify } = props;

  const targetInputId = useId();
  const wdModalTitleId = useId();
  const importModalTitleId = useId();
  const cloudDetailsId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onDataChangedRef = useRef(onDataChanged);
  onDataChangedRef.current = onDataChanged;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;

  const [liveStatus, setLiveStatus] = useState<HubStatusResponse | null>(
    hubStatus,
  );
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [showCloudDetails, setShowCloudDetails] = useState(false);
  const [manualPlanOverride, setManualPlanOverride] =
    useState<CfWorkersPlan | null>(() => readLocalCfPlan());

  useEffect(() => {
    if (hubStatus) setLiveStatus(hubStatus);
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
        // Parent handles top-level connectivity
      });
    return () => {
      cancelled = true;
    };
  }, [hubStatus]);

  const effectiveStatus = liveStatus ?? hubStatus;
  const hubMode = effectiveStatus?.mode ?? null;
  const isCloudflare = hubMode === "cloudflare-worker";
  const isSelfHosted = hubMode === "self-hosted-hub";

  useEffect(() => {
    const serverManual = effectiveStatus?.cloudflare_quota?.manual_plan;
    if (serverManual === "free" || serverManual === "paid") {
      setManualPlanOverride(serverManual);
      writeLocalCfPlan(serverManual);
    }
  }, [effectiveStatus?.cloudflare_quota?.manual_plan]);

  const handleSelectCfPlan = async (nextPlan: CfWorkersPlan) => {
    setManualPlanOverride(nextPlan);
    writeLocalCfPlan(nextPlan);
    setLiveStatus((prev) => {
      const base = prev ?? hubStatus;
      if (!base?.cloudflare_quota) return prev;
      const detected = base.cloudflare_quota.detected_plan;
      return {
        ...base,
        cloudflare_quota: {
          ...base.cloudflare_quota,
          manual_plan: nextPlan,
          effective_plan: detected ?? nextPlan,
          plan_source: detected ? base.cloudflare_quota.plan_source : "manual",
        },
      };
    });
    try {
      await api.updateCfPlan(nextPlan);
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "保存 Cloudflare 套餐档位失败",
      );
    }
  };

  const onlineNodes = useMemo(() => nodes.filter((n) => n.online), [nodes]);
  const orderedNodes = useMemo(
    () => [...onlineNodes, ...nodes.filter((n) => !n.online)],
    [nodes, onlineNodes],
  );

  // Self-hosted one-click install ticket
  const [installTicket, setInstallTicket] =
    useState<MigrationTicketResponse | null>(null);
  const [generatingInstall, setGeneratingInstall] = useState(false);

  // Smooth Migration state
  const [direction, setDirection] = useState<MigrationDirection>("outbound");
  const [targetInput, setTargetInput] = useState("");
  const [pilotOnly, setPilotOnly] = useState(false);
  const [pilotNodeId, setPilotNodeId] = useState(
    () => orderedNodes[0]?.id ?? "",
  );
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);

  const [migrating, setMigrating] = useState(false);
  const [cutoverPhase, setCutoverPhase] = useState<CutoverPhase>("idle");
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] =
    useState<SmartMigrateResponse | null>(null);
  const [baselineConnected, setBaselineConnected] = useState(0);
  const [lastWasPilot, setLastWasPilot] = useState(false);
  const [lastTargetUsed, setLastTargetUsed] = useState("");
  const outboundPollRef = useRef<number | null>(null);

  // Inbound receive ticket state
  const [receiveTicket, setReceiveTicket] =
    useState<MigrationTicketResponse | null>(null);
  const [generatingReceive, setGeneratingReceive] = useState(false);
  const inboundPollRef = useRef<number | null>(null);
  const lastInboundCountsRef = useRef<{ total: number; connected: number }>({
    total: 0,
    connected: 0,
  });

  // Shared 1s clock for active ticket countdowns
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

  useEffect(() => {
    if (orderedNodes.length === 0) {
      if (pilotNodeId) setPilotNodeId("");
      return;
    }
    if (!pilotNodeId || !orderedNodes.some((n) => n.id === pilotNodeId)) {
      setPilotNodeId(orderedNodes[0].id);
    }
  }, [orderedNodes, pilotNodeId]);

  const stopOutboundPolling = useCallback(() => {
    if (outboundPollRef.current !== null) {
      window.clearInterval(outboundPollRef.current);
      outboundPollRef.current = null;
    }
  }, []);

  const stopInboundPolling = useCallback(() => {
    if (inboundPollRef.current !== null) {
      window.clearInterval(inboundPollRef.current);
      inboundPollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopOutboundPolling();
      stopInboundPolling();
    };
  }, [stopOutboundPolling, stopInboundPolling]);

  // Cloudflare-only Watchdog Config (CRITICAL DUAL-MODE GUARD)
  const [wdConfig, setWdConfig] = useState<WatchdogConfig>({
    enabled: false,
    secret: "",
    timeout_sec: 900,
    cooldown_sec: 1800,
    hub_label: "自建服务端",
    channel_ids: [],
  });
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [wdModalOpen, setWdModalOpen] = useState(false);
  const [savingWd, setSavingWd] = useState(false);

  const loadWatchdogAux = useCallback(async () => {
    if (hubMode !== "cloudflare-worker") return;
    try {
      const [wdRes, chRes] = await Promise.all([
        api.getWatchdogConfig(),
        api.getChannels(),
      ]);
      setWdConfig(wdRes);
      setChannels(Array.isArray(chRes?.channels) ? chRes.channels : []);
    } catch {
      // Non-blocking auxiliary fetch
    }
  }, [hubMode]);

  useEffect(() => {
    if (hubMode !== "cloudflare-worker") return;
    void loadWatchdogAux();
  }, [hubMode, loadWatchdogAux]);

  // Inbound live 2s polling while inbound ticket is active
  useEffect(() => {
    stopInboundPolling();
    const cur = Math.floor(Date.now() / 1000);
    if (
      direction !== "inbound" ||
      !receiveTicket ||
      receiveTicket.expires_at <= cur
    ) {
      return;
    }

    inboundPollRef.current = window.setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      setNowSec(now);
      if (now >= receiveTicket.expires_at) {
        stopInboundPolling();
        return;
      }
      try {
        const next = await api.getHubStatus();
        setLiveStatus(next);
        const prev = lastInboundCountsRef.current;
        if (
          next.total_nodes !== prev.total ||
          next.connected_agents !== prev.connected
        ) {
          lastInboundCountsRef.current = {
            total: next.total_nodes,
            connected: next.connected_agents,
          };
          await onDataChangedRef.current();
        }
      } catch {
        // Ignore transient network hiccup
      }
    }, 2000);

    return () => stopInboundPolling();
  }, [direction, receiveTicket, stopInboundPolling]);

  // Backup & Restore state
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastBackupNote, setLastBackupNote] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingBackupFile | null>(
    null,
  );

  const handleRefreshStatus = async () => {
    if (refreshingStatus) return;
    setRefreshingStatus(true);
    try {
      const [next] = await Promise.all([
        api.getHubStatus({ refresh: true }),
        onDataChanged(),
      ]);
      setLiveStatus(next);
      if (next.mode === "cloudflare-worker") {
        await loadWatchdogAux();
      }
      onNotify("success", "服务状态已刷新");
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "刷新状态失败",
      );
    } finally {
      setRefreshingStatus(false);
    }
  };

  const handleGenerateInstallCmd = async () => {
    if (generatingInstall) return;
    setGeneratingInstall(true);
    try {
      const res = await api.createMigrationTicket({
        purpose: "install",
        enable_watchdog: true,
      });
      setNowSec(Math.floor(Date.now() / 1000));
      setInstallTicket(res);
      onNotify("success", "已生成自建服务端一键部署命令");
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "生成部署命令失败",
      );
    } finally {
      setGeneratingInstall(false);
    }
  };

  const handleGenerateReceiveCode = async () => {
    if (generatingReceive) return;
    setGeneratingReceive(true);
    try {
      const res = await api.createMigrationTicket({ purpose: "receive" });
      setNowSec(Math.floor(Date.now() / 1000));
      lastInboundCountsRef.current = {
        total: effectiveStatus?.total_nodes ?? nodes.length,
        connected: effectiveStatus?.connected_agents ?? onlineNodes.length,
      };
      setReceiveTicket(res);
      onNotify("success", "接收口令已生成，有效期 15 分钟");
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "生成接收口令失败",
      );
    } finally {
      setGeneratingReceive(false);
    }
  };

  const startOutboundPolling = useCallback(
    (dispatchedCount: number, initialConnected: number, isPilot: boolean) => {
      stopOutboundPolling();
      if (dispatchedCount <= 0) {
        setCutoverPhase("done");
        void onDataChangedRef.current();
        onNotifyRef.current("success", "配置与数据已同步至目标面板");
        return;
      }

      setCutoverPhase("polling");
      let elapsed = 0;
      outboundPollRef.current = window.setInterval(async () => {
        elapsed += 2;
        try {
          const next = await api.getHubStatus();
          setLiveStatus(next);
          const switched = Math.max(
            0,
            initialConnected - next.connected_agents,
          );
          if (switched >= dispatchedCount || elapsed >= 30) {
            stopOutboundPolling();
            setCutoverPhase("done");
            void onDataChangedRef.current();
            onNotifyRef.current(
              "success",
              isPilot
                ? "试迁服务器已完成平滑切换"
                : `已完成 ${dispatchedCount} 台服务器平滑迁移`,
            );
          }
        } catch {
          if (elapsed >= 30) {
            stopOutboundPolling();
            setCutoverPhase("done");
            void onDataChangedRef.current();
          }
        }
      }, 2000);
    },
    [stopOutboundPolling],
  );

  const executeSmartMigration = async (
    rawTarget: string,
    forceAllNodes = false,
  ) => {
    const trimmed = rawTarget.trim();
    if (!trimmed) {
      setMigrationError("请填写目标面板地址或接收口令");
      return;
    }

    const isPilot = !forceAllNodes && pilotOnly && Boolean(pilotNodeId);
    stopOutboundPolling();
    const initialConn =
      effectiveStatus?.connected_agents ?? onlineNodes.length;
    setBaselineConnected(initialConn);
    setMigrating(true);
    setMigrationError(null);
    setMigrationResult(null);
    setLastWasPilot(isPilot);
    setLastTargetUsed(trimmed);
    setCutoverPhase("connecting");

    try {
      const res = await api.smartMigrateHub({
        target_input: trimmed,
        ...(isPilot ? { node_ids: [pilotNodeId] } : {}),
        ...(allowInsecureHttp && trimmed.toLowerCase().startsWith("http://")
          ? { allow_insecure_ws: true }
          : {}),
      });
      setMigrationResult(res);
      startOutboundPolling(res.dispatched, initialConn, isPilot);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "迁移请求失败，请检查目标地址或口令";
      setCutoverPhase("error");
      setMigrationError(msg);
      onNotify("danger", "平滑迁移未完成", msg);
    } finally {
      setMigrating(false);
    }
  };

  const handleToggleWatchdogQuick = async (nextEnabled: boolean) => {
    if (!isCloudflare || savingWd) return;
    const nextPayload: WatchdogConfig = {
      ...wdConfig,
      enabled: nextEnabled,
      secret:
        nextEnabled && !wdConfig.secret.trim()
          ? generateRandomSecret()
          : wdConfig.secret,
    };
    setSavingWd(true);
    try {
      const saved = await api.updateWatchdogConfig(nextPayload);
      setWdConfig(saved);
      const latest = await api.getHubStatus();
      setLiveStatus(latest);
      onNotify(
        "info",
        saved.enabled ? "已开启掉线提醒" : "已关闭掉线提醒",
      );
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "更新掉线提醒失败",
      );
    } finally {
      setSavingWd(false);
    }
  };

  const handleSaveWatchdogModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isCloudflare || savingWd) return;
    const payload: WatchdogConfig = {
      ...wdConfig,
      secret: wdConfig.secret.trim() || generateRandomSecret(),
    };
    setSavingWd(true);
    try {
      const saved = await api.updateWatchdogConfig(payload);
      setWdConfig(saved);
      const latest = await api.getHubStatus();
      setLiveStatus(latest);
      setWdModalOpen(false);
      onNotify("success", "掉线提醒配置已保存");
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "保存掉线提醒配置失败",
      );
    } finally {
      setSavingWd(false);
    }
  };

  const handleExportBackup = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const bundle = await api.exportBundle();
      const jsonText = JSON.stringify(bundle, null, 2);
      const blob = new Blob([jsonText], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = `uniob-backup-${datePart}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const sizeKb = Math.max(1, Math.round(jsonText.length / 1024));
      setLastBackupNote(`已导出 ${sizeKb} KB`);
      onNotify("success", `备份文件已导出（${sizeKb} KB）`);
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "导出备份失败",
      );
    } finally {
      setExporting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        onNotify("danger", "备份文件格式无效");
        return;
      }
      const bundle = parsed as ExportBundle;
      setPendingImport({
        fileName: file.name,
        bundle,
        nodesCount: Array.isArray(bundle.nodes) ? bundle.nodes.length : 0,
        rulesCount: Array.isArray(bundle.alert_rules)
          ? bundle.alert_rules.length
          : 0,
        channelsCount: Array.isArray(bundle.notification_channels)
          ? bundle.notification_channels.length
          : 0,
        exportedAt:
          typeof bundle.exported_at === "number" ? bundle.exported_at : null,
      });
    } catch {
      onNotify("danger", "无法解析所选 JSON 备份文件");
    }
  };

  const handleConfirmImport = async () => {
    if (!pendingImport || importing) return;
    setImporting(true);
    try {
      const res = await api.importBundle(pendingImport.bundle);
      await onDataChanged();
      setLastBackupNote(`已恢复 ${res.imported.nodes} 台服务器配置`);
      setPendingImport(null);
      onNotify(
        "success",
        `已恢复 ${res.imported.nodes} 台服务器与 ${res.imported.rules} 条规则`,
      );
    } catch (err) {
      onNotify(
        "danger",
        err instanceof Error ? err.message : "导入恢复失败",
      );
    } finally {
      setImporting(false);
    }
  };

  const connectedAgents =
    effectiveStatus?.connected_agents ?? onlineNodes.length;
  const totalNodes = effectiveStatus?.total_nodes ?? nodes.length;
  const onlineRatioPct =
    totalNodes > 0 ? Math.round((connectedAgents / totalNodes) * 100) : 0;

  const cfQuota = effectiveStatus?.cloudflare_quota;
  const detectedCfPlan: CfWorkersPlan | null = cfQuota?.detected_plan ?? null;
  const effectiveCfPlan: CfWorkersPlan =
    detectedCfPlan ??
    manualPlanOverride ??
    cfQuota?.manual_plan ??
    cfQuota?.effective_plan ??
    "free";

  const fallbackNqNodes = useMemo(
    () => nodes.filter((n) => n.metrics?.network_quality?.enabled).length,
    [nodes],
  );
  const estDailyWrites =
    cfQuota?.est_daily_do_writes ??
    (totalNodes > 0 ? 888 * totalNodes + 96 + fallbackNqNodes * 1034 : 0);
  const estDailyRequests =
    cfQuota?.est_daily_do_requests ??
    (totalNodes > 0 ? Math.round(14.4 * totalNodes + 96) : 0);
  const estSteadyStorageBytes =
    cfQuota?.est_steady_storage_bytes ??
    totalNodes * 1_840_000 + fallbackNqNodes * 17_707_932;
  const doStorageBytes = cfQuota?.do_storage_bytes ?? null;

  const estMonthlyWrites = estDailyWrites * 30;
  const cfWritePct =
    effectiveCfPlan === "paid"
      ? (estMonthlyWrites / 50_000_000) * 100
      : (estDailyWrites / 100_000) * 100;
  const cfWriteLabel =
    effectiveCfPlan === "paid"
      ? isCloudflare
        ? "DO SQLite 月写入配额（预估）"
        : "迁回云端预计月写入配额"
      : isCloudflare
        ? "DO SQLite 日写入配额（预估）"
        : "迁回云端预计日写入配额";
  const cfWriteValueLabel =
    effectiveCfPlan === "paid"
      ? `${formatQuotaCount(estMonthlyWrites)} / 50M (${formatQuotaPct(cfWritePct)})`
      : `${formatQuotaCount(estDailyWrites)} / 100k (${formatQuotaPct(cfWritePct)})`;

  const perNodeWritesAvg =
    totalNodes > 0
      ? Math.max(888, Math.round((estDailyWrites - 96) / totalNodes))
      : 888;
  const freeMaxNodes = Math.max(1, Math.floor((100_000 - 96) / perNodeWritesAvg));
  const cfStorageLimitLabel = effectiveCfPlan === "paid" ? "5 GB" : "1 GB";
  const cfStorageDisplay =
    doStorageBytes !== null
      ? `${formatBytes(doStorageBytes)} / ${cfStorageLimitLabel}`
      : `~${formatBytes(estSteadyStorageBytes)} / ${cfStorageLimitLabel}`;
  const cfRequestsDisplay =
    effectiveCfPlan === "paid"
      ? `${formatQuotaCount(estDailyRequests * 30)} / 1M · 月`
      : `${formatQuotaCount(estDailyRequests)} / 100k · 日`;
  const cfCapacityDisplay =
    effectiveCfPlan === "paid"
      ? `${totalNodes} 台 · 充裕`
      : `${totalNodes} / ~${freeMaxNodes} 台`;
  const cfVersionDisplay = effectiveStatus?.version
    ? `v${effectiveStatus.version.replace(/^v/, "")}`
    : "—";

  const dispatchedCount = migrationResult?.dispatched ?? 0;
  const switchedCount =
    cutoverPhase === "done"
      ? dispatchedCount
      : cutoverPhase === "polling"
        ? Math.min(
            dispatchedCount,
            Math.max(0, baselineConnected - connectedAgents),
          )
        : 0;

  const stepIndex: 0 | 1 | 2 =
    cutoverPhase === "done" ? 2 : cutoverPhase === "polling" ? 1 : 0;
  const steps = ["连接校验", "平滑切换", "完成"] as const;

  const wdStatus = effectiveStatus?.watchdog.status ?? "disabled";
  const wdDotTone =
    wdStatus === "healthy"
      ? "ok"
      : wdStatus === "waiting"
        ? "warn"
        : wdStatus === "stale"
          ? "danger"
          : "idle";
  const wdLabelText = !isCloudflare
    ? "自建端在线运行中"
    : !wdConfig.enabled
      ? "未开启"
      : wdStatus === "healthy"
        ? `正常 · ${formatRelativeTime(effectiveStatus?.watchdog.last_ping_ts)}`
        : wdStatus === "stale"
          ? "连接超时告警中"
          : "等待首次信号";

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <SectionHeader
        title="服务与迁移"
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={refreshingStatus}
            icon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshingStatus ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            }
            onClick={() => void handleRefreshStatus()}
          >
            刷新状态
          </Button>
        }
      />

      {/* Block 1: 运行模式 */}
      <section className="space-y-3">
        <h3
          style={{ color: "var(--text-secondary)" }}
          className="text-[13px] font-medium"
        >
          运行模式
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Card 1: Cloudflare 云端托管 */}
          <Card
            style={{
              borderColor: isCloudflare
                ? "var(--accent-border)"
                : "var(--border-hairline)",
            }}
            className="flex flex-col justify-between gap-5 p-5"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    style={{
                      backgroundColor: "var(--accent-soft)",
                      color: "var(--accent-ink)",
                      border: "1px solid var(--accent-border)",
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[8px]"
                  >
                    <Cloud className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <div
                      style={{ color: "var(--text-primary)" }}
                      className="text-[15px] font-semibold"
                    >
                      Cloudflare 云端托管
                    </div>
                    <div
                      style={{ color: "var(--text-tertiary)" }}
                      className="text-[12px]"
                    >
                      全球边缘接入 · 免维护部署
                    </div>
                  </div>
                </div>

                {isCloudflare ? (
                  <Badge tone="accent">当前使用</Badge>
                ) : (
                  <Badge tone="neutral">支持随时迁回</Badge>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex items-center gap-1.5">
                  <span style={{ color: "var(--text-tertiary)" }}>
                    套餐档位
                  </span>
                  {detectedCfPlan !== null && (
                    <span
                      style={{
                        color: "var(--text-tertiary)",
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[4px] px-1.5 py-0.5 text-[10.5px] leading-none"
                    >
                      自动识别
                    </span>
                  )}
                </div>

                {detectedCfPlan !== null ? (
                  detectedCfPlan === "paid" ? (
                    <Badge tone="accent">Workers Paid</Badge>
                  ) : (
                    <Badge tone="neutral">Workers Free</Badge>
                  )
                ) : (
                  <SegmentedControl<CfWorkersPlan>
                    size="xs"
                    ariaLabel="选择 Cloudflare 套餐档位"
                    value={effectiveCfPlan}
                    onChange={(next) => void handleSelectCfPlan(next)}
                    options={CF_PLAN_OPTIONS}
                  />
                )}
              </div>

              <MetricBar
                label={cfWriteLabel}
                valueLabel={cfWriteValueLabel}
                valuePct={cfWritePct}
                thickness={4}
              />

              <div>
                <button
                  type="button"
                  aria-expanded={showCloudDetails}
                  aria-controls={cloudDetailsId}
                  onClick={() => setShowCloudDetails((v) => !v)}
                  style={{ color: "var(--text-tertiary)" }}
                  className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium hover:text-[var(--text-primary)]"
                >
                  <span>{showCloudDetails ? "收起细项" : "查看细项"}</span>
                  {showCloudDetails ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>

                {showCloudDetails && (
                  <div
                    id={cloudDetailsId}
                    className="mt-2.5 grid grid-cols-2 gap-2"
                  >
                    <div
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[8px] px-3 py-2"
                    >
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[11px]"
                      >
                        {doStorageBytes !== null
                          ? "DO SQLite 实时存储"
                          : "DO SQLite 稳态存储"}
                      </div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="font-mono-num tabular-nums mt-0.5 text-[13px] font-semibold"
                      >
                        {cfStorageDisplay}
                      </div>
                    </div>

                    <div
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[8px] px-3 py-2"
                    >
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[11px]"
                      >
                        DO 请求配额（预估）
                      </div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="font-mono-num tabular-nums mt-0.5 text-[13px] font-semibold"
                      >
                        {cfRequestsDisplay}
                      </div>
                    </div>

                    <div
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[8px] px-3 py-2"
                    >
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[11px]"
                      >
                        建议承载规模
                      </div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="font-mono-num tabular-nums mt-0.5 text-[13px] font-semibold"
                      >
                        {cfCapacityDisplay}
                      </div>
                    </div>

                    <div
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="rounded-[8px] px-3 py-2"
                    >
                      <div
                        style={{ color: "var(--text-tertiary)" }}
                        className="text-[11px]"
                      >
                        节点状态 · 版本
                      </div>
                      <div
                        style={{ color: "var(--text-primary)" }}
                        className="font-mono-num tabular-nums mt-0.5 text-[13px] font-semibold"
                      >
                        {connectedAgents}/{totalNodes} 在线 · {cfVersionDisplay}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Card 2: 自建服务端 */}
          <Card
            style={{
              borderColor: isSelfHosted
                ? "var(--status-ok-border)"
                : "var(--border-hairline)",
            }}
            className="flex flex-col justify-between gap-5 p-5"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-hairline)",
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[8px]"
                  >
                    <Server className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <div
                      style={{ color: "var(--text-primary)" }}
                      className="text-[15px] font-semibold"
                    >
                      自建服务端
                    </div>
                    <div
                      style={{ color: "var(--text-tertiary)" }}
                      className="text-[12px]"
                    >
                      无额度限制 · 本地独立存储
                    </div>
                  </div>
                </div>

                {isSelfHosted ? (
                  <Badge tone="ok">当前使用</Badge>
                ) : (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={generatingInstall}
                    icon={
                      generatingInstall ? (
                        <Loader2
                          className="h-3 w-3 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Sparkles className="h-3 w-3" aria-hidden="true" />
                      )
                    }
                    onClick={() => void handleGenerateInstallCmd()}
                  >
                    生成部署命令
                  </Button>
                )}
              </div>

              {isSelfHosted ? (
                <MetricBar
                  label="当前自建节点在线率"
                  valueLabel={`${connectedAgents} / ${totalNodes}`}
                  valuePct={onlineRatioPct}
                  toneOverride="ok"
                  thickness={4}
                />
              ) : installTicket?.install_cmd &&
                installTicket.expires_at > nowSec ? (
                <div
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-hairline)",
                  }}
                  className="space-y-2 rounded-[8px] p-3"
                >
                  <code
                    style={{ color: "var(--text-primary)" }}
                    className="block break-all font-mono text-[11.5px] leading-relaxed"
                  >
                    {installTicket.install_cmd}
                  </code>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      style={{ color: "var(--text-tertiary)" }}
                      className="font-mono-num tabular-nums text-[11px]"
                    >
                      有效期 {formatCountdown(installTicket.expires_at, nowSec)}
                    </span>
                    <CopyButton
                      value={installTicket.install_cmd}
                      label="复制安装命令"
                    />
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-hairline)",
                    color: "var(--text-secondary)",
                  }}
                  className="flex items-center justify-between gap-3 rounded-[8px] px-3.5 py-2.5 text-[12.5px]"
                >
                  <span>一键部署新服务端并自动同步当前配置</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={generatingInstall}
                    onClick={() => void handleGenerateInstallCmd()}
                  >
                    获取命令
                  </Button>
                </div>
              )}
            </div>
          </Card>
        </div>
      </section>

      {/* Block 2: 平滑迁移 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3
              style={{ color: "var(--text-secondary)" }}
              className="text-[13px] font-medium"
            >
              平滑迁移
            </h3>
            <Badge tone="neutral">失败自动回退</Badge>
          </div>

          <SegmentedControl<MigrationDirection>
            ariaLabel="迁移方向"
            value={direction}
            onChange={setDirection}
            options={[
              { value: "outbound", label: "迁出至目标面板" },
              { value: "inbound", label: "接收外部迁入" },
            ]}
          />
        </div>

        {direction === "outbound" ? (
          <Card className="space-y-5 p-5">
            {/* Target URL / Code Input + Action */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void executeSmartMigration(targetInput, false);
              }}
              className="space-y-3"
            >
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <label htmlFor={targetInputId} className="sr-only">
                  目标面板地址或接收口令
                </label>
                <input
                  id={targetInputId}
                  type="text"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  placeholder="粘贴目标面板地址（https://...）或接收口令"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="font-mono-num h-9 flex-1 rounded-[8px] px-3 text-[13px] outline-none"
                />
                <Button
                  type="submit"
                  size="md"
                  variant="primary"
                  disabled={migrating || cutoverPhase === "polling"}
                  icon={
                    migrating || cutoverPhase === "polling" ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    )
                  }
                >
                  {migrating || cutoverPhase === "polling"
                    ? "迁移中..."
                    : "开始迁移"}
                </Button>
              </div>

              {/* Optional Pilot Single-Server Row & HTTP toggle */}
              {(orderedNodes.length > 1 ||
                targetInput.trim().toLowerCase().startsWith("http://")) && (
                <div className="flex flex-wrap items-center gap-4 text-[12px]">
                  {orderedNodes.length > 1 && (
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={pilotOnly}
                        onChange={setPilotOnly}
                        ariaLabel="先用单台服务器试迁"
                      />
                      <span style={{ color: "var(--text-secondary)" }}>
                        先用 1 台服务器试迁
                      </span>
                      {pilotOnly && (
                        <Select
                          size="sm"
                          name="pilot_node_id"
                          aria-label="选择试迁服务器"
                          value={pilotNodeId}
                          onChange={(e) => setPilotNodeId(e.target.value)}
                          className="min-w-[128px] max-w-[220px]"
                        >
                          {orderedNodes.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                  )}

                  {targetInput.trim().toLowerCase().startsWith("http://") && (
                    <label
                      style={{ color: "var(--text-secondary)" }}
                      className="inline-flex cursor-pointer items-center gap-1.5"
                    >
                      <input
                        type="checkbox"
                        checked={allowInsecureHttp}
                        onChange={(e) => setAllowInsecureHttp(e.target.checked)}
                        style={{ accentColor: "var(--ink-primary)" }}
                      />
                      <span>允许内网 HTTP 明文地址</span>
                    </label>
                  )}
                </div>
              )}
            </form>

            {migrationError && (
              <div
                role="alert"
                style={{
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--status-danger-ink)",
                }}
                className="rounded-[8px] px-3.5 py-2.5 text-[12.5px]"
              >
                {migrationError}
              </div>
            )}

            {/* 3-Step Visual Progress Bar */}
            <div
              style={{
                backgroundColor: "var(--bg-subtle)",
                border: "1px solid var(--border-hairline)",
              }}
              className="space-y-3 rounded-[10px] px-4 py-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-1 items-center justify-between gap-2">
                  {steps.map((label, idx) => {
                    const isErr = cutoverPhase === "error" && idx === 0;
                    const completed =
                      cutoverPhase !== "idle" &&
                      cutoverPhase !== "error" &&
                      (stepIndex > idx || cutoverPhase === "done");
                    const current =
                      (cutoverPhase === "connecting" && idx === 0) ||
                      (cutoverPhase === "polling" && idx === 1);

                    return (
                      <React.Fragment key={label}>
                        <div className="flex items-center gap-2">
                          <span
                            style={
                              isErr
                                ? {
                                    backgroundColor: "var(--status-danger-bg)",
                                    color: "var(--status-danger-ink)",
                                    border:
                                      "1px solid var(--status-danger-border)",
                                  }
                                : completed
                                  ? {
                                      backgroundColor: "var(--ink-primary)",
                                      color: "var(--ink-on-primary)",
                                    }
                                  : current
                                    ? {
                                        backgroundColor: "var(--accent-soft)",
                                        color: "var(--accent-ink)",
                                        border:
                                          "1px solid var(--accent-border)",
                                      }
                                    : {
                                        backgroundColor: "var(--bg-sheet)",
                                        color: "var(--text-tertiary)",
                                        border:
                                          "1px solid var(--border-subtle)",
                                      }
                            }
                            className="font-mono-num inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                          >
                            {completed ? (
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              idx + 1
                            )}
                          </span>
                          <span
                            style={{
                              color:
                                completed || current
                                  ? "var(--text-primary)"
                                  : "var(--text-tertiary)",
                            }}
                            className="text-[12.5px] font-medium whitespace-nowrap"
                          >
                            {label}
                          </span>
                        </div>

                        {idx < steps.length - 1 && (
                          <div
                            style={{
                              backgroundColor: completed
                                ? "var(--ink-primary)"
                                : "var(--border-subtle)",
                            }}
                            className="mx-2 h-[1.5px] flex-1 rounded-full transition-colors"
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>

                <span
                  style={{
                    color:
                      cutoverPhase === "error"
                        ? "var(--status-danger-ink)"
                        : "var(--text-secondary)",
                  }}
                  className="font-mono-num tabular-nums ml-3 text-[12px] font-medium whitespace-nowrap"
                >
                  {cutoverPhase === "idle"
                    ? `待命 · ${onlineNodes.length} 台在线`
                    : cutoverPhase === "error"
                      ? "原连接保持不变"
                      : `${switchedCount} / ${dispatchedCount}`}
                </span>
              </div>

              {cutoverPhase === "done" && lastWasPilot && lastTargetUsed && (
                <div
                  style={{ borderTop: "1px solid var(--border-hairline)" }}
                  className="flex items-center justify-between gap-3 pt-2.5"
                >
                  <span
                    style={{ color: "var(--text-secondary)" }}
                    className="text-[12px]"
                  >
                    单台试迁已完成，可一键切换其余全部在线服务器
                  </span>
                  <Button
                    size="xs"
                    variant="primary"
                    onClick={() =>
                      void executeSmartMigration(lastTargetUsed, true)
                    }
                  >
                    迁移全部服务器
                  </Button>
                </div>
              )}
            </div>

            {/* Compact Visual Node Status Grid */}
            {nodes.length > 0 && (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                {nodes.map((node) => {
                  const targetedByRun =
                    cutoverPhase !== "idle" &&
                    (!lastWasPilot || node.id === pilotNodeId);
                  const isSwitched =
                    targetedByRun &&
                    (cutoverPhase === "done" || !node.online);
                  const isSwitching =
                    targetedByRun && cutoverPhase === "polling" && node.online;

                  const dotTone = isSwitched
                    ? "ok"
                    : isSwitching
                      ? "accent"
                      : node.online
                        ? "ok"
                        : "idle";

                  const phaseText = isSwitched
                    ? "已切流"
                    : isSwitching
                      ? "切换中"
                      : node.online
                        ? "在线"
                        : "离线";

                  const barPct = isSwitched
                    ? 100
                    : isSwitching
                      ? 65
                      : node.online
                        ? 100
                        : 0;

                  return (
                    <div
                      key={node.id}
                      style={{
                        backgroundColor: "var(--bg-card)",
                        border: "1px solid var(--border-hairline)",
                      }}
                      className="flex flex-col gap-2 rounded-[8px] p-3"
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span
                          style={{ color: "var(--text-primary)" }}
                          className="truncate text-[12.5px] font-medium"
                        >
                          {node.name}
                        </span>
                        <StatusDot tone={dotTone} pulse={isSwitching} />
                      </div>

                      <div className="flex items-center justify-between text-[11px]">
                        <span
                          style={{ color: "var(--text-tertiary)" }}
                          className="font-mono-num truncate"
                        >
                          {node.region_code || node.group_name || "Linux"}
                        </span>
                        <span style={{ color: "var(--text-secondary)" }}>
                          {phaseText}
                        </span>
                      </div>

                      <MetricBar
                        valuePct={barPct}
                        toneOverride={
                          isSwitching ? "accent" : node.online ? "ok" : "ink"
                        }
                        thickness={3}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        ) : (
          /* Inbound Receive Card */
          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div
                  style={{ color: "var(--text-primary)" }}
                  className="text-[14px] font-semibold"
                >
                  生成接收口令
                </div>
                <div
                  style={{ color: "var(--text-tertiary)" }}
                  className="text-[12px]"
                >
                  将生成的口令粘贴至旧面板「迁出至目标面板」即可自动同步并切流
                </div>
              </div>

              <Button
                size="sm"
                variant="primary"
                disabled={generatingReceive}
                icon={
                  generatingReceive ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  )
                }
                onClick={() => void handleGenerateReceiveCode()}
              >
                {receiveTicket ? "重新生成口令" : "生成接收口令"}
              </Button>
            </div>

            {receiveTicket?.migration_code &&
              receiveTicket.expires_at > nowSec && (
                <div
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="space-y-2.5 rounded-[10px] p-3.5"
                >
                  <code
                    style={{ color: "var(--text-primary)" }}
                    className="block break-all font-mono text-[12px] leading-relaxed"
                  >
                    {receiveTicket.migration_code}
                  </code>
                  <div className="flex items-center justify-between gap-2">
                    <StatusDot
                      tone="accent"
                      pulse
                      label={`等待迁入 · 有效期 ${formatCountdown(receiveTicket.expires_at, nowSec)} · 当前在线 ${connectedAgents} / ${totalNodes}`}
                      className="font-mono-num"
                    />
                    <CopyButton
                      value={receiveTicket.migration_code}
                      label="复制口令"
                    />
                  </div>
                </div>
              )}
          </Card>
        )}
      </section>

      {/* Block 3: 辅助保障 */}
      <section className="space-y-3">
        <h3
          style={{ color: "var(--text-secondary)" }}
          className="text-[13px] font-medium"
        >
          辅助保障
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 掉线提醒 */}
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="space-y-1">
              <div
                style={{ color: "var(--text-primary)" }}
                className="text-[14px] font-semibold"
              >
                掉线提醒
              </div>
              <StatusDot
                tone={isCloudflare ? wdDotTone : "ok"}
                pulse={isCloudflare && wdConfig.enabled}
                label={wdLabelText}
                className="font-mono-num"
              />
            </div>

            {isCloudflare ? (
              <div className="flex items-center gap-2.5">
                <Button
                  size="xs"
                  variant="ghost"
                  icon={
                    <SlidersHorizontal
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                  }
                  onClick={() => setWdModalOpen(true)}
                >
                  设置
                </Button>
                <Switch
                  checked={wdConfig.enabled}
                  disabled={savingWd}
                  onChange={(next) => void handleToggleWatchdogQuick(next)}
                  ariaLabel="开启自建端掉线提醒"
                />
              </div>
            ) : (
              <Button
                size="xs"
                variant="secondary"
                disabled={refreshingStatus}
                onClick={() => void handleRefreshStatus()}
              >
                立即检测
              </Button>
            )}
          </Card>

          {/* 数据备份 */}
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="space-y-1">
              <div
                style={{ color: "var(--text-primary)" }}
                className="text-[14px] font-semibold"
              >
                数据备份
              </div>
              <div
                style={{ color: "var(--text-tertiary)" }}
                className="font-mono-num text-[12px]"
              >
                {lastBackupNote ?? `${totalNodes} 台服务器配置与规则快照`}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={(e) => void handleFileChange(e)}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={exporting}
                icon={
                  exporting ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  )
                }
                onClick={() => void handleExportBackup()}
              >
                导出备份
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={importing}
                icon={<Upload className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={() => fileInputRef.current?.click()}
              >
                导入恢复
              </Button>
            </div>
          </Card>
        </div>
      </section>

      {/* Watchdog Settings Modal (Cloudflare mode only) */}
      <NativeDialog
        open={wdModalOpen && isCloudflare}
        onClose={() => {
          if (!savingWd) setWdModalOpen(false);
        }}
        titleId={wdModalTitleId}
        maxWidthClass="max-w-[420px]"
      >
        <form
          onSubmit={(e) => void handleSaveWatchdogModal(e)}
          className="space-y-4 p-5"
        >
          <div className="flex items-center justify-between">
            <h3
              id={wdModalTitleId}
              style={{ color: "var(--text-primary)" }}
              className="text-[15px] font-semibold"
            >
              掉线提醒设置
            </h3>
            <IconCloseButton
              onClick={() => {
                if (!savingWd) setWdModalOpen(false);
              }}
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor="wd-hub-label"
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                守护对象名称
              </label>
              <input
                id="wd-hub-label"
                type="text"
                value={wdConfig.hub_label}
                onChange={(e) =>
                  setWdConfig((prev) => ({
                    ...prev,
                    hub_label: e.target.value,
                  }))
                }
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
                className="h-9 w-full rounded-[8px] px-3 text-[13px] outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <span
                style={{ color: "var(--text-secondary)" }}
                className="block text-[12px] font-medium"
              >
                超时判定时长
              </span>
              <div className="grid grid-cols-3 gap-1.5">
                {TIMEOUT_OPTIONS.map((opt) => {
                  const selected = wdConfig.timeout_sec === opt.sec;
                  return (
                    <button
                      key={opt.sec}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setWdConfig((prev) => ({
                          ...prev,
                          timeout_sec: opt.sec,
                        }))
                      }
                      style={
                        selected
                          ? {
                              backgroundColor: "var(--ink-primary)",
                              color: "var(--ink-on-primary)",
                            }
                          : {
                              backgroundColor: "var(--bg-subtle)",
                              color: "var(--text-secondary)",
                              border: "1px solid var(--border-hairline)",
                            }
                      }
                      className="font-mono-num h-8 cursor-pointer rounded-[7px] text-[12px] font-medium"
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="wd-secret"
                  style={{ color: "var(--text-secondary)" }}
                  className="text-[12px] font-medium"
                >
                  通信密钥
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setWdConfig((prev) => ({
                      ...prev,
                      secret: generateRandomSecret(),
                    }))
                  }
                  style={{ color: "var(--accent-ink)" }}
                  className="cursor-pointer text-[11.5px] font-medium hover:underline"
                >
                  随机生成
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  id="wd-secret"
                  type="text"
                  value={wdConfig.secret}
                  onChange={(e) =>
                    setWdConfig((prev) => ({ ...prev, secret: e.target.value }))
                  }
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                  }}
                  className="font-mono-num h-9 flex-1 rounded-[8px] px-3 text-[12.5px] outline-none"
                />
                {wdConfig.secret && (
                  <CopyButton value={wdConfig.secret} label="复制" />
                )}
              </div>
            </div>

            {channels.length > 0 && (
              <div className="space-y-1.5">
                <span
                  style={{ color: "var(--text-secondary)" }}
                  className="block text-[12px] font-medium"
                >
                  告警通知渠道
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((ch) => {
                    const selected = (wdConfig.channel_ids ?? []).includes(
                      ch.id,
                    );
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setWdConfig((prev) => {
                            const cur = prev.channel_ids ?? [];
                            return {
                              ...prev,
                              channel_ids: selected
                                ? cur.filter((id) => id !== ch.id)
                                : [...cur, ch.id],
                            };
                          })
                        }
                        style={
                          selected
                            ? {
                                backgroundColor: "var(--ink-primary)",
                                color: "var(--ink-on-primary)",
                              }
                            : {
                                backgroundColor: "var(--bg-subtle)",
                                color: "var(--text-secondary)",
                                border: "1px solid var(--border-hairline)",
                              }
                        }
                        className="h-7 cursor-pointer rounded-[6px] px-2.5 text-[12px] font-medium"
                      >
                        {ch.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={savingWd}
              onClick={() => setWdModalOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={savingWd}
              icon={
                savingWd ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : undefined
              }
            >
              保存设置
            </Button>
          </div>
        </form>
      </NativeDialog>

      {/* Import Backup Confirmation Modal */}
      <NativeDialog
        open={pendingImport !== null}
        onClose={() => {
          if (!importing) setPendingImport(null);
        }}
        titleId={importModalTitleId}
        maxWidthClass="max-w-[400px]"
      >
        {pendingImport && (
          <div className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h3
                id={importModalTitleId}
                style={{ color: "var(--text-primary)" }}
                className="text-[15px] font-semibold"
              >
                导入备份恢复
              </h3>
              <IconCloseButton
                onClick={() => {
                  if (!importing) setPendingImport(null);
                }}
              />
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-subtle)",
                border: "1px solid var(--border-hairline)",
              }}
              className="space-y-1.5 rounded-[8px] p-3 text-[12.5px]"
            >
              <div
                style={{ color: "var(--text-primary)" }}
                className="truncate font-mono font-medium"
              >
                {pendingImport.fileName}
              </div>
              <div
                style={{ color: "var(--text-secondary)" }}
                className="font-mono-num"
              >
                包含 {pendingImport.nodesCount} 台服务器 ·{" "}
                {pendingImport.rulesCount} 条规则 ·{" "}
                {pendingImport.channelsCount} 个通知渠道
              </div>
              {pendingImport.exportedAt && (
                <div
                  style={{ color: "var(--text-tertiary)" }}
                  className="font-mono-num text-[11.5px]"
                >
                  导出时间：{formatTimestamp(pendingImport.exportedAt)}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={importing}
                onClick={() => setPendingImport(null)}
              >
                取消
              </Button>
              <Button
                autoFocus
                variant="primary"
                size="sm"
                disabled={importing}
                icon={
                  importing ? (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : undefined
                }
                onClick={() => void handleConfirmImport()}
              >
                {importing ? "导入中..." : "确认恢复"}
              </Button>
            </div>
          </div>
        )}
      </NativeDialog>
    </div>
  );
}

export default HubMigrationStudio;
