use super::mapping;
use crate::monitor_v1 as v1;
use bigbud_system::app_resources::{AppResources, Group, Role, Root};
use std::collections::HashSet;
use std::time::UNIX_EPOCH;

pub(super) fn roots(
    demand: &Option<v1::Demand>,
    minor: u32,
) -> Result<Option<Vec<Root>>, &'static str> {
    let Some(demand) = demand.as_ref().filter(|d| d.app_resources) else {
        return Ok(None);
    };
    if minor < 3 {
        return Err("bigbud monitoring requires protocol 1.3");
    }
    if demand.app_roots.is_empty() || demand.app_roots.len() > 128 {
        return Err("invalid app root count");
    }
    let mut pids = HashSet::new();
    let mut identities = HashSet::new();
    let mut roots = Vec::new();
    for root in &demand.app_roots {
        if root.pid == 0
            || root.identity.is_empty()
            || root.identity.len() > 128
            || root.start_time_seconds == Some(0)
            || !pids.insert(root.pid)
            || !identities.insert(&root.identity)
        {
            return Err("invalid app root identity");
        }
        let role = match root.role.as_str() {
            "desktop" => Role::Desktop,
            "backend" => Role::Backend,
            "native" => Role::Native,
            _ => return Err("invalid app root role"),
        };
        roots.push(Root {
            pid: root.pid,
            identity: root.identity.clone(),
            start_time_seconds: root.start_time_seconds,
            role,
        });
    }
    Ok(Some(roots))
}

fn group(value: &Group) -> v1::AppGroup {
    v1::AppGroup {
        role: value.role.as_str().into(),
        process_count: value.process_count,
        cpu_percent: Some(mapping::metric(&value.cpu_percent)),
        resident_bytes: Some(mapping::bytes(&value.resident_bytes)),
        read_bytes_per_second: Some(mapping::metric(&value.read_bytes_per_second)),
        written_bytes_per_second: Some(mapping::metric(&value.written_bytes_per_second)),
    }
}

pub(super) fn snapshot(value: &AppResources) -> v1::AppResources {
    v1::AppResources {
        generation: value.generation,
        sampled_at_ms: value
            .sampled_at
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64),
        incomplete: value.incomplete,
        core: Some(group(&value.core)),
        inclusive: Some(group(&value.inclusive)),
        groups: value.groups.iter().map(group).collect(),
    }
}
