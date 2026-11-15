//! Network quality v1: shared wire contract, statistics and bounded native probe runtime.
#![allow(dead_code)] // The agent and Hub intentionally use different portions of this module.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::net::{Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const IDS: [&str; 3] = ["ct", "cu", "cm"];
pub const MAX_POINTS: usize = 270;
const INTERVAL: Duration = Duration::from_secs(20);
const BUDGET: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub enabled: bool,
    pub label: String,
    pub region: String,
    pub host: String,
    pub port: u16,
    pub address_family: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub targets: Vec<Target>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeOverride {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
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
        targets: IDS
            .iter()
            .zip(["电信", "联通", "移动"])
            .map(|(id, label)| Target {
                id: (*id).into(),
                enabled: true,
                label: label.into(),
                region: "广东".into(),
                host: format!("gd-{id}-v4.ip.zstaticcdn.com"),
                port: 80,
                address_family: "ipv4".into(),
            })
            .collect(),
    }
}
fn allowed(value: &Value, keys: &[&str]) -> Result<(), String> {
    let obj = value.as_object().ok_or("Expected an object")?;
    if obj.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("Unknown network quality field".into());
    }
    Ok(())
}
fn short_text(value: &str, max: usize) -> Result<String, String> {
    let s = value.trim();
    if s.is_empty() || s.chars().count() > max || value.chars().any(char::is_control) {
        return Err("Invalid network quality text".into());
    }
    Ok(s.into())
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
pub fn parse_target(v: &Value) -> Result<Target, String> {
    allowed(
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
    )?;
    let mut t: Target = serde_json::from_value(v.clone()).map_err(|_| "Invalid network target")?;
    if !IDS.contains(&t.id.as_str()) || t.address_family != "ipv4" || t.port == 0 {
        return Err("Invalid target identity, port or address family".into());
    }
    t.label = short_text(&t.label, 64)?;
    t.region = short_text(&t.region, 64)?;
    t.host = short_text(&t.host, 253)?.to_ascii_lowercase();
    if t.host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        if !t.host.parse::<Ipv4Addr>().is_ok_and(is_public_ipv4) {
            return Err("Target must be a public IPv4 address".into());
        }
    } else if !t.host.contains('.')
        || !t.host.split('.').all(|p| {
            !p.is_empty()
                && p.len() <= 63
                && p.as_bytes()[0].is_ascii_alphanumeric()
                && p.as_bytes()[p.len() - 1].is_ascii_alphanumeric()
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("Invalid target hostname".into());
    }
    Ok(t)
}
pub fn parse_config(v: &Value) -> Result<Config, String> {
    allowed(v, &["enabled", "targets"])?;
    let enabled = v["enabled"].as_bool().ok_or("Missing enabled")?;
    let values = v["targets"]
        .as_array()
        .filter(|v| v.len() == 3)
        .ok_or("Expected three target slots")?;
    let mut targets: Vec<Target> = values.iter().map(parse_target).collect::<Result<_, _>>()?;
    targets.sort_by_key(|t| IDS.iter().position(|id| *id == t.id).unwrap());
    if targets.iter().map(|t| &t.id).collect::<HashSet<_>>().len() != 3 {
        return Err("Duplicate target slot".into());
    }
    Ok(Config { enabled, targets })
}
pub fn parse_override(v: &Value) -> Result<NodeOverride, String> {
    allowed(v, &["mode", "config"])?;
    let mode = v["mode"].as_str().ok_or("Missing mode")?;
    let config = if mode == "custom" {
        Some(parse_config(&v["config"])?)
    } else if (mode == "inherit" || mode == "off") && v.get("config").is_none() {
        None
    } else {
        return Err("Invalid node network mode".into());
    };
    Ok(NodeOverride {
        mode: mode.into(),
        config,
    })
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
    Control {
        schema_version: 1,
        config_id: crate::crypto::sha256_hex(
            json!([
                "network_quality_v1",
                c.enabled,
                c.targets.iter().map(target_array).collect::<Vec<_>>()
            ])
            .to_string()
            .as_bytes(),
        ),
        enabled: c.enabled,
        targets: c
            .targets
            .iter()
            .map(|t| ControlTarget {
                target: t.clone(),
                target_revision: target_revision(t),
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
    Ok(make_control(&parse_config(
        &serde_json::to_value(config).map_err(|e| e.to_string())?,
    )?))
}
pub fn parse_control(v: &Value) -> Result<Control, String> {
    allowed(v, &["schema_version", "config_id", "enabled", "targets"])?;
    let c: Control = serde_json::from_value(v.clone()).map_err(|_| "Invalid network control")?;
    let targets = v["targets"]
        .as_array()
        .ok_or("Invalid control targets")?
        .iter()
        .map(|t| {
            let mut t = t.clone();
            t.as_object_mut()
                .ok_or("Invalid control target")?
                .remove("target_revision");
            Ok(t)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let normalized = make_control(&parse_config(
        &json!({"enabled":c.enabled,"targets":targets}),
    )?);
    if c.schema_version != 1 || c != normalized {
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
    if v["latest"].as_array().is_none_or(|a| a.len() > 3) {
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
        q.target = parse_target(&serde_json::to_value(&q.target).map_err(|e| e.to_string())?)?;
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
    IDS.iter()
        .filter_map(|id| {
            points
                .iter()
                .filter(|p| p.target_id == *id)
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
    slot: usize,
    sequence: u64,
    generation: u64,
    target: ControlTarget,
    cancelled: Arc<AtomicBool>,
}
enum Outcome {
    Measured(ProbeResult, Option<f64>, Option<Ipv4Addr>),
    Blocked,
    Cancelled,
}
#[allow(clippy::large_enum_variant)] // Fixed 12-slot channel; avoid a heap allocation per sample.
enum ProbeEvent {
    Started(usize, u64, Instant),
    Resolved(usize, u64),
    Finished(ProbeJob, Outcome, u64),
}
struct ActiveJob {
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
struct RuntimeState {
    control: Option<Control>,
    negotiated: bool,
    config_error: Option<String>,
    target_errors: [Option<String>; 3],
    generations: [u64; 3],
    queue: VecDeque<Point>,
    recent: VecDeque<Point>,
    latest: Vec<Latest>,
    dropped: u64,
    round: u64,
    segment_counter: u64,
    session: String,
    segments: [Segment; 3],
}
impl RuntimeState {
    fn trim(&mut self, now: u64) {
        while self
            .queue
            .front()
            .is_some_and(|p| p.ts < now.saturating_sub(1800))
            || self.queue.len() > MAX_POINTS
        {
            self.queue.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
    }
    fn complete(&mut self, job: &ProbeJob, outcome: Outcome, ts: u64) {
        if job.generation != self.generations[job.slot]
            || !self.control.as_ref().is_some_and(|c| c.enabled)
        {
            return;
        }
        let (result, connect_ms, ip) = match outcome {
            Outcome::Measured(result, ms, ip) => (result, ms, ip),
            Outcome::Blocked => {
                self.target_errors[job.slot] = Some(format!(
                    "{}: resolved address blocked",
                    job.target.target.id
                ));
                self.config_error = self.target_errors.iter().find_map(Clone::clone);
                return;
            }
            Outcome::Cancelled => return,
        };
        self.target_errors[job.slot] = None;
        self.config_error = self.target_errors.iter().find_map(Clone::clone);
        let segment = &mut self.segments[job.slot];
        if segment.revision != job.target.target_revision
            || (segment.ip.is_some() && ip.is_some() && segment.ip != ip)
            || segment.id.is_empty()
        {
            self.segment_counter += 1;
            *segment = Segment {
                revision: job.target.target_revision.clone(),
                id: format!("{}:{}:{}", self.session, job.slot, self.segment_counter),
                ip,
            };
        } else if ip.is_some() {
            segment.ip = ip;
        }
        let point = Point {
            sample_id: format!("{}:{}:{}", self.session, job.sequence, job.slot),
            round_seq: job.sequence,
            // A different target may have changed while this attempt was in
            // flight. The generation check above proves this target is still
            // valid; acknowledge its measurement under the current control.
            config_id: self.control.as_ref().unwrap().config_id.clone(),
            target_id: job.target.target.id.clone(),
            target_revision: job.target.target_revision.clone(),
            segment_id: segment.id.clone(),
            ts,
            result,
            connect_ms,
            remote_ip: ip.map(|ip| ip.to_string()),
            target: job.target.target.clone(),
        };
        self.queue.push_back(point.clone());
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

/// Four bounded background threads at most: one scheduler and one resolver/connector
/// per target. A stalled system resolver occupies its existing worker; later rounds
/// skip that target until it returns. No per-attempt thread or external process exists.
pub struct ProbeRuntime {
    state: Arc<Mutex<RuntimeState>>,
    stop: Arc<AtomicBool>,
    generation: Arc<[std::sync::atomic::AtomicU64; 3]>,
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
            target_errors: [None, None, None],
            generations: [0; 3],
            queue: VecDeque::new(),
            recent: VecDeque::new(),
            latest: vec![],
            dropped: 0,
            round: 0,
            segment_counter: 0,
            session,
            segments: std::array::from_fn(|_| Segment::default()),
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let generation = Arc::new(std::array::from_fn(|_| {
            std::sync::atomic::AtomicU64::new(0)
        }));
        let digest = crate::crypto::sha256_hex(node_id.as_bytes());
        let offset =
            Duration::from_millis(u64::from_str_radix(&digest[..8], 16).unwrap_or(0) % 2001);
        let (s, quit, g) = (state.clone(), stop.clone(), generation.clone());
        if std::thread::Builder::new()
            .name("uniob-nq".into())
            .stack_size(128 * 1024)
            .spawn(move || run_probes(s, quit, g, offset))
            .is_err()
        {
            state.lock().unwrap().config_error = Some("probe executor unavailable".into());
        }
        Self {
            state,
            stop,
            generation,
        }
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
                    for slot in 0..3 {
                        s.generations[slot] += 1;
                        self.generation[slot].store(s.generations[slot], Ordering::Release);
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
            for (slot, id) in IDS.iter().enumerate() {
                let before = old.as_ref().map(|c| (&c.targets[slot], c.enabled));
                let after = control.as_ref().map(|c| (&c.targets[slot], c.enabled));
                if before != after {
                    s.generations[slot] += 1;
                    self.generation[slot].store(s.generations[slot], Ordering::Release);
                    s.segments[slot] = Segment::default();
                    s.target_errors[slot] = None;
                    s.recent.retain(|p| p.target_id != *id);
                    s.latest.retain(|p| p.target_id != *id);
                }
            }
            s.control = control;
            s.config_error = s.target_errors.iter().find_map(Clone::clone);
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
        // Verbose user labels can make 270 points exceed the envelope. Send an oldest
        // prefix; remaining points retain their IDs/timestamps until the next resource frame.
        let mut size = serde_json::to_vec(&p).ok()?.len();
        for point in &s.queue {
            let cost = serde_json::to_vec(point).ok()?.len() + usize::from(!p.points.is_empty());
            if size + cost > 128 * 1024 {
                break;
            }
            size += cost;
            p.points.push(point.clone());
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
            .retain(|p| !ids.contains(p.sample_id.as_str()));
    }
}
impl Drop for ProbeRuntime {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for g in self.generation.iter() {
            g.fetch_add(1, Ordering::AcqRel);
        }
    }
}

fn run_probes(
    state: Arc<Mutex<RuntimeState>>,
    stop: Arc<AtomicBool>,
    generation: Arc<[std::sync::atomic::AtomicU64; 3]>,
    offset: Duration,
) {
    run_probes_with_resolver(
        state,
        stop,
        generation,
        offset,
        INTERVAL,
        BUDGET,
        Arc::new(resolve),
    );
}

type Resolver = Arc<dyn Fn(&Target) -> Resolution + Send + Sync>;
fn run_probes_with_resolver(
    state: Arc<Mutex<RuntimeState>>,
    stop: Arc<AtomicBool>,
    generation: Arc<[std::sync::atomic::AtomicU64; 3]>,
    offset: Duration,
    interval: Duration,
    budget: Duration,
    resolver: Resolver,
) {
    let (events_tx, events_rx) = mpsc::sync_channel::<ProbeEvent>(12);
    let mut workers: Option<Vec<mpsc::SyncSender<ProbeJob>>> = None;
    let mut active: [Option<ActiveJob>; 3] = std::array::from_fn(|_| None);
    let mut next = Instant::now() + offset;
    let mut was_enabled = false;
    while !stop.load(Ordering::Acquire) {
        while let Ok(event) = events_rx.try_recv() {
            match event {
                ProbeEvent::Started(slot, seq, started) => {
                    if let Some(a) = &mut active[slot] {
                        if a.job.sequence == seq {
                            a.started = Some(started);
                        }
                    }
                }
                ProbeEvent::Resolved(slot, seq) => {
                    if let Some(a) = &mut active[slot] {
                        if a.job.sequence == seq {
                            a.dns_pending = false;
                        }
                    }
                }
                ProbeEvent::Finished(job, outcome, ts) => {
                    if active[job.slot]
                        .as_ref()
                        .is_some_and(|a| a.job.sequence == job.sequence)
                    {
                        let a = active[job.slot].take().unwrap();
                        if !a.emitted {
                            state.lock().unwrap().complete(&job, outcome, ts);
                        }
                    }
                }
            }
        }
        let now = Instant::now();
        for a in active.iter_mut().flatten() {
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
        let (control, generations) = {
            let mut s = state.lock().unwrap();
            // Expire retained samples even while disabled or disconnected, when no
            // resource frame is asking for a payload.
            s.trim(wall_time());
            (s.control.clone().filter(|c| c.enabled), s.generations)
        };
        if control.is_some() && !was_enabled {
            next = next.max(now + offset);
        }
        was_enabled = control.is_some();
        if let Some(control) = control {
            if workers.is_none() {
                let mut senders = Vec::new();
                for slot in 0..3 {
                    let (tx, rx) = mpsc::sync_channel::<ProbeJob>(1);
                    let events = events_tx.clone();
                    let g = generation.clone();
                    let resolve = resolver.clone();
                    if std::thread::Builder::new()
                        .name(format!("uniob-nq-{slot}"))
                        .stack_size(128 * 1024)
                        .spawn(move || probe_worker(rx, events, g, budget, resolve))
                        .is_err()
                    {
                        state.lock().unwrap().config_error =
                            Some("probe worker unavailable".into());
                        return;
                    }
                    senders.push(tx);
                }
                workers = Some(senders);
            }
            if now >= next {
                // No catch-up probes after congestion or a long scheduler pause.
                next = now + interval;
                let sequence = {
                    let mut s = state.lock().unwrap();
                    s.round += 1;
                    s.round
                };
                for (slot, target) in control.targets.into_iter().enumerate() {
                    if !target.target.enabled || active[slot].is_some() {
                        continue;
                    }
                    let job = ProbeJob {
                        slot,
                        sequence,
                        generation: generations[slot],
                        target,
                        cancelled: Arc::new(AtomicBool::new(false)),
                    };
                    if workers.as_ref().unwrap()[slot]
                        .try_send(job.clone())
                        .is_ok()
                    {
                        active[slot] = Some(ActiveJob {
                            job,
                            started: None,
                            dns_pending: true,
                            emitted: false,
                        });
                    }
                }
            }
        }
        std::thread::sleep(if was_enabled || active.iter().any(Option::is_some) {
            Duration::from_millis(20).min(interval / 4)
        } else {
            Duration::from_millis(200)
        });
    }
    for a in active.into_iter().flatten() {
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
    rx: mpsc::Receiver<ProbeJob>,
    events: mpsc::SyncSender<ProbeEvent>,
    generation: Arc<[std::sync::atomic::AtomicU64; 3]>,
    budget: Duration,
    resolve: Resolver,
) {
    let mut cache: Option<(String, u16, Instant, Resolution)> = None;
    while let Ok(job) = rx.recv() {
        let live = || {
            !job.cancelled.load(Ordering::Acquire)
                && generation[job.slot].load(Ordering::Acquire) == job.generation
        };
        let started = Instant::now();
        if !live() {
            if events
                .send(ProbeEvent::Finished(job, Outcome::Cancelled, wall_time()))
                .is_err()
            {
                break;
            }
            continue;
        }
        if events
            .send(ProbeEvent::Started(job.slot, job.sequence, started))
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
                .send(ProbeEvent::Finished(job, outcome, wall_time()))
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
                        INTERVAL
                    },
                resolution.clone(),
            ));
        }
        if events
            .send(ProbeEvent::Resolved(job.slot, job.sequence))
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
                        BUDGET,
                    ) {
                        Ok(stream) => {
                            drop(stream);
                            let elapsed = connect_start.elapsed();
                            if elapsed > BUDGET {
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
            .send(ProbeEvent::Finished(job, outcome, wall_time()))
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, AtomicUsize},
        Condvar,
    };

    fn fixture() -> Value {
        serde_json::from_str(include_str!("fixtures/network-quality-v1.json")).unwrap()
    }
    fn runtime() -> ProbeRuntime {
        ProbeRuntime {
            state: Arc::new(Mutex::new(RuntimeState {
                control: None,
                negotiated: false,
                config_error: None,
                target_errors: [None, None, None],
                generations: [0; 3],
                queue: VecDeque::new(),
                recent: VecDeque::new(),
                latest: vec![],
                dropped: 0,
                round: 0,
                segment_counter: 0,
                session: "test-session".into(),
                segments: std::array::from_fn(|_| Segment::default()),
            })),
            stop: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(std::array::from_fn(|_| AtomicU64::new(0))),
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
        let s = runtime.state.lock().unwrap();
        let c = s.control.as_ref().unwrap();
        ProbeJob {
            slot,
            sequence,
            generation: s.generations[slot],
            target: c.targets[slot].clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
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
        runtime.state.lock().unwrap().queue.back().unwrap().clone()
    }

    #[test]
    fn shared_fixture_hashes_medians_raw_and_rollups_match() {
        let f = fixture();
        let c = parse_config(&f["config"]).unwrap();
        assert_eq!(
            make_control(&c),
            serde_json::from_value::<Control>(f["control"].clone()).unwrap()
        );
        let points: Vec<Point> = serde_json::from_value(f["points"].clone()).unwrap();
        assert_eq!(
            latest_from_points(&points),
            serde_json::from_value::<Vec<Latest>>(f["expected"]["latest"].clone()).unwrap()
        );
        for id in IDS {
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
            .any(|p| p.sample_id == last.sample_id));
        assert!(!rt
            .state
            .lock()
            .unwrap()
            .queue
            .iter()
            .any(|p| payload.points.iter().any(|q| q.sample_id == p.sample_id)));
        rt.state.lock().unwrap().trim(now + 1801);
        assert!(rt.state.lock().unwrap().queue.is_empty());
        assert_eq!(rt.payload().unwrap().latest.len(), 2); // sending/ageing never recomputes last statistics
    }
    #[test]
    fn blocked_configuration_is_not_an_attempt_and_errors_clear_on_recovery() {
        let rt = runtime();
        let config = enabled(&rt);
        let job = job(&rt, 0, 1);
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
    #[test]
    fn stuck_resolver_is_bounded_and_other_targets_keep_sampling() {
        let rt = runtime();
        enabled(&rt);
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let calls = Arc::new(std::array::from_fn::<_, 3, _>(|_| AtomicUsize::new(0)));
        let (release, counts) = (gate.clone(), calls.clone());
        let resolver: Resolver = Arc::new(move |t| {
            let slot = IDS.iter().position(|id| *id == t.id).unwrap();
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
        let (state, stop, generation) = (rt.state.clone(), rt.stop.clone(), rt.generation.clone());
        let runner = std::thread::spawn(move || {
            run_probes_with_resolver(
                state,
                stop,
                generation,
                Duration::ZERO,
                Duration::from_millis(30),
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
        let (state, stop, generation) = (rt.state.clone(), rt.stop.clone(), rt.generation.clone());
        let runner = std::thread::spawn(move || {
            run_probes_with_resolver(
                state,
                stop,
                generation,
                Duration::ZERO,
                Duration::from_millis(400),
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
}
