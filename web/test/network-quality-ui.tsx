// Local, deterministic browser acceptance fixture; not an application route or production entry.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import { NetworkQualityPanel } from "../src/components/NetworkQualityPanel";
import { NodesOpsView } from "../src/components/NodesOpsView";
import { defaultNetworkConfig } from "../src/utils/networkQuality";
import type { HorizonNode, MetricsRange } from "../src/types";
import type { NetworkQualityConfig, NetworkNodeOverride, NetworkQualityQuery } from "../src/types/network-quality";

const now = Math.floor(Date.now() / 1000);
let globalConfig = { ...defaultNetworkConfig(), enabled: true };
let override: NetworkNodeOverride = { mode: "inherit" };
let version = "fixture";
let requestCount = 0;
const state = { supported: true, enabled: true, applied_config_id: version, config_error: null, dropped_samples: 0,
  latest: globalConfig.targets.map((target, i) => ({ target_id: target.id, target_revision: target.id, segment_id: `fixture:${target.id}`,
    target, measured_at: now - i, result: i === 1 ? "connect_timeout" as const : "ok" as const, remote_ip: `1.1.1.${i + 1}`,
    latency_median_ms: 72 + i * 30, attempts: 6, failures: i === 1 ? 1 : 0, failure_rate_pct: i === 1 ? 100 / 6 : 0 })) };
const metrics = { ts: now, up: 12345, cpu: { all: 10, cores: [10], steal: 0, iowait: 0, load: [0.1, 0.2, 0.1] as [number, number, number] },
  mem: { used: 1024, avail: 2048, cached: 0, swap_used: 0 }, disks: [], net: { rx_bps: 1024, tx_bps: 512, rx_tot: 0, tx_tot: 0, tcp_est: 5, tcp_tw: 0, udp: 0 }, network_quality: state };
const node = { id: "fixture", name: "Network quality fixture", group_name: "测试", tags: [], sort_order: 0, hostname: "fixture", os: "Linux", kernel: "6", arch: "x86_64",
  cpu_model: "Fixture", cpu_cores: 2, mem_total: 3072, swap_total: 0, agent_version: "0.2.0", proc_enabled: false, mute_until: null, online: true,
  last_seen_ts: now, created_at: now, updated_at: now, traffic: { limit_bytes: null, reset_day: 1, count_mode: "both", cycle_key: "2026-11", rx_bytes: 0, tx_bytes: 0, counted_bytes: 0, days_remaining: 15 },
  metrics, region_code: "CN", region_flag: "🇨🇳", provider: "Fixture", ipv4_masked: "1.1.1.*", sparkline_cpu: [], sparkline_rx: [], sparkline_tx: [], sparkline_mem: [], sparkline_latency: [] } as HorizonNode;

const configReply = (isGlobal: boolean) => {
  const effective = isGlobal || override.mode === "inherit" ? globalConfig : override.mode === "custom" ? override.config! : { ...globalConfig, enabled: false };
  return { config: isGlobal ? globalConfig : override, effective_config: { ...effective, schema_version: 1, config_id: version,
    targets: effective.targets.map(t => ({ ...t, target_revision: t.id })) }, config_id: version, applied_config_id: isGlobal ? null : state.applied_config_id, supported: true };
};
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  requestCount++;
  window.dispatchEvent(new CustomEvent("fixture-request", { detail: requestCount }));
  if (url.pathname.endsWith("/config")) {
    const isGlobal = url.pathname === "/api/network-quality/config";
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (isGlobal) globalConfig = body as NetworkQualityConfig;
      else override = body;
      version = `saved-${requestCount}`;
    }
    return Response.json(configReply(isGlobal));
  }
  const range = url.searchParams.get("range") as NetworkQualityQuery["range"];
  const resolution = range === "7d" || range === "30d" ? 300 : 20;
  const perPage =
    range === "30d" ? 4320 : range === "7d" ? 1008 : range === "24h" ? 2160 : 90;
  const totalPoints = perPage * 2;
  const page = url.searchParams.has("cursor") ? 1 : 0;
  const series = globalConfig.targets.map((target, i) => ({
    target_id: target.id,
    points: Array.from({ length: perPage }, (_, index) => {
      const n = index + page * perPage;
      const failed = n >= 30 && n < 40 && i === 1;
      const gap = n >= 55 && i === 0 ? 5 : 0;
      const spike =
        !failed &&
        ((i === 0 && (n === totalPoints - 18 || n === totalPoints - 52)) ||
          (i === 2 && n === totalPoints - 8));
      const baseLatency = 60 + i * 35 + Math.sin(n * 0.8) * 10;
      return {
        ts: now - (totalPoints + 5 - n) * resolution,
        segment_id:
          n < totalPoints - 30
            ? `fixture:${target.id}`
            : `fixture:${target.id}:new`,
        target_revision: target.id,
        target,
        remote_ip: `1.1.1.${i + 1}`,
        round_seq: resolution === 20 ? n + gap : null,
        result:
          resolution === 20
            ? failed
              ? ("connect_timeout" as const)
              : ("ok" as const)
            : null,
        latency_ms: failed ? null : spike ? 1320 : baseLatency,
        latency_max_ms: failed ? null : spike ? 1350 : 90 + i * 35,
        attempts: 6,
        failures: failed ? 6 : 0,
        success_count: failed ? 0 : 6,
        latency_sum_ms: failed ? 0 : 420,
        failure_rate_pct: failed ? 100 : 0,
      };
    }),
  }));
  return Response.json({ node_id: node.id, range, resolution_sec: resolution, server_time: now, state, series, next_cursor: page ? null : "page2" });
};

function Fixture() {
  const [range, setRange] = useState<"live" | MetricsRange>("live");
  const [active, setActive] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [count, setCount] = useState(0);
  React.useEffect(() => {
    const update = (event: Event) => setCount((event as CustomEvent<number>).detail);
    window.addEventListener("fixture-request", update);
    return () => window.removeEventListener("fixture-request", update);
  }, []);
  return <main className="mx-auto space-y-5 p-4" style={{ maxWidth: narrow ? 390 : 900 }}>
    <div className="flex flex-wrap gap-3 text-sm">
      <select aria-label="Fixture range" value={range} onChange={e => setRange(e.target.value as typeof range)}>{["live", "1h", "24h", "7d", "30d", "1y"].map(value => <option key={value}>{value}</option>)}</select>
      <button onClick={() => setNarrow(v => !v)}>窄屏</button>
      <button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"}>明暗主题</button>
      <button onClick={() => setActive(v => !v)}>{active ? "关闭面板" : "开启面板"}</button>
      <output>请求 {count}</output>
    </div>
    <NetworkQualityPanel node={node} chartMode={range} active={active} live={active && range === "live"} />
    <NodesOpsView nodes={[node]} groups={["测试"]} onInspectNode={() => {}} onOpenAddServer={() => {}} onUpdateNode={async () => {}} onMuteNode={async () => {}}
      onRotateToken={async () => ({ agent_token: "fixture", install_cmd: "fixture" })} onDeleteNode={async () => {}} onNavigateMigration={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
