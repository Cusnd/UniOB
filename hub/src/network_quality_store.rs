//! Independent, versioned network history rings. Resource telemetry keeps its binary format.
use crate::db::HubDb;
use crate::network_quality::{self as nq, Config, Control, NodeOverride, Point, QueryPoint, State};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const GLOBAL_KEY: &str = "network_quality_config";
pub const NODE_PREFIX: &str = "network_quality_node:";
const RAW_TABLE: &str = "network_quality_chunk_10m";
const ROLLUP_TABLE: &str = "network_quality_5m_chunk_1h";
const PAGE_SIZE: usize = 3000;
const PAGE_POINT_BYTES: usize = 1_000_000;
const MAX_RAW_BLOCK_POINTS: usize = 180;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Block<T> {
    v: u8,
    points: Vec<T>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RollupPoint {
    target_id: String,
    point: QueryPoint,
}

#[derive(Serialize)]
pub struct QuerySeries {
    target_id: String,
    points: Vec<QueryPoint>,
}

#[derive(Serialize)]
pub struct QualityQuery {
    node_id: String,
    range: String,
    resolution_sec: u16,
    server_time: u64,
    state: State,
    series: Vec<QuerySeries>,
    next_cursor: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    v: u8,
    node_id: String,
    range: String,
    to: u64,
    #[serde(default)]
    bucket: Option<u64>,
    offset: usize,
}

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS network_quality_chunk_10m (
           node_id TEXT NOT NULL, slot INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
           payload TEXT NOT NULL, PRIMARY KEY(node_id, slot),
           FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE);
         CREATE TABLE IF NOT EXISTS network_quality_5m_chunk_1h (
           node_id TEXT NOT NULL, slot INTEGER NOT NULL, bucket_ts INTEGER NOT NULL,
           payload TEXT NOT NULL, PRIMARY KEY(node_id, slot),
           FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE);
         CREATE TABLE IF NOT EXISTS network_quality_state (
           node_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
           FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE);
         CREATE INDEX IF NOT EXISTS nq_raw_time
           ON network_quality_chunk_10m(node_id,bucket_ts);
         CREATE INDEX IF NOT EXISTS nq_rollup_time
           ON network_quality_5m_chunk_1h(node_id,bucket_ts);",
    )
    .map_err(|e| format!("network schema: {e}"))
}

fn read_state(c: &Connection, node: &str) -> Result<State, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT payload FROM network_quality_state WHERE node_id=?1",
            [node],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("network state: {e}"))?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| "Invalid persisted network state".into()))
        .unwrap_or_else(|| Ok(State::default()))
}

fn write_state(c: &Connection, node: &str, state: &State, previous: &State) -> Result<(), String> {
    if state == previous {
        return Ok(());
    }
    c.execute(
        "INSERT INTO network_quality_state(node_id,payload) VALUES(?1,?2)
        ON CONFLICT(node_id) DO UPDATE SET payload=excluded.payload",
        params![
            node,
            serde_json::to_string(state).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| format!("write network state: {e}"))?;
    Ok(())
}

fn read_blocks<T: for<'de> Deserialize<'de>>(
    c: &Connection,
    table: &str,
    node: &str,
    from: u64,
    to: u64,
) -> Result<Vec<T>, String> {
    let mut stmt = c.prepare(&format!("SELECT payload FROM {table} WHERE node_id=?1 AND bucket_ts>=?2 AND bucket_ts<=?3 ORDER BY bucket_ts"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![node, from, to], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for raw in rows {
        let raw = raw.map_err(|e| e.to_string())?;
        out.extend(decode_block::<T>(&raw)?);
    }
    Ok(out)
}

fn decode_block<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<Vec<T>, String> {
    if raw.len() > 2 * 1024 * 1024 {
        return Err("Oversized network block".into());
    }
    let block: Block<T> = serde_json::from_str(raw).map_err(|_| "Invalid network block")?;
    if block.v != 1 || block.points.len() > 4096 {
        return Err("Invalid network block version or count".into());
    }
    Ok(block.points)
}

fn write_block<T: Serialize>(
    c: &Connection,
    table: &str,
    node: &str,
    bucket: u64,
    width: u64,
    slots: u64,
    points: Vec<T>,
) -> Result<(), String> {
    let payload = serde_json::to_string(&Block { v: 1, points }).map_err(|e| e.to_string())?;
    c.execute(&format!("INSERT INTO {table}(node_id,slot,bucket_ts,payload) VALUES(?1,?2,?3,?4)
        ON CONFLICT(node_id,slot) DO UPDATE SET bucket_ts=excluded.bucket_ts,payload=excluded.payload
        WHERE excluded.bucket_ts >= {table}.bucket_ts"),
        params![node, bucket / width % slots, bucket, payload]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn normalize_setting(key: &str, value: &str) -> Result<Option<String>, String> {
    if key != GLOBAL_KEY && !key.starts_with(NODE_PREFIX) {
        return Ok(None);
    }
    if value.len() > 16_384 {
        return Err("Network configuration is too large".into());
    }
    let parsed: Value =
        serde_json::from_str(value).map_err(|_| "Invalid network configuration JSON")?;
    let normalized = if key == GLOBAL_KEY {
        serde_json::to_string(&nq::parse_config(&parsed)?)
    } else {
        if key.len() == NODE_PREFIX.len() {
            return Err("Missing network configuration node ID".into());
        }
        serde_json::to_string(&nq::parse_override(&parsed)?)
    }
    .map_err(|e| e.to_string())?;
    Ok(Some(normalized))
}

impl HubDb {
    pub fn network_config(&self) -> Result<Config, String> {
        match self.get_setting(GLOBAL_KEY)? {
            Some(v) => nq::parse_config(
                &serde_json::from_str(&v).map_err(|_| "Invalid network config JSON")?,
            ),
            None => Ok(nq::default_config()),
        }
    }

    pub fn network_override(&self, node: &str) -> Result<NodeOverride, String> {
        match self.get_setting(&format!("{NODE_PREFIX}{node}"))? {
            Some(v) => nq::parse_override(
                &serde_json::from_str(&v).map_err(|_| "Invalid network override JSON")?,
            ),
            None => nq::parse_override(&serde_json::json!({"mode":"inherit"})),
        }
    }

    pub fn network_control(&self, node: &str) -> Result<Control, String> {
        nq::effective_control(&self.network_config()?, &self.network_override(node)?)
    }

    pub fn network_state(&self, node: &str) -> Result<State, String> {
        self.with_conn(|c| read_state(c, node))
    }

    pub fn network_set_supported(&self, node: &str, supported: bool) -> Result<(), String> {
        self.with_conn(|c| {
            let old = read_state(c, node)?;
            let mut state = old.clone();
            state.supported = supported;
            if !supported {
                state.enabled = false;
                state.applied_config_id = None;
                state.config_error = None;
                state.latest.clear();
            }
            write_state(c, node, &state, &old)
        })
    }

    /// Malformed extensions are rejected here, independently of their resource frame.
    pub fn ingest_network_quality(
        &self,
        node: &str,
        value: &Value,
        now: u64,
    ) -> Result<State, String> {
        let payload = nq::validate_payload(value, now)?;
        let control = self.network_control(node)?;
        self.with_conn(|c| {
            let tx = c.transaction().map_err(|e| e.to_string())?;
            let previous = read_state(&tx, node)?;
            if !previous.supported {
                return Ok(previous);
            }
            let from = now.saturating_sub(1800) / 600 * 600;
            let mut recent: Vec<Point> =
                read_blocks(&tx, RAW_TABLE, node, from, now.saturating_add(60))?;
            let mut seen: HashSet<String> = recent.iter().map(|p| p.sample_id.clone()).collect();
            let mut changed_blocks = HashSet::new();
            let mut changed_buckets = HashSet::new();
            for point in payload.points {
                if seen.contains(&point.sample_id) {
                    continue;
                }
                let block = point.ts / 600 * 600;
                if recent.iter().filter(|p| p.ts / 600 * 600 == block).count()
                    >= MAX_RAW_BLOCK_POINTS
                {
                    continue;
                }
                seen.insert(point.sample_id.clone());
                changed_blocks.insert(block);
                changed_buckets.insert(point.ts / 300 * 300);
                recent.push(point);
            }
            recent.sort_by(|a, b| {
                (a.ts, &a.target_id, &a.sample_id).cmp(&(b.ts, &b.target_id, &b.sample_id))
            });
            for bucket in &changed_blocks {
                write_block(
                    &tx,
                    RAW_TABLE,
                    node,
                    *bucket,
                    600,
                    146,
                    recent
                        .iter()
                        .filter(|p| p.ts / 600 * 600 == *bucket)
                        .cloned()
                        .collect(),
                )?;
            }
            let changed_hours: HashSet<u64> =
                changed_buckets.iter().map(|b| b / 3600 * 3600).collect();
            for hour in changed_hours {
                let mut rollups: Vec<RollupPoint> =
                    read_blocks(&tx, ROLLUP_TABLE, node, hour, hour)?;
                rollups.retain(|p| !changed_buckets.contains(&p.point.ts));
                for id in ["ct", "cu", "cm"] {
                    let source: Vec<Point> = recent
                        .iter()
                        .filter(|p| {
                            p.target_id == id
                                && p.ts / 3600 * 3600 == hour
                                && changed_buckets.contains(&(p.ts / 300 * 300))
                        })
                        .cloned()
                        .collect();
                    rollups.extend(nq::rollup_points(&source).into_iter().map(|point| {
                        RollupPoint {
                            target_id: id.to_owned(),
                            point,
                        }
                    }));
                }
                rollups.sort_by(|a, b| {
                    (a.point.ts, &a.target_id, &a.point.segment_id).cmp(&(
                        b.point.ts,
                        &b.target_id,
                        &b.point.segment_id,
                    ))
                });
                write_block(&tx, ROLLUP_TABLE, node, hour, 3600, 721, rollups)?;
            }
            let mut state = previous.clone();
            // An old retransmission may fill history, but must not undo an already applied config.
            let acknowledged = payload.applied_config_id.as_deref() == Some(&control.config_id);
            if acknowledged {
                state.applied_config_id = payload.applied_config_id;
                state.enabled = payload.enabled;
                state.config_error = payload.config_error;
            }
            state.dropped_samples = payload.dropped_samples;
            if !changed_blocks.is_empty() && acknowledged && control.enabled {
                state.latest = control
                    .targets
                    .iter()
                    .filter(|target| target.target.enabled)
                    .filter_map(|target| {
                        let previous = previous.latest.iter().find(|latest| {
                            latest.target_id == target.target.id
                                && latest.target_revision == target.target_revision
                        });
                        let anchor = recent
                            .iter()
                            .filter(|point| {
                                point.config_id == control.config_id
                                    && point.target_id == target.target.id
                                    && point.target_revision == target.target_revision
                            })
                            .max_by_key(|point| (point.ts, point.round_seq));
                        let Some(anchor) = anchor else {
                            return previous.cloned();
                        };
                        if previous.is_some_and(|old| old.measured_at > anchor.ts) {
                            return previous.cloned();
                        }
                        // Changing another target changes config_id, but must not reset
                        // this target's unchanged segment or its 120-second denominator.
                        let window: Vec<Point> = recent
                            .iter()
                            .filter(|point| {
                                point.target_id == anchor.target_id
                                    && point.target_revision == anchor.target_revision
                                    && point.segment_id == anchor.segment_id
                                    && point.ts <= anchor.ts
                            })
                            .cloned()
                            .collect();
                        nq::latest_from_points(&window).into_iter().next()
                    })
                    .collect();
            }
            write_state(&tx, node, &state, &previous)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(state)
        })
    }

    pub fn query_network_quality(
        &self,
        node: &str,
        range: &str,
        cursor: Option<&str>,
        now: u64,
    ) -> Result<QualityQuery, String> {
        let duration = match range {
            "1h" => 3600,
            "24h" => 86400,
            "7d" => 604800,
            "30d" => 2592000,
            _ => return Err("Invalid range (expected 1h|24h|7d|30d)".into()),
        };
        let raw = matches!(range, "1h" | "24h");
        let width = if raw { 600 } else { 3600 };
        let max_offset = MAX_RAW_BLOCK_POINTS * if raw { 1 } else { 6 };
        let page = match cursor {
            None => Cursor {
                v: 1,
                node_id: node.into(),
                range: range.into(),
                to: now,
                bucket: None,
                offset: 0,
            },
            Some(s) => {
                if s.len() > 2048 {
                    return Err("Invalid cursor".into());
                }
                let bytes = URL_SAFE_NO_PAD.decode(s).map_err(|_| "Invalid cursor")?;
                let c: Cursor = serde_json::from_slice(&bytes).map_err(|_| "Invalid cursor")?;
                if c.v != 1
                    || c.node_id != node
                    || c.range != range
                    || c.to > now.saturating_add(60)
                    || now.saturating_sub(c.to) > 1800
                    || c.offset > max_offset
                    || (c.bucket.is_none() && c.offset != 0)
                {
                    return Err("Invalid or expired cursor".into());
                }
                c
            }
        };
        let from = page.to.saturating_sub(duration);
        let first_bucket = from / width * width;
        let start_bucket = page.bucket.unwrap_or(first_bucket);
        if start_bucket % width != 0
            || start_bucket < first_bucket
            || start_bucket > page.to / width * width
        {
            return Err("Invalid cursor bucket".into());
        }
        self.with_conn(|c| {
            let mut grouped: Vec<QuerySeries> = ["ct", "cu", "cm"]
                .into_iter()
                .map(|s| QuerySeries {
                    target_id: s.to_owned(),
                    points: vec![],
                })
                .collect();
            let table = if raw { RAW_TABLE } else { ROLLUP_TABLE };
            let mut stmt = c.prepare(&format!("SELECT bucket_ts,payload FROM {table} WHERE node_id=?1 AND bucket_ts>=?2 AND bucket_ts<=?3 ORDER BY bucket_ts"))
                .map_err(|e|e.to_string())?;
            let mut rows = stmt.query(params![node,start_bucket,page.to]).map_err(|e|e.to_string())?;
            let mut count = 0;
            let mut bytes = 0;
            let mut found_cursor_bucket = page.offset == 0;
            let mut next_cursor = None;
            'blocks: while let Some(row) = rows.next().map_err(|e|e.to_string())? {
                let bucket: u64 = row.get(0).map_err(|e|e.to_string())?;
                let encoded: String = row.get(1).map_err(|e|e.to_string())?;
                // Decode only one block and its raw 120s warmup. Even valid
                // histories with a new segment every probe stay bounded in RAM.
                let mut points: Vec<RollupPoint> = if raw {
                    let mut source: Vec<Point> = if bucket == 0 { vec![] } else {
                        read_blocks(c,RAW_TABLE,node,bucket.saturating_sub(120)/600*600,bucket-1)?
                    };
                    source.extend(decode_block::<Point>(&encoded)?);
                    source.retain(|point|point.ts <= page.to);
                    nq::raw_query_points(&source).into_iter().map(|point|RollupPoint { target_id:point.target.id.clone(),point }).collect()
                } else { decode_block(&encoded)? };
                points.retain(|p|p.point.ts>=from && p.point.ts>=bucket && p.point.ts<bucket+width && p.point.ts<=page.to);
                points.sort_by(|a,b|(a.point.ts,&a.target_id,&a.point.segment_id).cmp(&(b.point.ts,&b.target_id,&b.point.segment_id)));
                let offset = if bucket==start_bucket {page.offset} else {0};
                if bucket==start_bucket { found_cursor_bucket = true; }
                if !found_cursor_bucket || offset>points.len() {return Err("Invalid cursor offset".into());}
                for (index,p) in points.into_iter().enumerate().skip(offset) {
                    let size = serde_json::to_vec(&p.point).map_err(|e|e.to_string())?.len();
                    if count>0 && (count==PAGE_SIZE || bytes+size>PAGE_POINT_BYTES) {
                        let next = Cursor {bucket:Some(bucket),offset:index,..page.clone()};
                        next_cursor = Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&next).map_err(|e|e.to_string())?));
                        break 'blocks;
                    }
                    count += 1;
                    bytes += size;
                    if let Some(series) = grouped.iter_mut().find(|series|series.target_id==p.target_id) {
                        series.points.push(p.point);
                    }
                }
            }
            if !found_cursor_bucket {return Err("Invalid cursor offset".into());}
            Ok(QualityQuery {
                node_id: node.into(),
                range: range.into(),
                resolution_sec: if raw { 20 } else { 300 },
                server_time: now,
                state: read_state(c, node)?,
                series: grouped,
                next_cursor,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ImportBundlePayload, NodeRow};
    use serde_json::json;

    fn setup() -> HubDb {
        let db = HubDb::open_in_memory().unwrap();
        let node: NodeRow =
            serde_json::from_value(json!({"id":"test","name":"Test","token_sha256":"hash"}))
                .unwrap();
        db.insert_node(&node).unwrap();
        db.network_set_supported("test", true).unwrap();
        let mut cfg = nq::default_config();
        cfg.enabled = true;
        db.set_setting(GLOBAL_KEY, &serde_json::to_string(&cfg).unwrap(), 0)
            .unwrap();
        db
    }

    fn point(
        db: &HubDb,
        ts: u64,
        seq: u64,
        id: &str,
        segment: &str,
        latency: Option<f64>,
    ) -> Value {
        let control = serde_json::to_value(db.network_control("test").unwrap()).unwrap();
        let target = control["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap();
        let mut metadata = target.clone();
        metadata.as_object_mut().unwrap().remove("target_revision");
        json!({"sample_id":format!("session:{seq}:{id}"),"round_seq":seq,"config_id":control["config_id"],
            "target_id":id,"target_revision":target["target_revision"],"segment_id":segment,"ts":ts,
            "result":if latency.is_some() {"ok"} else {"connect_timeout"},"connect_ms":latency,
            "remote_ip":"1.1.1.1","target":metadata})
    }

    fn payload(db: &HubDb, points: Vec<Value>) -> Value {
        json!({"schema_version":1,"applied_config_id":db.network_control("test").unwrap().config_id,
            "enabled":true,"config_error":null,"dropped_samples":0,"latest":[],"points":points})
    }

    #[test]
    fn rolling_window_deduplication_late_points_and_segment_rollups() {
        let db = setup();
        let end = 1_800_000_100u64;
        let vals = [Some(70.), Some(72.), None, Some(74.), Some(71.), Some(73.)];
        let points: Vec<Value> = vals
            .into_iter()
            .enumerate()
            .map(|(i, v)| point(&db, end - 100 + i as u64 * 20, i as u64, "ct", "a", v))
            .collect();
        let first = payload(&db, points[..3].to_vec());
        db.ingest_network_quality("test", &first, end).unwrap();
        let second = payload(&db, points[3..].to_vec());
        let state = db.ingest_network_quality("test", &second, end).unwrap();
        assert_eq!(state.latest[0].latency_median_ms, Some(72.));
        assert_eq!(state.latest[0].attempts, 6);
        assert_eq!(state.latest[0].failures, 1);
        assert!((state.latest[0].failure_rate_pct.unwrap() - 100. / 6.).abs() < 1e-9);
        let changes = db.with_conn(|c| Ok(c.total_changes())).unwrap();
        db.ingest_network_quality("test", &second, end).unwrap();
        assert_eq!(db.with_conn(|c| Ok(c.total_changes())).unwrap(), changes);
        let q = db.query_network_quality("test", "1h", None, end).unwrap();
        assert_eq!(q.series[0].points.len(), 6);
        db.ingest_network_quality(
            "test",
            &payload(&db, vec![point(&db, end + 20, 6, "ct", "b", Some(0.2))]),
            end + 20,
        )
        .unwrap();
        db.ingest_network_quality("test", &first, end + 20).unwrap();
        let state = db.network_state("test").unwrap();
        assert_eq!(state.latest[0].segment_id, "b");
        assert_eq!(state.latest[0].attempts, 1);
        let q = db
            .query_network_quality("test", "7d", None, end + 20)
            .unwrap();
        assert!(q.series[0].points.iter().any(|p| p.segment_id == "a"));
        assert!(q.series[0].points.iter().any(|p| p.segment_id == "b"));
        assert_eq!(
            q.series[0].points.iter().map(|p| p.attempts).sum::<u64>(),
            7
        );
    }

    #[test]
    fn invalid_extension_and_import_are_isolated_and_atomic() {
        let db = setup();
        assert!(db
            .ingest_network_quality("test", &json!("bad"), 100)
            .is_err());
        let bundle: ImportBundlePayload = serde_json::from_value(json!({
            "nodes":[{"id":"new","name":"New","token_sha256":"hash"}],
            "system_settings":[{"key":GLOBAL_KEY,"value":"{\"enabled\":true}"}]
        }))
        .unwrap();
        assert!(db.import_bundle(&bundle, 100).is_err());
        assert!(db.get_node_row("new").unwrap().is_none());
        assert!(db.query_network_quality("test", "1y", None, 100).is_err());
        assert!(db
            .query_network_quality("test", "1h", Some("bad"), 100)
            .is_err());
    }

    #[test]
    fn raw_pagination_and_full_window_survive_ring_boundary() {
        let db = setup();
        let start = 1_800_000_000u64;
        // More than one page, with all timestamps accepted within each ingestion window.
        for block in 0..37u64 {
            let points = (0..30u64)
                .flat_map(|i| {
                    let db = &db;
                    ["ct", "cu", "cm"].into_iter().map(move |id| {
                        point(
                            db,
                            start + block * 600 + i * 20,
                            block * 30 + i,
                            id,
                            id,
                            Some(10.),
                        )
                    })
                })
                .collect();
            db.ingest_network_quality("test", &payload(&db, points), start + block * 600 + 599)
                .unwrap();
        }
        let now = start + 37 * 600;
        let first = db.query_network_quality("test", "24h", None, now).unwrap();
        let mut total = first.series.iter().map(|s| s.points.len()).sum::<usize>();
        assert!((1..=3000).contains(&total));
        let cursor = first.next_cursor.unwrap();
        let mut next_cursor = Some(cursor.clone());
        while let Some(cursor) = next_cursor {
            let next = db
                .query_network_quality("test", "24h", Some(&cursor), now + 1)
                .unwrap();
            let count = next.series.iter().map(|s| s.points.len()).sum::<usize>();
            assert!((1..=3000).contains(&count));
            let bytes: usize = next
                .series
                .iter()
                .flat_map(|s| &s.points)
                .map(|p| serde_json::to_vec(p).unwrap().len())
                .sum();
            assert!(bytes <= PAGE_POINT_BYTES);
            total += count;
            next_cursor = next.next_cursor;
        }
        assert_eq!(total, 3330);
        assert!(db
            .query_network_quality("test", "7d", Some(&cursor), now)
            .is_err());
        assert!(db
            .query_network_quality("test", "24h", Some(&cursor), now + 1801)
            .is_err());
        let legacy = URL_SAFE_NO_PAD
            .encode(json!({"v":1,"node_id":"test","range":"24h","to":now,"offset":0}).to_string());
        assert!(db
            .query_network_quality("test", "24h", Some(&legacy), now)
            .is_ok());
        let mut decoded: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&cursor).unwrap()).unwrap();
        assert_eq!(decoded["bucket"].as_u64().unwrap() % 600, 0);
        assert!(decoded["offset"].as_u64().unwrap() <= 180);
        decoded["bucket"] = json!(now - 1);
        let invalid = URL_SAFE_NO_PAD.encode(decoded.to_string());
        assert!(db
            .query_network_quality("test", "24h", Some(&invalid), now)
            .is_err());
    }

    #[test]
    fn segmented_rollup_pages_read_bounded_blocks_without_duplicates_or_omissions() {
        let db = setup();
        let base = 1_800_000_000u64 / 3600 * 3600;
        for half_hour in 0..16u64 {
            let points: Vec<Value> = (0..90u64)
                .flat_map(|i| {
                    let db = &db;
                    ["ct", "cu", "cm"].into_iter().map(move |id| {
                        let seq = half_hour * 90 + i;
                        point(
                            db,
                            base + seq * 20,
                            seq,
                            id,
                            &format!("segment:{seq}:{id}"),
                            Some(10.),
                        )
                    })
                })
                .collect();
            db.ingest_network_quality(
                "test",
                &payload(&db, points),
                base + half_hour * 1800 + 1780,
            )
            .unwrap();
        }
        let now = base + 8 * 3600;
        // A corrupt block beyond the first response must not be decoded while
        // preparing that response; pagination must bound database materialization.
        db.with_conn(|c|c.execute("INSERT INTO network_quality_5m_chunk_1h(node_id,slot,bucket_ts,payload) VALUES('test',?1,?2,'invalid')",params![now/3600%721,now]).map_err(|e|e.to_string())).unwrap();
        let first = db.query_network_quality("test", "30d", None, now).unwrap();
        assert!(first.next_cursor.is_some());
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM network_quality_5m_chunk_1h WHERE node_id='test' AND bucket_ts=?1",
                [now],
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
        let mut identities = HashSet::new();
        let mut page = first;
        let mut pages = 0;
        loop {
            pages += 1;
            let count: usize = page.series.iter().map(|s| s.points.len()).sum();
            assert!((1..=PAGE_SIZE).contains(&count));
            let bytes: usize = page
                .series
                .iter()
                .flat_map(|s| &s.points)
                .map(|p| serde_json::to_vec(p).unwrap().len())
                .sum();
            assert!(bytes <= PAGE_POINT_BYTES);
            for series in page.series {
                for p in series.points {
                    assert_eq!(p.attempts, 1);
                    assert!(identities.insert((series.target_id.clone(), p.segment_id, p.ts)));
                }
            }
            let Some(cursor) = page.next_cursor else {
                break;
            };
            let decoded: Cursor =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&cursor).unwrap()).unwrap();
            assert_eq!(decoded.bucket.unwrap() % 3600, 0);
            assert!(decoded.offset <= 1080);
            page = db
                .query_network_quality("test", "30d", Some(&cursor), now + 1)
                .unwrap();
        }
        assert_eq!(identities.len(), 4320);
        assert!(pages >= 2);
    }

    #[test]
    fn raw_24h_ring_preserves_left_boundary_warmup_at_all_block_phases() {
        // 146 slots cover the entire 24h range plus its trailing-window pre-read,
        // including the vulnerable first 120 seconds of a ten-minute block.
        let base = 1_800_000_000u64;
        for phase in [0, 1, 119, 120, 599, 3600, 86400] {
            let db = setup();
            let now = base + 150 * 600 + phase;
            let from = now - 86400;
            let mut source: Vec<Value> = (0..=(now - base) / 600)
                .map(|i| point(&db, base + i * 600 + 300, i, "ct", "steady", Some(10.)))
                .filter(|p| p["ts"].as_u64().unwrap() <= now)
                .collect();
            source.extend((0..6).map(|i| {
                point(
                    &db,
                    from - 100 + i * 20,
                    10_000 + i,
                    "ct",
                    "warmup",
                    Some(70. + i as f64),
                )
            }));
            source.sort_by_key(|p| p["ts"].as_u64().unwrap());
            for p in source {
                let ts = p["ts"].as_u64().unwrap();
                db.ingest_network_quality("test", &payload(&db, vec![p]), ts)
                    .unwrap();
            }
            let query = db.query_network_quality("test", "24h", None, now).unwrap();
            let boundary = query.series[0]
                .points
                .iter()
                .find(|p| p.ts == from)
                .unwrap();
            assert_eq!(boundary.attempts, 6, "phase {phase}");
            assert_eq!(boundary.latency_sum_ms, 435., "phase {phase}");
            assert!(query.series[0]
                .points
                .iter()
                .all(|p| p.ts >= from && p.ts <= now));
            let rows: i64 = db
                .with_conn(|c| {
                    c.query_row("SELECT count(*) FROM network_quality_chunk_10m", [], |r| {
                        r.get(0)
                    })
                    .map_err(|e| e.to_string())
                })
                .unwrap();
            assert_eq!(rows, 146, "phase {phase}");
        }
    }

    #[test]
    fn thirty_day_rollup_ring_keeps_boundary_segments_and_weighted_counts() {
        let db = setup();
        let base = 1_800_000_000u64 / 3600 * 3600;
        // More than 721 hours forces physical slot reuse while preserving 30 days.
        for hour in 0..723u64 {
            let ts = base + hour * 3600;
            let samples = vec![
                point(&db, ts, hour * 3, "ct", "a", Some(10.)),
                point(&db, ts + 20, hour * 3 + 1, "ct", "a", None),
                point(&db, ts + 40, hour * 3 + 2, "ct", "b", None),
            ];
            db.ingest_network_quality("test", &payload(&db, samples), ts + 40)
                .unwrap();
        }
        let now = base + 722 * 3600;
        let query = db.query_network_quality("test", "30d", None, now).unwrap();
        assert_eq!(query.resolution_sec, 300);
        assert_eq!(query.series[0].points.len(), 721 * 2);
        assert!(query.next_cursor.is_none());
        let first = &query.series[0].points[0];
        assert_eq!(first.ts, now - 30 * 86400);
        assert_eq!(first.segment_id, "a");
        assert_eq!(
            (first.attempts, first.failures, first.success_count),
            (2, 1, 1)
        );
        assert_eq!(first.latency_ms, Some(10.));
        assert_eq!(first.failure_rate_pct, Some(50.));
        let all_failed = &query.series[0].points[1];
        assert_eq!(all_failed.segment_id, "b");
        assert_eq!(all_failed.latency_ms, None);
        assert_eq!(all_failed.failure_rate_pct, Some(100.));
        for phase in [1, 119, 300, 3599] {
            let shifted = db
                .query_network_quality("test", "30d", None, now + phase)
                .unwrap();
            assert!(shifted.series[0]
                .points
                .iter()
                .all(|p| p.ts >= now + phase - 30 * 86400));
            assert_eq!(shifted.series[0].points.len(), 720 * 2);
        }
        let rows: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT count(*) FROM network_quality_5m_chunk_1h",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(rows, 721);
    }

    #[test]
    fn reconnect_deduplicates_across_blocks_and_does_not_roll_back_acknowledgement() {
        let db = setup();
        let now = 1_800_000_000u64;
        let old_batch = payload(&db, vec![point(&db, now - 20, 0, "ct", "old", Some(5.))]);
        db.ingest_network_quality("test", &old_batch, now).unwrap();
        db.network_set_supported("test", true).unwrap();
        let mut changed_timestamp = old_batch.clone();
        changed_timestamp["points"][0]["ts"] = json!(now + 1);
        db.ingest_network_quality("test", &changed_timestamp, now + 1)
            .unwrap();
        let query = db
            .query_network_quality("test", "1h", None, now + 1)
            .unwrap();
        assert_eq!(query.series[0].points.len(), 1);
        assert_eq!(query.state.latest[0].measured_at, now - 20);

        let mut config = db.network_config().unwrap();
        config.targets[0].region = "北京".into();
        db.set_setting(
            GLOBAL_KEY,
            &serde_json::to_string(&config).unwrap(),
            now as i64,
        )
        .unwrap();
        let active = payload(&db, vec![point(&db, now + 20, 1, "ct", "new", Some(2.))]);
        let state = db
            .ingest_network_quality("test", &active, now + 20)
            .unwrap();
        let mut old_late_batch = old_batch;
        old_late_batch["points"][0]["sample_id"] = json!("late-old-result");
        old_late_batch["points"][0]["ts"] = json!(now + 40);
        let after = db
            .ingest_network_quality("test", &old_late_batch, now + 40)
            .unwrap();
        assert_eq!(after.applied_config_id, state.applied_config_id);
        assert_eq!(after.latest, state.latest);
        assert_eq!(
            db.query_network_quality("test", "1h", None, now + 40)
                .unwrap()
                .series[0]
                .points
                .len(),
            3
        );
        db.network_set_supported("test", false).unwrap();
        let unsupported = db.network_state("test").unwrap();
        assert!(!unsupported.enabled);
        assert!(unsupported.applied_config_id.is_none());
        assert!(unsupported.latest.is_empty());
        assert_eq!(
            db.query_network_quality("test", "1h", None, now + 40)
                .unwrap()
                .series[0]
                .points
                .len(),
            3
        );
    }

    #[test]
    fn late_five_minute_bucket_updates_preserve_neighboring_rollups() {
        let db = setup();
        let base = 1_800_000_000u64 / 3600 * 3600;
        for (i, ts) in [base + 20, base + 620, base + 1820].into_iter().enumerate() {
            db.ingest_network_quality(
                "test",
                &payload(&db, vec![point(&db, ts, i as u64, "ct", "a", Some(10.))]),
                ts,
            )
            .unwrap();
        }
        // The late sample changes an old 5m bucket while the first bucket is now
        // outside the ingestion lookback; that earlier rollup must remain intact.
        db.ingest_network_quality(
            "test",
            &payload(&db, vec![point(&db, base + 640, 10, "ct", "a", None)]),
            base + 2400,
        )
        .unwrap();
        let query = db
            .query_network_quality("test", "7d", None, base + 2400)
            .unwrap();
        assert_eq!(query.series[0].points.len(), 3);
        assert_eq!(query.series[0].points[0].attempts, 1);
        assert_eq!(
            (
                query.series[0].points[1].attempts,
                query.series[0].points[1].failures
            ),
            (2, 1)
        );
        assert_eq!(query.series[0].points[2].attempts, 1);
    }

    #[test]
    fn shared_fixture_matches_all_four_history_ranges_and_latest() {
        let db = setup();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../shared/fixtures/network-quality-v1.json"
        ))
        .unwrap();
        db.set_setting(GLOBAL_KEY, &fixture["config"].to_string(), 0)
            .unwrap();
        assert_eq!(
            serde_json::to_value(db.network_control("test").unwrap()).unwrap(),
            fixture["control"]
        );
        let points = fixture["points"].as_array().unwrap().clone();
        let now = points
            .iter()
            .map(|p| p["ts"].as_u64().unwrap())
            .max()
            .unwrap();
        let state = db
            .ingest_network_quality("test", &payload(&db, points), now)
            .unwrap();
        let expected_latest: Vec<nq::Latest> =
            serde_json::from_value(fixture["expected"]["latest"].clone()).unwrap();
        assert_eq!(state.latest, expected_latest);
        for range in ["1h", "24h", "7d", "30d"] {
            let query = db.query_network_quality("test", range, None, now).unwrap();
            let key = if range == "1h" || range == "24h" {
                "raw_by_target"
            } else {
                "rollup_by_target"
            };
            for series in query.series {
                let expected: Vec<QueryPoint> =
                    serde_json::from_value(fixture["expected"][key][&series.target_id].clone())
                        .unwrap();
                assert_eq!(series.points, expected, "{range} {}", series.target_id);
            }
        }
    }

    #[test]
    fn target_without_new_attempts_stays_stale_and_other_target_edits_keep_window() {
        let db = setup();
        let now = 1_800_000_000;
        let samples = vec![
            point(&db, now - 20, 0, "ct", "ct", Some(10.)),
            point(&db, now - 20, 0, "cu", "cu", Some(20.)),
        ];
        db.ingest_network_quality("test", &payload(&db, samples), now)
            .unwrap();
        let mut config = db.network_config().unwrap();
        config.targets[0].region = "北京".into();
        db.set_setting(
            GLOBAL_KEY,
            &serde_json::to_string(&config).unwrap(),
            now as i64,
        )
        .unwrap();
        let next = vec![point(&db, now, 1, "cu", "cu", Some(30.))];
        let updated = db
            .ingest_network_quality("test", &payload(&db, next), now)
            .unwrap();
        assert_eq!(updated.latest.len(), 1);
        assert_eq!(updated.latest[0].target_id, "cu");
        assert_eq!(updated.latest[0].attempts, 2);
        assert_eq!(updated.latest[0].latency_median_ms, Some(25.));
        let hour_later = vec![point(&db, now + 3600, 180, "cm", "cm", Some(40.))];
        let stale = db
            .ingest_network_quality("test", &payload(&db, hour_later), now + 3600)
            .unwrap();
        let retained = stale.latest.iter().find(|l| l.target_id == "cu").unwrap();
        assert_eq!(retained, &updated.latest[0]);
        assert_eq!(stale.latest.len(), 2);
        let pending = point(&db, now + 3620, 181, "cm", "cm", Some(50.));
        db.set_setting(
            &format!("{NODE_PREFIX}test"),
            "{\"mode\":\"off\"}",
            now as i64 + 3620,
        )
        .unwrap();
        let mut disabled = payload(&db, vec![pending]);
        disabled["enabled"] = json!(false);
        let stopped = db
            .ingest_network_quality("test", &disabled, now + 3620)
            .unwrap();
        assert!(!stopped.enabled);
        assert_eq!(stopped.latest, stale.latest);
    }

    #[test]
    fn old_database_upgrade_and_cold_reopen_preserve_config_state_and_deduplication() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            crate::crypto::generate_id("uniob-network-test").unwrap()
        ));
        let db = HubDb::open(&path).unwrap();
        let node: NodeRow =
            serde_json::from_value(json!({"id":"test","name":"Test","token_sha256":"hash"}))
                .unwrap();
        db.insert_node(&node).unwrap();
        // Model a pre-feature database and reopen through the real startup path.
        db.with_conn(|c|c.execute_batch("DROP TABLE network_quality_state; DROP TABLE network_quality_chunk_10m; DROP TABLE network_quality_5m_chunk_1h;").map_err(|e|e.to_string())).unwrap();
        drop(db);
        let db = HubDb::open(&path).unwrap();
        assert!(db.get_node_row("test").unwrap().is_some());
        assert!(!db.network_state("test").unwrap().supported);
        assert!(!db.network_control("test").unwrap().enabled);
        db.network_set_supported("test", true).unwrap();
        let mut config = nq::default_config();
        config.enabled = true;
        db.set_setting(GLOBAL_KEY, &serde_json::to_string(&config).unwrap(), 0)
            .unwrap();
        let now = 1_800_000_000;
        let batch = payload(
            &db,
            vec![point(&db, now, 0, "ct", "session:ct:1", Some(0.25))],
        );
        let before = db.ingest_network_quality("test", &batch, now).unwrap();
        drop(db);
        let reopened = HubDb::open(&path).unwrap();
        assert_eq!(reopened.network_config().unwrap(), config);
        assert_eq!(reopened.network_state("test").unwrap(), before);
        reopened.network_set_supported("test", true).unwrap();
        reopened
            .ingest_network_quality("test", &batch, now + 20)
            .unwrap();
        assert_eq!(
            reopened
                .query_network_quality("test", "1h", None, now + 20)
                .unwrap()
                .series[0]
                .points
                .len(),
            1
        );
        assert_eq!(
            reopened
                .query_network_quality("test", "30d", None, now + 20)
                .unwrap()
                .series[0]
                .points[0]
                .attempts,
            1
        );
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
}
