use crate::protocol::NetMetrics;
use std::fs;

const VIRTUAL_NIC_PREFIXES: &[&str] = &[
    "lo",
    "veth",
    "docker",
    "br-",
    "virbr",
    "cni",
    "flannel",
    "cali",
    "tun",
    "tap",
    "wg",
    "tailscale",
];

pub fn should_include_iface(iface: &str, nic_allowlist: &[String]) -> bool {
    if !nic_allowlist.is_empty() {
        return nic_allowlist.iter().any(|allowed| allowed == iface);
    }
    !VIRTUAL_NIC_PREFIXES
        .iter()
        .any(|prefix| iface.starts_with(prefix))
}

pub fn parse_net_dev(content: &str, nic_allowlist: &[String]) -> (u64, u64) {
    let mut rx_tot: u64 = 0;
    let mut tx_tot: u64 = 0;

    for line in content.lines() {
        let Some((raw_iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = raw_iface.trim();
        if iface.is_empty() || !should_include_iface(iface, nic_allowlist) {
            continue;
        }
        let cols: Vec<&str> = rest.split_whitespace().collect();
        if cols.len() < 9 {
            continue;
        }
        let Ok(rx_bytes) = cols[0].parse::<u64>() else {
            continue;
        };
        let Ok(tx_bytes) = cols[8].parse::<u64>() else {
            continue;
        };
        rx_tot = rx_tot.saturating_add(rx_bytes);
        tx_tot = tx_tot.saturating_add(tx_bytes);
    }

    (rx_tot, tx_tot)
}

fn find_kv_u64(tokens: &[&str], key: &str) -> u64 {
    for pair in tokens.windows(2) {
        if pair[0] == key {
            if let Ok(val) = pair[1].parse::<u64>() {
                return val;
            }
        }
    }
    0
}

/// Parses `/proc/net/sockstat` -> `(tcp_inuse, tcp_tw, udp_inuse)` in O(1).
pub fn parse_sockstat(content: &str) -> (u64, u64, u64) {
    let mut tcp_inuse = 0;
    let mut tcp_tw = 0;
    let mut udp_inuse = 0;

    for line in content.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(&proto) = tokens.first() else {
            continue;
        };
        match proto {
            "TCP:" => {
                tcp_inuse = find_kv_u64(&tokens[1..], "inuse");
                tcp_tw = find_kv_u64(&tokens[1..], "tw");
            }
            "UDP:" => {
                udp_inuse = find_kv_u64(&tokens[1..], "inuse");
            }
            _ => {}
        }
    }

    (tcp_inuse, tcp_tw, udp_inuse)
}

/// Parses `/proc/net/sockstat6` -> `(tcp6_inuse, udp6_inuse)` in O(1).
pub fn parse_sockstat6(content: &str) -> (u64, u64) {
    let mut tcp6_inuse = 0;
    let mut udp6_inuse = 0;

    for line in content.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(&proto) = tokens.first() else {
            continue;
        };
        match proto {
            "TCP6:" => tcp6_inuse = find_kv_u64(&tokens[1..], "inuse"),
            "UDP6:" => udp6_inuse = find_kv_u64(&tokens[1..], "inuse"),
            _ => {}
        }
    }

    (tcp6_inuse, udp6_inuse)
}

#[derive(Debug, Default)]
pub struct NetCollector {
    prev_totals: Option<(u64, u64)>,
}

impl NetCollector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build_metrics(
        &mut self,
        net_dev_content: &str,
        sockstat_content: &str,
        sockstat6_content: Option<&str>,
        nic_allowlist: &[String],
        dt_sec: Option<f64>,
    ) -> NetMetrics {
        let (rx_tot, tx_tot) = parse_net_dev(net_dev_content, nic_allowlist);

        let (rx_bps, tx_bps) = match (dt_sec, self.prev_totals) {
            (Some(dt), Some((prev_rx, prev_tx))) if dt > 0.0 => {
                let rx_rate = if rx_tot >= prev_rx {
                    ((rx_tot - prev_rx) as f64 / dt).round() as u64
                } else {
                    0
                };
                let tx_rate = if tx_tot >= prev_tx {
                    ((tx_tot - prev_tx) as f64 / dt).round() as u64
                } else {
                    0
                };
                (rx_rate, tx_rate)
            }
            _ => (0, 0),
        };
        self.prev_totals = Some((rx_tot, tx_tot));

        let (tcp4_est, tcp_tw, udp4) = parse_sockstat(sockstat_content);
        let (tcp6_est, udp6) = sockstat6_content.map(parse_sockstat6).unwrap_or((0, 0));

        NetMetrics {
            rx_bps,
            tx_bps,
            rx_tot,
            tx_tot,
            tcp_est: tcp4_est.saturating_add(tcp6_est),
            tcp_tw,
            udp: udp4.saturating_add(udp6),
        }
    }

    pub fn collect(&mut self, nic_allowlist: &[String], dt_sec: Option<f64>) -> NetMetrics {
        let net_dev = fs::read_to_string("/proc/net/dev").unwrap_or_default();
        let sockstat = fs::read_to_string("/proc/net/sockstat").unwrap_or_default();
        let sockstat6 = fs::read_to_string("/proc/net/sockstat6").ok();

        self.build_metrics(
            &net_dev,
            &sockstat,
            sockstat6.as_deref(),
            nic_allowlist,
            dt_sec,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_NET_DEV_1: &str = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999   100    0    0    0     0          0         0  9999999   100    0    0    0     0       0          0
  eth0: 1000000  1000    0    0    0     0          0         0  2000000  1200    0    0    0     0       0          0
docker0: 500000   200    0    0    0     0          0         0   500000   200    0    0    0     0       0          0
veth12a: 100000    50    0    0    0     0          0         0   100000    50    0    0    0     0       0          0
br-abc:  200000    60    0    0    0     0          0         0   200000    60    0    0    0     0       0          0
tailscale0: 5000 10    0    0    0     0          0         0     5000    10    0    0    0     0       0          0
  wg0:    12345    10    0    0    0     0          0         0    12345    10    0    0    0     0       0          0
";

    const SAMPLE_NET_DEV_2: &str = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 12000000  200    0    0    0     0          0         0 12000000   200    0    0    0     0       0          0
  eth0: 1256900  1200    0    0    0     0          0         0  2698240  1500    0    0    0     0       0          0
docker0: 600000   250    0    0    0     0          0         0   600000   250    0    0    0     0       0          0
";

    const SAMPLE_SOCKSTAT: &str = "\
sockets: used 142
TCP: inuse 24 orphan 0 tw 11 alloc 28 mem 3
UDP: inuse 4 mem 1
UDPLITE: inuse 0
RAW: inuse 0
FRAG: inuse 0 memory 0
";

    const SAMPLE_SOCKSTAT6: &str = "\
TCP6: inuse 6
UDP6: inuse 2
UDPLITE6: inuse 0
RAW6: inuse 0
FRAG6: inuse 0 memory 0
";

    #[test]
    fn filters_virtual_nics_unless_allowlist_set_and_parses_sockstat() {
        let mut collector = NetCollector::new();
        let m1 = collector.build_metrics(
            SAMPLE_NET_DEV_1,
            SAMPLE_SOCKSTAT,
            Some(SAMPLE_SOCKSTAT6),
            &[],
            None,
        );
        assert_eq!(m1.rx_tot, 1_000_000);
        assert_eq!(m1.tx_tot, 2_000_000);
        assert_eq!(m1.rx_bps, 0);
        assert_eq!(m1.tx_bps, 0);
        assert_eq!(m1.tcp_est, 30); // 24 + 6
        assert_eq!(m1.tcp_tw, 11);
        assert_eq!(m1.udp, 6); // 4 + 2

        let m2 = collector.build_metrics(SAMPLE_NET_DEV_2, SAMPLE_SOCKSTAT, None, &[], Some(2.0));
        assert_eq!(m2.rx_tot, 1_256_900);
        assert_eq!(m2.tx_tot, 2_698_240);
        assert_eq!(m2.rx_bps, 128_450);
        assert_eq!(m2.tx_bps, 349_120);
        assert_eq!(m2.tcp_est, 24);
        assert_eq!(m2.udp, 4);

        // Allowlist overrides virtual NIC filtering.
        let mut allow_collector = NetCollector::new();
        let m_allow = allow_collector.build_metrics(
            SAMPLE_NET_DEV_1,
            SAMPLE_SOCKSTAT,
            None,
            &["wg0".to_string(), "eth0".to_string()],
            None,
        );
        assert_eq!(m_allow.rx_tot, 1_012_345);
        assert_eq!(m_allow.tx_tot, 2_012_345);
    }
}
