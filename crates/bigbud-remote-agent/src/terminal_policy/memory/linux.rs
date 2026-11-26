//! Linux memory signals: PSI, `/proc/meminfo`, `/proc/self/statm` and cgroup v2 limits found
//! through `/proc/self/cgroup` and the `cgroup2` mount. Every path is read below `root`, so
//! tests run against fixture directories.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::terminal_policy::pressure::MemorySample;

const MAX_CGROUP_DEPTH: usize = 64;
const DEFAULT_CGROUP_MOUNT: &str = "/sys/fs/cgroup";

#[derive(Debug, Clone)]
pub struct LinuxMemorySource {
    root: PathBuf,
    page_size: u64,
}

impl LinuxMemorySource {
    /// Reads the live system.
    pub fn new() -> Self {
        Self::with_root("/", system_page_size())
    }

    /// Reads `root/proc/...` and `root/<cgroup mount>/...` instead of the live system.
    pub fn with_root(root: impl Into<PathBuf>, page_size: u64) -> Self {
        Self {
            root: root.into(),
            page_size,
        }
    }

    pub fn sample(&self) -> MemorySample {
        let meminfo = self.read("proc/meminfo");
        let mut available = meminfo
            .as_deref()
            .and_then(|text| meminfo_bytes(text, "MemAvailable"));
        let mut total = meminfo
            .as_deref()
            .and_then(|text| meminfo_bytes(text, "MemTotal"));
        let mut psi = self
            .read("proc/pressure/memory")
            .as_deref()
            .and_then(psi_some_avg10);
        if let Some(leaf) = self.cgroup_dir() {
            if let Some(cgroup_psi) = read_path(&leaf.join("memory.pressure"))
                .as_deref()
                .and_then(psi_some_avg10)
            {
                psi = Some(cgroup_psi);
            }
            let (limit, headroom) = self.cgroup_limit(&leaf).unwrap_or((None, None));
            if let Some(limit) = limit {
                total = Some(total.map_or(limit, |total| total.min(limit)));
            }
            if let Some(headroom) = headroom {
                available = Some(available.map_or(headroom, |available| available.min(headroom)));
            }
        }
        let host_rss = self
            .read("proc/self/statm")
            .and_then(|statm| statm.split_whitespace().nth(1)?.parse::<u64>().ok())
            .map(|pages| pages.saturating_mul(self.page_size));
        MemorySample {
            psi_some_avg10: psi,
            available_bytes: available,
            total_bytes: total,
            host_rss_bytes: host_rss,
            ..MemorySample::default()
        }
    }

    fn read(&self, relative: &str) -> Option<String> {
        read_path(&self.root.join(relative))
    }

    fn cgroup_mount(&self) -> Option<PathBuf> {
        let mount = self
            .read("proc/self/mountinfo")
            .and_then(|text| {
                text.lines().find_map(|line| {
                    let (fields, filesystem) = line.split_once(" - ")?;
                    (filesystem.split_whitespace().next()? == "cgroup2")
                        .then(|| fields.split_whitespace().nth(4).map(str::to_owned))
                        .flatten()
                })
            })
            .unwrap_or_else(|| DEFAULT_CGROUP_MOUNT.to_owned());
        Some(self.root.join(relative_path(&mount)?))
    }

    /// The process's cgroup v2 directory (`0::<path>`), if it exists.
    fn cgroup_dir(&self) -> Option<PathBuf> {
        let path = self
            .read("proc/self/cgroup")?
            .lines()
            .find_map(|line| line.strip_prefix("0::").map(str::to_owned))?;
        let dir = self.cgroup_mount()?.join(relative_path(&path)?);
        dir.is_dir().then_some(dir)
    }

    /// The tightest finite `memory.max` from the leaf up to the mount, and the smallest
    /// `memory.max − memory.current` headroom along the way.
    fn cgroup_limit(&self, leaf: &Path) -> Option<(Option<u64>, Option<u64>)> {
        let mount = self.cgroup_mount()?;
        let (mut limit, mut headroom) = (None::<u64>, None::<u64>);
        let mut dir = Some(leaf);
        for _ in 0..MAX_CGROUP_DEPTH {
            let Some(current_dir) = dir else { break };
            if let Some(max) = read_path(&current_dir.join("memory.max"))
                .and_then(|text| text.trim().parse::<u64>().ok())
            {
                limit = Some(limit.map_or(max, |limit| limit.min(max)));
                let used = read_path(&current_dir.join("memory.current"))
                    .and_then(|text| text.trim().parse::<u64>().ok())
                    .unwrap_or(0);
                let room = max.saturating_sub(used);
                headroom = Some(headroom.map_or(room, |headroom| headroom.min(room)));
            }
            if current_dir == mount {
                break;
            }
            dir = current_dir
                .parent()
                .filter(|parent| parent.starts_with(&mount));
        }
        Some((limit, headroom))
    }
}

impl Default for LinuxMemorySource {
    fn default() -> Self {
        Self::new()
    }
}

fn read_path(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// A cgroup path as a relative path with no `..`, so it cannot escape the mount.
fn relative_path(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(relative)
}

/// `some avg10=1.23 avg60=… avg300=… total=…`
pub(super) fn psi_some_avg10(text: &str) -> Option<f64> {
    let line = text.lines().find(|line| line.starts_with("some "))?;
    line.split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

/// `MemAvailable:   123456 kB` in bytes.
pub(super) fn meminfo_bytes(text: &str, key: &str) -> Option<u64> {
    let line = text
        .lines()
        .find(|line| line.split(':').next() == Some(key))?;
    let kib = line.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    Some(kib.saturating_mul(1024))
}

fn system_page_size() -> u64 {
    #[cfg(unix)]
    {
        // SAFETY: sysconf has no memory-safety preconditions.
        let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if let Ok(size) = u64::try_from(size)
            && size > 0
        {
            return size;
        }
    }
    4096
}
