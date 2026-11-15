#[cfg(target_os = "linux")]
use crate::crypto::now_sec;
use crate::hub_state::HubState;
use crate::protocol::MemMetrics;
#[cfg(target_os = "linux")]
use crate::protocol::{
    AgentDiskEntry, AgentHelloFrame, AgentMetricsBatchFrame, AgentMetricsFrame, CpuMetrics,
    NetMetrics, NodeHardwareInfo,
};
#[cfg(target_os = "linux")]
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct CpuTimes {
    pub total: u64,
    pub busy: u64,
    pub steal: u64,
    pub iowait: u64,
}

#[derive(Debug, Clone, Default)]
pub struct NetTotals {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

pub fn parse_cpu_stat(raw: &str) -> (CpuTimes, Vec<CpuTimes>) {
    let mut agg = CpuTimes::default();
    let mut cores = Vec::new();
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let Some(label) = parts.next() else {
            continue;
        };
        if label == "cpu" {
            agg = parse_cpu_line_nums(parts);
        } else if label.starts_with("cpu") && label[3..].bytes().all(|b| b.is_ascii_digit()) {
            cores.push(parse_cpu_line_nums(parts));
        }
    }
    (agg, cores)
}

fn parse_cpu_line_nums<'a>(parts: impl Iterator<Item = &'a str>) -> CpuTimes {
    let vals: Vec<u64> = parts
        .take(10)
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    let user = *vals.first().unwrap_or(&0);
    let nice = *vals.get(1).unwrap_or(&0);
    let system = *vals.get(2).unwrap_or(&0);
    let idle = *vals.get(3).unwrap_or(&0);
    let iowait = *vals.get(4).unwrap_or(&0);
    let irq = *vals.get(5).unwrap_or(&0);
    let softirq = *vals.get(6).unwrap_or(&0);
    let steal = *vals.get(7).unwrap_or(&0);

    let total = user
        .saturating_add(nice)
        .saturating_add(system)
        .saturating_add(idle)
        .saturating_add(iowait)
        .saturating_add(irq)
        .saturating_add(softirq)
        .saturating_add(steal);
    let busy = total.saturating_sub(idle).saturating_sub(iowait);
    CpuTimes {
        total,
        busy,
        steal,
        iowait,
    }
}

pub fn compute_cpu_pct(prev: &CpuTimes, curr: &CpuTimes) -> (f64, f64, f64) {
    let dt = curr.total.saturating_sub(prev.total);
    if dt == 0 {
        return (0.0, 0.0, 0.0);
    }
    let db = curr.busy.saturating_sub(prev.busy);
    let ds = curr.steal.saturating_sub(prev.steal);
    let di = curr.iowait.saturating_sub(prev.iowait);
    let all = ((db as f64 / dt as f64) * 100.0).clamp(0.0, 100.0);
    let steal = ((ds as f64 / dt as f64) * 100.0).clamp(0.0, 100.0);
    let iowait = ((di as f64 / dt as f64) * 100.0).clamp(0.0, 100.0);
    (round1(all), round1(steal), round1(iowait))
}

pub fn parse_loadavg(raw: &str) -> Vec<f64> {
    raw.split_whitespace()
        .take(3)
        .map(|s| s.parse::<f64>().unwrap_or(0.0))
        .collect()
}

pub fn parse_uptime(raw: &str) -> u64 {
    raw.split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|v| v.max(0.0).floor() as u64)
        .unwrap_or(0)
}

pub fn parse_meminfo(raw: &str) -> (u64, u64, MemMetrics) {
    let mut mem_total = 0u64;
    let mut mem_avail = 0u64;
    let mut buffers = 0u64;
    let mut cached = 0u64;
    let mut sreclaimable = 0u64;
    let mut mem_free = 0u64;
    let mut swap_total = 0u64;
    let mut swap_free = 0u64;

    for line in raw.lines() {
        let Some((k, rest)) = line.split_once(':') else {
            continue;
        };
        let kb = rest
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let bytes = kb.saturating_mul(1024);
        match k {
            "MemTotal" => mem_total = bytes,
            "MemAvailable" => mem_avail = bytes,
            "MemFree" => mem_free = bytes,
            "Buffers" => buffers = bytes,
            "Cached" => cached = bytes,
            "SReclaimable" => sreclaimable = bytes,
            "SwapTotal" => swap_total = bytes,
            "SwapFree" => swap_free = bytes,
            _ => {}
        }
    }

    if mem_avail == 0 && mem_total > 0 {
        mem_avail = mem_free.saturating_add(buffers).saturating_add(cached);
    }
    let used = mem_total.saturating_sub(mem_avail);
    let swap_used = swap_total.saturating_sub(swap_free);
    (
        mem_total,
        swap_total,
        MemMetrics {
            used,
            avail: mem_avail,
            cached: cached.saturating_add(sreclaimable),
            swap_used,
        },
    )
}

pub fn parse_net_dev(raw: &str) -> NetTotals {
    let mut tot = NetTotals::default();
    for line in raw.lines().skip(2) {
        let Some((iface, stats)) = line.split_once(':') else {
            continue;
        };
        let name = iface.trim();
        if name == "lo" || name.is_empty() {
            continue;
        }
        let cols: Vec<u64> = stats
            .split_whitespace()
            .map(|s| s.parse::<u64>().unwrap_or(0))
            .collect();
        if cols.len() >= 9 {
            tot.rx_bytes = tot.rx_bytes.saturating_add(cols[0]);
            tot.tx_bytes = tot.tx_bytes.saturating_add(cols[8]);
        }
    }
    tot
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(target_os = "linux")]
pub fn spawn_self_probe_loop(hub: HubState) {
    if !hub.cfg.self_probe_enabled {
        return;
    }
    if !std::path::Path::new("/proc/stat").exists() {
        return;
    }
    tokio::spawn(async move {
        let node_id = hub.cfg.self_probe_node_id.clone();
        let node_name = hub.cfg.self_probe_node_name.clone();
        let hw = read_linux_hardware();
        let now = now_sec();
        let hw_info = NodeHardwareInfo {
            hostname: Some(hw.hostname.clone()),
            os: Some(hw.os.clone()),
            kernel: Some(hw.kernel.clone()),
            arch: Some(hw.arch.clone()),
            cpu_model: Some(hw.cpu_model.clone()),
            cpu_cores: Some(hw.cpu_cores as i64),
            mem_total: Some(hw.mem_total as i64),
            swap_total: Some(hw.swap_total as i64),
            agent_version: Some(hw.agent_ver.clone()),
            proc_enabled: false,
        };
        if let Err(e) = hub
            .db
            .ensure_self_probe_node(&node_id, &node_name, &hw_info, now)
        {
            eprintln!("[uniob-hub] self_probe node init error: {e}");
            return;
        }
        let _ = hub.ingest_hello(&node_id, None, hw).await;
        let quality = crate::network_quality::ProbeRuntime::new(&node_id);
        if let Ok(control) = hub.db.network_control(&node_id) {
            if let Ok(value) = serde_json::to_value(control) {
                quality.apply_control(Some(&value), true);
            }
        }

        let mut prev_cpu = read_linux_cpu();
        let mut prev_net = read_linux_net();
        let mut prev_ms = now_ms();

        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        loop {
            let refresh_only = tokio::select! {
                _ = ticker.tick() => false,
                _ = hub.self_probe_notify.notified() => true,
            };
            if refresh_only {
                if let Ok(control) = hub.db.network_control(&node_id) {
                    if let Ok(value) = serde_json::to_value(control) {
                        quality.apply_control(Some(&value), false);
                    }
                }
                continue;
            }
            let quality_payload = quality.payload();
            let curr_ms = now_ms();
            let elapsed_sec = ((curr_ms.saturating_sub(prev_ms)) as f64 / 1000.0).max(0.5);
            prev_ms = curr_ms;

            let curr_cpu = read_linux_cpu();
            let curr_net = read_linux_net();

            let (all, steal, iowait) = compute_cpu_pct(&prev_cpu.0, &curr_cpu.0);
            let mut per_core = Vec::with_capacity(curr_cpu.1.len());
            for (i, c) in curr_cpu.1.iter().enumerate() {
                if let Some(pc) = prev_cpu.1.get(i) {
                    per_core.push(compute_cpu_pct(pc, c).0);
                }
            }
            prev_cpu = curr_cpu;

            let rx_bps = ((curr_net.rx_bytes.saturating_sub(prev_net.rx_bytes)) as f64
                / elapsed_sec)
                .round() as u64;
            let tx_bps = ((curr_net.tx_bytes.saturating_sub(prev_net.tx_bytes)) as f64
                / elapsed_sec)
                .round() as u64;
            prev_net = curr_net.clone();

            let (_, _, mem) = std::fs::read_to_string("/proc/meminfo")
                .map(|s| parse_meminfo(&s))
                .unwrap_or_else(|_| {
                    (
                        0,
                        0,
                        MemMetrics {
                            used: 0,
                            avail: 0,
                            cached: 0,
                            swap_used: 0,
                        },
                    )
                });
            let load = std::fs::read_to_string("/proc/loadavg")
                .map(|s| parse_loadavg(&s))
                .unwrap_or_else(|_| vec![0.0, 0.0, 0.0]);
            let up = std::fs::read_to_string("/proc/uptime")
                .map(|s| parse_uptime(&s))
                .unwrap_or(0);
            let disks = read_linux_disks();
            let (tcp_est, tcp_tw) = read_linux_tcp_counts();
            let ts = now_sec() as u64;

            let frame = AgentMetricsFrame {
                network_quality: None,
                ts,
                up,
                cpu: CpuMetrics {
                    all,
                    cores: per_core,
                    steal,
                    iowait,
                    load,
                },
                mem,
                disks,
                net: NetMetrics {
                    rx_bps,
                    tx_bps,
                    rx_tot: curr_net.rx_bytes,
                    tx_tot: curr_net.tx_bytes,
                    tcp_est,
                    tcp_tw,
                    udp: 0,
                },
                procs: None,
                upd: None,
            };

            let tuple = crate::protocol::metrics_frame_to_tuple(&frame);
            let mb = AgentMetricsBatchFrame {
                network_quality: quality_payload
                    .as_ref()
                    .and_then(|p| serde_json::to_value(p).ok()),
                upd: None,
                v: 2,
                reason: "cohort".to_string(),
                pts: vec![tuple],
                last: frame,
            };
            if hub.ingest_metrics_v2_mb(&node_id, mb).await.is_ok() {
                if let Some(payload) = quality_payload.as_ref() {
                    quality.mark_sent(payload);
                }
            }
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn spawn_self_probe_loop(_hub: HubState) {
    // Non-Linux hosts have no /proc filesystem; loopback self-probe is skipped silently.
}

#[cfg(target_os = "linux")]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(target_os = "linux")]
fn read_linux_cpu() -> (CpuTimes, Vec<CpuTimes>) {
    std::fs::read_to_string("/proc/stat")
        .map(|s| parse_cpu_stat(&s))
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn read_linux_net() -> NetTotals {
    std::fs::read_to_string("/proc/net/dev")
        .map(|s| parse_net_dev(&s))
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn read_linux_tcp_counts() -> (u32, u32) {
    let mut est = 0u32;
    let mut tw = 0u32;
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(raw) = std::fs::read_to_string(path) {
            for line in raw.lines().skip(1) {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if let Some(&st) = cols.get(3) {
                    if st == "01" {
                        est += 1;
                    } else if st == "06" {
                        tw += 1;
                    }
                }
            }
        }
    }
    (est, tw)
}

#[cfg(target_os = "linux")]
#[allow(clippy::unnecessary_cast)]
fn read_linux_disks() -> Vec<AgentDiskEntry> {
    use std::ffi::CString;
    let mut out = Vec::new();
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return out;
    };
    let mut seen_devs = std::collections::HashSet::new();
    for line in mounts.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        let dev = cols[0];
        let mp = cols[1];
        let fs = cols[2];
        if !matches!(fs, "ext4" | "xfs" | "btrfs" | "f2fs" | "zfs" | "overlay") {
            continue;
        }
        if mp.starts_with("/var/lib/docker") || mp.starts_with("/snap") {
            continue;
        }
        if !seen_devs.insert(dev.to_string()) {
            continue;
        }
        if let Ok(c_path) = CString::new(mp) {
            let mut vfs: libc::statvfs = unsafe { std::mem::zeroed() };
            let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut vfs) };
            if rc == 0 && vfs.f_blocks > 0 {
                let frsize = if vfs.f_frsize > 0 {
                    vfs.f_frsize as u64
                } else {
                    vfs.f_bsize as u64
                };
                let total = (vfs.f_blocks as u64).saturating_mul(frsize);
                let avail = (vfs.f_bavail as u64).saturating_mul(frsize);
                let free = (vfs.f_bfree as u64).saturating_mul(frsize);
                let used = total.saturating_sub(free);
                let _ = avail;
                out.push(AgentDiskEntry {
                    mp: mp.to_string(),
                    fs: fs.to_string(),
                    total,
                    used,
                    r_bps: 0,
                    w_bps: 0,
                });
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn read_linux_hardware() -> AgentHelloFrame {
    let hostname = std::fs::read_to_string("/etc/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "uniob-hub".to_string());
    let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "linux".to_string());
    let mut cpu_model = String::new();
    let mut cpu_cores = 0u32;
    if let Ok(cpuinfo) = std::fs::read_to_string("/proc/cpuinfo") {
        for line in cpuinfo.lines() {
            if let Some((k, v)) = line.split_once(':') {
                let key = k.trim();
                if key == "processor" {
                    cpu_cores += 1;
                } else if (key == "model name" || key == "Model") && cpu_model.is_empty() {
                    cpu_model = v.trim().to_string();
                }
            }
        }
    }
    let (mem_total, swap_total, _) = std::fs::read_to_string("/proc/meminfo")
        .map(|s| parse_meminfo(&s))
        .unwrap_or_else(|_| {
            (
                0,
                0,
                MemMetrics {
                    used: 0,
                    avail: 0,
                    cached: 0,
                    swap_used: 0,
                },
            )
        });
    let up = std::fs::read_to_string("/proc/uptime")
        .map(|s| parse_uptime(&s))
        .unwrap_or(0);
    let boot_time = (now_sec() as u64).saturating_sub(up);

    AgentHelloFrame {
        v: 2,
        agent_ver: format!("hub-loopback-{}", env!("CARGO_PKG_VERSION")),
        hostname,
        os: "Linux".to_string(),
        kernel,
        arch: std::env::consts::ARCH.to_string(),
        cpu_model,
        cpu_cores: cpu_cores.max(1),
        mem_total,
        swap_total,
        boot_time,
        proc_enabled: false,
        capabilities: vec!["mb_v2".to_string(), "network_quality_v1".to_string()],
        migrated_epoch: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_parsers_compute_expected_metrics() {
        let stat1 = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\n";
        let stat2 = "cpu  200 0 100 1050 50 0 0 0 0 0\ncpu0 100 0 50 525 25 0 0 0 0 0\n";
        let (a1, c1) = parse_cpu_stat(stat1);
        let (a2, c2) = parse_cpu_stat(stat2);
        let (all, steal, iowait) = compute_cpu_pct(&a1, &a2);
        // total delta = 400, busy delta = 150 -> 37.5%
        assert_eq!(all, 37.5);
        assert_eq!(steal, 0.0);
        assert_eq!(iowait, 0.0);
        assert_eq!(compute_cpu_pct(&c1[0], &c2[0]).0, 37.5);

        let meminfo = "MemTotal: 4096000 kB\nMemAvailable: 1024000 kB\nCached: 512000 kB\nSwapTotal: 1048576 kB\nSwapFree: 524288 kB\n";
        let (mt, st, m) = parse_meminfo(meminfo);
        assert_eq!(mt, 4096000 * 1024);
        assert_eq!(st, 1048576 * 1024);
        assert_eq!(m.used, (4096000 - 1024000) * 1024);
        assert_eq!(m.swap_used, 524288 * 1024);

        let net = "Inter-|\n face |\n    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n";
        let nt = parse_net_dev(net);
        assert_eq!(nt.rx_bytes, 1000);
        assert_eq!(nt.tx_bytes, 2000);
    }
}
