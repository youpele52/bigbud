use super::{
    ActivityTracker, HostPolicy, PolicyAction, PolicyEngine, PolicyState, PolicyUpdate,
    PressureLevel, TerminalRef, ViewState,
};

const MINUTE: u64 = 60_000;
const T0: u64 = 50_000_000;

fn enabled() -> HostPolicy {
    HostPolicy {
        lifecycle_enabled: true,
        ..HostPolicy::default()
    }
}

fn quiet(managed: bool) -> ActivityTracker {
    let mut tracker = ActivityTracker::new(managed, T0 - MINUTE);
    tracker.record_output(T0);
    tracker
}

fn run(
    engine: &mut PolicyEngine,
    now: u64,
    policy: &HostPolicy,
    ptys: &mut [(&str, &mut ActivityTracker)],
) -> Vec<PolicyAction> {
    let mut refs: Vec<TerminalRef<'_>> = ptys
        .iter_mut()
        .map(|(pty_id, activity)| TerminalRef { pty_id, activity })
        .collect();
    engine.evaluate(now, policy, &mut refs)
}

#[test]
fn lifecycle_off_closes_nothing_and_drops_pending_warnings() {
    let mut engine = PolicyEngine::default();
    let mut tracker = quiet(true);
    let off = HostPolicy::default();
    assert!(
        run(
            &mut engine,
            T0 + 60 * MINUTE,
            &off,
            &mut [("a", &mut tracker)]
        )
        .is_empty()
    );
    let actions = run(
        &mut engine,
        T0 + 9 * MINUTE,
        &enabled(),
        &mut [("a", &mut tracker)],
    );
    assert_eq!(
        actions,
        vec![PolicyAction::IdleWarning {
            pty_id: "a".into(),
            closes_at: T0 + 10 * MINUTE
        }]
    );
    let actions = run(
        &mut engine,
        T0 + 10 * MINUTE,
        &off,
        &mut [("a", &mut tracker)],
    );
    assert_eq!(
        actions,
        vec![PolicyAction::IdleWarningCleared { pty_id: "a".into() }]
    );
}

#[test]
fn only_managed_ptys_are_warned_and_closed() {
    let mut engine = PolicyEngine::default();
    let (mut managed, mut unmanaged) = (quiet(true), quiet(false));
    let policy = enabled();
    let mut ptys = [("managed", &mut managed), ("unmanaged", &mut unmanaged)];
    let actions = run(&mut engine, T0 + 9 * MINUTE, &policy, &mut ptys);
    assert_eq!(
        actions,
        vec![PolicyAction::IdleWarning {
            pty_id: "managed".into(),
            closes_at: T0 + 10 * MINUTE
        }]
    );
    let actions = run(&mut engine, T0 + 10 * MINUTE, &policy, &mut ptys);
    assert_eq!(
        actions,
        vec![PolicyAction::IdleClose {
            pty_id: "managed".into()
        }]
    );
}

#[test]
fn pressure_closes_the_least_recently_used_quiet_hidden_terminal_only() {
    let mut engine = PolicyEngine::default();
    let policy = HostPolicy {
        idle_ms: 24 * 60 * MINUTE,
        ..enabled()
    };
    let now = T0 + 20 * MINUTE;
    let mut visible = quiet(true);
    visible.set_view_state(ViewState::Visible, T0);
    let mut busy = quiet(true);
    busy.set_foreground_program(true, T0);
    let mut chatty = quiet(true);
    chatty.record_output(now - MINUTE);
    let mut recent = quiet(true);
    recent.record_input(T0 + 5 * MINUTE);
    let mut oldest = quiet(true);
    oldest.record_input(T0 + MINUTE);
    let mut unmanaged = quiet(false);
    assert_eq!(
        engine.observe_memory(PressureLevel::Low),
        PressureLevel::Normal
    );
    assert_eq!(
        engine.observe_memory(PressureLevel::Low),
        PressureLevel::Low
    );
    let mut ptys = [
        ("visible", &mut visible),
        ("busy", &mut busy),
        ("chatty", &mut chatty),
        ("recent", &mut recent),
        ("oldest", &mut oldest),
        ("unmanaged", &mut unmanaged),
    ];
    let actions = run(&mut engine, now, &policy, &mut ptys);
    assert_eq!(
        actions,
        vec![PolicyAction::PressureClose {
            pty_id: "oldest".into()
        }]
    );
    assert!(
        run(&mut engine, now + 29_999, &policy, &mut ptys).is_empty(),
        "wait 30 s"
    );
    let actions = run(&mut engine, now + 30_000, &policy, &mut ptys);
    assert_eq!(
        actions,
        vec![PolicyAction::PressureClose {
            pty_id: "oldest".into()
        }],
        "R5 had not closed it yet"
    );
}

#[test]
fn pressure_without_a_candidate_notifies_at_most_every_ten_minutes() {
    let mut engine = PolicyEngine::default();
    engine.observe_memory(PressureLevel::Critical);
    engine.observe_memory(PressureLevel::Critical);
    let mut visible = quiet(true);
    visible.set_view_state(ViewState::Visible, T0);
    let policy = enabled();
    let now = T0 + MINUTE;
    let mut ptys = [("visible", &mut visible)];
    assert_eq!(
        run(&mut engine, now, &policy, &mut ptys),
        vec![PolicyAction::PressureNoCandidate]
    );
    assert!(run(&mut engine, now + 5 * MINUTE, &policy, &mut ptys).is_empty());
    assert_eq!(
        run(&mut engine, now + 10 * MINUTE, &policy, &mut ptys),
        vec![PolicyAction::PressureNoCandidate]
    );
}

#[test]
fn policy_values_are_clamped_and_the_latest_revision_wins() {
    let clamped = HostPolicy {
        idle_ms: 1_000,
        warning_ms: 50_000,
        max_live_ptys: 99,
        orphan_ms: 5,
        ..HostPolicy::default()
    }
    .clamped();
    assert_eq!(
        (
            clamped.idle_ms,
            clamped.warning_ms,
            clamped.max_live_ptys,
            clamped.orphan_ms
        ),
        (60_000, 30_000, 40, 60_000)
    );
    assert_eq!(
        HostPolicy {
            max_live_ptys: 0,
            orphan_ms: 0,
            ..HostPolicy::default()
        }
        .clamped()
        .max_live_ptys,
        1
    );
    assert_eq!(
        HostPolicy {
            orphan_ms: 0,
            ..HostPolicy::default()
        }
        .clamped()
        .orphan_ms,
        0,
        "0 keeps orphans"
    );
    let mut state = PolicyState::default();
    assert!(
        !state.current().lifecycle_enabled,
        "lifecycle is off by default"
    );
    let applied = state.apply(HostPolicy {
        revision: 5,
        ..enabled()
    });
    assert!(matches!(applied, PolicyUpdate::Applied(ref policy) if policy.lifecycle_enabled));
    let stale = state.apply(HostPolicy {
        revision: 4,
        ..HostPolicy::default()
    });
    assert!(
        matches!(stale, PolicyUpdate::Stale(ref policy) if policy.revision == 5 && policy.lifecycle_enabled)
    );
    assert!(matches!(
        state.apply(HostPolicy {
            revision: 5,
            ..HostPolicy::default()
        }),
        PolicyUpdate::Applied(_)
    ));
    assert!(!state.current().lifecycle_enabled);
}

#[test]
fn a_debug_idle_override_replaces_the_timeout_and_shortens_the_warning() {
    let policy = HostPolicy::default().clamped();
    let overridden = policy.clone().with_idle_override(Some(4_000));
    assert_eq!((overridden.idle_ms, overridden.warning_ms), (4_000, 2_000));
    // Too short or absent: the pushed values stay.
    assert_eq!(policy.clone().with_idle_override(Some(999)), policy);
    assert_eq!(policy.clone().with_idle_override(None), policy);
}
