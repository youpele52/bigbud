use super::*;

fn policy() -> SchedulingPolicy {
    SchedulingPolicy {
        version: 1,
        idle: RuleWait {
            enabled: false,
            timeout_ms: 600_000,
        },
        idle_destination: Section::Later,
        older: RuleWait {
            enabled: false,
            timeout_ms: 86_400_000,
        },
        target: Some(7),
        target_not_before_ms: None,
        grace_ms: 300_000,
    }
}
fn clock(ms: i64) -> ClockSample {
    ClockSample {
        wall_ms: ms,
        monotonic_ms: ms as u64,
    }
}
fn row(id: &str) -> ThreadFacts {
    ThreadFacts {
        in_scope: Some(true),
        manual_attention_watermark: Some(0),
        engaged_until_ms: None,
        thread_id: id.into(),
        fact_version: 1,
        organization_revision: 0,
        section: Section::Present as i32,
        work: Work::Idle as i32,
        actionable: false,
        attention_watermark: 0,
        inactivity_at_ms: Some(0),
        manual_until_ms: None,
        snooze_until_ms: None,
        snooze_identity: String::new(),
        grace_until_ms: None,
        eligible: true,
        automatic_placement: None,
    }
}
fn facts(row: &ThreadFacts) -> SchedulingFacts<'_> {
    SchedulingFacts {
        row,
        in_scope: true,
        decision_allowed: true,
        manual_attention_watermark: 0,
        engaged_until_ms: None,
    }
}
fn scheduler() -> Scheduler {
    Scheduler::new(clock(0), None, policy()).expect("valid fixture")
}

#[test]
fn active_unknown_and_all_protected_overflow_are_not_evicted() {
    let mut rows: Vec<_> = (0..270).map(|n| row(&format!("thread-{n:03}"))).collect();
    for (i, row) in rows.iter_mut().enumerate() {
        row.work = if i % 2 == 0 {
            Work::Active as i32
        } else {
            Work::Unknown as i32
        };
    }
    assert_eq!(
        scheduler().next(
            clock(1_000_000),
            &rows.iter().map(facts).collect::<Vec<_>>()
        ),
        None
    );
    rows.push(row("zz-eligible"));
    let selected = scheduler()
        .next(
            clock(1_000_000),
            &rows.iter().map(facts).collect::<Vec<_>>(),
        )
        .expect("eligible beyond protected rows");
    assert_eq!(selected.thread_id, "zz-eligible");
    assert_eq!(selected.reason, MovementReason::Target);
}

#[test]
fn target_uses_activity_not_creation_or_arrival_and_honours_scope() {
    let mut rows: Vec<_> = (0..8).map(|n| row(&format!("thread-{n}"))).collect();
    for (i, row) in rows.iter_mut().enumerate() {
        row.inactivity_at_ms = Some(100 - i as u64);
    }
    let proposed = scheduler()
        .next(clock(1000), &rows.iter().map(facts).collect::<Vec<_>>())
        .expect("over target");
    assert_eq!(proposed.thread_id, "thread-7");
    let mut input: Vec<_> = rows.iter().map(facts).collect();
    input.last_mut().expect("fixture").in_scope = false;
    assert_eq!(scheduler().next(clock(1000), &input), None);
}

#[test]
fn manual_move_last_ten_minutes_but_new_request_interrupts_immediately() {
    let mut thread = row("manual");
    thread.section = Section::Done as i32;
    thread.work = Work::Active as i32;
    thread.manual_until_ms = Some(MANUAL_OVERRIDE_MS);
    let mut scheduler = scheduler();
    assert_eq!(scheduler.next(clock(599_999), &[facts(&thread)]), None);
    assert_eq!(
        scheduler
            .next(clock(600_000), &[facts(&thread)])
            .expect("return")
            .destination,
        Section::Present
    );
    thread.actionable = true;
    thread.attention_watermark = 3;
    let mut before_request = facts(&thread);
    before_request.manual_attention_watermark = 3;
    assert_eq!(scheduler.next(clock(100), &[before_request]), None);
    assert_eq!(
        scheduler
            .next(clock(100), &[facts(&thread)])
            .expect("new request")
            .destination,
        Section::NeedsYou
    );
    thread.work = Work::Idle as i32;
    thread.actionable = false;
    assert_eq!(scheduler.next(clock(600_000), &[facts(&thread)]), None);
}

#[test]
fn snooze_honours_full_deadline_even_with_active_work_and_new_attention_interrupts() {
    let mut thread = row("snooze");
    thread.section = Section::Later as i32;
    thread.work = Work::Active as i32;
    thread.snooze_identity = "occurrence".into();
    thread.snooze_until_ms = Some(3_600_000);
    let mut scheduler = scheduler();
    assert_eq!(scheduler.next(clock(600_001), &[facts(&thread)]), None);
    let expired = scheduler
        .next(clock(3_600_000), &[facts(&thread)])
        .expect("deadline equality");
    assert_eq!(expired.reason, MovementReason::SnoozeExpired);
    assert_eq!(expired.destination, Section::NeedsYou);
    assert_eq!(expired.snooze_identity, "occurrence");
    thread.actionable = true;
    thread.attention_watermark = 1;
    assert_eq!(
        scheduler
            .next(clock(100), &[facts(&thread)])
            .expect("new approval")
            .reason,
        MovementReason::Attention
    );
}

#[test]
fn attention_wins_while_subagent_or_terminal_is_still_running() {
    let mut thread = row("both");
    thread.work = Work::Active as i32;
    thread.actionable = true;
    assert_eq!(
        scheduler()
            .next(clock(100), &[facts(&thread)])
            .expect("needs user")
            .destination,
        Section::NeedsYou
    );
    thread.section = Section::NeedsYou as i32;
    assert_eq!(scheduler().next(clock(100), &[facts(&thread)]), None);
    thread.actionable = false;
    assert_eq!(
        scheduler()
            .next(clock(100), &[facts(&thread)])
            .expect("all requests resolved")
            .destination,
        Section::Present
    );
}

#[test]
fn engagement_grace_and_target_change_barrier_expire_at_equality() {
    let rows: Vec<_> = (0..8)
        .map(|n| {
            let mut row = row(&format!("thread-{n}"));
            row.grace_until_ms = Some(1000);
            row
        })
        .collect();
    let mut policy = policy();
    policy.target_not_before_ms = Some(2000);
    let mut scheduler = Scheduler::new(clock(0), None, policy).expect("valid");
    let mut input: Vec<_> = rows.iter().map(facts).collect();
    assert_eq!(scheduler.next(clock(999), &input), None);
    assert_eq!(scheduler.next(clock(1999), &input), None);
    for facts in &mut input {
        facts.engaged_until_ms = Some(3000);
    }
    assert_eq!(scheduler.next(clock(2000), &input), None);
    assert_eq!(
        scheduler
            .next(clock(3000), &input)
            .expect("at boundary")
            .reason,
        MovementReason::Target
    );
}

#[test]
fn older_runs_first_at_restart_but_short_waits_and_disabled_older_cannot_block_it() {
    let mut policy = policy();
    policy.target = None;
    policy.idle.enabled = true;
    policy.older.enabled = true;
    let mut scheduler = Scheduler::new(clock(86_400_000), None, policy).expect("valid");
    let thread = row("old");
    assert_eq!(
        scheduler
            .next(clock(86_400_000), &[facts(&thread)])
            .expect("old at restart")
            .reason,
        MovementReason::Older
    );
    policy.version = 2;
    policy.older.enabled = false;
    scheduler
        .update_policy(clock(86_400_000), policy)
        .expect("valid");
    assert_eq!(scheduler.next(clock(86_400_000), &[facts(&thread)]), None);
    for tick in 1..=40 {
        assert_eq!(scheduler.next(clock(86_400_000 + tick * 15_000), &[]), None);
    }
    assert_eq!(
        scheduler
            .next(clock(87_000_000), &[facts(&thread)])
            .expect("short wait elapsed")
            .reason,
        MovementReason::Idle
    );
}

#[test]
fn invalid_and_ambiguous_policy_changes_fail_closed() {
    let mut scheduler = scheduler();
    let mut invalid = policy();
    invalid.grace_ms = 119_999;
    assert!(scheduler.update_policy(clock(0), invalid).is_err());
    let mut conflicting = policy();
    conflicting.target = Some(10);
    assert!(scheduler.update_policy(clock(0), conflicting).is_err());
    let mut low = policy();
    low.version = 0;
    assert!(scheduler.update_policy(clock(0), low).is_err());
}

fn needs_you(id: &str, automatic: Option<bool>, work: Work) -> ThreadFacts {
    ThreadFacts {
        section: Section::NeedsYou as i32,
        work: work as i32,
        automatic_placement: automatic,
        ..row(id)
    }
}

#[test]
fn answered_automatic_needs_you_returns_to_present_whatever_the_work_state() {
    for work in [Work::Idle, Work::Unknown, Work::Active] {
        let row = needs_you("answered", Some(true), work);
        let movement = scheduler()
            .next(clock(1_000), &[facts(&row)])
            .expect("automatic placement returns");
        assert_eq!(movement.destination, Section::Present);
        assert_eq!(movement.reason, MovementReason::Resolved);
        assert_eq!(movement.from, Section::NeedsYou);
    }
}

#[test]
fn manual_needs_you_and_open_requests_stay_in_needs_you() {
    let manual = needs_you("manual", None, Work::Idle);
    let explicit = needs_you("explicit", Some(false), Work::Idle);
    // A snooze reminder (or any open request) keeps the row actionable.
    let reminder = ThreadFacts {
        actionable: true,
        attention_watermark: 1,
        ..needs_you("reminder", Some(true), Work::Idle)
    };
    let rows = [manual, explicit, reminder];
    let facts: Vec<_> = rows.iter().map(facts).collect();
    assert_eq!(scheduler().next(clock(1_000), &facts), None);
}

#[test]
fn automatic_needs_you_waits_for_a_live_manual_override() {
    let row = ThreadFacts {
        manual_until_ms: Some(5_000),
        ..needs_you("override", Some(true), Work::Idle)
    };
    assert_eq!(scheduler().next(clock(1_000), &[facts(&row)]), None);
}

#[test]
fn same_version_policy_may_only_advance_the_target_barrier() {
    let mut scheduler = scheduler();
    let barrier = |ms| SchedulingPolicy {
        target_not_before_ms: ms,
        ..policy()
    };
    assert!(scheduler.update_policy(clock(1), barrier(Some(10))).is_ok());
    assert!(scheduler.update_policy(clock(2), barrier(Some(20))).is_ok());
    assert!(
        scheduler
            .update_policy(clock(3), barrier(Some(15)))
            .is_err()
    );
    assert!(scheduler.update_policy(clock(4), barrier(None)).is_err());
    let retargeted = SchedulingPolicy {
        target: Some(3),
        ..barrier(Some(20))
    };
    assert!(scheduler.update_policy(clock(5), retargeted).is_err());
    let newer = SchedulingPolicy {
        version: 2,
        ..retargeted
    };
    assert!(scheduler.update_policy(clock(6), newer).is_ok());
}
