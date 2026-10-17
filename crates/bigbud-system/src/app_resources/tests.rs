use super::{
    accounting::{Process, group, has_unmeasured_children, owned},
    model::{Role, Root},
};
use crate::model::Availability;
use std::{collections::HashMap, time::SystemTime};

fn process(pid: u32, parent: Option<u32>, start: u64) -> Process {
    Process {
        pid,
        parent,
        start,
        cpu: Some(20.0),
        memory: 100,
        read: Some(4.0),
        written: Some(8.0),
    }
}
fn root(pid: u32, role: Role) -> Root {
    Root {
        pid,
        identity: format!("root:{pid}"),
        start_time_seconds: None,
        role,
    }
}

#[test]
fn explicit_core_roles_override_tool_ancestry_and_unrelated_names_do_not_count() {
    let rows = HashMap::from([
        (1, process(1, None, 10)),
        (2, process(2, Some(1), 11)),
        (3, process(3, Some(2), 12)),
        (4, process(4, Some(1), 13)),
        (5, process(5, None, 14)),
    ]);
    let roots = vec![
        root(1, Role::Desktop),
        root(2, Role::Backend),
        root(4, Role::Native),
    ];
    let roles = owned(&rows, &roots, &mut HashMap::new());
    assert_eq!(roles.get(&1), Some(&Role::Desktop));
    assert_eq!(roles.get(&2), Some(&Role::Backend));
    assert_eq!(roles.get(&3), Some(&Role::Tools));
    assert_eq!(roles.get(&4), Some(&Role::Native));
    assert!(!roles.contains_key(&5));
    let core = group(
        Role::Desktop,
        rows.values()
            .filter(|p| roles.get(&p.pid).is_some_and(|r| *r != Role::Tools)),
        10,
        SystemTime::UNIX_EPOCH,
        false,
    );
    let inclusive = group(
        Role::Tools,
        rows.values().filter(|p| roles.contains_key(&p.pid)),
        10,
        SystemTime::UNIX_EPOCH,
        false,
    );
    assert_eq!(core.process_count, 3);
    assert_eq!(core.resident_bytes.value, Some(300));
    assert_eq!(core.cpu_percent.value, Some(6.0));
    assert_eq!(inclusive.resident_bytes.value, Some(400));
    assert_eq!(inclusive.cpu_percent.value, Some(8.0));
}

#[test]
fn newer_reused_parent_cannot_claim_an_older_child_and_native_children_are_tools() {
    let rows = HashMap::from([
        (1, process(1, None, 20)),
        (2, process(2, Some(1), 10)),
        (3, process(3, Some(1), 21)),
    ]);
    let roles = owned(&rows, &[root(1, Role::Native)], &mut HashMap::new());
    assert!(!roles.contains_key(&2));
    assert_eq!(roles.get(&3), Some(&Role::Tools));
    assert!(!has_unmeasured_children(&rows, &roles));
}

#[test]
fn pid_reuse_cannot_steal_registered_root_or_descendants() {
    let roots = vec![root(1, Role::Backend)];
    let mut pinned = HashMap::new();
    assert_eq!(
        owned(
            &HashMap::from([(1, process(1, None, 10))]),
            &roots,
            &mut pinned
        )
        .len(),
        1
    );
    let reused = HashMap::from([(1, process(1, None, 20)), (2, process(2, Some(1), 21))]);
    assert!(owned(&reused, &roots, &mut pinned).is_empty());
    assert!(owned(&HashMap::new(), &roots, &mut pinned).is_empty());
    assert!(owned(&reused, &roots, &mut pinned).is_empty());
}

#[test]
fn supplied_start_time_is_checked_and_cycles_are_bounded() {
    let mut expected = root(1, Role::Desktop);
    expected.start_time_seconds = Some(9);
    let rows = HashMap::from([
        (1, process(1, None, 10)),
        (2, process(2, Some(3), 11)),
        (3, process(3, Some(2), 12)),
    ]);
    assert!(owned(&rows, &[expected], &mut HashMap::new()).is_empty());
}

#[test]
fn warming_missing_and_partial_are_not_presented_as_zero() {
    let mut p = process(1, None, 10);
    p.cpu = None;
    p.read = None;
    let warm = group(
        Role::Desktop,
        [&p].into_iter(),
        8,
        SystemTime::UNIX_EPOCH,
        false,
    );
    assert_eq!(warm.cpu_percent.status, Availability::Warming);
    assert_eq!(warm.cpu_percent.value, None);
    assert_eq!(warm.resident_bytes.value, Some(100));
    let partial = group(
        Role::Desktop,
        [&p].into_iter(),
        8,
        SystemTime::UNIX_EPOCH,
        true,
    );
    assert_eq!(partial.resident_bytes.status, Availability::Unavailable);
    assert_eq!(partial.cpu_percent.value, None);
    let no_cores = group(
        Role::Desktop,
        [&p].into_iter(),
        0,
        SystemTime::UNIX_EPOCH,
        false,
    );
    assert_eq!(no_cores.cpu_percent.value, None);
}

#[test]
fn live_owned_process_is_sampled_without_host_process_demand() {
    use crate::collector::{Collector, Demand};
    let mut collector = Collector::new();
    assert!(collector.set_app_roots(vec![root(std::process::id(), Role::Desktop)]));
    let demand = Demand {
        app_resources: true,
        ..Default::default()
    };
    let (snapshot, inventory) = collector.sample(demand, std::time::Instant::now());
    assert!(inventory.is_none());
    let app = snapshot.app_resources.unwrap();
    assert!(!app.incomplete);
    assert!(app.core.process_count >= 1);
    assert_eq!(app.core.cpu_percent.status, Availability::Warming);
    assert!(app.core.resident_bytes.value.is_some_and(|v| v > 0));
}

#[test]
fn ancestry_depth_is_bounded_and_empty_groups_have_real_zeroes() {
    let rows: HashMap<_, _> = (1..=66)
        .map(|pid| (pid, process(pid, (pid > 1).then_some(pid - 1), 10)))
        .collect();
    let roles = owned(&rows, &[root(1, Role::Desktop)], &mut HashMap::new());
    assert!(roles.contains_key(&65));
    assert!(!roles.contains_key(&66));
    assert!(has_unmeasured_children(&rows, &roles));
    let empty = group(
        Role::Backend,
        std::iter::empty(),
        8,
        SystemTime::UNIX_EPOCH,
        false,
    );
    assert_eq!(empty.cpu_percent.value, Some(0.0));
    assert_eq!(empty.resident_bytes.value, Some(0));
}

#[test]
fn roots_deduplicate_and_registry_changes_restart_only_app_baselines() {
    use crate::collector::{Collector, Demand};
    use std::time::{Duration, Instant};
    let mut collector = Collector::new();
    let registered = root(std::process::id(), Role::Desktop);
    assert!(collector.set_app_roots(vec![registered.clone(), registered.clone()]));
    let now = Instant::now();
    let demand = Demand {
        app_resources: true,
        ..Default::default()
    };
    let first = collector.sample(demand, now).0.app_resources.unwrap();
    assert_eq!(first.core.process_count, 1);
    assert!(!collector.set_app_roots(vec![registered]));
    let second = collector
        .sample(demand, now + Duration::from_secs(5))
        .0
        .app_resources
        .unwrap();
    assert_eq!(second.generation, first.generation);
    assert_eq!(second.core.cpu_percent.status, Availability::Ready);
    let mut restarted = root(std::process::id(), Role::Desktop);
    restarted.identity = "new-handle".into();
    assert!(collector.set_app_roots(vec![restarted]));
    let third = collector
        .sample(demand, now + Duration::from_secs(6))
        .0
        .app_resources
        .unwrap();
    assert_ne!(third.generation, first.generation);
    assert_eq!(third.core.cpu_percent.status, Availability::Warming);
    assert!(collector.set_app_roots(vec![root(u32::MAX, Role::Backend)]));
    let missing = collector
        .sample(demand, now + Duration::from_secs(7))
        .0
        .app_resources
        .unwrap();
    assert!(missing.incomplete);
    assert_eq!(
        missing.core.resident_bytes.status,
        Availability::Unavailable
    );
    assert_eq!(missing.core.resident_bytes.value, None);
}
