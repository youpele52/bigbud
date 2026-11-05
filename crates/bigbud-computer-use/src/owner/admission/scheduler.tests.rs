#![allow(clippy::unwrap_used, clippy::unreachable)]
use super::scheduler::*;

fn op(ticket: u64, caller: &str) -> Queued {
    Queued {
        ticket,
        caller: caller.into(),
        bytes: 100,
        deadline_ns: u64::MAX,
    }
}
fn run(scheduler: &mut Scheduler) -> Vec<u64> {
    let mut order = vec![];
    while let Some(started) = scheduler.start_next(0).started {
        order.push(started.ticket);
        assert!(scheduler.finish(started.ticket));
    }
    order
}

#[test]
fn fifo_per_caller_and_round_robin_against_a_flooding_caller() {
    let mut scheduler = Scheduler::default();
    for ticket in 1..=4 {
        scheduler.enqueue(op(ticket, "flood")).unwrap();
    }
    assert_eq!(
        scheduler.enqueue(op(5, "flood")),
        Err(QueueRefusal::CallerQueueFull)
    );
    scheduler.enqueue(op(10, "quiet")).unwrap();
    scheduler.enqueue(op(11, "quiet")).unwrap();
    assert_eq!(run(&mut scheduler), [1, 10, 2, 11, 3, 4]);
}

#[test]
fn compound_sequence_holds_lane_until_finish() {
    let mut scheduler = Scheduler::default();
    scheduler.enqueue(op(1, "a")).unwrap();
    scheduler.enqueue(op(2, "b")).unwrap();
    assert_eq!(scheduler.start_next(0).started.unwrap().ticket, 1);
    assert_eq!(scheduler.start_next(0).started, None);
    assert!(!scheduler.finish(2));
    assert!(scheduler.finish(1));
    assert_eq!(scheduler.start_next(0).started.unwrap().ticket, 2);
}

#[test]
fn cancellation_revocation_and_deadlines_never_execute_later() {
    let mut scheduler = Scheduler::default();
    scheduler.enqueue(op(1, "a")).unwrap();
    scheduler.enqueue(op(2, "a")).unwrap();
    scheduler
        .enqueue(Queued {
            deadline_ns: 50,
            ..op(3, "b")
        })
        .unwrap();
    scheduler.enqueue(op(4, "c")).unwrap();
    assert_eq!(scheduler.start_next(0).started.unwrap().ticket, 1);
    assert_eq!(scheduler.cancel(1), Some(Cancelled::InFlight));
    assert_eq!(scheduler.cancel(4), Some(Cancelled::NotStarted));
    assert_eq!(scheduler.cancel(4), None);
    assert_eq!(scheduler.revoke_caller("a"), (vec![2], Some(1)));
    assert!(scheduler.finish(1));
    let dispatch = scheduler.start_next(60);
    assert_eq!(
        dispatch,
        Dispatch {
            started: None,
            expired: vec![3]
        }
    );
    assert_eq!(scheduler.queued(), 0);
}

#[test]
fn global_count_byte_budget_and_duplicates_refuse_explicitly() {
    let mut scheduler = Scheduler::default();
    for ticket in 0..32_u64 {
        scheduler
            .enqueue(op(ticket, &format!("caller-{}", ticket / 4)))
            .unwrap();
    }
    assert_eq!(
        scheduler.enqueue(op(99, "late")),
        Err(QueueRefusal::QueueFull)
    );
    let mut bytes = Scheduler::default();
    bytes
        .enqueue(Queued {
            bytes: 1024 * 1024,
            ..op(1, "a")
        })
        .unwrap();
    assert_eq!(bytes.enqueue(op(2, "b")), Err(QueueRefusal::BytesExceeded));
    assert_eq!(bytes.enqueue(op(1, "c")), Err(QueueRefusal::Duplicate));
}

#[test]
fn drained_callers_leave_no_queue_state_behind() {
    let mut scheduler = Scheduler::default();
    for index in 0..100_u64 {
        scheduler
            .enqueue(op(index, &format!("caller-{index}")))
            .unwrap();
        match index % 3 {
            0 => assert_eq!(scheduler.cancel(index), Some(Cancelled::NotStarted)),
            1 => assert_eq!(
                scheduler.revoke_caller(&format!("caller-{index}")).0,
                [index]
            ),
            _ => assert_eq!(run(&mut scheduler), [index]),
        }
        assert_eq!((scheduler.callers(), scheduler.queued()), (0, 0));
    }
}

#[test]
fn removed_before_start_tickets_settle_not_started_in_the_ledger() {
    use super::ledger::{Completion, Ledger, Lookup, Outcome};
    let mut ledger = Ledger::new("owner-1").unwrap();
    let caller = ledger.open_caller("thread-1").unwrap();
    let super::ledger::Admit::New(admitted) = ledger
        .admit("owner-1", &caller, "op.1", [1; 32], 0)
        .unwrap()
    else {
        unreachable!("fresh operation")
    };
    let mut scheduler = Scheduler::default();
    let mut queued = op(admitted.number, &caller);
    queued.deadline_ns = 5;
    scheduler.enqueue(queued).unwrap();
    let dispatch = scheduler.start_next(5);
    assert_eq!(
        (dispatch.started, dispatch.expired.as_slice()),
        (None, &[admitted.number][..])
    );
    let not_started = Outcome {
        completion: Completion::NotStarted,
        code: "deadline_exceeded".into(),
        policy_revision: 1,
        projected: Vec::new(),
        capture_error: None,
    };
    ledger.settle(admitted.number, not_started, 6).unwrap();
    assert_eq!(
        ledger.lookup(&caller, "op.1", [1; 32], Some(2), 7),
        Lookup::ContentFree {
            completion: Completion::NotStarted,
            code: "deadline_exceeded".into()
        }
    );
    let _retired = ledger.retire_caller(&caller).unwrap();
}
