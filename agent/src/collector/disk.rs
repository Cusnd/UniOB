use crate::protocol::DiskMetrics;
use std::collections::HashMap;
use std::fs;

const VIRTUAL_FS_TYPES: &[&str] = &[
    "proc",
    "sysfs",
    "tmpfs",
    "devtmpfs",
    "overlay",
    "squashfs",
    "cgroup",
    "cgroup2",
    "nsfs",
    "autofs",
    "fuse.lxcfs",
    "tracefs",
    "devpts",
    "mqueue",
    "hugetlbfs",
    "securityfs",
    "pstore",
    "bpf",
    "configfs",
    "debugfs",
    "fusectl",
    "efivarfs",
    "binfmt_misc",
    "rpc_pipefs",
    "ramfs",
    "drm",
    "fuse.portal",
    "fuse.gvfsd-fuse",
];

const PSEUDO_MOUNT_PREFIXES: &[&str] = &["/proc", "/sys", "/dev"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountEntry {
    pub device: String,
    pub mountpoint: String,
    pub fstype: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskIoStat {
    pub major: u32,
    pub minor: u32,
    pub name: String,
    pub sectors_read: u64,
    pub sectors_written: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskSpaceStat {
    pub total: u64,
    pub used: u64,
}

pub fn unescape_mount_path(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            let d0 = bytes[i + 1];
            let d1 = bytes[i + 2];
            let d2 = bytes[i + 3];
            if (b'0'..=b'7').contains(&d0)
                && (b'0'..=b'7').contains(&d1)
                && (b'0'..=b'7').contains(&d2)
            {
                let val = ((d0 - b'0') << 6) | ((d1 - b'0') << 3) | (d2 - b'0');
                out.push(val);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn is_virtual_fs(fstype: &str) -> bool {
    VIRTUAL_FS_TYPES.contains(&fstype)
}

fn matches_path_prefix(mountpoint: &str, prefix: &str) -> bool {
    let p = prefix.trim();
    if p.is_empty() {
        return false;
    }
    let clean = p.trim_end_matches('/');
    if clean.is_empty() {
        return mountpoint == "/";
    }
    mountpoint == clean
        || (mountpoint.starts_with(clean) && mountpoint.as_bytes().get(clean.len()) == Some(&b'/'))
}

pub fn matches_ignore_prefix(mountpoint: &str, prefixes: &[String]) -> bool {
    prefixes
        .iter()
        .any(|prefix| matches_path_prefix(mountpoint, prefix))
}

pub fn is_pseudo_mountpoint(mountpoint: &str) -> bool {
    PSEUDO_MOUNT_PREFIXES
        .iter()
        .any(|prefix| matches_path_prefix(mountpoint, prefix))
}

pub fn parse_proc_mounts(content: &str, ignore_prefixes: &[String]) -> Vec<MountEntry> {
    let mut mounts = Vec::new();
    for line in content.lines() {
        let mut cols = line.split_whitespace();
        let (Some(dev), Some(raw_mp), Some(fs_type)) = (cols.next(), cols.next(), cols.next())
        else {
            continue;
        };
        if is_virtual_fs(fs_type) {
            continue;
        }
        let mountpoint = unescape_mount_path(raw_mp);
        if is_pseudo_mountpoint(&mountpoint) || matches_ignore_prefix(&mountpoint, ignore_prefixes)
        {
            continue;
        }
        mounts.push(MountEntry {
            device: unescape_mount_path(dev),
            mountpoint,
            fstype: fs_type.to_string(),
        });
    }
    mounts
}

pub fn dedup_mounts_by_dev<F>(mounts: Vec<MountEntry>, mut get_dev: F) -> Vec<(MountEntry, u64)>
where
    F: FnMut(&str) -> Option<u64>,
{
    let mut best_by_dev: HashMap<u64, usize> = HashMap::new();
    let mut ordered: Vec<Option<(MountEntry, u64)>> = Vec::with_capacity(mounts.len());

    for mount in mounts {
        let Some(dev_id) = get_dev(&mount.mountpoint) else {
            continue;
        };
        if let Some(&existing_slot) = best_by_dev.get(&dev_id) {
            if let Some((ref existing_mount, _)) = ordered[existing_slot] {
                if mount.mountpoint.len() < existing_mount.mountpoint.len() {
                    ordered[existing_slot] = Some((mount, dev_id));
                }
            }
        } else {
            let slot = ordered.len();
            best_by_dev.insert(dev_id, slot);
            ordered.push(Some((mount, dev_id)));
        }
    }

    ordered.into_iter().flatten().collect()
}

pub fn parse_diskstats(content: &str) -> Vec<DiskIoStat> {
    let mut out = Vec::new();
    for line in content.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 14 {
            continue;
        }
        let (Ok(major), Ok(minor), Ok(sectors_read), Ok(sectors_written)) = (
            fields[0].parse::<u32>(),
            fields[1].parse::<u32>(),
            fields[5].parse::<u64>(),
            fields[9].parse::<u64>(),
        ) else {
            continue;
        };
        out.push(DiskIoStat {
            major,
            minor,
            name: fields[2].to_string(),
            sectors_read,
            sectors_written,
        });
    }
    out
}

fn strip_partition_suffix(dev_name: &str) -> &str {
    // Handles nvme0n1p1 -> nvme0n1, mmcblk0p1 -> mmcblk0, loop0p1 -> loop0
    if let Some(p_idx) = dev_name.rfind('p') {
        if p_idx > 0
            && dev_name[p_idx + 1..].chars().all(|c| c.is_ascii_digit())
            && !dev_name[p_idx + 1..].is_empty()
            && dev_name.as_bytes()[p_idx - 1].is_ascii_digit()
        {
            return &dev_name[..p_idx];
        }
    }
    // Handles vda1 -> vda, sda1 -> sda, xvda1 -> xvda
    let trimmed = dev_name.trim_end_matches(|c: char| c.is_ascii_digit());
    if trimmed.is_empty() {
        dev_name
    } else {
        trimmed
    }
}

pub fn match_disk_io<'a>(
    stats: &'a [DiskIoStat],
    major_minor: Option<(u32, u32)>,
    mount_device: &str,
) -> Option<&'a DiskIoStat> {
    if let Some((maj, min)) = major_minor {
        if let Some(found) = stats.iter().find(|s| s.major == maj && s.minor == min) {
            return Some(found);
        }
    }

    let base = mount_device.rsplit('/').next().unwrap_or(mount_device);
    if let Some(found) = stats.iter().find(|s| s.name == base) {
        return Some(found);
    }

    let parent = strip_partition_suffix(base);
    if parent != base {
        if let Some(found) = stats.iter().find(|s| s.name == parent) {
            return Some(found);
        }
    }

    None
}

#[derive(Debug, Default)]
pub struct DiskCollector {
    prev_sectors: HashMap<String, (u64, u64)>,
}

impl DiskCollector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build_metrics<FDev, FSpace>(
        &mut self,
        mounts_content: &str,
        diskstats_content: &str,
        ignore_prefixes: &[String],
        dt_sec: Option<f64>,
        get_dev: FDev,
        mut get_space: FSpace,
    ) -> Vec<DiskMetrics>
    where
        FDev: FnMut(&str) -> Option<u64>,
        FSpace: FnMut(&str) -> Option<DiskSpaceStat>,
    {
        let parsed_mounts = parse_proc_mounts(mounts_content, ignore_prefixes);
        let deduped = dedup_mounts_by_dev(parsed_mounts, get_dev);
        let diskstats = parse_diskstats(diskstats_content);

        let mut next_prev: HashMap<String, (u64, u64)> = HashMap::new();
        let mut results = Vec::new();

        for (mount, dev_id) in deduped {
            let Some(space) = get_space(&mount.mountpoint) else {
                continue;
            };
            if space.total == 0 {
                continue;
            }

            let maj_min = dev_major_minor(dev_id);
            let (r_bps, w_bps) = if let Some(io) = match_disk_io(&diskstats, maj_min, &mount.device)
            {
                next_prev.insert(io.name.clone(), (io.sectors_read, io.sectors_written));
                match (dt_sec, self.prev_sectors.get(&io.name)) {
                    (Some(dt), Some(&(prev_r, prev_w))) if dt > 0.0 => {
                        let dr = io.sectors_read.saturating_sub(prev_r).saturating_mul(512);
                        let dw = io
                            .sectors_written
                            .saturating_sub(prev_w)
                            .saturating_mul(512);
                        (
                            (dr as f64 / dt).round() as u64,
                            (dw as f64 / dt).round() as u64,
                        )
                    }
                    _ => (0, 0),
                }
            } else {
                (0, 0)
            };

            results.push(DiskMetrics {
                mp: mount.mountpoint,
                fs: mount.fstype,
                total: space.total,
                used: space.used,
                r_bps,
                w_bps,
            });
        }

        self.prev_sectors = next_prev;
        results
    }

    pub fn collect(&mut self, ignore_prefixes: &[String], dt_sec: Option<f64>) -> Vec<DiskMetrics> {
        let Ok(mounts) = fs::read_to_string("/proc/mounts") else {
            return Vec::new();
        };
        let diskstats = fs::read_to_string("/proc/diskstats").unwrap_or_default();
        self.build_metrics(
            &mounts,
            &diskstats,
            ignore_prefixes,
            dt_sec,
            platform_st_dev,
            platform_statvfs,
        )
    }
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
fn dev_major_minor(dev: u64) -> Option<(u32, u32)> {
    let d = dev as libc::dev_t;
    Some((libc::major(d) as u32, libc::minor(d) as u32))
}

#[cfg(not(unix))]
fn dev_major_minor(dev: u64) -> Option<(u32, u32)> {
    // Standard Linux st_dev encoding so unit tests can also pass Linux encoded st_dev values.
    let major = (((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff)) as u32;
    let minor = ((dev & 0xff) | ((dev >> 12) & !0xff)) as u32;
    Some((major, minor))
}

#[cfg(unix)]
fn platform_st_dev(mountpoint: &str) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(mountpoint).ok().map(|m| m.dev())
}

#[cfg(not(unix))]
fn platform_st_dev(_mountpoint: &str) -> Option<u64> {
    None
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
fn platform_statvfs(mountpoint: &str) -> Option<DiskSpaceStat> {
    let c_path = std::ffi::CString::new(mountpoint).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return None;
    }
    let block_size = if stat.f_frsize > 0 {
        stat.f_frsize as u64
    } else {
        stat.f_bsize as u64
    };
    let total = (stat.f_blocks as u64).saturating_mul(block_size);
    let free = (stat.f_bfree as u64).saturating_mul(block_size);
    let used = total.saturating_sub(free);
    Some(DiskSpaceStat { total, used })
}

#[cfg(not(unix))]
fn platform_statvfs(_mountpoint: &str) -> Option<DiskSpaceStat> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_linux_dev(major: u64, minor: u64) -> u64 {
        (minor & 0xff) | ((major & 0xfff) << 8) | ((minor & !0xff) << 12) | ((major & !0xfff) << 32)
    }

    #[test]
    fn filters_virtual_fs_and_ignore_prefixes_and_dedups_bind_mounts() {
        let mounts = "\
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
sysfs /sys sysfs rw 0 0
tmpfs /run tmpfs rw 0 0
overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0
/dev/vda1 / ext4 rw,relatime 0 0
/dev/vda1 /var/lib/docker/bind-root ext4 rw,relatime 0 0
/dev/vdb1 /mnt/data\\040vol xfs rw 0 0
/dev/loop0 /snap/core20/1234 squashfs ro 0 0
/dev/vda2 /boot/efi vfat rw 0 0
/dev/vdc1 /running ext4 rw 0 0
";
        let ignore = vec![
            "/snap".to_string(),
            "/boot/efi".to_string(),
            "/run".to_string(),
        ];

        let parsed = parse_proc_mounts(mounts, &ignore);
        let mps: Vec<&str> = parsed.iter().map(|m| m.mountpoint.as_str()).collect();
        // `/running` must NOT be excluded by `/run`!
        assert_eq!(
            mps,
            vec![
                "/",
                "/var/lib/docker/bind-root",
                "/mnt/data vol",
                "/running"
            ]
        );

        let dev_root = encode_linux_dev(253, 1);
        let dev_data = encode_linux_dev(253, 17);
        let dev_run = encode_linux_dev(253, 33);

        let deduped = dedup_mounts_by_dev(parsed, |mp| match mp {
            "/" | "/var/lib/docker/bind-root" => Some(dev_root),
            "/mnt/data vol" => Some(dev_data),
            "/running" => Some(dev_run),
            _ => None,
        });

        let dedup_mps: Vec<&str> = deduped.iter().map(|(m, _)| m.mountpoint.as_str()).collect();
        assert_eq!(dedup_mps, vec!["/", "/mnt/data vol", "/running"]);
    }

    #[test]
    fn computes_disk_throughput_from_diskstats_deltas() {
        let mounts = "/dev/vda1 / ext4 rw 0 0\n";
        let diskstats_1 = "\
 253       0 vda 100 0 1000 10 50 0 2000 5 0 15 15
 253       1 vda1 90 0 800 8 40 0 1500 4 0 12 12
";
        let diskstats_2 = "\
 253       0 vda 120 0 1200 12 60 0 2200 6 0 18 18
 253       1 vda1 100 0 840 9 45 0 1580 5 0 14 14
";
        let dev_vda1 = encode_linux_dev(253, 1);
        let mut collector = DiskCollector::new();

        let first = collector.build_metrics(
            mounts,
            diskstats_1,
            &[],
            None,
            |_| Some(dev_vda1),
            |_| {
                Some(DiskSpaceStat {
                    total: 20_000_000_000,
                    used: 6_000_000_000,
                })
            },
        );
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].r_bps, 0);
        assert_eq!(first[0].w_bps, 0);

        // +40 sectors read * 512 = 20480 bytes / 2.0s = 10240 B/s
        // +80 sectors written * 512 = 40960 bytes / 2.0s = 20480 B/s
        let second = collector.build_metrics(
            mounts,
            diskstats_2,
            &[],
            Some(2.0),
            |_| Some(dev_vda1),
            |_| {
                Some(DiskSpaceStat {
                    total: 20_000_000_000,
                    used: 6_000_000_000,
                })
            },
        );
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].mp, "/");
        assert_eq!(second[0].fs, "ext4");
        assert_eq!(second[0].r_bps, 10_240);
        assert_eq!(second[0].w_bps, 20_480);
    }

    #[test]
    fn matches_nvme_partition_fallback_when_major_minor_differs() {
        let stats = vec![DiskIoStat {
            major: 259,
            minor: 0,
            name: "nvme0n1".to_string(),
            sectors_read: 500,
            sectors_written: 900,
        }];
        let matched = match_disk_io(&stats, Some((0, 99)), "/dev/nvme0n1p1").unwrap();
        assert_eq!(matched.name, "nvme0n1");
        assert_eq!(matched.sectors_read, 500);
    }

    #[test]
    fn excludes_efivarfs_and_virtual_fs_types() {
        for fstype in [
            "efivarfs",
            "binfmt_misc",
            "rpc_pipefs",
            "ramfs",
            "drm",
            "fuse.portal",
            "fuse.gvfsd-fuse",
        ] {
            assert!(is_virtual_fs(fstype), "{fstype} should be virtual");
        }
        assert!(!is_virtual_fs("ext4"));
        assert!(!is_virtual_fs("xfs"));

        let mounts = "\
efivarfs /sys/firmware/efi/efivars efivarfs rw,nosuid,nodev,noexec,relatime 0 0
binfmt_misc /mnt/binfmt binfmt_misc rw,relatime 0 0
rpc_pipefs /var/lib/nfs/rpc_pipefs rpc_pipefs rw,relatime 0 0
ramfs /mnt/ram ramfs rw,relatime 0 0
drm /mnt/drm drm rw,relatime 0 0
portal /mnt/portal fuse.portal rw,nosuid,nodev,relatime 0 0
gvfsd-fuse /mnt/gvfs fuse.gvfsd-fuse rw,nosuid,nodev,relatime 0 0
/dev/vda1 / ext4 rw,relatime 0 0
";
        let parsed = parse_proc_mounts(mounts, &[]);
        let mps: Vec<&str> = parsed.iter().map(|m| m.mountpoint.as_str()).collect();
        assert_eq!(mps, vec!["/"]);

        let dev_root = encode_linux_dev(253, 1);
        let dev_efivars = encode_linux_dev(0, 42);
        let mut collector = DiskCollector::new();
        let metrics = collector.build_metrics(
            mounts,
            "",
            &[],
            None,
            |mp| match mp {
                "/" => Some(dev_root),
                "/sys/firmware/efi/efivars" => Some(dev_efivars),
                _ => None,
            },
            |mp| match mp {
                "/" => Some(DiskSpaceStat {
                    total: 20_000_000_000,
                    used: 5_000_000_000,
                }),
                "/sys/firmware/efi/efivars" => Some(DiskSpaceStat {
                    total: 262_144,
                    used: 128_000,
                }),
                _ => None,
            },
        );
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].mp, "/");
        assert_eq!(metrics[0].fs, "ext4");
    }

    #[test]
    fn excludes_pseudo_mountpoints_with_path_boundary_checks() {
        assert!(is_pseudo_mountpoint("/proc"));
        assert!(is_pseudo_mountpoint("/proc/sys/fs/binfmt_misc"));
        assert!(is_pseudo_mountpoint("/sys"));
        assert!(is_pseudo_mountpoint("/sys/kernel/custom"));
        assert!(is_pseudo_mountpoint("/sys/firmware/efi/efivars"));
        assert!(is_pseudo_mountpoint("/dev"));
        assert!(is_pseudo_mountpoint("/dev/shm"));

        assert!(!is_pseudo_mountpoint("/"));
        assert!(!is_pseudo_mountpoint("/system"));
        assert!(!is_pseudo_mountpoint("/dev2"));
        assert!(!is_pseudo_mountpoint("/proc2"));
        assert!(!is_pseudo_mountpoint("/data"));
        assert!(!is_pseudo_mountpoint(""));

        let mounts = "\
custom_sys /sys/kernel/custom custom_pseudo rw 0 0
custom_proc /proc/sys/fs/binfmt_misc custom_binfmt rw 0 0
custom_dev /dev/custom custom_devfs rw 0 0
/dev/sda1 /system ext4 rw,relatime 0 0
/dev/sda2 /dev2 ext4 rw,relatime 0 0
/dev/sdb1 /data xfs rw,relatime 0 0
/dev/vda1 / ext4 rw,relatime 0 0
";
        let parsed = parse_proc_mounts(mounts, &[]);
        let mps: Vec<(&str, &str)> = parsed
            .iter()
            .map(|m| (m.mountpoint.as_str(), m.fstype.as_str()))
            .collect();
        assert_eq!(
            mps,
            vec![
                ("/system", "ext4"),
                ("/dev2", "ext4"),
                ("/data", "xfs"),
                ("/", "ext4"),
            ]
        );
    }
}
