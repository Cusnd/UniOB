use chrono::{Datelike, NaiveDate, TimeZone, Utc};

#[derive(Debug, Clone)]
pub struct TrafficLedgerState {
    pub cycle_key: String,
    pub last_agent_rx: i64,
    pub last_agent_tx: i64,
    pub cycle_rx_bytes: i64,
    pub cycle_tx_bytes: i64,
    pub updated_at: i64,
}

fn days_in_utc_month(year: i32, month1: u32) -> u32 {
    let next = if month1 == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month1 + 1, 1)
    }
    .unwrap_or_else(|| NaiveDate::from_ymd_opt(year, month1, 28).unwrap());
    next.pred_opt().map(|d| d.day()).unwrap_or(28)
}

pub fn compute_traffic_cycle(ts_sec: i64, reset_day: i64) -> (String, i64) {
    let safe_reset_day = reset_day.clamp(1, 31) as u32;
    let dt = Utc
        .timestamp_opt(ts_sec, 0)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
    let year = dt.year();
    let month = dt.month(); // 1..=12
    let day = dt.day();

    let effective_this_month = safe_reset_day.min(days_in_utc_month(year, month));

    let (start_year, start_month, next_year, next_month, next_day) = if day < effective_this_month {
        let (sy, sm) = if month == 1 {
            (year - 1, 12)
        } else {
            (year, month - 1)
        };
        (sy, sm, year, month, effective_this_month)
    } else {
        let (ny, nm) = if month == 12 {
            (year + 1, 1)
        } else {
            (year, month + 1)
        };
        let nd = safe_reset_day.min(days_in_utc_month(ny, nm));
        (year, month, ny, nm, nd)
    };

    let cycle_key = format!("{start_year:04}-{start_month:02}");
    let next_reset_ts = Utc
        .with_ymd_and_hms(next_year, next_month, next_day, 0, 0, 0)
        .single()
        .map(|d| d.timestamp())
        .unwrap_or(ts_sec);

    let diff = next_reset_ts - ts_sec;
    let days_remaining = if diff <= 0 { 0 } else { (diff + 86399) / 86400 };
    (cycle_key, days_remaining)
}

pub fn compute_counted_bytes(rx_bytes: i64, tx_bytes: i64, mode: &str) -> i64 {
    match mode {
        "tx_only" => tx_bytes,
        "max" => rx_bytes.max(tx_bytes),
        _ => rx_bytes.saturating_add(tx_bytes),
    }
}

pub struct TrafficAdvanceResult {
    pub next: TrafficLedgerState,
    pub rebooted: bool,
    pub cycle_reset: bool,
}

pub fn advance_traffic_ledger(
    prev: Option<&TrafficLedgerState>,
    agent_rx_tot: u64,
    agent_tx_tot: u64,
    ts_sec: i64,
    reset_day: i64,
) -> TrafficAdvanceResult {
    let rx_tot = i64::try_from(agent_rx_tot).unwrap_or(i64::MAX);
    let tx_tot = i64::try_from(agent_tx_tot).unwrap_or(i64::MAX);
    let (cycle_key, _) = compute_traffic_cycle(ts_sec, reset_day);

    let Some(prev) = prev else {
        return TrafficAdvanceResult {
            next: TrafficLedgerState {
                cycle_key,
                last_agent_rx: rx_tot,
                last_agent_tx: tx_tot,
                cycle_rx_bytes: 0,
                cycle_tx_bytes: 0,
                updated_at: ts_sec,
            },
            rebooted: false,
            cycle_reset: false,
        };
    };

    let rx_rebooted = rx_tot < prev.last_agent_rx;
    let tx_rebooted = tx_tot < prev.last_agent_tx;
    let rebooted = rx_rebooted || tx_rebooted;

    let delta_rx = if rx_rebooted {
        rx_tot
    } else {
        rx_tot - prev.last_agent_rx
    };
    let delta_tx = if tx_rebooted {
        tx_tot
    } else {
        tx_tot - prev.last_agent_tx
    };

    let cycle_reset = prev.cycle_key != cycle_key;
    let base_rx = if cycle_reset { 0 } else { prev.cycle_rx_bytes };
    let base_tx = if cycle_reset { 0 } else { prev.cycle_tx_bytes };

    TrafficAdvanceResult {
        next: TrafficLedgerState {
            cycle_key,
            last_agent_rx: rx_tot,
            last_agent_tx: tx_tot,
            cycle_rx_bytes: base_rx.saturating_add(delta_rx),
            cycle_tx_bytes: base_tx.saturating_add(delta_tx),
            updated_at: ts_sec,
        },
        rebooted,
        cycle_reset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traffic_cycle_handles_leap_feb_and_clamping() {
        // 2024-02-28 12:00:00 UTC with reset_day 31 -> clamped to Feb 29 (leap year)
        let ts = Utc
            .with_ymd_and_hms(2024, 2, 28, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        let (cycle_key, days_rem) = compute_traffic_cycle(ts, 31);
        assert_eq!(cycle_key, "2024-01");
        assert_eq!(days_rem, 1);

        // On 2024-02-29 00:00:00 UTC -> new cycle 2024-02, next reset 2024-03-31 (31 days)
        let ts2 = Utc
            .with_ymd_and_hms(2024, 2, 29, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp();
        let (cycle_key2, days_rem2) = compute_traffic_cycle(ts2, 31);
        assert_eq!(cycle_key2, "2024-02");
        assert_eq!(days_rem2, 31);
    }

    #[test]
    fn traffic_ledger_handles_reboot_and_cycle_reset() {
        let init = advance_traffic_ledger(None, 1_000, 2_000, 1_704_067_200, 1); // 2024-01-01
        assert_eq!(init.next.cycle_rx_bytes, 0);
        assert_eq!(init.next.cycle_tx_bytes, 0);

        let step = advance_traffic_ledger(Some(&init.next), 1_500, 2_800, 1_704_067_230, 1);
        assert!(!step.rebooted);
        assert_eq!(step.next.cycle_rx_bytes, 500);
        assert_eq!(step.next.cycle_tx_bytes, 800);

        // Reboot wraps counters down
        let reb = advance_traffic_ledger(Some(&step.next), 200, 300, 1_704_067_260, 1);
        assert!(reb.rebooted);
        assert_eq!(reb.next.cycle_rx_bytes, 700);
        assert_eq!(reb.next.cycle_tx_bytes, 1100);
    }
}
