use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde::ser::SerializeTuple;
use serde::{Deserialize, Serialize, Serializer};
use std::fmt;

pub const MIN_INTERVAL_MS: u64 = 1_000;
pub const MAX_INTERVAL_MS: u64 = 60_000;
pub const DEFAULT_IDLE_INTERVAL_MS: u64 = 30_000;
pub const DEFAULT_LIVE_INTERVAL_MS: u64 = 2_000;
pub const DEFAULT_BATCH_SEC: u64 = 300;

pub const MIN_TOP_N: u32 = 5;
pub const MAX_TOP_N: u32 = 50;
pub const DEFAULT_TOP_N: u32 = 30;

pub const MIN_LEASE_SEC: u64 = 30;
pub const MAX_LEASE_SEC: u64 = 180;
pub const DEFAULT_LEASE_SEC: u64 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum SampleMode {
    #[default]
    Idle = 0,
    Live = 1,
    LiveProc = 2,
}

impl Serialize for SampleMode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for SampleMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct SampleModeVisitor;

        impl<'de> Visitor<'de> for SampleModeVisitor {
            type Value = SampleMode;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an integer 0, 1, or 2")
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                match value {
                    0 => Ok(SampleMode::Idle),
                    1 => Ok(SampleMode::Live),
                    2 => Ok(SampleMode::LiveProc),
                    other => Err(E::invalid_value(
                        de::Unexpected::Unsigned(other),
                        &"0, 1, or 2",
                    )),
                }
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                match value {
                    0 => Ok(SampleMode::Idle),
                    1 => Ok(SampleMode::Live),
                    2 => Ok(SampleMode::LiveProc),
                    other => Err(E::invalid_value(
                        de::Unexpected::Signed(other),
                        &"0, 1, or 2",
                    )),
                }
            }
        }

        deserializer.deserialize_any(SampleModeVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloFrame {
    pub t: String,
    pub v: u8,
    pub agent_ver: String,
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub cpu_model: String,
    pub cpu_cores: u32,
    pub mem_total: u64,
    pub swap_total: u64,
    pub boot_time: u64,
    pub proc_enabled: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetricsFrame {
    pub t: String,
    pub ts: u64,
    pub up: u64,
    pub cpu: CpuMetrics,
    pub mem: MemMetrics,
    pub disks: Vec<DiskMetrics>,
    pub net: NetMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub procs: Option<Vec<ProcEntry>>,
}

impl MetricsFrame {
    pub fn into_last_payload(self) -> MetricsLastPayload {
        MetricsLastPayload {
            ts: self.ts,
            up: self.up,
            cpu: self.cpu,
            mem: self.mem,
            disks: self.disks,
            net: self.net,
            procs: self.procs,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetricsLastPayload {
    pub ts: u64,
    pub up: u64,
    pub cpu: CpuMetrics,
    pub mem: MemMetrics,
    pub disks: Vec<DiskMetrics>,
    pub net: NetMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub procs: Option<Vec<ProcEntry>>,
}

impl From<MetricsFrame> for MetricsLastPayload {
    fn from(frame: MetricsFrame) -> Self {
        frame.into_last_payload()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchReason {
    Cohort,
    Edge,
    Flush,
    Hello,
}

/// 16-element compact telemetry tuple:
/// `[ts, up, cpu_all, steal, iowait, load1, mem_used, swap_used, disk_used, disk_r_bps, disk_w_bps, net_rx_bps, net_tx_bps, rx_tot, tx_tot, tcp_est]`
#[derive(Debug, Clone, PartialEq)]
pub struct CompactMetricTuple {
    pub ts: u64,
    pub up: u64,
    pub cpu_all: f64,
    pub steal: f64,
    pub iowait: f64,
    pub load1: f64,
    pub mem_used: u64,
    pub swap_used: u64,
    pub disk_used: u64,
    pub disk_r_bps: u64,
    pub disk_w_bps: u64,
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
    pub rx_tot: u64,
    pub tx_tot: u64,
    pub tcp_est: u64,
}

impl CompactMetricTuple {
    pub fn from_metrics(m: &MetricsFrame) -> Self {
        let mut disk_used = 0u64;
        let mut disk_r_bps = 0u64;
        let mut disk_w_bps = 0u64;
        for d in &m.disks {
            disk_used = disk_used.saturating_add(d.used);
            disk_r_bps = disk_r_bps.saturating_add(d.r_bps);
            disk_w_bps = disk_w_bps.saturating_add(d.w_bps);
        }

        Self {
            ts: m.ts,
            up: m.up,
            cpu_all: m.cpu.all,
            steal: m.cpu.steal,
            iowait: m.cpu.iowait,
            load1: m.cpu.load[0],
            mem_used: m.mem.used,
            swap_used: m.mem.swap_used,
            disk_used,
            disk_r_bps,
            disk_w_bps,
            net_rx_bps: m.net.rx_bps,
            net_tx_bps: m.net.tx_bps,
            rx_tot: m.net.rx_tot,
            tx_tot: m.net.tx_tot,
            tcp_est: m.net.tcp_est,
        }
    }
}

impl Serialize for CompactMetricTuple {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut tup = serializer.serialize_tuple(16)?;
        tup.serialize_element(&self.ts)?;
        tup.serialize_element(&self.up)?;
        tup.serialize_element(&self.cpu_all)?;
        tup.serialize_element(&self.steal)?;
        tup.serialize_element(&self.iowait)?;
        tup.serialize_element(&self.load1)?;
        tup.serialize_element(&self.mem_used)?;
        tup.serialize_element(&self.swap_used)?;
        tup.serialize_element(&self.disk_used)?;
        tup.serialize_element(&self.disk_r_bps)?;
        tup.serialize_element(&self.disk_w_bps)?;
        tup.serialize_element(&self.net_rx_bps)?;
        tup.serialize_element(&self.net_tx_bps)?;
        tup.serialize_element(&self.rx_tot)?;
        tup.serialize_element(&self.tx_tot)?;
        tup.serialize_element(&self.tcp_est)?;
        tup.end()
    }
}

impl<'de> Deserialize<'de> for CompactMetricTuple {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TupleVisitor;

        impl<'de> Visitor<'de> for TupleVisitor {
            type Value = CompactMetricTuple;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a 16-element compact metric array")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let next_u64 = |seq: &mut A, idx: usize| -> Result<u64, A::Error> {
                    seq.next_element()?
                        .ok_or_else(|| de::Error::invalid_length(idx, &self))
                };
                let next_f64 = |seq: &mut A, idx: usize| -> Result<f64, A::Error> {
                    seq.next_element()?
                        .ok_or_else(|| de::Error::invalid_length(idx, &self))
                };

                let val = CompactMetricTuple {
                    ts: next_u64(&mut seq, 0)?,
                    up: next_u64(&mut seq, 1)?,
                    cpu_all: next_f64(&mut seq, 2)?,
                    steal: next_f64(&mut seq, 3)?,
                    iowait: next_f64(&mut seq, 4)?,
                    load1: next_f64(&mut seq, 5)?,
                    mem_used: next_u64(&mut seq, 6)?,
                    swap_used: next_u64(&mut seq, 7)?,
                    disk_used: next_u64(&mut seq, 8)?,
                    disk_r_bps: next_u64(&mut seq, 9)?,
                    disk_w_bps: next_u64(&mut seq, 10)?,
                    net_rx_bps: next_u64(&mut seq, 11)?,
                    net_tx_bps: next_u64(&mut seq, 12)?,
                    rx_tot: next_u64(&mut seq, 13)?,
                    tx_tot: next_u64(&mut seq, 14)?,
                    tcp_est: next_u64(&mut seq, 15)?,
                };

                if seq.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::invalid_length(17, &self));
                }

                Ok(val)
            }
        }

        deserializer.deserialize_tuple(16, TupleVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetricsBatchFrame {
    pub t: String,
    pub v: u8,
    pub reason: BatchReason,
    pub pts: Vec<CompactMetricTuple>,
    pub last: MetricsLastPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CpuMetrics {
    pub all: f64,
    pub cores: Vec<f64>,
    pub steal: f64,
    pub iowait: f64,
    pub load: [f64; 3],
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemMetrics {
    pub used: u64,
    pub avail: u64,
    pub cached: u64,
    pub swap_used: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskMetrics {
    pub mp: String,
    pub fs: String,
    pub total: u64,
    pub used: u64,
    pub r_bps: u64,
    pub w_bps: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetMetrics {
    pub rx_bps: u64,
    pub tx_bps: u64,
    pub rx_tot: u64,
    pub tx_tot: u64,
    pub tcp_est: u64,
    pub tcp_tw: u64,
    pub udp: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcEntry {
    pub pid: u32,
    pub user: String,
    pub comm: String,
    pub st: String,
    pub cpu: f64,
    pub rss: u64,
    pub thr: u32,
    pub cmd: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Watermarks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steal: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrateDirective {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_url: Option<String>,
    pub epoch: u64,
    pub sig: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CtrlFrame {
    #[serde(deserialize_with = "deserialize_ctrl_tag")]
    pub t: String,
    pub mode: SampleMode,
    #[serde(
        default = "default_interval_ms",
        deserialize_with = "deserialize_interval_ms"
    )]
    pub interval_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_sec: Option<u64>,
    #[serde(default = "default_top_n", deserialize_with = "deserialize_top_n")]
    pub top_n: u32,
    #[serde(
        default = "default_lease_sec",
        deserialize_with = "deserialize_lease_sec"
    )]
    pub lease_sec: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flush_now: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watermarks: Option<Watermarks>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrate: Option<MigrateDirective>,
}

impl Default for CtrlFrame {
    fn default() -> Self {
        Self {
            t: "ctrl".to_string(),
            mode: SampleMode::Idle,
            interval_ms: DEFAULT_IDLE_INTERVAL_MS,
            batch_sec: None,
            top_n: DEFAULT_TOP_N,
            lease_sec: DEFAULT_LEASE_SEC,
            flush_now: None,
            watermarks: None,
            migrate: None,
        }
    }
}

impl CtrlFrame {
    pub fn parse(raw: &str) -> Result<Self, serde_json::Error> {
        let parsed: Self = serde_json::from_str(raw)?;
        Ok(parsed.clamped())
    }

    pub fn clamped(mut self) -> Self {
        self.interval_ms = self.interval_ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
        match self.mode {
            SampleMode::Idle => {
                self.top_n = self.top_n.clamp(0, MAX_TOP_N);
                self.lease_sec = self.lease_sec.clamp(0, MAX_LEASE_SEC);
            }
            SampleMode::Live | SampleMode::LiveProc => {
                self.top_n = self.top_n.clamp(MIN_TOP_N, MAX_TOP_N);
                self.lease_sec = self.lease_sec.clamp(MIN_LEASE_SEC, MAX_LEASE_SEC);
            }
        }
        self
    }
}

fn default_interval_ms() -> u64 {
    DEFAULT_LIVE_INTERVAL_MS
}

fn default_top_n() -> u32 {
    DEFAULT_TOP_N
}

fn default_lease_sec() -> u64 {
    DEFAULT_LEASE_SEC
}

fn deserialize_ctrl_tag<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let tag = String::deserialize(deserializer)?;
    if tag != "ctrl" {
        return Err(de::Error::invalid_value(
            de::Unexpected::Str(&tag),
            &"\"ctrl\"",
        ));
    }
    Ok(tag)
}

fn deserialize_clamped_i64<'de, D: Deserializer<'de>>(
    deserializer: D,
    min: i64,
    max: i64,
) -> Result<u64, D::Error> {
    struct ClampedIntVisitor {
        min: i64,
        max: i64,
    }

    impl<'de> Visitor<'de> for ClampedIntVisitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an integer")
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(v.clamp(self.min, self.max) as u64)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            let max_u = self.max as u64;
            let min_u = self.min.max(0) as u64;
            Ok(v.clamp(min_u, max_u))
        }
    }

    deserializer.deserialize_any(ClampedIntVisitor { min, max })
}

fn deserialize_interval_ms<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    deserialize_clamped_i64(deserializer, MIN_INTERVAL_MS as i64, MAX_INTERVAL_MS as i64)
}

fn deserialize_top_n<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let val = deserialize_clamped_i64(deserializer, 0, MAX_TOP_N as i64)?;
    Ok(val as u32)
}

fn deserialize_lease_sec<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    deserialize_clamped_i64(deserializer, 0, MAX_LEASE_SEC as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_metrics_frame() -> MetricsFrame {
        MetricsFrame {
            t: "m".to_string(),
            ts: 1763128000,
            up: 1126766,
            cpu: CpuMetrics {
                all: 14.2,
                cores: vec![14.2],
                steal: 0.8,
                iowait: 0.3,
                load: [0.18, 0.12, 0.09],
            },
            mem: MemMetrics {
                used: 412876800,
                avail: 607387648,
                cached: 289406976,
                swap_used: 12582912,
            },
            disks: vec![
                DiskMetrics {
                    mp: "/".to_string(),
                    fs: "ext4".to_string(),
                    total: 21002936320,
                    used: 6421987328,
                    r_bps: 1000,
                    w_bps: 16384,
                },
                DiskMetrics {
                    mp: "/data".to_string(),
                    fs: "xfs".to_string(),
                    total: 50000000000,
                    used: 1000000000,
                    r_bps: 2048,
                    w_bps: 4096,
                },
            ],
            net: NetMetrics {
                rx_bps: 128450,
                tx_bps: 349120,
                rx_tot: 84920193842,
                tx_tot: 192837465120,
                tcp_est: 24,
                tcp_tw: 11,
                udp: 4,
            },
            procs: None,
        }
    }

    #[test]
    fn sample_mode_serializes_and_deserializes_strictly() {
        assert_eq!(serde_json::to_string(&SampleMode::Idle).unwrap(), "0");
        assert_eq!(serde_json::to_string(&SampleMode::Live).unwrap(), "1");
        assert_eq!(serde_json::to_string(&SampleMode::LiveProc).unwrap(), "2");

        assert_eq!(
            serde_json::from_str::<SampleMode>("0").unwrap(),
            SampleMode::Idle
        );
        assert_eq!(
            serde_json::from_str::<SampleMode>("1").unwrap(),
            SampleMode::Live
        );
        assert_eq!(
            serde_json::from_str::<SampleMode>("2").unwrap(),
            SampleMode::LiveProc
        );

        assert!(serde_json::from_str::<SampleMode>("3").is_err());
        assert!(serde_json::from_str::<SampleMode>("-1").is_err());
        assert!(serde_json::from_str::<SampleMode>("\"1\"").is_err());
        assert!(serde_json::from_str::<SampleMode>("1.5").is_err());
        assert!(serde_json::from_str::<SampleMode>("true").is_err());
    }

    #[test]
    fn ctrl_frame_rejects_non_ctrl_and_clamps_ranges() {
        let valid = CtrlFrame::parse(
            r#"{"t":"ctrl","mode":2,"interval_ms":2000,"top_n":30,"lease_sec":90}"#,
        )
        .unwrap();
        assert_eq!(valid.mode, SampleMode::LiveProc);
        assert_eq!(valid.interval_ms, 2000);
        assert_eq!(valid.top_n, 30);
        assert_eq!(valid.lease_sec, 90);

        let low =
            CtrlFrame::parse(r#"{"t":"ctrl","mode":1,"interval_ms":50,"top_n":1,"lease_sec":5}"#)
                .unwrap();
        assert_eq!(low.interval_ms, 1000);
        assert_eq!(low.top_n, 5);
        assert_eq!(low.lease_sec, 30);

        let high = CtrlFrame::parse(
            r#"{"t":"ctrl","mode":2,"interval_ms":999999,"top_n":500,"lease_sec":9999}"#,
        )
        .unwrap();
        assert_eq!(high.interval_ms, 60_000);
        assert_eq!(high.top_n, 50);
        assert_eq!(high.lease_sec, 180);

        assert!(CtrlFrame::parse(r#"{"t":"exec","mode":2,"interval_ms":2000}"#).is_err());
        assert!(CtrlFrame::parse(r#"{"t":"ctrl","mode":9,"interval_ms":2000}"#).is_err());
    }

    #[test]
    fn ctrl_frame_idle_preserves_zero_top_n_and_lease_sec_and_parses_v2_fields() {
        let idle = CtrlFrame::parse(
            r#"{
                "t":"ctrl",
                "mode":0,
                "interval_ms":30000,
                "batch_sec":300,
                "top_n":0,
                "lease_sec":0,
                "flush_now":true,
                "watermarks":{"cpu":85.0,"steal":10.0,"mem":90.0,"swap":50.0,"disk":92.5},
                "migrate":{"url":"wss://hub2.example.com/api/agent/ws","fallback_url":"wss://hub1.example.com/api/agent/ws","epoch":1763128000,"sig":"abcd"}
            }"#,
        )
        .unwrap();

        assert_eq!(idle.mode, SampleMode::Idle);
        assert_eq!(idle.interval_ms, 30_000);
        assert_eq!(idle.batch_sec, Some(300));
        assert_eq!(idle.top_n, 0);
        assert_eq!(idle.lease_sec, 0);
        assert_eq!(idle.flush_now, Some(true));
        let wm = idle.watermarks.unwrap();
        assert_eq!(wm.cpu, Some(85.0));
        assert_eq!(wm.steal, Some(10.0));
        assert_eq!(wm.mem, Some(90.0));
        assert_eq!(wm.swap, Some(50.0));
        assert_eq!(wm.disk, Some(92.5));
        let mig = idle.migrate.unwrap();
        assert_eq!(mig.url, "wss://hub2.example.com/api/agent/ws");
        assert_eq!(
            mig.fallback_url.as_deref(),
            Some("wss://hub1.example.com/api/agent/ws")
        );
        assert_eq!(mig.epoch, 1763128000);
        assert_eq!(mig.sig, "abcd");

        // Negative top_n/lease_sec clamp to 0 in Idle, and to 5/30 in Live.
        let neg_idle = CtrlFrame::parse(
            r#"{"t":"ctrl","mode":0,"interval_ms":30000,"top_n":-5,"lease_sec":-1}"#,
        )
        .unwrap();
        assert_eq!(neg_idle.top_n, 0);
        assert_eq!(neg_idle.lease_sec, 0);

        let zero_live =
            CtrlFrame::parse(r#"{"t":"ctrl","mode":1,"interval_ms":2000,"top_n":0,"lease_sec":0}"#)
                .unwrap();
        assert_eq!(zero_live.top_n, 5);
        assert_eq!(zero_live.lease_sec, 30);
    }

    #[test]
    fn metrics_frame_omits_procs_when_none() {
        let mut frame = sample_metrics_frame();
        frame.disks.truncate(1);
        let json = serde_json::to_string(&frame).unwrap();
        assert!(!json.contains("\"procs\""));

        let mut with_procs = frame;
        with_procs.procs = Some(vec![ProcEntry {
            pid: 1420,
            user: "www-data".to_string(),
            comm: "nginx".to_string(),
            st: "S".to_string(),
            cpu: 4.5,
            rss: 28409856,
            thr: 2,
            cmd: "nginx: worker process".to_string(),
        }]);
        let json_procs = serde_json::to_string(&with_procs).unwrap();
        assert!(json_procs.contains("\"procs\""));
        assert!(json_procs.contains("\"nginx: worker process\""));
    }

    #[test]
    fn compact_metric_tuple_sums_disks_and_roundtrips_as_16_element_array() {
        let frame = sample_metrics_frame();
        let tup = CompactMetricTuple::from_metrics(&frame);
        let json = serde_json::to_string(&tup).unwrap();
        let arr: serde_json::Value = serde_json::from_str(&json).unwrap();
        let elems = arr.as_array().unwrap();
        assert_eq!(elems.len(), 16);
        assert_eq!(elems[0], 1763128000u64);
        assert_eq!(elems[1], 1126766u64);
        assert_eq!(elems[2], 14.2);
        assert_eq!(elems[3], 0.8);
        assert_eq!(elems[4], 0.3);
        assert_eq!(elems[5], 0.18);
        assert_eq!(elems[6], 412876800u64);
        assert_eq!(elems[7], 12582912u64);
        assert_eq!(elems[8], 7421987328u64); // 6421987328 + 1000000000
        assert_eq!(elems[9], 3048u64); // 1000 + 2048
        assert_eq!(elems[10], 20480u64); // 16384 + 4096
        assert_eq!(elems[11], 128450u64);
        assert_eq!(elems[12], 349120u64);
        assert_eq!(elems[13], 84920193842u64);
        assert_eq!(elems[14], 192837465120u64);
        assert_eq!(elems[15], 24u64);

        let decoded: CompactMetricTuple = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, tup);

        assert!(serde_json::from_str::<CompactMetricTuple>("[1,2,3]").is_err());
        assert!(serde_json::from_str::<CompactMetricTuple>(
            "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]"
        )
        .is_err());
    }

    #[test]
    fn metrics_batch_frame_serializes_v2_schema() {
        let frame = sample_metrics_frame();
        let tup = CompactMetricTuple::from_metrics(&frame);
        let batch = MetricsBatchFrame {
            t: "mb".to_string(),
            v: 2,
            reason: BatchReason::Cohort,
            pts: vec![tup],
            last: frame.into_last_payload(),
        };
        let val: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&batch).unwrap()).unwrap();
        assert_eq!(val["t"], "mb");
        assert_eq!(val["v"], 2);
        assert_eq!(val["reason"], "cohort");
        assert_eq!(val["pts"].as_array().unwrap().len(), 1);
        assert_eq!(val["pts"][0].as_array().unwrap().len(), 16);
        assert!(val["last"].get("t").is_none());
        assert_eq!(val["last"]["ts"], 1763128000);
    }

    #[test]
    fn hello_frame_serializes_spec_fields() {
        let hello = HelloFrame {
            t: "hello".to_string(),
            v: 1,
            agent_ver: "0.1.0".to_string(),
            hostname: "hk-bgp-nano-01".to_string(),
            os: "Debian GNU/Linux 12 (bookworm)".to_string(),
            kernel: "6.1.0-26-amd64".to_string(),
            arch: "x86_64".to_string(),
            cpu_model: "AMD EPYC 7763 64-Core Processor".to_string(),
            cpu_cores: 1,
            mem_total: 1020264448,
            swap_total: 1073737728,
            boot_time: 1762001234,
            proc_enabled: true,
            capabilities: Vec::new(),
            migrated_epoch: None,
        };
        let val: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&hello).unwrap()).unwrap();
        assert_eq!(val["t"], "hello");
        assert_eq!(val["v"], 1);
        assert_eq!(val["proc_enabled"], true);
        assert!(val.get("capabilities").is_none());
        assert!(val.get("migrated_epoch").is_none());

        let hello_v2 = HelloFrame {
            v: 2,
            capabilities: vec!["mb_v2".to_string(), "migrate_v1".to_string()],
            migrated_epoch: Some(1763128000),
            ..hello
        };
        let val_v2: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&hello_v2).unwrap()).unwrap();
        assert_eq!(val_v2["v"], 2);
        assert_eq!(
            val_v2["capabilities"],
            serde_json::json!(["mb_v2", "migrate_v1"])
        );
        assert_eq!(val_v2["migrated_epoch"], 1763128000);
    }
}
