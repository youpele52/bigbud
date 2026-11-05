#![allow(clippy::unwrap_used, clippy::unreachable)]
use super::{
    authority::*,
    ledger::{Admit, Completion, Ledger, Outcome, Refusal},
    session::CallerSession,
};

fn outcome() -> Outcome {
    Outcome {
        completion: Completion::Completed,
        code: "ok".into(),
        policy_revision: 1,
        projected: Vec::new(),
        capture_error: None,
    }
}

fn s(id: &str) -> CallerSession {
    CallerSession::fixture(id)
}

fn gate() -> Gate {
    Gate {
        pause_epoch: 4,
        latched: false,
        applied_policy_revision: Some(9),
        control_lease_until_ns: Some(1_000),
        worker_generation: "worker-1".into(),
    }
}
fn stamp(epoch: u64) -> Stamp {
    Stamp {
        caller: "thread-1".into(),
        caller_epoch: epoch,
        pause_epoch: 4,
        policy_revision: 9,
        worker_generation: "worker-1".into(),
        deadline_ns: 500,
        mutation: true,
    }
}

#[test]
fn downgrade_or_provider_replacement_between_enqueue_and_helper_refuses() {
    let mut table = AuthorityTable::default();
    let epoch = table
        .project(&s("thread-1"), "provider-1", 3, true)
        .unwrap();
    assert_eq!(check_dispatch(&gate(), &table, &stamp(epoch), 10), Ok(()));
    // Unchanged projection keeps the epoch (no spurious invalidation).
    assert_eq!(
        table.project(&s("thread-1"), "provider-1", 3, true),
        Ok(epoch)
    );
    let downgraded = table
        .project(&s("thread-1"), "provider-1", 4, false)
        .unwrap();
    assert_eq!(
        check_dispatch(&gate(), &table, &stamp(epoch), 10),
        Err(DispatchRefusal::AuthorityConflict)
    );
    assert_eq!(
        check_dispatch(&gate(), &table, &stamp(downgraded), 10),
        Err(DispatchRefusal::FullAccessRequired)
    );
    let read = Stamp {
        mutation: false,
        ..stamp(downgraded)
    };
    assert_eq!(check_dispatch(&gate(), &table, &read, 10), Ok(()));
    // Same revision with different data is a conflict, never an update.
    for (generation, full) in [("provider-2", false), ("provider-1", true)] {
        assert_eq!(
            table.project(&s("thread-1"), generation, 4, full),
            Err(DispatchRefusal::AuthorityConflict)
        );
    }
    let replaced = table
        .project(&s("thread-1"), "provider-2", 5, true)
        .unwrap();
    assert_ne!(replaced, downgraded);
    assert_eq!(
        table.project(&s("thread-1"), "provider-2", 3, true),
        Err(DispatchRefusal::AuthorityConflict)
    );
    table.revoke(&s("thread-1"), 5).unwrap();
    for mutation in [true, false] {
        let revoked = Stamp {
            mutation,
            ..stamp(replaced)
        };
        assert_eq!(
            check_dispatch(&gate(), &table, &revoked, 10),
            Err(DispatchRefusal::AuthorityConflict)
        );
    }
    // A delayed projection at the revoked revision cannot reopen it.
    assert_eq!(
        table.project(&s("thread-1"), "provider-2", 5, true),
        Err(DispatchRefusal::AuthorityConflict)
    );
    let reopened = table
        .project(&s("thread-1"), "provider-2", 6, true)
        .unwrap();
    assert_eq!(
        check_dispatch(&gate(), &table, &stamp(reopened), 10),
        Ok(())
    );
}

#[test]
fn epochs_are_table_wide_and_never_reused_even_after_forget() {
    let mut table = AuthorityTable::default();
    let session = s("owner-1.c1");
    let first = table.project(&session, "provider-1", 1, true).unwrap();
    table.forget(session);
    let session = s("owner-1.c1");
    let again = table.project(&session, "provider-1", 2, true).unwrap();
    assert!(again > first);
    assert_eq!(
        check_dispatch(
            &gate(),
            &table,
            &Stamp {
                caller: "owner-1.c1".into(),
                ..stamp(first)
            },
            10
        ),
        Err(DispatchRefusal::AuthorityConflict)
    );
}

#[test]
fn retired_sessions_can_never_be_projected_or_revoked_again() {
    let mut ledger = Ledger::new("owner-1").unwrap();
    let mut table = AuthorityTable::default();
    let id = ledger.open_caller("thread-1").unwrap();
    let live = ledger.session(&id).unwrap();
    table.project(live, "provider-1", 1, true).unwrap();
    table.revoke(live, 5).unwrap();
    // Busy retirement hands back nothing to forget: revocation history stays.
    let Admit::New(pending) = ledger.admit("owner-1", &id, "op.1", [1; 32], 0).unwrap() else {
        unreachable!("fresh operation")
    };
    assert_eq!(ledger.retire_caller(&id), Err(Refusal::CallerBusy));
    let live = ledger.session(&id).unwrap();
    assert_eq!(
        table.project(live, "provider-1", 5, true),
        Err(DispatchRefusal::AuthorityConflict)
    );
    ledger.settle(pending.number, outcome(), 1).unwrap();
    table.forget(ledger.retire_caller(&id).unwrap());
    // A delayed projection or revocation for the retired ID has no session to
    // name, so it can neither reopen authority nor leak a tombstone.
    assert!(ledger.session(&id).is_none());
    for forged in ["owner-1.c2", "owner-1.c01", "owner-2.c1", "thread-1"] {
        assert!(ledger.session(forged).is_none(), "{forged}");
    }
    for index in 0..32 {
        let id = ledger.open_caller(&format!("thread-{index}")).unwrap();
        table
            .project(ledger.session(&id).unwrap(), "p", 1, true)
            .unwrap();
    }
}

#[test]
fn revocation_before_projection_is_recorded_and_refuses_old_revisions() {
    let mut table = AuthorityTable::default();
    table.revoke(&s("thread-1"), 2).unwrap();
    let tombstone = Stamp {
        mutation: false,
        ..stamp(1)
    };
    assert_eq!(
        check_dispatch(&gate(), &table, &tombstone, 10),
        Err(DispatchRefusal::AuthorityConflict)
    );
    for revision in [1, 2] {
        assert_eq!(
            table.project(&s("thread-1"), "provider-1", revision, true),
            Err(DispatchRefusal::AuthorityConflict)
        );
    }
    let epoch = table
        .project(&s("thread-1"), "provider-1", 3, true)
        .unwrap();
    assert_eq!(check_dispatch(&gate(), &table, &stamp(epoch), 10), Ok(()));
    assert_eq!(
        table.revoke(&s("bad id"), 1),
        Err(DispatchRefusal::AuthorityConflict)
    );
}

#[test]
fn epoch_exhaustion_latches_closed() {
    let mut table = AuthorityTable::near_exhaustion();
    let last = table
        .project(&s("thread-1"), "provider-1", 1, true)
        .unwrap();
    assert_eq!(last, u64::MAX);
    assert_eq!(check_dispatch(&gate(), &table, &stamp(last), 10), Ok(()));
    assert_eq!(
        table.project(&s("thread-1"), "provider-1", 2, true),
        Err(DispatchRefusal::AuthorityConflict)
    );
    assert_eq!(
        check_dispatch(&gate(), &table, &stamp(last), 10),
        Err(DispatchRefusal::AuthorityConflict)
    );
    table.revoke(&s("thread-1"), 2).unwrap();
    assert_eq!(
        table.project(&s("thread-2"), "provider-1", 1, true),
        Err(DispatchRefusal::AuthorityConflict)
    );
}

#[test]
fn pause_policy_control_worker_and_deadline_each_refuse_with_frozen_codes() {
    let mut table = AuthorityTable::default();
    let epoch = table
        .project(&s("thread-1"), "provider-1", 1, true)
        .unwrap();
    let cases: Vec<(Gate, u64, &str)> = vec![
        (
            Gate {
                latched: true,
                ..gate()
            },
            10,
            "paused",
        ),
        (
            Gate {
                pause_epoch: 5,
                ..gate()
            },
            10,
            "paused",
        ),
        (
            Gate {
                applied_policy_revision: Some(10),
                ..gate()
            },
            10,
            "policy_pending",
        ),
        (
            Gate {
                applied_policy_revision: None,
                ..gate()
            },
            10,
            "policy_pending",
        ),
        (
            Gate {
                control_lease_until_ns: None,
                ..gate()
            },
            10,
            "control_unavailable",
        ),
        (gate(), 1_000, "control_unavailable"),
        (
            Gate {
                worker_generation: "worker-2".into(),
                ..gate()
            },
            10,
            "retirement_unknown",
        ),
        (gate(), 500, "deadline_exceeded"),
    ];
    for (candidate, now, code) in cases {
        let refusal = check_dispatch(&candidate, &table, &stamp(epoch), now).unwrap_err();
        assert_eq!(refusal.code(), code);
    }
    for index in 0..31 {
        table
            .project(&s(&format!("caller-{index}")), "p", 1, true)
            .unwrap();
    }
    assert_eq!(
        table.project(&s("one-more"), "p", 1, true),
        Err(DispatchRefusal::CallerCapacity)
    );
    table.forget(s("caller-0"));
    assert!(table.project(&s("one-more"), "p", 1, true).is_ok());
}
