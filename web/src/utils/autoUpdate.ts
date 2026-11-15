import type { AgentUpdateStatus, NodeSummary } from "../types.ts";

export function compareSemver(a: string, b: string): number {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]!
      .split("+")[0]!
      .split(".")
      .map((n) => {
        const parsed = Number.parseInt(n, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });
  const pa = clean(a);
  const pb = clean(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

export function formatVersionTag(version: string | null | undefined): string {
  if (!version || !version.trim()) return "—";
  const cleaned = version.trim();
  return cleaned.startsWith("v") ? cleaned : `v${cleaned}`;
}

export interface FormattedAgentUpdateState {
  label: string;
  tone: "subtle" | "accent" | "ok" | "warn" | "danger";
  detail?: string;
  hasUpgrade: boolean;
}

export function formatAgentUpdateState(
  status: AgentUpdateStatus | null | undefined,
  currentVersion: string | null | undefined,
  latestVersion?: string | null,
): FormattedAgentUpdateState {
  const hasUpgrade = Boolean(
    currentVersion &&
      latestVersion &&
      compareSemver(latestVersion, currentVersion) > 0,
  );

  if (status) {
    switch (status.state) {
      case "downloading":
        return {
          label: "正在下载",
          tone: "accent",
          detail: status.target_version
            ? `目标 ${formatVersionTag(status.target_version)}`
            : undefined,
          hasUpgrade,
        };
      case "staged":
        return {
          label: "已暂存待应用",
          tone: "accent",
          detail: status.target_version
            ? `目标 ${formatVersionTag(status.target_version)}`
            : undefined,
          hasUpgrade,
        };
      case "applying":
        return {
          label: "正在更新重启",
          tone: "warn",
          detail: status.target_version
            ? `目标 ${formatVersionTag(status.target_version)}`
            : undefined,
          hasUpgrade,
        };
      case "error":
        return {
          label: "更新失败",
          tone: "danger",
          detail: status.error || status.target_version || undefined,
          hasUpgrade,
        };
      case "idle":
      default:
        break;
    }
  }

  if (hasUpgrade && latestVersion) {
    return {
      label: `可更新至 ${formatVersionTag(latestVersion)}`,
      tone: "warn",
      hasUpgrade: true,
    };
  }

  if (currentVersion && currentVersion.trim()) {
    return {
      label: latestVersion ? "已是最新" : formatVersionTag(currentVersion),
      tone: "ok",
      hasUpgrade: false,
    };
  }

  return {
    label: "版本未知",
    tone: "subtle",
    hasUpgrade: false,
  };
}

export interface EffectiveAutoUpdate {
  enabled: boolean;
  source: "global" | "forced" | "disabled";
  label: string;
}

export function resolveEffectiveAutoUpdate(
  override: boolean | null | undefined,
  globalEnabled: boolean,
): EffectiveAutoUpdate {
  if (override === true) {
    return { enabled: true, source: "forced", label: "强制开启" };
  }
  if (override === false) {
    return { enabled: false, source: "disabled", label: "禁用" };
  }
  return {
    enabled: globalEnabled,
    source: "global",
    label: globalEnabled ? "跟随全局 (开启)" : "跟随全局 (关闭)",
  };
}

export function hasUpdateCap(caps: string[] | undefined): boolean {
  if (!Array.isArray(caps) || caps.length === 0) return false;
  return caps.some(
    (c) =>
      c === "self_update" ||
      c === "agent_update" ||
      c === "agent_update_v1" ||
      c.startsWith("self_update"),
  );
}

export function countUpdateEligibleNodes(
  nodes: Pick<
    NodeSummary,
    "online" | "agent_version" | "auto_update_override" | "update_status"
  >[],
  latestVersion: string | null | undefined,
): number {
  if (!latestVersion) return 0;
  return nodes.filter((node) => {
    if (!node.online) return false;
    if (
      node.update_status &&
      (node.update_status.state === "downloading" ||
        node.update_status.state === "staged" ||
        node.update_status.state === "applying")
    ) {
      return false;
    }
    if (!node.agent_version) return true;
    return compareSemver(latestVersion, node.agent_version) > 0;
  }).length;
}
