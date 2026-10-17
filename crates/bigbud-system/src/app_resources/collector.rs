use super::{
    accounting::{Process, group, has_unmeasured_children, owned},
    model::{AppResources, MAX_PROCESSES, MAX_ROOTS, Role, Root},
};
use crate::inventory::MAX_RECORDS;
use crate::rate::CounterRate;
use std::{
    collections::HashMap,
    time::{Instant, SystemTime},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Default)]
struct Baseline {
    read: CounterRate,
    written: CounterRate,
    cpu: CounterRate,
}

#[derive(Default)]
pub struct AppTracker {
    roots: Vec<Root>,
    pinned: HashMap<String, u64>,
    baselines: HashMap<(u32, u64), Baseline>,
    generation: u64,
    latest: Option<AppResources>,
}

impl AppTracker {
    /// Replaces only a bounded registry supplied by the trusted lifecycle owner.
    pub fn set_roots(&mut self, mut roots: Vec<Root>) -> bool {
        roots.sort_by_key(|root| root.pid);
        roots.dedup_by_key(|root| root.pid);
        roots.truncate(MAX_ROOTS);
        if roots != self.roots {
            self.generation = self.generation.wrapping_add(1);
            self.pinned
                .retain(|id, _| roots.iter().any(|root| root.identity == *id));
            self.baselines.clear();
            self.latest = None;
            self.roots = roots;
            return true;
        }
        false
    }

    pub fn reset(&mut self) {
        self.baselines.clear();
        self.latest = None;
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn latest(&self) -> Option<AppResources> {
        self.latest.clone()
    }

    /// Reuses the host collector's retained sysinfo state and full-refresh pass if present.
    pub fn sample(&mut self, system: &mut System, refreshed: bool, now: Instant, at: SystemTime) {
        if !refreshed {
            let _updated = system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
        }
        let inventory: HashMap<_, _> = system
            .processes()
            .iter()
            .take(MAX_RECORDS)
            .map(|(pid, p)| {
                (
                    pid.as_u32(),
                    Process {
                        pid: pid.as_u32(),
                        parent: p.parent().map(|p| p.as_u32()),
                        start: p.start_time(),
                        cpu: None,
                        memory: 0,
                        read: None,
                        written: None,
                    },
                )
            })
            .collect();
        let roles = owned(&inventory, &self.roots, &mut self.pinned);
        let missing = self.roots.iter().any(|root| !roles.contains_key(&root.pid));
        let incomplete = missing
            || self.roots.is_empty()
            || roles.len() > MAX_PROCESSES
            || has_unmeasured_children(&inventory, &roles)
            || system.processes().len() > MAX_RECORDS;
        let mut pids: Vec<_> = roles.keys().copied().collect();
        pids.sort_unstable();
        pids.truncate(MAX_PROCESSES);
        if !refreshed {
            let ids: Vec<_> = pids.iter().copied().map(Pid::from_u32).collect();
            let _updated = system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&ids),
                true,
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .with_disk_usage(),
            );
        }
        let mut rows = Vec::new();
        let mut keys = Vec::new();
        let mut incomplete = incomplete;
        for pid in pids {
            let Some(process) = system.process(Pid::from_u32(pid)) else {
                incomplete = true;
                continue;
            };
            if inventory
                .get(&pid)
                .is_none_or(|old| old.start != process.start_time())
            {
                incomplete = true;
                continue;
            }
            let key = (pid, process.start_time());
            keys.push(key);
            let baseline = self.baselines.entry(key).or_default();
            let disk = process.disk_usage();
            let row = Process {
                pid,
                parent: process.parent().map(|p| p.as_u32()),
                start: process.start_time(),
                cpu: baseline
                    .cpu
                    .sample(process.accumulated_cpu_time(), now)
                    .map(|milliseconds_per_second| milliseconds_per_second / 10.0),
                memory: process.memory(),
                read: baseline.read.sample(disk.total_read_bytes, now),
                written: baseline.written.sample(disk.total_written_bytes, now),
            };
            if let Some(role) = roles.get(&pid) {
                rows.push((*role, row));
            }
        }
        self.baselines.retain(|key, _| keys.contains(key));
        let cores = system.cpus().len();
        let groups = [Role::Desktop, Role::Backend, Role::Native, Role::Tools]
            .into_iter()
            .map(|role| {
                group(
                    role,
                    rows.iter().filter(|(r, _)| *r == role).map(|(_, p)| p),
                    cores,
                    at,
                    incomplete,
                )
            })
            .collect();
        self.latest = Some(AppResources {
            generation: self.generation,
            sampled_at: at,
            incomplete,
            core: group(
                Role::Desktop,
                rows.iter()
                    .filter(|(r, _)| *r != Role::Tools)
                    .map(|(_, p)| p),
                cores,
                at,
                incomplete,
            ),
            inclusive: group(
                Role::Tools,
                rows.iter().map(|(_, p)| p),
                cores,
                at,
                incomplete,
            ),
            groups,
        });
    }
}
