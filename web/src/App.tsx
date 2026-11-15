import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type {
  AppRoute,
  AuthStatus,
  NodeSummary,
  ViewMode,
} from "./types";
import { api, ApiError, setUnauthorizedHandler } from "./api/client";
import { useTheme } from "./hooks/useTheme";
import { useFleetSocket } from "./hooks/useFleetSocket";
import { GlobalStatusBar } from "./components/GlobalStatusBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { NodeDrawer } from "./components/NodeDrawer";
import { AddNodeModal } from "./components/AddNodeModal";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { NodesManage } from "./pages/NodesManage";
import { AlertsConfig } from "./pages/AlertsConfig";

const VIEW_MODE_KEY = "uniob_view_mode";

function readInitialViewMode(): ViewMode {
  try {
    const val = localStorage.getItem(VIEW_MODE_KEY);
    if (val === "grid" || val === "table") return val;
  } catch {
    // ignore
  }
  return "grid";
}

function AppContent() {
  const { themeMode, resolvedTheme, cycleTheme } = useTheme();

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [activeAlertsCount, setActiveAlertsCount] = useState(0);
  const [alertVersion, setAlertVersion] = useState(0);

  const [route, setRoute] = useState<AppRoute>("dashboard");
  const [viewMode, setViewMode] = useState<ViewMode>(readInitialViewMode);
  const [selectedGroup, setSelectedGroup] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const authCheckSeqRef = useRef(0);

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

  const loadNodes = useCallback(async () => {
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

  useEffect(() => {
    if (auth?.authenticated) {
      void loadNodes();
    } else {
      setNodes([]);
      setSelectedNodeId(null);
    }
  }, [auth?.authenticated, loadNodes]);

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
    enabled: Boolean(auth?.authenticated),
    fleetActive: route === "dashboard",
    onNodesUpdater: setNodes,
    onActiveAlertsChange: setActiveAlertsCount,
    onAlertEvent: handleAlertEvent,
  });

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // ignore
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setAuth((prev) => ({
      authenticated: false,
      needsSetup: false,
      mode: prev?.mode ?? "builtin",
    }));
  };

  const handleNodeCreated = (node: NodeSummary) => {
    setNodes((prev) => {
      if (prev.some((n) => n.id === node.id)) return prev;
      return [...prev, node];
    });
  };

  const handleNodeUpdated = (updated: NodeSummary) => {
    setNodes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
  };

  const handleNodeDeleted = (id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    if (selectedNodeId === id) {
      setSelectedNodeId(null);
    }
  };

  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.created_at - b.created_at;
    });
  }, [nodes]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const n of sortedNodes) {
      if (n.group_name) set.add(n.group_name);
    }
    return Array.from(set);
  }, [sortedNodes]);

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sortedNodes.filter((n) => {
      if (selectedGroup !== "ALL" && n.group_name !== selectedGroup) {
        return false;
      }
      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        (n.hostname ?? "").toLowerCase().includes(q) ||
        n.group_name.toLowerCase().includes(q) ||
        (n.os ?? "").toLowerCase().includes(q) ||
        (Array.isArray(n.tags) && n.tags.some((t) => t.toLowerCase().includes(q)))
      );
    });
  }, [sortedNodes, selectedGroup, searchQuery]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [nodes, selectedNodeId]);

  if (authLoading && !auth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f3f6fa] dark:bg-[#090d14] text-slate-500 dark:text-slate-400 text-xs font-mono-num gap-2">
        <Loader2 className="w-4 h-4 animate-spin text-sky-500" aria-hidden="true" />
        正在连接 UniOB 监控面板...
      </div>
    );
  }

  if (authError && !auth) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#f3f6fa] dark:bg-[#090d14]">
        <div className="max-w-sm w-full rounded-xl border border-rose-500/30 bg-white dark:bg-[#0f1623] p-5 text-center space-y-3 text-xs">
          <div className="text-rose-500 font-semibold">{authError}</div>
          <button
            type="button"
            onClick={() => void checkAuth()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600 text-white font-medium"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            重试连接
          </button>
        </div>
      </div>
    );
  }

  if (!auth?.authenticated) {
    return (
      <Login
        needsSetup={Boolean(auth?.needsSetup)}
        authMode={auth?.mode ?? "builtin"}
        forbidden={Boolean(auth?.forbidden)}
        authEmail={auth?.email}
        authError={authError}
        onAuthenticated={checkAuth}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#f3f6fa] dark:bg-[#090d14] text-slate-900 dark:text-slate-100 flex flex-col">
      <GlobalStatusBar
        nodes={sortedNodes}
        activeAlertsCount={activeAlertsCount}
        wsStatus={wsStatus}
        route={route}
        onRouteChange={setRoute}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        groups={groups}
        selectedGroup={selectedGroup}
        onGroupChange={setSelectedGroup}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenAddModal={() => setAddModalOpen(true)}
        themeMode={themeMode}
        onCycleTheme={cycleTheme}
        authMode={auth.mode}
        authEmail={auth.email}
        onLogout={handleLogout}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-5">
        {nodesError && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-600 dark:text-rose-300 flex items-center justify-between gap-2">
            <span>{nodesError}</span>
            <button
              type="button"
              onClick={() => void loadNodes()}
              className="px-2.5 py-1 rounded bg-rose-600 text-white font-medium"
            >
              重试
            </button>
          </div>
        )}

        {nodesLoading && nodes.length === 0 ? (
          <div className="py-16 flex items-center justify-center gap-2 text-xs text-slate-500 font-mono-num">
            <Loader2 className="w-4 h-4 animate-spin text-sky-500" aria-hidden="true" />
            正在同步服务器状态...
          </div>
        ) : route === "dashboard" ? (
          <Dashboard
            nodes={filteredNodes}
            viewMode={viewMode}
            onSelectNode={(node) => setSelectedNodeId(node.id)}
          />
        ) : route === "nodes" ? (
          <NodesManage
            nodes={sortedNodes}
            onNodeUpdated={handleNodeUpdated}
            onNodeDeleted={handleNodeDeleted}
            onInspectNode={(node) => setSelectedNodeId(node.id)}
            onOpenAddModal={() => setAddModalOpen(true)}
            onRefreshNodes={loadNodes}
          />
        ) : (
          <AlertsConfig
            nodes={sortedNodes}
            alertVersion={alertVersion}
            onActiveAlertsSync={setActiveAlertsCount}
          />
        )}
      </main>

      <NodeDrawer
        node={selectedNode}
        resolvedTheme={resolvedTheme}
        liveSeries={selectedNode ? (liveSeriesByNode[selectedNode.id] ?? []) : []}
        procsPacket={procsPacket}
        onClose={() => setSelectedNodeId(null)}
        onSubNode={subNode}
        onUnsubNode={unsubNode}
        onNodeUpdated={handleNodeUpdated}
        onNodeDeleted={handleNodeDeleted}
      />

      <AddNodeModal
        open={addModalOpen}
        nodes={nodes}
        existingGroups={groups}
        onClose={() => setAddModalOpen(false)}
        onNodeCreated={handleNodeCreated}
        onInspectNode={(node) => setSelectedNodeId(node.id)}
      />
    </div>
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
