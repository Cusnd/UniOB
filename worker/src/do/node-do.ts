import { DurableObject } from "cloudflare:workers";
import {
  countFiringAlerts,
  evaluateRuleStep,
  extractMetricReading,
  formatRuleThresholdText,
  loadNodeRulesAndChannels,
  notifyChannels,
  recordIncidentFiring,
  recordIncidentRenotify,
  recordIncidentResolved,
  type AlertRuleRuntimeState,
} from "../alert/engine";
import type { FleetHubDO } from "./fleet-hub-do";
import {
  advanceTrafficLedger,
  computeCountedBytes,
  computeTrafficCycle,
  type TrafficLedgerRow,
} from "../traffic";
import type {
  AgentCtrlFrame,
  AgentHelloFrame,
  AgentMetricsFrame,
  AlertRule,
  Env,
  MetricRange,
  MetricResolution,
  MetricsQueryPoint,
  MetricsQueryResponse,
  NodeConfigSync,
  NodeHardwareInfo,
  NodeLeaseUpdate,
  NodeMetricsPayload,
  NodeRow,
  NodeSnapshot,
  NotificationChannel,
  SampleMode,
  TrafficCountMode,
} from "../types";

type NodeMetaRow = {
  id: number;
  node_id: string;
  name: string;
  group_name: string;
  traffic_limit_bytes: number | null;
  traffic_reset_day: number;
  traffic_count_mode: TrafficCountMode;
  mute_until: number | null;
  online: number;
  last_seen_ts: number | null;
  last_raw_write_ts: number;
  last_5m_bucket: number;
  last_1h_bucket: number;
  last_cleanup_ts: number;
  last_metrics_json: string | null;
  last_hello_json: string | null;
  fleet_watch_until: number;
  detail_watch_until: number;
  proc_watch_until: number;
  last_ctrl_mode: number;
  last_ctrl_sent_ms: number;
};

type RawMetricRow = {
  ts: number;
  cpu: number;
  steal: number;
  load1: number;
  mem_used: number;
  swap_used: number;
  disk_used: number;
  disk_r_bps: number;
  disk_w_bps: number;
  net_rx_bps: number;
  net_tx_bps: number;
  tcp_est: number;
};

type Metric5mRow = {
  ts: number;
  cpu_avg: number;
  cpu_max: number;
  steal_max: number;
  load1_avg: number;
  mem_avg: number;
  mem_max: number;
  disk_used: number;
  net_rx_avg: number;
  net_rx_max: number;
  net_tx_avg: number;
  net_tx_max: number;
};

type Metric1hRow = {
  ts: number;
  cpu_avg: number;
  cpu_max: number;
  mem_avg: number;
  mem_max: number;
  disk_used: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
};

const DEFAULT_OFFLINE_THRESHOLD_MS = 90_000;
const ALARM_SLACK_MS = 35_000;
const RULES_CACHE_TTL_MS = 300_000;
const RAW_RETENTION_SEC = 86_400;
const M5_RETENTION_SEC = 30 * 86_400;
const H1_RETENTION_SEC = 365 * 86_400;

export class NodeDO extends DurableObject<Env> {
  private meta: NodeMetaRow | null = null;
  private trafficRow: TrafficLedgerRow | null = null;
  private trafficDirty = false;
  private lastMetrics: NodeMetricsPayload | null = null;
  private lastHardware: NodeHardwareInfo | null = null;
  private ruleStates = new Map<string, AlertRuleRuntimeState>();
  private rulesCache: {
    rules: AlertRule[];
    channelsById: Map<string, NotificationChannel>;
    expiresAt: number;
  } | null = null;
  private destroyed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
      this.loadFromSqlite();
    });
  }

  private initSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metrics_raw (
        ts INTEGER PRIMARY KEY,
        cpu REAL NOT NULL,
        steal REAL NOT NULL,
        load1 REAL NOT NULL,
        mem_used INTEGER NOT NULL,
        swap_used INTEGER NOT NULL,
        disk_used INTEGER NOT NULL,
        disk_r_bps INTEGER NOT NULL,
        disk_w_bps INTEGER NOT NULL,
        net_rx_bps INTEGER NOT NULL,
        net_tx_bps INTEGER NOT NULL,
        tcp_est INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics_5m (
        ts INTEGER PRIMARY KEY,
        cpu_avg REAL NOT NULL,
        cpu_max REAL NOT NULL,
        steal_max REAL NOT NULL,
        load1_avg REAL NOT NULL,
        mem_avg INTEGER NOT NULL,
        mem_max INTEGER NOT NULL,
        disk_used INTEGER NOT NULL,
        net_rx_avg INTEGER NOT NULL,
        net_rx_max INTEGER NOT NULL,
        net_tx_avg INTEGER NOT NULL,
        net_tx_max INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics_1h (
        ts INTEGER PRIMARY KEY,
        cpu_avg REAL NOT NULL,
        cpu_max REAL NOT NULL,
        mem_avg INTEGER NOT NULL,
        mem_max INTEGER NOT NULL,
        disk_used INTEGER NOT NULL,
        net_rx_bytes INTEGER NOT NULL,
        net_tx_bytes INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS traffic_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cycle_key TEXT NOT NULL,
        last_agent_rx INTEGER NOT NULL,
        last_agent_tx INTEGER NOT NULL,
        cycle_rx_bytes INTEGER NOT NULL,
        cycle_tx_bytes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS node_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        node_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT 'Default',
        traffic_limit_bytes INTEGER DEFAULT NULL,
        traffic_reset_day INTEGER NOT NULL DEFAULT 1,
        traffic_count_mode TEXT NOT NULL DEFAULT 'both',
        mute_until INTEGER DEFAULT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen_ts INTEGER DEFAULT NULL,
        last_raw_write_ts INTEGER NOT NULL DEFAULT 0,
        last_5m_bucket INTEGER NOT NULL DEFAULT 0,
        last_1h_bucket INTEGER NOT NULL DEFAULT 0,
        last_cleanup_ts INTEGER NOT NULL DEFAULT 0,
        last_metrics_json TEXT DEFAULT NULL,
        last_hello_json TEXT DEFAULT NULL,
        fleet_watch_until INTEGER NOT NULL DEFAULT 0,
        detail_watch_until INTEGER NOT NULL DEFAULT 0,
        proc_watch_until INTEGER NOT NULL DEFAULT 0,
        last_ctrl_mode INTEGER NOT NULL DEFAULT 0,
        last_ctrl_sent_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS alert_rule_states (
        rule_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'OK',
        first_breach_ts INTEGER DEFAULT NULL,
        last_notified_ts INTEGER DEFAULT NULL,
        recover_ok_count INTEGER NOT NULL DEFAULT 0,
        incident_id TEXT DEFAULT NULL,
        started_at INTEGER DEFAULT NULL
      );
    `);
  }

  private loadFromSqlite(): void {
    const metaRows = this.ctx.storage.sql
      .exec<NodeMetaRow>("SELECT * FROM node_meta WHERE id = 1")
      .toArray();
    this.meta = metaRows[0] ?? null;

    if (this.meta?.last_metrics_json) {
      try {
        this.lastMetrics = JSON.parse(this.meta.last_metrics_json) as NodeMetricsPayload;
      } catch {
        this.lastMetrics = null;
      }
    }
    if (this.meta?.last_hello_json) {
      try {
        this.lastHardware = JSON.parse(this.meta.last_hello_json) as NodeHardwareInfo;
      } catch {
        this.lastHardware = null;
      }
    }

    const trafficRows = this.ctx.storage.sql
      .exec<TrafficLedgerRow>(
        "SELECT cycle_key, last_agent_rx, last_agent_tx, cycle_rx_bytes, cycle_tx_bytes, updated_at FROM traffic_state WHERE id = 1",
      )
      .toArray();
    this.trafficRow = trafficRows[0] ?? null;

    const stateRows = this.ctx.storage.sql
      .exec<AlertRuleRuntimeState>(
        "SELECT rule_id, state, first_breach_ts, last_notified_ts, recover_ok_count, incident_id, started_at FROM alert_rule_states",
      )
      .toArray();
    this.ruleStates.clear();
    for (const row of stateRows) {
      this.ruleStates.set(row.rule_id, row);
    }
  }

  private ensureMetaDefaults(nodeId: string): NodeMetaRow {
    if (this.meta) {
      return this.meta;
    }
    const created: NodeMetaRow = {
      id: 1,
      node_id: nodeId,
      name: nodeId,
      group_name: "Default",
      traffic_limit_bytes: null,
      traffic_reset_day: 1,
      traffic_count_mode: "both",
      mute_until: null,
      online: 0,
      last_seen_ts: null,
      last_raw_write_ts: 0,
      last_5m_bucket: 0,
      last_1h_bucket: 0,
      last_cleanup_ts: 0,
      last_metrics_json: null,
      last_hello_json: null,
      fleet_watch_until: 0,
      detail_watch_until: 0,
      proc_watch_until: 0,
      last_ctrl_mode: 0,
      last_ctrl_sent_ms: 0,
    };
    this.persistMetaRow(created);
    this.meta = created;
    return created;
  }

  private persistMetaRow(meta: NodeMetaRow): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO node_meta (
        id, node_id, name, group_name, traffic_limit_bytes, traffic_reset_day,
        traffic_count_mode, mute_until, online, last_seen_ts, last_raw_write_ts,
        last_5m_bucket, last_1h_bucket, last_cleanup_ts, last_metrics_json,
        last_hello_json, fleet_watch_until, detail_watch_until, proc_watch_until,
        last_ctrl_mode, last_ctrl_sent_ms
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      meta.node_id,
      meta.name,
      meta.group_name,
      meta.traffic_limit_bytes,
      meta.traffic_reset_day,
      meta.traffic_count_mode,
      meta.mute_until,
      meta.online,
      meta.last_seen_ts,
      meta.last_raw_write_ts,
      meta.last_5m_bucket,
      meta.last_1h_bucket,
      meta.last_cleanup_ts,
      meta.last_metrics_json,
      meta.last_hello_json,
      meta.fleet_watch_until,
      meta.detail_watch_until,
      meta.proc_watch_until,
      meta.last_ctrl_mode,
      meta.last_ctrl_sent_ms,
    );
  }

  private async hydrateMetaFromD1(nodeId: string): Promise<NodeMetaRow> {
    if (this.meta && this.meta.node_id === nodeId && this.meta.name !== "") {
      return this.meta;
    }
    const row = await this.env.DB.prepare(
      `SELECT id, name, group_name, traffic_limit_bytes, traffic_reset_day,
              traffic_count_mode, mute_until, hostname, os, kernel, arch,
              cpu_model, cpu_cores, mem_total, swap_total, agent_version, proc_enabled
       FROM nodes WHERE id = ?`,
    )
      .bind(nodeId)
      .first<NodeRow>();

    const meta = this.ensureMetaDefaults(nodeId);
    if (row) {
      meta.node_id = row.id;
      meta.name = row.name;
      meta.group_name = row.group_name;
      meta.traffic_limit_bytes = row.traffic_limit_bytes;
      meta.traffic_reset_day = row.traffic_reset_day;
      meta.traffic_count_mode = row.traffic_count_mode;
      meta.mute_until = row.mute_until;
      if (!this.lastHardware && row.hostname) {
        this.lastHardware = {
          hostname: row.hostname,
          os: row.os,
          kernel: row.kernel,
          arch: row.arch,
          cpu_model: row.cpu_model,
          cpu_cores: row.cpu_cores,
          mem_total: row.mem_total,
          swap_total: row.swap_total,
          agent_version: row.agent_version,
          proc_enabled: Boolean(row.proc_enabled),
        };
        meta.last_hello_json = JSON.stringify(this.lastHardware);
      }
      this.persistMetaRow(meta);
    }
    return meta;
  }

  private async getRulesAndChannels(): Promise<{
    rules: AlertRule[];
    channelsById: Map<string, NotificationChannel>;
  }> {
    const nowMs = Date.now();
    if (this.rulesCache && this.rulesCache.expiresAt > nowMs) {
      return {
        rules: this.rulesCache.rules,
        channelsById: this.rulesCache.channelsById,
      };
    }
    const nodeId = this.meta?.node_id ?? "";
    const loaded = await loadNodeRulesAndChannels(this.env.DB, nodeId);
    this.rulesCache = {
      ...loaded,
      expiresAt: nowMs + RULES_CACHE_TTL_MS,
    };
    return loaded;
  }

  private getOfflineThresholdMs(rules: AlertRule[]): number {
    let minSec = DEFAULT_OFFLINE_THRESHOLD_MS / 1000;
    let found = false;
    for (const r of rules) {
      if (r.enabled && r.metric === "offline" && Number.isFinite(r.threshold) && r.threshold > 0) {
        if (!found || r.threshold < minSec) {
          minSec = r.threshold;
          found = true;
        }
      }
    }
    return Math.max(15_000, Math.round(minSec * 1000));
  }

  private async ensureOfflineAlarm(
    nowMs: number,
    offlineThresholdMs: number,
  ): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing - nowMs < ALARM_SLACK_MS) {
      await this.ctx.storage.setAlarm(nowMs + offlineThresholdMs);
    }
  }

  private computeEffectiveMode(nowMs: number): SampleMode {
    if (!this.meta) {
      return 0;
    }
    if (this.meta.proc_watch_until > nowMs) {
      return 2;
    }
    if (this.meta.detail_watch_until > nowMs || this.meta.fleet_watch_until > nowMs) {
      return 1;
    }
    return 0;
  }

  private isWatched(nowMs: number): boolean {
    if (!this.meta) {
      return false;
    }
    return (
      this.meta.fleet_watch_until > nowMs ||
      this.meta.detail_watch_until > nowMs ||
      this.meta.proc_watch_until > nowMs
    );
  }

  private sendCtrlToAgent(ws: WebSocket, mode: SampleMode, nowMs: number): void {
    const ctrl: AgentCtrlFrame = {
      t: "ctrl",
      mode,
      interval_ms: mode === 0 ? 30_000 : 2_000,
      top_n: 30,
      lease_sec: 90,
    };
    try {
      ws.send(JSON.stringify(ctrl));
      if (this.meta) {
        this.meta.last_ctrl_mode = mode;
        this.meta.last_ctrl_sent_ms = nowMs;
      }
    } catch {
      // ignore send errors on closing socket
    }
  }

  private buildTrafficSummary(nowSec: number) {
    const meta = this.meta;
    const resetDay = meta?.traffic_reset_day ?? 1;
    const countMode: TrafficCountMode = meta?.traffic_count_mode ?? "both";
    const limitBytes = meta?.traffic_limit_bytes ?? null;
    const { cycleKey, daysRemaining } = computeTrafficCycle(nowSec, resetDay);

    let rxBytes = 0;
    let txBytes = 0;
    if (this.trafficRow && this.trafficRow.cycle_key === cycleKey) {
      rxBytes = this.trafficRow.cycle_rx_bytes;
      txBytes = this.trafficRow.cycle_tx_bytes;
    }

    return {
      limit_bytes: limitBytes,
      reset_day: resetDay,
      count_mode: countMode,
      cycle_key: cycleKey,
      rx_bytes: rxBytes,
      tx_bytes: txBytes,
      counted_bytes: computeCountedBytes(rxBytes, txBytes, countMode),
      days_remaining: daysRemaining,
    };
  }

  private persistRuleState(state: AlertRuleRuntimeState): void {
    this.ruleStates.set(state.rule_id, state);
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO alert_rule_states (
        rule_id, state, first_breach_ts, last_notified_ts,
        recover_ok_count, incident_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      state.rule_id,
      state.state,
      state.first_breach_ts,
      state.last_notified_ts,
      state.recover_ok_count,
      state.incident_id,
      state.started_at,
    );
  }

  private deleteRuleState(ruleId: string): void {
    this.ruleStates.delete(ruleId);
    this.ctx.storage.sql.exec("DELETE FROM alert_rule_states WHERE rule_id = ?", ruleId);
  }

  private persistTrafficRow(row: TrafficLedgerRow): void {
    this.trafficRow = row;
    this.trafficDirty = false;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO traffic_state (
        id, cycle_key, last_agent_rx, last_agent_tx,
        cycle_rx_bytes, cycle_tx_bytes, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      row.cycle_key,
      row.last_agent_rx,
      row.last_agent_tx,
      row.cycle_rx_bytes,
      row.cycle_tx_bytes,
      row.updated_at,
    );
  }

  private async resolveOfflineRulesIfFiring(
    meta: NodeMetaRow,
    wallNowSec: number,
  ): Promise<boolean> {
    const { rules, channelsById } = await this.getRulesAndChannels();
    let changed = false;

    for (const rule of rules) {
      if (rule.metric !== "offline") {
        continue;
      }
      const state = this.ruleStates.get(rule.id);
      if (!state || state.state !== "FIRING") {
        continue;
      }
      changed = true;
      const outageDuration = Math.max(0, wallNowSec - (state.started_at ?? wallNowSec));
      const incidentId = state.incident_id;
      this.deleteRuleState(rule.id);

      if (incidentId) {
        await recordIncidentResolved(this.env.DB, incidentId, wallNowSec);
      }

      await notifyChannels(
        channelsById,
        rule.channel_ids,
        {
          kind: "resolved",
          nodeId: meta.node_id,
          nodeName: meta.name || meta.node_id,
          groupName: meta.group_name,
          ruleId: rule.id,
          ruleName: rule.name,
          metric: "offline",
          operator: rule.operator,
          valueText: "在线",
          thresholdText: formatRuleThresholdText("offline", rule.threshold),
          durationSec: outageDuration,
          triggerValue: 0,
          threshold: rule.threshold,
          timestampSec: wallNowSec,
        },
        meta.mute_until,
      );
    }

    // Also resolve any stale firing offline state whose rule might have been modified
    for (const [ruleId, state] of this.ruleStates) {
      if (state.state === "FIRING" && !rules.some((r) => r.id === ruleId)) {
        const inc = await this.env.DB.prepare(
          "SELECT metric FROM alert_incidents WHERE id = ? AND status = 'firing'",
        )
          .bind(state.incident_id)
          .first<{ metric: string }>();
        if (inc?.metric === "offline" && state.incident_id) {
          await recordIncidentResolved(this.env.DB, state.incident_id, wallNowSec);
          this.deleteRuleState(ruleId);
          changed = true;
        }
      }
    }

    return changed;
  }

  private async notifyHubSafe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      // Never break agent ingestion if FleetHubDO fails transiently
    }
  }

  private async notifyAlertChange(
    hub: DurableObjectStub<FleetHubDO>,
  ): Promise<void> {
    const activeAlertsCount = await countFiringAlerts(this.env.DB);
    await this.notifyHubSafe(() =>
      hub.pushAlertChange({ t: "alert_change", activeAlertsCount }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const nodeId = request.headers.get("X-UniOB-Node-Id")?.trim();
    if (!nodeId) {
      return new Response("Missing X-UniOB-Node-Id", { status: 400 });
    }

    if (this.destroyed) {
      this.initSchema();
      this.destroyed = false;
    }
    await this.hydrateMetaFromD1(nodeId);

    for (const oldWs of this.ctx.getWebSockets("agent")) {
      try {
        oldWs.close(1000, "Superseded by new agent connection");
      } catch {
        // ignore close error
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ["agent"]);
    server.serializeAttachment({ nodeId });

    const nowMs = Date.now();
    const { rules } = await this.getRulesAndChannels();
    await this.ensureOfflineAlarm(nowMs, this.getOfflineThresholdMs(rules));

    const effectiveMode = this.computeEffectiveMode(nowMs);
    if (effectiveMode > 0) {
      this.sendCtrlToAgent(server, effectiveMode, nowMs);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (this.destroyed || typeof message !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const attachment = ws.deserializeAttachment() as { nodeId?: string } | null;
    const nodeId = this.meta?.node_id || attachment?.nodeId || "";
    if (!nodeId) {
      return;
    }

    const meta = await this.hydrateMetaFromD1(nodeId);
    const frame = parsed as { t?: string };

    if (frame.t === "hello") {
      await this.handleHello(ws, meta, parsed as AgentHelloFrame);
    } else if (frame.t === "m") {
      await this.handleMetrics(ws, meta, parsed as AgentMetricsFrame);
    }
  }

  private async handleHello(
    ws: WebSocket,
    meta: NodeMetaRow,
    frame: AgentHelloFrame,
  ): Promise<void> {
    const wallNowMs = Date.now();
    const wallNowSec = Math.floor(wallNowMs / 1000);

    const hardware: NodeHardwareInfo = {
      hostname: frame.hostname ?? null,
      os: frame.os ?? null,
      kernel: frame.kernel ?? null,
      arch: frame.arch ?? null,
      cpu_model: frame.cpu_model ?? null,
      cpu_cores: typeof frame.cpu_cores === "number" ? frame.cpu_cores : null,
      mem_total: typeof frame.mem_total === "number" ? frame.mem_total : null,
      swap_total: typeof frame.swap_total === "number" ? frame.swap_total : null,
      agent_version: frame.agent_ver ?? null,
      proc_enabled: frame.proc_enabled !== false,
    };

    this.lastHardware = hardware;
    meta.online = 1;
    meta.last_seen_ts = wallNowSec;
    meta.last_hello_json = JSON.stringify(hardware);
    this.persistMetaRow(meta);

    // Async/batched hardware sync to D1 for fast list rendering
    await this.env.DB.prepare(
      `UPDATE nodes SET
        hostname = ?, os = ?, kernel = ?, arch = ?, cpu_model = ?,
        cpu_cores = ?, mem_total = ?, swap_total = ?, agent_version = ?,
        proc_enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        hardware.hostname,
        hardware.os,
        hardware.kernel,
        hardware.arch,
        hardware.cpu_model,
        hardware.cpu_cores,
        hardware.mem_total,
        hardware.swap_total,
        hardware.agent_version,
        hardware.proc_enabled ? 1 : 0,
        wallNowSec,
        meta.node_id,
      )
      .run();

    const offlineResolved = await this.resolveOfflineRulesIfFiring(meta, wallNowSec);
    const { rules } = await this.getRulesAndChannels();
    await this.ensureOfflineAlarm(wallNowMs, this.getOfflineThresholdMs(rules));

    const effectiveMode = this.computeEffectiveMode(wallNowMs);
    if (effectiveMode > 0) {
      this.sendCtrlToAgent(ws, effectiveMode, wallNowMs);
    }

    if (this.isWatched(wallNowMs)) {
      const hub = this.env.FLEET_HUB_DO.getByName("global");
      if (meta.fleet_watch_until > wallNowMs) {
        await this.notifyHubSafe(() =>
          hub.pushFleetTick({
            t: "fleet_tick",
            nodeId: meta.node_id,
            online: true,
            last_seen_ts: wallNowSec,
            traffic: this.buildTrafficSummary(wallNowSec),
            metrics: this.lastMetrics,
            hardware,
          }),
        );
      }
      if (offlineResolved) {
        await this.notifyAlertChange(hub);
      }
    }
  }

  private async handleMetrics(
    ws: WebSocket,
    meta: NodeMetaRow,
    frame: AgentMetricsFrame,
  ): Promise<void> {
    const wallNowMs = Date.now();
    const wallNowSec = Math.floor(wallNowMs / 1000);
    const frameTs =
      typeof frame.ts === "number" && Number.isFinite(frame.ts) && frame.ts > 0
        ? Math.floor(frame.ts)
        : wallNowSec;

    const wasOffline = meta.online === 0;
    meta.online = 1;
    meta.last_seen_ts = wallNowSec;

    let alertStateChanged = false;
    if (wasOffline) {
      alertStateChanged = await this.resolveOfflineRulesIfFiring(meta, wallNowSec);
    }

    const metricsPayload: NodeMetricsPayload = {
      ts: frameTs,
      up: frame.up,
      cpu: frame.cpu,
      mem: frame.mem,
      disks: Array.isArray(frame.disks) ? frame.disks : [],
      net: frame.net,
    };
    this.lastMetrics = metricsPayload;
    meta.last_metrics_json = JSON.stringify(metricsPayload);

    // Advance monotonic traffic ledger
    const trafficResult = advanceTrafficLedger(
      this.trafficRow,
      frame.net.rx_tot ?? 0,
      frame.net.tx_tot ?? 0,
      frameTs,
      meta.traffic_reset_day,
    );
    this.trafficRow = trafficResult.next;
    this.trafficDirty = true;

    // 30s raw write throttle + 5m / 1h rollups + 24h TTL cleanup
    const shouldWriteRaw =
      meta.last_raw_write_ts === 0 ||
      frameTs - meta.last_raw_write_ts >= 30;

    if (shouldWriteRaw) {
      const bucket5m = Math.floor(frameTs / 300) * 300;
      const bucket1h = Math.floor(frameTs / 3600) * 3600;

      if (meta.last_5m_bucket > 0 && bucket5m > meta.last_5m_bucket) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO metrics_5m (
            ts, cpu_avg, cpu_max, steal_max, load1_avg,
            mem_avg, mem_max, disk_used,
            net_rx_avg, net_rx_max, net_tx_avg, net_tx_max
          )
          SELECT
            (ts / 300) * 300 AS bucket_ts,
            AVG(cpu),
            MAX(cpu),
            MAX(steal),
            AVG(load1),
            CAST(ROUND(AVG(mem_used)) AS INTEGER),
            MAX(mem_used),
            MAX(disk_used),
            CAST(ROUND(AVG(net_rx_bps)) AS INTEGER),
            MAX(net_rx_bps),
            CAST(ROUND(AVG(net_tx_bps)) AS INTEGER),
            MAX(net_tx_bps)
          FROM metrics_raw
          WHERE ts >= ? AND ts < ?
          GROUP BY bucket_ts`,
          meta.last_5m_bucket,
          bucket5m,
        );
      }

      if (meta.last_1h_bucket > 0 && bucket1h > meta.last_1h_bucket) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO metrics_1h (
            ts, cpu_avg, cpu_max, mem_avg, mem_max,
            disk_used, net_rx_bytes, net_tx_bytes
          )
          SELECT
            (ts / 3600) * 3600 AS bucket_ts,
            AVG(cpu_avg),
            MAX(cpu_max),
            CAST(ROUND(AVG(mem_avg)) AS INTEGER),
            MAX(mem_max),
            MAX(disk_used),
            CAST(ROUND(SUM(net_rx_avg * 300)) AS INTEGER),
            CAST(ROUND(SUM(net_tx_avg * 300)) AS INTEGER)
          FROM metrics_5m
          WHERE ts >= ? AND ts < ?
          GROUP BY bucket_ts`,
          meta.last_1h_bucket,
          bucket1h,
        );
      }

      const diskUsed = metricsPayload.disks.reduce(
        (acc, d) => acc + Math.max(0, Math.floor(d.used || 0)),
        0,
      );
      const diskRBps = metricsPayload.disks.reduce(
        (acc, d) => acc + Math.max(0, Math.floor(d.r_bps || 0)),
        0,
      );
      const diskWBps = metricsPayload.disks.reduce(
        (acc, d) => acc + Math.max(0, Math.floor(d.w_bps || 0)),
        0,
      );

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO metrics_raw (
          ts, cpu, steal, load1, mem_used, swap_used,
          disk_used, disk_r_bps, disk_w_bps, net_rx_bps, net_tx_bps, tcp_est
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        frameTs,
        metricsPayload.cpu.all,
        metricsPayload.cpu.steal,
        metricsPayload.cpu.load[0] ?? 0,
        Math.floor(metricsPayload.mem.used),
        Math.floor(metricsPayload.mem.swap_used),
        diskUsed,
        diskRBps,
        diskWBps,
        Math.floor(metricsPayload.net.rx_bps),
        Math.floor(metricsPayload.net.tx_bps),
        Math.floor(metricsPayload.net.tcp_est),
      );

      this.persistTrafficRow(trafficResult.next);

      if (meta.last_cleanup_ts === 0) {
        meta.last_cleanup_ts = frameTs;
      } else if (frameTs - meta.last_cleanup_ts >= RAW_RETENTION_SEC) {
        this.ctx.storage.sql.exec(
          "DELETE FROM metrics_raw WHERE ts < ?",
          frameTs - RAW_RETENTION_SEC,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM metrics_5m WHERE ts < ?",
          frameTs - M5_RETENTION_SEC,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM metrics_1h WHERE ts < ?",
          frameTs - H1_RETENTION_SEC,
        );
        meta.last_cleanup_ts = frameTs;
      }

      meta.last_raw_write_ts = frameTs;
      meta.last_5m_bucket = bucket5m;
      meta.last_1h_bucket = bucket1h;
      this.persistMetaRow(meta);
    } else if (trafficResult.rebooted || trafficResult.cycleReset || wasOffline) {
      // Immediately flush critical state changes (reboot, billing rollover, online transition)
      this.persistTrafficRow(trafficResult.next);
      this.persistMetaRow(meta);
    }

    // Evaluate non-offline alert rules
    const { rules, channelsById } = await this.getRulesAndChannels();
    const trafficSummary = this.buildTrafficSummary(frameTs);
    const evalCtx = {
      nodeId: meta.node_id,
      nodeName: meta.name || meta.node_id,
      groupName: meta.group_name,
      muteUntil: meta.mute_until,
      memTotalBytes: this.lastHardware?.mem_total ?? null,
      swapTotalBytes: this.lastHardware?.swap_total ?? null,
      traffic: trafficSummary,
      metrics: metricsPayload,
      nowSec: frameTs,
    };

    for (const rule of rules) {
      if (rule.metric === "offline") {
        continue;
      }
      const reading = extractMetricReading(rule.metric, evalCtx);
      if (!reading) {
        continue;
      }
      const decision = evaluateRuleStep(
        rule,
        this.ruleStates.get(rule.id),
        reading.value,
        frameTs,
      );
      if (decision.changed) {
        if (decision.action === "resolve") {
          this.deleteRuleState(rule.id);
        } else {
          this.persistRuleState(decision.nextState);
        }
      }

      if (decision.action === "fire" && decision.incidentId) {
        alertStateChanged = true;
        await recordIncidentFiring(this.env.DB, {
          incidentId: decision.incidentId,
          nodeId: meta.node_id,
          nodeName: meta.name || meta.node_id,
          ruleId: rule.id,
          metric: rule.metric,
          triggerValue: reading.value,
          threshold: rule.threshold,
          message: `${rule.name}: ${reading.valueText}${reading.valueDetail ? ` (${reading.valueDetail})` : ""}`,
          startedAt: frameTs,
        });
        await notifyChannels(
          channelsById,
          rule.channel_ids,
          {
            kind: "firing",
            nodeId: meta.node_id,
            nodeName: meta.name || meta.node_id,
            groupName: meta.group_name,
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
            timestampSec: frameTs,
          },
          meta.mute_until,
        );
      } else if (decision.action === "renotify") {
        if (decision.incidentId) {
          await recordIncidentRenotify(this.env.DB, decision.incidentId, frameTs);
        }
        await notifyChannels(
          channelsById,
          rule.channel_ids,
          {
            kind: "firing",
            nodeId: meta.node_id,
            nodeName: meta.name || meta.node_id,
            groupName: meta.group_name,
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
            timestampSec: frameTs,
          },
          meta.mute_until,
        );
      } else if (decision.action === "resolve") {
        alertStateChanged = true;
        if (decision.incidentId) {
          await recordIncidentResolved(this.env.DB, decision.incidentId, frameTs);
        }
        await notifyChannels(
          channelsById,
          rule.channel_ids,
          {
            kind: "resolved",
            nodeId: meta.node_id,
            nodeName: meta.name || meta.node_id,
            groupName: meta.group_name,
            ruleId: rule.id,
            ruleName: rule.name,
            metric: rule.metric,
            operator: rule.operator,
            valueText: reading.valueText,
            valueDetail: reading.valueDetail,
            thresholdText: formatRuleThresholdText(rule.metric, rule.threshold),
            durationSec: decision.resolvedDurationSec ?? 0,
            triggerValue: reading.value,
            threshold: rule.threshold,
            timestampSec: frameTs,
          },
          meta.mute_until,
        );
      }
    }

    // Re-arm offline alarm only when remaining < 35s
    await this.ensureOfflineAlarm(wallNowMs, this.getOfflineThresholdMs(rules));

    // Check if watch lease expired or mode changed
    const effectiveMode = this.computeEffectiveMode(wallNowMs);
    if (effectiveMode !== meta.last_ctrl_mode) {
      this.sendCtrlToAgent(ws, effectiveMode, wallNowMs);
      this.persistMetaRow(meta);
    }

    if (this.isWatched(wallNowMs)) {
      const hub = this.env.FLEET_HUB_DO.getByName("global");
      if (meta.fleet_watch_until > wallNowMs) {
        await this.notifyHubSafe(() =>
          hub.pushFleetTick({
            t: "fleet_tick",
            nodeId: meta.node_id,
            online: true,
            last_seen_ts: wallNowSec,
            traffic: trafficSummary,
            metrics: metricsPayload,
          }),
        );
      }
      if (meta.detail_watch_until > wallNowMs || meta.proc_watch_until > wallNowMs) {
        await this.notifyHubSafe(() =>
          hub.pushNodeDetail({
            t: "node_detail",
            nodeId: meta.node_id,
            online: true,
            ts: frameTs,
            metrics: metricsPayload,
            ...(Array.isArray(frame.procs) ? { procs: frame.procs } : {}),
          }),
        );
      }
      if (alertStateChanged) {
        await this.notifyAlertChange(hub);
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.flushPendingStateToSqlite();
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  async webSocketError(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.flushPendingStateToSqlite();
  }

  private flushPendingStateToSqlite(): void {
    if (this.trafficDirty && this.trafficRow) {
      this.persistTrafficRow(this.trafficRow);
    }
    if (this.meta) {
      this.persistMetaRow(this.meta);
    }
  }

  async alarm(): Promise<void> {
    if (this.destroyed || !this.meta) {
      return;
    }
    const meta = this.meta;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const { rules, channelsById } = await this.getRulesAndChannels();
    const offlineThresholdMs = this.getOfflineThresholdMs(rules);
    const offlineThresholdSec = Math.floor(offlineThresholdMs / 1000);

    const lastSeenSec = meta.last_seen_ts;
    if (lastSeenSec === null) {
      return;
    }

    const elapsedSec = nowSec - lastSeenSec;
    if (elapsedSec < offlineThresholdSec) {
      // Earlier frames skipped setAlarm optimization; reschedule to exact deadline
      const remainingMs = Math.max(1_000, offlineThresholdMs - elapsedSec * 1000);
      await this.ctx.storage.setAlarm(nowMs + remainingMs);
      return;
    }

    // Node is offline!
    const wasOnline = meta.online === 1;
    if (wasOnline) {
      meta.online = 0;
      this.persistMetaRow(meta);
    }

    for (const ws of this.ctx.getWebSockets("agent")) {
      try {
        ws.close(1001, "Offline watchdog timeout");
      } catch {
        // ignore
      }
    }

    let alertFired = false;
    for (const rule of rules) {
      if (rule.metric !== "offline") {
        continue;
      }
      const prev = this.ruleStates.get(rule.id);
      if (prev && prev.state === "FIRING") {
        // Check cooldown re-notify if configured
        if (
          rule.cooldown_sec > 0 &&
          nowSec - (prev.last_notified_ts ?? 0) >= rule.cooldown_sec
        ) {
          prev.last_notified_ts = nowSec;
          this.persistRuleState(prev);
          if (prev.incident_id) {
            await recordIncidentRenotify(this.env.DB, prev.incident_id, nowSec);
          }
          await notifyChannels(
            channelsById,
            rule.channel_ids,
            {
              kind: "firing",
              nodeId: meta.node_id,
              nodeName: meta.name || meta.node_id,
              groupName: meta.group_name,
              ruleId: rule.id,
              ruleName: rule.name,
              metric: "offline",
              operator: rule.operator,
              valueText: `已离线 ${elapsedSec}s`,
              thresholdText: formatRuleThresholdText("offline", rule.threshold),
              durationSec: rule.duration_sec,
              triggerValue: elapsedSec,
              threshold: rule.threshold,
              timestampSec: nowSec,
            },
            meta.mute_until,
          );
        }
        continue;
      }

      const incidentId = `${meta.node_id}_off_${nowSec}`;
      const newState: AlertRuleRuntimeState = {
        rule_id: rule.id,
        state: "FIRING",
        first_breach_ts: lastSeenSec,
        last_notified_ts: nowSec,
        recover_ok_count: 0,
        incident_id: incidentId,
        started_at: nowSec,
      };
      this.persistRuleState(newState);
      alertFired = true;

      await recordIncidentFiring(this.env.DB, {
        incidentId,
        nodeId: meta.node_id,
        nodeName: meta.name || meta.node_id,
        ruleId: rule.id,
        metric: "offline",
        triggerValue: elapsedSec,
        threshold: rule.threshold,
        message: `${rule.name}: 节点失联超过 ${elapsedSec}s`,
        startedAt: nowSec,
      });

      await notifyChannels(
        channelsById,
        rule.channel_ids,
        {
          kind: "firing",
          nodeId: meta.node_id,
          nodeName: meta.name || meta.node_id,
          groupName: meta.group_name,
          ruleId: rule.id,
          ruleName: rule.name,
          metric: "offline",
          operator: rule.operator,
          valueText: `已离线 ${elapsedSec}s`,
          thresholdText: formatRuleThresholdText("offline", rule.threshold),
          durationSec: rule.duration_sec,
          triggerValue: elapsedSec,
          threshold: rule.threshold,
          timestampSec: nowSec,
        },
        meta.mute_until,
      );
    }

    if (this.isWatched(nowMs)) {
      const hub = this.env.FLEET_HUB_DO.getByName("global");
      await this.notifyHubSafe(() =>
        hub.pushNodeOffline({
          t: "node_offline",
          nodeId: meta.node_id,
          last_seen_ts: meta.last_seen_ts,
        }),
      );
      if (alertFired) {
        await this.notifyAlertChange(hub);
      }
    }
  }

  // Typed RPC Methods

  async syncConfig(config: NodeConfigSync): Promise<void> {
    if (this.destroyed) {
      this.initSchema();
      this.destroyed = false;
    }
    const meta = this.ensureMetaDefaults(config.nodeId);
    meta.node_id = config.nodeId;
    meta.name = config.name;
    meta.group_name = config.groupName;
    meta.traffic_limit_bytes = config.trafficLimitBytes;
    meta.traffic_reset_day = config.trafficResetDay;
    meta.traffic_count_mode = config.trafficCountMode;
    meta.mute_until = config.muteUntil;
    this.persistMetaRow(meta);
  }

  async invalidateRules(): Promise<void> {
    this.rulesCache = null;
    if (this.meta && this.meta.online === 1) {
      const { rules } = await this.getRulesAndChannels();
      const thresholdMs = this.getOfflineThresholdMs(rules);
      const existing = await this.ctx.storage.getAlarm();
      const nowMs = Date.now();
      if (existing === null || existing > nowMs + thresholdMs) {
        await this.ctx.storage.setAlarm(nowMs + thresholdMs);
      }
    }
  }

  async updateWatchLease(lease: NodeLeaseUpdate): Promise<{ mode: SampleMode }> {
    if (this.destroyed) {
      return { mode: 0 };
    }
    if (!this.meta) {
      if (!lease.nodeId) {
        return { mode: 0 };
      }
      await this.hydrateMetaFromD1(lease.nodeId);
    }
    if (!this.meta) {
      return { mode: 0 };
    }
    const nowMs = Date.now();
    if (lease.fleetUntil !== undefined) {
      this.meta.fleet_watch_until = lease.fleetUntil;
    }
    if (lease.detailUntil !== undefined) {
      this.meta.detail_watch_until = lease.detailUntil;
    }
    if (lease.procUntil !== undefined) {
      this.meta.proc_watch_until = lease.procUntil;
    }

    const effectiveMode = this.computeEffectiveMode(nowMs);
    const sockets = this.ctx.getWebSockets("agent");
    if (
      sockets.length > 0 &&
      (effectiveMode !== this.meta.last_ctrl_mode ||
        (effectiveMode > 0 && nowMs - this.meta.last_ctrl_sent_ms >= 30_000))
    ) {
      for (const ws of sockets) {
        this.sendCtrlToAgent(ws, effectiveMode, nowMs);
      }
    } else if (sockets.length === 0) {
      this.meta.last_ctrl_mode = effectiveMode;
    }

    this.persistMetaRow(this.meta);

    return { mode: effectiveMode };
  }

  async getSnapshot(fallback?: NodeConfigSync): Promise<NodeSnapshot> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (!this.meta && fallback) {
      this.ensureMetaDefaults(fallback.nodeId);
      await this.syncConfig(fallback);
    }
    const meta = this.meta;
    return {
      online: Boolean(meta?.online),
      last_seen_ts: meta?.last_seen_ts ?? null,
      traffic: this.buildTrafficSummary(nowSec),
      metrics: this.lastMetrics,
      hardware: this.lastHardware,
    };
  }

  async queryMetrics(range: MetricRange): Promise<MetricsQueryResponse> {
    const nowSec = Math.floor(Date.now() / 1000);
    const nodeId = this.meta?.node_id ?? "";

    let resolution: MetricResolution = "30s";
    let points: MetricsQueryPoint[] = [];

    if (range === "1h" || range === "24h") {
      resolution = "30s";
      const windowSec = range === "1h" ? 3_600 : 86_400;
      const rows = this.ctx.storage.sql
        .exec<RawMetricRow>(
          "SELECT ts, cpu, steal, load1, mem_used, swap_used, disk_used, disk_r_bps, disk_w_bps, net_rx_bps, net_tx_bps, tcp_est FROM metrics_raw WHERE ts >= ? ORDER BY ts ASC",
          nowSec - windowSec,
        )
        .toArray();
      points = rows.map((r) => ({
        ts: r.ts,
        cpu: r.cpu,
        steal: r.steal,
        load1: r.load1,
        mem_used: r.mem_used,
        swap_used: r.swap_used,
        disk_used: r.disk_used,
        disk_r_bps: r.disk_r_bps,
        disk_w_bps: r.disk_w_bps,
        net_rx_bps: r.net_rx_bps,
        net_tx_bps: r.net_tx_bps,
        tcp_est: r.tcp_est,
      }));
    } else if (range === "7d" || range === "30d") {
      resolution = "5m";
      const windowSec = range === "7d" ? 7 * 86_400 : 30 * 86_400;
      const rows = this.ctx.storage.sql
        .exec<Metric5mRow>(
          "SELECT ts, cpu_avg, cpu_max, steal_max, load1_avg, mem_avg, mem_max, disk_used, net_rx_avg, net_rx_max, net_tx_avg, net_tx_max FROM metrics_5m WHERE ts >= ? ORDER BY ts ASC",
          nowSec - windowSec,
        )
        .toArray();
      points = rows.map((r) => ({
        ts: r.ts,
        cpu: r.cpu_avg,
        cpu_max: r.cpu_max,
        steal: r.steal_max,
        load1: r.load1_avg,
        mem_used: r.mem_avg,
        mem_max: r.mem_max,
        swap_used: 0,
        disk_used: r.disk_used,
        disk_r_bps: 0,
        disk_w_bps: 0,
        net_rx_bps: r.net_rx_avg,
        net_tx_bps: r.net_tx_avg,
        tcp_est: 0,
      }));
    } else {
      resolution = "1h";
      const windowSec = 365 * 86_400;
      const rows = this.ctx.storage.sql
        .exec<Metric1hRow>(
          "SELECT ts, cpu_avg, cpu_max, mem_avg, mem_max, disk_used, net_rx_bytes, net_tx_bytes FROM metrics_1h WHERE ts >= ? ORDER BY ts ASC",
          nowSec - windowSec,
        )
        .toArray();
      points = rows.map((r) => ({
        ts: r.ts,
        cpu: r.cpu_avg,
        cpu_max: r.cpu_max,
        steal: 0,
        load1: 0,
        mem_used: r.mem_avg,
        mem_max: r.mem_max,
        swap_used: 0,
        disk_used: r.disk_used,
        disk_r_bps: 0,
        disk_w_bps: 0,
        net_rx_bps: Math.round(r.net_rx_bytes / 3600),
        net_tx_bps: Math.round(r.net_tx_bytes / 3600),
        tcp_est: 0,
      }));
    }

    return {
      node_id: nodeId,
      range,
      resolution,
      points,
    };
  }

  async disconnectAgent(): Promise<void> {
    for (const ws of this.ctx.getWebSockets("agent")) {
      try {
        ws.close(4001, "Agent token rotated");
      } catch {
        // ignore
      }
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const ws of this.ctx.getWebSockets("agent")) {
      try {
        ws.close(1000, "Node deleted");
      } catch {
        // ignore
      }
    }
    this.meta = null;
    this.trafficRow = null;
    this.trafficDirty = false;
    this.lastMetrics = null;
    this.lastHardware = null;
    this.ruleStates.clear();
    this.rulesCache = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
