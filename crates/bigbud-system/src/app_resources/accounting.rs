use super::model::{Group, Role, Root};
use crate::model::{Availability, Field};
use std::{
    collections::{HashMap, HashSet},
    time::SystemTime,
};

#[derive(Clone, Debug)]
pub(super) struct Process {
    pub pid: u32,
    pub parent: Option<u32>,
    pub start: u64,
    pub cpu: Option<f64>,
    pub memory: u64,
    pub read: Option<f64>,
    pub written: Option<f64>,
}

/// Explicit registered roots take priority over inherited tool ownership.
pub(super) fn owned(
    processes: &HashMap<u32, Process>,
    roots: &[Root],
    pinned: &mut HashMap<String, u64>,
) -> HashMap<u32, Role> {
    let mut roles = HashMap::new();
    for root in roots {
        if let Some(process) = processes.get(&root.pid) {
            if process.start == 0 {
                continue;
            }
            let start = pinned
                .entry(root.identity.clone())
                .or_insert(root.start_time_seconds.unwrap_or(process.start));
            if *start == process.start {
                roles.insert(root.pid, root.role);
            }
        }
    }
    let explicit = roles.clone();
    for process in processes.values() {
        if explicit.contains_key(&process.pid) {
            continue;
        }
        let mut child = process;
        let mut cursor = process.parent;
        let mut seen = HashSet::new();
        for _ in 0..64 {
            let Some(pid) = cursor else {
                break;
            };
            if !seen.insert(pid) {
                break;
            }
            let Some(parent) = processes.get(&pid) else {
                break;
            };
            // A newer process cannot be the original parent of this child after PID reuse.
            if parent.start == 0 || child.start == 0 || parent.start > child.start {
                break;
            }
            if explicit.contains_key(&pid) {
                roles.insert(process.pid, Role::Tools);
                break;
            }
            child = parent;
            cursor = parent.parent;
        }
    }
    roles
}

pub(super) fn group<'a>(
    role: Role,
    processes: impl Iterator<Item = &'a Process>,
    cores: usize,
    at: SystemTime,
    incomplete: bool,
) -> Group {
    let mut count = 0;
    let mut cpu = Some(0.0);
    let mut memory = Some(0u64);
    let mut read = Some(0.0);
    let mut written = Some(0.0);
    for process in processes {
        count += 1;
        cpu = cpu.zip(process.cpu).map(|(a, b)| a + b);
        memory = memory.and_then(|a| a.checked_add(process.memory));
        read = read.zip(process.read).map(|(a, b)| a + b);
        written = written.zip(process.written).map(|(a, b)| a + b);
    }
    let status = if incomplete {
        Availability::Unavailable
    } else {
        Availability::Warming
    };
    let numeric = |value: Option<f64>| match value.filter(|v| v.is_finite()) {
        Some(value) if !incomplete => Field::ready(value, at),
        _ => Field::absent(status, at),
    };
    Group {
        role,
        process_count: count,
        cpu_percent: numeric(
            cpu.filter(|_| cores > 0)
                .map(|v| (v / cores as f64).clamp(0.0, 100.0)),
        ),
        resident_bytes: match memory {
            Some(value) if !incomplete => Field::ready(value, at),
            _ => Field::absent(Availability::Unavailable, at),
        },
        read_bytes_per_second: numeric(read),
        written_bytes_per_second: numeric(written),
    }
}

/// Detects owned branches stopped by the ancestry limit or an unavailable child identity.
pub(super) fn has_unmeasured_children(
    processes: &HashMap<u32, Process>,
    roles: &HashMap<u32, Role>,
) -> bool {
    processes.values().any(|child| {
        !roles.contains_key(&child.pid)
            && child.parent.is_some_and(|pid| {
                roles.contains_key(&pid)
                    && processes
                        .get(&pid)
                        .is_some_and(|parent| child.start == 0 || parent.start <= child.start)
            })
    })
}
