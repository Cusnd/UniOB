//! Network quality v1: shared wire contract, statistics and bounded native probe runtime.
#![allow(dead_code)] // The agent and Hub intentionally use different portions of this module.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::net::{Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_TARGETS: usize = 8;
pub const MAX_POINTS: usize = 270;
pub const MIN_INTERVAL_SEC: u16 = 10;
pub const MAX_INTERVAL_SEC: u16 = 300;
pub const DEFAULT_INTERVAL_SEC: u16 = 20;
const BUDGET: Duration = Duration::from_millis(1500);

fn default_port() -> u16 {
    80
}

fn default_interval_sec() -> u16 {
    DEFAULT_INTERVAL_SEC
}

fn is_default_interval_sec(v: &u16) -> bool {
    *v == DEFAULT_INTERVAL_SEC
}

pub fn target_sort_key(id: &str) -> (u8, &str) {
    let rank = match id {
        "ct" => 0,
        "cu" => 1,
        "cm" => 2,
        _ => 3,
    };
    (rank, id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub enabled: bool,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub address_family: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    #[serde(
        default = "default_interval_sec",
        skip_serializing_if = "is_default_interval_sec"
    )]
    pub interval_sec: u16,
    pub targets: Vec<Target>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeOverride {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Config>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlTarget {
    #[serde(flatten)]
    pub target: Target,
    pub target_revision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    pub schema_version: u8,
    pub config_id: String,
    pub enabled: bool,
    #[serde(
        default = "default_interval_sec",
        skip_serializing_if = "is_default_interval_sec"
    )]
    pub interval_sec: u16,
    pub targets: Vec<ControlTarget>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeResult {
    Ok,
    ConnectTimeout,
    ConnectionRefused,
    DnsError,
    DnsTimeout,
    NetworkError,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub sample_id: String,
    pub round_seq: u64,
    pub config_id: String,
    pub target_id: String,
    pub target_revision: String,
    pub segment_id: String,
    pub ts: u64,
    pub result: ProbeResult,
    pub connect_ms: Option<f64>,
    pub remote_ip: Option<String>,
    pub target: Target,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Latest {
    pub target_id: String,
    pub target_revision: String,
    pub segment_id: String,
    pub target: Target,
    pub measured_at: u64,
    pub result: ProbeResult,
    pub remote_ip: Option<String>,
    pub latency_median_ms: Option<f64>,
    pub attempts: u64,
    pub failures: u64,
    pub failure_rate_pct: Option<f64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Payload {
    pub schema_version: u8,
    pub applied_config_id: Option<String>,
    pub enabled: bool,
    pub config_error: Option<String>,
    pub dropped_samples: u64,
    pub latest: Vec<Latest>,
    pub points: Vec<Point>,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub supported: bool,
    pub enabled: bool,
    pub applied_config_id: Option<String>,
    pub config_error: Option<String>,
    pub dropped_samples: u64,
    pub latest: Vec<Latest>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryPoint {
    pub ts: u64,
    pub segment_id: String,
    pub target_revision: String,
    pub target: Target,
    pub remote_ip: Option<String>,
    pub round_seq: Option<u64>,
    pub result: Option<ProbeResult>,
    pub latency_ms: Option<f64>,
    pub latency_max_ms: Option<f64>,
    pub attempts: u64,
    pub failures: u64,
    pub success_count: u64,
    pub latency_sum_ms: f64,
    pub failure_rate_pct: Option<f64>,
}

pub fn default_config() -> Config {
    Config {
        enabled: false,
        interval_sec: DEFAULT_INTERVAL_SEC,
        targets: [("ct", "电信"), ("cu", "联通"), ("cm", "移动")]
            .into_iter()
            .map(|(id, label)| Target {
                id: id.into(),
                enabled: true,
                label: label.into(),
                region: Some("广东".into()),
                host: format!("gd-{id}-v4.ip.zstaticcdn.com"),
                port: 80,
                address_family: "ipv4".into(),
            })
            .collect(),
    }
}
fn reject_unknown_keys(value: &Value, keys: &[&str]) -> Result<(), String> {
    let obj = value.as_object().ok_or("Expected an object")?;
    if obj.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("Unknown network quality field".into());
    }
    Ok(())
}
fn short_text(value: &str, max: usize) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Invalid network quality text".into());
    }
    let s = value.trim();
    if s.is_empty() || s.chars().count() > max {
        return Err("Invalid network quality text".into());
    }
    Ok(s.into())
}
fn optional_short_text(value: Option<&str>, max: usize) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    if raw.chars().any(char::is_control) {
        return Err("Invalid network quality text".into());
    }
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.chars().count() > max {
        return Err("Invalid network quality text".into());
    }
    Ok(Some(s.into()))
}
fn valid_target_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 24
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}
fn validate_host(raw: &str) -> Result<String, String> {
    let host = short_text(raw, 253)?.to_ascii_lowercase();
    if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        if !host.parse::<Ipv4Addr>().is_ok_and(is_public_ipv4) {
            return Err("Target must be a public IPv4 address".into());
        }
    } else if !host.contains('.')
        || !host.split('.').all(|p| {
            !p.is_empty()
                && p.len() <= 63
                && p.as_bytes()[0].is_ascii_alphanumeric()
                && p.as_bytes()[p.len() - 1].is_ascii_alphanumeric()
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("Invalid target hostname".into());
    }
    Ok(host)
}
pub fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a != 0
        && a != 10
        && a != 127
        && a < 224
        && !(a == 100 && (64..=127).contains(&b))
        && !(a == 169 && b == 254)
        && !(a == 172 && (16..=31).contains(&b))
        && !(a == 192 && b == 168)
        && !(a == 192 && b == 0 && (c == 0 || c == 2))
        && !(a == 192 && b == 88 && c == 99)
        && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        && !(a == 203 && b == 0 && c == 113)
}
pub fn normalize_target(mut t: Target) -> Result<Target, String> {
    if !valid_target_id(&t.id) || t.address_family != "ipv4" || t.port == 0 {
        return Err("Invalid target identity, port or address family".into());
    }
    t.label = short_text(&t.label, 32)?;
    t.region = optional_short_text(t.region.as_deref(), 64)?;
    t.host = validate_host(&t.host)?;
    Ok(t)
}
pub fn normalize_config(mut c: Config) -> Result<Config, String> {
    if !(MIN_INTERVAL_SEC..=MAX_INTERVAL_SEC).contains(&c.interval_sec) {
        return Err("Invalid probe interval".into());
    }
    if !(1..=MAX_TARGETS).contains(&c.targets.len()) {
        return Err("Expected 1 to 8 targets".into());
    }
    let mut normalized = Vec::with_capacity(c.targets.len());
    let mut seen = HashSet::with_capacity(c.targets.len());
    for target in c.targets {
        let t = normalize_target(target)?;
        if !seen.insert(t.id.clone()) {
            return Err("Duplicate target id".into());
        }
        normalized.push(t);
    }
    normalized.sort_by(|a, b| target_sort_key(&a.id).cmp(&target_sort_key(&b.id)));
    c.targets = normalized;
    Ok(c)
}
fn reject_unknown_target_keys(v: &Value, allow_revision: bool) -> Result<(), String> {
    if allow_revision {
        reject_unknown_keys(
            v,
            &[
                "id",
                "enabled",
                "label",
                "region",
                "host",
                "port",
                "address_family",
                "target_revision",
            ],
        )
    } else {
        reject_unknown_keys(
            v,
            &[
                "id",
                "enabled",
                "label",
                "region",
                "host",
                "port",
                "address_family",
            ],
        )
    }
}
pub fn parse_target(v: &Value) -> Result<Target, String> {
    reject_unknown_target_keys(v, false)?;
    let t: Target = serde_json::from_value(v.clone()).map_err(|_| "Invalid network target")?;
    normalize_target(t)
}
pub fn parse_config(v: &Value) -> Result<Config, String> {
    let raw_targets = v
        .as_object()
        .and_then(|o| o.get("targets"))
        .and_then(|t| t.as_array())
        .ok_or("Expected target array")?;
    for target in raw_targets {
        reject_unknown_target_keys(target, false)?;
    }
    let c: Config = serde_json::from_value(v.clone()).map_err(|_| "Invalid network config")?;
    normalize_config(c)
}
pub fn parse_override(v: &Value) -> Result<NodeOverride, String> {
    let o: NodeOverride =
        serde_json::from_value(v.clone()).map_err(|_| "Invalid node network mode")?;
    match o.mode.as_str() {
        "custom" => {
            let Some(cfg) = o.config else {
                return Err("Missing custom config".into());
            };
            if let Some(targets) = v
                .get("config")
                .and_then(|c| c.get("targets"))
                .and_then(|t| t.as_array())
            {
                for target in targets {
                    reject_unknown_target_keys(target, false)?;
                }
            }
            Ok(NodeOverride {
                mode: o.mode,
                config: Some(normalize_config(cfg)?),
            })
        }
        "inherit" | "off" if v.get("config").is_none() => Ok(NodeOverride {
            mode: o.mode,
            config: None,
        }),
        _ => Err("Invalid node network mode".into()),
    }
}
fn target_array(t: &Target) -> Value {
    json!([
        t.id,
        t.enabled,
        t.label,
        t.region,
        t.host,
        t.port,
        t.address_family
    ])
}
pub fn target_revision(t: &Target) -> String {
    crate::crypto::sha256_hex(target_array(t).to_string().as_bytes())
}
pub fn make_control(c: &Config) -> Control {
    let mut targets = c.targets.clone();
    targets.sort_by(|a, b| target_sort_key(&a.id).cmp(&target_sort_key(&b.id)));
    let target_arrays: Vec<Value> = targets.iter().map(target_array).collect();
    let config_input = if c.interval_sec == DEFAULT_INTERVAL_SEC {
        json!(["network_quality_v1", c.enabled, target_arrays])
    } else {
        json!([
            "network_quality_v1",
            c.enabled,
            target_arrays,
            c.interval_sec
        ])
    };
    Control {
        schema_version: 1,
        config_id: crate::crypto::sha256_hex(config_input.to_string().as_bytes()),
        enabled: c.enabled,
        interval_sec: c.interval_sec,
        targets: targets
            .into_iter()
            .map(|t| ControlTarget {
                target_revision: target_revision(&t),
                target: t,
            })
            .collect(),
    }
}
pub fn effective_control(global: &Config, node: &NodeOverride) -> Result<Control, String> {
    let mut config = match node.mode.as_str() {
        "inherit" | "off" => global.clone(),
        "custom" => node.config.clone().ok_or("Missing custom config")?,
        _ => return Err("Invalid node mode".into()),
    };
    if node.mode == "off" {
        config.enabled = false;
    }
    Ok(make_control(&normalize_config(config)?))
}
pub fn parse_control(v: &Value) -> Result<Control, String> {
    let raw_targets = v
        .as_object()
        .and_then(|o| o.get("targets"))
        .and_then(|t| t.as_array())
        .ok_or("Invalid control targets")?;
    for target in raw_targets {
        reject_unknown_target_keys(target, true)?;
    }
    let c: Control = serde_json::from_value(v.clone()).map_err(|_| "Invalid network control")?;
    if c.schema_version != 1 {
        return Err("Network control schema mismatch".into());
    }
    let cfg = normalize_config(Config {
        enabled: c.enabled,
        interval_sec: c.interval_sec,
        targets: c.targets.iter().map(|t| t.target.clone()).collect(),
    })?;
    let normalized = make_control(&cfg);
    if c != normalized {
        return Err("Network control hash or schema mismatch".into());
    }
    Ok(c)
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control)
}
pub fn validate_payload(v: &Value, now: u64) -> Result<Payload, String> {
    if v.to_string().len() > 128 * 1024 {
        return Err("Oversized network payload".into());
    }
    // Aggregates are ignored, but their envelope is bounded. The store rebuilds them from raw data.
    if v["latest"].as_array().is_none_or(|a| a.len() > MAX_TARGETS) {
        return Err("Invalid network latest array".into());
    }
    let mut sanitized = v.clone();
    sanitized["latest"] = json!([]);
    let mut p: Payload =
        serde_json::from_value(sanitized).map_err(|_| "Invalid network payload")?;
    if p.schema_version != 1
        || p.points.len() > MAX_POINTS
        || p.applied_config_id.as_ref().is_some_and(|s| !digest(s))
        || p.config_error.as_ref().is_some_and(|s| s.len() > 256)
    {
        return Err("Invalid network payload header".into());
    }
    for q in &mut p.points {
        q.target = normalize_target(std::mem::replace(
            &mut q.target,
            Target {
                id: String::new(),
                enabled: false,
                label: String::new(),
                region: None,
                host: String::new(),
                port: 80,
                address_family: String::new(),
            },
        ))?;
        let good_ip = q
            .remote_ip
            .as_ref()
            .is_none_or(|s| s.parse::<Ipv4Addr>().is_ok_and(is_public_ipv4));
        if !identifier(&q.sample_id)
            || !identifier(&q.segment_id)
            || !digest(&q.config_id)
            || q.target_id != q.target.id
            || q.target_revision != target_revision(&q.target)
            || !good_ip
        {
            return Err("Invalid network point identity".into());
        }
        if q.result == ProbeResult::Ok {
            if !q
                .connect_ms
                .is_some_and(|ms| ms.is_finite() && (0.0..=1500.0).contains(&ms))
                || q.remote_ip.is_none()
            {
                return Err("Invalid successful probe".into());
            }
        } else if q.connect_ms.is_some() {
            return Err("Failed probe has latency".into());
        }
        if matches!(q.result, ProbeResult::DnsError | ProbeResult::DnsTimeout)
            && q.remote_ip.is_some()
        {
            return Err("DNS failure has remote IP".into());
        }
    }
    p.points
        .retain(|q| q.ts >= now.saturating_sub(1800) && q.ts <= now.saturating_add(60));
    Ok(p)
}
fn window<'a>(points: &'a [Point], end: &Point) -> Vec<&'a Point> {
    let mut w: Vec<_> = points
        .iter()
        .filter(|p| {
            p.target_id == end.target_id
                && p.segment_id == end.segment_id
                && p.ts <= end.ts
                && end.ts - p.ts < 120
        })
        .collect();
    w.sort_by_key(|p| (p.ts, p.round_seq));
    if w.len() > 6 {
        w.drain(..w.len() - 6);
    }
    w
}
pub fn latest_from_points(points: &[Point]) -> Vec<Latest> {
    let mut ids: Vec<&str> = points.iter().map(|p| p.target_id.as_str()).collect();
    ids.sort_by_key(|id| target_sort_key(id));
    ids.dedup();
    ids.into_iter()
        .filter_map(|id| {
            points
                .iter()
                .filter(|p| p.target_id == id)
                .max_by_key(|p| (p.ts, p.round_seq))
                .map(|p| {
                    let w = window(points, p);
                    let mut ok: Vec<_> = w.iter().filter_map(|p| p.connect_ms).collect();
                    ok.sort_by(f64::total_cmp);
                    let n = ok.len();
                    let median = if n == 0 {
                        None
                    } else if n % 2 == 1 {
                        Some(ok[n / 2])
                    } else {
                        Some((ok[n / 2 - 1] + ok[n / 2]) / 2.0)
                    };
                    Latest {
                        target_id: p.target_id.clone(),
                        target_revision: p.target_revision.clone(),
                        segment_id: p.segment_id.clone(),
                        target: p.target.clone(),
                        measured_at: p.ts,
                        result: p.result,
                        remote_ip: p.remote_ip.clone(),
                        latency_median_ms: median,
                        attempts: w.len() as u64,
                        failures: (w.len() - n) as u64,
                        failure_rate_pct: Some((w.len() - n) as f64 * 100.0 / w.len() as f64),
                    }
                })
        })
        .collect()
}
fn query_point(p: &Point, w: &[&Point], bucket: bool) -> QueryPoint {
    let ok: Vec<f64> = w.iter().filter_map(|p| p.connect_ms).collect();
    let sum: f64 = ok.iter().sum();
    QueryPoint {
        ts: if bucket { p.ts / 300 * 300 } else { p.ts },
        segment_id: p.segment_id.clone(),
        target_revision: p.target_revision.clone(),
        target: p.target.clone(),
        remote_ip: p.remote_ip.clone(),
        round_seq: if bucket { None } else { Some(p.round_seq) },
        result: if bucket { None } else { Some(p.result) },
        latency_ms: if bucket {
            (!ok.is_empty()).then(|| sum / ok.len() as f64)
        } else {
            p.connect_ms
        },
        latency_max_ms: ok.iter().copied().reduce(f64::max),
        attempts: w.len() as u64,
        failures: (w.len() - ok.len()) as u64,
        success_count: ok.len() as u64,
        latency_sum_ms: sum,
        failure_rate_pct: (!w.is_empty())
            .then(|| (w.len() - ok.len()) as f64 * 100.0 / w.len() as f64),
    }
}
pub fn raw_query_points(points: &[Point]) -> Vec<QueryPoint> {
    let mut sorted: Vec<_> = points.iter().collect();
    sorted.sort_by_key(|p| (p.ts, p.round_seq));
    let mut windows: BTreeMap<(&str, &str), VecDeque<&Point>> = BTreeMap::new();
    sorted
        .into_iter()
        .map(|p| {
            let w = windows.entry((&p.target_id, &p.segment_id)).or_default();
            w.push_back(p);
            while w.front().is_some_and(|q| p.ts - q.ts >= 120) || w.len() > 6 {
                w.pop_front();
            }
            query_point(p, &w.iter().copied().collect::<Vec<_>>(), false)
        })
        .collect()
}
pub fn rollup_points(points: &[Point]) -> Vec<QueryPoint> {
    let mut groups: BTreeMap<(u64, &str, &str), Vec<&Point>> = BTreeMap::new();
    for p in points {
        groups
            .entry((p.ts / 300 * 300, &p.target_id, &p.segment_id))
            .or_default()
            .push(p);
    }
    groups
        .values()
        .map(|w| {
            let mut point = query_point(
                w.iter().max_by_key(|p| (p.ts, p.round_seq)).unwrap(),
                w,
                true,
            );
            point.remote_ip = w
                .iter()
                .filter(|p| p.remote_ip.is_some())
                .max_by_key(|p| (p.ts, p.round_seq))
                .and_then(|p| p.remote_ip.clone());
            point
        })
        .collect()
}

fn wall_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone)]
struct ProbeJob {
    target_id: String,
    sequence: u64,
    generation: u64,
    cancel_epoch: Arc<AtomicU64>,
    target: ControlTarget,
    cancelled: Arc<AtomicBool>,
    interval: Duration,
}
enum Outcome {
    Measured(ProbeResult, Option<f64>, Option<Ipv4Addr>),
    Blocked,
    Cancelled,
}
#[allow(clippy::large_enum_variant)]
enum ProbeEvent {
    Started(String, u64, Instant),
    Resolved(String, u64),
    Finished(usize, ProbeJob, Outcome, u64),
}
struct ActiveJob {
    worker_idx: usize,
    job: ProbeJob,
    started: Option<Instant>,
    dns_pending: bool,
    emitted: bool,
}
#[derive(Default)]
struct Segment {
    revision: String,
    id: String,
    ip: Option<Ipv4Addr>,
}
struct QueuedPoint {
    point: Point,
    serialized_len: usize,
}
struct RuntimeState {
    control: Option<Control>,
    negotiated: bool,
    config_error: Option<String>,
    target_errors: HashMap<String, String>,
    generations: HashMap<String, Arc<AtomicU64>>,
    queue: VecDeque<QueuedPoint>,
    recent: VecDeque<Point>,
    latest: Vec<Latest>,
    dropped: u64,
    round: u64,
    segment_counter: u64,
    session: String,
    segments: HashMap<String, Segment>,
}
impl RuntimeState {
    fn generation_for(&mut self, id: &str) -> Arc<AtomicU64> {
        self.generations
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone()
    }
    fn bump_generation(&mut self, id: &str) {
        self.generation_for(id).fetch_add(1, Ordering::AcqRel);
    }
    fn current_generation(&self, id: &str) -> u64 {
        self.generations
            .get(id)
            .map_or(0, |g| g.load(Ordering::Acquire))
    }
    fn refresh_config_error(&mut self) {
        self.config_error = self
            .target_errors
            .iter()
            .min_by_key(|(id, _)| target_sort_key(id))
            .map(|(_, msg)| msg.clone());
    }
    fn trim(&mut self, now: u64) {
        while self
            .queue
            .front()
            .is_some_and(|p| p.point.ts < now.saturating_sub(1800))
            || self.queue.len() > MAX_POINTS
        {
            self.queue.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
    }
    fn complete(&mut self, job: &ProbeJob, outcome: Outcome, ts: u64) {
        if job.generation != self.current_generation(&job.target_id)
            || !self.control.as_ref().is_some_and(|c| c.enabled)
        {
            return;
        }
        let (result, connect_ms, ip) = match outcome {
            Outcome::Measured(result, ms, ip) => (result, ms, ip),
            Outcome::Blocked => {
                self.target_errors.insert(
                    job.target_id.clone(),
                    format!("{}: resolved address blocked", job.target_id),
                );
                self.refresh_config_error();
                return;
            }
            Outcome::Cancelled => return,
        };
        self.target_errors.remove(&job.target_id);
        self.refresh_config_error();
        let segment = self.segments.entry(job.target_id.clone()).or_default();
        if segment.revision != job.target.target_revision
            || (segment.ip.is_some() && ip.is_some() && segment.ip != ip)
            || segment.id.is_empty()
        {
            self.segment_counter += 1;
            *segment = Segment {
                revision: job.target.target_revision.clone(),
                id: format!(
                    "{}:{}:{}",
                    self.session, job.target_id, self.segment_counter
                ),
                ip,
            };
        } else if ip.is_some() {
            segment.ip = ip;
        }
        let point = Point {
            sample_id: format!("{}:{}:{}", self.session, job.sequence, job.target_id),
            round_seq: job.sequence,
            // A different target may have changed while this attempt was in
            // flight. The generation check above proves this target is still
            // valid; acknowledge its measurement under the current control.
            config_id: self.control.as_ref().unwrap().config_id.clone(),
            target_id: job.target_id.clone(),
            target_revision: job.target.target_revision.clone(),
            segment_id: segment.id.clone(),
            ts,
            result,
            connect_ms,
            remote_ip: ip.map(|ip| ip.to_string()),
            target: job.target.target.clone(),
        };
        let serialized_len = serde_json::to_vec(&point).map_or(usize::MAX, |v| v.len());
        self.queue.push_back(QueuedPoint {
            point: point.clone(),
            serialized_len,
        });
        self.recent.push_back(point);
        // Keep six attempts per target/segment independently of the transmission queue.
        let end = self.recent.back().unwrap().clone();
        let keep: HashSet<String> = window(self.recent.make_contiguous(), &end)
            .iter()
            .map(|p| p.sample_id.clone())
            .collect();
        self.recent
            .retain(|p| p.target_id != end.target_id || keep.contains(&p.sample_id));
        self.latest = latest_from_points(self.recent.make_contiguous());
        self.trim(ts);
    }
}

/// Bounded background probe runtime: one scheduler and a lazily-grown, capped pool of
/// resolver/connector workers (at most 2 * MAX_TARGETS threads). A stalled system resolver
/// occupies its worker; later rounds skip that target until it returns.
pub struct ProbeRuntime {
    state: Arc<Mutex<RuntimeState>>,
    stop: Arc<AtomicBool>,
}
impl ProbeRuntime {
    pub fn new(node_id: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let session = crate::crypto::sha256_hex(
            format!("{node_id}:{nonce}:{}", std::process::id()).as_bytes(),
        )[..24]
            .to_owned();
        let state = Arc::new(Mutex::new(RuntimeState {
            control: None,
            negotiated: false,
            config_error: None,
            target_errors: HashMap::new(),
            generations: HashMap::new(),
            queue: VecDeque::new(),
            recent: VecDeque::new(),
            latest: vec![],
            dropped: 0,
            round: 0,
            segment_counter: 0,
            session,
            segments: HashMap::new(),
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let digest = crate::crypto::sha256_hex(node_id.as_bytes());
        let offset =
            Duration::from_millis(u64::from_str_radix(&digest[..8], 16).unwrap_or(0) % 2001);
        let (s, quit) = (state.clone(), stop.clone());
        if std::thread::Builder::new()
            .name("uniob-nq".into())
            .stack_size(128 * 1024)
            .spawn(move || run_probes(s, quit, offset))
            .is_err()
        {
            state.lock().unwrap().config_error = Some("probe executor unavailable".into());
        }
        Self { state, stop }
    }
    /// `first` means the first ctrl on this physical connection. Missing configuration
    /// there disables an old inherited configuration; later omission leaves it intact.
    pub fn apply_control(&self, value: Option<&Value>, first: bool) {
        let mut s = self.state.lock().unwrap();
        let control = match value {
            Some(v) => match parse_control(v) {
                Ok(c) => Some(c),
                Err(_) => {
                    s.config_error = Some("invalid network quality configuration".into());
                    // An invalid extension stops probing until a valid configuration arrives.
                    s.negotiated = true;
                    s.control = None;
                    for g in s.generations.values() {
                        g.fetch_add(1, Ordering::AcqRel);
                    }
                    return;
                }
            },
            None if first => {
                s.negotiated = false;
                None
            }
            None => return,
        };
        if value.is_some() {
            s.negotiated = true;
        }
        if s.control != control {
            let old = s.control.clone();
            let mut ids = HashSet::new();
            if let Some(ref c) = old {
                for t in &c.targets {
                    ids.insert(t.target.id.clone());
                }
            }
            if let Some(ref c) = control {
                for t in &c.targets {
                    ids.insert(t.target.id.clone());
                }
            }
            for id in ids {
                let before = old.as_ref().and_then(|c| {
                    c.targets
                        .iter()
                        .find(|t| t.target.id == id)
                        .map(|t| (t, c.enabled))
                });
                let after = control.as_ref().and_then(|c| {
                    c.targets
                        .iter()
                        .find(|t| t.target.id == id)
                        .map(|t| (t, c.enabled))
                });
                if before != after {
                    s.bump_generation(&id);
                    s.segments.remove(&id);
                    s.target_errors.remove(&id);
                    s.recent.retain(|p| p.target_id != id);
                    s.latest.retain(|p| p.target_id != id);
                }
            }
            s.control = control;
            s.refresh_config_error();
        }
    }
    pub fn payload(&self) -> Option<Payload> {
        let mut s = self.state.lock().unwrap();
        if !s.negotiated {
            return None;
        }
        s.trim(wall_time());
        let c = s.control.as_ref();
        let mut p = Payload {
            schema_version: 1,
            applied_config_id: c.map(|c| c.config_id.clone()),
            enabled: c.is_some_and(|c| c.enabled),
            config_error: s.config_error.clone(),
            dropped_samples: s.dropped,
            latest: s.latest.clone(),
            points: vec![],
        };
        // Verbose user labels can make buffered points exceed the 128 KiB envelope.
        // Use the serialized byte size cached on enqueue so repeated calls never re-serialize points.
        let mut size = serde_json::to_vec(&p).ok()?.len();
        for entry in &s.queue {
            let cost = entry
                .serialized_len
                .saturating_add(usize::from(!p.points.is_empty()));
            if size + cost > 128 * 1024 {
                break;
            }
            size += cost;
            p.points.push(entry.point.clone());
        }
        Some(p)
    }
    pub fn mark_sent(&self, payload: &Payload) {
        let ids: HashSet<&str> = payload
            .points
            .iter()
            .map(|p| p.sample_id.as_str())
            .collect();
        self.state
            .lock()
            .unwrap()
            .queue
            .retain(|entry| !ids.contains(entry.point.sample_id.as_str()));
    }
}
impl Drop for ProbeRuntime {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(s) = self.state.lock() {
            for g in s.generations.values() {
                g.fetch_add(1, Ordering::AcqRel);
            }
        }
    }
}

fn run_probes(state: Arc<Mutex<RuntimeState>>, stop: Arc<AtomicBool>, offset: Duration) {
    run_probes_with_resolver(state, stop, offset, None, BUDGET, Arc::new(resolve));
}

struct WorkerHandle {
    tx: mpsc::SyncSender<ProbeJob>,
    busy: bool,
    last_target: String,
}

type Resolver = Arc<dyn Fn(&Target) -> Resolution + Send + Sync>;
fn run_probes_with_resolver(
    state: Arc<Mutex<RuntimeState>>,
    stop: Arc<AtomicBool>,
    offset: Duration,
    interval_override: Option<Duration>,
    budget: Duration,
    resolver: Resolver,
) {
    let (events_tx, events_rx) = mpsc::sync_channel::<ProbeEvent>(MAX_TARGETS * 8);
    let mut workers: Vec<WorkerHandle> = Vec::new();
    let mut active: HashMap<String, ActiveJob> = HashMap::new();
    let mut next = Instant::now() + offset;
    let mut was_enabled = false;
    let mut last_interval: Option<Duration> = None;
    let mut worker_spawn_failed = false;

    while !stop.load(Ordering::Acquire) {
        while let Ok(event) = events_rx.try_recv() {
            match event {
                ProbeEvent::Started(target_id, seq, started) => {
                    if let Some(a) = active.get_mut(&target_id) {
                        if a.job.sequence == seq {
                            a.started = Some(started);
                        }
                    }
                }
                ProbeEvent::Resolved(target_id, seq) => {
                    if let Some(a) = active.get_mut(&target_id) {
                        if a.job.sequence == seq {
                            a.dns_pending = false;
                        }
                    }
                }
                ProbeEvent::Finished(worker_idx, job, outcome, ts) => {
                    if let Some(w) = workers.get_mut(worker_idx) {
                        w.busy = false;
                    }
                    if active
                        .get(&job.target_id)
                        .is_some_and(|a| a.job.sequence == job.sequence)
                    {
                        let a = active.remove(&job.target_id).unwrap();
                        if !a.emitted {
                            state.lock().unwrap().complete(&job, outcome, ts);
                        }
                    }
                }
            }
        }
        let now = Instant::now();
        for a in active.values_mut() {
            if a.dns_pending
                && !a.emitted
                && a.started
                    .is_some_and(|started| now.duration_since(started) >= budget)
            {
                a.job.cancelled.store(true, Ordering::Release);
                a.emitted = true;
                state.lock().unwrap().complete(
                    &a.job,
                    Outcome::Measured(ProbeResult::DnsTimeout, None, None),
                    wall_time(),
                );
            }
        }
        let control = {
            let mut s = state.lock().unwrap();
            // Expire retained samples even while disabled or disconnected, when no
            // resource frame is asking for a payload.
            s.trim(wall_time());
            s.control.clone().filter(|c| c.enabled)
        };
        let active_interval = interval_override.unwrap_or_else(|| {
            control
                .as_ref()
                .map_or(Duration::from_secs(u64::from(DEFAULT_INTERVAL_SEC)), |c| {
                    Duration::from_secs(u64::from(c.interval_sec))
                })
        });
        if control.is_some() {
            if !was_enabled {
                next = next.max(now + offset);
            } else if last_interval.is_some_and(|prev| prev != active_interval) {
                next = next.min(now + active_interval);
            }
            last_interval = Some(active_interval);
        }
        was_enabled = control.is_some();
        if let Some(control) = control {
            if now >= next && !worker_spawn_failed {
                // No catch-up probes after congestion or a long scheduler pause.
                next = now + active_interval;
                let enabled_targets: Vec<ControlTarget> = control
                    .targets
                    .into_iter()
                    .filter(|t| t.target.enabled && !active.contains_key(&t.target.id))
                    .collect();
                if !enabled_targets.is_empty() {
                    let mut dispatch = Vec::with_capacity(enabled_targets.len());
                    {
                        let mut s = state.lock().unwrap();
                        s.round += 1;
                        let sequence = s.round;
                        for target in enabled_targets {
                            let cancel_epoch = s.generation_for(&target.target.id);
                            let generation = cancel_epoch.load(Ordering::Acquire);
                            dispatch.push((target, sequence, generation, cancel_epoch));
                        }
                    }
                    for (target, sequence, generation, cancel_epoch) in dispatch {
                        let target_id = target.target.id.clone();
                        let worker_idx = workers
                            .iter()
                            .position(|w| !w.busy && w.last_target == target_id)
                            .or_else(|| workers.iter().position(|w| !w.busy));
                        let worker_idx = match worker_idx {
                            Some(idx) => idx,
                            None if workers.len() < MAX_TARGETS * 2 => {
                                let idx = workers.len();
                                let (tx, rx) = mpsc::sync_channel::<ProbeJob>(1);
                                let events = events_tx.clone();
                                let resolve = resolver.clone();
                                if std::thread::Builder::new()
                                    .name(format!("uniob-nq-{idx}"))
                                    .stack_size(128 * 1024)
                                    .spawn(move || probe_worker(idx, rx, events, budget, resolve))
                                    .is_err()
                                {
                                    worker_spawn_failed = true;
                                    state.lock().unwrap().config_error =
                                        Some("probe worker unavailable".into());
                                    break;
                                }
                                workers.push(WorkerHandle {
                                    tx,
                                    busy: false,
                                    last_target: target_id.clone(),
                                });
                                idx
                            }
                            None => continue,
                        };
                        let job = ProbeJob {
                            target_id: target_id.clone(),
                            sequence,
                            generation,
                            cancel_epoch,
                            target,
                            cancelled: Arc::new(AtomicBool::new(false)),
                            interval: active_interval,
                        };
                        if workers[worker_idx].tx.try_send(job.clone()).is_ok() {
                            workers[worker_idx].busy = true;
                            workers[worker_idx].last_target = target_id.clone();
                            active.insert(
                                target_id,
                                ActiveJob {
                                    worker_idx,
                                    job,
                                    started: None,
                                    dns_pending: true,
                                    emitted: false,
                                },
                            );
                        }
                    }
                }
            }
        }
        std::thread::sleep(if was_enabled || !active.is_empty() {
            Duration::from_millis(20).min(active_interval / 4)
        } else {
            Duration::from_millis(200)
        });
    }
    for a in active.into_values() {
        a.job.cancelled.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
enum Resolution {
    Address(Ipv4Addr),
    Error,
    Blocked,
}
fn resolve(target: &Target) -> Resolution {
    if let Ok(ip) = target.host.parse::<Ipv4Addr>() {
        return if is_public_ipv4(ip) {
            Resolution::Address(ip)
        } else {
            Resolution::Blocked
        };
    }
    match (target.host.as_str(), target.port).to_socket_addrs() {
        Ok(addresses) => {
            let mut ipv4: Vec<_> = addresses
                .filter_map(|a| {
                    if let SocketAddr::V4(a) = a {
                        Some(*a.ip())
                    } else {
                        None
                    }
                })
                .collect();
            ipv4.sort();
            ipv4.dedup();
            if let Some(ip) = ipv4.iter().find(|ip| is_public_ipv4(**ip)) {
                Resolution::Address(*ip)
            } else if ipv4.is_empty() {
                Resolution::Error
            } else {
                Resolution::Blocked
            }
        }
        Err(_) => Resolution::Error,
    }
}
fn probe_worker(
    worker_idx: usize,
    rx: mpsc::Receiver<ProbeJob>,
    events: mpsc::SyncSender<ProbeEvent>,
    budget: Duration,
    resolve: Resolver,
) {
    let mut cache: Option<(String, u16, Instant, Resolution)> = None;
    while let Ok(job) = rx.recv() {
        let live = || {
            !job.cancelled.load(Ordering::Acquire)
                && job.cancel_epoch.load(Ordering::Acquire) == job.generation
        };
        let started = Instant::now();
        if !live() {
            if events
                .send(ProbeEvent::Finished(
                    worker_idx,
                    job,
                    Outcome::Cancelled,
                    wall_time(),
                ))
                .is_err()
            {
                break;
            }
            continue;
        }
        if events
            .send(ProbeEvent::Started(
                job.target_id.clone(),
                job.sequence,
                started,
            ))
            .is_err()
        {
            break;
        }
        let resolution = if let Some((host, port, expires, result)) = &cache {
            if *host == job.target.target.host
                && *port == job.target.target.port
                && *expires > started
            {
                result.clone()
            } else {
                resolve(&job.target.target)
            }
        } else {
            resolve(&job.target.target)
        };
        if !live() || started.elapsed() > budget {
            let outcome = if live() {
                Outcome::Measured(ProbeResult::DnsTimeout, None, None)
            } else {
                Outcome::Cancelled
            };
            if events
                .send(ProbeEvent::Finished(worker_idx, job, outcome, wall_time()))
                .is_err()
            {
                break;
            }
            continue;
        }
        // Never extend a cache hit's expiry. Multi-A selection stays stable for ten minutes.
        if !cache.as_ref().is_some_and(|(host, port, expires, _)| {
            *host == job.target.target.host && *port == job.target.target.port && *expires > started
        }) {
            cache = Some((
                job.target.target.host.clone(),
                job.target.target.port,
                started
                    + if matches!(resolution, Resolution::Address(_)) {
                        Duration::from_secs(600)
                    } else {
                        job.interval
                    },
                resolution.clone(),
            ));
        }
        if events
            .send(ProbeEvent::Resolved(job.target_id.clone(), job.sequence))
            .is_err()
        {
            break;
        }
        let outcome = match resolution {
            Resolution::Error => Outcome::Measured(ProbeResult::DnsError, None, None),
            Resolution::Blocked => Outcome::Blocked,
            Resolution::Address(ip) => {
                if !live() {
                    Outcome::Cancelled
                } else {
                    let connect_start = Instant::now();
                    match TcpStream::connect_timeout(
                        &SocketAddr::from((ip, job.target.target.port)),
                        budget,
                    ) {
                        Ok(stream) => {
                            drop(stream);
                            let elapsed = connect_start.elapsed();
                            if elapsed > budget {
                                Outcome::Measured(ProbeResult::ConnectTimeout, None, Some(ip))
                            } else {
                                Outcome::Measured(
                                    ProbeResult::Ok,
                                    Some(elapsed.as_secs_f64() * 1000.0),
                                    Some(ip),
                                )
                            }
                        }
                        Err(e) => Outcome::Measured(
                            match e.kind() {
                                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                                    ProbeResult::ConnectTimeout
                                }
                                std::io::ErrorKind::ConnectionRefused => {
                                    ProbeResult::ConnectionRefused
                                }
                                _ => ProbeResult::NetworkError,
                            },
                            None,
                            Some(ip),
                        ),
                    }
                }
            }
        };
        let outcome = if live() { outcome } else { Outcome::Cancelled };
        if events
            .send(ProbeEvent::Finished(worker_idx, job, outcome, wall_time()))
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Condvar};

    fn fixture() -> Value {
        serde_json::from_str(include_str!("fixtures/network-quality-v1.json")).unwrap()
    }
    fn runtime() -> ProbeRuntime {
        ProbeRuntime {
            state: Arc::new(Mutex::new(RuntimeState {
                control: None,
                negotiated: false,
                config_error: None,
                target_errors: HashMap::new(),
                generations: HashMap::new(),
                queue: VecDeque::new(),
                recent: VecDeque::new(),
                latest: vec![],
                dropped: 0,
                round: 0,
                segment_counter: 0,
                session: "test-session".into(),
                segments: HashMap::new(),
            })),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }
    fn enabled(runtime: &ProbeRuntime) -> Value {
        let mut c = default_config();
        c.enabled = true;
        let v = serde_json::to_value(make_control(&c)).unwrap();
        runtime.apply_control(Some(&v), true);
        v
    }
    fn job(runtime: &ProbeRuntime, slot: usize, sequence: u64) -> ProbeJob {
        let mut s = runtime.state.lock().unwrap();
        let target = s.control.as_ref().unwrap().targets[slot].clone();
        let target_id = target.target.id.clone();
        let interval = Duration::from_secs(u64::from(s.control.as_ref().unwrap().interval_sec));
        let cancel_epoch = s.generation_for(&target_id);
        let generation = cancel_epoch.load(Ordering::Acquire);
        ProbeJob {
            target_id,
            sequence,
            generation,
            cancel_epoch,
            target,
            cancelled: Arc::new(AtomicBool::new(false)),
            interval,
        }
    }
    fn complete(
        runtime: &ProbeRuntime,
        slot: usize,
        seq: u64,
        ts: u64,
        ip: Option<Ipv4Addr>,
    ) -> Point {
        let job = job(runtime, slot, seq);
        runtime.state.lock().unwrap().complete(
            &job,
            Outcome::Measured(
                if ip.is_some() {
                    ProbeResult::Ok
                } else {
                    ProbeResult::DnsError
                },
                ip.map(|_| seq as f64),
                ip,
            ),
            ts,
        );
        runtime
            .state
            .lock()
            .unwrap()
            .queue
            .back()
            .unwrap()
            .point
            .clone()
    }

    #[test]
    fn shared_fixture_hashes_medians_raw_and_rollups_match() {
        let f = fixture();
        let c = parse_config(&f["config"]).unwrap();
        assert_eq!(
            make_control(&c),
            serde_json::from_value::<Control>(f["control"].clone()).unwrap()
        );
        // Verify default interval_sec=20 omits "interval_sec" from serialized canonical JSON.
        let ctrl_json = serde_json::to_value(make_control(&c)).unwrap();
        assert!(ctrl_json.get("interval_sec").is_none());
        assert_eq!(ctrl_json["config_id"], f["control"]["config_id"]);
        let points: Vec<Point> = serde_json::from_value(f["points"].clone()).unwrap();
        assert_eq!(
            latest_from_points(&points),
            serde_json::from_value::<Vec<Latest>>(f["expected"]["latest"].clone()).unwrap()
        );
        for id in ["ct", "cu", "cm"] {
            let ps: Vec<_> = points
                .iter()
                .filter(|p| p.target_id == id)
                .cloned()
                .collect();
            assert_eq!(
                raw_query_points(&ps),
                serde_json::from_value::<Vec<QueryPoint>>(
                    f["expected"]["raw_by_target"][id].clone()
                )
                .unwrap()
            );
            assert_eq!(
                rollup_points(&ps),
                serde_json::from_value::<Vec<QueryPoint>>(
                    f["expected"]["rollup_by_target"][id].clone()
                )
                .unwrap()
            );
        }
    }
    #[test]
    fn custom_targets_sort_interval_and_optional_region() {
        let raw = json!({
            "enabled": true,
            "interval_sec": 30,
            "targets": [
                {
                    "id": "us-west",
                    "enabled": true,
                    "label": "US West",
                    "region": "   ",
                    "host": "1.1.1.1",
                    "address_family": "ipv4"
                },
                {
                    "id": "cm",
                    "enabled": true,
                    "label": "移动",
                    "host": "8.8.8.8",
                    "port": 443,
                    "address_family": "ipv4"
                },
                {
                    "id": "ap-hk_1",
                    "enabled": false,
                    "label": "Hong Kong",
                    "region": "HK",
                    "host": "example.com",
                    "port": 8443,
                    "address_family": "ipv4"
                },
                {
                    "id": "ct",
                    "enabled": true,
                    "label": "电信",
                    "region": "广东",
                    "host": "9.9.9.9",
                    "port": 80,
                    "address_family": "ipv4"
                }
            ]
        });
        let cfg = parse_config(&raw).unwrap();
        assert_eq!(cfg.interval_sec, 30);
        let ids: Vec<&str> = cfg.targets.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["ct", "cm", "ap-hk_1", "us-west"]);
        assert_eq!(cfg.targets[0].region.as_deref(), Some("广东"));
        assert_eq!(cfg.targets[1].region, None);
        assert_eq!(cfg.targets[3].region, None);
        assert_eq!(cfg.targets[3].port, 80);

        let serialized_cfg = serde_json::to_value(&cfg).unwrap();
        assert_eq!(serialized_cfg["interval_sec"], 30);
        assert!(serialized_cfg["targets"][1].get("region").is_none());
        assert!(serialized_cfg["targets"][3].get("region").is_none());

        let ctrl = make_control(&cfg);
        let ctrl_val = serde_json::to_value(&ctrl).unwrap();
        assert_eq!(ctrl_val["interval_sec"], 30);
        assert_eq!(parse_control(&ctrl_val).unwrap(), ctrl);

        // interval_sec == 20 yields identical config_id and omits field.
        let mut cfg20 = cfg.clone();
        cfg20.interval_sec = 20;
        let ctrl20 = make_control(&cfg20);
        assert_ne!(ctrl20.config_id, ctrl.config_id);
        let ctrl20_val = serde_json::to_value(&ctrl20).unwrap();
        assert!(ctrl20_val.get("interval_sec").is_none());
        assert_eq!(parse_control(&ctrl20_val).unwrap(), ctrl20);

        // Bounds checks: 0 targets, 9 targets, duplicate id, invalid slug, label > 32, C1 control, bad interval.
        assert!(parse_config(&json!({"enabled": true, "targets": []})).is_err());
        let eight: Vec<Value> = (1..=8)
            .map(|i| json!({"id": format!("t-{i}"), "enabled": true, "label": format!("T{i}"), "host": "1.1.1.1", "address_family": "ipv4"}))
            .collect();
        assert!(parse_config(&json!({"enabled": true, "targets": eight})).is_ok());
        let mut nine = eight;
        nine.push(json!({"id": "t-9", "enabled": true, "label": "T9", "host": "1.1.1.1", "address_family": "ipv4"}));
        assert!(parse_config(&json!({"enabled": true, "targets": nine})).is_err());

        for bad_id in ["", "-abc", "AB", "a b", "a".repeat(25).as_str()] {
            assert!(parse_config(&json!({"enabled": true, "targets": [{"id": bad_id, "enabled": true, "label": "x", "host": "1.1.1.1", "address_family": "ipv4"}]})).is_err(), "{bad_id}");
        }
        assert!(parse_config(&json!({"enabled": true, "targets": [{"id": "a", "enabled": true, "label": "x".repeat(33), "host": "1.1.1.1", "address_family": "ipv4"}]})).is_err());
        assert!(parse_config(&json!({"enabled": true, "targets": [{"id": "a", "enabled": true, "label": "hi\u{0085}", "host": "1.1.1.1", "address_family": "ipv4"}]})).is_err());
        assert!(parse_config(&json!({"enabled": true, "targets": [{"id": "a", "enabled": true, "label": "hi", "region": "r\u{007f}", "host": "1.1.1.1", "address_family": "ipv4"}]})).is_err());
        assert!(parse_config(&json!({"enabled": true, "interval_sec": 9, "targets": [{"id": "a", "enabled": true, "label": "hi", "host": "1.1.1.1", "address_family": "ipv4"}]})).is_err());
        assert!(parse_config(&json!({"enabled": true, "interval_sec": 301, "targets": [{"id": "a", "enabled": true, "label": "hi", "host": "1.1.1.1", "address_family": "ipv4"}]})).is_err());
    }
    #[test]
    fn unchanged_inflight_target_acknowledges_current_configuration() {
        let runtime = runtime();
        enabled(&runtime);
        let pending = job(&runtime, 1, 1);
        let mut config = default_config();
        config.enabled = true;
        config.targets[0].label = "Changed CT".into();
        let control = make_control(&config);
        runtime.apply_control(Some(&serde_json::to_value(&control).unwrap()), false);
        runtime.state.lock().unwrap().complete(
            &pending,
            Outcome::Measured(ProbeResult::Ok, Some(12.0), Some(Ipv4Addr::new(1, 1, 1, 1))),
            wall_time(),
        );
        let payload = runtime.payload().unwrap();
        assert_eq!(payload.points.len(), 1);
        assert_eq!(payload.points[0].config_id, control.config_id);
        assert_eq!(payload.points[0].target_id, "cu");
        assert_eq!(
            payload.applied_config_id.as_deref(),
            Some(control.config_id.as_str())
        );
    }
    #[test]
    fn config_normalization_and_public_ip_policy_are_strict() {
        let mut value = serde_json::to_value(default_config()).unwrap();
        value["targets"][0]["host"] = json!("  GD-CT-v4.ip.ZSTATICCDN.com ");
        assert_eq!(parse_config(&value).unwrap(), default_config());
        for ip in [
            "0.1.1.1",
            "10.1.2.3",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.1.1",
            "192.168.1.1",
            "100.64.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public_ipv4(ip.parse().unwrap()), "{ip}");
            value["targets"][0]["host"] = json!(ip);
            assert!(parse_config(&value).is_err());
        }
        for host in [
            "https://example.com",
            "example.com:80",
            "a@b.com",
            "*.example.com",
            "-a.example.com",
            "localhost",
            "0127.0.0.1",
        ] {
            value["targets"][0]["host"] = json!(host);
            assert!(parse_config(&value).is_err(), "{host}");
        }
        value = serde_json::to_value(default_config()).unwrap();
        value["surprise"] = json!(true);
        assert!(parse_config(&value).is_err());
        assert!(parse_override(&json!({"mode":"inherit","config":null})).is_err());
        let mut control = serde_json::to_value(make_control(&default_config())).unwrap();
        control["enabled"] = json!(true);
        assert!(parse_control(&control).is_err());
    }
    #[test]
    fn payload_validation_is_bounded_and_ignores_untrusted_aggregates() {
        let f = fixture();
        let now = 1700000200;
        let mut p = json!({"schema_version":1,"applied_config_id":f["control"]["config_id"],"enabled":true,"config_error":null,"dropped_samples":0,"latest":[{"fake":"aggregate"}],"points":f["points"]});
        let accepted = validate_payload(&p, now).unwrap();
        assert_eq!(accepted.points.len(), 16);
        assert!(accepted.latest.is_empty());
        p["points"][0]["remote_ip"] = json!("127.0.0.1");
        assert!(validate_payload(&p, now).is_err());
        p["points"] = f["points"].clone();
        p["points"][0]["ts"] = json!(now - 1801);
        assert_eq!(validate_payload(&p, now).unwrap().points.len(), 15);
        p["points"][1]["ts"] = json!(now + 61);
        assert_eq!(validate_payload(&p, now).unwrap().points.len(), 14);
        p["points"] = json!(vec![f["points"][0].clone(); 271]);
        assert!(validate_payload(&p, now).is_err());
    }
    #[test]
    fn same_config_reconnect_and_canary_preserve_segments_old_hub_stops() {
        let rt = runtime();
        assert!(rt.payload().is_none());
        let c = enabled(&rt);
        let now = wall_time();
        let first = complete(&rt, 0, 1, now, Some(Ipv4Addr::new(1, 1, 1, 1)));
        rt.apply_control(None, false);
        rt.apply_control(Some(&c), true);
        let second = complete(&rt, 0, 2, now + 20, Some(Ipv4Addr::new(1, 1, 1, 1)));
        assert_eq!(first.segment_id, second.segment_id);
        assert_eq!(rt.payload().unwrap().latest[0].attempts, 2);
        let old_job = job(&rt, 0, 3);
        rt.apply_control(None, true);
        assert!(rt.payload().is_none());
        let mut state = rt.state.lock().unwrap();
        let before = state.queue.len();
        state.complete(
            &old_job,
            Outcome::Measured(ProbeResult::DnsError, None, None),
            now + 40,
        );
        assert_eq!(state.queue.len(), before);
        drop(state);
        rt.apply_control(Some(&c), true);
        assert_ne!(
            first.segment_id,
            complete(&rt, 0, 4, now + 60, Some(Ipv4Addr::new(1, 1, 1, 1))).segment_id
        );
    }
    #[test]
    fn ip_a_b_a_and_dns_failures_preserve_correct_denominators() {
        let rt = runtime();
        enabled(&rt);
        let now = wall_time();
        let a = Ipv4Addr::new(1, 1, 1, 1);
        let b = Ipv4Addr::new(8, 8, 8, 8);
        let unknown = complete(&rt, 0, 1, now, None);
        let first = complete(&rt, 0, 2, now + 20, Some(a));
        assert_eq!(unknown.segment_id, first.segment_id);
        let failed = complete(&rt, 0, 3, now + 40, None);
        assert_eq!(failed.segment_id, first.segment_id);
        assert_eq!(rt.payload().unwrap().latest[0].attempts, 3);
        assert_eq!(rt.payload().unwrap().latest[0].failures, 2);
        let second = complete(&rt, 0, 4, now + 60, Some(b));
        assert_ne!(second.segment_id, first.segment_id);
        let third = complete(&rt, 0, 5, now + 80, Some(a));
        assert_ne!(third.segment_id, first.segment_id);
        assert_ne!(third.segment_id, second.segment_id);
        assert_eq!(rt.payload().unwrap().latest[0].attempts, 1);
    }
    #[test]
    fn only_changed_target_resets_and_late_old_tasks_are_discarded() {
        let rt = runtime();
        enabled(&rt);
        let now = wall_time();
        let ip = Some(Ipv4Addr::new(1, 1, 1, 1));
        let a = complete(&rt, 0, 1, now, ip);
        let b = complete(&rt, 1, 1, now, ip);
        let old_job = job(&rt, 0, 2);
        let mut c = default_config();
        c.enabled = true;
        c.targets[0].host = "one.one.one.one".into();
        rt.apply_control(
            Some(&serde_json::to_value(make_control(&c)).unwrap()),
            false,
        );
        rt.state.lock().unwrap().complete(
            &old_job,
            Outcome::Measured(ProbeResult::Ok, Some(1.0), ip),
            now + 20,
        );
        assert_eq!(rt.state.lock().unwrap().queue.len(), 2);
        assert_ne!(a.segment_id, complete(&rt, 0, 3, now + 40, ip).segment_id);
        assert_eq!(b.segment_id, complete(&rt, 1, 3, now + 40, ip).segment_id);
    }
    #[test]
    fn queue_limits_expiry_and_successful_send_ack_preserve_exact_prefix() {
        let rt = runtime();
        enabled(&rt);
        let now = wall_time();
        let ip = Some(Ipv4Addr::new(1, 1, 1, 1));
        for n in 1..=300 {
            complete(&rt, 0, n, now - 400 + n, ip);
        }
        assert_eq!(rt.state.lock().unwrap().queue.len(), 270);
        assert_eq!(rt.payload().unwrap().dropped_samples, 30);
        let payload = rt.payload().unwrap();
        assert!(serde_json::to_vec(&payload).unwrap().len() <= 128 * 1024);
        assert_eq!(rt.payload().unwrap().points, payload.points); // failed send takes no action
        let last = complete(&rt, 1, 301, now, ip);
        rt.mark_sent(&payload);
        assert!(rt
            .state
            .lock()
            .unwrap()
            .queue
            .iter()
            .any(|p| p.point.sample_id == last.sample_id));
        assert!(!rt.state.lock().unwrap().queue.iter().any(|p| payload
            .points
            .iter()
            .any(|q| q.sample_id == p.point.sample_id)));
        rt.state.lock().unwrap().trim(now + 1801);
        assert!(rt.state.lock().unwrap().queue.is_empty());
        assert_eq!(rt.payload().unwrap().latest.len(), 2); // sending/ageing never recomputes last statistics
    }
    #[test]
    fn blocked_configuration_is_not_an_attempt_and_errors_clear_on_recovery() {
        let rt = runtime();
        let config = enabled(&rt);
        let job = job(runtime_ref(&rt), 0, 1);
        rt.state
            .lock()
            .unwrap()
            .complete(&job, Outcome::Blocked, wall_time());
        let p = rt.payload().unwrap();
        assert!(p.points.is_empty());
        assert!(p.config_error.is_some());
        rt.apply_control(Some(&config), false);
        assert!(rt.payload().unwrap().config_error.is_some());
        complete(&rt, 0, 2, wall_time(), Some(Ipv4Addr::new(1, 1, 1, 1)));
        assert!(rt.payload().unwrap().config_error.is_none());
    }
    fn runtime_ref(rt: &ProbeRuntime) -> &ProbeRuntime {
        rt
    }
    #[test]
    fn stuck_resolver_is_bounded_and_other_targets_keep_sampling() {
        let rt = runtime();
        enabled(&rt);
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let calls = Arc::new(std::array::from_fn::<_, 3, _>(|_| AtomicUsize::new(0)));
        let (release, counts) = (gate.clone(), calls.clone());
        let resolver: Resolver = Arc::new(move |t| {
            let slot = ["ct", "cu", "cm"]
                .iter()
                .position(|id| *id == t.id)
                .unwrap();
            counts[slot].fetch_add(1, Ordering::SeqCst);
            if slot == 0 {
                let (lock, cv) = &*release;
                let mut done = lock.lock().unwrap();
                while !*done {
                    done = cv.wait(done).unwrap();
                }
            }
            Resolution::Error
        });
        let (state, stop) = (rt.state.clone(), rt.stop.clone());
        let runner = std::thread::spawn(move || {
            run_probes_with_resolver(
                state,
                stop,
                Duration::ZERO,
                Some(Duration::from_millis(30)),
                Duration::from_millis(10),
                resolver,
            )
        });
        std::thread::sleep(Duration::from_millis(180));
        let p = rt.payload().unwrap();
        assert_eq!(calls[0].load(Ordering::SeqCst), 1);
        assert_eq!(p.points.iter().filter(|p| p.target_id == "ct").count(), 1);
        assert_eq!(
            p.points
                .iter()
                .find(|p| p.target_id == "ct")
                .unwrap()
                .result,
            ProbeResult::DnsTimeout
        );
        assert!(p.points.iter().filter(|p| p.target_id == "cu").count() >= 3);
        assert!(p.points.iter().filter(|p| p.target_id == "cm").count() >= 3);
        rt.stop.store(true, Ordering::Release);
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
        runner.join().unwrap();
    }

    #[test]
    fn configuration_updates_do_not_restart_the_probe_clock() {
        let rt = runtime();
        enabled(&rt);
        let (state, stop) = (rt.state.clone(), rt.stop.clone());
        let runner = std::thread::spawn(move || {
            run_probes_with_resolver(
                state,
                stop,
                Duration::ZERO,
                Some(Duration::from_millis(400)),
                Duration::from_millis(100),
                Arc::new(|_| Resolution::Error),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while rt.state.lock().unwrap().round == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(rt.state.lock().unwrap().round, 1);
        for n in 0..12 {
            let mut c = default_config();
            c.enabled = true;
            c.targets[0].label = format!("label-{n}");
            rt.apply_control(
                Some(&serde_json::to_value(make_control(&c)).unwrap()),
                false,
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            rt.state.lock().unwrap().round,
            1,
            "config edits must not trigger probes"
        );
        rt.stop.store(true, Ordering::Release);
        runner.join().unwrap();
    }
    #[test]
    fn dynamic_custom_targets_probe_concurrently() {
        let rt = runtime();
        let cfg = parse_config(&json!({
            "enabled": true,
            "interval_sec": 15,
            "targets": [
                {"id": "hk", "enabled": true, "label": "HK", "host": "1.1.1.1", "port": 80, "address_family": "ipv4"},
                {"id": "jp", "enabled": true, "label": "JP", "host": "8.8.8.8", "port": 443, "address_family": "ipv4"},
                {"id": "us", "enabled": true, "label": "US", "host": "9.9.9.9", "port": 80, "address_family": "ipv4"},
                {"id": "eu", "enabled": false, "label": "EU", "host": "1.0.0.1", "port": 80, "address_family": "ipv4"}
            ]
        })).unwrap();
        rt.apply_control(
            Some(&serde_json::to_value(make_control(&cfg)).unwrap()),
            true,
        );
        let (state, stop) = (rt.state.clone(), rt.stop.clone());
        let runner = std::thread::spawn(move || {
            run_probes_with_resolver(
                state,
                stop,
                Duration::ZERO,
                Some(Duration::from_millis(25)),
                Duration::from_millis(10),
                Arc::new(|_| Resolution::Error),
            )
        });
        std::thread::sleep(Duration::from_millis(90));
        let p = rt.payload().unwrap();
        assert!(p.points.iter().any(|q| q.target_id == "hk"));
        assert!(p.points.iter().any(|q| q.target_id == "jp"));
        assert!(p.points.iter().any(|q| q.target_id == "us"));
        assert!(!p.points.iter().any(|q| q.target_id == "eu"));
        rt.stop.store(true, Ordering::Release);
        runner.join().unwrap();
    }
}
