use super::identity::namespace;
use super::test_support::*;
use super::*;

#[test]
fn owner_intent_is_written_with_epoch_and_exact_identity() {
    let root = Root::new();
    let retirement = Retirement::open(&root.lock(), [9; 32], false).unwrap();
    let record = retirement.read(INTENT_FILE).unwrap().unwrap();
    assert_eq!(record.epoch, hex(&[9; 32]));
    assert_eq!(record.kind, None);
    assert_eq!(record.state, State::Bound);
    assert_eq!(record.pid, std::process::id());
    assert!(record.start > 0);
    assert_eq!(record.namespace, namespace());
    retirement.clear_owner();
    assert!(!root.0.join(INTENT_FILE).exists());
}

#[test]
fn unresolved_intent_refuses_before_any_new_record_is_written() {
    let root = Root::new();
    root.send(
        INTENT_FILE,
        &Record {
            epoch: hex(&[1; 32]),
            kind: None,
            state: State::Intent,
            pid: 0,
            start: 0,
            namespace: None,
        },
    );
    assert!(matches!(
        Retirement::open(&root.lock(), [2; 32], false),
        Err(UNVERIFIED)
    ));
    assert_eq!(
        root.retirement(false).read(INTENT_FILE).unwrap(),
        Some(Record {
            epoch: hex(&[1; 32]),
            kind: None,
            state: State::Intent,
            pid: 0,
            start: 0,
            namespace: None,
        })
    );
}

#[test]
fn pid_reuse_is_rejected_by_start_time_and_pid_only_is_unverifiable() {
    let root = Root::new();
    let mut child = sleep("5");
    let identity = read_identity(child.id()).unwrap();
    let mut record = child_record(Kind::Master, identity, &hex(&[3; 32]));
    record.start += 1;
    root.send(INTENT_FILE, &gone_owner(&hex(&[3; 32])));
    root.send(&child_name(Kind::Master, SLOT), &record);
    assert!(matches!(
        root.retirement(false).reconcile(),
        Err(UNVERIFIED)
    ));
    assert!(read_identity(child.id()).is_some());

    record.start = 0;
    assert_eq!(parse(&encode(&record)), Err(UNVERIFIED));
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn namespace_mismatch_refuses_and_is_never_adopted() {
    let root = Root::new();
    let mut child = sleep("5");
    let identity = read_identity(child.id()).unwrap();
    let mut record = child_record(Kind::Master, identity, &hex(&[4; 32]));
    record.namespace = Some(identity.namespace.unwrap_or(0) ^ 1);
    root.send(INTENT_FILE, &gone_owner(&hex(&[4; 32])));
    root.send(&child_name(Kind::Master, SLOT), &record);
    assert!(matches!(
        root.retirement(false).reconcile(),
        Err(UNVERIFIED)
    ));
    assert!(read_identity(child.id()).is_some());
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn exact_live_instance_is_refused_without_signalling_when_retirement_is_off() {
    let root = Root::new();
    let pid = orphan_sleep();
    let _guard = Pid(pid);
    let identity = read_identity(pid).unwrap();
    root.send(INTENT_FILE, &gone_owner(&hex(&[5; 32])));
    root.send(
        &child_name(Kind::Master, SLOT),
        &child_record(Kind::Master, identity, &hex(&[5; 32])),
    );
    assert!(matches!(
        root.retirement(false).reconcile(),
        Err(UNVERIFIED)
    ));
    std::thread::sleep(Duration::from_millis(50));
    assert!(read_identity(pid).is_some());
    assert!(root.0.join(child_name(Kind::Master, SLOT)).exists());
}

#[test]
fn verified_gone_record_is_cleared_without_touching_anything_else() {
    let root = Root::new();
    let mut child = sleep("5");
    let identity = read_identity(child.id()).unwrap();
    let _ = child.kill();
    let _ = child.wait();
    let name = child_name(Kind::Master, SLOT);
    root.send(INTENT_FILE, &gone_owner(&hex(&[6; 32])));
    root.send(&name, &child_record(Kind::Master, identity, &hex(&[6; 32])));
    assert!(root.retirement(false).reconcile().is_ok());
    assert!(!root.0.join(&name).exists());
    assert!(!root.0.join(INTENT_FILE).exists());
}

#[test]
fn enabled_retirement_signals_only_the_exact_instance_and_clears_after_exit() {
    let root = Root::new();
    let pid = orphan_sleep();
    let _guard = Pid(pid);
    let identity = read_identity(pid).unwrap();
    let name = child_name(Kind::Master, SLOT);
    root.send(INTENT_FILE, &gone_owner(&hex(&[8; 32])));
    root.send(&name, &child_record(Kind::Master, identity, &hex(&[8; 32])));
    assert!(root.retirement(true).reconcile().is_ok());
    assert!(read_identity(pid).is_none());
    assert!(!root.0.join(&name).exists());
}

#[test]
fn child_intent_is_written_before_spawn_and_completed_only_by_bind() {
    let root = Root::new();
    let retirement = root.retirement(false);
    let instance = retirement.begin(Kind::Master).unwrap();
    let intent = retirement.read(instance.name()).unwrap().unwrap();
    assert_eq!(intent.state, State::Intent);
    assert_eq!((intent.pid, intent.start, intent.namespace), (0, 0, None));

    let mut child = sleep("5");
    retirement.bind(&instance, child.id()).unwrap();
    let bound = retirement.read(instance.name()).unwrap().unwrap();
    assert_eq!(bound.state, State::Bound);
    assert_eq!(bound.pid, child.id());
    assert!(bound.start > 0);
    retirement.clear(&instance).unwrap();
    assert!(!root.0.join(instance.name()).exists());
    let _ = child.kill();
    let _ = child.wait();
}

/// B1 regression: two same-kind instances must coexist. Before per-instance
/// records, the second `begin` found the first intent and refused at leg 2.
#[test]
fn same_kind_instances_are_independent_and_each_is_cleared_on_reap() {
    let root = Root::new();
    let retirement = root.retirement(false);
    let first = retirement.begin(Kind::Master).unwrap();
    let second = retirement.begin(Kind::Master).unwrap();
    assert_ne!(first.name(), second.name());
    assert!(root.0.join(first.name()).exists());
    assert!(root.0.join(second.name()).exists());

    let mut first_child = sleep("5");
    let mut second_child = sleep("5");
    retirement.bind(&first, first_child.id()).unwrap();
    retirement.bind(&second, second_child.id()).unwrap();
    assert!(root.retirement(false).reconcile().is_err());
    retirement.clear(&first).unwrap();
    assert!(!root.0.join(first.name()).exists());
    assert!(root.0.join(second.name()).exists());
    retirement.clear(&second).unwrap();
    assert!(!root.0.join(second.name()).exists());
    let _ = first_child.kill();
    let _ = first_child.wait();
    let _ = second_child.kill();
    let _ = second_child.wait();
}

#[test]
fn four_jump_legs_are_each_reconciled_and_cleared() {
    let root = Root::new();
    let retirement = root.retirement(false);
    let mut instances = Vec::new();
    let mut children = Vec::new();
    for _ in 0..4 {
        let instance = retirement.begin(Kind::Master).unwrap();
        let child = sleep("5");
        retirement.bind(&instance, child.id()).unwrap();
        instances.push(instance);
        children.push(child);
    }
    // Every leg is a separate record, and all live legs refuse together.
    assert!(matches!(
        root.retirement(false).reconcile(),
        Err(UNVERIFIED)
    ));
    for instance in &instances {
        assert!(root.0.join(instance.name()).exists());
    }
    // Reap and clear each leg individually.
    for (instance, child) in instances.iter().zip(children.iter_mut()) {
        let _ = child.kill();
        let _ = child.wait();
        retirement.clear(instance).unwrap();
        assert!(!root.0.join(instance.name()).exists());
    }
    assert!(root.retirement(false).reconcile().is_ok());
}

#[test]
fn child_intent_without_identity_is_never_treated_as_bound() {
    let record = Record {
        epoch: hex(&[1; 32]),
        kind: Some(Kind::Master),
        state: State::Intent,
        pid: 0,
        start: 0,
        namespace: None,
    };
    let parsed = parse(&encode(&record)).unwrap();
    assert_eq!(parsed, record);
    assert_eq!(observe(&parsed), Err(UNVERIFIED));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_pid_and_start_without_a_namespace_is_rejected() {
    let mut child = sleep("5");
    let identity = read_identity(child.id()).unwrap();
    let record = Record {
        epoch: hex(&[1; 32]),
        kind: Some(Kind::Master),
        state: State::Bound,
        pid: identity.pid,
        start: identity.start,
        namespace: None,
    };
    assert_eq!(observe(&record), Err(UNVERIFIED));
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn retire_exact_rejects_a_mismatched_instance_without_signalling() {
    let mut child = sleep("5");
    let identity = read_identity(child.id()).unwrap();
    let mut record = child_record(Kind::Master, identity, &hex(&[0x0d; 32]));
    record.start += 1;
    assert_eq!(retire_exact(&record), Err(UNVERIFIED));
    assert!(read_identity(child.id()).is_some());
    let _ = child.kill();
    let _ = child.wait();
}
