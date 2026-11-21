//! `ProcessProbe`: PTY foreground state and process-tree memory (plan §8.5, §8.6).

mod foreground;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod unsupported;

#[cfg(target_os = "linux")]
use linux as sys;
#[cfg(target_os = "macos")]
use macos as sys;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use unsupported as sys;

use std::collections::HashMap;

pub use foreground::{
    ForegroundReason, ProbeSource, ProcessProbe, SHELL_NAMES, SystemProbe, is_shell_executable,
};

/// Bound on one tree walk; a PTY tree beyond this is summed partially.
const MAX_TREE_PROCESSES: usize = 4096;

/// Sums `root` and its descendants in a `pid -> (ppid, rss)` table; `None` if `root` is gone.
fn sum_tree(root: i32, table: &HashMap<i32, (i32, u64)>) -> Option<u64> {
    let (_, root_rss) = table.get(&root)?;
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, (parent, _)) in table {
        if pid != parent {
            children.entry(*parent).or_default().push(*pid);
        }
    }
    let mut total = *root_rss;
    let mut frontier = vec![root];
    let mut visited = 1usize;
    while let Some(pid) = frontier.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if visited >= MAX_TREE_PROCESSES {
                return Some(total);
            }
            visited += 1;
            total = total.saturating_add(table.get(child).map_or(0, |(_, rss)| *rss));
            frontier.push(*child);
        }
    }
    Some(total)
}

#[cfg(test)]
#[path = "probe.tests.rs"]
mod probe_tests;
#[cfg(test)]
#[path = "pty.fixture.tests.rs"]
mod pty_fixture;
#[cfg(test)]
#[path = "pty.tests.rs"]
mod pty_tests;
