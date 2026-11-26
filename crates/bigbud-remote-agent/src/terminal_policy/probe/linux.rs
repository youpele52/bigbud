//! Linux process facts from `/proc`.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;

pub(super) use super::unix::{foreground_group, process_group};

pub(super) fn executable(pid: i32) -> io::Result<PathBuf> {
    if pid <= 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"));
    }
    fs::read_link(format!("/proc/{pid}/exe"))
}

/// One `/proc/*/stat` pass, then a breadth-first sum per root.
pub(super) fn tree_rss(roots: &[i32]) -> Vec<Option<u64>> {
    let table = process_table();
    roots
        .iter()
        .map(|root| super::sum_tree(*root, &table))
        .collect()
}

fn process_table() -> HashMap<i32, (i32, u64)> {
    let page = page_size();
    let mut table = HashMap::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return table;
    };
    for entry in entries.filter_map(Result::ok) {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        // Processes exit during the scan; a vanished entry is simply skipped.
        if let Ok(stat) = fs::read_to_string(entry.path().join("stat"))
            && let Some((ppid, rss_pages)) = parse_stat(&stat)
        {
            table.insert(pid, (ppid, rss_pages.saturating_mul(page)));
        }
    }
    table
}

/// `pid (comm) state ppid … rss …`: fields after the last `)` start at field 3; `ppid` is
/// field 4 and `rss` (pages) field 24.
pub(super) fn parse_stat(stat: &str) -> Option<(i32, u64)> {
    let (_, rest) = stat.rsplit_once(')')?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let ppid = fields.get(1)?.parse().ok()?;
    let rss = fields.get(21)?.parse().ok()?;
    Some((ppid, rss))
}

fn page_size() -> u64 {
    // SAFETY: sysconf has no memory-safety preconditions.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(size)
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(4096)
}
