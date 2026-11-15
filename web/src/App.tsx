import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
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
import { Button, StatusDot, type StatusDotTone } from "./components/ui/Primitives";

const TONE_TO_DOT: Record<ToastTone, StatusDotTone> = {
  info: "accent",
  success: "ok",
  warning: "warn",
  danger: "danger",
};

function AppContent() {
  const {
    themeMode,
    resolvedTheme,
    setThemeMode,
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

  // Floating bottom-right auto-dismiss toast (2400ms, zero layout shift)
  const [toast, setToast] = useState<(ToastMessage & { seq: number }) | null>(
    null,
  );
  const toastSeqRef = useRef(0);
  const authCheckSeqRef = useRef(0);
  const lastFocusRefreshRef = useRef(0);

  const pushToast = useCallback(
    (tone: ToastTone, title: string, description?: string) => {
      const seq = ++toastSeqRef.current;
      setToast({
        id: `toast_${seq}`,
        seq,
        tone,
        title,
        description,
      });
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(id);
  }, [toast]);

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

  useEffect(() => {
    if (!auth?.authenticated) return;
    if (route === "nodes") {
      void refreshNodes();
    } else if (route === "migration") {
      void refreshHubStatus();
    }
  }, [auth?.authenticated, route, refreshNodes, refreshHubStatus]);

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
    liveNodeId,
    liveSeriesByNode,
    procsPacket,
    subNode,
    unsubNode,
  } = useFleetSocket({
    enabled: auth?.authenticated === true,
    fleetActive: route === "dashboard" || route === "nodes" || addServerOpen,
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
      pushToast("success", `已添加 ${res.node.name}`);
      return res;
    },
    [pushToast],
  );

  const handleUpdateNode = useCallback(
    async (id: string, patch: UpdateNodePayload): Promise<void> => {
      const res = await api.updateNode(id, patch);
      setNodes((prev) => prev.map((n) => (n.id === id ? res.node : n)));
      pushToast("success", "服务器信息已保存");
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
          pushToast("info", `已静音 ${mins} 分钟`);
        } else {
          pushToast("success", "已恢复告警通知");
        }
      } catch (err) {
        pushToast(
          "danger",
          err instanceof Error ? err.message : "更新失败",
        );
        throw err;
      }
    },
    [pushToast],
  );

  const handleRotateToken = useCallback(
    async (nodeId: string): Promise<RotateTokenResponse> => {
      const res = await api.rotateNodeToken(nodeId);
      pushToast("warning", "连接密钥已重新生成");
      return res;
    },
    [pushToast],
  );

  const handleDeleteNode = useCallback(
    async (nodeId: string): Promise<void> => {
      await api.deleteNode(nodeId);
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setInspectedNodeId((cur) => (cur === nodeId ? null : cur));
      pushToast("info", "已移除服务器");
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
      <div
        style={{
          backgroundColor: "var(--bg-shell)",
          color: "var(--text-secondary)",
        }}
        className="flex min-h-dvh items-center justify-center gap-2 text-[13px]"
      >
        <Loader2
          style={{ color: "var(--accent)" }}
          className="h-4 w-4 animate-spin"
          aria-hidden="true"
        />
        <span>正在连接…</span>
      </div>
    );
  }

  if (authError && !auth) {
    return (
      <div
        style={{ backgroundColor: "var(--bg-shell)" }}
        className="flex min-h-dvh items-center justify-center p-4"
      >
        <div className="atelier-sheet w-full max-w-[380px] space-y-4 p-6 text-center">
          <div
            style={{ color: "var(--status-danger-ink)" }}
            className="text-[13px] font-medium"
          >
            {authError}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void checkAuth()}
            icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            重试连接
          </Button>
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
        onThemeModeChange={setThemeMode}
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
            style={{
              backgroundColor: "var(--status-danger-bg)",
              border: "1px solid var(--status-danger-border)",
              color: "var(--status-danger-ink)",
            }}
            className="mb-5 flex items-center justify-between gap-3 rounded-[10px] px-4 py-2.5 text-[12.5px]"
          >
            <span>{nodesError}</span>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => void refreshNodes()}
            >
              重试
            </Button>
          </div>
        )}

        {nodesLoading && nodes.length === 0 ? (
          <div
            style={{ color: "var(--text-secondary)" }}
            className="flex items-center justify-center gap-2 py-20 text-[13px]"
          >
            <Loader2
              style={{ color: "var(--accent)" }}
              className="h-4 w-4 animate-spin"
              aria-hidden="true"
            />
            <span>正在加载服务器数据…</span>
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
        liveNodeId={liveNodeId}
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

      {/* Non-Intrusive Floating Auto-Dismiss Toast (Bottom-Right, 2400ms, Zero Layout Shift) */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-5 bottom-5 z-50 max-w-[min(22rem,calc(100vw-2.5rem))]"
      >
        {toast && (
          <div
            key={toast.seq}
            className="uniob-floating-toast pointer-events-auto flex items-center gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[13px] font-medium"
          >
            <StatusDot tone={TONE_TO_DOT[toast.tone]} />
            <div className="min-w-0">
              <div className="truncate">{toast.title}</div>
              {toast.description && (
                <div
                  style={{ color: "var(--text-secondary)" }}
                  className="truncate text-[11.5px] font-normal"
                >
                  {toast.description}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
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
