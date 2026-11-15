import type { DiskMetrics, HorizonNode, NodeSummary } from "../types";

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(
  bytes: number | null | undefined,
  decimals = 1,
): string {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes < 0
  ) {
    return "0 B";
  }
  if (bytes === 0) return "0 B";
  const k = 1024;
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    SIZE_UNITS.length - 1,
  );
  const val = bytes / Math.pow(k, idx);
  const digits = idx === 0 ? 0 : val >= 100 ? 0 : decimals;
  return `${val.toFixed(digits)} ${SIZE_UNITS[idx]}`;
}

export function formatBytesCompact(bytes: number | null | undefined): string {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes <= 0
  ) {
    return "0B";
  }
  const k = 1024;
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    SIZE_UNITS.length - 1,
  );
  const val = bytes / Math.pow(k, idx);
  const digits = idx === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(digits)} ${SIZE_UNITS[idx]}`;
}

export function formatBytesPerSec(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps <= 0) {
    return "0 B/s";
  }
  const k = 1024;
  const idx = Math.min(
    Math.floor(Math.log(bps) / Math.log(k)),
    SIZE_UNITS.length - 1,
  );
  const val = bps / Math.pow(k, idx);
  const digits = idx === 0 ? 0 : val >= 100 ? 0 : 1;
  return `${val.toFixed(digits)} ${SIZE_UNITS[idx]}/s`;
}

export function formatRate(bps: number | null | undefined): string {
  return formatBytesPerSec(bps);
}

export function formatPercent(
  val: number | null | undefined,
  digits = 1,
): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return "0.0%";
  }
  return `${Math.max(0, Math.min(100, val)).toFixed(digits)}%`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "—";
  }
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${s}s`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "0 秒";
  }
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0) parts.push(`${mins} 分`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} 秒`);
  return parts.join(" ");
}

export function formatRelativeTime(unixSec: number | null | undefined): string {
  if (!unixSec) return "从未连接";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 5) return "刚刚";
  if (diff < 60) return `${diff}s 前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
  return `${Math.floor(diff / 86400)}d 前`;
}

export function formatTimestamp(unixSec: number | null | undefined): string {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function getRootDisk(
  disks: DiskMetrics[] | undefined | null,
): DiskMetrics | null {
  if (!disks || disks.length === 0) return null;
  const root = disks.find((d) => d.mp === "/");
  if (root) return root;
  return disks.reduce(
    (max, cur) => (cur.total > max.total ? cur : max),
    disks[0],
  );
}

export function getMemUsagePct(node: NodeSummary): number {
  const m = node.metrics?.mem;
  if (!m) return 0;
  const total =
    node.mem_total && node.mem_total > 0 ? node.mem_total : m.used + m.avail;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (m.used / total) * 100));
}

export function getMemTotalBytes(node: NodeSummary): number {
  if (node.mem_total && node.mem_total > 0) return node.mem_total;
  const m = node.metrics?.mem;
  return m ? m.used + m.avail : 0;
}

export function getDiskUsagePct(disk: DiskMetrics | null): number {
  if (!disk || disk.total <= 0) return 0;
  return Math.max(0, Math.min(100, (disk.used / disk.total) * 100));
}

export function getTrafficUsagePct(traffic: NodeSummary["traffic"]): number {
  if (!traffic.limit_bytes || traffic.limit_bytes <= 0) return 0;
  return Math.max(0, (traffic.counted_bytes / traffic.limit_bytes) * 100);
}

export interface OsBadgeInfo {
  short: string;
  colorClass: string;
}

export function parseOsBadge(os: string | null | undefined): OsBadgeInfo {
  const neutralClass =
    "bg-[var(--bg-subtle)] text-[var(--text-secondary)] border-[var(--border-hairline)]";
  if (!os) {
    return { short: "Linux", colorClass: neutralClass };
  }
  const lower = os.toLowerCase();
  if (lower.includes("debian")) {
    return { short: "Debian", colorClass: neutralClass };
  }
  if (lower.includes("ubuntu")) {
    return { short: "Ubuntu", colorClass: neutralClass };
  }
  if (lower.includes("alpine")) {
    return { short: "Alpine", colorClass: neutralClass };
  }
  if (lower.includes("arch")) {
    return { short: "Arch", colorClass: neutralClass };
  }
  if (lower.includes("rocky")) {
    return { short: "Rocky", colorClass: neutralClass };
  }
  if (lower.includes("alma")) {
    return { short: "Alma", colorClass: neutralClass };
  }
  if (
    lower.includes("centos") ||
    lower.includes("red hat") ||
    lower.includes("rhel") ||
    lower.includes("fedora")
  ) {
    return {
      short: lower.includes("fedora") ? "Fedora" : "RHEL",
      colorClass: neutralClass,
    };
  }
  const firstWord = os.split(/[\s/(]/)[0] || "Linux";
  return {
    short: firstWord.slice(0, 12),
    colorClass: neutralClass,
  };
}

export function getMetricBarColor(pct: number): string {
  if (pct >= 88) return "bg-[var(--status-danger)]";
  if (pct >= 75) return "bg-[var(--status-warn)]";
  return "bg-[var(--accent)]";
}

export function getMetricTextColor(pct: number): string {
  if (pct >= 88) return "text-[var(--status-danger-ink)]";
  if (pct >= 75) return "text-[var(--status-warn-ink)]";
  return "text-[var(--text-primary)]";
}

export function isNodeMuted(node: NodeSummary): boolean {
  return (
    node.mute_until !== null && node.mute_until > Math.floor(Date.now() / 1000)
  );
}

const TRAFFIC_MODE_LABELS: Record<string, string> = {
  both: "双向计费",
  tx_only: "仅算上传",
  rx_only: "仅算下载",
  max: "双向取大",
};

export function formatTrafficMode(mode: string | null | undefined): string {
  if (!mode) return "—";
  return TRAFFIC_MODE_LABELS[mode] ?? mode;
}

const ALERT_METRIC_LABELS: Record<string, string> = {
  offline: "服务器离线",
  cpu: "CPU 占用",
  steal: "CPU 争抢",
  mem: "内存占用",
  swap: "Swap 占用",
  disk: "磁盘占用",
  traffic_pct: "月流量使用率",
  watchdog: "服务端连通性",
  firing: "告警中",
  FIRING: "告警中",
  resolved: "已恢复",
  RESOLVED: "已恢复",
};

export function formatAlertMetric(metric: string | null | undefined): string {
  if (!metric) return "—";
  return ALERT_METRIC_LABELS[metric] ?? metric;
}

export function formatAlertStatus(status: string | null | undefined): string {
  if (!status) return "—";
  const upper = status.toUpperCase();
  if (upper === "FIRING") return "告警中";
  if (upper === "RESOLVED") return "已恢复";
  return status;
}

export function formatDurationZh(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  if (s === 0) return "0 秒";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0) {
    parts.push(`${mins} 分${hours === 0 && days === 0 && secs === 0 ? "钟" : ""}`);
  }
  if (secs > 0) parts.push(`${secs} 秒`);
  return parts.join(" ");
}

export function formatAlertCondition(
  metric: string,
  operator: string,
  threshold: number,
): string {
  const opText = operator === "gte" ? "≥" : ">";
  if (metric === "offline") {
    return `离线 ${opText} ${formatDurationZh(threshold)}`;
  }
  return `${formatAlertMetric(metric)} ${opText} ${threshold}%`;
}

export function formatCycleMonth(cycleKey: string | null | undefined): string {
  if (!cycleKey) return "—";
  const match = /^(\d{4})-(\d{1,2})$/.exec(cycleKey.trim());
  if (!match) return cycleKey;
  return `${match[1]} 年 ${Number(match[2])} 月`;
}

export function formatNodeMetaLine(
  node: Pick<
    HorizonNode,
    "region_code" | "provider" | "ipv4_masked" | "hostname"
  >,
  options?: { includeHostnameFallback?: boolean },
): string {
  const endpoint =
    node.ipv4_masked ||
    (options?.includeHostnameFallback ? (node.hostname ?? "") : "");
  return [node.region_code, node.provider, endpoint]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" · ");
}
