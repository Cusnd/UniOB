use crate::protocol::CpuMetrics;
use std::fs;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CpuJiffies {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
}

impl CpuJiffies {
    /// Per Spec 4.2.1: sum ONLY the first 8 counters (user, nice, system, idle, iowait, irq,
    /// softirq, steal). Columns 9 and 10 (guest, guest_nice) are already accounted for in
    /// user/nice by the Linux kernel and must be excluded from total.
    pub fn total(&self) -> u64 {
        self.user
            .saturating_add(self.nice)
            .saturating_add(self.system)
            .saturating_add(self.idle)
            .saturating_add(self.iowait)
            .saturating_add(self.irq)
            .saturating_add(self.softirq)
            .saturating_add(self.steal)
    }

    pub fn idle_all(&self) -> u64 {
        self.idle.saturating_add(self.iowait)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProcStatData {
    pub total: CpuJiffies,
    pub cores: Vec<CpuJiffies>,
    pub btime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticHostInfo {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub cpu_model: String,
    pub cpu_cores: u32,
    pub boot_time: u64,
}

pub fn parse_cpu_jiffies(fields: &[&str]) -> Option<CpuJiffies> {
    if fields.len() < 7 {
        return None;
    }
    let parse_u64 = |idx: usize| -> Option<u64> { fields.get(idx)?.parse::<u64>().ok() };
    Some(CpuJiffies {
        user: parse_u64(0)?,
        nice: parse_u64(1)?,
        system: parse_u64(2)?,
        idle: parse_u64(3)?,
        iowait: parse_u64(4)?,
        irq: parse_u64(5)?,
        softirq: parse_u64(6)?,
        steal: fields
            .get(7)
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0),
    })
}

pub fn parse_proc_stat(content: &str) -> Result<ProcStatData, String> {
    let mut total: Option<CpuJiffies> = None;
    let mut indexed_cores: Vec<(usize, CpuJiffies)> = Vec::new();
    let mut btime: u64 = 0;

    for line in content.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else {
            continue;
        };

        if key == "cpu" {
            let fields: Vec<&str> = parts.collect();
            if let Some(jiffies) = parse_cpu_jiffies(&fields) {
                total = Some(jiffies);
            }
        } else if let Some(suffix) = key.strip_prefix("cpu") {
            if let Ok(core_idx) = suffix.parse::<usize>() {
                let fields: Vec<&str> = parts.collect();
                if let Some(jiffies) = parse_cpu_jiffies(&fields) {
                    indexed_cores.push((core_idx, jiffies));
                }
            }
        } else if key == "btime" {
            if let Some(val) = parts.next().and_then(|s| s.parse::<u64>().ok()) {
                btime = val;
            }
        }
    }

    let total = total.ok_or_else(|| "missing aggregate 'cpu' line in /proc/stat".to_string())?;
    indexed_cores.sort_by_key(|(idx, _)| *idx);
    let cores = indexed_cores.into_iter().map(|(_, j)| j).collect();

    Ok(ProcStatData {
        total,
        cores,
        btime,
    })
}

fn pct_delta(num_curr: u64, num_prev: u64, den_delta: u64) -> f64 {
    if den_delta == 0 {
        return 0.0;
    }
    let diff = num_curr.saturating_sub(num_prev);
    let pct = (diff as f64 / den_delta as f64) * 100.0;
    round1(pct.clamp(0.0, 100.0))
}

fn round1(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * 10.0).round() / 10.0
}

fn compute_usage_pct(prev: &CpuJiffies, curr: &CpuJiffies) -> (f64, f64, f64) {
    let total_delta = curr.total().saturating_sub(prev.total());
    if total_delta == 0 {
        return (0.0, 0.0, 0.0);
    }
    let idle_delta = curr.idle_all().saturating_sub(prev.idle_all());
    let active_delta = total_delta.saturating_sub(idle_delta);
    let all = round1(((active_delta as f64 / total_delta as f64) * 100.0).clamp(0.0, 100.0));
    let steal = pct_delta(curr.steal, prev.steal, total_delta);
    let iowait = pct_delta(curr.iowait, prev.iowait, total_delta);
    (all, steal, iowait)
}

pub fn compute_cpu_metrics(
    prev: Option<&ProcStatData>,
    curr: &ProcStatData,
    load: [f64; 3],
) -> CpuMetrics {
    let Some(prev) = prev else {
        return CpuMetrics {
            all: 0.0,
            cores: vec![0.0; curr.cores.len()],
            steal: 0.0,
            iowait: 0.0,
            load,
        };
    };

    let (all, steal, iowait) = compute_usage_pct(&prev.total, &curr.total);
    let cores = curr
        .cores
        .iter()
        .enumerate()
        .map(|(i, c)| match prev.cores.get(i) {
            Some(p) => compute_usage_pct(p, c).0,
            None => 0.0,
        })
        .collect();

    CpuMetrics {
        all,
        cores,
        steal,
        iowait,
        load,
    }
}

pub fn parse_loadavg(content: &str) -> [f64; 3] {
    let mut nums = content
        .split_whitespace()
        .take(3)
        .filter_map(|tok| tok.parse::<f64>().ok())
        .map(|v| if v.is_finite() { v } else { 0.0 });

    [
        nums.next().unwrap_or(0.0),
        nums.next().unwrap_or(0.0),
        nums.next().unwrap_or(0.0),
    ]
}

pub fn parse_uptime(content: &str) -> u64 {
    let first = content.split_whitespace().next().unwrap_or("0");
    match first.parse::<f64>() {
        Ok(secs) if secs.is_finite() && secs >= 0.0 => secs.floor() as u64,
        _ => 0,
    }
}

pub fn parse_cpuinfo(content: &str) -> (String, u32) {
    let mut cores: u32 = 0;
    let mut model_name: Option<String> = None;
    let mut fallback_model: Option<String> = None;

    for line in content.lines() {
        let Some((raw_key, raw_val)) = line.split_once(':') else {
            continue;
        };
        let key = raw_key.trim();
        let val = raw_val.trim();

        if key == "processor" {
            cores = cores.saturating_add(1);
        } else if key == "model name" && model_name.is_none() && !val.is_empty() {
            model_name = Some(val.to_string());
        } else if matches!(key, "Model" | "Hardware" | "Processor")
            && fallback_model.is_none()
            && !val.is_empty()
        {
            fallback_model = Some(val.to_string());
        }
    }

    let model = model_name
        .or(fallback_model)
        .unwrap_or_else(|| "Unknown CPU".to_string());
    (model, cores)
}

pub fn parse_os_release(content: &str) -> Option<String> {
    let mut pretty: Option<String> = None;
    let mut name: Option<String> = None;
    let mut version_id: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once('=') else {
            continue;
        };
        let unquoted = v.trim().trim_matches('"').trim_matches('\'').to_string();
        if unquoted.is_empty() {
            continue;
        }
        match k.trim() {
            "PRETTY_NAME" => pretty = Some(unquoted),
            "NAME" => name = Some(unquoted),
            "VERSION_ID" => version_id = Some(unquoted),
            _ => {}
        }
    }

    pretty.or_else(|| match (name, version_id) {
        (Some(n), Some(v)) => Some(format!("{n} {v}")),
        (Some(n), None) => Some(n),
        _ => None,
    })
}

pub fn collect_static_info(stat: Option<&ProcStatData>) -> StaticHostInfo {
    let hostname = fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("HOSTNAME")
                .or_else(|_| std::env::var("COMPUTERNAME"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());

    let os = fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| parse_os_release(&s))
        .or_else(|| {
            fs::read_to_string("/proc/sys/kernel/ostype")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| std::env::consts::OS.to_string());

    let kernel = fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    let (cpu_model, cpuinfo_cores) = fs::read_to_string("/proc/cpuinfo")
        .ok()
        .map(|s| parse_cpuinfo(&s))
        .unwrap_or_else(|| ("Unknown CPU".to_string(), 0));

    let stat_cores = stat.map(|s| s.cores.len() as u32).unwrap_or(0);
    let cpu_cores = if cpuinfo_cores > 0 {
        cpuinfo_cores
    } else if stat_cores > 0 {
        stat_cores
    } else {
        std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1)
    };

    let boot_time = stat.map(|s| s.btime).unwrap_or(0);

    StaticHostInfo {
        hostname,
        os,
        kernel,
        arch: std::env::consts::ARCH.to_string(),
        cpu_model,
        cpu_cores,
        boot_time,
    }
}

pub fn read_proc_stat() -> Option<ProcStatData> {
    fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|s| parse_proc_stat(&s).ok())
}

pub fn read_loadavg() -> [f64; 3] {
    fs::read_to_string("/proc/loadavg")
        .ok()
        .map(|s| parse_loadavg(&s))
        .unwrap_or([0.0, 0.0, 0.0])
}

pub fn read_uptime() -> u64 {
    fs::read_to_string("/proc/uptime")
        .ok()
        .map(|s| parse_uptime(&s))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_stat_excluding_guest_from_total() {
        let sample = "\
cpu  100 10 40 800 20 5 5 20 500 200
cpu0 60 5 25 390 10 3 2 10 250 100
cpu1 40 5 15 410 10 2 3 10 250 100
intr 12345
ctxt 67890
btime 1762001234
processes 42
";
        let prev = parse_proc_stat(sample).unwrap();
        assert_eq!(prev.btime, 1762001234);
        assert_eq!(prev.cores.len(), 2);
        // First 8 sum: 100+10+40+800+20+5+5+20 = 1000 (500 & 200 guest/guest_nice excluded!).
        assert_eq!(prev.total.total(), 1000);

        let sample2 = "\
cpu  200 10 60 1500 40 5 5 40 999 999
cpu0 120 5 35 720 20 3 2 20 500 500
cpu1 80 5 25 780 20 2 3 20 499 499
btime 1762001234
";
        let curr = parse_proc_stat(sample2).unwrap();
        // Total delta = 1860 - 1000 = 860.
        // Idle delta = (1500+40) - (800+20) = 720.
        // Active delta = 860 - 720 = 140 -> 140/860*100 = 16.279% -> 16.3%.
        // Steal delta = 40 - 20 = 20 -> 20/860*100 = 2.325% -> 2.3%.
        // IOWait delta = 40 - 20 = 20 -> 2.3%.
        let metrics = compute_cpu_metrics(Some(&prev), &curr, [0.18, 0.12, 0.09]);
        assert_eq!(metrics.all, 16.3);
        assert_eq!(metrics.steal, 2.3);
        assert_eq!(metrics.iowait, 2.3);
        assert_eq!(metrics.load, [0.18, 0.12, 0.09]);
        assert_eq!(metrics.cores.len(), 2);
        assert_eq!(metrics.cores[0], 19.0);
        assert_eq!(metrics.cores[1], 13.6);
    }

    #[test]
    fn parses_loadavg_uptime_cpuinfo_and_os_release() {
        assert_eq!(
            parse_loadavg("0.18 0.12 0.09 2/198 14209\n"),
            [0.18, 0.12, 0.09]
        );
        assert_eq!(parse_uptime("1126766.89 2234567.12\n"), 1126766);

        let cpuinfo = "\
processor\t: 0
vendor_id\t: AuthenticAMD
model name\t: AMD EPYC 7763 64-Core Processor
processor\t: 1
model name\t: AMD EPYC 7763 64-Core Processor
";
        assert_eq!(
            parse_cpuinfo(cpuinfo),
            ("AMD EPYC 7763 64-Core Processor".to_string(), 2)
        );

        let os_rel = "\
NAME=\"Debian GNU/Linux\"
VERSION_ID=\"12\"
PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"
";
        assert_eq!(
            parse_os_release(os_rel).as_deref(),
            Some("Debian GNU/Linux 12 (bookworm)")
        );
    }
}
