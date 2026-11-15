use crate::crypto::{now_sec, sha256_hex};
use crate::protocol::{
    AlertIncidentRow, AlertRuleRow, CompactMetricTuple, ExportBundle, ExportSystemSettingEntry,
    ExportTrafficLedgerEntry, ImportBundlePayload, ImportBundleResponse, ImportCounts,
    ImportSystemSettingsInput, ImportTrafficLedgersInput, MetricsQueryPoint, MetricsQueryResponse,
    NodeHardwareInfo, NodeMetricsPayload, NodeRow, NodeSummary, NodeTrafficSummary,
    NotificationChannelRow, SystemSettingMapValue,
};
use crate::traffic::{
    advance_traffic_ledger, compute_counted_bytes, compute_traffic_cycle, TrafficLedgerState,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

const SLAB_10M_SLOTS: i64 = 144; // 144 * 600s = 24h
const SLAB_1H_SLOTS: i64 = 720; // 720 * 3600s = 30d
const SLAB_1D_SLOTS: i64 = 366; // 366 * 86400s = 366d
const RAW_SAMPLE_BYTES: usize = 96; // 12 x 8-byte fields
const ROLLUP_5M_BYTES: usize = 104; // 13 x 8-byte fields
const ROLLUP_1H_BYTES: usize = 72; // 9 x 8-byte fields
const MAX_POINTS_PER_10M_CHUNK: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Welford5mAccumulator {
    pub bucket_ts: i64,
    pub count: u64,
    pub cpu_mean: f64,
    pub cpu_max: f64,
    pub steal_max: f64,
    pub load1_mean: f64,
    pub mem_mean: f64,
    pub mem_max: f64,
    pub disk_used_max: f64,
    pub net_rx_mean: f64,
    pub net_rx_max: f64,
    pub net_tx_mean: f64,
    pub net_tx_max: f64,
}

impl Welford5mAccumulator {
    fn from_sample(bucket_ts: i64, s: &RawSlabSample) -> Self {
        Self {
            bucket_ts,
            count: 1,
            cpu_mean: s.cpu,
            cpu_max: s.cpu,
            steal_max: s.steal,
            load1_mean: s.load1,
            mem_mean: s.mem_used,
            mem_max: s.mem_used,
            disk_used_max: s.disk_used,
            net_rx_mean: s.net_rx_bps,
            net_rx_max: s.net_rx_bps,
            net_tx_mean: s.net_tx_bps,
            net_tx_max: s.net_tx_bps,
        }
    }

    fn update(&mut self, s: &RawSlabSample) {
        self.count += 1;
        let n = self.count as f64;
        self.cpu_mean += (s.cpu - self.cpu_mean) / n;
        self.cpu_max = self.cpu_max.max(s.cpu);
        self.steal_max = self.steal_max.max(s.steal);
        self.load1_mean += (s.load1 - self.load1_mean) / n;
        self.mem_mean += (s.mem_used - self.mem_mean) / n;
        self.mem_max = self.mem_max.max(s.mem_used);
        self.disk_used_max = self.disk_used_max.max(s.disk_used);
        self.net_rx_mean += (s.net_rx_bps - self.net_rx_mean) / n;
        self.net_rx_max = self.net_rx_max.max(s.net_rx_bps);
        self.net_tx_mean += (s.net_tx_bps - self.net_tx_mean) / n;
        self.net_tx_max = self.net_tx_max.max(s.net_tx_bps);
    }

    fn to_rollup(&self) -> Rollup5mSample {
        Rollup5mSample {
            ts: self.bucket_ts,
            cpu_avg: self.cpu_mean,
            cpu_max: self.cpu_max,
            steal_max: self.steal_max,
            load1_avg: self.load1_mean,
            mem_avg: self.mem_mean.round(),
            mem_max: self.mem_max,
            disk_used: self.disk_used_max,
            net_rx_avg: self.net_rx_mean.round(),
            net_rx_max: self.net_rx_max,
            net_tx_avg: self.net_tx_mean.round(),
            net_tx_max: self.net_tx_max,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Welford1hAccumulator {
    pub bucket_ts: i64,
    pub count: u64,
    pub cpu_mean: f64,
    pub cpu_max: f64,
    pub mem_mean: f64,
    pub mem_max: f64,
    pub disk_used_max: f64,
    pub net_rx_bytes_sum: f64,
    pub net_tx_bytes_sum: f64,
}

impl Welford1hAccumulator {
    fn from_5m(bucket_ts: i64, r: &Rollup5mSample) -> Self {
        Self {
            bucket_ts,
            count: 1,
            cpu_mean: r.cpu_avg,
            cpu_max: r.cpu_max,
            mem_mean: r.mem_avg,
            mem_max: r.mem_max,
            disk_used_max: r.disk_used,
            net_rx_bytes_sum: (r.net_rx_avg * 300.0).round(),
            net_tx_bytes_sum: (r.net_tx_avg * 300.0).round(),
        }
    }

    fn update_5m(&mut self, r: &Rollup5mSample) {
        self.count += 1;
        let n = self.count as f64;
        self.cpu_mean += (r.cpu_avg - self.cpu_mean) / n;
        self.cpu_max = self.cpu_max.max(r.cpu_max);
        self.mem_mean += (r.mem_avg - self.mem_mean) / n;
        self.mem_max = self.mem_max.max(r.mem_max);
        self.disk_used_max = self.disk_used_max.max(r.disk_used);
        self.net_rx_bytes_sum += (r.net_rx_avg * 300.0).round();
        self.net_tx_bytes_sum += (r.net_tx_avg * 300.0).round();
    }

    fn to_rollup(&self) -> Rollup1hSample {
        Rollup1hSample {
            ts: self.bucket_ts,
            cpu_avg: self.cpu_mean,
            cpu_max: self.cpu_max,
            mem_avg: self.mem_mean.round(),
            mem_max: self.mem_max,
            disk_used: self.disk_used_max,
            net_rx_bytes: self.net_rx_bytes_sum,
            net_tx_bytes: self.net_tx_bytes_sum,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RawSlabSample {
    pub ts: i64,
    pub cpu: f64,
    pub steal: f64,
    pub load1: f64,
    pub mem_used: f64,
    pub swap_used: f64,
    pub disk_used: f64,
    pub disk_r_bps: f64,
    pub disk_w_bps: f64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub tcp_est: f64,
}

impl RawSlabSample {
    pub fn from_tuple(t: &CompactMetricTuple) -> Self {
        Self {
            ts: t[0].round() as i64,
            cpu: t[2],
            steal: t[3],
            load1: t[5],
            mem_used: t[6],
            swap_used: t[7],
            disk_used: t[8],
            disk_r_bps: t[9],
            disk_w_bps: t[10],
            net_rx_bps: t[11],
            net_tx_bps: t[12],
            tcp_est: t[15],
        }
    }

    fn write_le(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.ts.to_le_bytes());
        buf.extend_from_slice(&self.cpu.to_le_bytes());
        buf.extend_from_slice(&self.steal.to_le_bytes());
        buf.extend_from_slice(&self.load1.to_le_bytes());
        buf.extend_from_slice(&self.mem_used.to_le_bytes());
        buf.extend_from_slice(&self.swap_used.to_le_bytes());
        buf.extend_from_slice(&self.disk_used.to_le_bytes());
        buf.extend_from_slice(&self.disk_r_bps.to_le_bytes());
        buf.extend_from_slice(&self.disk_w_bps.to_le_bytes());
        buf.extend_from_slice(&self.net_rx_bps.to_le_bytes());
        buf.extend_from_slice(&self.net_tx_bps.to_le_bytes());
        buf.extend_from_slice(&self.tcp_est.to_le_bytes());
    }

    fn read_le_slice(blob: &[u8]) -> Vec<Self> {
        let count = blob.len() / RAW_SAMPLE_BYTES;
        let mut out = Vec::with_capacity(count);
        for chunk in blob.as_chunks::<RAW_SAMPLE_BYTES>().0 {
            out.push(Self {
                ts: read_i64_le(&chunk[0..8]),
                cpu: read_f64_le(&chunk[8..16]),
                steal: read_f64_le(&chunk[16..24]),
                load1: read_f64_le(&chunk[24..32]),
                mem_used: read_f64_le(&chunk[32..40]),
                swap_used: read_f64_le(&chunk[40..48]),
                disk_used: read_f64_le(&chunk[48..56]),
                disk_r_bps: read_f64_le(&chunk[56..64]),
                disk_w_bps: read_f64_le(&chunk[64..72]),
                net_rx_bps: read_f64_le(&chunk[72..80]),
                net_tx_bps: read_f64_le(&chunk[80..88]),
                tcp_est: read_f64_le(&chunk[88..96]),
            });
        }
        out
    }

    fn to_query_point(&self) -> MetricsQueryPoint {
        MetricsQueryPoint {
            ts: self.ts,
            cpu: self.cpu,
            cpu_max: None,
            steal: self.steal,
            load1: self.load1,
            mem_used: self.mem_used,
            mem_max: None,
            swap_used: self.swap_used,
            disk_used: self.disk_used,
            disk_r_bps: self.disk_r_bps,
            disk_w_bps: self.disk_w_bps,
            net_rx_bps: self.net_rx_bps,
            net_tx_bps: self.net_tx_bps,
            tcp_est: self.tcp_est,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Rollup5mSample {
    pub ts: i64,
    pub cpu_avg: f64,
    pub cpu_max: f64,
    pub steal_max: f64,
    pub load1_avg: f64,
    pub mem_avg: f64,
    pub mem_max: f64,
    pub disk_used: f64,
    pub net_rx_avg: f64,
    pub net_rx_max: f64,
    pub net_tx_avg: f64,
    pub net_tx_max: f64,
}

impl Rollup5mSample {
    fn write_le(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.ts.to_le_bytes());
        buf.extend_from_slice(&self.cpu_avg.to_le_bytes());
        buf.extend_from_slice(&self.cpu_max.to_le_bytes());
        buf.extend_from_slice(&self.steal_max.to_le_bytes());
        buf.extend_from_slice(&self.load1_avg.to_le_bytes());
        buf.extend_from_slice(&self.mem_avg.to_le_bytes());
        buf.extend_from_slice(&self.mem_max.to_le_bytes());
        buf.extend_from_slice(&self.disk_used.to_le_bytes());
        buf.extend_from_slice(&self.net_rx_avg.to_le_bytes());
        buf.extend_from_slice(&self.net_rx_max.to_le_bytes());
        buf.extend_from_slice(&self.net_tx_avg.to_le_bytes());
        buf.extend_from_slice(&self.net_tx_max.to_le_bytes());
        buf.extend_from_slice(&0i64.to_le_bytes()); // reserved alignment/pad (104B)
    }

    fn read_le_slice(blob: &[u8]) -> Vec<Self> {
        let count = blob.len() / ROLLUP_5M_BYTES;
        let mut out = Vec::with_capacity(count);
        for chunk in blob.as_chunks::<ROLLUP_5M_BYTES>().0 {
            out.push(Self {
                ts: read_i64_le(&chunk[0..8]),
                cpu_avg: read_f64_le(&chunk[8..16]),
                cpu_max: read_f64_le(&chunk[16..24]),
                steal_max: read_f64_le(&chunk[24..32]),
                load1_avg: read_f64_le(&chunk[32..40]),
                mem_avg: read_f64_le(&chunk[40..48]),
                mem_max: read_f64_le(&chunk[48..56]),
                disk_used: read_f64_le(&chunk[56..64]),
                net_rx_avg: read_f64_le(&chunk[64..72]),
                net_rx_max: read_f64_le(&chunk[72..80]),
                net_tx_avg: read_f64_le(&chunk[80..88]),
                net_tx_max: read_f64_le(&chunk[88..96]),
            });
        }
        out
    }

    fn to_query_point(&self) -> MetricsQueryPoint {
        MetricsQueryPoint {
            ts: self.ts,
            cpu: self.cpu_avg,
            cpu_max: Some(self.cpu_max),
            steal: self.steal_max,
            load1: self.load1_avg,
            mem_used: self.mem_avg,
            mem_max: Some(self.mem_max),
            swap_used: 0.0,
            disk_used: self.disk_used,
            disk_r_bps: 0.0,
            disk_w_bps: 0.0,
            net_rx_bps: self.net_rx_avg,
            net_tx_bps: self.net_tx_avg,
            tcp_est: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Rollup1hSample {
    pub ts: i64,
    pub cpu_avg: f64,
    pub cpu_max: f64,
    pub mem_avg: f64,
    pub mem_max: f64,
    pub disk_used: f64,
    pub net_rx_bytes: f64,
    pub net_tx_bytes: f64,
}

impl Rollup1hSample {
    fn write_le(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.ts.to_le_bytes());
        buf.extend_from_slice(&self.cpu_avg.to_le_bytes());
        buf.extend_from_slice(&self.cpu_max.to_le_bytes());
        buf.extend_from_slice(&self.mem_avg.to_le_bytes());
        buf.extend_from_slice(&self.mem_max.to_le_bytes());
        buf.extend_from_slice(&self.disk_used.to_le_bytes());
        buf.extend_from_slice(&self.net_rx_bytes.to_le_bytes());
        buf.extend_from_slice(&self.net_tx_bytes.to_le_bytes());
        buf.extend_from_slice(&0i64.to_le_bytes()); // reserved (72B)
    }

    fn read_le_slice(blob: &[u8]) -> Vec<Self> {
        let count = blob.len() / ROLLUP_1H_BYTES;
        let mut out = Vec::with_capacity(count);
        for chunk in blob.as_chunks::<ROLLUP_1H_BYTES>().0 {
            out.push(Self {
                ts: read_i64_le(&chunk[0..8]),
                cpu_avg: read_f64_le(&chunk[8..16]),
                cpu_max: read_f64_le(&chunk[16..24]),
                mem_avg: read_f64_le(&chunk[24..32]),
                mem_max: read_f64_le(&chunk[32..40]),
                disk_used: read_f64_le(&chunk[40..48]),
                net_rx_bytes: read_f64_le(&chunk[48..56]),
                net_tx_bytes: read_f64_le(&chunk[56..64]),
            });
        }
        out
    }

    fn to_query_point(&self) -> MetricsQueryPoint {
        MetricsQueryPoint {
            ts: self.ts,
            cpu: self.cpu_avg,
            cpu_max: Some(self.cpu_max),
            steal: 0.0,
            load1: 0.0,
            mem_used: self.mem_avg,
            mem_max: Some(self.mem_max),
            swap_used: 0.0,
            disk_used: self.disk_used,
            disk_r_bps: 0.0,
            disk_w_bps: 0.0,
            net_rx_bps: (self.net_rx_bytes / 3600.0).round(),
            net_tx_bps: (self.net_tx_bytes / 3600.0).round(),
            tcp_est: 0.0,
        }
    }
}

fn read_i64_le(bytes: &[u8]) -> i64 {
    i64::from_le_bytes(bytes.try_into().unwrap())
}

fn read_f64_le(bytes: &[u8]) -> f64 {
    f64::from_le_bytes(bytes.try_into().unwrap())
}

#[derive(Debug, Clone)]
pub struct AlertRuleRuntimeState {
    pub rule_id: String,
    pub state: String, // "OK" | "PENDING" | "FIRING"
    pub first_breach_ts: Option<i64>,
    pub last_notified_ts: Option<i64>,
    pub recover_ok_count: i64,
    pub incident_id: Option<String>,
    pub started_at: Option<i64>,
}

#[derive(Clone)]
pub struct HubDb {
    conn: Arc<Mutex<Connection>>,
}

impl HubDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create DB dir {}: {e}", parent.display()))?;
            }
        }
        let conn = Connection::open(path)
            .map_err(|e| format!("Failed to open SQLite DB {}: {e}", path.display()))?;
        Self::init_conn(conn)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn =
            Connection::open_in_memory().map_err(|e| format!("Failed to open memory DB: {e}"))?;
        Self::init_conn(conn)
    }

    fn init_conn(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;

             CREATE TABLE IF NOT EXISTS nodes (
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
               caps_json TEXT NOT NULL DEFAULT '[]',
               update_status_json TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS notification_channels (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               type TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 1,
               config_json TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS alert_rules (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               node_id TEXT,
               metric TEXT NOT NULL,
               operator TEXT NOT NULL DEFAULT 'gt',
               threshold REAL NOT NULL,
               duration_sec INTEGER NOT NULL DEFAULT 60,
               cooldown_sec INTEGER NOT NULL DEFAULT 300,
               channel_ids_json TEXT NOT NULL DEFAULT '[]',
               enabled INTEGER NOT NULL DEFAULT 1,
               created_at INTEGER NOT NULL,
               FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
             );

             CREATE TABLE IF NOT EXISTS alert_incidents (
               id TEXT PRIMARY KEY,
               node_id TEXT NOT NULL,
               node_name TEXT NOT NULL,
               rule_id TEXT NOT NULL,
               metric TEXT NOT NULL,
               status TEXT NOT NULL,
               trigger_value REAL,
               threshold REAL,
               message TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               resolved_at INTEGER,
               last_notified_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_incidents_status_started ON alert_incidents(status, started_at DESC);
             CREATE INDEX IF NOT EXISTS idx_incidents_node_started ON alert_incidents(node_id, started_at DESC);

             CREATE TABLE IF NOT EXISTS system_settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS traffic_ledgers (
               node_id TEXT PRIMARY KEY,
               cycle_key TEXT NOT NULL,
               last_agent_rx INTEGER NOT NULL,
               last_agent_tx INTEGER NOT NULL,
               cycle_rx_bytes INTEGER NOT NULL,
               cycle_tx_bytes INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
             );

             CREATE TABLE IF NOT EXISTS node_state (
               node_id TEXT PRIMARY KEY,
               last_seen_ts INTEGER,
               last_raw_write_ts INTEGER NOT NULL DEFAULT 0,
               online INTEGER NOT NULL DEFAULT 0,
               uptime_sec INTEGER,
               last_metrics_json TEXT,
               welford_5m_json TEXT,
               welford_1h_json TEXT,
               updated_at INTEGER NOT NULL,
               FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
             );

             CREATE TABLE IF NOT EXISTS metrics_chunk_10m (
               node_id TEXT NOT NULL,
               slot INTEGER NOT NULL,
               bucket_ts INTEGER NOT NULL,
               payload BLOB NOT NULL,
               PRIMARY KEY (node_id, slot),
               FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
             );

             CREATE TABLE IF NOT EXISTS metrics_5m_chunk_1h (
               node_id TEXT NOT NULL,
               slot INTEGER NOT NULL,
               bucket_ts INTEGER NOT NULL,
               payload BLOB NOT NULL,
               PRIMARY KEY (node_id, slot),
               FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
             );

             CREATE TABLE IF NOT EXISTS metrics_1h_chunk_1d (
               node_id TEXT NOT NULL,
               slot INTEGER NOT NULL,
               bucket_ts INTEGER NOT NULL,
               payload BLOB NOT NULL,
               PRIMARY KEY (node_id, slot),
               FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
             );

             CREATE TABLE IF NOT EXISTS alert_rule_states (
               node_id TEXT NOT NULL,
               rule_id TEXT NOT NULL,
               state TEXT NOT NULL,
               first_breach_ts INTEGER,
               last_notified_ts INTEGER,
               recover_ok_count INTEGER NOT NULL DEFAULT 0,
               incident_id TEXT,
               started_at INTEGER,
               PRIMARY KEY (node_id, rule_id),
               FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE,
               FOREIGN KEY(rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
             );",
        )
        .map_err(|e| format!("DB schema init failed: {e}"))?;

        ensure_node_column(&conn, "auto_update_override", "INTEGER")?;
        ensure_node_column(&conn, "caps_json", "TEXT NOT NULL DEFAULT '[]'")?;
        ensure_node_column(&conn, "update_status_json", "TEXT")?;

        crate::network_quality_store::init_schema(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn with_conn<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Connection) -> Result<R, String>,
    {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| "DB mutex poisoned".to_string())?;
        f(&mut guard)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT value FROM system_settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("get_setting error: {e}"))
        })
    }

    pub fn set_setting(&self, key: &str, value: &str, ts: i64) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO system_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, ts],
            )
            .map_err(|e| format!("set_setting error: {e}"))?;
            Ok(())
        })
    }

    pub fn ensure_session_secret(&self, env_secret: &str) -> Result<String, String> {
        if !env_secret.trim().is_empty() {
            return Ok(env_secret.to_string());
        }
        if let Some(existing) = self.get_setting("session_secret")? {
            if !existing.is_empty() {
                return Ok(existing);
            }
        }
        let generated = crate::crypto::generate_session_secret()?;
        self.set_setting("session_secret", &generated, now_sec())?;
        Ok(generated)
    }

    pub fn count_nodes(&self) -> Result<usize, String> {
        self.with_conn(|c| {
            let cnt: i64 = c
                .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0))
                .map_err(|e| format!("count_nodes error: {e}"))?;
            Ok(cnt.max(0) as usize)
        })
    }

    pub fn list_node_ids(&self) -> Result<Vec<String>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare("SELECT id FROM nodes")
                .map_err(|e| format!("list_node_ids prepare error: {e}"))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| format!("list_node_ids query error: {e}"))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| format!("list_node_ids row error: {e}"))?);
            }
            Ok(out)
        })
    }

    pub fn get_node_token_hash(&self, node_id: &str) -> Result<Option<String>, String> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT token_sha256 FROM nodes WHERE id = ?1",
                params![node_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("get_node_token_hash error: {e}"))
        })
    }

    pub fn get_node_row(&self, node_id: &str) -> Result<Option<NodeRow>, String> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT id, name, group_name, tags_json, sort_order, token_sha256,
                        traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
                        hostname, os, kernel, arch, cpu_model, cpu_cores,
                        mem_total, swap_total, agent_version, proc_enabled,
                        mute_until, auto_update_override, caps_json, update_status_json,
                        created_at, updated_at
                 FROM nodes WHERE id = ?1",
                params![node_id],
                map_node_row,
            )
            .optional()
            .map_err(|e| format!("get_node_row error: {e}"))
        })
    }

    pub fn list_nodes_with_summary(&self, current_sec: i64) -> Result<Vec<NodeSummary>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT n.id, n.name, n.group_name, n.tags_json, n.sort_order, n.token_sha256,
                            n.traffic_limit_bytes, n.traffic_reset_day, n.traffic_count_mode,
                            n.hostname, n.os, n.kernel, n.arch, n.cpu_model, n.cpu_cores,
                            n.mem_total, n.swap_total, n.agent_version, n.proc_enabled,
                            n.mute_until, n.auto_update_override, n.caps_json, n.update_status_json,
                            n.created_at, n.updated_at,
                            s.last_seen_ts, s.online, s.last_metrics_json,
                            t.cycle_key, t.cycle_rx_bytes, t.cycle_tx_bytes, nq.payload
                     FROM nodes n
                     LEFT JOIN node_state s ON s.node_id = n.id
                     LEFT JOIN traffic_ledgers t ON t.node_id = n.id
                     LEFT JOIN network_quality_state nq ON nq.node_id = n.id
                     ORDER BY n.sort_order ASC, n.created_at ASC",
                )
                .map_err(|e| format!("list_nodes prepare error: {e}"))?;

            let rows = stmt
                .query_map([], |row| {
                    let node = map_node_row(row)?;
                    let last_seen_ts: Option<i64> = row.get(25)?;
                    let online_int: i64 = row.get::<_, Option<i64>>(26)?.unwrap_or(0);
                    let last_metrics_json: Option<String> = row.get(27)?;
                    let cycle_key_db: Option<String> = row.get(28)?;
                    let rx_bytes: i64 = row.get::<_, Option<i64>>(29)?.unwrap_or(0);
                    let tx_bytes: i64 = row.get::<_, Option<i64>>(30)?.unwrap_or(0);

                    let (default_cycle, days_remaining) =
                        compute_traffic_cycle(current_sec, node.traffic_reset_day);
                    let cycle_key = cycle_key_db.unwrap_or(default_cycle);
                    let counted_bytes =
                        compute_counted_bytes(rx_bytes, tx_bytes, &node.traffic_count_mode);
                    let tags: Vec<String> =
                        serde_json::from_str(&node.tags_json).unwrap_or_default();
                    let caps: Vec<String> =
                        serde_json::from_str(&node.caps_json).unwrap_or_default();
                    let auto_update_override = node.auto_update_override.map(|v| v != 0);
                    let update_status = node
                        .update_status_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok());
                    let mut metrics: Option<NodeMetricsPayload> = last_metrics_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok());
                    if let Some(metrics) = metrics.as_mut() {
                        metrics.network_quality = row
                            .get::<_, Option<String>>(31)?
                            .and_then(|s| serde_json::from_str(&s).ok());
                    }

                    Ok(NodeSummary {
                        id: node.id,
                        name: node.name,
                        group_name: node.group_name,
                        tags,
                        sort_order: node.sort_order,
                        mute_until: node.mute_until,
                        hostname: node.hostname,
                        os: node.os,
                        kernel: node.kernel,
                        arch: node.arch,
                        cpu_model: node.cpu_model,
                        cpu_cores: node.cpu_cores,
                        mem_total: node.mem_total,
                        swap_total: node.swap_total,
                        agent_version: node.agent_version,
                        proc_enabled: node.proc_enabled != 0,
                        caps,
                        auto_update_override,
                        update_status,
                        online: online_int != 0,
                        last_seen_ts,
                        created_at: node.created_at,
                        updated_at: node.updated_at,
                        traffic: NodeTrafficSummary {
                            limit_bytes: node.traffic_limit_bytes,
                            reset_day: node.traffic_reset_day,
                            count_mode: node.traffic_count_mode,
                            cycle_key,
                            rx_bytes,
                            tx_bytes,
                            counted_bytes,
                            days_remaining,
                        },
                        metrics,
                    })
                })
                .map_err(|e| format!("list_nodes query error: {e}"))?;

            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| format!("list_nodes row error: {e}"))?);
            }
            Ok(out)
        })
    }

    pub fn get_node_summary(
        &self,
        node_id: &str,
        current_sec: i64,
    ) -> Result<Option<NodeSummary>, String> {
        let all = self.list_nodes_with_summary(current_sec)?;
        Ok(all.into_iter().find(|n| n.id == node_id))
    }

    pub fn insert_node(&self, node: &NodeRow) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO nodes (
                    id, name, group_name, tags_json, sort_order, token_sha256,
                    traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
                    hostname, os, kernel, arch, cpu_model, cpu_cores,
                    mem_total, swap_total, agent_version, proc_enabled,
                    mute_until, auto_update_override, caps_json, update_status_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
                params![
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
                    node.auto_update_override,
                    node.caps_json,
                    node.update_status_json,
                    node.created_at,
                    node.updated_at,
                ],
            )
            .map_err(|e| format!("insert_node error: {e}"))?;
            Ok(())
        })
    }

    pub fn ensure_self_probe_node(
        &self,
        node_id: &str,
        node_name: &str,
        hw: &NodeHardwareInfo,
        ts: i64,
    ) -> Result<(), String> {
        let dummy_hash = sha256_hex(format!("loopback:{node_id}").as_bytes());
        self.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO nodes (
                    id, name, group_name, tags_json, sort_order, token_sha256,
                    traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
                    hostname, os, kernel, arch, cpu_model, cpu_cores,
                    mem_total, swap_total, agent_version, proc_enabled,
                    mute_until, auto_update_override, caps_json, update_status_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, 'Hub', '[\"hub\"]', -100, ?3, NULL, 1, 'both',
                           ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, NULL, '[]', NULL, ?14, ?14)",
                params![
                    node_id,
                    node_name,
                    dummy_hash,
                    hw.hostname,
                    hw.os,
                    hw.kernel,
                    hw.arch,
                    hw.cpu_model,
                    hw.cpu_cores,
                    hw.mem_total,
                    hw.swap_total,
                    hw.agent_version,
                    if hw.proc_enabled { 1 } else { 0 },
                    ts,
                ],
            )
            .map_err(|e| format!("ensure_self_probe_node error: {e}"))?;
            Ok(())
        })
    }

    pub fn update_node_hello(
        &self,
        node_id: &str,
        hw: &NodeHardwareInfo,
        wall_sec: i64,
    ) -> Result<(), String> {
        self.update_node_hello_with_caps(node_id, hw, &[], wall_sec)
    }

    pub fn update_node_hello_with_caps(
        &self,
        node_id: &str,
        hw: &NodeHardwareInfo,
        caps: &[String],
        wall_sec: i64,
    ) -> Result<(), String> {
        let caps_json = serde_json::to_string(caps).unwrap_or_else(|_| "[]".to_string());
        self.with_conn(|c| {
            let tx = c
                .transaction()
                .map_err(|e| format!("update_node_hello tx error: {e}"))?;
            tx.execute(
                "UPDATE nodes SET
                    hostname = ?1, os = ?2, kernel = ?3, arch = ?4, cpu_model = ?5,
                    cpu_cores = ?6, mem_total = ?7, swap_total = ?8, agent_version = ?9,
                    proc_enabled = ?10, caps_json = ?11, updated_at = ?12
                 WHERE id = ?13",
                params![
                    hw.hostname,
                    hw.os,
                    hw.kernel,
                    hw.arch,
                    hw.cpu_model,
                    hw.cpu_cores,
                    hw.mem_total,
                    hw.swap_total,
                    hw.agent_version,
                    if hw.proc_enabled { 1 } else { 0 },
                    caps_json,
                    wall_sec,
                    node_id,
                ],
            )
            .map_err(|e| format!("update_node_hello update nodes: {e}"))?;

            tx.execute(
                "INSERT INTO node_state (node_id, last_seen_ts, online, updated_at)
                 VALUES (?1, ?2, 1, ?2)
                 ON CONFLICT(node_id) DO UPDATE SET
                   last_seen_ts = excluded.last_seen_ts,
                   online = 1,
                   updated_at = excluded.updated_at",
                params![node_id, wall_sec],
            )
            .map_err(|e| format!("update_node_hello node_state: {e}"))?;
            tx.commit()
                .map_err(|e| format!("update_node_hello commit: {e}"))?;
            Ok(())
        })
    }

    pub fn set_node_update_status(
        &self,
        node_id: &str,
        status: Option<&crate::protocol::NodeUpdateStatus>,
    ) -> Result<(), String> {
        let json_opt = status.and_then(|s| serde_json::to_string(s).ok());
        self.with_conn(|c| {
            c.execute(
                "UPDATE nodes SET update_status_json = ?1 WHERE id = ?2",
                params![json_opt, node_id],
            )
            .map_err(|e| format!("set_node_update_status error: {e}"))?;
            Ok(())
        })
    }

    pub fn agent_update_config(&self) -> Result<crate::agent_update::AgentUpdateConfig, String> {
        match self.get_setting(crate::agent_update::AGENT_UPDATE_CONFIG_SETTING)? {
            Some(raw) => serde_json::from_str(&raw).map_err(|e| {
                format!(
                    "Invalid persisted {} JSON: {e}",
                    crate::agent_update::AGENT_UPDATE_CONFIG_SETTING
                )
            }),
            None => Ok(crate::agent_update::AgentUpdateConfig::default()),
        }
    }

    pub fn set_agent_update_config(
        &self,
        cfg: &crate::agent_update::AgentUpdateConfig,
        ts: i64,
    ) -> Result<(), String> {
        let raw = serde_json::to_string(cfg)
            .map_err(|e| format!("serialize agent_update_config error: {e}"))?;
        self.set_setting(crate::agent_update::AGENT_UPDATE_CONFIG_SETTING, &raw, ts)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_metrics_batch(
        &self,
        node_id: &str,
        reset_day: i64,
        count_mode: &str,
        limit_bytes: Option<i64>,
        wall_sec: i64,
        pts: &[RawSlabSample],
        latest_payload: &NodeMetricsPayload,
        record_raw_points: bool,
    ) -> Result<(NodeTrafficSummary, bool), String> {
        self.with_conn(|c| {
            let tx = c
                .transaction()
                .map_err(|e| format!("record_metrics tx error: {e}"))?;

            let prev_ledger: Option<TrafficLedgerState> = tx
                .query_row(
                    "SELECT cycle_key, last_agent_rx, last_agent_tx, cycle_rx_bytes, cycle_tx_bytes, updated_at
                     FROM traffic_ledgers WHERE node_id = ?1",
                    params![node_id],
                    |r| {
                        Ok(TrafficLedgerState {
                            cycle_key: r.get(0)?,
                            last_agent_rx: r.get(1)?,
                            last_agent_tx: r.get(2)?,
                            cycle_rx_bytes: r.get(3)?,
                            cycle_tx_bytes: r.get(4)?,
                            updated_at: r.get(5)?,
                        })
                    },
                )
                .optional()
                .map_err(|e| format!("read traffic_ledgers: {e}"))?;

            let frame_ts = if latest_payload.ts > 0 {
                latest_payload.ts as i64
            } else {
                wall_sec
            };
            let adv = advance_traffic_ledger(
                prev_ledger.as_ref(),
                latest_payload.net.rx_tot,
                latest_payload.net.tx_tot,
                frame_ts,
                reset_day,
            );
            tx.execute(
                "INSERT INTO traffic_ledgers (
                    node_id, cycle_key, last_agent_rx, last_agent_tx, cycle_rx_bytes, cycle_tx_bytes, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(node_id) DO UPDATE SET
                   cycle_key = excluded.cycle_key,
                   last_agent_rx = excluded.last_agent_rx,
                   last_agent_tx = excluded.last_agent_tx,
                   cycle_rx_bytes = excluded.cycle_rx_bytes,
                   cycle_tx_bytes = excluded.cycle_tx_bytes,
                   updated_at = excluded.updated_at",
                params![
                    node_id,
                    adv.next.cycle_key,
                    adv.next.last_agent_rx,
                    adv.next.last_agent_tx,
                    adv.next.cycle_rx_bytes,
                    adv.next.cycle_tx_bytes,
                    adv.next.updated_at,
                ],
            )
            .map_err(|e| format!("upsert traffic_ledgers: {e}"))?;

            let existing_state: Option<(i64, i64, Option<String>, Option<String>)> = tx
                .query_row(
                    "SELECT last_raw_write_ts, online, welford_5m_json, welford_1h_json
                     FROM node_state WHERE node_id = ?1",
                    params![node_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(|e| format!("read node_state: {e}"))?;

            let mut last_raw_write_ts = existing_state.as_ref().map(|s| s.0).unwrap_or(0);
            let was_offline = existing_state.as_ref().map(|s| s.1 == 0).unwrap_or(true);
            let mut w5: Option<Welford5mAccumulator> = existing_state
                .as_ref()
                .and_then(|s| s.2.as_deref())
                .and_then(|j| serde_json::from_str(j).ok());
            let mut w1: Option<Welford1hAccumulator> = existing_state
                .as_ref()
                .and_then(|s| s.3.as_deref())
                .and_then(|j| serde_json::from_str(j).ok());

            if record_raw_points && !pts.is_empty() {
                // Group samples into 10-minute Ring-Slab chunks
                let mut grouped_10m: BTreeMap<i64, Vec<&RawSlabSample>> = BTreeMap::new();
                for sample in pts {
                    let b10m = (sample.ts / 600) * 600;
                    grouped_10m.entry(b10m).or_default().push(sample);

                    if sample.ts > last_raw_write_ts {
                        last_raw_write_ts = sample.ts;
                    }

                    // Advance 5m & 1h Welford rollups chronologically
                    let b5m = (sample.ts / 300) * 300;
                    match w5.as_mut() {
                        Some(acc) if acc.bucket_ts == b5m => acc.update(sample),
                        Some(acc) if b5m > acc.bucket_ts => {
                            let finalized_5m = acc.to_rollup();
                            append_5m_rollup_to_slab(&tx, node_id, &finalized_5m)?;
                            let b1h = (finalized_5m.ts / 3600) * 3600;
                            match w1.as_mut() {
                                Some(acc1h) if acc1h.bucket_ts == b1h => {
                                    acc1h.update_5m(&finalized_5m);
                                }
                                Some(acc1h) if b1h > acc1h.bucket_ts => {
                                    let finalized_1h = acc1h.to_rollup();
                                    append_1h_rollup_to_slab(&tx, node_id, &finalized_1h)?;
                                    *acc1h = Welford1hAccumulator::from_5m(b1h, &finalized_5m);
                                }
                                None => {
                                    w1 = Some(Welford1hAccumulator::from_5m(b1h, &finalized_5m));
                                }
                                Some(_) => {}
                            }
                            *acc = Welford5mAccumulator::from_sample(b5m, sample);
                        }
                        None => {
                            w5 = Some(Welford5mAccumulator::from_sample(b5m, sample));
                        }
                        Some(_) => {
                            // Out-of-order historical backfill older than current 5m bucket: ignore for live Welford
                        }
                    }
                }

                for (bucket_ts, batch) in grouped_10m {
                    append_raw_samples_to_slab(&tx, node_id, bucket_ts, &batch)?;
                }
            }

            let last_metrics_json = serde_json::to_string(latest_payload)
                .map_err(|e| format!("serialize metrics: {e}"))?;
            let w5_json = w5.as_ref().and_then(|v| serde_json::to_string(v).ok());
            let w1_json = w1.as_ref().and_then(|v| serde_json::to_string(v).ok());

            tx.execute(
                "INSERT INTO node_state (
                    node_id, last_seen_ts, last_raw_write_ts, online, uptime_sec,
                    last_metrics_json, welford_5m_json, welford_1h_json, updated_at
                 ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?2)
                 ON CONFLICT(node_id) DO UPDATE SET
                   last_seen_ts = excluded.last_seen_ts,
                   last_raw_write_ts = MAX(node_state.last_raw_write_ts, excluded.last_raw_write_ts),
                   online = 1,
                   uptime_sec = excluded.uptime_sec,
                   last_metrics_json = excluded.last_metrics_json,
                   welford_5m_json = COALESCE(excluded.welford_5m_json, node_state.welford_5m_json),
                   welford_1h_json = COALESCE(excluded.welford_1h_json, node_state.welford_1h_json),
                   updated_at = excluded.updated_at",
                params![
                    node_id,
                    wall_sec,
                    last_raw_write_ts,
                    latest_payload.up as i64,
                    last_metrics_json,
                    w5_json,
                    w1_json,
                ],
            )
            .map_err(|e| format!("upsert node_state: {e}"))?;

            tx.commit()
                .map_err(|e| format!("record_metrics commit error: {e}"))?;

            let (_, days_remaining) = compute_traffic_cycle(wall_sec, reset_day);
            let counted_bytes = compute_counted_bytes(
                adv.next.cycle_rx_bytes,
                adv.next.cycle_tx_bytes,
                count_mode,
            );

            Ok((
                NodeTrafficSummary {
                    limit_bytes,
                    reset_day,
                    count_mode: count_mode.to_string(),
                    cycle_key: adv.next.cycle_key,
                    rx_bytes: adv.next.cycle_rx_bytes,
                    tx_bytes: adv.next.cycle_tx_bytes,
                    counted_bytes,
                    days_remaining,
                },
                was_offline,
            ))
        })
    }

    pub fn last_raw_write_ts(&self, node_id: &str) -> Result<i64, String> {
        self.with_conn(|c| {
            Ok(c.query_row(
                "SELECT last_raw_write_ts FROM node_state WHERE node_id = ?1",
                params![node_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| format!("last_raw_write_ts error: {e}"))?
            .unwrap_or(0))
        })
    }

    pub fn query_metrics(
        &self,
        node_id: &str,
        range: &str,
        current_sec: i64,
    ) -> Result<MetricsQueryResponse, String> {
        self.with_conn(|c| {
            let (resolution, points) = match range {
                "1h" | "24h" => {
                    let window_sec = if range == "1h" { 3_600 } else { 86_400 };
                    let cutoff = current_sec - window_sec;
                    let mut stmt = c
                        .prepare(
                            "SELECT bucket_ts, payload FROM metrics_chunk_10m
                             WHERE node_id = ?1 AND bucket_ts >= ?2
                             ORDER BY bucket_ts ASC",
                        )
                        .map_err(|e| format!("query 10m slab error: {e}"))?;
                    let bucket_cutoff = (cutoff / 600) * 600;
                    let rows = stmt
                        .query_map(params![node_id, bucket_cutoff], |r| r.get::<_, Vec<u8>>(1))
                        .map_err(|e| format!("query 10m rows error: {e}"))?;
                    let mut pts = Vec::new();
                    for r in rows {
                        let blob = r.map_err(|e| format!("row blob error: {e}"))?;
                        for s in RawSlabSample::read_le_slice(&blob) {
                            if s.ts >= cutoff {
                                pts.push(s.to_query_point());
                            }
                        }
                    }
                    pts.sort_by_key(|p| p.ts);
                    ("30s", pts)
                }
                "7d" | "30d" => {
                    let window_sec = if range == "7d" {
                        7 * 86_400
                    } else {
                        30 * 86_400
                    };
                    let cutoff = current_sec - window_sec;
                    let bucket_cutoff = (cutoff / 3600) * 3600;
                    let mut stmt = c
                        .prepare(
                            "SELECT payload FROM metrics_5m_chunk_1h
                             WHERE node_id = ?1 AND bucket_ts >= ?2
                             ORDER BY bucket_ts ASC",
                        )
                        .map_err(|e| format!("query 5m slab error: {e}"))?;
                    let rows = stmt
                        .query_map(params![node_id, bucket_cutoff], |r| r.get::<_, Vec<u8>>(0))
                        .map_err(|e| format!("query 5m rows error: {e}"))?;
                    let mut pts = Vec::new();
                    for r in rows {
                        let blob = r.map_err(|e| format!("5m blob error: {e}"))?;
                        for s in Rollup5mSample::read_le_slice(&blob) {
                            if s.ts >= cutoff {
                                pts.push(s.to_query_point());
                            }
                        }
                    }
                    if let Some(w5_json) = c
                        .query_row(
                            "SELECT welford_5m_json FROM node_state WHERE node_id = ?1",
                            params![node_id],
                            |r| r.get::<_, Option<String>>(0),
                        )
                        .optional()
                        .map_err(|e| format!("welford_5m read error: {e}"))?
                        .flatten()
                    {
                        if let Ok(acc) = serde_json::from_str::<Welford5mAccumulator>(&w5_json) {
                            if acc.bucket_ts >= cutoff && !pts.iter().any(|p| p.ts == acc.bucket_ts)
                            {
                                pts.push(acc.to_rollup().to_query_point());
                            }
                        }
                    }
                    pts.sort_by_key(|p| p.ts);
                    ("5m", pts)
                }
                _ => {
                    let window_sec = 365 * 86_400;
                    let cutoff = current_sec - window_sec;
                    let bucket_cutoff = (cutoff / 86_400) * 86_400;
                    let mut stmt = c
                        .prepare(
                            "SELECT payload FROM metrics_1h_chunk_1d
                             WHERE node_id = ?1 AND bucket_ts >= ?2
                             ORDER BY bucket_ts ASC",
                        )
                        .map_err(|e| format!("query 1h slab error: {e}"))?;
                    let rows = stmt
                        .query_map(params![node_id, bucket_cutoff], |r| r.get::<_, Vec<u8>>(0))
                        .map_err(|e| format!("query 1h rows error: {e}"))?;
                    let mut pts = Vec::new();
                    for r in rows {
                        let blob = r.map_err(|e| format!("1h blob error: {e}"))?;
                        for s in Rollup1hSample::read_le_slice(&blob) {
                            if s.ts >= cutoff {
                                pts.push(s.to_query_point());
                            }
                        }
                    }
                    if let Some(w1_json) = c
                        .query_row(
                            "SELECT welford_1h_json FROM node_state WHERE node_id = ?1",
                            params![node_id],
                            |r| r.get::<_, Option<String>>(0),
                        )
                        .optional()
                        .map_err(|e| format!("welford_1h read error: {e}"))?
                        .flatten()
                    {
                        if let Ok(acc) = serde_json::from_str::<Welford1hAccumulator>(&w1_json) {
                            if acc.bucket_ts >= cutoff && !pts.iter().any(|p| p.ts == acc.bucket_ts)
                            {
                                pts.push(acc.to_rollup().to_query_point());
                            }
                        }
                    }
                    pts.sort_by_key(|p| p.ts);
                    ("1h", pts)
                }
            };

            Ok(MetricsQueryResponse {
                node_id: node_id.to_string(),
                range: range.to_string(),
                resolution: resolution.to_string(),
                points,
            })
        })
    }

    pub fn mark_node_offline(&self, node_id: &str, wall_sec: i64) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE node_state SET online = 0, updated_at = ?2 WHERE node_id = ?1",
                params![node_id, wall_sec],
            )
            .map_err(|e| format!("mark_node_offline error: {e}"))?;
            Ok(())
        })
    }

    pub fn list_online_node_heartbeats(&self) -> Result<Vec<(String, Option<i64>)>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare("SELECT node_id, last_seen_ts FROM node_state WHERE online = 1")
                .map_err(|e| format!("list_online_node_heartbeats prepare: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
                })
                .map_err(|e| format!("list_online_node_heartbeats query: {e}"))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| format!("heartbeat row error: {e}"))?);
            }
            Ok(out)
        })
    }

    pub fn list_channels(&self) -> Result<Vec<NotificationChannelRow>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT id, name, type, enabled, config_json, created_at
                     FROM notification_channels ORDER BY created_at ASC",
                )
                .map_err(|e| format!("list_channels error: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(NotificationChannelRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        channel_type: r.get(2)?,
                        enabled: r.get(3)?,
                        config_json: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                })
                .map_err(|e| format!("list_channels query: {e}"))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| format!("channel row error: {e}"))?);
            }
            Ok(out)
        })
    }

    pub fn list_rules(&self) -> Result<Vec<AlertRuleRow>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT id, name, node_id, metric, operator, threshold,
                            duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
                     FROM alert_rules ORDER BY created_at ASC",
                )
                .map_err(|e| format!("list_rules error: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(AlertRuleRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        node_id: r.get(2)?,
                        metric: r.get(3)?,
                        operator: r.get(4)?,
                        threshold: r.get(5)?,
                        duration_sec: r.get(6)?,
                        cooldown_sec: r.get(7)?,
                        channel_ids_json: r.get(8)?,
                        enabled: r.get(9)?,
                        created_at: r.get(10)?,
                    })
                })
                .map_err(|e| format!("list_rules query: {e}"))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| format!("rule row error: {e}"))?);
            }
            Ok(out)
        })
    }

    pub fn count_firing_incidents(&self) -> Result<usize, String> {
        self.with_conn(|c| {
            let cnt: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM alert_incidents WHERE status = 'firing'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| format!("count_firing_incidents error: {e}"))?;
            Ok(cnt.max(0) as usize)
        })
    }

    pub fn load_rule_states(&self, node_id: &str) -> Result<Vec<AlertRuleRuntimeState>, String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare(
                    "SELECT rule_id, state, first_breach_ts, last_notified_ts,
                            recover_ok_count, incident_id, started_at
                     FROM alert_rule_states WHERE node_id = ?1",
                )
                .map_err(|e| format!("load_rule_states prepare: {e}"))?;
            let rows = stmt
                .query_map(params![node_id], |r| {
                    Ok(AlertRuleRuntimeState {
                        rule_id: r.get(0)?,
                        state: r.get(1)?,
                        first_breach_ts: r.get(2)?,
                        last_notified_ts: r.get(3)?,
                        recover_ok_count: r.get(4)?,
                        incident_id: r.get(5)?,
                        started_at: r.get(6)?,
                    })
                })
                .map_err(|e| format!("load_rule_states query: {e}"))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| format!("rule_state row error: {e}"))?);
            }
            Ok(out)
        })
    }

    pub fn save_rule_state(&self, node_id: &str, st: &AlertRuleRuntimeState) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO alert_rule_states (
                    node_id, rule_id, state, first_breach_ts, last_notified_ts,
                    recover_ok_count, incident_id, started_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(node_id, rule_id) DO UPDATE SET
                   state = excluded.state,
                   first_breach_ts = excluded.first_breach_ts,
                   last_notified_ts = excluded.last_notified_ts,
                   recover_ok_count = excluded.recover_ok_count,
                   incident_id = excluded.incident_id,
                   started_at = excluded.started_at",
                params![
                    node_id,
                    st.rule_id,
                    st.state,
                    st.first_breach_ts,
                    st.last_notified_ts,
                    st.recover_ok_count,
                    st.incident_id,
                    st.started_at,
                ],
            )
            .map_err(|e| format!("save_rule_state error: {e}"))?;
            Ok(())
        })
    }

    pub fn delete_rule_state(&self, node_id: &str, rule_id: &str) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "DELETE FROM alert_rule_states WHERE node_id = ?1 AND rule_id = ?2",
                params![node_id, rule_id],
            )
            .map_err(|e| format!("delete_rule_state error: {e}"))?;
            Ok(())
        })
    }

    pub fn record_incident_firing(&self, inc: &AlertIncidentRow) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "INSERT OR REPLACE INTO alert_incidents (
                    id, node_id, node_name, rule_id, metric, status,
                    trigger_value, threshold, message, started_at, resolved_at, last_notified_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'firing', ?6, ?7, ?8, ?9, NULL, ?10)",
                params![
                    inc.id,
                    inc.node_id,
                    inc.node_name,
                    inc.rule_id,
                    inc.metric,
                    inc.trigger_value,
                    inc.threshold,
                    inc.message,
                    inc.started_at,
                    inc.last_notified_at,
                ],
            )
            .map_err(|e| format!("record_incident_firing error: {e}"))?;
            Ok(())
        })
    }

    pub fn record_incident_renotify(&self, incident_id: &str, now: i64) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE alert_incidents SET last_notified_at = ?1 WHERE id = ?2",
                params![now, incident_id],
            )
            .map_err(|e| format!("record_incident_renotify error: {e}"))?;
            Ok(())
        })
    }

    pub fn record_incident_resolved(
        &self,
        incident_id: &str,
        resolved_at: i64,
    ) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE alert_incidents SET status = 'resolved', resolved_at = ?1, last_notified_at = ?1
                 WHERE id = ?2",
                params![resolved_at, incident_id],
            )
            .map_err(|e| format!("record_incident_resolved error: {e}"))?;
            Ok(())
        })
    }

    pub fn resolve_incidents_for_deleted_rule(
        &self,
        rule_id: &str,
        resolved_at: i64,
    ) -> Result<(), String> {
        self.with_conn(|c| {
            c.execute(
                "UPDATE alert_incidents SET status = 'resolved', resolved_at = ?1
                 WHERE rule_id = ?2 AND status = 'firing'",
                params![resolved_at, rule_id],
            )
            .map_err(|e| format!("resolve_incidents_for_deleted_rule error: {e}"))?;
            Ok(())
        })
    }

    pub fn export_bundle(&self, exported_at: i64) -> Result<ExportBundle, String> {
        self.with_conn(|c| {
            let mut n_stmt = c
                .prepare(
                    "SELECT id, name, group_name, tags_json, sort_order, token_sha256,
                            traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
                            hostname, os, kernel, arch, cpu_model, cpu_cores,
                            mem_total, swap_total, agent_version, proc_enabled,
                            mute_until, auto_update_override, caps_json, update_status_json,
                            created_at, updated_at
                     FROM nodes ORDER BY sort_order ASC, created_at ASC",
                )
                .map_err(|e| format!("export nodes prepare: {e}"))?;
            let nodes: Vec<NodeRow> = n_stmt
                .query_map([], map_node_row)
                .map_err(|e| format!("export nodes query: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("export nodes row: {e}"))?;

            let mut c_stmt = c
                .prepare(
                    "SELECT id, name, type, enabled, config_json, created_at
                     FROM notification_channels ORDER BY created_at ASC",
                )
                .map_err(|e| format!("export channels prepare: {e}"))?;
            let notification_channels: Vec<NotificationChannelRow> = c_stmt
                .query_map([], |r| {
                    Ok(NotificationChannelRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        channel_type: r.get(2)?,
                        enabled: r.get(3)?,
                        config_json: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                })
                .map_err(|e| format!("export channels query: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("export channels row: {e}"))?;

            let mut r_stmt = c
                .prepare(
                    "SELECT id, name, node_id, metric, operator, threshold,
                            duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
                     FROM alert_rules ORDER BY created_at ASC",
                )
                .map_err(|e| format!("export rules prepare: {e}"))?;
            let alert_rules: Vec<AlertRuleRow> = r_stmt
                .query_map([], |r| {
                    Ok(AlertRuleRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        node_id: r.get(2)?,
                        metric: r.get(3)?,
                        operator: r.get(4)?,
                        threshold: r.get(5)?,
                        duration_sec: r.get(6)?,
                        cooldown_sec: r.get(7)?,
                        channel_ids_json: r.get(8)?,
                        enabled: r.get(9)?,
                        created_at: r.get(10)?,
                    })
                })
                .map_err(|e| format!("export rules query: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("export rules row: {e}"))?;

            let mut s_stmt = c
                .prepare(
                    "SELECT key, value, updated_at FROM system_settings
                     WHERE key NOT IN (
                         'watchdog_state',
                         'imported_bundle_sha256',
                         'migration_pull_ticket',
                         'migration_receive_ticket',
                         'migration_paired_token'
                     )
                     ORDER BY key ASC",
                )
                .map_err(|e| format!("export settings prepare: {e}"))?;
            let system_settings: Vec<ExportSystemSettingEntry> = s_stmt
                .query_map([], |r| {
                    Ok(ExportSystemSettingEntry {
                        key: r.get(0)?,
                        value: r.get(1)?,
                        updated_at: r.get(2)?,
                    })
                })
                .map_err(|e| format!("export settings query: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("export settings row: {e}"))?;

            let mut t_stmt = c
                .prepare(
                    "SELECT node_id, cycle_key, last_agent_rx, last_agent_tx,
                            cycle_rx_bytes, cycle_tx_bytes, updated_at
                     FROM traffic_ledgers ORDER BY node_id ASC",
                )
                .map_err(|e| format!("export ledgers prepare: {e}"))?;
            let traffic_ledgers: Vec<ExportTrafficLedgerEntry> = t_stmt
                .query_map([], |r| {
                    Ok(ExportTrafficLedgerEntry {
                        node_id: r.get(0)?,
                        cycle_key: r.get(1)?,
                        last_agent_rx: r.get(2)?,
                        last_agent_tx: r.get(3)?,
                        cycle_rx_bytes: r.get(4)?,
                        cycle_tx_bytes: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                })
                .map_err(|e| format!("export ledgers query: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("export ledgers row: {e}"))?;

            Ok(ExportBundle {
                version: 1,
                exported_at,
                nodes,
                notification_channels,
                alert_rules,
                system_settings,
                traffic_ledgers,
            })
        })
    }

    pub fn import_bundle(
        &self,
        bundle: &ImportBundlePayload,
        ts: i64,
    ) -> Result<ImportBundleResponse, String> {
        self.import_bundle_with_options(bundle, ts, false)
    }

    pub fn import_bundle_with_options(
        &self,
        bundle: &ImportBundlePayload,
        ts: i64,
        allow_receive_ticket: bool,
    ) -> Result<ImportBundleResponse, String> {
        self.with_conn(|c| {
            let tx = c
                .transaction()
                .map_err(|e| format!("import_bundle tx error: {e}"))?;

            let mut nodes_count = 0usize;
            for n in &bundle.nodes {
                tx.execute(
                    "INSERT INTO nodes (
                        id, name, group_name, tags_json, sort_order, token_sha256,
                        traffic_limit_bytes, traffic_reset_day, traffic_count_mode,
                        hostname, os, kernel, arch, cpu_model, cpu_cores,
                        mem_total, swap_total, agent_version, proc_enabled,
                        mute_until, auto_update_override, caps_json, update_status_json,
                        created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name,
                       group_name = excluded.group_name,
                       tags_json = excluded.tags_json,
                       sort_order = excluded.sort_order,
                       token_sha256 = excluded.token_sha256,
                       traffic_limit_bytes = excluded.traffic_limit_bytes,
                       traffic_reset_day = excluded.traffic_reset_day,
                       traffic_count_mode = excluded.traffic_count_mode,
                       hostname = excluded.hostname,
                       os = excluded.os,
                       kernel = excluded.kernel,
                       arch = excluded.arch,
                       cpu_model = excluded.cpu_model,
                       cpu_cores = excluded.cpu_cores,
                       mem_total = excluded.mem_total,
                       swap_total = excluded.swap_total,
                       agent_version = excluded.agent_version,
                       proc_enabled = excluded.proc_enabled,
                       mute_until = excluded.mute_until,
                       auto_update_override = excluded.auto_update_override,
                       caps_json = excluded.caps_json,
                       update_status_json = excluded.update_status_json,
                       updated_at = excluded.updated_at",
                    params![
                        n.id,
                        n.name,
                        n.group_name,
                        n.tags_json,
                        n.sort_order,
                        n.token_sha256,
                        n.traffic_limit_bytes,
                        n.traffic_reset_day,
                        n.traffic_count_mode,
                        n.hostname,
                        n.os,
                        n.kernel,
                        n.arch,
                        n.cpu_model,
                        n.cpu_cores,
                        n.mem_total,
                        n.swap_total,
                        n.agent_version,
                        n.proc_enabled,
                        n.mute_until,
                        n.auto_update_override,
                        n.caps_json,
                        n.update_status_json,
                        n.created_at,
                        n.updated_at,
                    ],
                )
                .map_err(|e| format!("import node {} error: {e}", n.id))?;
                nodes_count += 1;
            }

            let mut channels_count = 0usize;
            for ch in &bundle.notification_channels {
                tx.execute(
                    "INSERT INTO notification_channels (id, name, type, enabled, config_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name,
                       type = excluded.type,
                       enabled = excluded.enabled,
                       config_json = excluded.config_json",
                    params![
                        ch.id,
                        ch.name,
                        ch.channel_type,
                        ch.enabled,
                        ch.config_json,
                        ch.created_at,
                    ],
                )
                .map_err(|e| format!("import channel {} error: {e}", ch.id))?;
                channels_count += 1;
            }

            let mut rules_count = 0usize;
            for r in &bundle.alert_rules {
                tx.execute(
                    "INSERT INTO alert_rules (
                        id, name, node_id, metric, operator, threshold,
                        duration_sec, cooldown_sec, channel_ids_json, enabled, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name,
                       node_id = excluded.node_id,
                       metric = excluded.metric,
                       operator = excluded.operator,
                       threshold = excluded.threshold,
                       duration_sec = excluded.duration_sec,
                       cooldown_sec = excluded.cooldown_sec,
                       channel_ids_json = excluded.channel_ids_json,
                       enabled = excluded.enabled",
                    params![
                        r.id,
                        r.name,
                        r.node_id,
                        r.metric,
                        r.operator,
                        r.threshold,
                        r.duration_sec,
                        r.cooldown_sec,
                        r.channel_ids_json,
                        r.enabled,
                        r.created_at,
                    ],
                )
                .map_err(|e| format!("import rule {} error: {e}", r.id))?;
                rules_count += 1;
            }

            let settings_entries: Vec<ExportSystemSettingEntry> = match &bundle.system_settings {
                ImportSystemSettingsInput::List(v) => v.clone(),
                ImportSystemSettingsInput::Map(m) => m
                    .iter()
                    .map(|(k, v)| match v {
                        SystemSettingMapValue::Plain(val) => ExportSystemSettingEntry {
                            key: k.clone(),
                            value: val.clone(),
                            updated_at: ts,
                        },
                        SystemSettingMapValue::Obj { value, updated_at } => {
                            ExportSystemSettingEntry {
                                key: k.clone(),
                                value: value.clone(),
                                updated_at: updated_at.unwrap_or(ts),
                            }
                        }
                    })
                    .collect(),
            };

            for mut s in settings_entries {
                if let Some(value) = crate::network_quality_store::normalize_setting(&s.key, &s.value)? {
                    if let Some(node_id) = s.key.strip_prefix(crate::network_quality_store::NODE_PREFIX) {
                        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?1)", [node_id], |r| r.get(0))
                            .map_err(|e| e.to_string())?;
                        if !exists { return Err("Network configuration refers to an unknown node".into()); }
                    }
                    s.value = value;
                }
                if let Some(value) = crate::agent_update::normalize_setting(&s.key, &s.value)? {
                    s.value = value;
                }
                if matches!(
                    s.key.as_str(),
                    "watchdog_state"
                        | "imported_bundle_sha256"
                        | "migration_pull_ticket"
                        | "migration_paired_token"
                ) || (!allow_receive_ticket && s.key == "migration_receive_ticket")
                {
                    continue;
                }
                if s.key == "admin_password_hash" || s.key == "session_secret" {
                    tx.execute(
                        "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                        params![s.key, s.value, s.updated_at],
                    )
                    .map_err(|e| format!("import setting {} error: {e}", s.key))?;
                } else {
                    tx.execute(
                        "INSERT INTO system_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        params![s.key, s.value, s.updated_at],
                    )
                    .map_err(|e| format!("import setting {} error: {e}", s.key))?;
                }
            }

            let ledger_entries: Vec<ExportTrafficLedgerEntry> = match &bundle.traffic_ledgers {
                ImportTrafficLedgersInput::List(v) => v.clone(),
                ImportTrafficLedgersInput::Map(m) => m
                    .iter()
                    .map(|(node_id, v)| ExportTrafficLedgerEntry {
                        node_id: node_id.clone(),
                        cycle_key: v.cycle_key.clone(),
                        last_agent_rx: v.last_agent_rx,
                        last_agent_tx: v.last_agent_tx,
                        cycle_rx_bytes: v.cycle_rx_bytes,
                        cycle_tx_bytes: v.cycle_tx_bytes,
                        updated_at: v.updated_at.unwrap_or(ts),
                    })
                    .collect(),
            };

            let mut ledgers_count = 0usize;
            for l in ledger_entries {
                tx.execute(
                    "INSERT INTO traffic_ledgers (
                        node_id, cycle_key, last_agent_rx, last_agent_tx,
                        cycle_rx_bytes, cycle_tx_bytes, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(node_id) DO UPDATE SET
                       cycle_key = excluded.cycle_key,
                       last_agent_rx = excluded.last_agent_rx,
                       last_agent_tx = excluded.last_agent_tx,
                       cycle_rx_bytes = excluded.cycle_rx_bytes,
                       cycle_tx_bytes = excluded.cycle_tx_bytes,
                       updated_at = excluded.updated_at",
                    params![
                        l.node_id,
                        l.cycle_key,
                        l.last_agent_rx,
                        l.last_agent_tx,
                        l.cycle_rx_bytes,
                        l.cycle_tx_bytes,
                        l.updated_at,
                    ],
                )
                .map_err(|e| format!("import traffic ledger {} error: {e}", l.node_id))?;
                ledgers_count += 1;
            }

            tx.commit()
                .map_err(|e| format!("import_bundle commit error: {e}"))?;

            Ok(ImportBundleResponse {
                ok: true,
                imported: ImportCounts {
                    nodes: nodes_count,
                    channels: channels_count,
                    rules: rules_count,
                    traffic_ledgers: ledgers_count,
                },
            })
        })
    }

    pub fn import_bundle_file_idempotent(&self, path: &Path) -> Result<bool, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read bundle file {}: {e}", path.display()))?;
        let digest_hex = sha256_hex(raw.as_bytes());
        if let Some(prev) = self.get_setting("imported_bundle_sha256")? {
            if prev == digest_hex {
                return Ok(false);
            }
        }
        let payload: ImportBundlePayload = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid bundle JSON in {}: {e}", path.display()))?;
        let ts = now_sec();
        self.import_bundle_with_options(&payload, ts, true)?;
        self.set_setting("imported_bundle_sha256", &digest_hex, ts)?;
        Ok(true)
    }
}

fn append_raw_samples_to_slab(
    tx: &rusqlite::Transaction<'_>,
    node_id: &str,
    bucket_ts: i64,
    batch: &[&RawSlabSample],
) -> Result<(), String> {
    let slot = (bucket_ts / 600).rem_euclid(SLAB_10M_SLOTS);
    let existing: Option<(i64, Vec<u8>)> = tx
        .query_row(
            "SELECT bucket_ts, payload FROM metrics_chunk_10m WHERE node_id = ?1 AND slot = ?2",
            params![node_id, slot],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("read 10m slab error: {e}"))?;

    let mut samples = match existing {
        Some((prev_bucket, blob)) if prev_bucket == bucket_ts => {
            RawSlabSample::read_le_slice(&blob)
        }
        _ => Vec::new(),
    };

    for &s in batch {
        if let Some(pos) = samples.iter().position(|x| x.ts == s.ts) {
            samples[pos] = s.clone();
        } else {
            samples.push(s.clone());
        }
    }
    samples.sort_by_key(|s| s.ts);
    if samples.len() > MAX_POINTS_PER_10M_CHUNK {
        let excess = samples.len() - MAX_POINTS_PER_10M_CHUNK;
        samples.drain(0..excess);
    }

    let mut payload = Vec::with_capacity(samples.len() * RAW_SAMPLE_BYTES);
    for s in &samples {
        s.write_le(&mut payload);
    }
    tx.execute(
        "INSERT OR REPLACE INTO metrics_chunk_10m (node_id, slot, bucket_ts, payload)
         VALUES (?1, ?2, ?3, ?4)",
        params![node_id, slot, bucket_ts, payload],
    )
    .map_err(|e| format!("write 10m slab error: {e}"))?;
    Ok(())
}

fn append_5m_rollup_to_slab(
    tx: &rusqlite::Transaction<'_>,
    node_id: &str,
    sample: &Rollup5mSample,
) -> Result<(), String> {
    let bucket_ts = (sample.ts / 3600) * 3600;
    let slot = (bucket_ts / 3600).rem_euclid(SLAB_1H_SLOTS);
    let existing: Option<(i64, Vec<u8>)> = tx
        .query_row(
            "SELECT bucket_ts, payload FROM metrics_5m_chunk_1h WHERE node_id = ?1 AND slot = ?2",
            params![node_id, slot],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("read 5m slab error: {e}"))?;

    let mut items = match existing {
        Some((prev_bucket, blob)) if prev_bucket == bucket_ts => {
            Rollup5mSample::read_le_slice(&blob)
        }
        _ => Vec::new(),
    };
    if let Some(pos) = items.iter().position(|x| x.ts == sample.ts) {
        items[pos] = sample.clone();
    } else {
        items.push(sample.clone());
    }
    items.sort_by_key(|x| x.ts);
    if items.len() > 16 {
        let excess = items.len() - 16;
        items.drain(0..excess);
    }

    let mut payload = Vec::with_capacity(items.len() * ROLLUP_5M_BYTES);
    for item in &items {
        item.write_le(&mut payload);
    }
    tx.execute(
        "INSERT OR REPLACE INTO metrics_5m_chunk_1h (node_id, slot, bucket_ts, payload)
         VALUES (?1, ?2, ?3, ?4)",
        params![node_id, slot, bucket_ts, payload],
    )
    .map_err(|e| format!("write 5m slab error: {e}"))?;
    Ok(())
}

fn append_1h_rollup_to_slab(
    tx: &rusqlite::Transaction<'_>,
    node_id: &str,
    sample: &Rollup1hSample,
) -> Result<(), String> {
    let bucket_ts = (sample.ts / 86_400) * 86_400;
    let slot = (bucket_ts / 86_400).rem_euclid(SLAB_1D_SLOTS);
    let existing: Option<(i64, Vec<u8>)> = tx
        .query_row(
            "SELECT bucket_ts, payload FROM metrics_1h_chunk_1d WHERE node_id = ?1 AND slot = ?2",
            params![node_id, slot],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("read 1h slab error: {e}"))?;

    let mut items = match existing {
        Some((prev_bucket, blob)) if prev_bucket == bucket_ts => {
            Rollup1hSample::read_le_slice(&blob)
        }
        _ => Vec::new(),
    };
    if let Some(pos) = items.iter().position(|x| x.ts == sample.ts) {
        items[pos] = sample.clone();
    } else {
        items.push(sample.clone());
    }
    items.sort_by_key(|x| x.ts);
    if items.len() > 32 {
        let excess = items.len() - 32;
        items.drain(0..excess);
    }

    let mut payload = Vec::with_capacity(items.len() * ROLLUP_1H_BYTES);
    for item in &items {
        item.write_le(&mut payload);
    }
    tx.execute(
        "INSERT OR REPLACE INTO metrics_1h_chunk_1d (node_id, slot, bucket_ts, payload)
         VALUES (?1, ?2, ?3, ?4)",
        params![node_id, slot, bucket_ts, payload],
    )
    .map_err(|e| format!("write 1h slab error: {e}"))?;
    Ok(())
}

fn ensure_node_column(conn: &Connection, col: &str, def: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(nodes)")
        .map_err(|e| format!("PRAGMA table_info(nodes) error: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("PRAGMA table_info(nodes) query error: {e}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("PRAGMA table_info(nodes) row error: {e}"))?
    {
        let name: String = row.get(1).unwrap_or_default();
        if name == col {
            return Ok(());
        }
    }
    conn.execute(&format!("ALTER TABLE nodes ADD COLUMN {col} {def}"), [])
        .map_err(|e| format!("ALTER TABLE nodes ADD COLUMN {col} error: {e}"))?;
    Ok(())
}

fn map_node_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<NodeRow> {
    Ok(NodeRow {
        id: r.get(0)?,
        name: r.get(1)?,
        group_name: r.get(2)?,
        tags_json: r.get(3)?,
        sort_order: r.get(4)?,
        token_sha256: r.get(5)?,
        traffic_limit_bytes: r.get(6)?,
        traffic_reset_day: r.get(7)?,
        traffic_count_mode: r.get(8)?,
        hostname: r.get(9)?,
        os: r.get(10)?,
        kernel: r.get(11)?,
        arch: r.get(12)?,
        cpu_model: r.get(13)?,
        cpu_cores: r.get(14)?,
        mem_total: r.get(15)?,
        swap_total: r.get(16)?,
        agent_version: r.get(17)?,
        proc_enabled: r.get(18)?,
        mute_until: r.get(19)?,
        auto_update_override: r.get(20)?,
        caps_json: r.get(21)?,
        update_status_json: r.get(22)?,
        created_at: r.get(23)?,
        updated_at: r.get(24)?,
    })
}

pub fn payload_to_raw_sample(p: &NodeMetricsPayload) -> RawSlabSample {
    let (disk_used, disk_r_bps, disk_w_bps) = p.disks.iter().fold((0u64, 0u64, 0u64), |acc, d| {
        (
            acc.0.saturating_add(d.used),
            acc.1.saturating_add(d.r_bps),
            acc.2.saturating_add(d.w_bps),
        )
    });
    RawSlabSample {
        ts: p.ts as i64,
        cpu: p.cpu.all,
        steal: p.cpu.steal,
        load1: p.cpu.load.first().copied().unwrap_or(0.0),
        mem_used: p.mem.used as f64,
        swap_used: p.mem.swap_used as f64,
        disk_used: disk_used as f64,
        disk_r_bps: disk_r_bps as f64,
        disk_w_bps: disk_w_bps as f64,
        net_rx_bps: p.net.rx_bps as f64,
        net_tx_bps: p.net.tx_bps as f64,
        tcp_est: p.net.tcp_est as f64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CpuMetrics, MemMetrics, NetMetrics};

    #[test]
    fn ring_slab_welford_rollups_and_queries_work() {
        let db = HubDb::open_in_memory().unwrap();
        let base_ts = 1_704_067_200i64; // 2024-01-01 00:00:00 UTC

        db.insert_node(&NodeRow {
            id: "node_test1".into(),
            name: "Test 1".into(),
            group_name: "Default".into(),
            tags_json: "[]".into(),
            sort_order: 0,
            token_sha256: sha256_hex(b"uob_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            traffic_limit_bytes: Some(1_000_000_000),
            traffic_reset_day: 1,
            traffic_count_mode: "both".into(),
            hostname: None,
            os: None,
            kernel: None,
            arch: None,
            cpu_model: None,
            cpu_cores: None,
            mem_total: None,
            swap_total: None,
            agent_version: None,
            proc_enabled: 1,
            mute_until: None,
            auto_update_override: None,
            caps_json: "[]".into(),
            update_status_json: None,
            created_at: base_ts,
            updated_at: base_ts,
        })
        .unwrap();

        // Feed samples crossing a 5m and 1h boundary so 5m AND 1h ring slabs populate!
        let timestamps = [
            base_ts,
            base_ts + 30,
            base_ts + 300,  // flushes 5m bucket [base_ts]
            base_ts + 3600, // flushes 5m bucket [base_ts+300] & 1h bucket [base_ts]
            base_ts + 3900, // flushes 5m bucket [base_ts+3600]
        ];
        for (idx, &t) in timestamps.iter().enumerate() {
            let p = NodeMetricsPayload {
                network_quality: None,
                ts: t as u64,
                up: (100 + idx * 30) as u64,
                cpu: CpuMetrics {
                    all: 10.0 + idx as f64 * 5.0,
                    cores: vec![],
                    steal: 1.0,
                    iowait: 0.5,
                    load: vec![0.4, 0.3, 0.2],
                },
                mem: MemMetrics {
                    used: 1024 + idx as u64 * 100,
                    avail: 4096,
                    cached: 512,
                    swap_used: 0,
                },
                disks: vec![],
                net: NetMetrics {
                    rx_bps: 1000,
                    tx_bps: 2000,
                    rx_tot: (idx as u64 + 1) * 5000,
                    tx_tot: (idx as u64 + 1) * 10000,
                    tcp_est: 5,
                    tcp_tw: 1,
                    udp: 2,
                },
            };
            let raw = payload_to_raw_sample(&p);
            db.record_metrics_batch(
                "node_test1",
                1,
                "both",
                Some(1_000_000_000),
                t,
                &[raw],
                &p,
                true,
            )
            .unwrap();
        }

        let q1h = db
            .query_metrics("node_test1", "1h", base_ts + 3900)
            .unwrap();
        assert_eq!(q1h.resolution, "30s");
        assert!(q1h.points.len() >= 3);

        let q24h = db
            .query_metrics("node_test1", "24h", base_ts + 3900)
            .unwrap();
        assert_eq!(q24h.points.len(), 5);

        let q7d = db
            .query_metrics("node_test1", "7d", base_ts + 3900)
            .unwrap();
        assert_eq!(q7d.resolution, "5m");
        assert!(q7d.points.len() >= 3);

        let q1y = db
            .query_metrics("node_test1", "1y", base_ts + 3900)
            .unwrap();
        assert_eq!(q1y.resolution, "1h");
        assert!(q1y.points.len() >= 2);
    }

    #[test]
    fn export_and_import_bundle_preserves_tokens_and_secrets() {
        let db1 = HubDb::open_in_memory().unwrap();
        let db2 = HubDb::open_in_memory().unwrap();

        let ts = 1_700_000_000i64;
        db1.set_setting("admin_password_hash", "pbkdf2$100000$aa$bb", ts)
            .unwrap();
        db1.set_setting("session_secret", "source-secret", ts)
            .unwrap();
        db1.set_setting("watchdog_state", "{\"status\":\"ok\"}", ts)
            .unwrap();
        db1.set_setting("custom_pref", "dark", ts).unwrap();

        db1.insert_node(&NodeRow {
            id: "node_alpha".into(),
            name: "Alpha".into(),
            group_name: "Default".into(),
            tags_json: "[\"hk\"]".into(),
            sort_order: 1,
            token_sha256: "deadbeef".repeat(8),
            traffic_limit_bytes: None,
            traffic_reset_day: 1,
            traffic_count_mode: "both".into(),
            hostname: None,
            os: None,
            kernel: None,
            arch: None,
            cpu_model: None,
            cpu_cores: None,
            mem_total: None,
            swap_total: None,
            agent_version: None,
            proc_enabled: 1,
            mute_until: None,
            auto_update_override: None,
            caps_json: "[]".into(),
            update_status_json: None,
            created_at: ts,
            updated_at: ts,
        })
        .unwrap();

        let bundle = db1.export_bundle(ts).unwrap();
        // watchdog_state excluded per contract
        assert!(!bundle
            .system_settings
            .iter()
            .any(|s| s.key == "watchdog_state"));
        assert!(bundle
            .system_settings
            .iter()
            .any(|s| s.key == "custom_pref"));

        // Target DB already has its own admin password & session secret which MUST be preserved
        db2.set_setting("admin_password_hash", "pbkdf2$100000$cc$dd", ts)
            .unwrap();
        db2.set_setting("session_secret", "target-secret", ts)
            .unwrap();

        let json = serde_json::to_string(&bundle).unwrap();
        let parsed: ImportBundlePayload = serde_json::from_str(&json).unwrap();
        let res = db2.import_bundle(&parsed, ts).unwrap();
        assert_eq!(res.imported.nodes, 1);
        assert_eq!(
            db2.get_setting("admin_password_hash").unwrap().as_deref(),
            Some("pbkdf2$100000$cc$dd")
        );
        assert_eq!(
            db2.get_setting("session_secret").unwrap().as_deref(),
            Some("target-secret")
        );
        assert_eq!(
            db2.get_setting("custom_pref").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            db2.get_node_token_hash("node_alpha").unwrap().as_deref(),
            Some("deadbeef".repeat(8).as_str())
        );
    }

    #[test]
    fn migration_tickets_and_bundle_hygiene() {
        let db1 = HubDb::open_in_memory().unwrap();
        let db2 = HubDb::open_in_memory().unwrap();
        let db3 = HubDb::open_in_memory().unwrap();
        let db4 = HubDb::open_in_memory().unwrap();

        let ts = 1_700_000_000i64;
        db1.set_setting("custom_pref", "dark", ts).unwrap();
        db1.set_setting("watchdog_state", r#"{"ok":true}"#, ts)
            .unwrap();
        db1.set_setting("imported_bundle_sha256", "deadbeef", ts)
            .unwrap();
        db1.set_setting(
            "migration_pull_ticket",
            r#"{"token_sha256":"aaa","expires_at":1700001800}"#,
            ts,
        )
        .unwrap();
        db1.set_setting(
            "migration_receive_ticket",
            r#"{"token_sha256":"bbb","expires_at":1700001800}"#,
            ts,
        )
        .unwrap();
        db1.set_setting(
            "migration_paired_token",
            r#"{"raw_receive_token":"uob_mtk_secret","expires_at":1700001800}"#,
            ts,
        )
        .unwrap();

        let mut exported = db1.export_bundle(ts).unwrap();
        assert!(exported
            .system_settings
            .iter()
            .any(|s| s.key == "custom_pref"));
        for excluded in [
            "watchdog_state",
            "imported_bundle_sha256",
            "migration_pull_ticket",
            "migration_receive_ticket",
            "migration_paired_token",
        ] {
            assert!(
                !exported.system_settings.iter().any(|s| s.key == excluded),
                "export_bundle must exclude {excluded}"
            );
        }

        // Simulate a pulled install bundle carrying migration_receive_ticket plus transient keys
        exported.system_settings.extend([
            ExportSystemSettingEntry {
                key: "watchdog_state".into(),
                value: r#"{"ok":false}"#.into(),
                updated_at: ts,
            },
            ExportSystemSettingEntry {
                key: "imported_bundle_sha256".into(),
                value: "ignored".into(),
                updated_at: ts,
            },
            ExportSystemSettingEntry {
                key: "migration_pull_ticket".into(),
                value: r#"{"token_sha256":"aaa"}"#.into(),
                updated_at: ts,
            },
            ExportSystemSettingEntry {
                key: "migration_paired_token".into(),
                value: r#"{"raw_receive_token":"leak"}"#.into(),
                updated_at: ts,
            },
            ExportSystemSettingEntry {
                key: "migration_receive_ticket".into(),
                value: r#"{"token_sha256":"armed","expires_at":1700001800}"#.into(),
                updated_at: ts,
            },
        ]);
        let bundle_json = serde_json::to_string(&exported).unwrap();
        let payload: ImportBundlePayload = serde_json::from_str(&bundle_json).unwrap();

        // Standard API/receive import (allow_receive_ticket = false) skips all 5 hygiene keys
        db2.import_bundle(&payload, ts).unwrap();
        assert_eq!(
            db2.get_setting("custom_pref").unwrap().as_deref(),
            Some("dark")
        );
        for blocked in [
            "watchdog_state",
            "imported_bundle_sha256",
            "migration_pull_ticket",
            "migration_receive_ticket",
            "migration_paired_token",
        ] {
            assert_eq!(
                db2.get_setting(blocked).unwrap(),
                None,
                "import_bundle must skip {blocked}"
            );
        }

        // allow_receive_ticket = true arms migration_receive_ticket while still skipping the rest
        db3.import_bundle_with_options(&payload, ts, true).unwrap();
        assert_eq!(
            db3.get_setting("migration_receive_ticket")
                .unwrap()
                .as_deref(),
            Some(r#"{"token_sha256":"armed","expires_at":1700001800}"#)
        );
        for blocked in [
            "watchdog_state",
            "imported_bundle_sha256",
            "migration_pull_ticket",
            "migration_paired_token",
        ] {
            assert_eq!(
                db3.get_setting(blocked).unwrap(),
                None,
                "import_bundle_with_options(true) must still skip {blocked}"
            );
        }

        // import_bundle_file_idempotent enables allow_receive_ticket = true and stays idempotent
        let tmp_path = std::env::temp_dir().join(format!(
            "uniob_test_bundle_hygiene_{}_{}.json",
            std::process::id(),
            ts
        ));
        std::fs::write(&tmp_path, &bundle_json).unwrap();
        let first = db4.import_bundle_file_idempotent(&tmp_path).unwrap();
        let second = db4.import_bundle_file_idempotent(&tmp_path).unwrap();
        let _ = std::fs::remove_file(&tmp_path);
        assert!(first);
        assert!(!second);
        assert_eq!(
            db4.get_setting("migration_receive_ticket")
                .unwrap()
                .as_deref(),
            Some(r#"{"token_sha256":"armed","expires_at":1700001800}"#)
        );
        assert_eq!(db4.get_setting("migration_paired_token").unwrap(), None);
        assert_eq!(db4.get_setting("migration_pull_ticket").unwrap(), None);
        assert!(db4.get_setting("imported_bundle_sha256").unwrap().is_some());
    }
}
