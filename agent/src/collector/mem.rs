use crate::protocol::MemMetrics;
use std::fs;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MemSnapshot {
    pub metrics: MemMetrics,
    pub mem_total: u64,
    pub swap_total: u64,
}

pub fn parse_meminfo(content: &str) -> MemSnapshot {
    let mut mem_total: u64 = 0;
    let mut mem_free: u64 = 0;
    let mut mem_available: Option<u64> = None;
    let mut buffers: u64 = 0;
    let mut cached: u64 = 0;
    let mut s_reclaimable: u64 = 0;
    let mut shmem: u64 = 0;
    let mut swap_total: u64 = 0;
    let mut swap_free: u64 = 0;

    for line in content.lines() {
        let Some((raw_key, raw_rest)) = line.split_once(':') else {
            continue;
        };
        let Some(kb) = raw_rest
            .split_whitespace()
            .next()
            .and_then(|tok| tok.parse::<u64>().ok())
        else {
            continue;
        };
        let bytes = kb.saturating_mul(1024);

        match raw_key.trim() {
            "MemTotal" => mem_total = bytes,
            "MemFree" => mem_free = bytes,
            "MemAvailable" => mem_available = Some(bytes),
            "Buffers" => buffers = bytes,
            "Cached" => cached = bytes,
            "SReclaimable" => s_reclaimable = bytes,
            "Shmem" => shmem = bytes,
            "SwapTotal" => swap_total = bytes,
            "SwapFree" => swap_free = bytes,
            _ => {}
        }
    }

    let avail_raw = mem_available.unwrap_or_else(|| {
        mem_free
            .saturating_add(buffers)
            .saturating_add(cached)
            .saturating_add(s_reclaimable)
            .saturating_sub(shmem)
    });
    let avail = avail_raw.min(mem_total);
    let used = mem_total.saturating_sub(avail);
    let total_cached = buffers.saturating_add(cached).saturating_add(s_reclaimable);
    let swap_used = swap_total.saturating_sub(swap_free);

    MemSnapshot {
        metrics: MemMetrics {
            used,
            avail,
            cached: total_cached,
            swap_used,
        },
        mem_total,
        swap_total,
    }
}

pub fn collect_mem() -> MemSnapshot {
    fs::read_to_string("/proc/meminfo")
        .ok()
        .map(|s| parse_meminfo(&s))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo_with_mem_available() {
        let sample = "\
MemTotal:        1000000 kB
MemFree:          100000 kB
MemAvailable:     600000 kB
Buffers:           50000 kB
Cached:           200000 kB
SwapTotal:       1048576 kB
SwapFree:        1036288 kB
Shmem:             10000 kB
SReclaimable:      30000 kB
";
        let snap = parse_meminfo(sample);
        assert_eq!(snap.mem_total, 1_000_000 * 1024);
        assert_eq!(snap.swap_total, 1_048_576 * 1024);
        assert_eq!(snap.metrics.avail, 600_000 * 1024);
        assert_eq!(snap.metrics.used, 400_000 * 1024);
        assert_eq!(snap.metrics.cached, (50_000 + 200_000 + 30_000) * 1024);
        assert_eq!(snap.metrics.swap_used, (1_048_576 - 1_036_288) * 1024);
    }

    #[test]
    fn falls_back_on_old_kernels_without_mem_available() {
        let legacy = "\
MemTotal:        1000000 kB
MemFree:          200000 kB
Buffers:           50000 kB
Cached:           300000 kB
Shmem:             20000 kB
SReclaimable:      40000 kB
SwapTotal:        500000 kB
SwapFree:         500000 kB
";
        let snap = parse_meminfo(legacy);
        // Fallback: 200000 + 50000 + 300000 + 40000 - 20000 = 570000 kB
        assert_eq!(snap.metrics.avail, 570_000 * 1024);
        assert_eq!(snap.metrics.used, 430_000 * 1024);
        assert_eq!(snap.metrics.swap_used, 0);
    }
}
