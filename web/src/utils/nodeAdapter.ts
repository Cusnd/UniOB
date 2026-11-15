import { useMemo, useRef } from "react";
import type { LiveMetricSample } from "../hooks/useFleetSocket";
import type { HorizonNode, NodeSummary } from "../types";

const MAX_SPARKLINE_POINTS = 24;

interface RegionRule {
  region_code: string;
  region_flag: string;
  phrases: string[];
  tokenRegex: RegExp;
}

const REGION_RULES: RegionRule[] = [
  {
    region_code: "HKG",
    region_flag: "🇭🇰",
    phrases: ["香港", "hong kong", "hongkong"],
    tokenRegex: /(?:^|[^a-z])(hkg|hk)(?:[^a-z]|$)/i,
  },
  {
    region_code: "TYO",
    region_flag: "🇯🇵",
    phrases: ["东京", "日本", "大阪"],
    tokenRegex: /(?:^|[^a-z])(tyo|nrt|kix|jp|jpn|tokyo|osaka|japan)(?:[^a-z]|$)/i,
  },
  {
    region_code: "SIN",
    region_flag: "🇸🇬",
    phrases: ["新加坡"],
    tokenRegex: /(?:^|[^a-z])(sin|sgp|sg|singapore)(?:[^a-z]|$)/i,
  },
  {
    region_code: "USA",
    region_flag: "🇺🇸",
    phrases: ["美国", "united states"],
    tokenRegex:
      /(?:^|[^a-z])(usa|us|sjc|lax|sea|iad|nyc|ewr|ord|dfw|atl|mia|america)(?:[^a-z]|$)/i,
  },
  {
    region_code: "FRA",
    region_flag: "🇩🇪",
    phrases: ["德国", "法兰克福"],
    tokenRegex: /(?:^|[^a-z])(fra|de|deu|germany|frankfurt)(?:[^a-z]|$)/i,
  },
  {
    region_code: "LON",
    region_flag: "🇬🇧",
    phrases: ["英国", "伦敦"],
    tokenRegex: /(?:^|[^a-z])(lon|lhr|uk|gbr|london)(?:[^a-z]|$)/i,
  },
  {
    region_code: "ICN",
    region_flag: "🇰🇷",
    phrases: ["韩国", "首尔"],
    tokenRegex: /(?:^|[^a-z])(icn|sel|kr|kor|korea|seoul)(?:[^a-z]|$)/i,
  },
  {
    region_code: "TPE",
    region_flag: "🇹🇼",
    phrases: ["台湾", "台北"],
    tokenRegex: /(?:^|[^a-z])(tpe|tw|twn|taiwan|taipei)(?:[^a-z]|$)/i,
  },
  {
    region_code: "AMS",
    region_flag: "🇳🇱",
    phrases: ["荷兰", "阿姆斯特丹"],
    tokenRegex: /(?:^|[^a-z])(ams|nl|nld|netherlands|amsterdam)(?:[^a-z]|$)/i,
  },
  {
    region_code: "PAR",
    region_flag: "🇫🇷",
    phrases: ["法国", "巴黎"],
    tokenRegex: /(?:^|[^a-z])(par|cdg|fr|france|paris)(?:[^a-z]|$)/i,
  },
  {
    region_code: "CAN",
    region_flag: "🇨🇦",
    phrases: ["加拿大"],
    tokenRegex: /(?:^|[^a-z])(can|ca|yyz|yvr|canada)(?:[^a-z]|$)/i,
  },
  {
    region_code: "SYD",
    region_flag: "🇦🇺",
    phrases: ["澳大利亚", "悉尼"],
    tokenRegex: /(?:^|[^a-z])(syd|au|aus|australia|sydney)(?:[^a-z]|$)/i,
  },
  {
    region_code: "CHN",
    region_flag: "🇨🇳",
    phrases: ["中国"],
    tokenRegex: /(?:^|[^a-z])(chn|china|cn(?!2))(?:[^a-z]|$)/i,
  },
];

const REGION_PREFIX_RE = /^(?:region|loc|area|geo)\s*:\s*(.+)$/i;
const PROVIDER_PREFIX_RE = /^(?:provider|isp)\s*:\s*(.+)$/i;
const IP_PREFIX_RE = /^(?:ip|ipv4)\s*:\s*(.+)$/i;
const IPV4_PATTERN_RE =
  /(?<![a-z0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3}|xx|\*+)\.(\d{1,3})(?![a-z0-9.])/i;

function matchRegionText(
  text: string | null | undefined,
): { region_code: string; region_flag: string } | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const rule of REGION_RULES) {
    if (rule.phrases.some((phrase) => lower.includes(phrase))) {
      return { region_code: rule.region_code, region_flag: rule.region_flag };
    }
    if (rule.tokenRegex.test(trimmed)) {
      return { region_code: rule.region_code, region_flag: rule.region_flag };
    }
  }
  return null;
}

function isPureRegionTag(tag: string): boolean {
  const trimmed = tag.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  for (const rule of REGION_RULES) {
    if (rule.phrases.includes(lower)) return true;
    const stripped = trimmed.replace(/[^a-z0-9\u4e00-\u9fff]/gi, "");
    if (stripped === trimmed && rule.tokenRegex.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function extractMaskedIpv4(text: string | null | undefined): string {
  if (!text) return "";
  const match = IPV4_PATTERN_RE.exec(text);
  if (!match) return "";
  const o1 = Number(match[1]);
  const o2 = Number(match[2]);
  const o4 = Number(match[4]);
  if (
    !Number.isInteger(o1) ||
    !Number.isInteger(o2) ||
    !Number.isInteger(o4) ||
    o1 > 255 ||
    o2 > 255 ||
    o4 > 255
  ) {
    return "";
  }
  if (/^\d+$/.test(match[3])) {
    const o3 = Number(match[3]);
    if (!Number.isInteger(o3) || o3 > 255) return "";
  }
  return `${o1}.${o2}.xx.${o4}`;
}

export function inferRegionMeta(node: NodeSummary): {
  region_code: string;
  region_flag: string;
} {
  const tags = Array.isArray(node.tags) ? node.tags : [];

  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag) continue;
    const explicit = REGION_PREFIX_RE.exec(tag);
    if (explicit) {
      const val = explicit[1].trim();
      const matched = matchRegionText(val);
      if (matched) return matched;
      if (val) {
        return {
          region_code: val.slice(0, 4).toUpperCase(),
          region_flag: "🖥️",
        };
      }
    }
  }

  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag) continue;
    if (
      REGION_PREFIX_RE.test(tag) ||
      PROVIDER_PREFIX_RE.test(tag) ||
      IP_PREFIX_RE.test(tag)
    ) {
      continue;
    }
    const matched = matchRegionText(tag);
    if (matched) return matched;
  }

  const fromName = matchRegionText(node.name);
  if (fromName) return fromName;

  const fromGroup = matchRegionText(node.group_name);
  if (fromGroup) return fromGroup;

  const fromHost = matchRegionText(node.hostname);
  if (fromHost) return fromHost;

  const arch = node.arch?.trim();
  return {
    region_code: arch ? arch.slice(0, 3).toUpperCase() : "LNX",
    region_flag: "🖥️",
  };
}

export function extractProviderAndIp(node: NodeSummary): {
  provider: string;
  ipv4_masked: string;
} {
  const tags = Array.isArray(node.tags) ? node.tags : [];

  let provider = "";
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag) continue;
    const explicit = PROVIDER_PREFIX_RE.exec(tag);
    if (explicit && explicit[1].trim()) {
      provider = explicit[1].trim();
      break;
    }
  }

  if (!provider) {
    for (const rawTag of tags) {
      const tag = rawTag.trim();
      if (!tag) continue;
      if (
        REGION_PREFIX_RE.test(tag) ||
        PROVIDER_PREFIX_RE.test(tag) ||
        IP_PREFIX_RE.test(tag)
      ) {
        continue;
      }
      if (extractMaskedIpv4(tag)) continue;
      if (isPureRegionTag(tag)) continue;
      provider = tag;
      break;
    }
  }

  let ipv4_masked = "";
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const explicitIp = IP_PREFIX_RE.exec(tag);
    if (explicitIp) {
      const masked = extractMaskedIpv4(explicitIp[1]);
      if (masked) {
        ipv4_masked = masked;
        break;
      }
    }
  }

  if (!ipv4_masked) {
    for (const rawTag of tags) {
      const masked = extractMaskedIpv4(rawTag);
      if (masked) {
        ipv4_masked = masked;
        break;
      }
    }
  }

  if (!ipv4_masked) {
    ipv4_masked =
      extractMaskedIpv4(node.hostname) || extractMaskedIpv4(node.name);
  }

  return { provider, ipv4_masked };
}

interface SparklineBuffer {
  lastTs: number | null;
  cpu: number[];
  rx: number[];
  tx: number[];
}

export function useHorizonNodes(
  nodes: NodeSummary[],
  liveSeriesByNode: Record<string, LiveMetricSample[]>,
): HorizonNode[] {
  const bufferRef = useRef<Map<string, SparklineBuffer>>(new Map());

  return useMemo(() => {
    const bufMap = bufferRef.current;
    const activeIds = new Set(nodes.map((n) => n.id));
    for (const id of bufMap.keys()) {
      if (!activeIds.has(id)) {
        bufMap.delete(id);
      }
    }

    return nodes.map((node) => {
      let entry = bufMap.get(node.id);
      if (!entry) {
        entry = { lastTs: null, cpu: [], rx: [], tx: [] };
        bufMap.set(node.id, entry);
      }

      const liveSeries = liveSeriesByNode[node.id];
      if (Array.isArray(liveSeries) && liveSeries.length > 0) {
        const recent = liveSeries.slice(-MAX_SPARKLINE_POINTS);
        for (const sample of recent) {
          if (
            sample?.metrics &&
            (entry.lastTs === null || sample.ts > entry.lastTs)
          ) {
            entry.cpu = [...entry.cpu, sample.metrics.cpu.all].slice(
              -MAX_SPARKLINE_POINTS,
            );
            entry.rx = [...entry.rx, sample.metrics.net.rx_bps].slice(
              -MAX_SPARKLINE_POINTS,
            );
            entry.tx = [...entry.tx, sample.metrics.net.tx_bps].slice(
              -MAX_SPARKLINE_POINTS,
            );
            entry.lastTs = sample.ts;
          }
        }
      }

      const m = node.metrics;
      if (m && (entry.lastTs === null || m.ts > entry.lastTs)) {
        entry.cpu = [...entry.cpu, m.cpu.all].slice(-MAX_SPARKLINE_POINTS);
        entry.rx = [...entry.rx, m.net.rx_bps].slice(-MAX_SPARKLINE_POINTS);
        entry.tx = [...entry.tx, m.net.tx_bps].slice(-MAX_SPARKLINE_POINTS);
        entry.lastTs = m.ts;
      }

      const region = inferRegionMeta(node);
      const { provider, ipv4_masked } = extractProviderAndIp(node);

      return {
        ...node,
        region_code: region.region_code,
        region_flag: region.region_flag,
        provider,
        ipv4_masked,
        sparkline_cpu: entry.cpu,
        sparkline_rx: entry.rx,
        sparkline_tx: entry.tx,
      };
    });
  }, [nodes, liveSeriesByNode]);
}
