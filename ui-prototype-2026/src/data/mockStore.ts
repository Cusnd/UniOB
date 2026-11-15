import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccentPreset,
  AlertIncident,
  AlertRule,
  AppRoute,
  CreateNodePayload,
  CreateNodeResponse,
  DensityMode,
  DiskMetrics,
  FleetViewMode,
  HistoricalMetricPoint,
  HubMode,
  HubStatusResponse,
  LiveSample,
  MetricsRange,
  NodeMetricsHistoryResponse,
  NodeMetricsSnapshot,
  NotificationChannel,
  ProcEntry,
  PrototypeNode,
  RotateTokenResponse,
  SimSpeed,
  ThemeMode,
  ToastMessage,
  UpdateNodePayload,
  WatchdogConfig,
} from "../types";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const TiB = 1024 * GiB;
const Mbps = 125_000; // bytes/sec per Mbps

const THEME_STORAGE_KEY = "uniob_horizon_theme";
const ACCENT_STORAGE_KEY = "uniob_horizon_accent";
const DENSITY_STORAGE_KEY = "uniob_horizon_density";

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHex(len: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function getCurrentCycleInfo(resetDay: number): {
  cycleKey: string;
  daysRemaining: number;
} {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const cycleKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const today = now.getDate();
  let nextReset: Date;
  if (today < resetDay) {
    nextReset = new Date(year, month, resetDay);
  } else {
    nextReset = new Date(year, month + 1, resetDay);
  }
  const daysRemaining = Math.max(
    1,
    Math.ceil((nextReset.getTime() - now.getTime()) / 86_400_000),
  );
  return { cycleKey, daysRemaining };
}

interface NodeSeedProfile {
  id: string;
  name: string;
  group_name: string;
  tags: string[];
  sort_order: number;
  region_code: string;
  region_flag: string;
  provider: string;
  ipv4_masked: string;
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpu_model: string;
  cpu_cores: number;
  mem_total: number;
  swap_total: number;
  agent_version: string;
  proc_enabled: boolean;
  mute_until: number | null;
  online: boolean;
  uptimeSec: number;
  baseCpu: number;
  baseSteal: number;
  baseIowait: number;
  baseMemPct: number;
  baseCachedRatio: number;
  baseSwapPct: number;
  baseRxMbps: number;
  baseTxMbps: number;
  baseTcpEst: number;
  baseUdp: number;
  disks: Array<{
    mp: string;
    fs: string;
    totalGb: number;
    usedPct: number;
    rMbps: number;
    wMbps: number;
  }>;
  trafficLimitTb: number | null;
  trafficCountedPct: number;
  trafficMode: "both" | "tx_only" | "max";
  resetDay: number;
}

function buildInitialData(nowSec: number): {
  nodes: PrototypeNode[];
  liveSeriesByNode: Record<string, LiveSample[]>;
  procsByNode: Record<string, ProcEntry[]>;
} {
  const profiles: NodeSeedProfile[] = [
    // Group 1: 亚太核心 BGP
    {
      id: "nd_01jhkbgpedge01",
      name: "hk-bgp-edge-01",
      group_name: "亚太核心 BGP",
      tags: ["BGP", "Edge", "Prod"],
      sort_order: 1,
      region_code: "HKG",
      region_flag: "🇭🇰",
      provider: "Misaka BGP",
      ipv4_masked: "45.134.xx.18",
      hostname: "hk-bgp-edge-01.uniob.net",
      os: "Debian GNU/Linux 12 (bookworm)",
      kernel: "6.1.0-28-amd64",
      arch: "x86_64",
      cpu_model: "AMD EPYC 9654 96-Core Processor",
      cpu_cores: 8,
      mem_total: 16 * GiB,
      swap_total: 2 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 64 * 86400 + 14 * 3600,
      baseCpu: 26.4,
      baseSteal: 0.2,
      baseIowait: 0.5,
      baseMemPct: 48.2,
      baseCachedRatio: 0.28,
      baseSwapPct: 1.5,
      baseRxMbps: 245,
      baseTxMbps: 218,
      baseTcpEst: 1842,
      baseUdp: 96,
      disks: [
        {
          mp: "/",
          fs: "/dev/vda1 (ext4)",
          totalGb: 160,
          usedPct: 41,
          rMbps: 14,
          wMbps: 22,
        },
      ],
      trafficLimitTb: 10,
      trafficCountedPct: 54,
      trafficMode: "both",
      resetDay: 1,
    },
    {
      id: "nd_01jtyoeqxprod1",
      name: "tyo-eqx-prod-01",
      group_name: "亚太核心 BGP",
      tags: ["Equinix", "Core", "10G"],
      sort_order: 2,
      region_code: "NRT",
      region_flag: "🇯🇵",
      provider: "Equinix Metal",
      ipv4_masked: "103.82.xx.91",
      hostname: "tyo-eqx-prod-01.uniob.net",
      os: "Ubuntu 24.04.1 LTS",
      kernel: "6.8.0-49-generic",
      arch: "x86_64",
      cpu_model: "AMD EPYC 7543P 32-Core Processor",
      cpu_cores: 16,
      mem_total: 32 * GiB,
      swap_total: 4 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 112 * 86400 + 7 * 3600,
      baseCpu: 42.8,
      baseSteal: 0.1,
      baseIowait: 0.8,
      baseMemPct: 61.5,
      baseCachedRatio: 0.25,
      baseSwapPct: 2.0,
      baseRxMbps: 348,
      baseTxMbps: 312,
      baseTcpEst: 3210,
      baseUdp: 184,
      disks: [
        {
          mp: "/",
          fs: "/dev/nvme0n1p2 (xfs)",
          totalGb: 480,
          usedPct: 53,
          rMbps: 42,
          wMbps: 58,
        },
        {
          mp: "/data",
          fs: "/dev/nvme1n1 (xfs)",
          totalGb: 1024,
          usedPct: 62,
          rMbps: 86,
          wMbps: 110,
        },
      ],
      trafficLimitTb: 20,
      trafficCountedPct: 48,
      trafficMode: "both",
      resetDay: 5,
    },
    {
      id: "nd_01jsincn2prox2",
      name: "sin-cn2-proxy-02",
      group_name: "亚太核心 BGP",
      tags: ["CN2-GIA", "Traffic-Warn"],
      sort_order: 3,
      region_code: "SIN",
      region_flag: "🇸🇬",
      provider: "DMIT CN2 GIA",
      ipv4_masked: "194.127.xx.44",
      hostname: "sin-cn2-proxy-02.uniob.net",
      os: "Debian GNU/Linux 12 (bookworm)",
      kernel: "6.1.0-26-amd64",
      arch: "x86_64",
      cpu_model: "Intel Xeon Platinum 8352V",
      cpu_cores: 2,
      mem_total: 2 * GiB,
      swap_total: 1 * GiB,
      agent_version: "2.4.0",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 28 * 86400 + 3 * 3600,
      baseCpu: 37.5,
      baseSteal: 0.4,
      baseIowait: 0.6,
      baseMemPct: 56.0,
      baseCachedRatio: 0.22,
      baseSwapPct: 4.0,
      baseRxMbps: 192,
      baseTxMbps: 185,
      baseTcpEst: 1420,
      baseUdp: 312,
      disks: [
        {
          mp: "/",
          fs: "/dev/vda1 (ext4)",
          totalGb: 40,
          usedPct: 38,
          rMbps: 4,
          wMbps: 8,
        },
      ],
      trafficLimitTb: 2,
      trafficCountedPct: 94.2,
      trafficMode: "both",
      resetDay: 20,
    },

    // Group 2: 欧美生产集群
    {
      id: "nd_01jfrahetzner4",
      name: "fra-hetzner-core",
      group_name: "欧美生产集群",
      tags: ["EU-Central", "Muted"],
      sort_order: 4,
      region_code: "FRA",
      region_flag: "🇩🇪",
      provider: "Hetzner Cloud",
      ipv4_masked: "138.201.xx.72",
      hostname: "fra-hetzner-core.uniob.net",
      os: "Rocky Linux 9.4 (Blue Onyx)",
      kernel: "5.14.0-427.el9.x86_64",
      arch: "x86_64",
      cpu_model: "AMD EPYC 7763 64-Core Processor",
      cpu_cores: 8,
      mem_total: 16 * GiB,
      swap_total: 2 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: nowSec + 5400, // 维护静默中 (1.5h)
      online: true,
      uptimeSec: 47 * 86400 + 19 * 3600,
      baseCpu: 31.8,
      baseSteal: 0.3,
      baseIowait: 1.1,
      baseMemPct: 54.0,
      baseCachedRatio: 0.26,
      baseSwapPct: 2.0,
      baseRxMbps: 112,
      baseTxMbps: 104,
      baseTcpEst: 920,
      baseUdp: 48,
      disks: [
        {
          mp: "/",
          fs: "/dev/sda1 (xfs)",
          totalGb: 160,
          usedPct: 49,
          rMbps: 18,
          wMbps: 26,
        },
      ],
      trafficLimitTb: 20,
      trafficCountedPct: 29,
      trafficMode: "tx_only",
      resetDay: 1,
    },
    {
      id: "nd_01jlaxkvmovrs5",
      name: "lax-kvm-oversold",
      group_name: "欧美生产集群",
      tags: ["KVM", "Noisy-Neighbor"],
      sort_order: 5,
      region_code: "LAX",
      region_flag: "🇺🇸",
      provider: "CloudCone KVM",
      ipv4_masked: "173.82.xx.109",
      hostname: "lax-kvm-oversold.uniob.net",
      os: "Ubuntu 22.04.5 LTS",
      kernel: "5.15.0-125-generic",
      arch: "x86_64",
      cpu_model: "Intel Xeon E5-2697 v4 (KVM)",
      cpu_cores: 4,
      mem_total: 4 * GiB,
      swap_total: 2 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 19 * 86400 + 8 * 3600,
      baseCpu: 63.5,
      baseSteal: 6.8,
      baseIowait: 4.1,
      baseMemPct: 71.4,
      baseCachedRatio: 0.14,
      baseSwapPct: 14.0,
      baseRxMbps: 68,
      baseTxMbps: 62,
      baseTcpEst: 680,
      baseUdp: 42,
      disks: [
        {
          mp: "/",
          fs: "/dev/vda1 (ext4)",
          totalGb: 80,
          usedPct: 67,
          rMbps: 24,
          wMbps: 34,
        },
      ],
      trafficLimitTb: 4,
      trafficCountedPct: 61,
      trafficMode: "both",
      resetDay: 10,
    },
    {
      id: "nd_01jamsvaultsc6",
      name: "ams-vault-sec-01",
      group_name: "欧美生产集群",
      tags: ["Vault", "Privacy-Lock"],
      sort_order: 6,
      region_code: "AMS",
      region_flag: "🇳🇱",
      provider: "Leaseweb NL",
      ipv4_masked: "95.211.xx.15",
      hostname: "ams-vault-sec-01.uniob.net",
      os: "Alpine Linux v3.20",
      kernel: "6.6.58-0-lts",
      arch: "x86_64",
      cpu_model: "AMD EPYC 7313P 16-Core Processor",
      cpu_cores: 4,
      mem_total: 8 * GiB,
      swap_total: 0,
      agent_version: "2.4.1",
      proc_enabled: false, // 隐私保护节点：禁止进程列表上报
      mute_until: null,
      online: true,
      uptimeSec: 94 * 86400 + 2 * 3600,
      baseCpu: 14.2,
      baseSteal: 0.0,
      baseIowait: 0.2,
      baseMemPct: 36.4,
      baseCachedRatio: 0.34,
      baseSwapPct: 0,
      baseRxMbps: 34,
      baseTxMbps: 29,
      baseTcpEst: 310,
      baseUdp: 14,
      disks: [
        {
          mp: "/",
          fs: "/dev/nvme0n1p1 (ext4)",
          totalGb: 120,
          usedPct: 31,
          rMbps: 6,
          wMbps: 9,
        },
      ],
      trafficLimitTb: 10,
      trafficCountedPct: 18,
      trafficMode: "both",
      resetDay: 1,
    },

    // Group 3: AI 推理与计算
    {
      id: "nd_01jsjcgpuinf7",
      name: "sjc-gpu-infer-01",
      group_name: "AI 推理与计算",
      tags: ["vLLM", "NVMe", "ARM64/CUDA"],
      sort_order: 7,
      region_code: "SJC",
      region_flag: "🇺🇸",
      provider: "CoreWeave SJC",
      ipv4_masked: "144.48.xx.203",
      hostname: "sjc-gpu-infer-01.uniob.net",
      os: "Ubuntu 24.04.1 LTS",
      kernel: "6.8.0-45-generic",
      arch: "x86_64",
      cpu_model: "AMD EPYC 9354 32-Core Processor",
      cpu_cores: 16,
      mem_total: 128 * GiB,
      swap_total: 8 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 36 * 86400 + 11 * 3600,
      baseCpu: 68.4,
      baseSteal: 0.0,
      baseIowait: 1.9,
      baseMemPct: 74.2,
      baseCachedRatio: 0.19,
      baseSwapPct: 0.5,
      baseRxMbps: 510,
      baseTxMbps: 430,
      baseTcpEst: 4860,
      baseUdp: 128,
      disks: [
        {
          mp: "/",
          fs: "/dev/nvme0n1p2 (ext4)",
          totalGb: 512,
          usedPct: 58,
          rMbps: 145,
          wMbps: 72,
        },
        {
          mp: "/models",
          fs: "/dev/nvme1n1 (xfs)",
          totalGb: 4096,
          usedPct: 76,
          rMbps: 420,
          wMbps: 36,
        },
      ],
      trafficLimitTb: null, // 不限流量
      trafficCountedPct: 0,
      trafficMode: "both",
      resetDay: 1,
    },
    {
      id: "nd_01jselvectdb8",
      name: "sel-vector-db-01",
      group_name: "AI 推理与计算",
      tags: ["Qdrant", "High-Freq"],
      sort_order: 8,
      region_code: "ICN",
      region_flag: "🇰🇷",
      provider: "Vultr High Freq",
      ipv4_masked: "45.76.xx.61",
      hostname: "sel-vector-db-01.uniob.net",
      os: "AlmaLinux 9.4 (Seafoam Ocelot)",
      kernel: "5.14.0-427.37.1.el9.x86_64",
      arch: "x86_64",
      cpu_model: "Intel Xeon E-2388G",
      cpu_cores: 8,
      mem_total: 32 * GiB,
      swap_total: 4 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 52 * 86400 + 6 * 3600,
      baseCpu: 46.2,
      baseSteal: 0.5,
      baseIowait: 1.4,
      baseMemPct: 72.0,
      baseCachedRatio: 0.24,
      baseSwapPct: 3.0,
      baseRxMbps: 164,
      baseTxMbps: 142,
      baseTcpEst: 1580,
      baseUdp: 64,
      disks: [
        {
          mp: "/",
          fs: "/dev/vda1 (xfs)",
          totalGb: 320,
          usedPct: 64,
          rMbps: 95,
          wMbps: 48,
        },
      ],
      trafficLimitTb: 8,
      trafficCountedPct: 41,
      trafficMode: "max",
      resetDay: 15,
    },
    {
      id: "nd_01jlonmlwrkr9",
      name: "lon-worker-ml-03",
      group_name: "AI 推理与计算",
      tags: ["Worker", "Offline-Alert"],
      sort_order: 9,
      region_code: "LHR",
      region_flag: "🇬🇧",
      provider: "OVHcloud UK",
      ipv4_masked: "51.89.xx.134",
      hostname: "lon-worker-ml-03.uniob.net",
      os: "Debian GNU/Linux 12 (bookworm)",
      kernel: "6.1.0-25-amd64",
      arch: "x86_64",
      cpu_model: "AMD EPYC 7443P 24-Core Processor",
      cpu_cores: 16,
      mem_total: 64 * GiB,
      swap_total: 4 * GiB,
      agent_version: "2.3.9",
      proc_enabled: true,
      mute_until: null,
      online: false, // 离线告警中节点
      uptimeSec: 0,
      baseCpu: 0,
      baseSteal: 0,
      baseIowait: 0,
      baseMemPct: 0,
      baseCachedRatio: 0,
      baseSwapPct: 0,
      baseRxMbps: 0,
      baseTxMbps: 0,
      baseTcpEst: 0,
      baseUdp: 0,
      disks: [
        {
          mp: "/",
          fs: "/dev/nvme0n1p1 (ext4)",
          totalGb: 500,
          usedPct: 51,
          rMbps: 0,
          wMbps: 0,
        },
      ],
      trafficLimitTb: 15,
      trafficCountedPct: 37,
      trafficMode: "both",
      resetDay: 1,
    },

    // Group 4: 边缘与灾备节点
    {
      id: "nd_01jnrtmicr1g10",
      name: "nrt-micro-1g-01",
      group_name: "边缘与灾备节点",
      tags: ["1G-VPS", "Mem-Pressure"],
      sort_order: 10,
      region_code: "NRT",
      region_flag: "🇯🇵",
      provider: "BuyVM KVM",
      ipv4_masked: "209.141.xx.87",
      hostname: "nrt-micro-1g-01.uniob.net",
      os: "Alpine Linux v3.20",
      kernel: "6.6.58-0-virt",
      arch: "x86_64",
      cpu_model: "AMD Ryzen 9 3900X (KVM)",
      cpu_cores: 1,
      mem_total: 1 * GiB, // 1G 小内存高压 ~92%
      swap_total: 1 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 41 * 86400 + 5 * 3600,
      baseCpu: 48.0,
      baseSteal: 0.7,
      baseIowait: 1.5,
      baseMemPct: 92.1,
      baseCachedRatio: 0.06,
      baseSwapPct: 31.0,
      baseRxMbps: 18,
      baseTxMbps: 16,
      baseTcpEst: 265,
      baseUdp: 24,
      disks: [
        {
          mp: "/",
          fs: "/dev/vda1 (ext4)",
          totalGb: 20,
          usedPct: 68,
          rMbps: 2.5,
          wMbps: 4.1,
        },
      ],
      trafficLimitTb: 1,
      trafficCountedPct: 58,
      trafficMode: "both",
      resetDay: 12,
    },
    {
      id: "nd_01jtpeedge11",
      name: "tpe-edge-dns-01",
      group_name: "边缘与灾备节点",
      tags: ["Anycast-DNS", "ARM64"],
      sort_order: 11,
      region_code: "TPE",
      region_flag: "🇹🇼",
      provider: "HiNet Edge",
      ipv4_masked: "61.220.xx.52",
      hostname: "tpe-edge-dns-01.uniob.net",
      os: "Arch Linux ARM",
      kernel: "6.11.6-1-aarch64",
      arch: "aarch64",
      cpu_model: "Ampere Altra Neoverse-N1",
      cpu_cores: 2,
      mem_total: 2 * GiB,
      swap_total: 512 * MiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 78 * 86400 + 22 * 3600,
      baseCpu: 18.6,
      baseSteal: 0.0,
      baseIowait: 0.3,
      baseMemPct: 44.5,
      baseCachedRatio: 0.29,
      baseSwapPct: 0.0,
      baseRxMbps: 46,
      baseTxMbps: 49,
      baseTcpEst: 412,
      baseUdp: 684,
      disks: [
        {
          mp: "/",
          fs: "/dev/mmcblk0p2 (ext4)",
          totalGb: 32,
          usedPct: 46,
          rMbps: 3.1,
          wMbps: 5.2,
        },
      ],
      trafficLimitTb: 3,
      trafficCountedPct: 33,
      trafficMode: "both",
      resetDay: 1,
    },
    {
      id: "nd_01jsgpbkpnas12",
      name: "sgp-backup-nas",
      group_name: "边缘与灾备节点",
      tags: ["ZFS/Restic", "Backup"],
      sort_order: 12,
      region_code: "SIN",
      region_flag: "🇸🇬",
      provider: "Contabo Storage",
      ipv4_masked: "167.86.xx.29",
      hostname: "sgp-backup-nas.uniob.net",
      os: "Debian GNU/Linux 12 (bookworm)",
      kernel: "6.1.0-28-amd64",
      arch: "x86_64",
      cpu_model: "AMD EPYC 7282 16-Core Processor",
      cpu_cores: 4,
      mem_total: 8 * GiB,
      swap_total: 2 * GiB,
      agent_version: "2.4.1",
      proc_enabled: true,
      mute_until: null,
      online: true,
      uptimeSec: 131 * 86400 + 9 * 3600,
      baseCpu: 28.4,
      baseSteal: 0.6,
      baseIowait: 5.1,
      baseMemPct: 67.8,
      baseCachedRatio: 0.32,
      baseSwapPct: 4.5,
      baseRxMbps: 138,
      baseTxMbps: 24,
      baseTcpEst: 194,
      baseUdp: 18,
      disks: [
        {
          mp: "/",
          fs: "/dev/sda1 (ext4)",
          totalGb: 64,
          usedPct: 44,
          rMbps: 6,
          wMbps: 11,
        },
        {
          mp: "/mnt/vault",
          fs: "/dev/sdb1 (ext4)",
          totalGb: 2048,
          usedPct: 79,
          rMbps: 34,
          wMbps: 142,
        },
      ],
      trafficLimitTb: 32,
      trafficCountedPct: 26,
      trafficMode: "tx_only",
      resetDay: 1,
    },
  ];

  const nodes: PrototypeNode[] = [];
  const liveSeriesByNode: Record<string, LiveSample[]> = {};
  const procsByNode: Record<string, ProcEntry[]> = {};

  for (const p of profiles) {
    const rng = createRng(hashSeed(p.id));
    const { cycleKey, daysRemaining } = getCurrentCycleInfo(p.resetDay);
    const limitBytes = p.trafficLimitTb ? p.trafficLimitTb * TiB : null;
    const countedBytes = limitBytes
      ? Math.round((limitBytes * p.trafficCountedPct) / 100)
      : Math.round(2.4 * TiB + rng() * 1.8 * TiB);
    const rxBytes =
      p.trafficMode === "tx_only"
        ? Math.round(countedBytes * 1.35)
        : p.trafficMode === "max"
          ? countedBytes
          : Math.round(countedBytes * 0.52);
    const txBytes =
      p.trafficMode === "tx_only"
        ? countedBytes
        : p.trafficMode === "max"
          ? Math.round(countedBytes * 0.86)
          : Math.max(0, countedBytes - rxBytes);

    const samples: LiveSample[] = [];
    const sparkCpu: number[] = [];
    const sparkRx: number[] = [];
    const sparkTx: number[] = [];

    if (p.online) {
      for (let i = 0; i < 60; i++) {
        const ts = nowSec - (59 - i) * 2;
        const phase = i * 0.24 + rng() * 0.35;
        const cpuVal = round1(
          clamp(
            p.baseCpu + Math.sin(phase) * 4.2 + (rng() - 0.5) * 3.8,
            1.5,
            98.5,
          ),
        );
        const stealVal = round1(
          clamp(
            p.baseSteal +
              (p.baseSteal > 1 ? Math.sin(phase * 0.7) * 0.6 : 0) +
              (rng() - 0.5) * 0.25,
            0,
            25,
          ),
        );
        const iowaitVal = round1(
          clamp(p.baseIowait + (rng() - 0.5) * 0.8, 0, 20),
        );

        const cores: number[] = [];
        for (let c = 0; c < p.cpu_cores; c++) {
          const coreDrift = Math.sin(phase + c * 0.85) * 9 + (rng() - 0.5) * 8;
          cores.push(round1(clamp(cpuVal + coreDrift, 1, 99.5)));
        }

        const memUsedPct = clamp(
          p.baseMemPct + Math.sin(phase * 0.3) * 0.9 + (rng() - 0.5) * 0.8,
          8,
          96.5,
        );
        const memUsed = Math.round((p.mem_total * memUsedPct) / 100);
        const memAvail = Math.max(0, p.mem_total - memUsed);
        const memCached = Math.round(p.mem_total * p.baseCachedRatio);
        const swapUsed = Math.round((p.swap_total * p.baseSwapPct) / 100);

        const rxBps = Math.max(
          20_000,
          Math.round(
            (p.baseRxMbps + Math.sin(phase * 0.6) * p.baseRxMbps * 0.18 + (rng() - 0.5) * p.baseRxMbps * 0.14) *
              Mbps,
          ),
        );
        const txBps = Math.max(
          20_000,
          Math.round(
            (p.baseTxMbps + Math.cos(phase * 0.55) * p.baseTxMbps * 0.18 + (rng() - 0.5) * p.baseTxMbps * 0.14) *
              Mbps,
          ),
        );

        const disks: DiskMetrics[] = p.disks.map((d) => ({
          mp: d.mp,
          fs: d.fs,
          total: d.totalGb * GiB,
          used: Math.round((d.totalGb * GiB * d.usedPct) / 100),
          r_bps: Math.max(
            0,
            Math.round(d.rMbps * MiB * (0.85 + rng() * 0.35)),
          ),
          w_bps: Math.max(
            0,
            Math.round(d.wMbps * MiB * (0.85 + rng() * 0.35)),
          ),
        }));

        const loadBase = (cpuVal / 100) * p.cpu_cores;
        const snapshot: NodeMetricsSnapshot = {
          ts,
          up: p.uptimeSec + i * 2,
          cpu: {
            all: cpuVal,
            cores,
            steal: p.id === "nd_01jlaxkvmovrs5" && i === 59 ? 6.8 : stealVal,
            iowait: iowaitVal,
            load: [
              round1(Math.max(0.05, loadBase + (rng() - 0.5) * 0.25)),
              round1(Math.max(0.05, loadBase * 0.94)),
              round1(Math.max(0.05, loadBase * 0.88)),
            ],
          },
          mem: {
            used: memUsed,
            avail: memAvail,
            cached: memCached,
            swap_used: swapUsed,
          },
          disks,
          net: {
            rx_bps: rxBps,
            tx_bps: txBps,
            rx_tot: rxBytes,
            tx_tot: txBytes,
            tcp_est: Math.max(
              10,
              Math.round(p.baseTcpEst + (rng() - 0.5) * 45),
            ),
            tcp_tw: Math.max(2, Math.round(p.baseTcpEst * 0.06)),
            udp: Math.max(4, Math.round(p.baseUdp + (rng() - 0.5) * 12)),
          },
        };
        samples.push({ ts, metrics: snapshot });
        if (i >= 36) {
          sparkCpu.push(cpuVal);
          sparkRx.push(rxBps);
          sparkTx.push(txBps);
        }
      }
    } else {
      for (let i = 0; i < 24; i++) {
        sparkCpu.push(0);
        sparkRx.push(0);
        sparkTx.push(0);
      }
    }

    const latestMetrics =
      samples.length > 0 ? samples[samples.length - 1].metrics : null;
    const lastSeenTs = p.online ? nowSec : nowSec - 420;

    const node: PrototypeNode = {
      id: p.id,
      name: p.name,
      group_name: p.group_name,
      tags: p.tags,
      sort_order: p.sort_order,
      hostname: p.hostname,
      os: p.os,
      kernel: p.kernel,
      arch: p.arch,
      cpu_model: p.cpu_model,
      cpu_cores: p.cpu_cores,
      mem_total: p.mem_total,
      swap_total: p.swap_total,
      agent_version: p.agent_version,
      proc_enabled: p.proc_enabled,
      mute_until: p.mute_until,
      online: p.online,
      last_seen_ts: lastSeenTs,
      created_at: nowSec - 90 * 86400 + p.sort_order * 3600,
      updated_at: lastSeenTs,
      traffic: {
        limit_bytes: limitBytes,
        reset_day: p.resetDay,
        count_mode: p.trafficMode,
        cycle_key: cycleKey,
        rx_bytes: rxBytes,
        tx_bytes: txBytes,
        counted_bytes: countedBytes,
        days_remaining: daysRemaining,
      },
      metrics: latestMetrics,
      region_code: p.region_code,
      region_flag: p.region_flag,
      provider: p.provider,
      ipv4_masked: p.ipv4_masked,
      sparkline_cpu: sparkCpu,
      sparkline_rx: sparkRx,
      sparkline_tx: sparkTx,
    };

    nodes.push(node);
    liveSeriesByNode[node.id] = samples;
    procsByNode[node.id] = buildProcsForNode(node);
  }

  return { nodes, liveSeriesByNode, procsByNode };
}

function buildProcsForNode(node: PrototypeNode): ProcEntry[] {
  if (!node.online) return [];
  const memTotal = node.mem_total ?? 4 * GiB;
  const scale = clamp(memTotal / (8 * GiB), 0.14, 6);

  const baseList: ProcEntry[] = [
    {
      pid: 1,
      user: "root",
      comm: "systemd",
      st: "S",
      cpu: 0.1,
      rss: Math.round(11 * MiB),
      thr: 1,
      cmd: "/sbin/init --no-reexec",
    },
    {
      pid: 412,
      user: "uniob",
      comm: "uniob-agent",
      st: "S",
      cpu: 0.2,
      rss: Math.round(4.6 * MiB),
      thr: 3,
      cmd: "/usr/local/bin/uniob-agent --config /etc/uniob/agent.toml",
    },
    {
      pid: 892,
      user: "www-data",
      comm: "caddy",
      st: "R",
      cpu: round1(clamp(6.4 + (node.metrics?.cpu.all ?? 20) * 0.22, 1.2, 34)),
      rss: Math.round(68 * MiB * Math.min(scale, 2.2)),
      thr: 12,
      cmd: "/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile",
    },
    {
      pid: 1240,
      user: "root",
      comm: "containerd",
      st: "S",
      cpu: 1.8,
      rss: Math.round(92 * MiB * Math.min(scale, 1.8)),
      thr: 16,
      cmd: "/usr/bin/containerd --config /etc/containerd/config.toml",
    },
    {
      pid: 1684,
      user: "redis",
      comm: "redis-server",
      st: "S",
      cpu: 2.3,
      rss: Math.round(180 * MiB * scale),
      thr: 5,
      cmd: "/usr/bin/redis-server 127.0.0.1:6379 --appendonly yes",
    },
    {
      pid: 2108,
      user: "postgres",
      comm: "postgres",
      st: "S",
      cpu: round1(clamp((node.metrics?.cpu.all ?? 25) * 0.28, 1.1, 41)),
      rss: Math.round(460 * MiB * scale),
      thr: 8,
      cmd: "postgres: writer process cluster/prod-ledger",
    },
    {
      pid: 2491,
      user: "app",
      comm: "node",
      st: "R",
      cpu: round1(clamp((node.metrics?.cpu.all ?? 20) * 0.18, 0.9, 28)),
      rss: Math.round(240 * MiB * Math.min(scale, 2.4)),
      thr: 11,
      cmd: "/usr/bin/node /srv/gateway/dist/server.mjs --workers=4",
    },
    {
      pid: 3180,
      user: "root",
      comm: "sshd",
      st: "S",
      cpu: 0.0,
      rss: Math.round(7.8 * MiB),
      thr: 1,
      cmd: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups",
    },
  ];

  if (node.group_name === "AI 推理与计算") {
    baseList.unshift({
      pid: 2810,
      user: "mlops",
      comm: node.name.includes("vector") ? "qdrant" : "vllm-worker",
      st: "R",
      cpu: round1(clamp((node.metrics?.cpu.all ?? 50) * 0.62, 12, 82)),
      rss: Math.round(memTotal * 0.44),
      thr: 32,
      cmd: node.name.includes("vector")
        ? "/usr/local/bin/qdrant --config-path /etc/qdrant/production.yaml"
        : "python3 -m vllm.entrypoints.openai.api_server --model qwen2.5-32b-awq",
    });
  }

  if (node.id === "nd_01jsgpbkpnas12" || node.id === "nd_01jlaxkvmovrs5") {
    baseList.push({
      pid: 4102,
      user: "backup",
      comm: "restic",
      st: "D", // 磁盘阻塞示例
      cpu: 3.4,
      rss: Math.round(145 * MiB),
      thr: 6,
      cmd: "/usr/bin/restic backup /srv/snapshots --repo s3:https://r2.uniob.internal/vault",
    });
  } else {
    baseList.push({
      pid: 4102,
      user: "root",
      comm: "kworker/u16:2",
      st: "D",
      cpu: 0.7,
      rss: 0,
      thr: 1,
      cmd: "[kworker/u16:2-flush-259:0]",
    });
  }

  baseList.push({
    pid: 4799,
    user: "app",
    comm: "python3",
    st: "Z", // 僵尸进程示例
    cpu: 0.0,
    rss: 0,
    thr: 1,
    cmd: "[python3] <defunct>",
  });

  if (node.id === "nd_01jnrtmicr1g10") {
    // 1G 小内存高压实例进程占比调整
    return baseList.map((proc) =>
      proc.pid === 2108
        ? { ...proc, rss: Math.round(318 * MiB), comm: "sing-box", cmd: "/usr/bin/sing-box run -c /etc/sing-box/config.json" }
        : proc.pid === 1684
          ? { ...proc, rss: Math.round(212 * MiB) }
          : proc,
    );
  }

  return baseList;
}

function generateHistoryPoints(
  node: PrototypeNode,
  range: MetricsRange,
): NodeMetricsHistoryResponse {
  const nowSec = Math.floor(Date.now() / 1000);
  const config: Record<
    MetricsRange,
    { count: number; stepSec: number; resolution: "30s" | "5m" | "1h" }
  > = {
    "1h": { count: 120, stepSec: 30, resolution: "30s" },
    "24h": { count: 288, stepSec: 300, resolution: "5m" },
    "7d": { count: 168, stepSec: 3600, resolution: "1h" },
    "30d": { count: 360, stepSec: 7200, resolution: "1h" },
    "1y": { count: 366, stepSec: 86400, resolution: "1h" },
  };

  const { count, stepSec, resolution } = config[range];
  const rng = createRng(hashSeed(`${node.id}:${range}`));

  const baseCpu = node.metrics?.cpu.all ?? (node.id === "nd_01jlonmlwrkr9" ? 44 : 28);
  const baseSteal = node.metrics?.cpu.steal ?? 0.3;
  const memTotal = node.mem_total ?? 8 * GiB;
  const baseMem = node.metrics?.mem.used ?? memTotal * 0.55;
  const baseSwap = node.metrics?.mem.swap_used ?? 0;
  const rootDisk = node.metrics?.disks[0];
  const baseDiskUsed = rootDisk?.used ?? 40 * GiB;
  const baseRx = node.metrics?.net.rx_bps ?? 85 * Mbps;
  const baseTx = node.metrics?.net.tx_bps ?? 72 * Mbps;
  const baseTcp = node.metrics?.net.tcp_est ?? 850;
  const cores = node.cpu_cores ?? 4;

  const endTs = node.online ? nowSec : (node.last_seen_ts ?? nowSec - 420);
  const points: HistoricalMetricPoint[] = [];

  for (let i = 0; i < count; i++) {
    const ts = endTs - (count - 1 - i) * stepSec;
    const progress = i / Math.max(1, count - 1);
    const diurnal = Math.sin(progress * Math.PI * (range === "1h" ? 2 : 6)) * 0.25;
    const spike = rng() > 0.92 ? 1.28 + rng() * 0.2 : 1.0;

    const cpu = round1(
      clamp(baseCpu * (0.85 + diurnal + (rng() - 0.5) * 0.28) * spike, 2, 97),
    );
    const cpuMax =
      range === "1h"
        ? undefined
        : round1(clamp(cpu + 8 + rng() * 19, cpu, 99.5));
    const steal = round1(
      clamp(baseSteal * (0.75 + rng() * 0.65), 0, 22),
    );
    const memUsed = Math.round(
      clamp(
        baseMem * (0.91 + diurnal * 0.14 + (rng() - 0.5) * 0.08),
        memTotal * 0.08,
        memTotal * 0.96,
      ),
    );
    const memMax =
      range === "1h"
        ? undefined
        : Math.round(
            clamp(memUsed * (1.04 + rng() * 0.08), memUsed, memTotal * 0.985),
          );

    points.push({
      ts,
      cpu,
      cpu_max: cpuMax,
      steal,
      load1: round1(Math.max(0.05, (cpu / 100) * cores)),
      mem_used: memUsed,
      mem_max: memMax,
      swap_used: Math.round(baseSwap * (0.85 + rng() * 0.3)),
      disk_used: Math.round(baseDiskUsed * (0.94 + progress * 0.06)),
      disk_r_bps: Math.round((rootDisk?.r_bps ?? 12 * MiB) * (0.6 + rng() * 0.9)),
      disk_w_bps: Math.round((rootDisk?.w_bps ?? 18 * MiB) * (0.6 + rng() * 0.9)),
      net_rx_bps: Math.max(
        10_000,
        Math.round(baseRx * (0.72 + diurnal * 0.45 + rng() * 0.42)),
      ),
      net_tx_bps: Math.max(
        10_000,
        Math.round(baseTx * (0.72 + diurnal * 0.45 + rng() * 0.42)),
      ),
      tcp_est: Math.max(12, Math.round(baseTcp * (0.8 + rng() * 0.4))),
    });
  }

  return {
    node_id: node.id,
    range,
    resolution,
    points,
  };
}

function readStoredTheme(): ThemeMode {
  try {
    const val = localStorage.getItem(THEME_STORAGE_KEY);
    if (val === "dark" || val === "light" || val === "system") return val;
  } catch {
    // ignore
  }
  return "dark";
}

function readStoredAccent(): AccentPreset {
  try {
    const val = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (val === "emerald" || val === "indigo" || val === "cyan") return val;
  } catch {
    // ignore
  }
  return "emerald";
}

function readStoredDensity(): DensityMode {
  try {
    const val = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (val === "comfortable" || val === "compact") return val;
  } catch {
    // ignore
  }
  return "comfortable";
}

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function usePrototypeStore() {
  const initialNow = useRef(Math.floor(Date.now() / 1000)).current;
  const initialData = useMemo(() => buildInitialData(initialNow), [initialNow]);

  const [route, setRoute] = useState<AppRoute>("dashboard");
  const [viewMode, setViewMode] = useState<FleetViewMode>("bento");
  const [selectedGroup, setSelectedGroup] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredTheme);
  const [systemDark, setSystemDark] = useState<boolean>(getSystemPrefersDark);
  const [accent, setAccentState] = useState<AccentPreset>(readStoredAccent);
  const [density, setDensityState] = useState<DensityMode>(readStoredDensity);
  const [simSpeed, setSimSpeed] = useState<SimSpeed>("2s");

  const [nodes, setNodes] = useState<PrototypeNode[]>(initialData.nodes);
  const [liveSeriesByNode, setLiveSeriesByNode] = useState<
    Record<string, LiveSample[]>
  >(initialData.liveSeriesByNode);
  const [procsByNode, setProcsByNode] = useState<Record<string, ProcEntry[]>>(
    initialData.procsByNode,
  );

  const [channels, setChannels] = useState<NotificationChannel[]>([
    {
      id: "ch_tg_ops",
      name: "运维值守 Telegram 群组",
      type: "telegram",
      enabled: true,
      config: {
        bot_token: "7492018812:AAH9kdemoTokenMasked4819",
        chat_id: "-1002389104412",
        thread_id: 42,
      },
      created_at: initialNow - 60 * 86400,
    },
    {
      id: "ch_wh_pager",
      name: "飞书 / PagerDuty Webhook",
      type: "webhook",
      enabled: true,
      config: {
        url: "https://hooks.ops.uniob.internal/v2/incident",
        secret: "whsec_demo_9f8a7b6c5d4e",
      },
      created_at: initialNow - 42 * 86400,
    },
  ]);

  const [rules, setRules] = useState<AlertRule[]>([
    {
      id: "rule_offline",
      name: "全节点失联掉线 (> 90s)",
      node_id: null,
      metric: "offline",
      operator: "gt",
      threshold: 90,
      duration_sec: 30,
      cooldown_sec: 1800,
      channel_ids: ["ch_tg_ops", "ch_wh_pager"],
      enabled: true,
      created_at: initialNow - 55 * 86400,
    },
    {
      id: "rule_steal",
      name: "KVM 宿主机 CPU Steal 争抢",
      node_id: null,
      metric: "steal",
      operator: "gte",
      threshold: 5,
      duration_sec: 120,
      cooldown_sec: 3600,
      channel_ids: ["ch_tg_ops"],
      enabled: true,
      created_at: initialNow - 48 * 86400,
    },
    {
      id: "rule_mem",
      name: "小内存节点高压预警 (> 90%)",
      node_id: null,
      metric: "mem",
      operator: "gt",
      threshold: 90,
      duration_sec: 180,
      cooldown_sec: 3600,
      channel_ids: ["ch_tg_ops", "ch_wh_pager"],
      enabled: true,
      created_at: initialNow - 40 * 86400,
    },
    {
      id: "rule_traffic",
      name: "月度计费流量临近上限 (>= 90%)",
      node_id: null,
      metric: "traffic_pct",
      operator: "gte",
      threshold: 90,
      duration_sec: 60,
      cooldown_sec: 43200,
      channel_ids: ["ch_tg_ops"],
      enabled: true,
      created_at: initialNow - 30 * 86400,
    },
    {
      id: "rule_cpu",
      name: "生产集群 CPU 持续满载 (> 92%)",
      node_id: null,
      metric: "cpu",
      operator: "gt",
      threshold: 92,
      duration_sec: 300,
      cooldown_sec: 3600,
      channel_ids: ["ch_wh_pager"],
      enabled: true,
      created_at: initialNow - 24 * 86400,
    },
  ]);

  const [incidents, setIncidents] = useState<AlertIncident[]>([
    {
      id: "inc_offline_lon",
      node_id: "nd_01jlonmlwrkr9",
      node_name: "lon-worker-ml-03",
      rule_id: "rule_offline",
      metric: "offline",
      status: "firing",
      trigger_value: 420,
      threshold: 90,
      message: "节点失联已超过 7 分钟，最后一次心跳来自伦敦 OVHcloud",
      started_at: initialNow - 360,
      resolved_at: null,
      last_notified_at: initialNow - 355,
    },
    {
      id: "inc_steal_lax",
      node_id: "nd_01jlaxkvmovrs5",
      node_name: "lax-kvm-oversold",
      rule_id: "rule_steal",
      metric: "steal",
      status: "firing",
      trigger_value: 6.8,
      threshold: 5,
      message: "宿主机 CPU Steal 争抢持续达 6.8% (>= 5%)，存在邻居超售抢占",
      started_at: initialNow - 1140,
      resolved_at: null,
      last_notified_at: initialNow - 1135,
    },
    {
      id: "inc_mem_nrt",
      node_id: "nd_01jnrtmicr1g10",
      node_name: "nrt-micro-1g-01",
      rule_id: "rule_mem",
      metric: "mem",
      status: "firing",
      trigger_value: 92.1,
      threshold: 90,
      message: "1 GiB 边缘实例物理内存占用达 92.1%，已触发 Swap 交换缓冲",
      started_at: initialNow - 820,
      resolved_at: null,
      last_notified_at: initialNow - 815,
    },
    {
      id: "inc_disk_sgp",
      node_id: "nd_01jsgpbkpnas12",
      node_name: "sgp-backup-nas",
      rule_id: "rule_cpu",
      metric: "disk",
      status: "resolved",
      trigger_value: 86.4,
      threshold: 85,
      message: "备份卷 /mnt/vault 归档写入峰值达 86.4%，自动清理过期快照后恢复",
      started_at: initialNow - 18400,
      resolved_at: initialNow - 14200,
      last_notified_at: initialNow - 14200,
    },
  ]);

  const [hubMode, setHubMode] = useState<HubMode>("cloudflare-worker");
  const [watchdogConfig, setWatchdogConfig] = useState<WatchdogConfig>({
    enabled: true,
    secret: "wd_live_8c4e19b2a7f044d9",
    timeout_sec: 600,
    cooldown_sec: 1800,
    hub_label: "tokyo-selfhost-hub-01",
    channel_ids: ["ch_tg_ops"],
  });

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastTimersRef = useRef<Record<string, number>>({});

  const nodesRef = useRef<PrototypeNode[]>(nodes);
  const liveSeriesRef = useRef<Record<string, LiveSample[]>>(liveSeriesByNode);
  const procsRef = useRef<Record<string, ProcEntry[]>>(procsByNode);
  const rulesRef = useRef<AlertRule[]>(rules);
  const channelsRef = useRef<NotificationChannel[]>(channels);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    liveSeriesRef.current = liveSeriesByNode;
  }, [liveSeriesByNode]);

  useEffect(() => {
    procsRef.current = procsByNode;
  }, [procsByNode]);

  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  // Sync system dark listener
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "dark" | "light" =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  // Sync DOM theme/accent/density attributes
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = themeMode;
    if (resolvedTheme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute(
        "content",
        resolvedTheme === "dark" ? "#07090e" : "#f5f7fa",
      );
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // ignore
    }
  }, [themeMode, resolvedTheme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    } catch {
      // ignore
    }
  }, [accent]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, density);
    } catch {
      // ignore
    }
  }, [density]);

  // Cleanup toast timers on unmount
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const t of Object.values(timers)) {
        window.clearTimeout(t);
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

  const notify = useCallback(
    (tone: ToastMessage["tone"], title: string, description?: string) => {
      const id = `toast_${Date.now()}_${randomHex(4)}`;
      setToasts((prev) => [...prev.slice(-3), { id, tone, title, description }]);
      toastTimersRef.current[id] = window.setTimeout(() => {
        dismissToast(id);
      }, 4200);
    },
    [dismissToast],
  );

  // Live telemetry simulation loop
  useEffect(() => {
    if (simSpeed === "paused") return;
    const intervalMs = simSpeed === "1s" ? 1000 : 2000;

    const timer = window.setInterval(() => {
      const nowSec = Math.floor(Date.now() / 1000);
      const prevNodes = nodesRef.current;
      const nextNodes: PrototypeNode[] = [];
      const appendedSamples: Record<string, LiveSample> = {};

      for (const node of prevNodes) {
        if (!node.online || !node.metrics) {
          nextNodes.push(node);
          continue;
        }

        const m = node.metrics;
        const nextTs = Math.max(nowSec, m.ts + 1);
        const isHighSteal = node.id === "nd_01jlaxkvmovrs5";
        const isMicroMem = node.id === "nd_01jnrtmicr1g10";

        const cpuDelta = (Math.random() - 0.5) * 4.4;
        const nextCpuAll = round1(clamp(m.cpu.all + cpuDelta, 2.5, 96.5));
        const nextSteal = isHighSteal
          ? round1(clamp(6.8 + (Math.random() - 0.5) * 0.7, 5.8, 7.9))
          : round1(clamp(m.cpu.steal + (Math.random() - 0.5) * 0.25, 0, 2.5));
        const nextIowait = round1(
          clamp(m.cpu.iowait + (Math.random() - 0.5) * 0.45, 0.1, 14),
        );
        const nextCores = m.cpu.cores.map((c, idx) => {
          const target = nextCpuAll + Math.sin(nextTs * 0.4 + idx) * 6;
          return round1(
            clamp(c * 0.45 + target * 0.55 + (Math.random() - 0.5) * 4, 1, 99.5),
          );
        });

        const memTotal = node.mem_total ?? m.mem.used + m.mem.avail;
        const curMemPct = memTotal > 0 ? (m.mem.used / memTotal) * 100 : 50;
        const nextMemPct = isMicroMem
          ? clamp(92.1 + (Math.random() - 0.5) * 1.1, 90.8, 93.6)
          : clamp(curMemPct + (Math.random() - 0.5) * 1.1, 10, 95);
        const nextMemUsed = Math.round((memTotal * nextMemPct) / 100);
        const nextMemAvail = Math.max(0, memTotal - nextMemUsed);

        const rxFactor = 0.88 + Math.random() * 0.24;
        const txFactor = 0.88 + Math.random() * 0.24;
        const nextRxBps = Math.max(15_000, Math.round(m.net.rx_bps * rxFactor));
        const nextTxBps = Math.max(15_000, Math.round(m.net.tx_bps * txFactor));
        const dtSec = Math.max(1, nextTs - m.ts);
        const rxDelta = nextRxBps * dtSec;
        const txDelta = nextTxBps * dtSec;
        const countedDelta =
          node.traffic.count_mode === "tx_only"
            ? txDelta
            : node.traffic.count_mode === "max"
              ? Math.max(rxDelta, txDelta)
              : rxDelta + txDelta;

        const nextDisks = m.disks.map((d) => ({
          ...d,
          r_bps: Math.max(
            0,
            Math.round(d.r_bps * (0.82 + Math.random() * 0.36)),
          ),
          w_bps: Math.max(
            0,
            Math.round(d.w_bps * (0.82 + Math.random() * 0.36)),
          ),
        }));

        const coreCount = Math.max(1, node.cpu_cores ?? nextCores.length);
        const load1Target = (nextCpuAll / 100) * coreCount;
        const nextMetrics: NodeMetricsSnapshot = {
          ts: nextTs,
          up: m.up + dtSec,
          cpu: {
            all: nextCpuAll,
            cores: nextCores,
            steal: nextSteal,
            iowait: nextIowait,
            load: [
              round1(Math.max(0.04, m.cpu.load[0] * 0.6 + load1Target * 0.4)),
              round1(Math.max(0.04, m.cpu.load[1] * 0.9 + load1Target * 0.1)),
              m.cpu.load[2],
            ],
          },
          mem: {
            used: nextMemUsed,
            avail: nextMemAvail,
            cached: m.mem.cached,
            swap_used: m.mem.swap_used,
          },
          disks: nextDisks,
          net: {
            rx_bps: nextRxBps,
            tx_bps: nextTxBps,
            rx_tot: m.net.rx_tot + rxDelta,
            tx_tot: m.net.tx_tot + txDelta,
            tcp_est: Math.max(
              10,
              Math.round(m.net.tcp_est + (Math.random() - 0.5) * 18),
            ),
            tcp_tw: Math.max(
              1,
              Math.round(m.net.tcp_tw + (Math.random() - 0.5) * 6),
            ),
            udp: Math.max(
              2,
              Math.round(m.net.udp + (Math.random() - 0.5) * 8),
            ),
          },
        };

        appendedSamples[node.id] = { ts: nextTs, metrics: nextMetrics };

        nextNodes.push({
          ...node,
          last_seen_ts: nextTs,
          updated_at: nextTs,
          traffic: {
            ...node.traffic,
            rx_bytes: node.traffic.rx_bytes + rxDelta,
            tx_bytes: node.traffic.tx_bytes + txDelta,
            counted_bytes: node.traffic.counted_bytes + countedDelta,
          },
          metrics: nextMetrics,
          sparkline_cpu: [...node.sparkline_cpu.slice(1), nextCpuAll],
          sparkline_rx: [...node.sparkline_rx.slice(1), nextRxBps],
          sparkline_tx: [...node.sparkline_tx.slice(1), nextTxBps],
        });
      }

      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      const prevSeries = liveSeriesRef.current;
      const nextSeries: Record<string, LiveSample[]> = { ...prevSeries };
      for (const [nodeId, sample] of Object.entries(appendedSamples)) {
        const existing = prevSeries[nodeId] ?? [];
        const last = existing[existing.length - 1];
        const safeSample =
          last && sample.ts <= last.ts
            ? { ...sample, ts: last.ts + 1 }
            : sample;
        nextSeries[nodeId] = [...existing.slice(-89), safeSample];
      }
      liveSeriesRef.current = nextSeries;
      setLiveSeriesByNode(nextSeries);

      const prevProcs = procsRef.current;
      const nextProcs: Record<string, ProcEntry[]> = { ...prevProcs };
      for (const [nodeId, list] of Object.entries(prevProcs)) {
        if (!appendedSamples[nodeId]) continue;
        nextProcs[nodeId] = list.map((proc) => {
          if (proc.st === "Z") return proc;
          return {
            ...proc,
            cpu:
              proc.cpu === 0
                ? 0
                : round1(
                    clamp(proc.cpu + (Math.random() - 0.5) * 1.4, 0.1, 95),
                  ),
          };
        });
      }
      procsRef.current = nextProcs;
      setProcsByNode(nextProcs);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [simSpeed]);

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

  const activeAlertsCount = useMemo(
    () => incidents.filter((inc) => inc.status === "firing").length,
    [incidents],
  );

  const hubStatus: HubStatusResponse = useMemo(() => {
    const connectedAgents = nodes.filter((n) => n.online).length;
    return {
      mode: hubMode,
      version: hubMode === "cloudflare-worker" ? "2.4.1-scch" : "2.4.1-axum",
      connected_agents: connectedAgents,
      total_nodes: nodes.length,
      watchdog: {
        enabled: watchdogConfig.enabled,
        last_ping_ts:
          hubMode === "self-hosted-hub" && watchdogConfig.enabled
            ? Math.floor(Date.now() / 1000) - 35
            : null,
        status: !watchdogConfig.enabled
          ? "disabled"
          : hubMode === "self-hosted-hub"
            ? "healthy"
            : "waiting",
        timeout_sec: watchdogConfig.timeout_sec,
      },
    };
  }, [hubMode, nodes, watchdogConfig]);

  const cycleTheme = useCallback(() => {
    setThemeMode((prev) =>
      prev === "dark" ? "light" : prev === "light" ? "system" : "dark",
    );
  }, []);

  const setAccent = useCallback((next: AccentPreset) => {
    setAccentState(next);
  }, []);

  const setDensity = useCallback((next: DensityMode) => {
    setDensityState(next);
  }, []);

  const getHistory = useCallback(
    (nodeId: string, range: MetricsRange): NodeMetricsHistoryResponse => {
      const found = nodes.find((n) => n.id === nodeId);
      if (!found) {
        return {
          node_id: nodeId,
          range,
          resolution: "30s",
          points: [],
        };
      }
      return generateHistoryPoints(found, range);
    },
    [nodes],
  );

  const createNode = useCallback(
    (payload: CreateNodePayload): CreateNodeResponse => {
      const nowSec = Math.floor(Date.now() / 1000);
      const id = `nd_${randomHex(12)}`;
      const token = `uob_live_${randomHex(24)}`;
      const { cycleKey, daysRemaining } = getCurrentCycleInfo(
        payload.traffic_reset_day || 1,
      );

      const nameLower = payload.name.toLowerCase();
      const regionGuess = nameLower.includes("hk")
        ? { code: "HKG", flag: "🇭🇰" }
        : nameLower.includes("jp") ||
            nameLower.includes("tyo") ||
            nameLower.includes("nrt")
          ? { code: "NRT", flag: "🇯🇵" }
          : nameLower.includes("sg") || nameLower.includes("sin")
            ? { code: "SIN", flag: "🇸🇬" }
            : nameLower.includes("fra") || nameLower.includes("de")
              ? { code: "FRA", flag: "🇩🇪" }
              : nameLower.includes("us") ||
                  nameLower.includes("lax") ||
                  nameLower.includes("sjc")
                ? { code: "LAX", flag: "🇺🇸" }
                : { code: "EDGE", flag: "🌐" };

      const newNode: PrototypeNode = {
        id,
        name: payload.name.trim(),
        group_name: payload.group_name.trim() || "亚太核心 BGP",
        tags: payload.tags,
        sort_order: payload.sort_order,
        hostname: null,
        os: null,
        kernel: null,
        arch: null,
        cpu_model: null,
        cpu_cores: null,
        mem_total: null,
        swap_total: null,
        agent_version: null,
        proc_enabled: true,
        mute_until: null,
        online: false,
        last_seen_ts: null,
        created_at: nowSec,
        updated_at: nowSec,
        traffic: {
          limit_bytes: payload.traffic_limit_bytes,
          reset_day: payload.traffic_reset_day,
          count_mode: payload.traffic_count_mode,
          cycle_key: cycleKey,
          rx_bytes: 0,
          tx_bytes: 0,
          counted_bytes: 0,
          days_remaining: daysRemaining,
        },
        metrics: null,
        region_code: regionGuess.code,
        region_flag: regionGuess.flag,
        provider: "Provisioned Node",
        ipv4_masked: `198.51.xx.${Math.floor(20 + Math.random() * 200)}`,
        sparkline_cpu: Array.from({ length: 24 }, () => 0),
        sparkline_rx: Array.from({ length: 24 }, () => 0),
        sparkline_tx: Array.from({ length: 24 }, () => 0),
      };

      const nextNodes = [...nodesRef.current, newNode];
      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      const nextSeries = { ...liveSeriesRef.current, [id]: [] };
      liveSeriesRef.current = nextSeries;
      setLiveSeriesByNode(nextSeries);

      const nextProcs = { ...procsRef.current, [id]: [] };
      procsRef.current = nextProcs;
      setProcsByNode(nextProcs);

      notify("info", `已注册节点 ${newNode.name}`, "等待探针首帧握手接入");

      const installCmd = `curl -fsSL https://edge.uniob.demo/install.sh | sudo bash -s -- --id ${id} --token ${token}`;
      return {
        node: newNode,
        agent_token: token,
        install_cmd: installCmd,
      };
    },
    [notify],
  );

  const simulateNodeOnline = useCallback(
    (nodeId: string) => {
      const target = nodesRef.current.find((n) => n.id === nodeId);
      if (!target) return;

      const nowSec = Math.floor(Date.now() / 1000);
      const memTotal = 8 * GiB;
      const swapTotal = 2 * GiB;
      const metrics: NodeMetricsSnapshot = {
        ts: nowSec,
        up: 185,
        cpu: {
          all: 14.6,
          cores: [16.2, 12.8, 15.1, 14.3],
          steal: 0.1,
          iowait: 0.4,
          load: [0.58, 0.42, 0.31],
        },
        mem: {
          used: Math.round(memTotal * 0.29),
          avail: Math.round(memTotal * 0.71),
          cached: Math.round(memTotal * 0.18),
          swap_used: 0,
        },
        disks: [
          {
            mp: "/",
            fs: "/dev/vda1 (ext4)",
            total: 80 * GiB,
            used: 18 * GiB,
            r_bps: 3.4 * MiB,
            w_bps: 6.2 * MiB,
          },
        ],
        net: {
          rx_bps: 18 * Mbps,
          tx_bps: 14 * Mbps,
          rx_tot: 120 * MiB,
          tx_tot: 85 * MiB,
          tcp_est: 96,
          tcp_tw: 8,
          udp: 14,
        },
      };

      const onlineNode: PrototypeNode = {
        ...target,
        hostname: `${target.name}.uniob.net`,
        os: "Debian GNU/Linux 12 (bookworm)",
        kernel: "6.1.0-28-amd64",
        arch: "x86_64",
        cpu_model: "AMD EPYC 7763 (vCPU)",
        cpu_cores: 4,
        mem_total: memTotal,
        swap_total: swapTotal,
        agent_version: "2.4.1",
        online: true,
        last_seen_ts: nowSec,
        updated_at: nowSec,
        metrics,
        sparkline_cpu: Array.from({ length: 24 }, (_, idx) =>
          round1(12 + Math.sin(idx * 0.5) * 3 + Math.random() * 2),
        ),
        sparkline_rx: Array.from({ length: 24 }, () =>
          Math.round((16 + Math.random() * 5) * Mbps),
        ),
        sparkline_tx: Array.from({ length: 24 }, () =>
          Math.round((12 + Math.random() * 4) * Mbps),
        ),
      };

      const initialSamples: LiveSample[] = Array.from(
        { length: 24 },
        (_, idx) => ({
          ts: nowSec - (23 - idx) * 2,
          metrics: {
            ...metrics,
            ts: nowSec - (23 - idx) * 2,
          },
        }),
      );

      const nextNodes = nodesRef.current.map((n) =>
        n.id === nodeId ? onlineNode : n,
      );
      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      const nextSeries = { ...liveSeriesRef.current, [nodeId]: initialSamples };
      liveSeriesRef.current = nextSeries;
      setLiveSeriesByNode(nextSeries);

      const nextProcs = {
        ...procsRef.current,
        [nodeId]: buildProcsForNode(onlineNode),
      };
      procsRef.current = nextProcs;
      setProcsByNode(nextProcs);

      notify("success", "探针已上线并完成 TLS 握手", "实时遥测流已接入机群大盘");
    },
    [notify],
  );

  const updateNode = useCallback(
    (id: string, patch: UpdateNodePayload) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const nextNodes = nodesRef.current.map((n) => {
        if (n.id !== id) return n;
        const nextTraffic = {
          ...n.traffic,
          limit_bytes:
            patch.traffic_limit_bytes !== undefined
              ? patch.traffic_limit_bytes
              : n.traffic.limit_bytes,
          reset_day: patch.traffic_reset_day ?? n.traffic.reset_day,
          count_mode: patch.traffic_count_mode ?? n.traffic.count_mode,
        };
        return {
          ...n,
          name: patch.name !== undefined ? patch.name : n.name,
          group_name:
            patch.group_name !== undefined ? patch.group_name : n.group_name,
          tags: patch.tags !== undefined ? patch.tags : n.tags,
          sort_order:
            patch.sort_order !== undefined ? patch.sort_order : n.sort_order,
          mute_until:
            patch.mute_until !== undefined ? patch.mute_until : n.mute_until,
          traffic: nextTraffic,
          updated_at: nowSec,
        };
      });
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      notify("success", "节点配置已更新");
    },
    [notify],
  );

  const muteNode = useCallback(
    (nodeId: string, seconds: number | null) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const muteUntil = seconds && seconds > 0 ? nowSec + seconds : null;
      const nextNodes = nodesRef.current.map((n) =>
        n.id === nodeId
          ? { ...n, mute_until: muteUntil, updated_at: nowSec }
          : n,
      );
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      if (muteUntil) {
        const mins = Math.round((seconds ?? 0) / 60);
        notify("info", `已开启维护静默 (${mins} 分钟)`, "静默期内将抑制该节点告警通知");
      } else {
        notify("success", "已取消维护静默", "恢复正常告警判定");
      }
    },
    [notify],
  );

  const rotateToken = useCallback(
    (nodeId: string): RotateTokenResponse => {
      const token = `uob_live_${randomHex(24)}`;
      const installCmd = `curl -fsSL https://edge.uniob.demo/install.sh | sudo bash -s -- --id ${nodeId} --token ${token}`;
      notify(
        "warning",
        "节点连接密钥已轮换",
        "旧 Token 已立即吊销，请在目标节点更新凭据",
      );
      return {
        agent_token: token,
        install_cmd: installCmd,
      };
    },
    [notify],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      const nextNodes = nodesRef.current.filter((n) => n.id !== nodeId);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      const nextSeries = { ...liveSeriesRef.current };
      delete nextSeries[nodeId];
      liveSeriesRef.current = nextSeries;
      setLiveSeriesByNode(nextSeries);

      const nextProcs = { ...procsRef.current };
      delete nextProcs[nodeId];
      procsRef.current = nextProcs;
      setProcsByNode(nextProcs);

      setIncidents((prev) => prev.filter((inc) => inc.node_id !== nodeId));
      notify("info", "已从监控台账移除服务器");
    },
    [notify],
  );

  const toggleProcPrivacyPreview = useCallback(
    (nodeId: string) => {
      const target = nodesRef.current.find((n) => n.id === nodeId);
      if (!target) return;

      const nextEnabled = !target.proc_enabled;
      const nextNodes = nodesRef.current.map((n) =>
        n.id === nodeId ? { ...n, proc_enabled: nextEnabled } : n,
      );
      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      if (
        nextEnabled &&
        (!procsRef.current[nodeId] || procsRef.current[nodeId].length === 0)
      ) {
        const nextProcs = {
          ...procsRef.current,
          [nodeId]: buildProcsForNode({ ...target, proc_enabled: true }),
        };
        procsRef.current = nextProcs;
        setProcsByNode(nextProcs);
      }

      notify(
        "info",
        nextEnabled
          ? "已演示启用 /proc 进程透视"
          : "已演示启用隐私保护（禁用进程上报）",
        "对应探针配置项 /etc/uniob/agent.toml -> proc_enabled",
      );
    },
    [notify],
  );

  const saveChannel = useCallback(
    (ch: Omit<NotificationChannel, "id" | "created_at"> & { id?: string }) => {
      const nowSec = Math.floor(Date.now() / 1000);
      if (ch.id) {
        const nextChannels = channelsRef.current.map((item) =>
          item.id === ch.id
            ? {
                ...item,
                name: ch.name,
                type: ch.type,
                enabled: ch.enabled,
                config: ch.config,
              }
            : item,
        );
        channelsRef.current = nextChannels;
        setChannels(nextChannels);
        notify("success", `已更新通知渠道「${ch.name}」`);
      } else {
        const newCh: NotificationChannel = {
          id: `ch_${randomHex(8)}`,
          name: ch.name,
          type: ch.type,
          enabled: ch.enabled,
          config: ch.config,
          created_at: nowSec,
        };
        const nextChannels = [...channelsRef.current, newCh];
        channelsRef.current = nextChannels;
        setChannels(nextChannels);
        notify("success", `已创建通知渠道「${ch.name}」`);
      }
    },
    [notify],
  );

  const toggleChannel = useCallback(
    (id: string) => {
      const nextChannels = channelsRef.current.map((c) =>
        c.id === id ? { ...c, enabled: !c.enabled } : c,
      );
      channelsRef.current = nextChannels;
      setChannels(nextChannels);
      notify("info", "通知渠道状态已切换");
    },
    [notify],
  );

  const deleteChannel = useCallback(
    (id: string) => {
      const nextChannels = channelsRef.current.filter((c) => c.id !== id);
      channelsRef.current = nextChannels;
      setChannels(nextChannels);

      const nextRules = rulesRef.current.map((r) => ({
        ...r,
        channel_ids: r.channel_ids.filter((cid) => cid !== id),
      }));
      rulesRef.current = nextRules;
      setRules(nextRules);
      notify("info", "通知渠道已删除");
    },
    [notify],
  );

  const testChannel = useCallback(
    (id: string) => {
      const ch = channelsRef.current.find((c) => c.id === id);
      notify(
        "success",
        `测试通知已推送至「${ch?.name ?? id}」`,
        "模拟返回 HTTP 200 OK · 延迟 142ms",
      );
    },
    [notify],
  );

  const saveRule = useCallback(
    (rule: Omit<AlertRule, "id" | "created_at"> & { id?: string }) => {
      const nowSec = Math.floor(Date.now() / 1000);
      if (rule.id) {
        const nextRules = rulesRef.current.map((item) =>
          item.id === rule.id
            ? {
                ...item,
                name: rule.name,
                node_id: rule.node_id,
                metric: rule.metric,
                operator: rule.operator,
                threshold: rule.threshold,
                duration_sec: rule.duration_sec,
                cooldown_sec: rule.cooldown_sec,
                channel_ids: rule.channel_ids,
                enabled: rule.enabled,
              }
            : item,
        );
        rulesRef.current = nextRules;
        setRules(nextRules);
        notify("success", `已保存告警规则「${rule.name}」`);
      } else {
        const newRule: AlertRule = {
          id: `rule_${randomHex(8)}`,
          name: rule.name,
          node_id: rule.node_id,
          metric: rule.metric,
          operator: rule.operator,
          threshold: rule.threshold,
          duration_sec: rule.duration_sec,
          cooldown_sec: rule.cooldown_sec,
          channel_ids: rule.channel_ids,
          enabled: rule.enabled,
          created_at: nowSec,
        };
        const nextRules = [...rulesRef.current, newRule];
        rulesRef.current = nextRules;
        setRules(nextRules);
        notify("success", `已新增告警规则「${rule.name}」`);
      }
    },
    [notify],
  );

  const toggleRule = useCallback(
    (id: string) => {
      const nextRules = rulesRef.current.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      );
      rulesRef.current = nextRules;
      setRules(nextRules);
      notify("info", "告警规则启用状态已更新");
    },
    [notify],
  );

  const deleteRule = useCallback(
    (id: string) => {
      const nextRules = rulesRef.current.filter((r) => r.id !== id);
      rulesRef.current = nextRules;
      setRules(nextRules);
      notify("info", "告警规则已删除");
    },
    [notify],
  );

  const applyPresets = useCallback(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const defaultChannels = channelsRef.current.map((c) => c.id);
    const templates: Array<Omit<AlertRule, "id" | "created_at">> = [
      {
        name: "全节点失联掉线 (> 90s)",
        node_id: null,
        metric: "offline",
        operator: "gt",
        threshold: 90,
        duration_sec: 30,
        cooldown_sec: 1800,
        channel_ids: defaultChannels,
        enabled: true,
      },
      {
        name: "KVM 宿主机 CPU Steal 争抢 (>= 5%)",
        node_id: null,
        metric: "steal",
        operator: "gte",
        threshold: 5,
        duration_sec: 120,
        cooldown_sec: 3600,
        channel_ids: defaultChannels,
        enabled: true,
      },
      {
        name: "物理内存高水位预警 (> 90%)",
        node_id: null,
        metric: "mem",
        operator: "gt",
        threshold: 90,
        duration_sec: 180,
        cooldown_sec: 3600,
        channel_ids: defaultChannels,
        enabled: true,
      },
      {
        name: "Swap 虚拟内存抖动预警 (> 75%)",
        node_id: null,
        metric: "swap",
        operator: "gt",
        threshold: 75,
        duration_sec: 180,
        cooldown_sec: 3600,
        channel_ids: defaultChannels,
        enabled: true,
      },
      {
        name: "根分区磁盘空间危急 (>= 88%)",
        node_id: null,
        metric: "disk",
        operator: "gte",
        threshold: 88,
        duration_sec: 60,
        cooldown_sec: 7200,
        channel_ids: defaultChannels,
        enabled: true,
      },
      {
        name: "月度计费流量即将耗尽 (>= 90%)",
        node_id: null,
        metric: "traffic_pct",
        operator: "gte",
        threshold: 90,
        duration_sec: 60,
        cooldown_sec: 43200,
        channel_ids: defaultChannels,
        enabled: true,
      },
    ];

    const currentRules = rulesRef.current;
    const existingMetrics = new Set(
      currentRules.map((r) => `${r.metric}:${r.threshold}`),
    );
    const nextRules = [...currentRules];
    let added = 0;

    for (const tpl of templates) {
      const key = `${tpl.metric}:${tpl.threshold}`;
      if (!existingMetrics.has(key) && nextRules.length < 10) {
        nextRules.push({
          ...tpl,
          id: `rule_tpl_${randomHex(6)}`,
          created_at: nowSec,
        });
        existingMetrics.add(key);
        added++;
      }
    }

    if (added > 0) {
      rulesRef.current = nextRules;
      setRules(nextRules);
    }

    notify(
      "success",
      added > 0
        ? `已应用黄金模板（新增 ${added} 条规则）`
        : "6 项推荐黄金模板已全部就绪",
    );
  }, [notify]);

  const resolveIncident = useCallback(
    (id: string) => {
      const nowSec = Math.floor(Date.now() / 1000);
      setIncidents((prev) =>
        prev.map((inc) =>
          inc.id === id
            ? {
                ...inc,
                status: "resolved",
                resolved_at: nowSec,
                last_notified_at: nowSec,
              }
            : inc,
        ),
      );
      notify("success", "告警事件已标记为已恢复");
    },
    [notify],
  );

  const switchHubModePreview = useCallback(
    (mode: HubMode) => {
      setHubMode(mode);
      notify(
        "info",
        mode === "cloudflare-worker"
          ? "已切换为 Cloudflare SCCH 边缘中枢模式 ($0/月)"
          : "已切换为自建 uniob-hub (Rust + SQLite WAL) 模式",
      );
    },
    [notify],
  );

  const saveWatchdog = useCallback(
    (cfg: WatchdogConfig) => {
      setWatchdogConfig(cfg);
      notify(
        "success",
        "Cloudflare 云端看门狗配置已保存",
        cfg.enabled
          ? `超时阈值 ${cfg.timeout_sec}s · 冷却 ${cfg.cooldown_sec}s`
          : "已暂停看门狗巡检",
      );
    },
    [notify],
  );

  return {
    route,
    setRoute,
    viewMode,
    setViewMode,
    selectedGroup,
    setSelectedGroup,
    searchQuery,
    setSearchQuery,
    themeMode,
    resolvedTheme,
    cycleTheme,
    accent,
    setAccent,
    density,
    setDensity,
    simSpeed,
    setSimSpeed,
    nodes: sortedNodes,
    groups,
    liveSeriesByNode,
    procsByNode,
    channels,
    rules,
    incidents,
    activeAlertsCount,
    hubMode,
    hubStatus,
    watchdogConfig,
    toasts,
    getHistory,
    createNode,
    simulateNodeOnline,
    updateNode,
    muteNode,
    rotateToken,
    deleteNode,
    toggleProcPrivacyPreview,
    saveChannel,
    toggleChannel,
    deleteChannel,
    testChannel,
    saveRule,
    toggleRule,
    deleteRule,
    applyPresets,
    resolveIncident,
    switchHubModePreview,
    saveWatchdog,
    notify,
    dismissToast,
  };
}
