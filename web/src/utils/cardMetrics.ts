import type {
  CardPrimaryMetric,
  HorizonNode,
  NodeMetricsSnapshot,
} from "../types.ts";

export interface CardPrimaryMetricOption {
  value: CardPrimaryMetric;
  label: string;
}

export const CARD_PRIMARY_METRIC_OPTIONS: CardPrimaryMetricOption[] = [
  { value: "net", label: "实时网络" },
  { value: "cpu", label: "CPU" },
  { value: "latency", label: "TCP 延迟" },
  { value: "mem", label: "内存" },
];

export type BottomMetricSlot = "net" | "cpu" | "mem" | "disk" | "traffic";

export function parseCardPrimaryMetric(
  val: string | null | undefined,
): CardPrimaryMetric {
  if (val === "net" || val === "cpu" || val === "latency" || val === "mem") {
    return val;
  }
  return "net";
}

export function getSnapshotLatencyMs(
  metrics: NodeMetricsSnapshot | null | undefined,
): number | null {
  const nq = metrics?.network_quality;
  if (!nq || nq.enabled === false || !Array.isArray(nq.latest)) {
    return null;
  }
  const okLatencies = nq.latest
    .filter(
      (item) =>
        item.result === "ok" &&
        typeof item.latency_median_ms === "number" &&
        Number.isFinite(item.latency_median_ms) &&
        item.latency_median_ms >= 0,
    )
    .map((item) => item.latency_median_ms as number)
    .sort((a, b) => a - b);

  if (okLatencies.length === 0) return null;
  const mid = Math.floor(okLatencies.length / 2);
  const median =
    okLatencies.length % 2 === 1
      ? okLatencies[mid]!
      : (okLatencies[mid - 1]! + okLatencies[mid]!) / 2;
  return Math.round(median * 10) / 10;
}

export function getSnapshotMemPct(
  metrics: NodeMetricsSnapshot | null | undefined,
  declaredMemTotal: number | null | undefined,
): number {
  if (!metrics) return 0;
  const total =
    declaredMemTotal && declaredMemTotal > 0
      ? declaredMemTotal
      : metrics.mem.used + metrics.mem.avail;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (metrics.mem.used / total) * 100));
}

export function formatRateBpsText(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const idx = Math.min(
    Math.floor(Math.log(bps) / Math.log(1024)),
    units.length - 1,
  );
  const val = bps / Math.pow(1024, idx);
  const digits = idx === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 1;
  return `${val.toFixed(digits)} ${units[idx]}`;
}

export function getBottomMetricSlots(
  primaryMetric: CardPrimaryMetric,
): [BottomMetricSlot, BottomMetricSlot, BottomMetricSlot, BottomMetricSlot] {
  return [
    primaryMetric === "cpu" ? "net" : "cpu",
    primaryMetric === "mem" ? "net" : "mem",
    "disk",
    "traffic",
  ];
}

export interface PrimaryPlotSeries {
  label: string;
  color: string;
  data: number[];
}

export interface CardPrimaryPlotModel {
  primaryMetric: CardPrimaryMetric;
  heroLabel: string;
  offline: boolean;
  hasLiveChart: boolean;
  placeholderText: string;
  unitKind: "bps" | "pct" | "ms";
  yMax?: number;
  yUnit: string;
  primaryValueText: string;
  netRatePair?: { rx: string; tx: string };
  series: PrimaryPlotSeries[];
  bottomSlots: [
    BottomMetricSlot,
    BottomMetricSlot,
    BottomMetricSlot,
    BottomMetricSlot,
  ];
}

export function resolvePrimaryMetricCard(
  node: Pick<
    HorizonNode,
    | "online"
    | "mem_total"
    | "metrics"
    | "sparkline_cpu"
    | "sparkline_rx"
    | "sparkline_tx"
    | "sparkline_mem"
    | "sparkline_latency"
  >,
  primaryMetric: CardPrimaryMetric,
): CardPrimaryPlotModel {
  const bottomSlots = getBottomMetricSlots(primaryMetric);
  const offline = !node.online;

  if (offline) {
    const heroLabel =
      CARD_PRIMARY_METRIC_OPTIONS.find((o) => o.value === primaryMetric)
        ?.label ?? "实时网络";
    return {
      primaryMetric,
      heroLabel,
      offline: true,
      hasLiveChart: false,
      placeholderText: "离线",
      unitKind:
        primaryMetric === "net"
          ? "bps"
          : primaryMetric === "latency"
            ? "ms"
            : "pct",
      yMax:
        primaryMetric === "cpu" || primaryMetric === "mem" ? 100 : undefined,
      yUnit:
        primaryMetric === "cpu" || primaryMetric === "mem"
          ? "%"
          : primaryMetric === "latency"
            ? " ms"
            : "",
      primaryValueText: "—",
      series: [],
      bottomSlots,
    };
  }

  const m = node.metrics;
  if (!m) {
    const heroLabel =
      CARD_PRIMARY_METRIC_OPTIONS.find((o) => o.value === primaryMetric)
        ?.label ?? "实时网络";
    return {
      primaryMetric,
      heroLabel,
      offline: false,
      hasLiveChart: false,
      placeholderText: "等待数据",
      unitKind:
        primaryMetric === "net"
          ? "bps"
          : primaryMetric === "latency"
            ? "ms"
            : "pct",
      yMax:
        primaryMetric === "cpu" || primaryMetric === "mem" ? 100 : undefined,
      yUnit:
        primaryMetric === "cpu" || primaryMetric === "mem"
          ? "%"
          : primaryMetric === "latency"
            ? " ms"
            : "",
      primaryValueText: "—",
      series: [],
      bottomSlots,
    };
  }

  switch (primaryMetric) {
    case "cpu": {
      const val = m.cpu.all;
      const data = node.sparkline_cpu.length > 0 ? node.sparkline_cpu : [val, val];
      return {
        primaryMetric,
        heroLabel: "CPU",
        offline: false,
        hasLiveChart: true,
        placeholderText: "",
        unitKind: "pct",
        yMax: 100,
        yUnit: "%",
        primaryValueText: `${val.toFixed(1)}%`,
        series: [{ label: "CPU", color: "var(--accent)", data }],
        bottomSlots,
      };
    }
    case "mem": {
      const val = getSnapshotMemPct(m, node.mem_total);
      const data = node.sparkline_mem.length > 0 ? node.sparkline_mem : [val, val];
      return {
        primaryMetric,
        heroLabel: "内存",
        offline: false,
        hasLiveChart: true,
        placeholderText: "",
        unitKind: "pct",
        yMax: 100,
        yUnit: "%",
        primaryValueText: `${val.toFixed(1)}%`,
        series: [{ label: "内存", color: "var(--status-ok)", data }],
        bottomSlots,
      };
    }
    case "latency": {
      const latestMs = getSnapshotLatencyMs(m);
      const spark = node.sparkline_latency;
      if (latestMs === null && spark.length === 0) {
        return {
          primaryMetric,
          heroLabel: "TCP 延迟",
          offline: false,
          hasLiveChart: false,
          placeholderText:
            m.network_quality?.enabled === false ? "探测未启用" : "等待延迟样本",
          unitKind: "ms",
          yUnit: " ms",
          primaryValueText: "—",
          series: [],
          bottomSlots,
        };
      }
      const data = spark.length > 0 ? spark : [latestMs!, latestMs!];
      const headline = latestMs ?? data[data.length - 1]!;
      return {
        primaryMetric,
        heroLabel: "TCP 延迟",
        offline: false,
        hasLiveChart: true,
        placeholderText: "",
        unitKind: "ms",
        yUnit: " ms",
        primaryValueText: `${headline.toFixed(1)} ms`,
        series: [{ label: "延迟", color: "var(--accent)", data }],
        bottomSlots,
      };
    }
    case "net":
    default: {
      const rxData =
        node.sparkline_rx.length > 0
          ? node.sparkline_rx
          : [m.net.rx_bps, m.net.rx_bps];
      const txData =
        node.sparkline_tx.length > 0
          ? node.sparkline_tx
          : [m.net.tx_bps, m.net.tx_bps];
      const rx = formatRateBpsText(m.net.rx_bps);
      const tx = formatRateBpsText(m.net.tx_bps);
      return {
        primaryMetric: "net",
        heroLabel: "实时网络",
        offline: false,
        hasLiveChart: true,
        placeholderText: "",
        unitKind: "bps",
        yUnit: "",
        primaryValueText: `↓ ${rx} · ↑ ${tx}`,
        netRatePair: { rx, tx },
        series: [
          { label: "↓", color: "var(--accent)", data: rxData },
          { label: "↑", color: "var(--status-ok)", data: txData },
        ],
        bottomSlots,
      };
    }
  }
}
