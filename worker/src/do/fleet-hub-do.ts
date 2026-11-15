import { DurableObject } from "cloudflare:workers";
import {
  evaluateRuleStep,
  extractMetricReading,
  formatRuleThresholdText,
  notifyChannels,
  recordIncidentFiring,
  recordIncidentRenotify,
  recordIncidentResolved,
  rowToAlertRule,
  rowToNotificationChannel,
  type AlertEvaluationContext,
  type AlertRuleMachineState,
  type AlertRuleRuntimeState,
} from "../alert/engine";
import { generateId } from "../crypto";
import {
  checkLatestAgentRelease,
  clearCachedAgentRelease,
  decodeAutoUpdateOverride,
  getAgentUpdateConfig,
  isNewerAgentVersion,
  isNodeEligibleForUpdate,
  normalizeAgentArch,
  parseAgentUpdateStatus,
  RELEASE_CACHE_TTL_SEC,
  signUpdateDirective,
} from "../auto-update";
import { NetworkQualityStore } from "./network-quality-store";
import {
  computeFleetScchEstimates,
  type FleetNqQuotaControl,
  type FleetScchEstimates,
} from "../cf-quota";
import {
  advanceTrafficLedger,
  computeCountedBytes,
  computeTrafficCycle,
  type TrafficLedgerRow,
} from "../traffic";
import type {
  AgentCtrlFrame,
  AgentHelloFrame,
  AgentLatestRelease,
  AgentMetricsBatchFrame,
  AgentMetricsFrame,
  AgentProcEntry,
  AgentUpdateConfig,
  AgentWsAttachment,
  AlertChangeMessage,
  AlertRule,
  AlertRuleRow,
  ClientAttachment,
  ClientInboundMessage,
  CompactMetricTuple,
  CtrlUpdateDirective,
  CtrlWatermarks,
  Env,
  ExportTrafficLedgerEntry,
  FleetBatchMessage,
  FleetTickMessage,
  MetricRange,
  MetricsQueryPoint,
  MetricsQueryResponse,
  NodeDetailMessage,
  NodeHardwareInfo,
  NodeMetricsPayload,
  NodeOfflineMessage,
  NodeRow,
  NodeSnapshot,
  NodeTrafficSummary,
  NodeUpdateStatus,
  NotificationChannel,
  NotificationChannelRow,
} from "../types";
import {
  CHUNK_1H_SEC,
  CHUNK_5M_SEC,
  chunkBucketTs,
  chunkSlot,
  decodeRawChunk,
  decodeRollupChunk,
  encodeRawChunk,
  encodeRollupChunk,
  finalizeWelford,
  isValidCompactTuple,
  mergeSortedPoints,
  payloadToCompactTuple,
  RAW_CHUNK_SEC,
  RAW_SLAB_SLOTS,
  rawPointToQueryPoint,
  ROLLUP_1H_SEC,
  ROLLUP_5M_SEC,
  RollupSlabPoint,
  rollupPointToQueryPoint,
  SLAB_1H_SLOTS,
  SLAB_5M_SLOTS,
  stepWelford,
  tupleToRawPoint,
  type RawSlabPoint,
  type WelfordAccum,
} from "./tsdb-slab";

const CLIENT_LEASE_SEC = 90;
const AGENT_LEASE_REFRESH_SEC = 30;
const OFFLINE_THRESHOLD_SEC = 60;
const COHORT_OFFLINE_THRESHOLD_SEC = 390; // 300s cohort batch_sec + 90s grace
const SAFETY_ALARM_MS = 15 * 60 * 1000;
const RAW_SAMPLE_MIN_GAP_SEC = 30;
const BATCH_SAMPLE_MIN_GAP_SEC = 25;
const TRAFFIC_COALESCE_BYTES = 64 * 1024 * 1024; // 64 MiB
const STALE_COHORT_FLUSH_SEC = 35;
const FLUSH_NOW_WAIT_MS = 350;
const FLEET_BROADCAST_THROTTLE_MS = 500;
const WS_CLOSE_SUPERSEDED = 4000;

interface PersistedNodeState {
  node_id: string;
  online: number;
  last_seen_ts: number | null;
  offline_deadline_ms: number | null;
  cycle_key: string | null;
  last_agent_rx: number | null;
  last_agent_tx: number | null;
  cycle_rx_bytes: number;
  cycle_tx_bytes: number;
  traffic_updated_at: number;
  last_flush_rx_tot: number;
  last_flush_tx_tot: number;
  last_raw_ts: number;
  last_boot_up: number | null;
  last_metrics: NodeMetricsPayload | null;
  welford_5m: WelfordAccum | null;
  welford_1h: WelfordAccum | null;
  hw: NodeHardwareInfo | null;
  caps: string[];
  update_status: NodeUpdateStatus | null;
}

interface NodeStateSqlRow {
  [key: string]: SqlStorageValue;
  node_id: string;
  online: number;
  last_seen_ts: number | null;
  offline_deadline_ms: number | null;
  cycle_key: string | null;
  last_agent_rx: number | null;
  last_agent_tx: number | null;
  cycle_rx_bytes: number;
  cycle_tx_bytes: number;
  traffic_updated_at: number;
  last_flush_rx_tot: number;
  last_flush_tx_tot: number;
  last_raw_ts: number;
  last_boot_up: number | null;
  last_metrics_json: string | null;
  welford_5m_json: string | null;
  welford_1h_json: string | null;
  hw_json: string | null;
  caps_json: string | null;
  update_status_json: string | null;
}

interface StoredAlertRuleState extends AlertRuleRuntimeState {
  metric: string;
}

interface AlertRuleStateSqlRow {
  [key: string]: SqlStorageValue;
  node_id: string;
  rule_id: string;
  metric: string;
  state: AlertRuleMachineState;
  first_breach_ts: number | null;
  last_notified_ts: number | null;
  recover_ok_count: number;
  incident_id: string | null;
  started_at: number | null;
}

interface ChunkSqlRow {
  [key: string]: SqlStorageValue;
  slot: number;
  bucket_ts: number;
  payload: ArrayBuffer;
}

export interface MigrateTargetSpec {
  nodeId: string;
  url: string;
  fallbackUrl?: string;
  epoch: number;
  sig: string;
}

export interface MigrateDispatchResult {
  dispatched: string[];
  skipped_offline: Array<{ node_id: string; reason: string }>;
}

export class FleetHubDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly networkQuality: NetworkQualityStore;
  private mirrorSeeded = false;
  private nodesMirror = new Map<string, NodeRow>();
  private rulesMirror = new Map<string, AlertRuleRow>();
  private channelsMirror = new Map<string, NotificationChannelRow>();
  private nodeStates = new Map<string, PersistedNodeState>();
  private dirtyNodeStates = new Set<string>();
  private ruleStates = new Map<string, StoredAlertRuleState>();
  private liveProcs = new Map<string, AgentProcEntry[]>();
  private flushWaiters = new Map<string, Array<() => void>>();
  private lastFleetBroadcastMs = 0;
  private lastRequestOrigin: string | null = null;
  private agentUpdateConfigCache: { config: AgentUpdateConfig; loadedAt: number } | null = null;
  private agentReleaseCache: { release: AgentLatestRelease | null; checkedAt: number; key: string } | null = null;
  private inFlightReleaseCheck: Promise<AgentLatestRelease | null> | null = null;
  private lastUpdateDispatchByNode = new Map<string, { version: string; ts: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.networkQuality = new NetworkQualityStore(this.sql, env, fn => this.ctx.storage.transactionSync(fn));

    // Auto-respond to browser heartbeat pings without waking the DO isolate.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"op":"ping"}', '{"t":"pong"}'),
    );

    void this.ctx.blockConcurrencyWhile(async () => {
      const hasMetaTable =
        this.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hub_meta'",
          )
          .toArray().length > 0;
      let schemaVersion = 0;
      if (hasMetaTable) {
        const verRow = this.sql
          .exec<{ value: string }>(
            "SELECT value FROM hub_meta WHERE key = 'schema_version'",
          )
          .toArray()[0];
        schemaVersion = verRow ? Number(verRow.value) || 0 : 0;
      }
      if (schemaVersion < 2) {
        this.initSchema();
      }
      if (schemaVersion < 3) {
        this.networkQuality.initSchema();
      }
      if (schemaVersion >= 2 && schemaVersion < 4) {
        this.migrateSchemaToV4();
      }
      if (schemaVersion < 4) {
        this.sql.exec("INSERT OR REPLACE INTO hub_meta(key,value) VALUES ('schema_version','4')");
      }
      this.loadPersistedStateIntoMemory();
      await this.networkQuality.ensureReady();
    });
  }

  private migrateSchemaToV4(): void {
    const mirrorCols = new Set(
      this.sql
        .exec<{ name: string }>("PRAGMA table_info(nodes_mirror)")
        .toArray()
        .map((c) => c.name),
    );
    if (!mirrorCols.has("auto_update_override")) {
      this.sql.exec("ALTER TABLE nodes_mirror ADD COLUMN auto_update_override INTEGER");
    }
    const stateCols = new Set(
      this.sql
        .exec<{ name: string }>("PRAGMA table_info(node_state)")
        .toArray()
        .map((c) => c.name),
    );
    if (!stateCols.has("caps_json")) {
      this.sql.exec("ALTER TABLE node_state ADD COLUMN caps_json TEXT");
    }
    if (!stateCols.has("update_status_json")) {
      this.sql.exec("ALTER TABLE node_state ADD COLUMN update_status_json TEXT");
    }
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hub_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes_mirror (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_name TEXT NOT NULL DEFAULT 'Default',
        tags_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        token_sha256 TEXT NOT NULL,
        traffic_limit_bytes INTEGER,
        traffic_reset_day INTEGER NOT NULL DEFAULT 1,
        traffic_count_mode TEXT NOT NULL DEFAULT 'both',
        hostname TEXT,
        os TEXT,
        kernel TEXT,
        arch TEXT,
        cpu_model TEXT,
        cpu_cores INTEGER,
        mem_total INTEGER,
        swap_total INTEGER,
        agent_version TEXT,
        proc_enabled INTEGER NOT NULL DEFAULT 1,
        mute_until INTEGER,
        auto_update_override INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_rules_mirror (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        node_id TEXT,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        duration_sec INTEGER NOT NULL DEFAULT 120,
        cooldown_sec INTEGER NOT NULL DEFAULT 3600,
        channel_ids_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels_mirror (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS node_state (
        node_id TEXT PRIMARY KEY,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen_ts INTEGER,
        offline_deadline_ms INTEGER,
        cycle_key TEXT,
        last_agent_rx INTEGER,
        last_agent_tx INTEGER,
        cycle_rx_bytes INTEGER NOT NULL DEFAULT 0,
        cycle_tx_bytes INTEGER NOT NULL DEFAULT 0,
        traffic_updated_at INTEGER NOT NULL DEFAULT 0,
        last_flush_rx_tot INTEGER NOT NULL DEFAULT 0,
        last_flush_tx_tot INTEGER NOT NULL DEFAULT 0,
        last_raw_ts INTEGER NOT NULL DEFAULT 0,
        last_boot_up INTEGER,
        last_metrics_json TEXT,
        welford_5m_json TEXT,
        welford_1h_json TEXT,
        hw_json TEXT,
        caps_json TEXT,
        update_status_json TEXT
      );

      CREATE TABLE IF NOT EXISTS alert_rule_states (
        node_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'OK',
        first_breach_ts INTEGER,
        last_notified_ts INTEGER,
        recover_ok_count INTEGER NOT NULL DEFAULT 0,
        incident_id TEXT,
        started_at INTEGER,
        PRIMARY KEY (node_id, rule_id)
      );

      CREATE TABLE IF NOT EXISTS metrics_chunk_10m (
        node_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        bucket_ts INTEGER NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (node_id, slot)
      );

      CREATE TABLE IF NOT EXISTS metrics_5m_chunk_1h (
        node_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        bucket_ts INTEGER NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (node_id, slot)
      );

      CREATE TABLE IF NOT EXISTS metrics_1h_chunk_1d (
        node_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        bucket_ts INTEGER NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (node_id, slot)
      );
    `);
  }

  private loadPersistedStateIntoMemory(): void {
    const metaRows = this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM hub_meta WHERE key IN ('mirror_seeded', 'last_request_origin')",
      )
      .toArray();
    for (const m of metaRows) {
      if (m.key === "mirror_seeded") {
        this.mirrorSeeded = m.value === "1";
      } else if (m.key === "last_request_origin") {
        this.lastRequestOrigin = m.value;
      }
    }

    for (const row of this.sql
      .exec<NodeRow & Record<string, SqlStorageValue>>("SELECT * FROM nodes_mirror")
      .toArray()) {
      this.nodesMirror.set(row.id, {
        ...row,
        auto_update_override: row.auto_update_override ?? null,
      });
    }
    for (const row of this.sql
      .exec<AlertRuleRow & Record<string, SqlStorageValue>>("SELECT * FROM alert_rules_mirror")
      .toArray()) {
      this.rulesMirror.set(row.id, row);
    }
    for (const row of this.sql
      .exec<NotificationChannelRow & Record<string, SqlStorageValue>>(
        "SELECT * FROM channels_mirror",
      )
      .toArray()) {
      this.channelsMirror.set(row.id, row);
    }
    for (const row of this.sql
      .exec<NodeStateSqlRow>("SELECT * FROM node_state")
      .toArray()) {
      this.nodeStates.set(row.node_id, {
        node_id: row.node_id,
        online: row.online,
        last_seen_ts: row.last_seen_ts,
        offline_deadline_ms: row.offline_deadline_ms,
        cycle_key: row.cycle_key,
        last_agent_rx: row.last_agent_rx,
        last_agent_tx: row.last_agent_tx,
        cycle_rx_bytes: row.cycle_rx_bytes,
        cycle_tx_bytes: row.cycle_tx_bytes,
        traffic_updated_at: row.traffic_updated_at,
        last_flush_rx_tot: row.last_flush_rx_tot,
        last_flush_tx_tot: row.last_flush_tx_tot,
        last_raw_ts: row.last_raw_ts,
        last_boot_up: row.last_boot_up,
        last_metrics: safeJsonParse<NodeMetricsPayload>(row.last_metrics_json),
        welford_5m: safeJsonParse<WelfordAccum>(row.welford_5m_json),
        welford_1h: safeJsonParse<WelfordAccum>(row.welford_1h_json),
        hw: safeJsonParse<NodeHardwareInfo>(row.hw_json),
        caps: safeJsonParse<string[]>(row.caps_json) ?? [],
        update_status: safeJsonParse<NodeUpdateStatus>(row.update_status_json),
      });
    }
    for (const row of this.sql
      .exec<AlertRuleStateSqlRow>("SELECT * FROM alert_rule_states")
      .toArray()) {
      this.ruleStates.set(ruleStateKey(row.node_id, row.rule_id), {
        rule_id: row.rule_id,
        metric: row.metric,
        state: row.state,
        first_breach_ts: row.first_breach_ts,
        last_notified_ts: row.last_notified_ts,
        recover_ok_count: row.recover_ok_count,
        incident_id: row.incident_id,
        started_at: row.started_at,
      });
    }
  }

  /**
   * Lazily populates local mirror tables from D1 once after fresh creation.
   * Subsequent wakes read DO SQLite only, keeping hot paths at zero D1 queries.
   */
  private async ensureMirrorSeeded(): Promise<void> {
    if (this.mirrorSeeded) {
      return;
    }

    const [nodesRes, rulesRes, channelsRes] = await Promise.all([
      this.env.DB.prepare("SELECT * FROM nodes").all<NodeRow>(),
      this.env.DB.prepare("SELECT * FROM alert_rules").all<AlertRuleRow>(),
      this.env.DB.prepare("SELECT * FROM notification_channels").all<NotificationChannelRow>(),
    ]);

    this.ctx.storage.transactionSync(() => {
      for (const node of nodesRes.results ?? []) {
        this.upsertNodeMirrorSql(node);
        this.nodesMirror.set(node.id, node);
      }
      for (const rule of rulesRes.results ?? []) {
        this.upsertRuleMirrorSql(rule);
        this.rulesMirror.set(rule.id, rule);
      }
      for (const channel of channelsRes.results ?? []) {
        this.upsertChannelMirrorSql(channel);
        this.channelsMirror.set(channel.id, channel);
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO hub_meta (key, value) VALUES ('mirror_seeded', '1')",
      );
      this.mirrorSeeded = true;
    });
  }

  /**
   * Self-heals `nodesMirror` from D1 if a node was inserted outside the API
   * (for example via `wrangler d1 execute`) after initial mirror seeding.
   * Zero D1 reads on the steady-state hot path.
   */
  private async ensureNodeMirrored(nodeId: string): Promise<NodeRow | undefined> {
    const existing = this.nodesMirror.get(nodeId);
    if (existing) {
      return existing;
    }

    const row = await this.env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
      .bind(nodeId)
      .first<NodeRow>();
    if (!row) {
      return undefined;
    }

    this.nodesMirror.set(nodeId, row);
    this.upsertNodeMirrorSql(row);
    return row;
  }

  private upsertNodeMirrorSql(node: NodeRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO nodes_mirror (
        id, name, group_name, tags_json, sort_order, token_sha256,
        traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
        hostname, os, kernel, arch, cpu_model, cpu_cores, mem_total, swap_total,
        agent_version, proc_enabled, mute_until, auto_update_override, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      node.id,
      node.name,
      node.group_name,
      node.tags_json,
      node.sort_order,
      node.token_sha256,
      node.traffic_limit_bytes,
      node.traffic_reset_day,
      node.traffic_count_mode,
      node.hostname,
      node.os,
      node.kernel,
      node.arch,
      node.cpu_model,
      node.cpu_cores,
      node.mem_total,
      node.swap_total,
      node.agent_version,
      node.proc_enabled,
      node.mute_until,
      node.auto_update_override ?? null,
      node.created_at,
      node.updated_at,
    );
  }

  private upsertRuleMirrorSql(rule: AlertRuleRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO alert_rules_mirror (
        id, name, node_id, metric, operator, threshold, duration_sec,
        cooldown_sec, channel_ids_json, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rule.id,
      rule.name,
      rule.node_id,
      rule.metric,
      rule.operator,
      rule.threshold,
      rule.duration_sec,
      rule.cooldown_sec,
      rule.channel_ids_json,
      rule.enabled,
      rule.created_at,
    );
  }

  private upsertChannelMirrorSql(channel: NotificationChannelRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO channels_mirror (
        id, name, type, enabled, config_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      channel.id,
      channel.name,
      channel.type,
      channel.enabled,
      channel.config_json,
      channel.created_at,
    );
  }

  private persistNodeStateSql(state: PersistedNodeState): void {
    this.sql.exec(
      `INSERT INTO node_state (
        node_id, online, last_seen_ts, offline_deadline_ms,
        cycle_key, last_agent_rx, last_agent_tx, cycle_rx_bytes, cycle_tx_bytes,
        traffic_updated_at, last_flush_rx_tot, last_flush_tx_tot,
        last_raw_ts, last_boot_up, last_metrics_json, welford_5m_json, welford_1h_json, hw_json,
        caps_json, update_status_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        online = excluded.online,
        last_seen_ts = excluded.last_seen_ts,
        offline_deadline_ms = excluded.offline_deadline_ms,
        cycle_key = excluded.cycle_key,
        last_agent_rx = excluded.last_agent_rx,
        last_agent_tx = excluded.last_agent_tx,
        cycle_rx_bytes = excluded.cycle_rx_bytes,
        cycle_tx_bytes = excluded.cycle_tx_bytes,
        traffic_updated_at = excluded.traffic_updated_at,
        last_flush_rx_tot = excluded.last_flush_rx_tot,
        last_flush_tx_tot = excluded.last_flush_tx_tot,
        last_raw_ts = excluded.last_raw_ts,
        last_boot_up = excluded.last_boot_up,
        last_metrics_json = excluded.last_metrics_json,
        welford_5m_json = excluded.welford_5m_json,
        welford_1h_json = excluded.welford_1h_json,
        hw_json = excluded.hw_json,
        caps_json = excluded.caps_json,
        update_status_json = excluded.update_status_json`,
      state.node_id,
      state.online,
      state.last_seen_ts,
      state.offline_deadline_ms,
      state.cycle_key,
      state.last_agent_rx,
      state.last_agent_tx,
      state.cycle_rx_bytes,
      state.cycle_tx_bytes,
      state.traffic_updated_at,
      state.last_flush_rx_tot,
      state.last_flush_tx_tot,
      state.last_raw_ts,
      state.last_boot_up,
      state.last_metrics ? JSON.stringify(state.last_metrics) : null,
      state.welford_5m ? JSON.stringify(state.welford_5m) : null,
      state.welford_1h ? JSON.stringify(state.welford_1h) : null,
      state.hw ? JSON.stringify(state.hw) : null,
      JSON.stringify(state.caps),
      state.update_status ? JSON.stringify(state.update_status) : null,
    );
    this.dirtyNodeStates.delete(state.node_id);
  }

  private persistRuleStateSql(nodeId: string, stored: StoredAlertRuleState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO alert_rule_states (
        node_id, rule_id, metric, state, first_breach_ts, last_notified_ts,
        recover_ok_count, incident_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nodeId,
      stored.rule_id,
      stored.metric,
      stored.state,
      stored.first_breach_ts,
      stored.last_notified_ts,
      stored.recover_ok_count,
      stored.incident_id,
      stored.started_at,
    );
  }

  private getOrCreateNodeState(nodeId: string): PersistedNodeState {
    const existing = this.nodeStates.get(nodeId);
    if (existing) {
      return existing;
    }
    const created: PersistedNodeState = {
      node_id: nodeId,
      online: 0,
      last_seen_ts: null,
      offline_deadline_ms: null,
      cycle_key: null,
      last_agent_rx: null,
      last_agent_tx: null,
      cycle_rx_bytes: 0,
      cycle_tx_bytes: 0,
      traffic_updated_at: 0,
      last_flush_rx_tot: 0,
      last_flush_tx_tot: 0,
      last_raw_ts: 0,
      last_boot_up: null,
      last_metrics: null,
      welford_5m: null,
      welford_1h: null,
      hw: null,
      caps: [],
      update_status: null,
    };
    this.nodeStates.set(nodeId, created);
    return created;
  }

  private resolveHardware(
    node: NodeRow | undefined,
    state: PersistedNodeState | undefined,
  ): NodeHardwareInfo | null {
    if (state?.hw) {
      return state.hw;
    }
    if (!node) {
      return null;
    }
    if (
      node.hostname === null &&
      node.os === null &&
      node.kernel === null &&
      node.arch === null &&
      node.cpu_model === null &&
      node.cpu_cores === null &&
      node.mem_total === null &&
      node.swap_total === null &&
      node.agent_version === null
    ) {
      return null;
    }
    return {
      hostname: node.hostname,
      os: node.os,
      kernel: node.kernel,
      arch: node.arch,
      cpu_model: node.cpu_model,
      cpu_cores: node.cpu_cores,
      mem_total: node.mem_total,
      swap_total: node.swap_total,
      agent_version: node.agent_version,
      proc_enabled: node.proc_enabled === 1,
    };
  }

  private buildTrafficSummary(
    node: NodeRow | undefined,
    state: PersistedNodeState | undefined,
    nowSec = Math.floor(Date.now() / 1000),
  ): NodeTrafficSummary {
    const resetDay = node?.traffic_reset_day ?? 1;
    const countMode = node?.traffic_count_mode ?? "both";
    const { cycleKey, daysRemaining } = computeTrafficCycle(nowSec, resetDay);
    const rxBytes = state?.cycle_rx_bytes ?? 0;
    const txBytes = state?.cycle_tx_bytes ?? 0;
    return {
      limit_bytes: node?.traffic_limit_bytes ?? null,
      reset_day: resetDay,
      count_mode: countMode,
      cycle_key: state?.cycle_key ?? cycleKey,
      rx_bytes: rxBytes,
      tx_bytes: txBytes,
      counted_bytes: computeCountedBytes(rxBytes, txBytes, countMode),
      days_remaining: daysRemaining,
    };
  }

  private buildNodeSnapshot(nodeId: string): NodeSnapshot {
    const node = this.nodesMirror.get(nodeId);
    const state = this.nodeStates.get(nodeId);
    return {
      online: state?.online === 1,
      last_seen_ts: state?.last_seen_ts ?? null,
      traffic: this.buildTrafficSummary(node, state),
      metrics: state?.last_metrics ?? null,
      hardware: this.resolveHardware(node, state),
      caps: state?.caps ?? [],
      update_status: state?.update_status ?? null,
    };
  }

  private buildFleetTick(nodeId: string): FleetTickMessage | null {
    const node = this.nodesMirror.get(nodeId);
    if (!node) {
      return null;
    }
    const state = this.nodeStates.get(nodeId);
    const hw = this.resolveHardware(node, state);
    return {
      t: "fleet_tick",
      nodeId,
      online: state?.online === 1,
      last_seen_ts: state?.last_seen_ts ?? null,
      traffic: this.buildTrafficSummary(node, state),
      metrics: state?.last_metrics ?? null,
      ...(hw ? { hardware: hw } : {}),
      caps: state?.caps ?? [],
      auto_update_override: decodeAutoUpdateOverride(node.auto_update_override),
      update_status: state?.update_status ?? null,
    };
  }

  private rememberOriginString(origin?: string): void {
    if (!origin) return;
    try {
      this.rememberRequestOrigin(new URL(origin));
    } catch {
      /* ignore invalid origin */
    }
  }

  private rememberRequestOrigin(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return;
    }
    if (this.lastRequestOrigin !== url.origin) {
      this.lastRequestOrigin = url.origin;
      this.sql.exec(
        "INSERT OR REPLACE INTO hub_meta(key, value) VALUES ('last_request_origin', ?)",
        url.origin,
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureMirrorSeeded();

    const url = new URL(request.url);
    this.rememberRequestOrigin(url);
    const upgrade = request.headers.get("Upgrade")?.toLowerCase();
    if (upgrade !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const role = request.headers.get("X-UniOB-Role");
    if (role === "agent" || url.pathname === "/api/agent/ws") {
      const nodeId = request.headers.get("X-UniOB-Node-Id") ?? url.searchParams.get("id");
      if (!nodeId) {
        return new Response("Missing node id", { status: 400 });
      }
      return this.acceptAgentWebSocket(nodeId);
    }

    return this.acceptClientWebSocket();
  }

  private acceptAgentWebSocket(nodeId: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    for (const existing of this.ctx.getWebSockets(`agent:${nodeId}`)) {
      try {
        existing.close(WS_CLOSE_SUPERSEDED, "Superseded by new connection");
      } catch {
        // Ignore sockets that are already closing.
      }
    }

    const attachment: AgentWsAttachment = {
      role: "agent",
      nodeId,
      ver: 1,
      mode: 0,
      caps: [],
    };
    this.ctx.acceptWebSocket(server, ["agent", `agent:${nodeId}`]);
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptClientWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const nowSec = Math.floor(Date.now() / 1000);
    const attachment: ClientAttachment = {
      role: "client",
      fleet: false,
      nodeId: null,
      proc: false,
      exp: nowSec + CLIENT_LEASE_SEC,
    };
    this.ctx.acceptWebSocket(server, ["client"]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      return;
    }

    await this.ensureMirrorSeeded();

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const att = this.readAnyAttachment(ws);
    if (att?.role === "agent") {
      await this.handleAgentMessage(ws, att, parsed as Record<string, unknown>);
      return;
    }

    if (att?.role === "client") {
      await this.handleClientMessage(ws, att, parsed as ClientInboundMessage);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.ensureMirrorSeeded();
    const att = this.readAnyAttachment(ws);
    if (!att) {
      return;
    }

    if (att.role === "agent") {
      await this.handleAgentDisconnect(ws, att.nodeId, code);
      return;
    }

    await this.handleClientDisconnect(ws, att);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.ensureMirrorSeeded();
    const att = this.readAnyAttachment(ws);
    if (!att) {
      return;
    }

    if (att.role === "agent") {
      await this.handleAgentDisconnect(ws, att.nodeId, 1006);
      return;
    }

    await this.handleClientDisconnect(ws, att);
  }

  private async handleAgentDisconnect(
    ws: WebSocket,
    nodeId: string,
    code: number,
  ): Promise<void> {
    if (code === WS_CLOSE_SUPERSEDED) {
      return;
    }
    const others = this.ctx
      .getWebSockets(`agent:${nodeId}`)
      .filter((candidate) => candidate !== ws && isSocketOpen(candidate));
    if (others.length > 0) {
      return;
    }

    const state = this.nodeStates.get(nodeId);
    if (!state) {
      await this.scheduleNextAlarm();
      return;
    }

    state.offline_deadline_ms = Date.now() + OFFLINE_THRESHOLD_SEC * 1000;
    this.persistNodeStateSql(state);
    await this.scheduleNextAlarm();
  }

  private async handleClientDisconnect(
    ws: WebSocket,
    att: ClientAttachment,
  ): Promise<void> {
    const affected = new Set<string>();
    if (att.nodeId) {
      affected.add(att.nodeId);
    }
    this.reconcileAffectedAgents(att.fleet ? null : affected, ws);
    await this.scheduleNextAlarm();
  }

  private async handleAgentMessage(
    ws: WebSocket,
    att: AgentWsAttachment,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const type = frame.t;
    if (type === "hello") {
      await this.onAgentHello(ws, att, frame as unknown as AgentHelloFrame);
      return;
    }
    if (type === "m") {
      await this.networkQuality.ingest(att.nodeId, frame.network_quality, Math.floor(Date.now()/1000));
      await this.onAgentMetrics(ws, att, frame as unknown as AgentMetricsFrame);
      return;
    }
    if (type === "mb") {
      await this.networkQuality.ingest(att.nodeId, frame.network_quality, Math.floor(Date.now()/1000));
      await this.onAgentBatch(ws, att, frame as unknown as AgentMetricsBatchFrame);
    }
  }

  private async onAgentHello(
    ws: WebSocket,
    att: AgentWsAttachment,
    hello: AgentHelloFrame,
  ): Promise<void> {
    const nodeId = att.nodeId;
    const node = await this.ensureNodeMirrored(nodeId);
    const nowSec = Math.floor(Date.now() / 1000);
    const state = this.getOrCreateNodeState(nodeId);
    const wasOffline = state.online === 0;

    const hw: NodeHardwareInfo = {
      hostname: hello.hostname ?? state.hw?.hostname ?? node?.hostname ?? null,
      os: hello.os ?? state.hw?.os ?? node?.os ?? null,
      kernel: hello.kernel ?? state.hw?.kernel ?? node?.kernel ?? null,
      arch: hello.arch ?? state.hw?.arch ?? node?.arch ?? null,
      cpu_model: hello.cpu_model ?? state.hw?.cpu_model ?? node?.cpu_model ?? null,
      cpu_cores:
        typeof hello.cpu_cores === "number"
          ? hello.cpu_cores
          : (state.hw?.cpu_cores ?? node?.cpu_cores ?? null),
      mem_total:
        typeof hello.mem_total === "number"
          ? hello.mem_total
          : (state.hw?.mem_total ?? node?.mem_total ?? null),
      swap_total:
        typeof hello.swap_total === "number"
          ? hello.swap_total
          : (state.hw?.swap_total ?? node?.swap_total ?? null),
      agent_version: hello.agent_ver ?? state.hw?.agent_version ?? node?.agent_version ?? null,
      proc_enabled:
        typeof hello.proc_enabled === "boolean"
          ? hello.proc_enabled
          : (state.hw?.proc_enabled ?? (node ? node.proc_enabled === 1 : true)),
    };

    state.online = 1;
    state.last_seen_ts = nowSec;
    state.offline_deadline_ms = null;
    state.hw = hw;

    let latestNode = node;
    if (node) {
      const procEnabledInt = hw.proc_enabled ? 1 : 0;
      const hwChanged =
        node.hostname !== hw.hostname ||
        node.os !== hw.os ||
        node.kernel !== hw.kernel ||
        node.arch !== hw.arch ||
        node.cpu_model !== hw.cpu_model ||
        node.cpu_cores !== hw.cpu_cores ||
        node.mem_total !== hw.mem_total ||
        node.swap_total !== hw.swap_total ||
        node.agent_version !== hw.agent_version ||
        node.proc_enabled !== procEnabledInt;

      const updatedNode: NodeRow = {
        ...node,
        hostname: hw.hostname,
        os: hw.os,
        kernel: hw.kernel,
        arch: hw.arch,
        cpu_model: hw.cpu_model,
        cpu_cores: hw.cpu_cores,
        mem_total: hw.mem_total,
        swap_total: hw.swap_total,
        agent_version: hw.agent_version,
        proc_enabled: procEnabledInt,
        updated_at: hwChanged ? nowSec : node.updated_at,
      };
      this.nodesMirror.set(nodeId, updatedNode);
      this.upsertNodeMirrorSql(updatedNode);
      latestNode = updatedNode;

      if (hwChanged) {
        try {
          await this.env.DB.prepare(
            `UPDATE nodes
             SET hostname = ?, os = ?, kernel = ?, arch = ?, cpu_model = ?,
                 cpu_cores = ?, mem_total = ?, swap_total = ?, agent_version = ?,
                 proc_enabled = ?, updated_at = ?
             WHERE id = ?`,
          )
            .bind(
              updatedNode.hostname,
              updatedNode.os,
              updatedNode.kernel,
              updatedNode.arch,
              updatedNode.cpu_model,
              updatedNode.cpu_cores,
              updatedNode.mem_total,
              updatedNode.swap_total,
              updatedNode.agent_version,
              updatedNode.proc_enabled,
              nowSec,
              nodeId,
            )
            .run();
        } catch {
          // Best-effort D1 writeback; DO mirror remains authoritative.
        }
      }
    }

    const ver = hello.v === 2 ? 2 : 1;
    const caps = Array.isArray(hello.capabilities)
      ? hello.capabilities.filter((c): c is string => typeof c === "string").slice(0, 16)
      : [];
    state.caps = caps;
    if (
      state.update_status &&
      (state.update_status.state === "applying" ||
        state.update_status.state === "staged") &&
      state.update_status.target_version &&
      state.update_status.target_version === hw.agent_version
    ) {
      state.update_status = { state: "idle", updated_at: nowSec };
    }
    this.persistNodeStateSql(state);

    this.networkQuality.setSupported(nodeId, caps.includes("network_quality_v1"));
    const desired = this.computeCtrlForNode(nodeId, ver, nowSec);
    const nextAtt: AgentWsAttachment = {
      role: "agent",
      nodeId,
      ver,
      mode: desired.mode,
      caps,
    };
    ws.serializeAttachment(nextAtt);

    if (latestNode) {
      const update = await this.resolveAutoUpdateDirective(
        nextAtt,
        latestNode,
        state,
        nowSec,
      );
      if (update) {
        desired.update = update;
        this.lastUpdateDispatchByNode.set(nodeId, {
          version: update.version,
          ts: nowSec,
        });
      }
    }

    // Send initial ctrl immediately for v2 agents, watched nodes, or auto-update dispatch.
    if (ver >= 2 || desired.mode > 0 || desired.update) {
      this.sendAgentCtrl(ws, desired);
    }

    if (wasOffline && latestNode) {
      await this.resolveOfflineRulesIfFiring(latestNode, nowSec);
      this.maybeBroadcastFleetTick(nodeId);
    }

    await this.scheduleNextAlarm();
  }

  private async onAgentMetrics(
    ws: WebSocket,
    att: AgentWsAttachment,
    frame: AgentMetricsFrame,
  ): Promise<void> {
    const nodeId = att.nodeId;
    const node = await this.ensureNodeMirrored(nodeId);
    if (!node) {
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const state = this.getOrCreateNodeState(nodeId);
    const wasOffline = state.online === 0;
    const {
      t: _t,
      procs,
      network_quality: _nq,
      upd: rawUpd,
      ...resourcePayload
    } = frame;
    const payload: NodeMetricsPayload = { ...resourcePayload, network_quality: this.networkQuality.state(nodeId) };
    const updChanged = this.applyMetricsUpdateStatus(state, rawUpd, nowSec);

    const prevLedger: TrafficLedgerRow | null =
      state.cycle_key !== null && state.last_agent_rx !== null && state.last_agent_tx !== null
        ? {
            cycle_key: state.cycle_key,
            last_agent_rx: state.last_agent_rx,
            last_agent_tx: state.last_agent_tx,
            cycle_rx_bytes: state.cycle_rx_bytes,
            cycle_tx_bytes: state.cycle_tx_bytes,
            updated_at: state.traffic_updated_at,
          }
        : null;

    const trafficStep = advanceTrafficLedger(
      prevLedger,
      payload.net.rx_tot,
      payload.net.tx_tot,
      payload.ts,
      node.traffic_reset_day,
    );

    const prevRawBucket =
      state.last_raw_ts > 0 ? chunkBucketTs(state.last_raw_ts, RAW_CHUNK_SEC) : -1;
    const sampleTs = Math.floor(payload.ts);
    const shouldWriteRaw =
      state.last_raw_ts === 0 ||
      sampleTs - state.last_raw_ts >= RAW_SAMPLE_MIN_GAP_SEC;

    state.online = 1;
    state.last_seen_ts = nowSec;
    state.offline_deadline_ms = null;
    state.cycle_key = trafficStep.next.cycle_key;
    state.last_agent_rx = trafficStep.next.last_agent_rx;
    state.last_agent_tx = trafficStep.next.last_agent_tx;
    state.cycle_rx_bytes = trafficStep.next.cycle_rx_bytes;
    state.cycle_tx_bytes = trafficStep.next.cycle_tx_bytes;
    state.traffic_updated_at = trafficStep.next.updated_at;
    state.last_boot_up = payload.up;
    state.last_metrics = payload;
    this.dirtyNodeStates.add(nodeId);

    if (Array.isArray(procs)) {
      this.liveProcs.set(nodeId, procs);
    }

    const trafficDelta =
      Math.abs(payload.net.rx_tot - state.last_flush_rx_tot) +
      Math.abs(payload.net.tx_tot - state.last_flush_tx_tot);
    const newRawBucket = chunkBucketTs(sampleTs, RAW_CHUNK_SEC);
    const chunkCrossed = prevRawBucket !== -1 && newRawBucket !== prevRawBucket;
    const shouldFlushState =
      shouldWriteRaw ||
      wasOffline ||
      updChanged ||
      trafficStep.rebooted ||
      trafficStep.cycleReset ||
      trafficDelta >= TRAFFIC_COALESCE_BYTES ||
      chunkCrossed;

    if (shouldWriteRaw) {
      const tuple = payloadToCompactTuple(payload);
      const rawPoint = tupleToRawPoint(tuple);
      state.last_raw_ts = sampleTs;
      this.ctx.storage.transactionSync(() => {
        this.ingestTsdbPointsSync(nodeId, state, [rawPoint]);
        state.last_flush_rx_tot = payload.net.rx_tot;
        state.last_flush_tx_tot = payload.net.tx_tot;
        this.persistNodeStateSql(state);
      });
    } else if (shouldFlushState) {
      state.last_flush_rx_tot = payload.net.rx_tot;
      state.last_flush_tx_tot = payload.net.tx_tot;
      this.persistNodeStateSql(state);
    }

    if (wasOffline) {
      await this.resolveOfflineRulesIfFiring(node, nowSec);
    }
    const evalSec = Number.isFinite(payload.ts) && payload.ts > 0 ? Math.floor(payload.ts) : nowSec;
    const trafficSummary = this.buildTrafficSummary(node, state, evalSec);
    await this.evaluateNodeMetricRules(node, state, payload, trafficSummary, evalSec);

    this.broadcastLiveUpdate(nodeId, nowSec, payload, procs);
    this.resolveFlushWaiters(nodeId);

    const desired = this.computeCtrlForNode(nodeId, att.ver, nowSec);
    if (desired.mode !== att.mode) {
      att.mode = desired.mode;
      ws.serializeAttachment(att);
      this.sendAgentCtrl(ws, desired);
    }
    await this.maybeAutoDispatchUpdate(ws, att, node, state, nowSec);

    if (wasOffline) {
      await this.scheduleNextAlarm();
    }
  }

  private async onAgentBatch(
    ws: WebSocket,
    att: AgentWsAttachment,
    frame: AgentMetricsBatchFrame,
  ): Promise<void> {
    const nodeId = att.nodeId;
    const node = await this.ensureNodeMirrored(nodeId);
    if (!node) {
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const state = this.getOrCreateNodeState(nodeId);
    const wasOffline = state.online === 0;
    const {
      procs: _lastProcs,
      network_quality: _lastNq,
      upd: lastUpd,
      ...resourcePayload
    } = frame.last;
    const rawUpd = frame.upd ?? lastUpd;
    const lastPayload: NodeMetricsPayload = { ...resourcePayload, network_quality: this.networkQuality.state(nodeId) };
    this.applyMetricsUpdateStatus(state, rawUpd, nowSec);

    const validTuples: CompactMetricTuple[] = Array.isArray(frame.pts)
      ? frame.pts.filter(isValidCompactTuple)
      : [];
    if (validTuples.length === 0) {
      validTuples.push(payloadToCompactTuple(lastPayload));
    }
    validTuples.sort((a, b) => a[0] - b[0]);

    let ledger: TrafficLedgerRow | null =
      state.cycle_key !== null && state.last_agent_rx !== null && state.last_agent_tx !== null
        ? {
            cycle_key: state.cycle_key,
            last_agent_rx: state.last_agent_rx,
            last_agent_tx: state.last_agent_tx,
            cycle_rx_bytes: state.cycle_rx_bytes,
            cycle_tx_bytes: state.cycle_tx_bytes,
            updated_at: state.traffic_updated_at,
          }
        : null;

    const acceptedRaw: RawSlabPoint[] = [];
    let lastAcceptedTs = state.last_raw_ts;
    let prevBootUp = state.last_boot_up;

    for (const tuple of validTuples) {
      const tupleTs = Math.floor(tuple[0]);
      prevBootUp = tuple[1];
      ledger = advanceTrafficLedger(
        ledger,
        tuple[13],
        tuple[14],
        tupleTs,
        node.traffic_reset_day,
      ).next;

      if (lastAcceptedTs === 0 || tupleTs - lastAcceptedTs >= BATCH_SAMPLE_MIN_GAP_SEC) {
        acceptedRaw.push(tupleToRawPoint(tuple));
        lastAcceptedTs = tupleTs;
      }
    }

    const finalLedger = advanceTrafficLedger(
      ledger,
      lastPayload.net.rx_tot,
      lastPayload.net.tx_tot,
      lastPayload.ts,
      node.traffic_reset_day,
    ).next;
    prevBootUp = lastPayload.up;

    state.online = 1;
    state.last_seen_ts = nowSec;
    state.offline_deadline_ms = null;
    state.cycle_key = finalLedger.cycle_key;
    state.last_agent_rx = finalLedger.last_agent_rx;
    state.last_agent_tx = finalLedger.last_agent_tx;
    state.cycle_rx_bytes = finalLedger.cycle_rx_bytes;
    state.cycle_tx_bytes = finalLedger.cycle_tx_bytes;
    state.traffic_updated_at = finalLedger.updated_at;
    state.last_boot_up = prevBootUp;
    state.last_raw_ts = lastAcceptedTs;
    state.last_metrics = lastPayload;
    state.last_flush_rx_tot = lastPayload.net.rx_tot;
    state.last_flush_tx_tot = lastPayload.net.tx_tot;

    this.ctx.storage.transactionSync(() => {
      if (acceptedRaw.length > 0) {
        this.ingestTsdbPointsSync(nodeId, state, acceptedRaw);
      }
      this.persistNodeStateSql(state);
    });

    if (wasOffline) {
      await this.resolveOfflineRulesIfFiring(node, nowSec);
    }
    const trafficSummary = this.buildTrafficSummary(node, state, nowSec);
    await this.evaluateNodeMetricRules(node, state, lastPayload, trafficSummary, nowSec);
    this.broadcastLiveUpdate(nodeId, nowSec, lastPayload, frame.last.procs);
    this.resolveFlushWaiters(nodeId);

    const desired = this.computeCtrlForNode(nodeId, 2, nowSec);
    if (att.ver !== 2 || desired.mode !== att.mode) {
      att.ver = 2;
      att.mode = desired.mode;
      ws.serializeAttachment(att);
      this.sendAgentCtrl(ws, desired);
    }
    await this.maybeAutoDispatchUpdate(ws, att, node, state, nowSec);

    if (wasOffline) {
      await this.scheduleNextAlarm();
    }
  }

  /**
   * Appends sorted raw points into 10m ring chunks and advances 5m/1h Welford rollups
   */
  private ingestTsdbPointsSync(
    nodeId: string,
    state: PersistedNodeState,
    points: RawSlabPoint[],
  ): void {
    const sorted = [...points].sort((a, b) => a.ts - b.ts);
    const rawByBucket = new Map<number, RawSlabPoint[]>();
    const closed5m: RollupSlabPoint[] = [];
    const closed1h: RollupSlabPoint[] = [];

    for (const pt of sorted) {
      const rawBucket = chunkBucketTs(pt.ts, RAW_CHUNK_SEC);
      const list = rawByBucket.get(rawBucket);
      if (list) {
        list.push(pt);
      } else {
        rawByBucket.set(rawBucket, [pt]);
      }

      const step5 = stepWelford(state.welford_5m, ROLLUP_5M_SEC, pt);
      if (step5.closed) {
        closed5m.push(step5.closed);
      }
      state.welford_5m = step5.next;

      const step1h = stepWelford(state.welford_1h, ROLLUP_1H_SEC, pt);
      if (step1h.closed) {
        closed1h.push(step1h.closed);
      }
      state.welford_1h = step1h.next;
    }

    for (const [bucketTs, incoming] of rawByBucket.entries()) {
      const slot = chunkSlot(bucketTs, RAW_CHUNK_SEC, RAW_SLAB_SLOTS);
      const existingRow = this.sql
        .exec<ChunkSqlRow>(
          "SELECT slot, bucket_ts, payload FROM metrics_chunk_10m WHERE node_id = ? AND slot = ?",
          nodeId,
          slot,
        )
        .toArray()[0];
      const existingPoints =
        existingRow && existingRow.bucket_ts === bucketTs
          ? decodeRawChunk(existingRow.payload)
          : [];
      const merged = mergeSortedPoints(existingPoints, incoming);
      this.sql.exec(
        "INSERT INTO metrics_chunk_10m (node_id, slot, bucket_ts, payload) VALUES (?, ?, ?, ?) ON CONFLICT(node_id, slot) DO UPDATE SET bucket_ts = excluded.bucket_ts, payload = excluded.payload",
        nodeId,
        slot,
        bucketTs,
        encodeRawChunk(merged),
      );
    }

    this.writeRollupPointsSync("metrics_5m_chunk_1h", nodeId, CHUNK_5M_SEC, SLAB_5M_SLOTS, closed5m);
    this.writeRollupPointsSync("metrics_1h_chunk_1d", nodeId, CHUNK_1H_SEC, SLAB_1H_SLOTS, closed1h);
  }

  private writeRollupPointsSync(
    table: "metrics_5m_chunk_1h" | "metrics_1h_chunk_1d",
    nodeId: string,
    chunkSec: number,
    slabSlots: number,
    points: RollupSlabPoint[],
  ): void {
    if (points.length === 0) {
      return;
    }

    const byBucket = new Map<number, RollupSlabPoint[]>();
    for (const pt of points) {
      const bucketTs = chunkBucketTs(pt.ts, chunkSec);
      const list = byBucket.get(bucketTs);
      if (list) {
        list.push(pt);
      } else {
        byBucket.set(bucketTs, [pt]);
      }
    }

    for (const [bucketTs, incoming] of byBucket.entries()) {
      const slot = chunkSlot(bucketTs, chunkSec, slabSlots);
      const existingRow = this.sql
        .exec<ChunkSqlRow>(
          `SELECT slot, bucket_ts, payload FROM ${table} WHERE node_id = ? AND slot = ?`,
          nodeId,
          slot,
        )
        .toArray()[0];
      const existingPoints =
        existingRow && existingRow.bucket_ts === bucketTs
          ? decodeRollupChunk(existingRow.payload)
          : [];
      const merged = mergeSortedPoints(existingPoints, incoming);
      this.sql.exec(
        `INSERT INTO ${table} (node_id, slot, bucket_ts, payload) VALUES (?, ?, ?, ?) ON CONFLICT(node_id, slot) DO UPDATE SET bucket_ts = excluded.bucket_ts, payload = excluded.payload`,
        nodeId,
        slot,
        bucketTs,
        encodeRollupChunk(merged),
      );
    }
  }

  private async handleClientMessage(
    ws: WebSocket,
    att: ClientAttachment,
    cmd: ClientInboundMessage,
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (cmd.op === "ping") {
      sendJsonSafe(ws, { t: "pong" });
      return;
    }

    if (cmd.op === "renew") {
      if (att.fleet || att.nodeId !== null) {
        const nextAtt: ClientAttachment = {
          role: "client",
          fleet: att.fleet,
          nodeId: att.nodeId,
          proc: att.proc,
          exp: nowSec + CLIENT_LEASE_SEC,
        };
        ws.serializeAttachment(nextAtt);
        this.reconcileAffectedAgents(att.fleet ? null : new Set(att.nodeId ? [att.nodeId] : []), undefined, true);
        await this.scheduleNextAlarm();
      }
      return;
    }

    if (cmd.op === "sub_fleet") {
      const nextAtt: ClientAttachment = {
        role: "client",
        fleet: true,
        nodeId: att.nodeId,
        proc: att.proc,
        exp: nowSec + CLIENT_LEASE_SEC,
      };
      ws.serializeAttachment(nextAtt);
      this.sendFleetBatchToClient(ws);
      this.reconcileAllConnectedAgents();
      await this.scheduleNextAlarm();
      return;
    }

    if (cmd.op === "unsub_fleet") {
      const nextAtt: ClientAttachment = {
        role: "client",
        fleet: false,
        nodeId: att.nodeId,
        proc: att.proc,
        exp: nowSec + CLIENT_LEASE_SEC,
      };
      ws.serializeAttachment(nextAtt);
      this.reconcileAllConnectedAgents();
      await this.scheduleNextAlarm();
      return;
    }

    if (cmd.op === "sub_node") {
      const prevNodeId = att.nodeId;
      const nextNodeId = cmd.nodeId;
      const nextAtt: ClientAttachment = {
        role: "client",
        fleet: att.fleet,
        nodeId: nextNodeId,
        proc: Boolean(cmd.proc),
        exp: nowSec + CLIENT_LEASE_SEC,
      };
      ws.serializeAttachment(nextAtt);

      if (prevNodeId && prevNodeId !== nextNodeId) {
        this.reconcileAgentCtrl(prevNodeId);
      }
      this.reconcileAgentCtrl(nextNodeId);

      const state = this.nodeStates.get(nextNodeId);
      if (state?.last_metrics) {
        const detail: NodeDetailMessage = {
          t: "node_detail",
          nodeId: nextNodeId,
          online: state.online === 1,
          ts: state.last_seen_ts ?? state.last_metrics.ts,
          metrics: state.last_metrics,
          ...(nextAtt.proc ? { procs: this.liveProcs.get(nextNodeId) ?? [] } : {}),
        };
        sendJsonSafe(ws, detail);
      }

      await this.scheduleNextAlarm();
      return;
    }

    if (cmd.op === "unsub_node") {
      const prevNodeId = att.nodeId;
      const nextAtt: ClientAttachment = {
        role: "client",
        fleet: att.fleet,
        nodeId: null,
        proc: false,
        exp: nowSec + CLIENT_LEASE_SEC,
      };
      ws.serializeAttachment(nextAtt);
      if (prevNodeId) {
        this.reconcileAgentCtrl(prevNodeId);
      }
      await this.scheduleNextAlarm();
    }
  }

  private sendFleetBatchToClient(ws: WebSocket): void {
    const ticks: FleetTickMessage[] = [];
    for (const nodeId of this.nodesMirror.keys()) {
      const tick = this.buildFleetTick(nodeId);
      if (tick) {
        ticks.push(tick);
      }
    }
    const batch: FleetBatchMessage = { t: "fleet_batch", ticks };
    sendJsonSafe(ws, batch);
  }

  private broadcastLiveUpdate(
    nodeId: string,
    nowSec: number,
    metrics: NodeMetricsPayload,
    procs?: AgentProcEntry[],
  ): void {
    const clients = this.ctx.getWebSockets("client");
    if (clients.length === 0) {
      return;
    }
    const tick = this.buildFleetTick(nodeId);

    let tickText: string | null = null;
    let detailNoProcText: string | null = null;
    let detailWithProcText: string | null = null;

    for (const client of clients) {
      const att = this.readClientAttachment(client);
      if (!att || (att.exp ?? 0) <= nowSec) {
        continue;
      }
      if (att.nodeId === nodeId) {
        if (att.proc) {
          detailWithProcText ??= JSON.stringify({
            t: "node_detail",
            nodeId,
            online: true,
            ts: nowSec,
            metrics,
            procs: procs ?? this.liveProcs.get(nodeId) ?? [],
          } satisfies NodeDetailMessage);
          sendRawSafe(client, detailWithProcText);
        } else {
          detailNoProcText ??= JSON.stringify({
            t: "node_detail",
            nodeId,
            online: true,
            ts: nowSec,
            metrics,
          } satisfies NodeDetailMessage);
          sendRawSafe(client, detailNoProcText);
        }
      }
      if (att.fleet && tick) {
        tickText ??= JSON.stringify(tick);
        sendRawSafe(client, tickText);
      }
    }
  }

  private maybeBroadcastFleetTick(nodeId: string): void {
    const nowMs = Date.now();
    if (
      nowMs - this.lastFleetBroadcastMs < FLEET_BROADCAST_THROTTLE_MS &&
      this.ctx.getWebSockets("client").length === 0
    ) {
      return;
    }
    const tick = this.buildFleetTick(nodeId);
    if (!tick) {
      return;
    }
    const nowSec = Math.floor(nowMs / 1000);
    const payload = JSON.stringify(tick);
    for (const client of this.ctx.getWebSockets("client")) {
      const att = this.readClientAttachment(client);
      if (att && (att.exp ?? 0) > nowSec && att.fleet) {
        sendRawSafe(client, payload);
      }
    }
    this.lastFleetBroadcastMs = nowMs;
  }

  private broadcastMessage(msg: unknown): void {
    const clients = this.ctx.getWebSockets("client");
    if (clients.length === 0) {
      return;
    }
    const serialized = JSON.stringify(msg);
    for (const client of clients) {
      sendRawSafe(client, serialized);
    }
  }

  private computeCtrlForNode(
    nodeId: string,
    ver: number,
    nowSec: number,
    excludeClientWs?: WebSocket,
  ): AgentCtrlFrame {
    const ctrl = this.computeResourceCtrlForNode(nodeId, ver, nowSec, excludeClientWs);
    if (this.networkQuality.state(nodeId).supported) ctrl.network_quality = this.networkQuality.control(nodeId);
    return ctrl;
  }

  private computeResourceCtrlForNode(
    nodeId: string,
    ver: number,
    nowSec: number,
    excludeClientWs?: WebSocket,
  ): AgentCtrlFrame {
    let hasNodeProc = false;
    let hasNodeDetail = false;
    let hasFleet = false;

    for (const client of this.ctx.getWebSockets("client")) {
      if (excludeClientWs && client === excludeClientWs) {
        continue;
      }
      const att = this.readClientAttachment(client);
      if (!att || (att.exp ?? 0) <= nowSec) {
        continue;
      }
      if (att.nodeId === nodeId) {
        if (att.proc) {
          hasNodeProc = true;
        } else {
          hasNodeDetail = true;
        }
      }
      if (att.fleet) {
        hasFleet = true;
      }
    }

    if (hasNodeProc) {
      return {
        t: "ctrl",
        mode: 2,
        interval_ms: 2000,
        top_n: 30,
        lease_sec: CLIENT_LEASE_SEC,
      };
    }

    if (hasNodeDetail) {
      return {
        t: "ctrl",
        mode: 1,
        interval_ms: 2000,
        top_n: 30,
        lease_sec: CLIENT_LEASE_SEC,
      };
    }

    if (hasFleet) {
      return {
        t: "ctrl",
        mode: 1,
        interval_ms: 10000,
        top_n: 0,
        lease_sec: CLIENT_LEASE_SEC,
      };
    }

    if (ver >= 2) {
      const ctrl: AgentCtrlFrame = {
        t: "ctrl",
        mode: 0,
        interval_ms: 30000,
        batch_sec: 300,
        top_n: 0,
        lease_sec: 0,
      };
      const watermarks = this.computeWatermarksForNode(nodeId);
      if (watermarks) {
        ctrl.watermarks = watermarks;
      }
      return ctrl;
    }

    return {
      t: "ctrl",
      mode: 0,
      interval_ms: 30000,
      top_n: 0,
      lease_sec: 0,
    };
  }

  private computeWatermarksForNode(nodeId: string): CtrlWatermarks | undefined {
    const watermarks: CtrlWatermarks = {};
    let hasAny = false;

    for (const rule of this.rulesMirror.values()) {
      if (rule.enabled !== 1) {
        continue;
      }
      if (rule.node_id !== null && rule.node_id !== nodeId) {
        continue;
      }
      if (
        rule.metric === "cpu" ||
        rule.metric === "steal" ||
        rule.metric === "mem" ||
        rule.metric === "swap" ||
        rule.metric === "disk"
      ) {
        const key = rule.metric;
        const current = watermarks[key];
        watermarks[key] = current === undefined ? rule.threshold : Math.min(current, rule.threshold);
        hasAny = true;
      }
    }

    return hasAny ? watermarks : undefined;
  }

  private sendAgentCtrl(ws: WebSocket, ctrl: AgentCtrlFrame): void {
    if (!sendJsonSafe(ws, ctrl)) return;
    const att = this.readAgentAttachment(ws);
    if (att) {
      att.mode = ctrl.mode;
      att.last_ctrl_ts = Math.floor(Date.now() / 1000);
      ws.serializeAttachment(att);
    }
  }

  private reconcileAgentCtrl(nodeId: string, excludeClientWs?: WebSocket, renewOnly = false): void {
    const sockets = this.ctx.getWebSockets(`agent:${nodeId}`);
    if (sockets.length === 0) {
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const sock of sockets) {
      if (!isSocketOpen(sock)) {
        continue;
      }
      const att: AgentWsAttachment = this.readAgentAttachment(sock) ?? {
        role: "agent" as const,
        nodeId,
        ver: 1,
        mode: 0 as const,
        caps: [],
      };
      // Browser renewals extend the agent's own lease as well as the watch lease.
      // A 30s gate accommodates both 20s and 50s clients within the 90s lease.
      const desired = renewOnly
        ? this.computeResourceCtrlForNode(nodeId, att.ver, nowSec, excludeClientWs)
        : this.computeCtrlForNode(nodeId, att.ver, nowSec, excludeClientWs);
      if (renewOnly && (desired.mode === 0 || nowSec - (att.last_ctrl_ts ?? 0) < AGENT_LEASE_REFRESH_SEC)) continue;
      att.mode = desired.mode;
      sock.serializeAttachment(att);
      this.sendAgentCtrl(sock, desired);
    }
  }

  private reconcileAllConnectedAgents(excludeClientWs?: WebSocket, renewOnly = false): void {
    const seen = new Set<string>();
    for (const sock of this.ctx.getWebSockets("agent")) {
      const att = this.readAgentAttachment(sock);
      if (att && !seen.has(att.nodeId)) {
        seen.add(att.nodeId);
        this.reconcileAgentCtrl(att.nodeId, excludeClientWs, renewOnly);
      }
    }
  }

  private reconcileAffectedAgents(nodeIds: Set<string> | null, excludeClientWs?: WebSocket, renewOnly = false): void {
    if (nodeIds === null) {
      this.reconcileAllConnectedAgents(excludeClientWs, renewOnly);
      return;
    }
    for (const nodeId of nodeIds) {
      this.reconcileAgentCtrl(nodeId, excludeClientWs, renewOnly);
    }
  }

  async alarm(): Promise<void> {
    await this.ensureMirrorSeeded();

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    for (const client of this.ctx.getWebSockets("client")) {
      const att = this.readClientAttachment(client);
      if (att && (att.exp ?? 0) <= nowSec && (att.fleet || att.nodeId !== null)) {
        const cleared: ClientAttachment = {
          role: "client",
          fleet: false,
          nodeId: null,
          proc: false,
          exp: att.exp,
        };
        client.serializeAttachment(cleared);
      }
    }

    this.reconcileAllConnectedAgents();

    for (const [nodeId, state] of this.nodeStates.entries()) {
      if (state.online !== 1) {
        continue;
      }
      const node = this.nodesMirror.get(nodeId);
      const openSockets = this.ctx
        .getWebSockets(`agent:${nodeId}`)
        .filter((sock) => isSocketOpen(sock));
      const hasOpenSocket = openSockets.length > 0;
      const hasOpenCohortV2 = openSockets.some((sock) => {
        const att = this.readAgentAttachment(sock);
        return att !== null && att.ver >= 2 && att.mode === 0;
      });
      const staleThresholdSec = hasOpenCohortV2
        ? COHORT_OFFLINE_THRESHOLD_SEC
        : OFFLINE_THRESHOLD_SEC;
      const deadlinePassed =
        state.offline_deadline_ms !== null && nowMs >= state.offline_deadline_ms;
      const lastSeenStale =
        state.last_seen_ts !== null && nowSec - state.last_seen_ts >= staleThresholdSec;

      if ((deadlinePassed && !hasOpenSocket) || lastSeenStale) {
        state.online = 0;
        state.offline_deadline_ms = null;
        this.persistNodeStateSql(state);
        if (node) {
          await this.fireOfflineRules(node, state, nowSec);
        }
        this.broadcastMessage({
          t: "node_offline",
          nodeId,
          last_seen_ts: state.last_seen_ts,
        } satisfies NodeOfflineMessage);
        this.maybeBroadcastFleetTick(nodeId);
      }
    }

    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    let earliestMs: number | null = null;

    for (const client of this.ctx.getWebSockets("client")) {
      const att = this.readClientAttachment(client);
      if (att && (att.fleet || att.nodeId !== null) && att.exp) {
        const expMs = Math.max(Date.now() + 100, att.exp * 1000);
        if (earliestMs === null || expMs < earliestMs) {
          earliestMs = expMs;
        }
      }
    }

    let hasOnline = false;
    for (const state of this.nodeStates.values()) {
      if (state.offline_deadline_ms !== null) {
        const deadline = Math.max(Date.now() + 50, state.offline_deadline_ms);
        if (earliestMs === null || deadline < earliestMs) {
          earliestMs = deadline;
        }
      }
      if (state.online === 1) {
        hasOnline = true;
      }
    }

    if (hasOnline) {
      const safetyAt = Date.now() + SAFETY_ALARM_MS;
      if (earliestMs === null || safetyAt < earliestMs) {
        earliestMs = safetyAt;
      }
    }

    if (earliestMs === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(earliestMs);
  }

  private getRulesForNode(nodeId: string): AlertRule[] {
    const rules: AlertRule[] = [];
    for (const row of this.rulesMirror.values()) {
      if (row.enabled === 1 && (row.node_id === null || row.node_id === nodeId)) {
        rules.push(rowToAlertRule(row));
      }
    }
    return rules;
  }

  private getEnabledChannelsMap(): Map<string, NotificationChannel> {
    const map = new Map<string, NotificationChannel>();
    for (const row of this.channelsMirror.values()) {
      if (row.enabled === 1) {
        const ch = rowToNotificationChannel(row);
        map.set(ch.id, ch);
      }
    }
    return map;
  }

  private countLocalFiringAlerts(): number {
    let count = 0;
    for (const rs of this.ruleStates.values()) {
      if (rs.state === "FIRING") {
        count += 1;
      }
    }
    return count;
  }

  private async resolveOfflineRulesIfFiring(node: NodeRow, nowSec: number): Promise<void> {
    const firingOffline: StoredAlertRuleState[] = [];
    for (const [key, rs] of this.ruleStates.entries()) {
      if (key.startsWith(`${node.id}:`) && rs.metric === "offline" && rs.state === "FIRING") {
        firingOffline.push(rs);
      }
    }
    if (firingOffline.length === 0) {
      return;
    }

    const channelsById = this.getEnabledChannelsMap();
    for (const prev of firingOffline) {
      const ruleRow = this.rulesMirror.get(prev.rule_id);
      const next: StoredAlertRuleState = {
        rule_id: prev.rule_id,
        metric: "offline",
        state: "OK",
        first_breach_ts: null,
        last_notified_ts: null,
        recover_ok_count: 0,
        incident_id: null,
        started_at: null,
      };
      this.ruleStates.set(ruleStateKey(node.id, prev.rule_id), next);
      this.persistRuleStateSql(node.id, next);

      if (prev.incident_id) {
        await recordIncidentResolved(this.env.DB, prev.incident_id, nowSec);
      }
      if (ruleRow) {
        const rule = rowToAlertRule(ruleRow);
        const outageDuration = prev.started_at !== null ? Math.max(0, nowSec - prev.started_at) : 0;
        await notifyChannels(
          channelsById,
          rule.channel_ids,
          {
            kind: "resolved",
            nodeId: node.id,
            nodeName: node.name,
            groupName: node.group_name,
            ruleId: rule.id,
            ruleName: rule.name,
            metric: rule.metric,
            operator: rule.operator,
            valueText: "Online",
            thresholdText: formatRuleThresholdText(rule.metric, rule.threshold),
            durationSec: outageDuration,
            triggerValue: 0,
            threshold: rule.threshold,
            timestampSec: nowSec,
          },
          node.mute_until,
        );
        this.broadcastMessage({
          t: "alert_change",
          activeAlertsCount: this.countLocalFiringAlerts(),
        } satisfies AlertChangeMessage);
      }
    }
  }

  private async fireOfflineRules(
    node: NodeRow,
    state: PersistedNodeState,
    nowSec: number,
  ): Promise<void> {
    const rules = this.getRulesForNode(node.id).filter((r) => r.metric === "offline");
    if (rules.length === 0) {
      return;
    }
    const channelsById = this.getEnabledChannelsMap();
    const downSec = state.last_seen_ts ? Math.max(0, nowSec - state.last_seen_ts) : OFFLINE_THRESHOLD_SEC;

    for (const rule of rules) {
      const key = ruleStateKey(node.id, rule.id);
      const prev = this.ruleStates.get(key);
      if (prev?.state === "FIRING") {
        continue;
      }

      const incidentId = generateId("inc");
      const next: StoredAlertRuleState = {
        rule_id: rule.id,
        metric: "offline",
        state: "FIRING",
        first_breach_ts: prev?.first_breach_ts ?? nowSec,
        last_notified_ts: nowSec,
        recover_ok_count: 0,
        incident_id: incidentId,
        started_at: nowSec,
      };
      this.ruleStates.set(key, next);
      this.persistRuleStateSql(node.id, next);

      await recordIncidentFiring(this.env.DB, {
        incidentId,
        nodeId: node.id,
        nodeName: node.name,
        ruleId: rule.id,
        metric: rule.metric,
        triggerValue: downSec,
        threshold: rule.threshold,
        message: `${rule.name}: offline for ${downSec}s`,
        startedAt: nowSec,
      });

      await notifyChannels(
        channelsById,
        rule.channel_ids,
        {
          kind: "firing",
          nodeId: node.id,
          nodeName: node.name,
          groupName: node.group_name,
          ruleId: rule.id,
          ruleName: rule.name,
          metric: rule.metric,
          operator: rule.operator,
          valueText: `Offline (${downSec}s)`,
          thresholdText: formatRuleThresholdText(rule.metric, rule.threshold),
          durationSec: rule.duration_sec,
          triggerValue: downSec,
          threshold: rule.threshold,
          timestampSec: nowSec,
        },
        node.mute_until,
      );

      this.broadcastMessage({
        t: "alert_change",
        activeAlertsCount: this.countLocalFiringAlerts(),
      } satisfies AlertChangeMessage);
    }
  }

  private async evaluateNodeMetricRules(
    node: NodeRow,
    state: PersistedNodeState,
    payload: NodeMetricsPayload,
    traffic: NodeTrafficSummary,
    nowSec: number,
  ): Promise<void> {
    const rules = this.getRulesForNode(node.id).filter((r) => r.metric !== "offline");
    if (rules.length === 0) {
      return;
    }

    const hw = this.resolveHardware(node, state);
    const evalCtx: AlertEvaluationContext = {
      nodeId: node.id,
      nodeName: node.name,
      groupName: node.group_name,
      muteUntil: node.mute_until,
      memTotalBytes: hw?.mem_total ?? node.mem_total ?? null,
      swapTotalBytes: hw?.swap_total ?? node.swap_total ?? null,
      traffic,
      metrics: payload,
      nowSec,
    };

    let channelsById: Map<string, NotificationChannel> | null = null;

    for (const rule of rules) {
      const reading = extractMetricReading(rule.metric, evalCtx);
      if (!reading) {
        continue;
      }

      const key = ruleStateKey(node.id, rule.id);
      const prev = this.ruleStates.get(key);
      const step = evaluateRuleStep(rule, prev, reading.value, nowSec);

      if (step.changed) {
        const nextStored: StoredAlertRuleState = {
          ...step.nextState,
          metric: rule.metric,
        };
        this.ruleStates.set(key, nextStored);
        this.persistRuleStateSql(node.id, nextStored);
      }

      if (step.action === "none") {
        continue;
      }

      channelsById ??= this.getEnabledChannelsMap();

      if (step.action === "fire") {
        const incidentId = step.incidentId ?? generateId("inc");
        await recordIncidentFiring(this.env.DB, {
          incidentId,
          nodeId: node.id,
          nodeName: node.name,
          ruleId: rule.id,
          metric: rule.metric,
          triggerValue: reading.value,
          threshold: rule.threshold,
          message: `${rule.name}: ${reading.valueText}`,
          startedAt: nowSec,
        });
        await notifyChannels(
          channelsById,
          rule.channel_ids,
          {
            kind: "firing",
            nodeId: node.id,
            nodeName: node.name,
            groupName: node.group_name,
            ruleId: rule.id,
            ruleName: rule.name,
            metric: rule.metric,
            operator: rule.operator,
            valueText: reading.valueText,
            valueDetail: reading.valueDetail,
            thresholdText: formatRuleThresholdText(rule.metric, rule.threshold),
            durationSec: rule.duration_sec,
            triggerValue: reading.value,
            threshold: rule.threshold,
            timestampSec: nowSec,
          },
          node.mute_until,
        );
        this.broadcastMessage({
          t: "alert_change",
          activeAlertsCount: this.countLocalFiringAlerts(),
        } satisfies AlertChangeMessage);
      } else if (step.action === "renotify") {
        const incidentId = step.incidentId ?? prev?.incident_id;
        if (incidentId) {
          await recordIncidentRenotify(this.env.DB, incidentId, nowSec);
        }
        await notifyChannels(
          channelsById,
          rule.channel_ids,
          {
            kind: "firing",
            nodeId: node.id,
            nodeName: node.name,
            groupName: node.group_name,
            ruleId: rule.id,
            ruleName: rule.name,
            metric: rule.metric,
            operator: rule.operator,
            valueText: reading.valueText,
            valueDetail: reading.valueDetail,
            thresholdText: formatRuleThresholdText(rule.metric, rule.threshold),
            durationSec: rule.duration_sec,
            triggerValue: reading.value,
            threshold: rule.threshold,
            timestampSec: nowSec,
          },
          node.mute_until,
        );
      } else if (step.action === "resolve") {
        const incidentId = step.incidentId ?? prev?.incident_id;
        if (incidentId) {
          await recordIncidentResolved(this.env.DB, incidentId, nowSec);
        }
        await notifyChannels(
          channelsById,
          rule.channel_ids,
          {
            kind: "resolved",
            nodeId: node.id,
            nodeName: node.name,
            groupName: node.group_name,
            ruleId: rule.id,
            ruleName: rule.name,
            metric: rule.metric,
            operator: rule.operator,
            valueText: reading.valueText,
            valueDetail: reading.valueDetail,
            thresholdText: formatRuleThresholdText(rule.metric, rule.threshold),
            durationSec: step.resolvedDurationSec ?? rule.duration_sec,
            triggerValue: reading.value,
            threshold: rule.threshold,
            timestampSec: nowSec,
          },
          node.mute_until,
        );
        this.broadcastMessage({
          t: "alert_change",
          activeAlertsCount: this.countLocalFiringAlerts(),
        } satisfies AlertChangeMessage);
      }
    }
  }

  private resolveFlushWaiters(nodeId: string): void {
    const waiters = this.flushWaiters.get(nodeId);
    if (!waiters || waiters.length === 0) {
      return;
    }
    this.flushWaiters.delete(nodeId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private waitForFlush(nodeId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        const list = this.flushWaiters.get(nodeId);
        if (list) {
          const next = list.filter((fn) => fn !== finish);
          if (next.length > 0) {
            this.flushWaiters.set(nodeId, next);
          } else {
            this.flushWaiters.delete(nodeId);
          }
        }
        finish();
      }, timeoutMs);

      const list = this.flushWaiters.get(nodeId) ?? [];
      list.push(finish);
      this.flushWaiters.set(nodeId, list);
    });
  }

  // ---- Legacy NodeDO Compatibility Push Hooks ----

  async pushFleetTick(msg: FleetTickMessage): Promise<void> {
    this.broadcastMessage(msg);
  }

  async pushNodeDetail(msg: NodeDetailMessage): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const client of this.ctx.getWebSockets("client")) {
      const att = this.readClientAttachment(client);
      if (att && (att.exp ?? 0) > nowSec && att.nodeId === msg.nodeId) {
        sendJsonSafe(client, msg);
      }
    }
  }

  async pushNodeOffline(msg: NodeOfflineMessage): Promise<void> {
    this.broadcastMessage(msg);
  }

  async pushAlertChange(msg: AlertChangeMessage): Promise<void> {
    this.broadcastMessage(msg);
  }

  // ---- RPC Methods Called by index.ts ----

  async getNetworkQualityConfig(nodeId?: string) {
    await this.ensureMirrorSeeded();
    return this.networkQuality.configResponse(nodeId);
  }

  async saveNetworkQualityConfig(value: unknown, nodeId?: string) {
    await this.ensureMirrorSeeded();
    await this.networkQuality.saveConfig(value, nodeId);
    this.pushNetworkQualityConfig(nodeId);
    return this.networkQuality.configResponse(nodeId);
  }

  async refreshNetworkQualitySettings(): Promise<void> {
    await this.networkQuality.reloadSettings();
    this.pushNetworkQualityConfig();
  }

  private pushNetworkQualityConfig(nodeId?: string): void {
    const now = Math.floor(Date.now()/1000);
    for (const sock of this.ctx.getWebSockets("agent")) {
      const att = this.readAgentAttachment(sock);
      if (att && (!nodeId || att.nodeId === nodeId) && att.caps?.includes("network_quality_v1") && isSocketOpen(sock)) {
        this.sendAgentCtrl(sock, this.computeCtrlForNode(att.nodeId, att.ver, now));
      }
    }
  }

  async queryNetworkQuality(nodeId: string, range: string, cursor?: string) {
    await this.ensureMirrorSeeded();
    const state = this.networkQuality.state(nodeId);
    const newest = state.latest.reduce((v,p) => Math.max(v,p.measured_at),0);
    if (!cursor && state.supported && this.networkQuality.control(nodeId).enabled && Math.floor(Date.now()/1000)-newest > STALE_COHORT_FLUSH_SEC) {
      const sock = this.ctx.getWebSockets(`agent:${nodeId}`).find(isSocketOpen);
      const att = sock ? this.readAgentAttachment(sock) : null;
      if (sock && att?.mode === 0) {
        this.sendAgentCtrl(sock,{...this.computeCtrlForNode(nodeId,att.ver,Math.floor(Date.now()/1000)),flush_now:true});
        await this.waitForFlush(nodeId,FLUSH_NOW_WAIT_MS);
      }
    }
    try { return this.networkQuality.query(nodeId,range,cursor); }
    catch (e) {
      // Expected client validation errors should not surface as uncaught RPC
      // exceptions in Durable Object logs.
      if (e instanceof Error && e.message.includes("cursor")) return { error: e.message };
      throw e;
    }
  }

  async getFleetSnapshot(): Promise<Record<string, NodeSnapshot>> {
    await this.ensureMirrorSeeded();
    const out: Record<string, NodeSnapshot> = {};
    for (const nodeId of this.nodesMirror.keys()) {
      out[nodeId] = this.buildNodeSnapshot(nodeId);
    }
    return out;
  }

  async getNodeSnapshot(nodeId: string): Promise<NodeSnapshot> {
    await this.ensureMirrorSeeded();
    await this.ensureNodeMirrored(nodeId);
    return this.buildNodeSnapshot(nodeId);
  }

  async queryMetrics(nodeId: string, range: MetricRange): Promise<MetricsQueryResponse> {
    await this.ensureMirrorSeeded();
    const nowSec = Math.floor(Date.now() / 1000);
    const state = this.nodeStates.get(nodeId);

    if (
      state &&
      state.online === 1 &&
      nowSec - state.last_raw_ts > STALE_COHORT_FLUSH_SEC
    ) {
      const openAgent = this.ctx
        .getWebSockets(`agent:${nodeId}`)
        .find((sock) => isSocketOpen(sock));
      const att = openAgent ? this.readAgentAttachment(openAgent) : null;
      if (openAgent && att && att.ver >= 2 && att.mode === 0) {
        const ctrl = this.computeCtrlForNode(nodeId, att.ver, nowSec);
        ctrl.flush_now = true;
        this.sendAgentCtrl(openAgent, ctrl);
        await this.waitForFlush(nodeId, FLUSH_NOW_WAIT_MS);
      }
    }

    if (range === "1h") {
      const fromTs = nowSec - 3600;
      const minBucket = chunkBucketTs(fromTs, RAW_CHUNK_SEC);
      const rows = this.sql
        .exec<ChunkSqlRow>(
          "SELECT slot, bucket_ts, payload FROM metrics_chunk_10m WHERE node_id = ? AND bucket_ts >= ?",
          nodeId,
          minBucket,
        )
        .toArray();
      const points: MetricsQueryPoint[] = [];
      for (const row of rows) {
        for (const p of decodeRawChunk(row.payload)) {
          if (p.ts >= fromTs) {
            points.push(rawPointToQueryPoint(p));
          }
        }
      }
      points.sort((a, b) => a.ts - b.ts);
      return { node_id: nodeId, range, resolution: "30s", points };
    }

    if (range === "1y") {
      const fromTs = nowSec - 366 * 86400;
      const minBucket = chunkBucketTs(fromTs, CHUNK_1H_SEC);
      const rows = this.sql
        .exec<ChunkSqlRow>(
          "SELECT slot, bucket_ts, payload FROM metrics_1h_chunk_1d WHERE node_id = ? AND bucket_ts >= ?",
          nodeId,
          minBucket,
        )
        .toArray();
      const rollups: RollupSlabPoint[] = [];
      for (const row of rows) {
        for (const p of decodeRollupChunk(row.payload)) {
          if (p.ts >= fromTs) {
            rollups.push(p);
          }
        }
      }
      if (state?.welford_1h && state.welford_1h.bucket_ts >= fromTs) {
        const active = finalizeWelford(state.welford_1h);
        if (!rollups.some((p) => p.ts === active.ts)) {
          rollups.push(active);
        }
      }
      rollups.sort((a, b) => a.ts - b.ts);
      return {
        node_id: nodeId,
        range,
        resolution: "1h",
        points: rollups.map(rollupPointToQueryPoint),
      };
    }

    const windowSec =
      range === "24h" ? 86400 : range === "7d" ? 7 * 86400 : 30 * 86400;
    const fromTs = nowSec - windowSec;
    const minBucket = chunkBucketTs(fromTs, CHUNK_5M_SEC);
    const rows = this.sql
      .exec<ChunkSqlRow>(
        "SELECT slot, bucket_ts, payload FROM metrics_5m_chunk_1h WHERE node_id = ? AND bucket_ts >= ?",
        nodeId,
        minBucket,
      )
      .toArray();
    const rollups: RollupSlabPoint[] = [];
    for (const row of rows) {
      for (const p of decodeRollupChunk(row.payload)) {
        if (p.ts >= fromTs) {
          rollups.push(p);
        }
      }
    }
    if (state?.welford_5m && state.welford_5m.bucket_ts >= fromTs) {
      const active = finalizeWelford(state.welford_5m);
      if (!rollups.some((p) => p.ts === active.ts)) {
        rollups.push(active);
      }
    }
    rollups.sort((a, b) => a.ts - b.ts);
    return {
      node_id: nodeId,
      range,
      resolution: "5m",
      points: rollups.map(rollupPointToQueryPoint),
    };
  }

  async syncNodeConfig(node: NodeRow): Promise<void> {
    await this.ensureMirrorSeeded();
    const existingState = this.nodeStates.get(node.id);
    if (existingState?.hw) {
      node = {
        ...node,
        hostname: node.hostname ?? existingState.hw.hostname,
        os: node.os ?? existingState.hw.os,
        kernel: node.kernel ?? existingState.hw.kernel,
        arch: node.arch ?? existingState.hw.arch,
        cpu_model: node.cpu_model ?? existingState.hw.cpu_model,
        cpu_cores: node.cpu_cores ?? existingState.hw.cpu_cores,
        mem_total: node.mem_total ?? existingState.hw.mem_total,
        swap_total: node.swap_total ?? existingState.hw.swap_total,
        agent_version: node.agent_version ?? existingState.hw.agent_version,
      };
    }
    const prevNode = this.nodesMirror.get(node.id);
    this.nodesMirror.set(node.id, node);
    this.upsertNodeMirrorSql(node);
    this.maybeBroadcastFleetTick(node.id);
    if (
      node.auto_update_override !== 0 &&
      (node.auto_update_override === 1 || prevNode?.auto_update_override === 0)
    ) {
      const sock = this.ctx.getWebSockets(`agent:${node.id}`).find(isSocketOpen);
      const att = sock ? this.readAgentAttachment(sock) : null;
      const state = this.nodeStates.get(node.id);
      if (sock && att && state) {
        await this.maybeAutoDispatchUpdate(
          sock,
          att,
          node,
          state,
          Math.floor(Date.now() / 1000),
        );
      }
    }
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.ensureMirrorSeeded();

    for (const sock of this.ctx.getWebSockets(`agent:${nodeId}`)) {
      try {
        sock.close(WS_CLOSE_SUPERSEDED, "Node deleted");
      } catch {
        // Ignore already-closed sockets.
      }
    }

    this.nodesMirror.delete(nodeId);
    this.nodeStates.delete(nodeId);
    this.dirtyNodeStates.delete(nodeId);
    this.liveProcs.delete(nodeId);

    let hadFiring = false;
    for (const key of Array.from(this.ruleStates.keys())) {
      if (key.startsWith(`${nodeId}:`)) {
        if (this.ruleStates.get(key)?.state === "FIRING") {
          hadFiring = true;
        }
        this.ruleStates.delete(key);
      }
    }

    this.ctx.storage.transactionSync(() => {
      this.networkQuality.removeNode(nodeId);
      this.sql.exec("DELETE FROM nodes_mirror WHERE id = ?", nodeId);
      this.sql.exec("DELETE FROM node_state WHERE node_id = ?", nodeId);
      this.sql.exec("DELETE FROM alert_rule_states WHERE node_id = ?", nodeId);
      this.sql.exec("DELETE FROM metrics_chunk_10m WHERE node_id = ?", nodeId);
      this.sql.exec("DELETE FROM metrics_5m_chunk_1h WHERE node_id = ?", nodeId);
      this.sql.exec("DELETE FROM metrics_1h_chunk_1d WHERE node_id = ?", nodeId);
    });

    if (hadFiring) {
      this.broadcastMessage({
        t: "alert_change",
        activeAlertsCount: this.countLocalFiringAlerts(),
      } satisfies AlertChangeMessage);
    }

    await this.scheduleNextAlarm();
  }

  async disconnectAgent(nodeId: string, reason = "Token rotated"): Promise<void> {
    await this.ensureMirrorSeeded();
    for (const sock of this.ctx.getWebSockets(`agent:${nodeId}`)) {
      try {
        sock.close(4001, reason);
      } catch {
        // Ignore closing errors.
      }
    }
  }

  async refreshRulesAndChannels(
    rules: AlertRuleRow[],
    channels: NotificationChannelRow[],
  ): Promise<void> {
    await this.ensureMirrorSeeded();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM alert_rules_mirror");
      this.sql.exec("DELETE FROM channels_mirror");
      this.rulesMirror.clear();
      this.channelsMirror.clear();

      for (const rule of rules) {
        this.upsertRuleMirrorSql(rule);
        this.rulesMirror.set(rule.id, rule);
      }
      for (const ch of channels) {
        this.upsertChannelMirrorSql(ch);
        this.channelsMirror.set(ch.id, ch);
      }
    });

    const nowSec = Math.floor(Date.now() / 1000);
    for (const sock of this.ctx.getWebSockets("agent")) {
      if (!isSocketOpen(sock)) {
        continue;
      }
      const att = this.readAgentAttachment(sock);
      if (att && att.ver >= 2 && att.mode === 0) {
        this.sendAgentCtrl(sock, this.computeCtrlForNode(att.nodeId, att.ver, nowSec));
      }
    }
  }

  async applyImportedBundle(input: {
    nodes: NodeRow[];
    rules: AlertRuleRow[];
    channels: NotificationChannelRow[];
    trafficLedgers: ExportTrafficLedgerEntry[];
  }): Promise<void> {
    await this.ensureMirrorSeeded();

    this.ctx.storage.transactionSync(() => {
      for (const node of input.nodes) {
        this.nodesMirror.set(node.id, node);
        this.upsertNodeMirrorSql(node);
      }

      this.sql.exec("DELETE FROM alert_rules_mirror");
      this.rulesMirror.clear();
      for (const rule of input.rules) {
        this.upsertRuleMirrorSql(rule);
        this.rulesMirror.set(rule.id, rule);
      }

      this.sql.exec("DELETE FROM channels_mirror");
      this.channelsMirror.clear();
      for (const ch of input.channels) {
        this.upsertChannelMirrorSql(ch);
        this.channelsMirror.set(ch.id, ch);
      }

      for (const entry of input.trafficLedgers) {
        const state = this.getOrCreateNodeState(entry.node_id);
        state.cycle_key = entry.cycle_key;
        state.last_agent_rx = entry.last_agent_rx;
        state.last_agent_tx = entry.last_agent_tx;
        state.cycle_rx_bytes = entry.cycle_rx_bytes;
        state.cycle_tx_bytes = entry.cycle_tx_bytes;
        state.traffic_updated_at = entry.updated_at;
        this.persistNodeStateSql(state);
      }
    });
  }

  async getExportData(): Promise<{
    nodes: NodeRow[];
    trafficLedgers: ExportTrafficLedgerEntry[];
  }> {
    await this.ensureMirrorSeeded();
    const nodes = Array.from(this.nodesMirror.values());
    const trafficLedgers: ExportTrafficLedgerEntry[] = [];
    for (const state of this.nodeStates.values()) {
      if (
        state.cycle_key !== null ||
        state.cycle_rx_bytes > 0 ||
        state.cycle_tx_bytes > 0
      ) {
        trafficLedgers.push({
          node_id: state.node_id,
          cycle_key: state.cycle_key ?? "",
          last_agent_rx: state.last_agent_rx ?? 0,
          last_agent_tx: state.last_agent_tx ?? 0,
          cycle_rx_bytes: state.cycle_rx_bytes,
          cycle_tx_bytes: state.cycle_tx_bytes,
          updated_at: state.traffic_updated_at || (state.last_seen_ts ?? 0),
        });
      }
    }
    return { nodes, trafficLedgers };
  }

  async getHubStats(): Promise<{
    connectedAgents: number;
    connectedClients: number;
    totalNodes: number;
    doStorageBytes: number | null;
    scchEstimates: FleetScchEstimates;
  }> {
    await Promise.all([
      this.ensureMirrorSeeded(),
      this.networkQuality.ensureReady(),
    ]);
    const onlineAgents = new Set<string>();
    for (const sock of this.ctx.getWebSockets("agent")) {
      if (isSocketOpen(sock)) {
        const att = this.readAgentAttachment(sock);
        if (att) {
          onlineAgents.add(att.nodeId);
        }
      }
    }
    const rawDbSize = this.sql.databaseSize;
    const doStorageBytes =
      typeof rawDbSize === "number" && Number.isFinite(rawDbSize)
        ? rawDbSize
        : null;

    const nqControls: FleetNqQuotaControl[] = [];
    for (const nodeId of this.nodesMirror.keys()) {
      const ctrl = this.networkQuality.control(nodeId);
      nqControls.push({
        enabled: Boolean(ctrl.enabled),
        intervalSec: ctrl.interval_sec ?? 20,
        targetCount: Array.isArray(ctrl.targets) ? ctrl.targets.length : 0,
      });
    }

    return {
      connectedAgents: onlineAgents.size,
      connectedClients: this.ctx.getWebSockets("client").filter(isSocketOpen).length,
      totalNodes: this.nodesMirror.size,
      doStorageBytes,
      scchEstimates: computeFleetScchEstimates(this.nodesMirror.size, nqControls),
    };
  }

  async dispatchMigration(targets: MigrateTargetSpec[]): Promise<MigrateDispatchResult> {
    await this.ensureMirrorSeeded();
    const nowSec = Math.floor(Date.now() / 1000);
    const dispatched: string[] = [];
    const skipped_offline: Array<{ node_id: string; reason: string }> = [];

    for (const target of targets) {
      const openSocket = this.ctx
        .getWebSockets(`agent:${target.nodeId}`)
        .find((sock) => isSocketOpen(sock));
      if (!openSocket) {
        skipped_offline.push({ node_id: target.nodeId, reason: "offline" });
        continue;
      }
      const att = this.readAgentAttachment(openSocket);
      const ctrl = this.computeCtrlForNode(target.nodeId, att?.ver ?? 2, nowSec);
      ctrl.migrate = {
        url: target.url,
        ...(target.fallbackUrl ? { fallback_url: target.fallbackUrl } : {}),
        epoch: target.epoch,
        sig: target.sig,
      };
      this.sendAgentCtrl(openSocket, ctrl);
      dispatched.push(target.nodeId);
    }

    return { dispatched, skipped_offline };
  }

  private applyMetricsUpdateStatus(
    state: PersistedNodeState,
    rawUpd: unknown,
    nowSec: number,
  ): boolean {
    if (rawUpd === undefined || rawUpd === null) {
      return false;
    }
    const parsed = parseAgentUpdateStatus(rawUpd, nowSec);
    if (!parsed) {
      return false;
    }
    const prev = state.update_status;
    if (
      prev &&
      prev.state === parsed.state &&
      prev.target_version === parsed.target_version &&
      prev.error === parsed.error
    ) {
      return false;
    }
    state.update_status = parsed;
    return true;
  }

  private async loadAgentUpdateConfigCached(
    nowSec: number,
  ): Promise<AgentUpdateConfig> {
    if (
      this.agentUpdateConfigCache &&
      nowSec - this.agentUpdateConfigCache.loadedAt < 60
    ) {
      return this.agentUpdateConfigCache.config;
    }
    const config = await getAgentUpdateConfig(this.env.DB);
    this.agentUpdateConfigCache = { config, loadedAt: nowSec };
    return config;
  }

  private async getOrCheckLatestRelease(
    config: AgentUpdateConfig,
    nowSec: number,
  ): Promise<AgentLatestRelease | null> {
    const origin = this.lastRequestOrigin ?? "";
    const key = `${config.channel}|${config.custom_base_url}|${this.env.GITHUB_REPO ?? ""}|${config.channel === "stable" ? origin : ""}`;
    const ttl = Math.max(
      60,
      Math.min(config.check_interval_sec, RELEASE_CACHE_TTL_SEC),
    );
    if (
      this.agentReleaseCache &&
      this.agentReleaseCache.key === key &&
      nowSec - this.agentReleaseCache.checkedAt < ttl
    ) {
      return this.agentReleaseCache.release;
    }
    if (!this.inFlightReleaseCheck) {
      this.inFlightReleaseCheck = checkLatestAgentRelease(this.env, config, {
        requestOrigin: this.lastRequestOrigin ?? undefined,
        nowSec,
      })
        .then((res) => {
          this.agentReleaseCache = {
            release: res.release,
            checkedAt: res.checked_at,
            key,
          };
          return res.release;
        })
        .finally(() => {
          this.inFlightReleaseCheck = null;
        });
    }
    return this.inFlightReleaseCheck;
  }

  private async sendSignedUpdateCtrl(
    ws: WebSocket,
    att: AgentWsAttachment,
    node: NodeRow,
    release: AgentLatestRelease,
    asset: { url: string; fallback_url?: string; sha256: string },
    nowSec: number,
  ): Promise<void> {
    const ctrl = this.computeCtrlForNode(node.id, att.ver, nowSec);
    ctrl.update = await signUpdateDirective(node.id, node.token_sha256, {
      version: release.version,
      sha256: asset.sha256,
      url: asset.url,
      fallback_url: asset.fallback_url,
      issued_at: nowSec,
    });
    this.sendAgentCtrl(ws, ctrl);
    this.lastUpdateDispatchByNode.set(node.id, {
      version: release.version,
      ts: nowSec,
    });
  }

  private async resolveAutoUpdateDirective(
    att: AgentWsAttachment,
    node: NodeRow,
    state: PersistedNodeState,
    nowSec: number,
  ): Promise<CtrlUpdateDirective | undefined> {
    const caps = att.caps.length > 0 ? att.caps : state.caps;
    if (!caps.includes("auto_update_v1") || node.auto_update_override === 0) {
      return undefined;
    }
    if (!normalizeAgentArch(state.hw?.arch ?? node.arch)) {
      return undefined;
    }
    const config = await this.loadAgentUpdateConfigCached(nowSec);
    const overrideBool = decodeAutoUpdateOverride(node.auto_update_override);
    if (
      !(
        overrideBool === true ||
        (overrideBool === null && config.auto_update_enabled)
      )
    ) {
      return undefined;
    }
    const release = await this.getOrCheckLatestRelease(config, nowSec);
    if (!release) {
      return undefined;
    }
    const lastAttempt = this.lastUpdateDispatchByNode.get(node.id);
    if (
      lastAttempt &&
      lastAttempt.version === release.version &&
      nowSec - lastAttempt.ts < 600
    ) {
      return undefined;
    }
    const check = isNodeEligibleForUpdate({
      capabilities: caps,
      arch: state.hw?.arch ?? node.arch,
      agentVersion: state.hw?.agent_version ?? node.agent_version,
      autoUpdateOverride: overrideBool,
      updateStatus: state.update_status,
      config,
      release,
      nowSec,
    });
    if (!check.eligible || !check.asset) {
      return undefined;
    }
    return signUpdateDirective(node.id, node.token_sha256, {
      version: release.version,
      sha256: check.asset.sha256,
      url: check.asset.url,
      fallback_url: check.asset.fallback_url,
      issued_at: nowSec,
    });
  }

  private async maybeAutoDispatchUpdate(
    ws: WebSocket,
    att: AgentWsAttachment,
    node: NodeRow,
    state: PersistedNodeState,
    nowSec: number,
  ): Promise<void> {
    const directive = await this.resolveAutoUpdateDirective(att, node, state, nowSec);
    if (!directive) {
      return;
    }
    const ctrl = this.computeCtrlForNode(node.id, att.ver, nowSec);
    ctrl.update = directive;
    this.sendAgentCtrl(ws, ctrl);
    this.lastUpdateDispatchByNode.set(node.id, {
      version: directive.version,
      ts: nowSec,
    });
  }

  async syncAgentUpdateState(params: {
    config: AgentUpdateConfig;
    origin?: string;
    release?: AgentLatestRelease | null;
    clearReleaseCache?: boolean;
  }): Promise<void> {
    await this.ensureMirrorSeeded();
    const nowSec = Math.floor(Date.now() / 1000);
    this.rememberOriginString(params.origin);
    this.agentUpdateConfigCache = { config: params.config, loadedAt: nowSec };
    if (params.clearReleaseCache) {
      this.agentReleaseCache = null;
      await clearCachedAgentRelease(this.env.DB);
    }
    if (params.release !== undefined) {
      const origin = this.lastRequestOrigin ?? "";
      const key = `${params.config.channel}|${params.config.custom_base_url}|${this.env.GITHUB_REPO ?? ""}|${params.config.channel === "stable" ? origin : ""}`;
      this.agentReleaseCache = {
        release: params.release,
        checkedAt: params.release?.checked_at ?? nowSec,
        key,
      };
    }

    for (const sock of this.ctx.getWebSockets("agent")) {
      if (!isSocketOpen(sock)) continue;
      const att = this.readAgentAttachment(sock);
      if (!att) continue;
      const node = this.nodesMirror.get(att.nodeId);
      const state = this.nodeStates.get(att.nodeId);
      if (node && state) {
        await this.maybeAutoDispatchUpdate(sock, att, node, state, nowSec);
      }
    }
  }

  async triggerAgentUpdates(params: {
    release: AgentLatestRelease;
    config: AgentUpdateConfig;
    nodeIds?: string[];
    force?: boolean;
    origin?: string;
  }): Promise<{
    version: string;
    targeted: number;
    dispatched: number;
    skipped: number;
  }> {
    await this.ensureMirrorSeeded();
    const nowSec = Math.floor(Date.now() / 1000);
    this.rememberOriginString(params.origin);
    const targetIds = params.nodeIds ?? Array.from(this.nodesMirror.keys());
    let dispatched = 0;
    let skipped = 0;

    for (const nodeId of targetIds) {
      const node = await this.ensureNodeMirrored(nodeId);
      const sock = this.ctx
        .getWebSockets(`agent:${nodeId}`)
        .find((s) => isSocketOpen(s));
      const att = sock ? this.readAgentAttachment(sock) : null;
      const state = this.nodeStates.get(nodeId);
      if (!node || !sock || !att) {
        skipped++;
        continue;
      }
      const caps = att.caps.length > 0 ? att.caps : (state?.caps ?? []);
      if (!caps.includes("auto_update_v1")) {
        skipped++;
        continue;
      }
      const arch = normalizeAgentArch(state?.hw?.arch ?? node.arch);
      const asset = arch ? params.release.assets[arch] : undefined;
      if (!asset) {
        skipped++;
        continue;
      }
      const agentVersion = state?.hw?.agent_version ?? node.agent_version;
      if (!params.force) {
        if (node.auto_update_override === 0) {
          skipped++;
          continue;
        }
        if (!isNewerAgentVersion(params.release.version, agentVersion)) {
          skipped++;
          continue;
        }
      }
      await this.sendSignedUpdateCtrl(
        sock,
        att,
        node,
        params.release,
        asset,
        nowSec,
      );
      dispatched++;
    }

    return {
      version: params.release.version,
      targeted: targetIds.length,
      dispatched,
      skipped,
    };
  }

  private readAnyAttachment(ws: WebSocket): AgentWsAttachment | ClientAttachment | null {
    try {
      const raw = ws.deserializeAttachment();
      if (!raw || typeof raw !== "object") {
        return null;
      }
      const obj = raw as { role?: unknown };
      if (obj.role === "agent") {
        return raw as AgentWsAttachment;
      }
      if (obj.role === "client" || "fleet" in obj) {
        return {
          role: "client",
          ...(raw as ClientAttachment),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private readAgentAttachment(ws: WebSocket): AgentWsAttachment | null {
    const att = this.readAnyAttachment(ws);
    return att?.role === "agent" ? att : null;
  }

  private readClientAttachment(ws: WebSocket): ClientAttachment | null {
    const att = this.readAnyAttachment(ws);
    return att && (att.role === "client" || "fleet" in att) ? (att as ClientAttachment) : null;
  }
}

function ruleStateKey(nodeId: string, ruleId: string): string {
  return `${nodeId}:${ruleId}`;
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isSocketOpen(ws: WebSocket): boolean {
  try {
    return ws.readyState === WebSocket.READY_STATE_OPEN;
  } catch {
    return true;
  }
}

function sendJsonSafe(ws: WebSocket, data: unknown): boolean {
  return sendRawSafe(ws, JSON.stringify(data));
}

function sendRawSafe(ws: WebSocket, payload: string): boolean {
  try {
    ws.send(payload);
    return true;
  } catch {
    // Socket closed mid-turn; webSocketClose handles cleanup.
    return false;
  }
}
