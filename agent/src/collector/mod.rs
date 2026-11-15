pub mod cpu;
pub mod disk;
pub mod mem;
pub mod net;
pub mod proc;

use crate::config::Config;
use crate::crypto;
use crate::protocol::{
    BatchReason, CompactMetricTuple, CtrlFrame, HelloFrame, MetricsBatchFrame, MetricsFrame,
    SampleMode, Watermarks, DEFAULT_BATCH_SEC, DEFAULT_IDLE_INTERVAL_MS, DEFAULT_TOP_N,
};
use cpu::{
    collect_static_info, compute_cpu_metrics, read_loadavg, read_proc_stat, read_uptime,
    ProcStatData,
};
use disk::DiskCollector;
use mem::collect_mem;
use net::NetCollector;
use proc::ProcCollector;
use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const RING_BUFFER_CAPACITY: usize = 12;
pub const DELTA_CPU_EDGE_THRESHOLD: f64 = 35.0;
pub const WATERMARK_HYSTERESIS: f64 = 3.0;
pub const COHORT_JITTER_MAX_MS: u64 = 400;

/// Computes deterministic per-node jitter in `[0, 400)` ms from `node_id` SHA-256.
pub fn deterministic_hash_jitter(node_id: &str) -> Duration {
    let digest = crypto::sha256(node_id.as_bytes());
    let raw = u64::from_le_bytes(digest[..8].try_into().unwrap());
    Duration::from_millis(raw % COHORT_JITTER_MAX_MS)
}

/// Computes the next UTC cohort boundary `(boundary_sec, target_wall_ms)`.
pub fn next_cohort_boundary_ms(
    now_wall_ms: u64,
    batch_sec: u64,
    jitter_ms: u64,
    last_boundary_sec: Option<u64>,
) -> (u64, u64) {
    let period = batch_sec.max(1);
    let now_sec = now_wall_ms / 1000;
    let mut target_sec = (now_sec / period + 1).saturating_mul(period);
    if last_boundary_sec == Some(target_sec) {
        target_sec = target_sec.saturating_add(period);
    }
    let target_wall_ms = target_sec.saturating_mul(1000).saturating_add(jitter_ms);
    (target_sec, target_wall_ms)
}

#[derive(Debug, Clone, PartialEq)]
pub struct SchedulerState {
    pub mode: SampleMode,
    pub interval: Duration,
    pub batch_sec: u64,
    pub top_n: usize,
    pub lease_expires_at: Option<Instant>,
    pub watermarks: Option<Watermarks>,
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self {
            mode: SampleMode::Idle,
            interval: Duration::from_millis(DEFAULT_IDLE_INTERVAL_MS),
            batch_sec: DEFAULT_BATCH_SEC,
            top_n: DEFAULT_TOP_N as usize,
            lease_expires_at: None,
            watermarks: None,
        }
    }
}

impl SchedulerState {
    /// Reverts to `Idle` on lease expiration while retaining session `watermarks` and `batch_sec`.
    pub fn reset_to_idle(&mut self) {
        self.mode = SampleMode::Idle;
        self.interval = Duration::from_millis(DEFAULT_IDLE_INTERVAL_MS);
        self.lease_expires_at = None;
    }

    /// Resets all scheduler state when the WebSocket connection drops.
    pub fn reset_on_disconnect(&mut self) {
        *self = Self::default();
    }

    pub fn apply_ctrl(&mut self, ctrl: CtrlFrame, now: Instant) {
        let clamped = ctrl.clamped();
        match clamped.mode {
            SampleMode::Idle => {
                self.mode = SampleMode::Idle;
                self.interval = Duration::from_millis(clamped.interval_ms);
                self.batch_sec = clamped
                    .batch_sec
                    .unwrap_or(DEFAULT_BATCH_SEC)
                    .clamp(30, 3600);
                self.top_n = clamped.top_n as usize;
                self.lease_expires_at = None;
                self.watermarks = clamped.watermarks;
            }
            SampleMode::Live | SampleMode::LiveProc => {
                self.mode = clamped.mode;
                self.interval = Duration::from_millis(clamped.interval_ms);
                if let Some(b) = clamped.batch_sec {
                    self.batch_sec = b.clamp(30, 3600);
                }
                self.top_n = clamped.top_n as usize;
                self.lease_expires_at = Some(now + Duration::from_secs(clamped.lease_sec));
                if clamped.watermarks.is_some() {
                    self.watermarks = clamped.watermarks;
                }
            }
        }
    }

    /// Checks monotonic lease expiration and auto-reverts to `Idle` (30s) when expired.
    /// Returns `true` if a reversion occurred.
    pub fn expire_lease_if_due(&mut self, now: Instant) -> bool {
        if self.mode == SampleMode::Idle {
            return false;
        }
        if let Some(expiry) = self.lease_expires_at {
            if now >= expiry {
                self.reset_to_idle();
                return true;
            }
        }
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WatermarkBreachState {
    pub cpu: bool,
    pub steal: bool,
    pub mem: bool,
    pub swap: bool,
    pub disk: bool,
}

#[derive(Debug, Clone, Default)]
pub struct EdgeDetector {
    pub breached: WatermarkBreachState,
    pub prev_cpu_all: Option<f64>,
    pub prev_up: Option<u64>,
}

fn eval_one_watermark(
    was_breached: &mut bool,
    reading: Option<f64>,
    threshold: Option<f64>,
) -> bool {
    let Some(wm) = threshold.filter(|v| v.is_finite()) else {
        *was_breached = false;
        return false;
    };
    let Some(val) = reading.filter(|v| v.is_finite()) else {
        return false;
    };

    if !*was_breached {
        if val >= wm {
            *was_breached = true;
            return true;
        }
    } else {
        let recover_below = (wm - WATERMARK_HYSTERESIS).max(0.0);
        if val < recover_below {
            *was_breached = false;
            return true;
        }
    }
    false
}

impl EdgeDetector {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    fn update_watermarks(
        &mut self,
        frame: &MetricsFrame,
        mem_total: u64,
        swap_total: u64,
        watermarks: Option<&Watermarks>,
    ) -> bool {
        let wm = watermarks.cloned().unwrap_or_default();

        let mem_pct = {
            let total = if mem_total > 0 {
                mem_total
            } else {
                frame.mem.used.saturating_add(frame.mem.avail)
            };
            (total > 0).then(|| (frame.mem.used as f64 / total as f64) * 100.0)
        };
        let swap_pct =
            (swap_total > 0).then(|| (frame.mem.swap_used as f64 / swap_total as f64) * 100.0);
        let disk_pct = frame
            .disks
            .iter()
            .filter(|d| d.total > 0)
            .map(|d| (d.used as f64 / d.total as f64) * 100.0)
            .fold(None, |acc: Option<f64>, p| {
                Some(acc.map_or(p, |m| m.max(p)))
            });

        let mut triggered = false;
        triggered |= eval_one_watermark(&mut self.breached.cpu, Some(frame.cpu.all), wm.cpu);
        triggered |= eval_one_watermark(&mut self.breached.steal, Some(frame.cpu.steal), wm.steal);
        triggered |= eval_one_watermark(&mut self.breached.mem, mem_pct, wm.mem);
        triggered |= eval_one_watermark(&mut self.breached.swap, swap_pct, wm.swap);
        triggered |= eval_one_watermark(&mut self.breached.disk, disk_pct, wm.disk);
        triggered
    }

    /// Evaluates watermarks (with 3% recovery hysteresis), `delta_cpu >= 35%`, and uptime reboot.
    pub fn evaluate(
        &mut self,
        frame: &MetricsFrame,
        mem_total: u64,
        swap_total: u64,
        watermarks: Option<&Watermarks>,
    ) -> bool {
        let mut triggered = self.update_watermarks(frame, mem_total, swap_total, watermarks);

        if let Some(prev_cpu) = self.prev_cpu_all {
            if (frame.cpu.all - prev_cpu).abs() >= DELTA_CPU_EDGE_THRESHOLD {
                triggered = true;
            }
        }
        self.prev_cpu_all = Some(frame.cpu.all);

        if let Some(prev_up) = self.prev_up {
            if frame.up < prev_up {
                triggered = true;
            }
        }
        self.prev_up = Some(frame.up);

        triggered
    }

    /// Updates baseline CPU/uptime and watermark breach tracking without emitting an edge alert
    /// (used when sending an immediate `"hello"` snapshot or streaming in Live mode).
    pub fn seed_without_trigger(
        &mut self,
        frame: &MetricsFrame,
        mem_total: u64,
        swap_total: u64,
        watermarks: Option<&Watermarks>,
    ) {
        let _ = self.update_watermarks(frame, mem_total, swap_total, watermarks);
        self.prev_cpu_all = Some(frame.cpu.all);
        self.prev_up = Some(frame.up);
    }
}

pub struct AgentCollector {
    config: Config,
    pub scheduler: SchedulerState,
    prev_cpu: Option<ProcStatData>,
    last_sample_at: Option<Instant>,
    last_mem_total: u64,
    last_swap_total: u64,
    disk: DiskCollector,
    net: NetCollector,
    proc_scanner: ProcCollector,
    ring_buf: VecDeque<CompactMetricTuple>,
    last_idle_frame: Option<MetricsFrame>,
    pub edge_detector: EdgeDetector,
    migrated_epoch: Option<u64>,
    jitter: Duration,
    last_cohort_boundary_sec: Option<u64>,
    pending_cohort_boundary_sec: Option<u64>,
}

impl AgentCollector {
    pub fn new(config: Config) -> Self {
        let jitter = deterministic_hash_jitter(&config.server.node_id);
        Self {
            config,
            scheduler: SchedulerState::default(),
            prev_cpu: None,
            last_sample_at: None,
            last_mem_total: 0,
            last_swap_total: 0,
            disk: DiskCollector::new(),
            net: NetCollector::new(),
            proc_scanner: ProcCollector::new(),
            ring_buf: VecDeque::with_capacity(RING_BUFFER_CAPACITY),
            last_idle_frame: None,
            edge_detector: EdgeDetector::default(),
            migrated_epoch: None,
            jitter,
            last_cohort_boundary_sec: None,
            pending_cohort_boundary_sec: None,
        }
    }

    pub fn set_migrated_epoch(&mut self, epoch: Option<u64>) {
        self.migrated_epoch = epoch;
    }

    #[cfg(test)]
    pub fn jitter(&self) -> Duration {
        self.jitter
    }

    #[cfg(test)]
    pub fn ring_len(&self) -> usize {
        self.ring_buf.len()
    }

    pub fn reset_on_disconnect(&mut self) {
        self.scheduler.reset_on_disconnect();
        self.proc_scanner.clear_state();
        self.ring_buf.clear();
        self.last_idle_frame = None;
        self.edge_detector.reset();
        self.last_cohort_boundary_sec = None;
        self.pending_cohort_boundary_sec = None;
    }

    pub fn reset_session_buffers_for_cutover(&mut self) {
        self.ring_buf.clear();
        self.last_idle_frame = None;
        self.edge_detector.reset();
        self.last_cohort_boundary_sec = None;
        self.pending_cohort_boundary_sec = None;
    }

    pub fn apply_ctrl(&mut self, ctrl: CtrlFrame, now: Instant) {
        let prev_mode = self.scheduler.mode;
        self.scheduler.apply_ctrl(ctrl, now);
        if prev_mode == SampleMode::LiveProc && self.scheduler.mode != SampleMode::LiveProc {
            self.proc_scanner.clear_state();
        }
    }

    pub fn check_lease(&mut self, now: Instant) -> bool {
        let reverted = self.scheduler.expire_lease_if_due(now);
        if reverted {
            self.proc_scanner.clear_state();
        }
        reverted
    }

    /// Takes a baseline snapshot for CPU, disk, and net counters so the very first emitted
    /// `MetricsFrame` can report accurate delta rates when separated by a short warm-up delay.
    pub fn warm_baseline(&mut self) {
        self.prev_cpu = read_proc_stat();
        let _ = self
            .disk
            .collect(&self.config.collector.mount_ignore_prefixes, None);
        let _ = self.net.collect(&self.config.collector.nic_allowlist, None);
        self.last_sample_at = Some(Instant::now());
    }

    pub fn collect_hello(&mut self) -> HelloFrame {
        self.collect_hello_with_epoch(self.migrated_epoch)
    }

    pub fn collect_hello_with_epoch(&mut self, migrated_epoch: Option<u64>) -> HelloFrame {
        let stat = read_proc_stat();
        let host = collect_static_info(stat.as_ref());
        let mem = collect_mem();
        self.last_mem_total = mem.mem_total;
        self.last_swap_total = mem.swap_total;

        HelloFrame {
            t: "hello".to_string(),
            v: 2,
            agent_ver: env!("CARGO_PKG_VERSION").to_string(),
            hostname: host.hostname,
            os: host.os,
            kernel: host.kernel,
            arch: host.arch,
            cpu_model: host.cpu_model,
            cpu_cores: host.cpu_cores,
            mem_total: mem.mem_total,
            swap_total: mem.swap_total,
            boot_time: host.boot_time,
            proc_enabled: self.config.process.enabled,
            capabilities: vec!["mb_v2".to_string(), "migrate_v1".to_string()],
            migrated_epoch,
        }
    }

    pub fn collect_metrics(&mut self, now: Instant) -> MetricsFrame {
        self.check_lease(now);

        let dt_sec = self
            .last_sample_at
            .map(|prev| now.saturating_duration_since(prev).as_secs_f64())
            .filter(|&dt| dt > 0.0);

        let curr_cpu = read_proc_stat();
        let load = read_loadavg();
        let cpu_metrics = match (&self.prev_cpu, &curr_cpu) {
            (prev, Some(curr)) => compute_cpu_metrics(prev.as_ref(), curr, load),
            (_, None) => compute_cpu_metrics(None, &ProcStatData::default(), load),
        };
        if curr_cpu.is_some() {
            self.prev_cpu = curr_cpu;
        }

        let mem_snap = collect_mem();
        self.last_mem_total = mem_snap.mem_total;
        self.last_swap_total = mem_snap.swap_total;

        let disks = self
            .disk
            .collect(&self.config.collector.mount_ignore_prefixes, dt_sec);
        let net = self
            .net
            .collect(&self.config.collector.nic_allowlist, dt_sec);

        let procs = if self.scheduler.mode == SampleMode::LiveProc && self.config.process.enabled {
            Some(self.proc_scanner.collect(
                self.scheduler.top_n,
                self.config.process.cmdline_mode,
                dt_sec,
            ))
        } else {
            None
        };

        self.last_sample_at = Some(now);

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        MetricsFrame {
            t: "m".to_string(),
            ts,
            up: read_uptime(),
            cpu: cpu_metrics,
            mem: mem_snap.metrics,
            disks,
            net,
            procs,
        }
    }

    /// Collects a `MetricsFrame` in `Live`/`LiveProc` mode while keeping `edge_detector`
    /// synchronized for future `Idle` mode transitions.
    pub fn collect_metrics_and_seed_edge(&mut self, now: Instant) -> MetricsFrame {
        let frame = self.collect_metrics(now);
        self.edge_detector.seed_without_trigger(
            &frame,
            self.last_mem_total,
            self.last_swap_total,
            self.scheduler.watermarks.as_ref(),
        );
        frame
    }

    /// Pushes a collected sample into the 12-slot ring buffer and evaluates edge triggers.
    /// Returns `true` if an edge condition triggered.
    pub fn push_ring_sample(&mut self, frame: MetricsFrame) -> bool {
        let tuple = CompactMetricTuple::from_metrics(&frame);
        if self.ring_buf.len() >= RING_BUFFER_CAPACITY {
            self.ring_buf.pop_front();
        }
        self.ring_buf.push_back(tuple);
        let triggered = self.edge_detector.evaluate(
            &frame,
            self.last_mem_total,
            self.last_swap_total,
            self.scheduler.watermarks.as_ref(),
        );
        self.last_idle_frame = Some(frame);
        triggered
    }

    /// Drains all buffered points from the ring buffer into a `MetricsBatchFrame`.
    pub fn take_batch(&mut self, reason: BatchReason) -> Option<MetricsBatchFrame> {
        let last = self.last_idle_frame.take()?;
        if self.ring_buf.is_empty() {
            return None;
        }
        let pts: Vec<CompactMetricTuple> = self.ring_buf.drain(..).collect();
        Some(MetricsBatchFrame {
            t: "mb".to_string(),
            v: 2,
            reason,
            pts,
            last: last.into_last_payload(),
        })
    }

    /// Samples current metrics and wraps them in a 1-point `mb` frame with `reason: "hello"`.
    pub fn collect_hello_batch(&mut self, now: Instant) -> MetricsBatchFrame {
        let frame = self.collect_metrics(now);
        self.edge_detector.seed_without_trigger(
            &frame,
            self.last_mem_total,
            self.last_swap_total,
            self.scheduler.watermarks.as_ref(),
        );
        let tup = CompactMetricTuple::from_metrics(&frame);
        MetricsBatchFrame {
            t: "mb".to_string(),
            v: 2,
            reason: BatchReason::Hello,
            pts: vec![tup],
            last: frame.into_last_payload(),
        }
    }

    /// Flushes pending ring points as `mb` (`reason: "flush"`), or collects a fresh sample
    /// and sends a 1-point `mb` (`reason: "flush"`) if the ring buffer is empty.
    pub fn collect_flush_batch(&mut self, now: Instant) -> MetricsBatchFrame {
        if let Some(batch) = self.take_batch(BatchReason::Flush) {
            return batch;
        }
        let frame = self.collect_metrics(now);
        self.edge_detector.seed_without_trigger(
            &frame,
            self.last_mem_total,
            self.last_swap_total,
            self.scheduler.watermarks.as_ref(),
        );
        let tup = CompactMetricTuple::from_metrics(&frame);
        MetricsBatchFrame {
            t: "mb".to_string(),
            v: 2,
            reason: BatchReason::Flush,
            pts: vec![tup],
            last: frame.into_last_payload(),
        }
    }

    /// Samples in `Idle` mode into the ring buffer; returns `Some(mb)` (`reason: "edge"`)
    /// immediately when an edge trigger fires, or `None` when buffered quietly.
    pub fn collect_idle_tick(&mut self, now: Instant) -> Option<MetricsBatchFrame> {
        let frame = self.collect_metrics(now);
        if self.push_ring_sample(frame) {
            self.take_batch(BatchReason::Edge)
        } else {
            None
        }
    }

    pub fn next_cohort_instant(&mut self, now_mono: Instant, now_wall: SystemTime) -> Instant {
        let now_wall_ms = now_wall
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let jitter_ms = self.jitter.as_millis() as u64;
        let (boundary_sec, target_wall_ms) = next_cohort_boundary_ms(
            now_wall_ms,
            self.scheduler.batch_sec,
            jitter_ms,
            self.last_cohort_boundary_sec,
        );
        self.pending_cohort_boundary_sec = Some(boundary_sec);
        let delay_ms = target_wall_ms.saturating_sub(now_wall_ms);
        now_mono + Duration::from_millis(delay_ms)
    }

    pub fn mark_cohort_fired(&mut self) {
        if let Some(b) = self.pending_cohort_boundary_sec.take() {
            self.last_cohort_boundary_sec = Some(b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CpuMetrics, DiskMetrics, MemMetrics, NetMetrics};

    fn test_config(node_id: &str) -> Config {
        Config::from_toml_str(&format!(
            r#"
[server]
url = "wss://example.com"
node_id = "{node_id}"
token = "tok_1"
"#
        ))
        .unwrap()
    }

    fn make_frame(
        ts: u64,
        up: u64,
        cpu_all: f64,
        steal: f64,
        mem_used: u64,
        swap_used: u64,
        disk_used: u64,
    ) -> MetricsFrame {
        MetricsFrame {
            t: "m".to_string(),
            ts,
            up,
            cpu: CpuMetrics {
                all: cpu_all,
                cores: vec![cpu_all],
                steal,
                iowait: 0.5,
                load: [0.5, 0.4, 0.3],
            },
            mem: MemMetrics {
                used: mem_used,
                avail: 1000u64.saturating_sub(mem_used),
                cached: 100,
                swap_used,
            },
            disks: vec![DiskMetrics {
                mp: "/".to_string(),
                fs: "ext4".to_string(),
                total: 1000,
                used: disk_used,
                r_bps: 100,
                w_bps: 200,
            }],
            net: NetMetrics {
                rx_bps: 10,
                tx_bps: 20,
                rx_tot: 1000,
                tx_tot: 2000,
                tcp_est: 5,
                tcp_tw: 1,
                udp: 2,
            },
            procs: None,
        }
    }

    #[test]
    fn scheduler_applies_ctrl_clamps_and_expires_lease_back_to_idle() {
        let mut sched = SchedulerState::default();
        assert_eq!(sched.mode, SampleMode::Idle);
        assert_eq!(sched.interval, Duration::from_secs(30));

        let t0 = Instant::now();
        let ctrl = CtrlFrame {
            t: "ctrl".to_string(),
            mode: SampleMode::LiveProc,
            interval_ms: 500, // clamps to 1000
            batch_sec: None,
            top_n: 80,     // clamps to 50
            lease_sec: 30, // valid min 30
            flush_now: None,
            watermarks: Some(Watermarks {
                cpu: Some(85.0),
                ..Default::default()
            }),
            migrate: None,
        };
        sched.apply_ctrl(ctrl, t0);
        assert_eq!(sched.mode, SampleMode::LiveProc);
        assert_eq!(sched.interval, Duration::from_millis(1000));
        assert_eq!(sched.top_n, 50);

        // Before lease expires -> stays LiveProc.
        assert!(!sched.expire_lease_if_due(t0 + Duration::from_secs(29)));
        assert_eq!(sched.mode, SampleMode::LiveProc);

        // At/after lease expiration -> automatically reverts to Idle (30s) and preserves watermarks.
        assert!(sched.expire_lease_if_due(t0 + Duration::from_secs(30)));
        assert_eq!(sched.mode, SampleMode::Idle);
        assert_eq!(sched.interval, Duration::from_secs(30));
        assert!(sched.lease_expires_at.is_none());
        assert_eq!(sched.watermarks.as_ref().unwrap().cpu, Some(85.0));
    }

    #[test]
    fn local_process_disabled_never_emits_procs_even_in_live_proc_mode() {
        let cfg = Config::from_toml_str(
            r#"
[server]
url = "wss://example.com"
node_id = "nd_1"
token = "tok_1"
[process]
enabled = false
"#,
        )
        .unwrap();

        let mut collector = AgentCollector::new(cfg);
        let now = Instant::now();
        collector.apply_ctrl(
            CtrlFrame {
                t: "ctrl".to_string(),
                mode: SampleMode::LiveProc,
                interval_ms: 2000,
                batch_sec: None,
                top_n: 30,
                lease_sec: 90,
                flush_now: None,
                watermarks: None,
                migrate: None,
            },
            now,
        );
        let frame = collector.collect_metrics(now + Duration::from_secs(2));
        assert!(frame.procs.is_none());
    }

    #[test]
    fn hello_emits_v2_capabilities_and_migrated_epoch() {
        let mut collector = AgentCollector::new(test_config("nd_v2"));
        let h1 = collector.collect_hello();
        assert_eq!(h1.v, 2);
        assert_eq!(
            h1.capabilities,
            vec!["mb_v2".to_string(), "migrate_v1".to_string()]
        );
        assert_eq!(h1.migrated_epoch, None);

        collector.set_migrated_epoch(Some(1763128000));
        let h2 = collector.collect_hello();
        assert_eq!(h2.migrated_epoch, Some(1763128000));
    }

    #[test]
    fn ring_buffer_caps_at_12_slots_preserving_chronological_order() {
        let mut collector = AgentCollector::new(test_config("nd_ring"));
        for i in 1..=15u64 {
            let triggered = collector.push_ring_sample(make_frame(
                1000 + i * 30,
                500 + i * 30,
                10.0,
                0.0,
                200,
                0,
                300,
            ));
            assert!(!triggered);
        }
        assert_eq!(collector.ring_len(), 12);

        let batch = collector.take_batch(BatchReason::Cohort).unwrap();
        assert_eq!(batch.reason, BatchReason::Cohort);
        assert_eq!(batch.pts.len(), 12);
        assert_eq!(batch.pts.first().unwrap().ts, 1000 + 4 * 30);
        assert_eq!(batch.pts.last().unwrap().ts, 1000 + 15 * 30);
        assert_eq!(batch.last.ts, 1000 + 15 * 30);
        assert_eq!(collector.ring_len(), 0);
        assert!(collector.take_batch(BatchReason::Cohort).is_none());
    }

    #[test]
    fn utc_cohort_boundary_and_deterministic_jitter() {
        let j1 = deterministic_hash_jitter("nd_alpha");
        let j2 = deterministic_hash_jitter("nd_alpha");
        let j3 = deterministic_hash_jitter("nd_beta");
        assert_eq!(j1, j2);
        assert!(j1 < Duration::from_millis(400));
        assert!(j3 < Duration::from_millis(400));
        assert_ne!(j1, j3);

        let collector = AgentCollector::new(test_config("nd_alpha"));
        assert_eq!(collector.jitter(), j1);

        // At 1700000123.450s -> next 300s boundary is (1700000123 / 300 + 1) * 300 = 1700000400
        let (sec, wall_ms) = next_cohort_boundary_ms(1_700_000_123_450, 300, 250, None);
        assert_eq!(sec, 1_700_000_400);
        assert_eq!(wall_ms, 1_700_000_400_250);

        // Exact boundary + jitter already passed -> jumps to next boundary
        let (sec2, wall_ms2) =
            next_cohort_boundary_ms(1_700_000_399_999, 300, 250, Some(1_700_000_400));
        assert_eq!(sec2, 1_700_000_700);
        assert_eq!(wall_ms2, 1_700_000_700_250);
    }

    #[test]
    fn edge_detector_watermarks_hysteresis_delta_cpu_and_reboot() {
        let mut collector = AgentCollector::new(test_config("nd_edge"));
        collector.last_mem_total = 1000;
        collector.last_swap_total = 1000;
        collector.apply_ctrl(
            CtrlFrame {
                t: "ctrl".to_string(),
                mode: SampleMode::Idle,
                interval_ms: 30_000,
                batch_sec: Some(300),
                top_n: 0,
                lease_sec: 0,
                flush_now: None,
                watermarks: Some(Watermarks {
                    cpu: Some(80.0),
                    steal: Some(10.0),
                    mem: Some(85.0),
                    swap: Some(50.0),
                    disk: Some(90.0),
                }),
                migrate: None,
            },
            Instant::now(),
        );

        // Normal sample below all watermarks -> buffered, no edge
        assert!(!collector.push_ring_sample(make_frame(100, 1000, 20.0, 1.0, 400, 100, 500)));

        // Cross CPU upward (>= 80.0): 20 -> 50 -> 82 (keep delta < 35 first to isolate watermark!)
        assert!(!collector.push_ring_sample(make_frame(130, 1030, 50.0, 1.0, 400, 100, 500)));
        assert!(collector.push_ring_sample(make_frame(160, 1060, 82.0, 1.0, 400, 100, 500)));
        let b1 = collector.take_batch(BatchReason::Edge).unwrap();
        assert_eq!(b1.pts.len(), 3);

        // Inside hysteresis band (77.0 >= 80.0 - 3.0) -> stays breached, NO edge flush
        assert!(!collector.push_ring_sample(make_frame(190, 1090, 77.0, 1.0, 400, 100, 500)));
        // Still at 78.0 -> NO edge flush
        assert!(!collector.push_ring_sample(make_frame(220, 1120, 78.0, 1.0, 400, 100, 500)));
        // Drop below (80.0 - 3.0) = 77.0 -> e.g. 76.9 -> downward recovery edge flush!
        assert!(collector.push_ring_sample(make_frame(250, 1150, 76.9, 1.0, 400, 100, 500)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();

        // Steal watermark crossing upward (>= 10.0) & downward (< 7.0)
        assert!(collector.push_ring_sample(make_frame(280, 1180, 70.0, 10.0, 400, 100, 500)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();
        assert!(!collector.push_ring_sample(make_frame(310, 1210, 70.0, 7.5, 400, 100, 500)));
        assert!(collector.push_ring_sample(make_frame(340, 1240, 70.0, 6.9, 400, 100, 500)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();

        // Mem watermark (>= 85%)
        assert!(collector.push_ring_sample(make_frame(370, 1270, 70.0, 1.0, 850, 100, 500)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();
        // Swap watermark (>= 50%)
        assert!(collector.push_ring_sample(make_frame(400, 1300, 70.0, 1.0, 850, 500, 500)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();
        // Disk watermark (>= 90%)
        assert!(collector.push_ring_sample(make_frame(430, 1330, 70.0, 1.0, 850, 500, 900)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();

        // Rapid delta CPU >= 35% (70.0 -> 35.0 = -35.0)
        assert!(collector.push_ring_sample(make_frame(460, 1360, 35.0, 1.0, 850, 500, 900)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();

        // Reboot detection (curr_up < prev_up: 1360 -> 12)
        assert!(collector.push_ring_sample(make_frame(490, 12, 35.0, 1.0, 850, 500, 900)));
        let _ = collector.take_batch(BatchReason::Edge).unwrap();
    }

    #[test]
    fn flush_now_returns_pending_ring_or_fresh_sample_when_empty() {
        let mut collector = AgentCollector::new(test_config("nd_flush"));
        collector.push_ring_sample(make_frame(555, 100, 12.0, 0.0, 200, 0, 100));
        let b1 = collector.collect_flush_batch(Instant::now());
        assert_eq!(b1.reason, BatchReason::Flush);
        assert_eq!(b1.pts.len(), 1);
        assert_eq!(b1.pts[0].ts, 555);
        assert_eq!(collector.ring_len(), 0);

        // Ring now empty -> collects a fresh sample and emits 1-pt mb(flush).
        let b2 = collector.collect_flush_batch(Instant::now());
        assert_eq!(b2.reason, BatchReason::Flush);
        assert_eq!(b2.pts.len(), 1);
    }
}
