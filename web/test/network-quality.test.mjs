import assert from "node:assert/strict";
import test from "node:test";
import {
  clonePresetTargets,
  compareTargetIds,
  defaultNetworkConfig,
  editableNetworkConfig,
  formatQualityValue,
  getTargetColor,
  isPublicIpv4,
  loadNetworkHistory,
  mergeMetricsNetworkState,
  mergeNetworkPages,
  NETWORK_PRESETS,
  networkMeasurementKey,
  networkStatus,
  nextAvailableTargetId,
  qualityPlotRuns,
  sortTargetsCanonical,
  validateNetworkConfig,
} from "../src/utils/networkQuality.ts";
import {
  getBottomMetricSlots,
  getSnapshotLatencyMs,
  parseCardPrimaryMetric,
  resolvePrimaryMetricCard,
} from "../src/utils/cardMetrics.ts";
import {
  compareSemver,
  countUpdateEligibleNodes,
  formatAgentUpdateState,
  hasUpdateCap,
  resolveEffectiveAutoUpdate,
} from "../src/utils/autoUpdate.ts";

const config = { config: { mode: "inherit" }, config_id: "cfg1", applied_config_id: "cfg1", supported: true,
  effective_config: { ...defaultNetworkConfig(), enabled: true, schema_version: 1, config_id: "cfg1",
    targets: defaultNetworkConfig().targets.map(t => ({ ...t, target_revision: t.id })) } };
const point = (ts, round = 1, overrides = {}) => ({ ts, segment_id: "session1:ct:1", target_revision: "ct", target: config.effective_config.targets[0], remote_ip: "1.1.1.1",
  round_seq: round, result: "ok", latency_ms: 72, latency_max_ms: 72, attempts: 6, failures: 1, success_count: 5, latency_sum_ms: 360, failure_rate_pct: 100 / 6, ...overrides });
const state = { supported: true, enabled: true, applied_config_id: "cfg1", config_error: null, dropped_samples: 0,
  latest: config.effective_config.targets.map(t => ({ target_id: t.id, target_revision: t.id, segment_id: `session1:${t.id}:1`, target: t,
    measured_at: 1000, result: "ok", remote_ip: "1.1.1.1", latency_median_ms: 72, attempts: 6, failures: 1, failure_rate_pct: 100 / 6 })) };
const page = (points, next_cursor = null, overrides = {}) => ({ node_id: "node1", range: "24h", resolution_sec: 20,
  server_time: 2000, state, series: [{ target_id: "ct", points }], next_cursor, ...overrides });

test("defaults stay explicitly disabled and strict editable payload strips control metadata", () => {
  assert.equal(defaultNetworkConfig().enabled, false);
  assert.deepEqual(defaultNetworkConfig().targets.map(t => t.id), ["ct", "cu", "cm"]);
  assert.equal("target_revision" in editableNetworkConfig(config.effective_config).targets[0], false);
  assert.equal("schema_version" in editableNetworkConfig(config.effective_config), false);
});

test("raw latency breaks at failures while rolling failure rate includes 100 percent", () => {
  const points = [point(1000), point(1020, 2, { result: "connect_timeout", latency_ms: null, failure_rate_pct: 100 }), point(1040, 3)];
  assert.deepEqual(qualityPlotRuns(points, "latency_ms", 20).map(run => run.map(p => p.ts)), [[1000], [1040]]);
  assert.deepEqual(qualityPlotRuns(points, "failure_rate_pct", 20).map(run => run.map(p => p.value)), [[100 / 6, 100, 100 / 6]]);
  assert.equal(formatQualityValue(null, " ms"), "—");
  assert.equal(formatQualityValue(0.3, " ms"), "0.3 ms");
});

test("round identities identify omissions without treating completion-time jitter as loss", () => {
  assert.equal(qualityPlotRuns([point(1000), point(1023, 2)], "latency_ms", 20).length, 1);
  assert.equal(qualityPlotRuns([point(1000), point(1040, 2)], "latency_ms", 20).length, 1);
  assert.equal(qualityPlotRuns([point(1000), point(1020, 3)], "latency_ms", 20).length, 2);
  assert.equal(qualityPlotRuns([point(1000, null), point(1040, null)], "latency_ms", 20).length, 2);
});

test("segment and revision changes cut both charts; empty buckets never create zero latency", () => {
  const points = [point(1000), point(1020, 2, { segment_id: "session1:ct:2" }), point(1040, 3, { target_revision: "new" })];
  for (const metric of ["latency_ms", "failure_rate_pct"]) assert.equal(qualityPlotRuns(points, metric, 20).length, 3);
  assert.deepEqual(qualityPlotRuns([point(1000, null, { attempts: 0 })], "latency_ms", 300), []);
  assert.deepEqual(qualityPlotRuns([point(1000, null, { latency_ms: null, failure_rate_pct: 100 })], "failure_rate_pct", 300)[0][0].value, 100);
});

test("history reads every cursor then deduplicates and sorts raw points", async () => {
  const requested = [];
  const pages = [page([point(1040, 3), point(1020, 2)], "next"), page([point(1020, 2), point(1000)])];
  const result = await loadNetworkHistory(async cursor => { requested.push(cursor); return pages.shift(); });
  assert.deepEqual(requested, [undefined, "next"]);
  assert.equal(result.next_cursor, null);
  assert.deepEqual(result.series[0].points.map(p => p.ts), [1000, 1020, 1040]);
});

test("pagination retains separate same-time aggregate segments and never averages ratios", () => {
  const result = mergeNetworkPages([page([point(1200, null, { attempts: 2, failures: 1, failure_rate_pct: 50 })], "next", { resolution_sec: 300 }),
    page([point(1200, null, { segment_id: "second", attempts: 10, failures: 0, failure_rate_pct: 0 })], null, { resolution_sec: 300 })]);
  assert.equal(result.series[0].points.length, 2);
  assert.deepEqual(result.series[0].points.map(p => p.failure_rate_pct).sort((a, b) => a - b), [0, 50]);
});

test("inconsistent pages and repeating cursors fail explicitly", async () => {
  assert.throws(() => mergeNetworkPages([page([]), page([], null, { node_id: "other" })]), /分页不一致/);
  await assert.rejects(loadNetworkHistory(async () => page([], "repeated")), /游标重复/);
});

test("cancelled history stops before asking for another page", async () => {
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(loadNetworkHistory(async () => { calls++; abort.abort(); return page([], "next"); }, abort.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("repeated resource snapshots keep the same measurement identity", () => {
  assert.equal(networkMeasurementKey(state), networkMeasurementKey({ ...state, latest: [...state.latest].reverse() }));
  assert.notEqual(networkMeasurementKey(state), networkMeasurementKey({ ...state, latest: state.latest.map(p => ({ ...p, measured_at: 1020 })) }));
  const previous = { ts: 1, network_quality: state };
  assert.equal(mergeMetricsNetworkState(previous, { ts: 2 }).network_quality, state);
  assert.equal(mergeMetricsNetworkState(previous, { ts: 2, network_quality: { ...state, enabled: false } }).network_quality.enabled, false);
});

test("status distinguishes missing capability, disabled, pending and initial samples", () => {
  assert.equal(networkStatus(undefined, { ...config, supported: false }, true, 1000, true).label, "探针不支持");
  assert.equal(networkStatus(undefined, { ...config, applied_config_id: null, effective_config: { ...config.effective_config, enabled: false } }, true, 1000, true).label, "未启用");
  assert.equal(networkStatus({ ...state, applied_config_id: "old" }, config, true, 1000, true).label, "等待配置生效");
  assert.equal(networkStatus({ ...state, latest: [] }, config, true, 1000, true).label, "等待首次样本");
  assert.equal(networkStatus({ ...state, config_error: "blocked" }, config, true, 1000, true).label, "配置错误");
});

test("staleness uses network measured_at and Live/Idle grace independently of resource updates", () => {
  assert.equal(networkStatus(state, config, true, 1061, true).label, "数据过期");
  assert.equal(networkStatus(state, config, true, 1061, false).label, "正常");
  assert.equal(networkStatus(state, config, true, 1391, false).label, "数据过期");
  assert.equal(networkStatus(state, config, false, 1001, false).label, "数据过期");
});

test("latest failure remains visible with an older successful median; partial samples are explicit", () => {
  assert.equal(networkStatus({ ...state, latest: state.latest.map(p => ({ ...p, result: "dns_error" })) }, config, true, 1000, true).label, "最新探测失败");
  assert.equal(networkStatus({ ...state, latest: state.latest.map(p => ({ ...p, attempts: 1 })) }, config, true, 1000, true).label, "样本不足");
  const nextConfig = { ...config, effective_config: { ...config.effective_config, targets: config.effective_config.targets.map(t => ({ ...t, target_revision: "changed" })) } };
  assert.equal(networkStatus(state, nextConfig, true, 1000, true).label, "等待首次样本");
});

test("canonical target sorting places ct, cu, cm before alphabetical custom ids", () => {
  const mixed = [
    { id: "us", label: "US" },
    { id: "cm", label: "CM" },
    { id: "hk", label: "HK" },
    { id: "ct", label: "CT" },
    { id: "apac-2", label: "APAC" },
    { id: "cu", label: "CU" },
  ];
  assert.deepEqual(sortTargetsCanonical(mixed).map((t) => t.id), [
    "ct",
    "cu",
    "cm",
    "apac-2",
    "hk",
    "us",
  ]);
  assert.ok(compareTargetIds("ct", "apac-2") < 0);
  assert.ok(compareTargetIds("hk", "us") < 0);

  const customPageA = page(
    [point(1000, 1, { target_revision: "hk" })],
    "next",
    {
      series: [
        { target_id: "us", points: [point(1000, 1)] },
        { target_id: "ct", points: [point(1000, 1)] },
      ],
    },
  );
  const customPageB = page([], null, {
    series: [{ target_id: "hk", points: [point(1020, 2)] }],
  });
  const merged = mergeNetworkPages([customPageA, customPageB]);
  assert.deepEqual(
    merged.series.map((s) => s.target_id),
    ["ct", "hk", "us"],
  );
});

test("dynamic target presets, validation, interval_sec, and optional region work cleanly", () => {
  assert.deepEqual(
    NETWORK_PRESETS.apac.targets.map((t) => t.id),
    ["hk", "jp", "sg"],
  );
  assert.deepEqual(
    clonePresetTargets("global").map((t) => t.id),
    ["us", "eu", "jp"],
  );
  assert.equal(getTargetColor("ct"), "var(--accent)");
  assert.ok(getTargetColor("hk", 3));

  const validCfg = {
    enabled: true,
    interval_sec: 60,
    targets: [
      {
        id: "hk-1",
        enabled: true,
        label: "香港节点",
        region: "",
        host: "s3.ap-east-1.amazonaws.com",
        port: 443,
        address_family: "ipv4",
      },
    ],
  };
  assert.equal(validateNetworkConfig(validCfg).valid, true);
  const serialized = editableNetworkConfig(validCfg);
  assert.equal(serialized.interval_sec, 60);
  assert.equal("region" in serialized.targets[0], false);

  assert.equal(isPublicIpv4("1.1.1.1"), true);
  assert.equal(isPublicIpv4("127.0.0.1"), false);
  assert.equal(isPublicIpv4("192.168.1.1"), false);
  assert.equal(isPublicIpv4("example.com"), null);

  const badInterval = validateNetworkConfig({ ...validCfg, interval_sec: 5 });
  assert.equal(badInterval.valid, false);
  assert.ok(badInterval.intervalError);

  const badTarget = validateNetworkConfig({
    enabled: true,
    interval_sec: 20,
    targets: [
      { ...validCfg.targets[0], id: "Bad ID", label: "", host: "10.0.0.1", port: 70000 },
    ],
  });
  assert.equal(badTarget.valid, false);
  assert.ok(badTarget.targetErrors[0].id);
  assert.ok(badTarget.targetErrors[0].label);
  assert.ok(badTarget.targetErrors[0].host);
  assert.ok(badTarget.targetErrors[0].port);

  assert.equal(
    validateNetworkConfig({
      enabled: true,
      interval_sec: 20,
      targets: Array.from({ length: 9 }, (_, i) => ({
        ...validCfg.targets[0],
        id: `n-${i}`,
      })),
    }).valid,
    false,
  );

  assert.equal(nextAvailableTargetId([{ ...validCfg.targets[0], id: "target-1" }]), "target-2");
});

test("networkStatus scales freshness and minimum sample thresholds with interval_sec", () => {
  const slowConfig = {
    ...config,
    effective_config: {
      ...config.effective_config,
      interval_sec: 120,
    },
  };
  const oneAttemptState = {
    ...state,
    latest: state.latest.map((p) => ({ ...p, measured_at: 1000, attempts: 1 })),
  };
  assert.equal(networkStatus(oneAttemptState, slowConfig, true, 1250, true).label, "正常");
  assert.equal(networkStatus(oneAttemptState, slowConfig, true, 1365, true).label, "数据过期");
});

test("offline bento cards emit no fake live series and customizable primary metric swaps bottom bars", () => {
  const sampleMetrics = {
    ts: 1000,
    up: 600,
    cpu: { all: 42.5, cores: [42.5], steal: 0, iowait: 0, load: [0.5, 0.4, 0.3] },
    mem: { used: 512 * 1024 * 1024, avail: 512 * 1024 * 1024, cached: 0, swap_used: 0 },
    disks: [],
    net: { rx_bps: 2048, tx_bps: 4096, rx_tot: 0, tx_tot: 0, tcp_est: 2, tcp_tw: 0, udp: 0 },
    network_quality: {
      ...state,
      latest: [
        { ...state.latest[0], result: "ok", latency_median_ms: 35.2 },
        { ...state.latest[1], result: "connect_timeout", latency_median_ms: null },
        { ...state.latest[2], result: "ok", latency_median_ms: 41.8 },
      ],
    },
  };

  assert.equal(getSnapshotLatencyMs(sampleMetrics), 38.5);
  assert.equal(parseCardPrimaryMetric("cpu"), "cpu");
  assert.equal(parseCardPrimaryMetric("invalid"), "net");

  const offlinePlot = resolvePrimaryMetricCard(
    {
      online: false,
      mem_total: 1024 * 1024 * 1024,
      metrics: sampleMetrics,
      sparkline_cpu: [42.5],
      sparkline_rx: [2048],
      sparkline_tx: [4096],
      sparkline_mem: [50],
      sparkline_latency: [38.5],
    },
    "net",
  );
  assert.equal(offlinePlot.offline, true);
  assert.equal(offlinePlot.hasLiveChart, false);
  assert.equal(offlinePlot.placeholderText, "离线");
  assert.equal(offlinePlot.primaryValueText, "—");
  assert.deepEqual(offlinePlot.series, []);

  const onlineNodeBase = {
    online: true,
    mem_total: 1024 * 1024 * 1024,
    metrics: sampleMetrics,
    sparkline_cpu: [30, 42.5],
    sparkline_rx: [1024, 2048],
    sparkline_tx: [2048, 4096],
    sparkline_mem: [48, 50],
    sparkline_latency: [36.0, 38.5],
  };

  const cpuPlot = resolvePrimaryMetricCard(onlineNodeBase, "cpu");
  assert.equal(cpuPlot.hasLiveChart, true);
  assert.equal(cpuPlot.primaryValueText, "42.5%");
  assert.equal(cpuPlot.yMax, 100);
  assert.deepEqual(cpuPlot.bottomSlots, ["net", "mem", "disk", "traffic"]);

  const memPlot = resolvePrimaryMetricCard(onlineNodeBase, "mem");
  assert.equal(memPlot.primaryValueText, "50.0%");
  assert.deepEqual(getBottomMetricSlots("mem"), ["cpu", "net", "disk", "traffic"]);

  const latPlot = resolvePrimaryMetricCard(onlineNodeBase, "latency");
  assert.equal(latPlot.primaryValueText, "38.5 ms");
  assert.deepEqual(latPlot.series[0].data, [36.0, 38.5]);
});

test("auto-update helpers format states, resolve overrides, and filter eligible nodes", () => {
  assert.equal(compareSemver("0.2.1", "0.2.0"), 1);
  assert.equal(compareSemver("v0.2.0", "0.2.0"), 0);
  assert.equal(compareSemver("0.1.9", "0.2.0"), -1);

  assert.equal(formatAgentUpdateState(null, "0.1.8", "0.2.0").tone, "warn");
  assert.equal(formatAgentUpdateState({ state: "downloading", target_version: "0.2.0" }, "0.1.8", "0.2.0").label, "正在下载");
  assert.equal(formatAgentUpdateState({ state: "error", error: "checksum mismatch" }, "0.1.8").tone, "danger");

  assert.equal(resolveEffectiveAutoUpdate(null, true).enabled, true);
  assert.equal(resolveEffectiveAutoUpdate(false, true).enabled, false);
  assert.equal(resolveEffectiveAutoUpdate(true, false).enabled, true);

  assert.equal(hasUpdateCap(["mb_v2", "self_update"]), true);
  assert.equal(hasUpdateCap(["mb_v2"]), false);

  const eligible = countUpdateEligibleNodes(
    [
      { online: true, agent_version: "0.1.9", auto_update_override: null, update_status: null },
      { online: true, agent_version: "0.2.0", auto_update_override: null, update_status: null },
      { online: false, agent_version: "0.1.8", auto_update_override: true, update_status: null },
      { online: true, agent_version: "0.1.8", auto_update_override: null, update_status: { state: "applying" } },
    ],
    "0.2.0",
  );
  assert.equal(eligible, 1);
});
