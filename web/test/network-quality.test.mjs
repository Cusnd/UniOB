import assert from "node:assert/strict";
import test from "node:test";
import {
  chartModeToNetworkSpan,
  clampNetworkTimeWindow,
  clonePresetTargets,
  compareTargetIds,
  computeLatencyAxis,
  defaultNetworkConfig,
  defaultPiecewiseConfig,
  editableNetworkConfig,
  formatQualityValue,
  getTargetColor,
  isPublicIpv4,
  loadNetworkHistory,
  MAX_NETWORK_RETENTION_SEC,
  mergeMetricsNetworkState,
  mergeNetworkPages,
  NETWORK_PRESETS,
  networkMeasurementKey,
  networkStatus,
  nextAvailableTargetId,
  normalizePiecewiseConfig,
  panNetworkTimeWindow,
  parseLatencyScaleMode,
  qualityPlotRuns,
  resolveNetworkFetchRange,
  slicePointsForWindow,
  sortTargetsCanonical,
  subdivideRunAtThresholds,
  validateNetworkConfig,
  zoomOutNetworkTimeWindow,
} from "../src/utils/networkQuality.ts";
import {
  formatBytesPairCompact,
  formatCompactRate,
  formatRateBpsText,
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

  assert.equal(hasUpdateCap(["mb_v2", "auto_update_v1"]), true);
  assert.equal(hasUpdateCap(["mb_v2", "self_update"]), true);
  assert.equal(hasUpdateCap(["mb_v2"]), false);

  const eligible = countUpdateEligibleNodes(
    [
      { online: true, agent_version: "0.1.9", caps: ["mb_v2", "auto_update_v1"], auto_update_override: null, update_status: null },
      { online: true, agent_version: "0.1.9", caps: ["mb_v2"], auto_update_override: null, update_status: null },
      { online: true, agent_version: "0.2.0", auto_update_override: null, update_status: null },
      { online: false, agent_version: "0.1.8", auto_update_override: true, update_status: null },
      { online: true, agent_version: "0.1.8", auto_update_override: null, update_status: { state: "applying" } },
    ],
    "0.2.0",
  );
  assert.equal(eligible, 1);
});

test("network target validation blocks RFC special-use IPv4s, control chars, and counts Unicode codepoints", () => {
  for (const reservedIp of [
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.1",
    "198.51.100.1",
    "203.0.113.1",
  ]) {
    assert.equal(isPublicIpv4(reservedIp), false, `expected ${reservedIp} to be blocked`);
  }
  assert.equal(isPublicIpv4("8.8.8.8"), true);

  const baseTarget = {
    id: "hk",
    enabled: true,
    label: "香港",
    region: "",
    host: "8.8.8.8",
    port: 443,
    address_family: "ipv4",
  };

  // Surrogate-pair emoji repeats: 32 codepoints (UTF-16 .length === 64) should pass, 33 should fail.
  const emoji32 = "🚀".repeat(32);
  const emoji33 = "🚀".repeat(33);
  assert.equal(
    validateNetworkConfig({ enabled: true, interval_sec: 20, targets: [{ ...baseTarget, label: emoji32 }] }).valid,
    true,
  );
  const tooLongLabel = validateNetworkConfig({
    enabled: true,
    interval_sec: 20,
    targets: [{ ...baseTarget, label: emoji33 }],
  });
  assert.equal(tooLongLabel.valid, false);
  assert.ok(tooLongLabel.targetErrors[0].label);

  const ctrlLabel = validateNetworkConfig({
    enabled: true,
    interval_sec: 20,
    targets: [{ ...baseTarget, label: "香港\n节点" }],
  });
  assert.equal(ctrlLabel.valid, false);
  assert.ok(ctrlLabel.targetErrors[0].label);

  const ctrlRegion = validateNetworkConfig({
    enabled: true,
    interval_sec: 20,
    targets: [{ ...baseTarget, region: "HK\u0007" }],
  });
  assert.equal(ctrlRegion.valid, false);
  assert.ok(ctrlRegion.targetErrors[0].region);
});

test("card metric compact formatters keep pairs concise and clamp fractional rates safely", () => {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const tib = 1024 ** 4;
  assert.equal(formatBytesPairCompact(1.2 * gib, 31.3 * gib), "1.2 / 31.3 GB");
  assert.equal(formatBytesPairCompact(13.4 * gib, 225 * gib), "13.4 / 225 GB");
  assert.equal(formatBytesPairCompact(546 * mib, 1.9 * gib), "546M / 1.9G");
  assert.equal(formatBytesPairCompact(45.1 * gib, 2.0 * tib), "45.1G / 2.0T");
  assert.equal(formatBytesPairCompact(0, 31.3 * gib), "0 / 31.3 GB");

  assert.equal(formatCompactRate(0), "0B");
  assert.equal(formatCompactRate(0.4), "0B");
  assert.equal(formatCompactRate(520), "520B");
  assert.equal(formatCompactRate(2.8 * mib), "2.8M");
  assert.equal(formatRateBpsText(0.4), "0 B/s");
});

test("computeLatencyAxis compresses spikes continuously in auto piecewise mode, supports custom thresholds/scales, and preserves linear/log modes", () => {
  assert.equal(parseLatencyScaleMode(null), "piecewise");
  assert.equal(parseLatencyScaleMode("auto"), "piecewise");
  assert.equal(parseLatencyScaleMode("piecewise"), "piecewise");
  assert.equal(parseLatencyScaleMode("linear"), "linear");
  assert.equal(parseLatencyScaleMode("log"), "log");
  assert.equal(parseLatencyScaleMode("unexpected"), "piecewise");

  // Screenshot-like scenario: 3 series with steady 100-230ms baselines and 7 spikes around 1280-1330ms.
  const cu = Array.from({ length: 90 }, (_, i) => 100 + (i % 16));
  const cm = [...Array.from({ length: 89 }, (_, i) => 115 + (i % 26)), 1280];
  const ct = [
    ...Array.from({ length: 84 }, (_, i) => 110 + ((i * 7) % 121)),
    1330,
    1330,
    1330,
    1330,
    1330,
    1330,
  ];

  const autoAxis = computeLatencyAxis([ct, cu, cm], "piecewise");
  assert.equal(autoAxis.mode, "piecewise");
  assert.equal(autoAxis.bands.length, 2);
  assert.equal(autoAxis.thresholds.length, 1);
  assert.ok(autoAxis.thresholds[0] >= 250 && autoAxis.thresholds[0] <= 300, `got ${autoAxis.thresholds[0]}`);
  assert.equal(autoAxis.outlierCount, 7);
  assert.equal(autoAxis.rawPeak, 1330);
  assert.ok(autoAxis.toRatio(230) > 0.55);
  assert.ok(autoAxis.toRatio(1280) < autoAxis.toRatio(1330));
  assert.ok(autoAxis.toRatio(1330) < 1);

  const linearAxis = computeLatencyAxis([ct, cu, cm], "linear");
  assert.equal(linearAxis.mode, "linear");
  assert.equal(linearAxis.outlierCount, 0);
  assert.equal(linearAxis.bands.length, 1);
  assert.ok(linearAxis.max >= 1460);
  assert.equal(linearAxis.ticks[0].value, 0);
  assert.equal(linearAxis.ticks[2].value, linearAxis.max);

  const logAxis = computeLatencyAxis([ct, cu, cm], "log");
  assert.equal(logAxis.mode, "log");
  assert.equal(logAxis.outlierCount, 0);
  assert.ok(logAxis.min > 0 && logAxis.min <= 80);
  assert.ok(logAxis.toRatio(230) - logAxis.toRatio(100) >= 0.2);
  assert.ok(logAxis.toRatio(1330) <= 1);
  assert.ok(
    logAxis.ticks[0].value < logAxis.ticks[1].value &&
      logAxis.ticks[1].value < logAxis.ticks[2].value,
  );

  const nearZeroLog = computeLatencyAxis([[0.2, 5, 1200]], "log");
  assert.equal(nearZeroLog.min, 0);
  assert.ok(nearZeroLog.ticks[1].value > 0 && nearZeroLog.ticks[1].value < nearZeroLog.max);

  // Multi-region scenario: 7 low-latency targets + 1 steady 240-260ms target with 2 spikes at 1400ms.
  const lowTargets = Array.from({ length: 7 }, () =>
    Array.from({ length: 30 }, (_, i) => 20 + (i % 21)),
  );
  const highSteadyWithSpikes = [
    ...Array.from({ length: 30 }, (_, i) => 240 + (i % 21)),
    1400,
    1400,
  ];
  const multiAxis = computeLatencyAxis([...lowTargets, highSteadyWithSpikes], "piecewise");
  assert.equal(multiAxis.bands.length, 2);
  assert.ok(multiAxis.thresholds[0] >= 280, `got threshold ${multiAxis.thresholds[0]}`);
  assert.equal(multiAxis.outlierCount, 2);

  // Sustained congestion: 40% high values must NOT be falsely compressed as outliers.
  const congested = [
    ...Array.from({ length: 30 }, () => 50),
    ...Array.from({ length: 20 }, () => 800),
  ];
  const congestedAxis = computeLatencyAxis([congested], "piecewise");
  assert.equal(congestedAxis.bands.length, 1);
  assert.equal(congestedAxis.outlierCount, 0);
  assert.ok(congestedAxis.max >= 800);

  // Custom thresholds [250, 350] with share weights [70, 15, 15], even when rawPeak < 250.
  const customShareCfg = {
    ...defaultPiecewiseConfig(),
    auto: false,
    sizingMode: "share",
    thresholds: [250, 350],
    shares: [70, 15, 15],
  };
  const customLowData = computeLatencyAxis([[120, 180]], "piecewise", customShareCfg);
  assert.ok(customLowData.max > 350);
  assert.ok(Math.abs(customLowData.toRatio(250) - 0.7) < 1e-6);
  assert.ok(Math.abs(customLowData.toRatio(350) - 0.85) < 1e-6);
  assert.equal(customLowData.toRatio(customLowData.max), 1);

  // Custom thresholds [250, 350] with scale multipliers [1, 0.5, 0.1].
  const customScaleCfg = {
    ...defaultPiecewiseConfig(),
    auto: false,
    sizingMode: "scale",
    thresholds: [250, 350],
    scales: [1, 0.5, 0.1],
  };
  const customScaleAxis = computeLatencyAxis([ct, cu, cm], "piecewise", customScaleCfg);
  assert.equal(customScaleAxis.bands.length, 3);
  assert.ok(Math.abs(customScaleAxis.bands[1].relativeSlope - 0.5) < 1e-6);
  assert.ok(Math.abs(customScaleAxis.bands[2].relativeSlope - 0.1) < 1e-6);

  // Config normalization sanitizes unsorted, near-duplicate, and out-of-range inputs.
  const sanitized = normalizePiecewiseConfig({
    auto: false,
    sizingMode: "scale",
    thresholds: [400, 250, 250.4, -5, 350, 999],
    shares: [0, 5000],
    scales: [0, 99],
  });
  assert.equal(sanitized.auto, false);
  assert.equal(sanitized.sizingMode, "scale");
  assert.deepEqual(sanitized.thresholds, [1, 250, 350]);
  assert.equal(sanitized.shares.length, 4);
  assert.equal(sanitized.scales.length, 4);
  assert.equal(sanitized.scales[0], 0.01);
  assert.equal(sanitized.scales[1], 20);

  // Polyline threshold crossing subdivision in both rising and falling segments.
  const subdivided = subdivideRunAtThresholds(
    [
      { ts: 100, value: 200 },
      { ts: 200, value: 400 },
      { ts: 300, value: 200 },
    ],
    [250, 350],
  );
  assert.deepEqual(subdivided, [
    { ts: 100, value: 200 },
    { ts: 125, value: 250 },
    { ts: 175, value: 350 },
    { ts: 200, value: 400 },
    { ts: 225, value: 350 },
    { ts: 275, value: 250 },
    { ts: 300, value: 200 },
  ]);
});

test("time-window helpers map fetch ranges, reuse cached supersets, clamp, pan, zoom, and preserve line continuity", () => {
  assert.equal(chartModeToNetworkSpan("live"), "1h");
  assert.equal(chartModeToNetworkSpan("24h"), "24h");
  assert.equal(chartModeToNetworkSpan("1y"), "1y");

  const now = 10_000_000;
  assert.equal(resolveNetworkFetchRange("15m", null, now), "1h");
  assert.equal(resolveNetworkFetchRange("30m", null, now), "1h");
  assert.equal(resolveNetworkFetchRange("1h", null, now), "1h");
  assert.equal(resolveNetworkFetchRange("6h", null, now), "24h");
  assert.equal(resolveNetworkFetchRange("24h", null, now), "24h");
  assert.equal(resolveNetworkFetchRange("7d", null, now), "7d");
  assert.equal(resolveNetworkFetchRange("30d", null, now), "30d");

  assert.equal(
    resolveNetworkFetchRange("1h", { start: now - 10800, end: now - 7200 }, now),
    "24h",
  );
  assert.equal(
    resolveNetworkFetchRange("1h", { start: now - 3 * 86400, end: now - 2 * 86400 }, now),
    "7d",
  );
  assert.equal(
    resolveNetworkFetchRange("1h", { start: now - 10 * 86400, end: now - 9 * 86400 }, now),
    "30d",
  );

  // Cache superset reuse
  assert.equal(
    resolveNetworkFetchRange("1h", { start: now - 900, end: now }, now, new Set(["24h"])),
    "24h",
  );
  assert.equal(
    resolveNetworkFetchRange("7d", { start: now - 3 * 86400, end: now }, now, new Set(["30d"])),
    "30d",
  );

  // Minimum zoom span & retention clamping
  const tooNarrow = clampNetworkTimeWindow({ start: now - 20, end: now }, now, 20);
  assert.equal(tooNarrow.end - tooNarrow.start, 120);
  assert.equal(tooNarrow.end, now);

  const tooEarly = clampNetworkTimeWindow(
    { start: now - MAX_NETWORK_RETENTION_SEC - 5000, end: now - MAX_NETWORK_RETENTION_SEC - 1400 },
    now,
    20,
  );
  assert.equal(tooEarly.start, now - MAX_NETWORK_RETENTION_SEC);
  assert.equal(tooEarly.end - tooEarly.start, 3600);

  // Panning back and forth
  const pannedBack = panNetworkTimeWindow({ start: now - 3600, end: now }, -1, now, 20, 3600);
  assert.deepEqual(pannedBack, { start: now - 5400, end: now - 1800 });

  // Snapping back to live-follow when duration matches active preset
  const snappedLive = panNetworkTimeWindow(pannedBack, 1, now, 20, 3600);
  assert.equal(snappedLive, null);

  // Custom zoomed window stays custom when panned to latest edge
  const customZoomed = { start: now - 1500, end: now - 900 };
  const pannedForward = panNetworkTimeWindow(customZoomed, 1, now, 20, 3600);
  assert.deepEqual(pannedForward, { start: now - 1200, end: now - 600 });
  const pannedToLatestEdge = panNetworkTimeWindow({ start: now - 700, end: now - 100 }, 1, now, 20, 3600);
  assert.deepEqual(pannedToLatestEdge, { start: now - 600, end: now });

  // Zoom out doubles duration around midpoint
  const zoomedOut = zoomOutNetworkTimeWindow({ start: now - 1600, end: now - 1000 }, now, 20);
  assert.equal(zoomedOut.end - zoomedOut.start, 1200);
  assert.equal(zoomedOut.start, now - 1900);
  assert.equal(zoomedOut.end, now - 700);

  // Slicing preserves boundary neighbor points so runs stay unbroken
  const pts = [
    point(1000, 1),
    point(1020, 2),
    point(1040, 3),
    point(1060, 4),
    point(1080, 5),
    point(1100, 6),
  ];
  const sliced = slicePointsForWindow(pts, { start: 1040, end: 1060 });
  assert.deepEqual(sliced.visiblePoints.map((p) => p.ts), [1040, 1060]);
  assert.deepEqual(sliced.contextPoints.map((p) => p.ts), [1000, 1020, 1040, 1060, 1080, 1100]);
  const runs = qualityPlotRuns(sliced.contextPoints, "latency_ms", 20);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 6);
});
