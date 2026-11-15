import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { NetworkQualityStore } from "../src/do/network-quality-store";
import {
  NQ_IDS,
  nqDefaultConfig,
  nqLatest,
  nqMakeControl,
  nqRollup,
  type NqPoint,
} from "../src/network-quality";
import { setupAndLogin } from "./helpers";

it("preserves a full day of network history within Idle and Live write budgets", async () => {
  await setupAndLogin();
  const control = await nqMakeControl({ ...nqDefaultConfig(), enabled: true });
  const result = await runInDurableObject(
    env.FLEET_HUB_DO.getByName("global"),
    async (_obj, state) => {
      const now = 1_800_000_000;
      const pointsAt = (ts: number): NqPoint[] =>
        control.targets.map(({ target_revision, ...target }) => ({
          sample_id: `cost:${ts}:${target.id}`,
          round_seq: ts / 20,
          config_id: control.config_id,
          target_id: target.id,
          target_revision,
          segment_id: `cost:${target.id}`,
          ts,
          result: "ok",
          connect_ms: 25,
          remote_ip: "1.1.1.1",
          target,
        }));
      const rows = [];
      for (const mode of ["idle", "live"] as const) {
        const node = `cost-${mode}`;
        const sql = state.storage.sql;
        for (let ts = now - 87000; ts < now; ts += 600) {
          const points = Array.from({ length: 30 }, (_, i) =>
            pointsAt(ts + i * 20),
          ).flat();
          sql.exec(
            "INSERT OR REPLACE INTO network_quality_chunk_10m VALUES (?,?,?,?)",
            node,
            Math.floor(ts / 600) % 146,
            ts,
            JSON.stringify({ version: 1, points }),
          );
        }
        for (let ts = now - 2592000; ts < now; ts += 3600) {
          const points = Array.from({ length: 180 }, (_, i) =>
            pointsAt(ts + i * 20),
          ).flat();
          sql.exec(
            "INSERT OR REPLACE INTO network_quality_5m_chunk_1h VALUES (?,?,?,?)",
            node,
            Math.floor(ts / 3600) % 721,
            ts,
            JSON.stringify({ version: 1, points: nqRollup(points) }),
          );
        }
        const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
        const tracked = {
          exec(...args: Parameters<SqlStorage["exec"]>) {
            const cursor = sql.exec(...args);
            cursors.push(cursor);
            return cursor;
          },
        } as SqlStorage;
        const store = new NetworkQualityStore(tracked, env, (fn) =>
          state.storage.transactionSync(fn),
        );
        await store.ensureReady();
        await store.saveConfig({ ...nqDefaultConfig(), enabled: true });
        store.setSupported(node, true);
        cursors.length = 0;
        let pending: NqPoint[] = [];
        let recent: NqPoint[] = [];
        let bytes = 0;
        let messages = 0;
        const started = Date.now();
        for (let t = now; t < now + 86400; t += 2) {
          if (t % 20 === 0) {
            pending.push(...pointsAt(t));
            recent = [...recent.filter((p) => p.ts > t - 120), ...pointsAt(t)];
          }
          if (mode === "idle" && (t - now) % 300 !== 298) continue;
          const latest = NQ_IDS.map((id) => {
            const p = recent.filter((p) => p.target_id === id).at(-1)!;
            return nqLatest(recent, p);
          });
          const payload = {
            schema_version: 1,
            applied_config_id: control.config_id,
            enabled: true,
            config_error: null,
            dropped_samples: 0,
            latest,
            points: pending,
          };
          bytes += new TextEncoder().encode(JSON.stringify(payload)).length;
          messages++;
          await store.ingest(node, payload, t);
          pending = [];
        }
        const elapsedMs = Date.now() - started;
        const read = cursors.reduce((n, c) => n + c.rowsRead, 0);
        const written = cursors.reduce((n, c) => n + c.rowsWritten, 0);
        const raw = sql
          .exec<{
            n: number;
            b: number;
          }>("SELECT COUNT(*) n,SUM(LENGTH(CAST(payload AS BLOB))) b FROM network_quality_chunk_10m WHERE node_id=?", node)
          .one();
        const roll = sql
          .exec<{
            n: number;
            b: number;
          }>("SELECT COUNT(*) n,SUM(LENGTH(CAST(payload AS BLOB))) b FROM network_quality_5m_chunk_1h WHERE node_id=?", node)
          .one();
        const blockDigest = async (table: string) => {
          const hashes: string[] = [];
          let points = 0;
          const slots = sql
            .exec<{ slot: number }>(
              `SELECT slot FROM ${table} WHERE node_id=? ORDER BY slot`,
              node,
            )
            .toArray();
          for (const { slot } of slots) {
            const row = sql
              .exec<{ slot: number; bucket_ts: number; payload: string }>(
                `SELECT slot,bucket_ts,payload FROM ${table} WHERE node_id=? AND slot=?`,
                node,
                slot,
              )
              .one();
            points += JSON.parse(row.payload).points.length;
            hashes.push(
              await sha256Hex(
                JSON.stringify([row.slot, row.bucket_ts, row.payload]),
              ),
            );
          }
          return { digest: await sha256Hex(hashes.join("\n")), points };
        };
        const rawContent = await blockDigest("network_quality_chunk_10m");
        const rollupContent = await blockDigest("network_quality_5m_chunk_1h");
        const persistedState = sql
          .exec<{ payload: string }>(
            "SELECT payload FROM network_quality_state WHERE node_id=?",
            node,
          )
          .one();
        expect(JSON.parse(persistedState.payload)).toEqual(store.state(node));
        rows.push({
          mode,
          hours: 24,
          messages,
          bytes,
          rowsRead: read,
          rowsWritten: written,
          elapsedMs,
          rawBlocks: raw.n,
          rollupBlocks: roll.n,
          rawPayloadBytes: raw.b,
          rollupPayloadBytes: roll.b,
          rawPoints: rawContent.points,
          rollupPoints: rollupContent.points,
          rawDigest: rawContent.digest,
          rollupDigest: rollupContent.digest,
          stateDigest: await sha256Hex(
            JSON.stringify(JSON.parse(persistedState.payload)),
          ),
        });
      }
      return rows;
    },
  );
  for (const row of result) {
    expect(row.rawBlocks).toBe(146);
    expect(row.rollupBlocks).toBe(721);
    expect(row.rawPoints).toBe(13140);
    expect(row.rollupPoints).toBe(25956);
    expect(row.rawPayloadBytes).toBe(6166164);
    expect(row.rollupPayloadBytes).toBe(11541768);
    expect(row.rawDigest).toBe(
      "755211b9f2d97fec1a6a0fda50c233f53b43e79937be2aa8bd9f00f27ea510d1",
    );
    expect(row.rollupDigest).toBe(
      "51e8fed8c108e57635ea225135415b138b1300f4a176d32f0e0bd7a546434d82",
    );
    expect(row.stateDigest).toBe(
      "1e7b89998e99b930d3f9761a33c065800e09810568615c33a82299df383e1ca7",
    );
  }
  expect(result[0]).toMatchObject({
    mode: "idle",
    messages: 288,
    bytes: 6475968,
    rowsWritten: 1034,
  });
  expect(result[1]).toMatchObject({
    mode: "live",
    messages: 43200,
    bytes: 65776320,
    rowsWritten: 13130,
  });
}, 60000);
