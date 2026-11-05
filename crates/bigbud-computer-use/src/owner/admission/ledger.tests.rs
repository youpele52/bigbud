#![allow(clippy::unwrap_used, clippy::panic)]
use super::ledger::*;

const MINUTE: u64 = 60_000_000_000;
fn outcome(revision: u64) -> Outcome {
    Outcome {
        completion: Completion::Completed,
        code: "ok".into(),
        policy_revision: revision,
        projected: b"projected".to_vec(),
        capture_error: None,
    }
}
fn admit(ledger: &mut Ledger, caller: &str, op: &str, now: u64) -> Result<Admit, Refusal> {
    ledger.admit("owner-1", caller, op, [1; 32], now)
}
fn number(admit: Result<Admit, Refusal>) -> u64 {
    match admit {
        Ok(Admit::New(admitted)) => admitted.number,
        other => panic!("expected new admission: {other:?}"),
    }
}
fn ledger_with_caller() -> (Ledger, String) {
    let mut ledger = Ledger::new("owner-1").unwrap();
    let caller = ledger.open_caller("thread-1").unwrap();
    (ledger, caller)
}

#[test]
fn lost_reply_is_recovered_by_lookup_never_by_reexecution() {
    let (mut ledger, a) = ledger_with_caller();
    let b = ledger.open_caller("thread-2").unwrap();
    assert_eq!(ledger.caller_thread(&a), Some("thread-1"));
    let ticket = number(admit(&mut ledger, &a, "op.1", 0));
    assert_eq!(
        admit(&mut ledger, &a, "op.1", 1),
        Ok(Admit::Duplicate(Lookup::Pending))
    );
    ledger.settle(ticket, outcome(7), 2).unwrap();
    assert_eq!(
        ledger.settle(ticket, outcome(7), 2),
        Err(Refusal::UnknownTicket)
    );
    assert_eq!(
        ledger.lookup(&a, "op.1", [1; 32], Some(7), 3),
        Lookup::Settled(outcome(7))
    );
    // Policy changed since: content-free settlement metadata only.
    assert_eq!(
        ledger.lookup(&a, "op.1", [1; 32], Some(8), 3),
        Lookup::ContentFree {
            completion: Completion::Completed,
            code: "ok".into()
        }
    );
    // Another caller cannot observe it; a conflicting digest refuses.
    assert_eq!(
        ledger.lookup(&b, "op.1", [1; 32], Some(7), 3),
        Lookup::Expired
    );
    assert_eq!(
        ledger.lookup(&a, "op.1", [2; 32], Some(7), 3),
        Lookup::Conflict
    );
    assert_eq!(
        ledger.admit("owner-1", &a, "op.1", [2; 32], 4),
        Err(Refusal::ConflictingDigest)
    );
}

#[test]
fn eviction_and_retention_expiry_never_reopen_old_operations() {
    let (mut ledger, a) = ledger_with_caller();
    for sequence in 1..=300_u64 {
        let ticket = number(admit(&mut ledger, &a, &format!("op.{sequence}"), sequence));
        ledger.settle(ticket, outcome(1), sequence).unwrap();
    }
    // op.1 was evicted (256 cap): the SAME operation ID, with the same or a
    // different digest, refuses rather than executing again.
    assert_eq!(
        ledger.lookup(&a, "op.1", [1; 32], Some(1), 301),
        Lookup::Expired
    );
    for digest in [[1; 32], [9; 32]] {
        assert_eq!(
            ledger.admit("owner-1", &a, "op.1", digest, 302),
            Err(Refusal::StaleSequence)
        );
    }
    // Ten-minute retention expires the outcome; still refused, still Expired.
    let later = 300 + 10 * MINUTE;
    assert_eq!(
        ledger.lookup(&a, "op.300", [1; 32], Some(1), later),
        Lookup::Expired
    );
    assert_eq!(
        admit(&mut ledger, &a, "op.300", later),
        Err(Refusal::StaleSequence)
    );
    number(admit(&mut ledger, &a, "op.301", later));
}

#[test]
fn operation_ids_must_carry_a_canonical_positive_sequence() {
    let (mut ledger, a) = ledger_with_caller();
    for bad in ["op", "op.0", "op.01", ".5", "op.+5", "op.x", "op 1.2", ""] {
        assert_eq!(
            admit(&mut ledger, &a, bad, 0),
            Err(Refusal::InvalidIdentity),
            "{bad}"
        );
    }
    number(admit(&mut ledger, &a, "launch.app.5", 0));
    assert_eq!(
        admit(&mut ledger, &a, "other.5", 0),
        Err(Refusal::StaleSequence)
    );
}

#[test]
fn caller_sessions_are_owner_issued_never_reused_and_retirable() {
    let mut ledger = Ledger::new("owner-1").unwrap();
    let mut callers: Vec<_> = (0..32)
        .map(|index| ledger.open_caller(&format!("thread-{index}")).unwrap())
        .collect();
    assert_eq!(ledger.open_caller("thread-x"), Err(Refusal::CallerCapacity));
    assert_eq!(ledger.open_caller("bad id"), Err(Refusal::InvalidIdentity));
    let first = callers.remove(0);
    let pending = number(admit(&mut ledger, &first, "op.1", 0));
    assert_eq!(ledger.retire_caller(&first), Err(Refusal::CallerBusy));
    ledger.settle(pending, outcome(1), 1).unwrap();
    let _retired = ledger.retire_caller(&first).unwrap();
    // Retired: the mark is gone but the session can never be used again.
    assert_eq!(
        admit(&mut ledger, &first, "op.2", 2),
        Err(Refusal::UnknownCaller)
    );
    assert_eq!(
        ledger.lookup(&first, "op.1", [1; 32], Some(1), 2),
        Lookup::Expired
    );
    assert_eq!(ledger.retire_caller(&first), Err(Refusal::UnknownCaller));
    let fresh = ledger.open_caller("thread-0").unwrap();
    assert_ne!(fresh, first);
    for forged in [
        "owner-1.c999",
        "owner-1.c01",
        "owner-2.c2",
        "thread-1",
        "owner-1.c",
    ] {
        assert_eq!(
            admit(&mut ledger, forged, "op.1", 0),
            Err(Refusal::UnknownCaller)
        );
    }
}

#[test]
fn owner_restart_rejects_old_generation_requests_and_tickets() {
    let (mut old, a) = ledger_with_caller();
    let Ok(Admit::New(admitted)) = admit(&mut old, &a, "op.1", 0) else {
        panic!("admit")
    };
    let mut restarted = Ledger::new("owner-2").unwrap();
    assert_eq!(
        restarted.ticket_number(&admitted.ticket),
        Err(Refusal::UnknownTicket)
    );
    assert_eq!(
        admit(&mut restarted, &a, "op.1", 0),
        Err(Refusal::GenerationMismatch)
    );
    assert_eq!(
        restarted.admit("owner-2", &a, "op.1", [1; 32], 0),
        Err(Refusal::UnknownCaller)
    );
    assert_eq!(old.ticket_number(&admitted.ticket), Ok(admitted.number));
    assert_eq!(
        old.ticket_number("owner-1.999"),
        Err(Refusal::UnknownTicket)
    );
}

#[test]
fn pending_entries_are_never_evicted_and_bounds_refuse_explicitly() {
    let mut ledger = Ledger::new("owner-1").unwrap();
    let callers: Vec<_> = (0..32)
        .map(|index| ledger.open_caller(&format!("thread-{index}")).unwrap())
        .collect();
    for caller in &callers {
        for sequence in 1..=8 {
            number(admit(&mut ledger, caller, &format!("op.{sequence}"), 0));
        }
    }
    let first = callers.first().unwrap();
    assert_eq!(
        admit(&mut ledger, first, "op.9", 0),
        Err(Refusal::OutcomeCapacity)
    );
    let mut oversized = outcome(1);
    oversized.projected = vec![0; 64 * 1024 + 1];
    assert_eq!(
        ledger.settle(1, oversized, 0),
        Err(Refusal::OutcomeTooLarge)
    );
    assert_eq!(
        ledger.settle(999, outcome(1), 0),
        Err(Refusal::UnknownTicket)
    );
    // A refused settlement left ticket 1 pending and still settleable.
    ledger.settle(1, outcome(1), 0).unwrap();
}
