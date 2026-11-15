use crate::config::CmdlineMode;
use crate::protocol::ProcEntry;
use crate::sanitize::format_cmdline;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::ErrorKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcStatParsed {
    pub pid: u32,
    pub comm: String,
    pub state: String,
    pub utime: u64,
    pub stime: u64,
    pub num_threads: u32,
    pub starttime: u64,
    pub rss_pages: u64,
}

#[derive(Debug, Clone)]
pub struct ProcPhase1 {
    pub pid: u32,
    pub user: String,
    pub comm: String,
    pub st: String,
    pub cpu: f64,
    pub rss: u64,
    pub thr: u32,
}

#[derive(Debug, Clone, Copy)]
struct PrevTicks {
    total_ticks: u64,
    starttime: u64,
}

pub fn parse_etc_passwd(content: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split(':');
        let (Some(name), Some(_pw), Some(uid_str)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if let Ok(uid) = uid_str.parse::<u32>() {
            map.entry(uid).or_insert_with(|| name.to_string());
        }
    }
    map
}

/// Parses `/proc/[pid]/stat` using `rfind(')')` so process `comm` names containing spaces or
/// parentheses (e.g. `(sd-pam)`, `(Web Content)`) never misalign subsequent fields.
pub fn parse_pid_stat(content: &str) -> Option<ProcStatParsed> {
    let open = content.find('(')?;
    let close = content.rfind(')')?;
    if close <= open {
        return None;
    }

    let pid = content[..open].trim().parse::<u32>().ok()?;
    let comm = content[open + 1..close].to_string();
    let rest: Vec<&str> = content[close + 1..].split_whitespace().collect();
    if rest.len() <= 21 {
        return None;
    }

    // Indices relative to field (3) `state`:
    // 0 -> (3) state, 11 -> (14) utime, 12 -> (15) stime,
    // 17 -> (20) num_threads, 19 -> (22) starttime, 21 -> (24) rss
    let state = rest[0].to_string();
    let utime = rest[11].parse::<u64>().ok()?;
    let stime = rest[12].parse::<u64>().ok()?;
    let num_threads = rest[17].parse::<u32>().ok()?;
    let starttime = rest[19].parse::<u64>().ok()?;
    let rss_pages = rest[21].parse::<u64>().ok()?;

    Some(ProcStatParsed {
        pid,
        comm,
        state,
        utime,
        stime,
        num_threads,
        starttime,
        rss_pages,
    })
}

/// Phase 2 index selection: computes the union of CPU Top `N` and RSS Top `N`.
pub fn select_phase2_indices(items: &[ProcPhase1], top_n: usize) -> Vec<usize> {
    if items.is_empty() || top_n == 0 {
        return Vec::new();
    }

    let mut by_cpu: Vec<usize> = (0..items.len()).collect();
    by_cpu.sort_by(|&a, &b| {
        items[b]
            .cpu
            .total_cmp(&items[a].cpu)
            .then_with(|| items[b].rss.cmp(&items[a].rss))
            .then_with(|| items[a].pid.cmp(&items[b].pid))
    });

    let mut by_rss: Vec<usize> = (0..items.len()).collect();
    by_rss.sort_by(|&a, &b| {
        items[b]
            .rss
            .cmp(&items[a].rss)
            .then_with(|| items[b].cpu.total_cmp(&items[a].cpu))
            .then_with(|| items[a].pid.cmp(&items[b].pid))
    });

    let mut union = BTreeSet::new();
    for idx in by_cpu.into_iter().take(top_n) {
        union.insert(idx);
    }
    for idx in by_rss.into_iter().take(top_n) {
        union.insert(idx);
    }

    union.into_iter().collect()
}

/// Runs Phase 2: invokes `read_cmdline` ONLY for the union of CPU Top `N` and RSS Top `N`,
/// sanitizes, sorts by CPU% desc -> RSS desc -> PID asc, and truncates to `top_n`.
pub fn finalize_phase2<F>(
    candidates: Vec<ProcPhase1>,
    top_n: usize,
    cmdline_mode: CmdlineMode,
    mut read_cmdline: F,
) -> Vec<ProcEntry>
where
    F: FnMut(u32) -> Option<Vec<u8>>,
{
    let selected_indices = select_phase2_indices(&candidates, top_n);
    let mut entries = Vec::with_capacity(selected_indices.len());

    for idx in selected_indices {
        let p = &candidates[idx];
        let cmd = if cmdline_mode == CmdlineMode::CommOnly {
            format_cmdline(&[], &p.comm, CmdlineMode::CommOnly)
        } else {
            let Some(raw) = read_cmdline(p.pid) else {
                continue;
            };
            format_cmdline(&raw, &p.comm, cmdline_mode)
        };

        entries.push(ProcEntry {
            pid: p.pid,
            user: p.user.clone(),
            comm: p.comm.clone(),
            st: p.st.clone(),
            cpu: p.cpu,
            rss: p.rss,
            thr: p.thr,
            cmd,
        });
    }

    entries.sort_by(|a, b| {
        b.cpu
            .total_cmp(&a.cpu)
            .then_with(|| b.rss.cmp(&a.rss))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    entries.truncate(top_n);
    entries
}

pub struct ProcCollector {
    passwd_cache: HashMap<u32, String>,
    prev_ticks: HashMap<u32, PrevTicks>,
    page_size: u64,
    clk_tck: f64,
}

impl Default for ProcCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcCollector {
    pub fn new() -> Self {
        let passwd_cache = fs::read_to_string("/etc/passwd")
            .ok()
            .map(|s| parse_etc_passwd(&s))
            .unwrap_or_default();

        Self {
            passwd_cache,
            prev_ticks: HashMap::new(),
            page_size: detect_page_size(),
            clk_tck: detect_clk_tck(),
        }
    }

    pub fn clear_state(&mut self) {
        self.prev_ticks.clear();
    }

    pub fn build_from_samples<FCmd>(
        &mut self,
        samples: Vec<(u32, ProcStatParsed)>,
        top_n: usize,
        cmdline_mode: CmdlineMode,
        dt_sec: Option<f64>,
        read_cmdline: FCmd,
    ) -> Vec<ProcEntry>
    where
        FCmd: FnMut(u32) -> Option<Vec<u8>>,
    {
        let mut next_prev = HashMap::with_capacity(samples.len());
        let mut candidates = Vec::with_capacity(samples.len());

        for (uid, stat) in samples {
            let total_ticks = stat.utime.saturating_add(stat.stime);
            let cpu_pct = match (dt_sec, self.prev_ticks.get(&stat.pid)) {
                (Some(dt), Some(prev))
                    if dt > 0.0
                        && prev.starttime == stat.starttime
                        && total_ticks >= prev.total_ticks =>
                {
                    let delta_ticks = total_ticks - prev.total_ticks;
                    let pct = (delta_ticks as f64 / (dt * self.clk_tck)) * 100.0;
                    if pct.is_finite() {
                        (pct * 10.0).round() / 10.0
                    } else {
                        0.0
                    }
                }
                _ => 0.0,
            };

            next_prev.insert(
                stat.pid,
                PrevTicks {
                    total_ticks,
                    starttime: stat.starttime,
                },
            );

            let user = self
                .passwd_cache
                .get(&uid)
                .cloned()
                .unwrap_or_else(|| uid.to_string());

            candidates.push(ProcPhase1 {
                pid: stat.pid,
                user,
                comm: stat.comm,
                st: stat.state,
                cpu: cpu_pct,
                rss: stat.rss_pages.saturating_mul(self.page_size),
                thr: stat.num_threads,
            });
        }

        self.prev_ticks = next_prev;
        finalize_phase2(candidates, top_n, cmdline_mode, read_cmdline)
    }

    pub fn collect(
        &mut self,
        top_n: usize,
        cmdline_mode: CmdlineMode,
        dt_sec: Option<f64>,
    ) -> Vec<ProcEntry> {
        let Ok(entries) = fs::read_dir("/proc") else {
            return Vec::new();
        };

        let mut samples = Vec::new();
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name_str) = file_name.to_str() else {
                continue;
            };
            if !name_str.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let Ok(pid) = name_str.parse::<u32>() else {
                continue;
            };

            let uid = entry_uid(&entry);
            let stat_path = entry.path().join("stat");
            let Ok(stat_raw) = fs::read_to_string(stat_path) else {
                continue;
            };
            let Some(parsed) = parse_pid_stat(&stat_raw) else {
                continue;
            };
            if parsed.pid != pid {
                continue;
            }
            samples.push((uid, parsed));
        }

        self.build_from_samples(samples, top_n, cmdline_mode, dt_sec, |pid| {
            let path = format!("/proc/{pid}/cmdline");
            match fs::read(path) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == ErrorKind::NotFound => None,
                Err(_) => Some(Vec::new()),
            }
        })
    }
}

#[cfg(unix)]
fn entry_uid(entry: &fs::DirEntry) -> u32 {
    use std::os::unix::fs::MetadataExt;
    entry.metadata().map(|m| m.uid()).unwrap_or(0)
}

#[cfg(not(unix))]
fn entry_uid(_entry: &fs::DirEntry) -> u32 {
    0
}

#[cfg(unix)]
fn detect_page_size() -> u64 {
    let val = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if val > 0 {
        val as u64
    } else {
        4096
    }
}

#[cfg(not(unix))]
fn detect_page_size() -> u64 {
    4096
}

#[cfg(unix)]
fn detect_clk_tck() -> f64 {
    let val = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if val > 0 {
        val as f64
    } else {
        100.0
    }
}

#[cfg(not(unix))]
fn detect_clk_tck() -> f64 {
    100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn parses_pid_stat_with_parens_and_spaces_in_comm() {
        let stat_line = "1420 ((sd-pam) helper) S 1 1420 1420 0 -1 4194560 120 0 1 0 350 150 0 0 20 0 2 0 987654 104857600 6936 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
        let parsed = parse_pid_stat(stat_line).unwrap();
        assert_eq!(parsed.pid, 1420);
        assert_eq!(parsed.comm, "(sd-pam) helper");
        assert_eq!(parsed.state, "S");
        assert_eq!(parsed.utime, 350);
        assert_eq!(parsed.stime, 150);
        assert_eq!(parsed.num_threads, 2);
        assert_eq!(parsed.starttime, 987654);
        assert_eq!(parsed.rss_pages, 6936);
    }

    #[test]
    fn parses_etc_passwd_uid_mapping() {
        let passwd = "\
root:x:0:0:root:/root:/bin/bash
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
";
        let map = parse_etc_passwd(passwd);
        assert_eq!(map.get(&0).map(String::as_str), Some("root"));
        assert_eq!(map.get(&33).map(String::as_str), Some("www-data"));
        assert_eq!(map.get(&65534).map(String::as_str), Some("nobody"));
    }

    #[test]
    fn two_phase_reads_cmdline_only_for_union_of_top_cpu_and_top_rss() {
        let mut collector = ProcCollector {
            passwd_cache: HashMap::from([(0, "root".to_string()), (33, "www-data".to_string())]),
            prev_ticks: HashMap::new(),
            page_size: 4096,
            clk_tck: 100.0,
        };

        let make_stat = |pid: u32, comm: &str, ticks: u64, rss_pages: u64| ProcStatParsed {
            pid,
            comm: comm.to_string(),
            state: "S".to_string(),
            utime: ticks,
            stime: 0,
            num_threads: 1,
            starttime: 100,
            rss_pages,
        };

        // Tick 1: baseline ticks
        let s1 = vec![
            (33, make_stat(1, "high_cpu_low_rss", 100, 10)),
            (0, make_stat(2, "low_cpu_high_rss", 100, 9000)),
            (0, make_stat(3, "mid_cpu_mid_rss", 100, 5000)),
            (0, make_stat(4, "idle_bg_1", 100, 50)),
            (0, make_stat(5, "idle_bg_2", 100, 40)),
        ];
        let _ = collector.build_from_samples(s1, 2, CmdlineMode::Sanitized, None, |_| Some(vec![]));

        // Tick 2 over 2.0s:
        // pid 1: +150 ticks -> 75.0% CPU, rss=10 pages (Top CPU #1)
        // pid 3: +40 ticks  -> 20.0% CPU, rss=5000 pages (Top CPU #2 AND Top RSS #2)
        // pid 2: +2 ticks   -> 1.0% CPU, rss=9000 pages (Top RSS #1)
        // pid 4 & pid 5: 0% CPU, low RSS -> MUST NOT have cmdline read!
        let s2 = vec![
            (33, make_stat(1, "high_cpu_low_rss", 250, 10)),
            (0, make_stat(2, "low_cpu_high_rss", 102, 9000)),
            (0, make_stat(3, "mid_cpu_mid_rss", 140, 5000)),
            (0, make_stat(4, "idle_bg_1", 100, 50)),
            (0, make_stat(5, "idle_bg_2", 100, 40)),
        ];

        let read_pids: RefCell<Vec<u32>> = RefCell::new(Vec::new());
        let top2 = collector.build_from_samples(s2, 2, CmdlineMode::Sanitized, Some(2.0), |pid| {
            read_pids.borrow_mut().push(pid);
            Some(format!("cmd-{pid}\0--token\0secret\0").into_bytes())
        });

        let reads = read_pids.into_inner();
        // Union of Top 2 CPU {1, 3} and Top 2 RSS {2, 3} = {1, 2, 3}. Pids 4 and 5 never read!
        assert_eq!(reads, vec![1, 2, 3]);

        // Sorted by CPU desc then truncated to top_n = 2 -> [1, 3].
        assert_eq!(top2.len(), 2);
        assert_eq!(top2[0].pid, 1);
        assert_eq!(top2[0].user, "www-data");
        assert_eq!(top2[0].cpu, 75.0);
        assert_eq!(top2[0].cmd, "cmd-1 --token ***");
        assert_eq!(top2[1].pid, 3);
        assert_eq!(top2[1].cpu, 20.0);
    }

    #[test]
    fn comm_only_mode_never_reads_cmdline() {
        let candidates = vec![ProcPhase1 {
            pid: 99,
            user: "root".to_string(),
            comm: "sshd".to_string(),
            st: "S".to_string(),
            cpu: 1.5,
            rss: 4096,
            thr: 1,
        }];
        let mut called = false;
        let out = finalize_phase2(candidates, 5, CmdlineMode::CommOnly, |_| {
            called = true;
            Some(b"sshd -D".to_vec())
        });
        assert!(!called);
        assert_eq!(out[0].cmd, "sshd");
    }

    #[test]
    fn skips_exited_pids_in_phase2_and_handles_nested_parens_zombie_state() {
        let zombie_stat =
            "888 ((weird (proc) name)) Z 1 888 888 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 555 0 0 0";
        let parsed = parse_pid_stat(zombie_stat).unwrap();
        assert_eq!(parsed.pid, 888);
        assert_eq!(parsed.comm, "(weird (proc) name)");
        assert_eq!(parsed.state, "Z");
        assert_eq!(parsed.rss_pages, 0);

        let candidates = vec![
            ProcPhase1 {
                pid: 10,
                user: "root".to_string(),
                comm: "alive".to_string(),
                st: "D".to_string(),
                cpu: 10.0,
                rss: 1024,
                thr: 1,
            },
            ProcPhase1 {
                pid: 11,
                user: "root".to_string(),
                comm: "exited".to_string(),
                st: "S".to_string(),
                cpu: 5.0,
                rss: 1024,
                thr: 1,
            },
        ];
        let out = finalize_phase2(candidates, 5, CmdlineMode::Sanitized, |pid| {
            if pid == 10 {
                Some(vec![])
            } else {
                None
            }
        });
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pid, 10);
        assert_eq!(out[0].st, "D");
        assert_eq!(out[0].cmd, "[alive]");
    }
}
