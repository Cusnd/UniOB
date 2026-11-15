import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldAlert,
  X,
} from "lucide-react";
import type { InspectorTab, PrototypeNode, ToastMessage } from "./types";
import { usePrototypeStore } from "./data/mockStore";
import { AppShell } from "./components/AppShell";
import { FleetOverviewPage } from "./components/FleetOverviewPage";
import { NodeInspectorSheet } from "./components/NodeInspectorSheet";
import { NodesOpsView } from "./components/NodesOpsView";
import { AddServerWizardModal } from "./components/AddServerWizardModal";
import { HubMigrationStudio } from "./components/HubMigrationStudio";
import { AlertsCenterView } from "./components/AlertsCenterView";
import { AuthPreviewModal } from "./components/AuthPreviewModal";

function ToastIcon({ tone }: { tone: ToastMessage["tone"] }) {
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

export function App() {
  const store = usePrototypeStore();

  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("charts");
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [authPreviewOpen, setAuthPreviewOpen] = useState(false);

  const inspectedNode = useMemo(() => {
    if (!inspectedNodeId) return null;
    return store.nodes.find((n) => n.id === inspectedNodeId) ?? null;
  }, [store.nodes, inspectedNodeId]);

  const handleSelectNode = useCallback(
    (node: PrototypeNode, initialTab: InspectorTab = "charts") => {
      setInspectorTab(initialTab);
      setInspectedNodeId(node.id);
    },
    [],
  );

  const handleCloseInspector = useCallback(() => {
    setInspectedNodeId(null);
  }, []);

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      if (inspectedNodeId === nodeId) {
        setInspectedNodeId(null);
      }
      store.deleteNode(nodeId);
    },
    [inspectedNodeId, store],
  );

  const handleToggleHubMode = useCallback(() => {
    store.switchHubModePreview(
      store.hubMode === "cloudflare-worker"
        ? "self-hosted-hub"
        : "cloudflare-worker",
    );
  }, [store]);

  return (
    <>
      <AppShell
        route={store.route}
        onRouteChange={store.setRoute}
        nodes={store.nodes}
        activeAlertsCount={store.activeAlertsCount}
        wsConnected={store.simSpeed !== "paused"}
        hubMode={store.hubMode}
        onToggleHubMode={handleToggleHubMode}
        themeMode={store.themeMode}
        resolvedTheme={store.resolvedTheme}
        onCycleTheme={store.cycleTheme}
        accent={store.accent}
        onAccentChange={store.setAccent}
        density={store.density}
        onDensityChange={store.setDensity}
        simSpeed={store.simSpeed}
        onSimSpeedChange={store.setSimSpeed}
        onOpenAddServer={() => setAddServerOpen(true)}
        onOpenAuthPreview={() => setAuthPreviewOpen(true)}
        onSelectNode={handleSelectNode}
      >
        {store.route === "dashboard" && (
          <FleetOverviewPage
            nodes={store.nodes}
            groups={store.groups}
            selectedGroup={store.selectedGroup}
            onGroupChange={store.setSelectedGroup}
            searchQuery={store.searchQuery}
            onSearchChange={store.setSearchQuery}
            viewMode={store.viewMode}
            onViewModeChange={store.setViewMode}
            activeAlertsCount={store.activeAlertsCount}
            hubStatus={store.hubStatus}
            density={store.density}
            onSelectNode={handleSelectNode}
            onMuteNode={store.muteNode}
            onOpenAddServer={() => setAddServerOpen(true)}
            onNavigate={store.setRoute}
          />
        )}

        {store.route === "nodes" && (
          <NodesOpsView
            nodes={store.nodes}
            groups={store.groups}
            onInspectNode={handleSelectNode}
            onOpenAddServer={() => setAddServerOpen(true)}
            onUpdateNode={store.updateNode}
            onMuteNode={store.muteNode}
            onRotateToken={store.rotateToken}
            onDeleteNode={handleDeleteNode}
            onNavigateMigration={() => store.setRoute("migration")}
          />
        )}

        {store.route === "migration" && (
          <HubMigrationStudio
            nodes={store.nodes}
            hubStatus={store.hubStatus}
            watchdogConfig={store.watchdogConfig}
            channels={store.channels}
            onSwitchHubModePreview={store.switchHubModePreview}
            onSaveWatchdog={store.saveWatchdog}
            onNotify={store.notify}
          />
        )}

        {store.route === "alerts" && (
          <AlertsCenterView
            nodes={store.nodes}
            channels={store.channels}
            rules={store.rules}
            incidents={store.incidents}
            onSaveChannel={store.saveChannel}
            onToggleChannel={store.toggleChannel}
            onDeleteChannel={store.deleteChannel}
            onTestChannel={store.testChannel}
            onSaveRule={store.saveRule}
            onToggleRule={store.toggleRule}
            onDeleteRule={store.deleteRule}
            onApplyPresets={store.applyPresets}
            onResolveIncident={store.resolveIncident}
          />
        )}
      </AppShell>

      <NodeInspectorSheet
        node={inspectedNode}
        initialTab={inspectorTab}
        resolvedTheme={store.resolvedTheme}
        liveSeries={
          inspectedNode ? (store.liveSeriesByNode[inspectedNode.id] ?? []) : []
        }
        procs={inspectedNode ? (store.procsByNode[inspectedNode.id] ?? []) : []}
        getHistory={store.getHistory}
        onClose={handleCloseInspector}
        onMuteNode={store.muteNode}
        onRotateToken={store.rotateToken}
        onDeleteNode={handleDeleteNode}
        onToggleProcPrivacyPreview={store.toggleProcPrivacyPreview}
      />

      <AddServerWizardModal
        open={addServerOpen}
        existingGroups={store.groups}
        nodes={store.nodes}
        onClose={() => setAddServerOpen(false)}
        onCreateNode={store.createNode}
        onSimulateOnline={store.simulateNodeOnline}
        onInspectNode={(node) => {
          setAddServerOpen(false);
          handleSelectNode(node, "charts");
        }}
      />

      <AuthPreviewModal
        open={authPreviewOpen}
        resolvedTheme={store.resolvedTheme}
        onClose={() => setAuthPreviewOpen(false)}
        onCycleTheme={store.cycleTheme}
      />

      {/* Bottom-right Toast Notification Stack */}
      <aside
        aria-label="系统操作通知"
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(24rem,calc(100vw-2rem))] pointer-events-none"
      >
        {store.toasts.map((toast) => (
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
              onClick={() => store.dismissToast(toast.id)}
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
