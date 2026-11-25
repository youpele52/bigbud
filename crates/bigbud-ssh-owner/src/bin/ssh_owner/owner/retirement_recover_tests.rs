use super::identity::namespace;
use super::recover::{Recovered, recover};
use super::test_support::*;
use super::*;
use std::fs;

#[test]
fn auto_retire_requires_both_the_switch_and_a_disposable_fixture() {
    assert!(auto_retire_enabled(true, true));
    assert!(!auto_retire_enabled(true, false));
    assert!(!auto_retire_enabled(false, true));
    // A normal profile with a live exact record still refuses and never signals.
    let root = Root::new();
    let pid = orphan_sleep();
    let _guard = Pid(pid);
    let identity = read_identity(pid).unwrap();
    root.send(INTENT_FILE, &gone_owner(&hex(&[9; 32])));
    root.send(
        &child_name(Kind::Master, SLOT),
        &child_record(Kind::Master, identity, &hex(&[9; 32])),
    );
    assert!(matches!(
        root.retirement(auto_retire_enabled(true, false))
            .reconcile(),
        Err(UNVERIFIED)
    ));
    assert!(read_identity(pid).is_some());
    // The startup path with "requested" true and a normal profile also refuses.
    assert!(matches!(
        Retirement::open_with(&root.lock(), [0x0e; 32], true, false),
        Err(UNVERIFIED)
    ));
    assert!(read_identity(pid).is_some());
}

#[test]
fn unknown_or_future_journal_names_refuse_and_temp_files_are_ignored() {
    let root = Root::new();
    for name in [
        "owner.retirement.master.zzzzzzzzzzzzzzzz",
        "owner.retirement.future.0011223344556677",
        "owner.retirement.master.0011223344556677.extra",
    ] {
        root.send_raw(name, "v1\n");
        assert!(
            matches!(root.retirement(false).reconcile(), Err(UNVERIFIED)),
            "{name}"
        );
        let _ = fs::remove_file(root.0.join(name));
    }
    root.send_raw(".owner.retirement.0011223344556677.tmp", "partial");
    assert!(root.retirement(false).reconcile().is_ok());
    assert!(
        !root
            .0
            .join(".owner.retirement.0011223344556677.tmp")
            .exists()
    );
}

#[test]
fn recover_clears_only_provably_absent_or_reused_records() {
    let root = Root::new();
    let lock = root.lock();
    // Provably absent.
    let gone_name = child_name(Kind::Master, SLOT);
    root.send(
        &gone_name,
        &child_record(
            Kind::Master,
            Identity {
                pid: u32::MAX,
                start: 1,
                namespace: namespace(),
            },
            &hex(&[0x0a; 32]),
        ),
    );
    assert_eq!(recover(&lock, &gone_name), Ok(Recovered::ClearedAbsent));
    assert!(!root.0.join(&gone_name).exists());

    // PID-reused: the PID is live but its start time differs.
    let mut child = sleep("5");
    let identity = read_identity(child.id()).unwrap();
    let mut reused = child_record(Kind::Master, identity, &hex(&[0x0b; 32]));
    reused.start += 1;
    let reused_name = child_name(Kind::Master, SLOT);
    root.send(&reused_name, &reused);
    assert_eq!(
        recover(&lock, &reused_name),
        Ok(Recovered::ClearedPidReused)
    );
    assert!(read_identity(child.id()).is_some());

    // Exact live: refuse, keep the record, never signal.
    let exact = child_record(Kind::Master, identity, &hex(&[0x0c; 32]));
    let exact_name = child_name(Kind::Master, SLOT);
    root.send(&exact_name, &exact);
    assert_eq!(recover(&lock, &exact_name), Err(UNVERIFIED));
    assert!(read_identity(child.id()).is_some());
    assert!(root.0.join(&exact_name).exists());

    // Unknown name and unreadable record refuse and stay.
    assert_eq!(
        recover(&lock, "owner.retirement.future.0011223344556677"),
        Err(UNVERIFIED)
    );
    let bad_name = child_name(Kind::Master, SLOT);
    root.send_raw(&bad_name, "not a record");
    assert_eq!(recover(&lock, &bad_name), Err(UNVERIFIED));
    assert!(root.0.join(&bad_name).exists());
    let _ = child.kill();
    let _ = child.wait();
}
