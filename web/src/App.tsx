import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  AppRoute,
  AuthStatus,
  CreateNodePayload,
  CreateNodeResponse,
  HorizonNode,
  HubStatusResponse,
  InspectorTab,
  NodeSummary,
  RotateTokenResponse,
  ToastMessage,
  ToastTone,
  UpdateNodePayload,
} from "./types";
import { api, ApiError, setUnauthorizedHandler } from "./api/client";
import { useHorizonPrefs } from "./hooks/useHorizonPrefs";
import { useFleetSocket } from "./hooks/useFleetSocket";
import { useHorizonNodes } from "./utils/nodeAdapter";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./pages/Login";
import { AppShell } from "./components/AppShell";
import { FleetOverviewPage } from "./components/FleetOverviewPage";
import { NodesOpsView } from "./components/NodesOpsView";
import { HubMigrationStudio } from "./components/HubMigrationStudio";
import { AlertsCenterView } from "./components/AlertsCenterView";
import { NodeInspectorSheet } from "./components/NodeInspectorSheet";
import { AddServerWizardModal } from "./components/AddServerWizardModal";

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") {
    return (
      <CheckCircle2
        className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5"
        aria-hidden="true"
      />
    );
  }
  if (tone === "warning") {
    return (
      <AlertTriangle
        className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
        aria-hidden="true"
      />
    );
  }
  if (tone === "danger") {
    return (
      <ShieldAlert
        className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5"
        aria-hidden="true"
      />
    );
  }
  return (
    <Info
      className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5"
      aria-hidden="true"
    />
  );
}

function AppContent() {
  const {
    themeMode,
    resolvedTheme,
    cycleTheme,
    accent,
    setAccent,
    density,
    setDensity,
    viewMode,
    setViewMode,
  } = useHorizonPrefs();

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [hubStatus, setHubStatus] = useState<HubStatusResponse | null>(null);
  const [activeAlertsCount, setActiveAlertsCount] = useState(0);
  const [alertVersion, setAlertVersion] = useState(0);

  const [route, setRoute] = useState<AppRoute>("dashboard");
  const [selectedGroup, setSelectedGroup] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("charts");
  const [addServerOpen, setAddServerOpen] = useState(false);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastTimersRef = useRef<Record<string, number>>({});
  const toastSeqRef = useRef(0);
  const authCheckSeqRef = useRef(0);
  const lastFocusRefreshRef = useRef(0);

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timer of Object.values(timers)) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    if (toastTimersRef.current[id]) {
      window.clearTimeout(toastTimersRef.current[id]);
      delete toastTimersRef.current[id];
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (tone: ToastTone, title: string, description?: string) => {
      const id = `toast_${Date.now()}_${++toastSeqRef.current}`;
      setToasts((prev) => [...prev.slice(-3), { id, tone, title, description }]);
      toastTimersRef.current[id] = window.setTimeout(() => {
        dismissToast(id);
      }, 4200);
    },
    [dismissToast],
  );

  const checkAuth = useCallback(async () => {
    const seq = ++authCheckSeqRef.current;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const status = await api.getAuthMe();
      if (seq === authCheckSeqRef.current) {
        setAuth(status);
      }
    } catch (err) {
      if (seq === authCheckSeqRef.current) {
        if (err instanceof ApiError && err.status === 403) {
          setAuth({
            authenticated: false,
            needsSetup: false,
            mode: "cf_access",
            forbidden: true,
          });
        } else {
          setAuthError(err instanceof Error ? err.message : "无法连接到监控面板");
        }
      }
    } finally {
      if (seq === authCheckSeqRef.current) {
        setAuthLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    setUnauthorizedHandler((status) => {
      if (status === 403) {
        setAuth((prev) => ({
          authenticated: false,
          needsSetup: false,
          mode: "cf_access",
          forbidden: true,
          email: prev?.email,
        }));
        void checkAuth();
        return;
      }
      setAuth((prev) =>
        prev
          ? { ...prev, authenticated: false, forbidden: false }
          : {
              authenticated: false,
              needsSetup: false,
              mode: "builtin",
              forbidden: false,
            },
      );
    });
    return () => setUnauthorizedHandler(null);
  }, [checkAuth]);

  const refreshNodes = useCallback(async () => {
    setNodesLoading(true);
    setNodesError(null);
    try {
      const res = await api.getNodes();
      setNodes(Array.isArray(res?.nodes) ? res.nodes : []);
      setActiveAlertsCount(
        typeof res?.activeAlertsCount === "number" ? res.activeAlertsCount : 0,
      );
    } catch (err) {
      setNodesError(err instanceof Error ? err.message : "加载服务器列表失败");
    } finally {
      setNodesLoading(false);
    }
  }, []);

  const refreshHubStatus = useCallback(async () => {
    try {
      const status = await api.getHubStatus();
      setHubStatus(status);
    } catch {
      // Keep previous hubStatus if transient error occurs
    }
  }, []);

  const refreshAllData = useCallback(async () => {
    await Promise.all([refreshNodes(), refreshHubStatus()]);
  }, [refreshNodes, refreshHubStatus]);

  useEffect(() => {
    if (auth?.authenticated) {
      void refreshAllData();
    } else {
      setNodes([]);
      setHubStatus(null);
      setInspectedNodeId(null);
      setAddServerOpen(false);
    }
  }, [auth?.authenticated, refreshAllData]);

  // Refresh relevant data when switching routes
  useEffect(() => {
    if (!auth?.authenticated) return;
    if (route === "nodes") {
      void refreshNodes();
    } else if (route === "migration") {
      void refreshHubStatus();
    }
  }, [auth?.authenticated, route, refreshNodes, refreshHubStatus]);

  // Refresh data when browser tab regains visibility / focus
  useEffect(() => {
    if (!auth?.authenticated) return;
    const handleFocusRefresh = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 5000) return;
      lastFocusRefreshRef.current = now;
      void refreshNodes();
      if (route === "migration" || hubStatus === null) {
        void refreshHubStatus();
      }
    };
    window.addEventListener("focus", handleFocusRefresh);
    document.addEventListener("visibilitychange", handleFocusRefresh);
    return () => {
      window.removeEventListener("focus", handleFocusRefresh);
      document.removeEventListener("visibilitychange", handleFocusRefresh);
    };
  }, [auth?.authenticated, route, hubStatus, refreshNodes, refreshHubStatus]);

  const handleAlertEvent = useCallback(() => {
    setAlertVersion((v) => v + 1);
  }, []);

  const {
    wsStatus,
    liveSeriesByNode,
    procsPacket,
    subNode,
    unsubNode,
  } = useFleetSocket({
    enabled: auth?.authenticated === true,
    fleetActive: route === "dashboard" || addServerOpen,
    onNodesUpdater: setNodes,
    onActiveAlertsChange: setActiveAlertsCount,
    onAlertEvent: handleAlertEvent,
  });

  const handleLogout = useCallback(async () => {
    if (auth?.mode === "cf_access") {
      window.location.assign("/cdn-cgi/access/logout");
      return;
    }
    try {
      await api.logout();
    } catch {
      // ignore network/session errors on logout
    }
    setAuth((prev) => ({
      authenticated: false,
      needsSetup: false,
      mode: prev?.mode ?? "builtin",
    }));
  }, [auth?.mode]);

  const handleCreateNode = useCallback(
    async (payload: CreateNodePayload): Promise<CreateNodeResponse> => {
      const res = await api.createNode(payload);
      setNodes((prev) =>
        prev.some((n) => n.id === res.node.id) ? prev : [...prev, res.node],
      );
      pushToast("info", `已注册节点 ${res.node.name}`, "等待探针首帧握手接入");
      return res;
    },
    [pushToast],
  );

  const handleUpdateNode = useCallback(
    async (id: string, patch: UpdateNodePayload): Promise<void> => {
      const res = await api.updateNode(id, patch);
      setNodes((prev) => prev.map((n) => (n.id === id ? res.node : n)));
      pushToast("success", "节点配置已更新");
    },
    [pushToast],
  );

  const handleMuteNode = useCallback(
    async (nodeId: string, seconds: number | null): Promise<void> => {
      try {
        const muteUntil =
          seconds !== null && seconds > 0
            ? Math.floor(Date.now() / 1000) + seconds
            : null;
        const res = await api.updateNode(nodeId, { mute_until: muteUntil });
        setNodes((prev) => prev.map((n) => (n.id === nodeId ? res.node : n)));
        if (muteUntil !== null && seconds !== null) {
          const mins = Math.max(1, Math.round(seconds / 60));
          pushToast(
            "info",
            `已开启维护静默 (${mins} 分钟)`,
            "静默期内将抑制该节点告警通知",
          );
        } else {
          pushToast("success", "已取消维护静默", "恢复正常告警判定");
        }
      } catch (err) {
        pushToast(
          "danger",
          "静默状态更新失败",
          err instanceof Error ? err.message : "操作失败，请稍后重试",
        );
        throw err;
      }
    },
    [pushToast],
  );

  const handleRotateToken = useCallback(
    async (nodeId: string): Promise<RotateTokenResponse> => {
      const res = await api.rotateNodeToken(nodeId);
      pushToast(
        "warning",
        "节点连接密钥已轮换",
        "旧 Token 已立即吊销，请在目标节点更新凭据",
      );
      return res;
    },
    [pushToast],
  );

  const handleDeleteNode = useCallback(
    async (nodeId: string): Promise<void> => {
      await api.deleteNode(nodeId);
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setInspectedNodeId((cur) => (cur === nodeId ? null : cur));
      pushToast("info", "已从监控台账移除服务器");
    },
    [pushToast],
  );

  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.created_at - b.created_at;
    });
  }, [nodes]);

  const horizonNodes = useHorizonNodes(sortedNodes, liveSeriesByNode);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const n of horizonNodes) {
      if (n.group_name) set.add(n.group_name);
    }
    return Array.from(set);
  }, [horizonNodes]);

  const inspectedNode = useMemo(() => {
    if (!inspectedNodeId) return null;
    return horizonNodes.find((n) => n.id === inspectedNodeId) ?? null;
  }, [horizonNodes, inspectedNodeId]);

  const handleSelectNode = useCallback(
    (node: HorizonNode, initialTab: InspectorTab = "charts") => {
      setInspectorTab(initialTab);
      setInspectedNodeId(node.id);
    },
    [],
  );

  const handleCloseInspector = useCallback(() => {
    setInspectedNodeId(null);
  }, []);

  if (authLoading && !auth) {
    return (
      <div className="min-h-dvh flex items-center justify-center horizon-grid-bg bg-[var(--bg-canvas)] text-[var(--text-secondary)] text-xs font-mono-num gap-2">
        <Loader2
          className="w-4 h-4 animate-spin text-[var(--accent-primary)]"
          aria-hidden="true"
        />
        <span>正在连接 UniOB 监控面板...</span>
      </div>
    );
  }

  if (authError && !auth) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-4 horizon-grid-bg bg-[var(--bg-canvas)]">
        <div className="max-w-sm w-full rounded-2xl surface-elevated border border-rose-500/35 p-5 text-center space-y-3 text-xs">
          <div className="text-rose-600 dark:text-rose-400 font-semibold">
            {authError}
          </div>
          <button
            type="button"
            onClick={() => void checkAuth()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--accent-solid)] hover:bg-[var(--accent-hover)] text-white font-medium transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>重试连接</span>
          </button>
        </div>
      </div>
    );
  }

  if (!auth?.authenticated) {
    return (
      <Login
        auth={
          auth ?? {
            authenticated: false,
            needsSetup: false,
            mode: "builtin",
          }
        }
        authError={authError}
        themeMode={themeMode}
        resolvedTheme={resolvedTheme}
        onCycleTheme={cycleTheme}
        onSuccess={checkAuth}
      />
    );
  }

  return (
    <>
      <AppShell
        route={route}
        onRouteChange={setRoute}
        nodes={horizonNodes}
        activeAlertsCount={activeAlertsCount}
        wsStatus={wsStatus}
        hubStatus={hubStatus}
        auth={auth}
        onLogout={handleLogout}
        themeMode={themeMode}
        resolvedTheme={resolvedTheme}
        onCycleTheme={cycleTheme}
        accent={accent}
        onAccentChange={setAccent}
        density={density}
        onDensityChange={setDensity}
        onOpenAddServer={() => setAddServerOpen(true)}
        onSelectNode={handleSelectNode}
      >
        {nodesError && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between gap-2"
          >
            <span>{nodesError}</span>
            <button
              type="button"
              onClick={() => void refreshNodes()}
              className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-medium shrink-0 transition-colors"
            >
              重试
            </button>
          </div>
        )}

        {nodesLoading && nodes.length === 0 ? (
          <div className="py-20 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)] font-mono-num">
            <Loader2
              className="w-4 h-4 animate-spin text-[var(--accent-primary)]"
              aria-hidden="true"
            />
            <span>正在同步服务器状态...</span>
          </div>
        ) : (
          <>
            {route === "dashboard" && (
              <FleetOverviewPage
                nodes={horizonNodes}
                groups={groups}
                selectedGroup={selectedGroup}
                onGroupChange={setSelectedGroup}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                activeAlertsCount={activeAlertsCount}
                hubStatus={hubStatus}
                density={density}
                onSelectNode={handleSelectNode}
                onMuteNode={handleMuteNode}
                onOpenAddServer={() => setAddServerOpen(true)}
                onNavigate={setRoute}
              />
            )}

            {route === "nodes" && (
              <NodesOpsView
                nodes={horizonNodes}
                groups={groups}
                onInspectNode={handleSelectNode}
                onOpenAddServer={() => setAddServerOpen(true)}
                onUpdateNode={handleUpdateNode}
                onMuteNode={handleMuteNode}
                onRotateToken={handleRotateToken}
                onDeleteNode={handleDeleteNode}
                onNavigateMigration={() => setRoute("migration")}
              />
            )}

            {route === "migration" && (
              <HubMigrationStudio
                nodes={horizonNodes}
                hubStatus={hubStatus}
                onDataChanged={refreshAllData}
                onNotify={pushToast}
              />
            )}

            {route === "alerts" && (
              <AlertsCenterView
                nodes={horizonNodes}
                alertVersion={alertVersion}
                onSelectNode={handleSelectNode}
                onMuteNode={handleMuteNode}
                onActiveCountChange={setActiveAlertsCount}
                onNotify={pushToast}
              />
            )}
          </>
        )}
      </AppShell>

      <NodeInspectorSheet
        node={inspectedNode}
        initialTab={inspectorTab}
        resolvedTheme={resolvedTheme}
        liveSeries={
          inspectedNode ? (liveSeriesByNode[inspectedNode.id] ?? []) : []
        }
        procsPacket={procsPacket}
        wsStatus={wsStatus}
        subNode={subNode}
        unsubNode={unsubNode}
        onClose={handleCloseInspector}
        onMuteNode={handleMuteNode}
        onRotateToken={handleRotateToken}
        onDeleteNode={handleDeleteNode}
      />

      <AddServerWizardModal
        open={addServerOpen}
        existingGroups={groups}
        nodes={horizonNodes}
        wsStatus={wsStatus}
        onClose={() => setAddServerOpen(false)}
        onCreateNode={handleCreateNode}
        onRefreshNodes={refreshNodes}
        onInspectNode={(node) => {
          setAddServerOpen(false);
          handleSelectNode(node, "charts");
        }}
      />

      {/* Bottom-right Toast Notification Stack */}
      <aside
        aria-label="系统操作通知"
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(24rem,calc(100vw-2rem))] pointer-events-none"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto surface-elevated rounded-xl p-3.5 flex items-start gap-2.5 text-xs transition-transform"
          >
            <ToastIcon tone={toast.tone} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="font-semibold text-[var(--text-primary)] leading-snug">
                {toast.title}
              </div>
              {toast.description && (
                <div className="text-[var(--text-secondary)] leading-relaxed">
                  {toast.description}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="关闭通知"
              className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </aside>
    </>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

export default App;
