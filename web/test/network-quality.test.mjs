import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultNetworkConfig, editableNetworkConfig, formatQualityValue, loadNetworkHistory,
  mergeMetricsNetworkState, mergeNetworkPages, networkMeasurementKey, networkStatus, qualityPlotRuns,
} from "../src/utils/networkQuality.ts";

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
