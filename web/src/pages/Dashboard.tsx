import type { NodeSummary, ViewMode } from "../types";
import { FleetGrid } from "../components/FleetGrid";
import { FleetTable } from "../components/FleetTable";

interface DashboardProps {
  nodes: NodeSummary[];
  viewMode: ViewMode;
  onSelectNode: (node: NodeSummary) => void;
}

export function Dashboard({ nodes, viewMode, onSelectNode }: DashboardProps) {
  return (
    <section className="space-y-4">
      {viewMode === "grid" ? (
        <FleetGrid nodes={nodes} onSelectNode={onSelectNode} />
      ) : (
        <FleetTable nodes={nodes} onSelectNode={onSelectNode} />
      )}
    </section>
  );
}
