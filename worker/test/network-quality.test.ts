import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  nqDefaultConfig,
  nqIsPublicV4,
  nqLatest,
  nqMakeControl,
  nqParseConfig,
  nqParseOverride,
  nqParsePayload,
  nqRawQuery,
  nqRollup,
  type NqControl,
  type NqPoint,
  type NqQueryPoint,
} from "../src/network-quality";
import { payloadToCompactTuple } from "../src/do/tsdb-slab";
import { NetworkQualityStore } from "../src/do/network-quality-store";
import fixture from "../../shared/fixtures/network-quality-v1.json";
import {
  authedFetch,
  connectAgentWs,
  createTestNode,
  flushMicrotasks,
  makeHelloFrame,
  makeMetricsFrame,
  nextWsMessage,
  setupAndLogin,
} from "./helpers";

async function pointsAt(
  now: number,
  values: Array<number | null>,
  control?: NqControl,
): Promise<NqPoint[]> {
  const c =
    control ?? (await nqMakeControl({ ...nqDefaultConfig(), enabled: true }));
  const { target_revision, ...target } = c.targets[0]!;
  return values.map((ms, i) => ({
    sample_id: `test:${i}:ct`,
    round_seq: i,
    config_id: c.config_id,
    target_id: "ct",
    target_revision,
    segment_id: "test:ct:1",
    ts: now - (values.length - 1 - i) * 20,
    result: ms === null ? "connect_timeout" : "ok",
    connect_ms: ms,
    remote_ip: "1.1.1.1",
    target,
  }));
}
const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("Network quality contract and statistics", () => {
  it("matches the shared Rust/TypeScript fixture for identities, short windows and rollups", async () => {
    const config = nqParseConfig(fixture.config);
    expect(await nqMakeControl(config)).toEqual(fixture.control);
    const points = fixture.points as NqPoint[];
    const raw = nqRawQuery(points);
    const roll = nqRollup(points);
    for (const id of ["ct", "cu", "cm"] as const) {
      expect(raw.filter((p) => p.target.id === id)).toEqual(
        fixture.expected.raw_by_target[id],
      );
      expect(roll.filter((p) => p.target.id === id)).toEqual(
        fixture.expected.rollup_by_target[id],
      );
    }
    const latest = ["ct", "cu", "cm"].map((id) => {
      const p = points.filter((p) => p.target_id === id).at(-1)!;
      return nqLatest(points, p);
    });
    expect(latest).toEqual(fixture.expected.latest);
  });
  it("normalizes config identities, rejects unsafe targets and duplicates", async () => {
    const a = nqDefaultConfig();
    const b = structuredClone(a);
    b.targets.reverse();
    b.targets[0]!.host = ` ${b.targets[0]!.host.toUpperCase()} `;
    expect(await nqMakeControl(nqParseConfig(a))).toEqual(
      await nqMakeControl(nqParseConfig(b)),
    );
    for (const ip of [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.1",
      "172.16.1.2",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "198.18.0.1",
      "203.0.113.1",
    ])
      expect(nqIsPublicV4(ip)).toBe(false);
    expect(nqIsPublicV4("1.1.1.1")).toBe(true);
    for (const host of [
      "http://example.com",
      "example.com:80",
      "-x.example.com",
      "*.example.com",
      "127.0.0.1",
      "::1",
    ]) {
      const c = nqDefaultConfig();
      c.targets[0]!.host = host;
      expect(() => nqParseConfig(c)).toThrow();
    }
    expect(() => nqParseOverride({ mode: "off", config: a })).toThrow();
    a.targets[1] = a.targets[0]!;
    expect(() => nqParseConfig(a)).toThrow();
  });
  it("uses six real attempts, null latency on failure, segment windows and weighted rollups", async () => {
    const p = await pointsAt(1794700200, [70, 72, null, 74, 71, 73]);
    const latest = nqLatest(p, p[5]!);
    expect(latest.latency_median_ms).toBe(72);
    expect(latest.failure_rate_pct).toBeCloseTo(100 / 6);
    expect(nqRawQuery(p)[2]?.latency_ms).toBeNull();
    expect(nqRawQuery(p)[2]?.failure_rate_pct).toBeCloseTo(100 / 3);
    const failures = await pointsAt(1794700200, [null, null]);
    expect(nqLatest(failures, failures[1]!).failure_rate_pct).toBe(100);
    expect(nqLatest(failures, failures[1]!).latency_median_ms).toBeNull();
    p[5]!.segment_id = "test:ct:3";
    expect(nqLatest(p, p[5]!).attempts).toBe(1);
    const weighted = await pointsAt(1794700490, [
      null,
      ...Array<number>(11).fill(20),
    ]);
    // Put all samples in the same 5m bucket without changing their identities.
    weighted.forEach((x, i) => (x.ts = 1794700200 + i * 20));
    const roll = nqRollup(weighted);
    expect(roll).toHaveLength(1);
    expect(roll[0]?.failure_rate_pct).toBeCloseTo(100 / 12);
    weighted[11]!.segment_id = "test:ct:other";
    expect(nqRollup(weighted)).toHaveLength(2);
  });
  it("rejects Unicode C1 controls in labels and regions without rejecting valid Unicode", () => {
    for (const field of ["label", "region"] as const) {
      for (let code = 0x80; code <= 0x9f; code++) {
        const config = nqDefaultConfig();
        config.targets[0]![field] = `前${String.fromCharCode(code)}后`;
        expect(
          () => nqParseConfig(config),
          `${field}: U+${code.toString(16)}`,
        ).toThrow("Invalid network quality text");
      }
    }
    const valid = nqDefaultConfig();
    valid.targets[0]!.label = "🚀".repeat(64);
    valid.targets[0]!.region = " 广东 ";
    expect(nqParseConfig(valid).targets[0]).toMatchObject({
      label: "🚀".repeat(64),
      region: "广东",
    });
  });
  it("isolates malformed extensions and filters stale timestamps", async () => {
    const now = Math.floor(Date.now() / 1000);
    const p = await pointsAt(now, [1]);
    const payload = {
      schema_version: 1,
      applied_config_id: p[0]!.config_id,
      enabled: true,
      config_error: null,
      dropped_samples: 0,
      latest: [],
      points: p,
    };
    expect((await nqParsePayload(payload, now))?.points).toHaveLength(1);
    expect(await nqParsePayload("bad", now)).toBeNull();
    expect(
      await nqParsePayload(
        { ...payload, points: [{ ...p[0], connect_ms: NaN }] },
        now,
      ),
    ).toBeNull();
    expect(
      await nqParsePayload(
        { ...payload, points: [{ ...p[0], remote_ip: "127.0.0.1" }] },
        now,
      ),
    ).toBeNull();
    expect(
      (
        await nqParsePayload(
          { ...payload, points: [{ ...p[0], ts: now - 1801 }] },
          now,
        )
      )?.points,
    ).toEqual([]);
  });
});

describe("Network quality Cloudflare integration", () => {
  it("preserves validated settings through bundles and rejects malformed active-probing imports", async () => {
    const cookie = await setupAndLogin();
    const { node } = await createTestNode(cookie);
    const config = { ...nqDefaultConfig(), enabled: true };
    await authedFetch("/api/network-quality/config", cookie, put(config));
    await authedFetch(
      `/api/nodes/${node.id}/network-quality/config`,
      cookie,
      put({ mode: "off" }),
    );
    const bundle = await (
      await authedFetch("/api/export/bundle", cookie)
    ).json<any>();
    expect(
      bundle.system_settings.some(
        (s: any) => s.key === "network_quality_config",
      ),
    ).toBe(true);
    expect(Object.keys(bundle).some((k) => k.includes("chunk"))).toBe(false);
    await authedFetch(
      "/api/network-quality/config",
      cookie,
      put(nqDefaultConfig()),
    );
    const restore = await authedFetch("/api/import/bundle", cookie, {
      ...put(bundle),
      method: "POST",
    });
    expect(restore.status).toBe(200);
    expect(
      (
        await (
          await authedFetch("/api/network-quality/config", cookie)
        ).json<any>()
      ).effective_config.enabled,
    ).toBe(true);
    expect(
      (
        await (
          await authedFetch(
            `/api/nodes/${node.id}/network-quality/config`,
            cookie,
          )
        ).json<any>()
      ).effective_config.enabled,
    ).toBe(false);
    bundle.system_settings.find(
      (s: any) => s.key === "network_quality_config",
    ).value = JSON.stringify({ enabled: true, targets: [] });
    expect(
      (
        await authedFetch("/api/import/bundle", cookie, {
          ...put(bundle),
          method: "POST",
        })
      ).status,
    ).toBe(400);
  });
  it("defaults off, requires admin auth, supports overrides and rejects invalid settings", async () => {
    expect((await authedFetch("/api/network-quality/config", "")).status).toBe(
      401,
    );
    const cookie = await setupAndLogin();
    const { node } = await createTestNode(cookie);
    const global = await (
      await authedFetch("/api/network-quality/config", cookie)
    ).json<any>();
    expect(global.effective_config.enabled).toBe(false);
    const config = { ...nqDefaultConfig(), enabled: true };
    expect(
      (await authedFetch("/api/network-quality/config", cookie, put(config)))
        .status,
    ).toBe(200);
    const inherited = await (
      await authedFetch(`/api/nodes/${node.id}/network-quality/config`, cookie)
    ).json<any>();
    expect(inherited.effective_config.enabled).toBe(true);
    expect(inherited.supported).toBe(false);
    const off = await (
      await authedFetch(
        `/api/nodes/${node.id}/network-quality/config`,
        cookie,
        put({ mode: "off" }),
      )
    ).json<any>();
    expect(off.effective_config.enabled).toBe(false);
    expect(
      (
        await authedFetch(
          `/api/nodes/${node.id}/network-quality?range=1y`,
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await authedFetch(
          `/api/nodes/${node.id}/network-quality?cursor=invalid`,
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (await authedFetch("/api/nodes/absent/network-quality", cookie)).status,
    ).toBe(404);
    expect(
      (
        await authedFetch(
          "/api/network-quality/config",
          cookie,
          put({ enabled: true, targets: [] }),
        )
      ).status,
    ).toBe(400);
  });
  it("receives batches without altering resource telemetry, dedupes, persists cold wake and rolls up failures", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie);
    await authedFetch(
      "/api/network-quality/config",
      cookie,
      put({ ...nqDefaultConfig(), enabled: true }),
    );
    const ws = await connectAgentWs(node.id, agent_token);
    const ctrlPromise = nextWsMessage<any>(ws, (m) => m.t === "ctrl");
    ws.send(
      JSON.stringify(
        makeHelloFrame({ v: 2, capabilities: ["mb_v2", "network_quality_v1"] }),
      ),
    );
    const ctrl = await ctrlPromise;
    expect(ctrl.network_quality.enabled).toBe(true);
    expect(ctrl.batch_sec).toBe(300);
    const now = Math.floor(Date.now() / 1000);
    const points = await pointsAt(
      now,
      [70, 72, null, 74, 71, 73],
      ctrl.network_quality,
    );
    const nq = {
      schema_version: 1,
      applied_config_id: ctrl.network_quality.config_id,
      enabled: true,
      config_error: null,
      dropped_samples: 0,
      latest: [],
      points,
    };
    const { t, ...last } = makeMetricsFrame(now);
    const frame = {
      t: "mb",
      v: 2,
      reason: "cohort",
      pts: [payloadToCompactTuple(last)],
      last,
      network_quality: nq,
    };
    ws.send(JSON.stringify(frame));
    await flushMicrotasks();
    ws.send(JSON.stringify(frame));
    await flushMicrotasks();
    const query = await (
      await authedFetch(`/api/nodes/${node.id}/network-quality`, cookie)
    ).json<any>();
    expect(query.series[0].points).toHaveLength(6);
    expect(query.state.latest[0].latency_median_ms).toBe(72);
    expect(query.state.latest[0].failures).toBe(1);
    const counts = await runInDurableObject(
      env.FLEET_HUB_DO.getByName("global"),
      (_obj, state) => ({
        raw: state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM network_quality_chunk_10m")
          .one().n,
        roll: state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM network_quality_5m_chunk_1h")
          .one().n,
      }),
    );
    expect(Number(counts.raw)).toBeLessThanOrEqual(2);
    expect(Number(counts.roll)).toBeLessThanOrEqual(2);
    ws.send(
      JSON.stringify({ ...makeMetricsFrame(now + 1), network_quality: "bad" }),
    );
    await flushMicrotasks();
    const resource = await (
      await authedFetch(`/api/nodes/${node.id}`, cookie)
    ).json<any>();
    expect(resource.node.metrics.ts).toBe(now + 1);
    expect(resource.node.metrics.network_quality.latest[0].attempts).toBe(6);
    const rollup = await (
      await authedFetch(
        `/api/nodes/${node.id}/network-quality?range=7d`,
        cookie,
      )
    ).json<any>();
    expect(
      rollup.series[0].points.reduce((n: number, p: any) => n + p.attempts, 0),
    ).toBe(6);
    expect(
      rollup.series[0].points.reduce((n: number, p: any) => n + p.failures, 0),
    ).toBe(1);
    await evictDurableObject(env.FLEET_HUB_DO.getByName("global"));
    const cold = await (
      await authedFetch(`/api/nodes/${node.id}/network-quality`, cookie)
    ).json<any>();
    expect(cold.series[0].points).toHaveLength(6);
    expect(cold.state.supported).toBe(true);
    ws.close();
    await authedFetch(`/api/nodes/${node.id}`, cookie, { method: "DELETE" });
    const after = await runInDurableObject(
      env.FLEET_HUB_DO.getByName("global"),
      (_obj, state) =>
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM network_quality_chunk_10m")
          .one().n,
    );
    expect(Number(after)).toBe(0);
  });
  it("deduplicates identities across blocks and does not roll state back after changing configuration", async () => {
    const cookie = await setupAndLogin();
    const { node, agent_token } = await createTestNode(cookie);
    await authedFetch(
      "/api/network-quality/config",
      cookie,
      put({ ...nqDefaultConfig(), enabled: true }),
    );
    const ws = await connectAgentWs(node.id, agent_token);
    const first = nextWsMessage<any>(ws, (m) => m.t === "ctrl");
    ws.send(
      JSON.stringify(
        makeHelloFrame({ v: 2, capabilities: ["network_quality_v1"] }),
      ),
    );
    const control = (await first).network_quality;
    const now = Math.floor(Date.now() / 1000);
    const points = await pointsAt(now - 650, [null], control);
    const payload = {
      schema_version: 1,
      applied_config_id: control.config_id,
      enabled: true,
      config_error: null,
      dropped_samples: 0,
      latest: [],
      points,
    };
    ws.send(
      JSON.stringify({ ...makeMetricsFrame(now), network_quality: payload }),
    );
    await flushMicrotasks();
    ws.close();
    await flushMicrotasks();
    const ws2 = await connectAgentWs(node.id, agent_token);
    const again = nextWsMessage<any>(ws2, (m) => m.t === "ctrl");
    ws2.send(
      JSON.stringify(
        makeHelloFrame({ v: 2, capabilities: ["network_quality_v1"] }),
      ),
    );
    await again;
    ws2.send(
      JSON.stringify({
        ...makeMetricsFrame(now + 1),
        network_quality: { ...payload, points: [{ ...points[0], ts: now }] },
      }),
    );
    await flushMicrotasks();
    const query = await (
      await authedFetch(`/api/nodes/${node.id}/network-quality`, cookie)
    ).json<any>();
    expect(query.series[0].points).toHaveLength(1);
    expect(query.series[0].points[0].ts).toBe(now - 650);
    const update = nextWsMessage<any>(
      ws2,
      (m) => m.t === "ctrl" && !m.network_quality.enabled,
    );
    await authedFetch(
      `/api/nodes/${node.id}/network-quality/config`,
      cookie,
      put({ mode: "off" }),
    );
    const disabled = (await update).network_quality;
    ws2.send(
      JSON.stringify({
        ...makeMetricsFrame(now + 2),
        network_quality: {
          ...payload,
          applied_config_id: disabled.config_id,
          enabled: false,
          points: [],
        },
      }),
    );
    await flushMicrotasks();
    ws2.send(
      JSON.stringify({
        ...makeMetricsFrame(now + 3),
        network_quality: payload,
      }),
    );
    await flushMicrotasks();
    const after = await (
      await authedFetch(`/api/nodes/${node.id}/network-quality`, cookie)
    ).json<any>();
    expect(after.state.enabled).toBe(false);
    expect(after.state.applied_config_id).toBe(disabled.config_id);
    expect(after.series[0].points).toHaveLength(1);
    ws2.close();
  });
  it("keeps complete 24h boundaries and warmup across ring phases and paginates every point", async () => {
    await setupAndLogin();
    const control = await nqMakeControl({
      ...nqDefaultConfig(),
      enabled: true,
    });
    const base = (
      await pointsAt(Math.floor(Date.now() / 1000), [5], control)
    )[0]!;
    const outcome = await runInDurableObject(
      env.FLEET_HUB_DO.getByName("global"),
      async (_obj, state) => {
        const store = new NetworkQualityStore(state.storage.sql, env, (fn) =>
          state.storage.transactionSync(fn),
        );
        await store.ensureReady();
        const now = Math.floor(Date.now() / 1000);
        const outcomes = [];
        for (const phase of [0, 1, 119, 120, 599]) {
          const to = Math.floor(now / 600) * 600 - phase;
          const from = to - 86400;
          const groups = new Map<number, NqPoint[]>();
          for (let ts = from - 120, i = 0; ts <= to; ts += 20, i++) {
            const bucket = Math.floor(ts / 600) * 600;
            const group = groups.get(bucket) ?? [];
            group.push({
              ...base,
              sample_id: `boundary:${i}`,
              round_seq: i,
              ts,
            });
            groups.set(bucket, group);
          }
          state.storage.sql.exec(
            "DELETE FROM network_quality_chunk_10m WHERE node_id='boundary'",
          );
          for (const [ts, points] of groups)
            state.storage.sql.exec(
              "INSERT OR REPLACE INTO network_quality_chunk_10m VALUES (?,?,?,?)",
              "boundary",
              Math.floor(ts / 600) % 146,
              ts,
              JSON.stringify({ version: 1, points }),
            );
          let cursor: string | null = btoa(
            JSON.stringify({
              node_id: "boundary",
              range: "24h",
              to,
              offset: 0,
            }),
          );
          const all = [];
          let pages = 0;
          do {
            const q = store.query("boundary", "24h", cursor!);
            all.push(...q.series[0]!.points);
            cursor = q.next_cursor;
            pages++;
          } while (cursor);
          outcomes.push({
            phase,
            count: all.length,
            first: all[0]!.ts,
            from,
            attempts: all[0]!.attempts,
            last: all.at(-1)!.ts,
            to,
            pages,
          });
        }
        return outcomes;
      },
    );
    for (const out of outcome) {
      expect(out.count).toBe(4321);
      expect(out.first).toBe(out.from);
      expect(out.last).toBe(out.to);
      expect(out.attempts).toBe(6);
      expect(out.pages).toBeGreaterThan(1);
    }
  });
  it("preserves an unchanged target's window and latest time through an unrelated A-B-A configuration change", async () => {
    await setupAndLogin();
    const result = await runInDurableObject(
      env.FLEET_HUB_DO.getByName("global"),
      async (_obj, state) => {
        const store = new NetworkQualityStore(state.storage.sql, env, (fn) =>
          state.storage.transactionSync(fn),
        );
        await store.ensureReady();
        const configA = { ...nqDefaultConfig(), enabled: true };
        const configB = structuredClone(configA);
        configB.targets[0]!.label = "电信新名称";
        await store.saveConfig(configA);
        store.setSupported("stable-cu", true);
        const controlA = store.control("stable-cu");
        const now = Math.floor(Date.now() / 1000);
        const point = (
          control: NqControl,
          id: NqPoint["target_id"],
          seq: number,
          ts: number,
          ms: number,
        ): NqPoint => {
          const { target_revision, ...target } = control.targets.find(
            (t) => t.id === id,
          )!;
          return {
            sample_id: `config-cycle:${id}:${seq}`,
            round_seq: seq,
            config_id: control.config_id,
            target_id: id,
            target_revision,
            segment_id: `stable:${id}`,
            ts,
            result: "ok",
            connect_ms: ms,
            remote_ip: "1.1.1.1",
            target,
          };
        };
        const ingest = (control: NqControl, points: NqPoint[]) =>
          store.ingest(
            "stable-cu",
            {
              schema_version: 1,
              applied_config_id: control.config_id,
              enabled: true,
              config_error: null,
              dropped_samples: 0,
              latest: [],
              points,
            },
            now,
          );
        await ingest(controlA, [
          point(controlA, "cu", 1, now - 100, 10),
          point(controlA, "cu", 2, now - 80, 20),
        ]);
        await store.saveConfig(configB);
        const controlB = store.control("stable-cu");
        await ingest(controlB, [point(controlB, "cu", 3, now - 60, 30)]);
        const underB = structuredClone(
          store.state("stable-cu").latest.find((p) => p.target_id === "cu")!,
        );
        await store.saveConfig(configA);
        // Only the changed CT target sends a point after the revert. CU's newest
        // stored point still has B's overall config ID but its own revision is unchanged.
        await ingest(controlA, [point(controlA, "ct", 4, now - 40, 1)]);
        const afterRevert = structuredClone(
          store.state("stable-cu").latest.find((p) => p.target_id === "cu")!,
        );
        await ingest(controlA, [point(controlA, "cu", 5, now - 20, 40)]);
        return {
          configChanged: controlA.config_id !== controlB.config_id,
          cuRevisionUnchanged:
            controlA.targets[1]!.target_revision ===
            controlB.targets[1]!.target_revision,
          underB,
          afterRevert,
          resumed: store
            .state("stable-cu")
            .latest.find((p) => p.target_id === "cu"),
          historyCount: store
            .query("stable-cu", "1h")
            .series.find((s) => s.target_id === "cu")!.points.length,
          now,
        };
      },
    );
    expect(result.configChanged).toBe(true);
    expect(result.cuRevisionUnchanged).toBe(true);
    expect(result.underB).toMatchObject({
      attempts: 3,
      latency_median_ms: 20,
      segment_id: "stable:cu",
      measured_at: result.now - 60,
    });
    expect(result.afterRevert).toEqual(result.underB);
    expect(result.resumed).toMatchObject({
      attempts: 4,
      latency_median_ms: 25,
      segment_id: "stable:cu",
      measured_at: result.now - 20,
    });
    expect(result.historyCount).toBe(4);
  });
  it("streams dense aggregate segments across every page without eager row reads or oversized point payloads", async () => {
    await setupAndLogin();
    const result = await runInDurableObject(
      env.FLEET_HUB_DO.getByName("global"),
      async (_obj, state) => {
        const rowReads: Array<{ rows: number; eager: boolean }> = [];
        // Instrument the actual SQLite cursor, not a substitute query result. A
        // regression to .toArray() is observed even if the final page is small.
        const trackedSql = new Proxy(state.storage.sql, {
          get(sql, key) {
            if (key === "exec")
              return (query: string, ...bindings: SqlStorageValue[]) => {
                const cursor = sql.exec(query, ...bindings);
                if (
                  !query.startsWith(
                    "SELECT bucket_ts,payload FROM network_quality_5m_chunk_1h",
                  )
                )
                  return cursor;
                const read = { rows: 0, eager: false };
                rowReads.push(read);
                return new Proxy(cursor, {
                  get(value, property) {
                    if (property === "toArray")
                      return () => {
                        read.eager = true;
                        return value.toArray();
                      };
                    if (property === Symbol.iterator)
                      return function* () {
                        for (const row of value) {
                          read.rows++;
                          yield row;
                        }
                      };
                    const member = Reflect.get(value, property, value);
                    return typeof member === "function"
                      ? member.bind(value)
                      : member;
                  },
                });
              };
            const member = Reflect.get(sql, key, sql);
            return typeof member === "function" ? member.bind(sql) : member;
          },
        });
        const store = new NetworkQualityStore(trackedSql, env, (fn) =>
          state.storage.transactionSync(fn),
        );
        await store.ensureReady();
        const config = nqDefaultConfig();
        const longHost = [
          "a".repeat(63),
          "b".repeat(63),
          "c".repeat(63),
          "d".repeat(61),
        ].join(".");
        for (const target of config.targets)
          Object.assign(target, {
            host: longHost,
            label: "🚀".repeat(64),
            region: "广".repeat(64),
          });
        const control = await nqMakeControl(nqParseConfig(config));
        const hours = 12;
        const pointsPerHour = 1080;
        const lastHour = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3600;
        const remaining = new Set<string>();
        for (let hourIndex = 0; hourIndex < hours; hourIndex++) {
          const hour = lastHour - (hours - 1 - hourIndex) * 3600;
          const points: NqQueryPoint[] = [];
          for (let i = 0; i < pointsPerHour; i++) {
            const { target_revision, ...target } = control.targets[i % 3]!;
            const seq = hourIndex * pointsPerHour + i;
            const segment_id = `segment-${String(seq).padStart(6, "0")}-${"x".repeat(120)}`;
            const failed = i % 7 === 0;
            remaining.add(segment_id);
            points.push({
              ts: hour + Math.floor(i / 90) * 300,
              segment_id,
              target_revision,
              target,
              remote_ip: failed ? null : "1.1.1.1",
              round_seq: null,
              result: null,
              latency_ms: failed ? null : 20,
              latency_max_ms: failed ? null : 20,
              attempts: 1,
              failures: failed ? 1 : 0,
              success_count: failed ? 0 : 1,
              latency_sum_ms: failed ? 0 : 20,
              failure_rate_pct: failed ? 100 : 0,
            });
          }
          state.storage.sql.exec(
            "INSERT OR REPLACE INTO network_quality_5m_chunk_1h VALUES (?,?,?,?)",
            "dense-segments",
            Math.floor(hour / 3600) % 721,
            hour,
            JSON.stringify({ version: 1, points }),
          );
        }
        const pages: Array<{
          count: number;
          bytes: number;
          rows: number;
          eager: boolean;
        }> = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        let count = 0;
        let duplicateOrUnknown = 0;
        let invalidStatistics = 0;
        let previous: NqQueryPoint | undefined;
        let ordered = true;
        const order = (a: NqQueryPoint, b: NqQueryPoint) =>
          a.ts - b.ts ||
          a.target.id.localeCompare(b.target.id) ||
          a.segment_id.localeCompare(b.segment_id);
        do {
          const query = store.query(
            "dense-segments",
            "30d",
            cursor ?? undefined,
          );
          const points = query.series.flatMap((s) => s.points).sort(order);
          let bytes = 0;
          for (const point of points) {
            if (!remaining.delete(point.segment_id)) duplicateOrUnknown++;
            if (previous && order(previous, point) >= 0) ordered = false;
            previous = point;
            if (
              point.attempts !== 1 ||
              point.failure_rate_pct !== point.failures * 100 ||
              (point.failures === 1
                ? point.latency_ms !== null
                : point.latency_ms !== 20)
            )
              invalidStatistics++;
            bytes += new TextEncoder().encode(JSON.stringify(point)).length + 1;
          }
          count += points.length;
          pages.push({ count: points.length, bytes, ...rowReads.at(-1)! });
          cursor = query.next_cursor;
          if (cursor) {
            if (cursors.has(cursor) || pages.length > hours * pointsPerHour)
              throw new Error("Pagination made no progress");
            cursors.add(cursor);
          }
        } while (cursor);
        return {
          pages,
          count,
          expected: hours * pointsPerHour,
          missing: remaining.size,
          duplicateOrUnknown,
          invalidStatistics,
          ordered,
          rowQueries: rowReads.length,
        };
      },
    );
    expect(result.count).toBe(result.expected);
    expect(result.missing).toBe(0);
    expect(result.duplicateOrUnknown).toBe(0);
    expect(result.invalidStatistics).toBe(0);
    expect(result.ordered).toBe(true);
    expect(result.rowQueries).toBe(result.pages.length);
    expect(result.pages.length).toBeGreaterThan(
      Math.ceil(result.expected / 3000),
    );
    expect(result.pages[0]!.bytes).toBeGreaterThan(900_000);
    for (const page of result.pages) {
      expect(page.count).toBeGreaterThan(0);
      expect(page.count).toBeLessThanOrEqual(3000);
      expect(page.bytes).toBeLessThanOrEqual(1_000_000);
      expect(page.eager).toBe(false);
      expect(page.rows).toBeGreaterThan(0);
      expect(page.rows).toBeLessThanOrEqual(2);
    }
  }, 30_000);
  it("retains a full 30d aggregate window including all-failure and separate segments", async () => {
    await setupAndLogin();
    const base = (await pointsAt(Math.floor(Date.now() / 1000), [null]))[0]!;
    const result = await runInDurableObject(
      env.FLEET_HUB_DO.getByName("global"),
      async (_obj, state) => {
        const store = new NetworkQualityStore(state.storage.sql, env, (fn) =>
          state.storage.transactionSync(fn),
        );
        await store.ensureReady();
        const to = Math.floor(Date.now() / 1000 / 300) * 300;
        const from = to - 2592000;
        const groups = new Map<number, ReturnType<typeof nqRollup>>();
        for (let ts = from; ts <= to; ts += 300) {
          const hour = Math.floor(ts / 3600) * 3600;
          const points = nqRollup([
            { ...base, ts },
            { ...base, sample_id: `b:${ts}`, segment_id: "second", ts: ts + 1 },
          ]);
          groups.set(hour, [...(groups.get(hour) ?? []), ...points]);
        }
        for (const [ts, points] of groups)
          state.storage.sql.exec(
            "INSERT OR REPLACE INTO network_quality_5m_chunk_1h VALUES (?,?,?,?)",
            "month",
            Math.floor(ts / 3600) % 721,
            ts,
            JSON.stringify({ version: 1, points }),
          );
        let cursor: string | null = btoa(
          JSON.stringify({ node_id: "month", range: "30d", to, offset: 0 }),
        );
        const all = [];
        let pages = 0;
        do {
          const q = store.query("month", "30d", cursor!);
          all.push(...q.series[0]!.points);
          cursor = q.next_cursor;
          pages++;
        } while (cursor);
        return {
          count: all.length,
          first: all[0]!.ts,
          last: all.at(-1)!.ts,
          from,
          to,
          pages,
          allFailed: all.every(
            (p) => p.failure_rate_pct === 100 && p.latency_ms === null,
          ),
          blocks: groups.size,
        };
      },
    );
    expect(result.count).toBe(8641 * 2);
    expect(result.first).toBe(result.from);
    expect(result.last).toBe(result.to);
    expect(result.allFailed).toBe(true);
    expect(result.blocks).toBe(721);
    expect(result.pages).toBeGreaterThan(1);
  });
});
