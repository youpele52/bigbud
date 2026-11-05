#![allow(clippy::unwrap_used, clippy::unreachable)]
//! Scheduler tests with private fixture targets only: no child, signal or reap.
use super::super::tests::{Calls, attach, lock};
use super::*;
use crate::guard::test_support::{TestDirectory, armed};
use std::sync::mpsc;

const SLOW: Duration = Duration::from_secs(5);

fn config(budget_ms: u64) -> GuardServiceConfig {
    GuardServiceConfig::new(MAX_CADENCE, Duration::from_millis(budget_ms)).unwrap()
}
fn calls(calls: &Arc<Mutex<Calls>>) -> std::sync::MutexGuard<'_, Calls> {
    calls.lock().unwrap()
}

#[test]
fn config_rejects_unbounded_cadence_and_budget() {
    let ms = Duration::from_millis;
    assert!(GuardServiceConfig::new(ms(0), ms(1)).is_err());
    assert!(GuardServiceConfig::new(ms(101), ms(1)).is_err());
    assert!(GuardServiceConfig::new(ms(1), ms(0)).is_err());
    assert!(GuardServiceConfig::new(ms(1), ms(5_001)).is_err());
    assert!(GuardServiceConfig::new(ms(100), ms(5_000)).is_ok());
}

#[test]
fn cancellation_joins_lanes_and_retains_owners_and_roots() {
    let directory = TestDirectory::new();
    // Armed recovery is always revoked (latched) before service starts.
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let fixtures = attach(&mut recovery);
    let control = GuardServiceControl::default();
    let canceller = control.clone();
    let started = Instant::now();
    let report = thread::scope(|scope| {
        scope.spawn(move || {
            let _cancel = CancelOnDrop(&canceller);
            thread::sleep(Duration::from_millis(30));
        });
        recovery.run_guard_service(&control, config(5_000))
    });
    assert!(started.elapsed() < SLOW);
    assert_eq!(report.exit, GuardServiceExit::Cancelled);
    // Unclean recovery latched; service retired but never settled/removed.
    let record = recovery.record().unwrap();
    assert_eq!(record.roots, armed().roots);
    assert!(record.latched);
    assert_eq!(calls(&fixtures[0]).signals.first(), Some(&"TERM"));
    assert!(matches!(
        recovery.retirement.as_ref().unwrap().targets[0],
        Target::Fixture(_)
    ));
}

#[test]
fn retirement_escalates_on_real_clock_and_persists_denial() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let fixtures = attach(&mut recovery);
    let epoch = recovery.record().unwrap().pause_epoch;
    let priority = recovery.session.retirement_requests();
    let (sent, received) = mpsc::sync_channel(4);
    {
        let target = &mut recovery.retirement.as_mut().unwrap().targets[0];
        let Target::Fixture(fixture) = target else {
            unreachable!()
        };
        fixture.before_signal = Some(Arc::new(move || {
            let _notify = sent.try_send(());
        }));
    }
    let control = GuardServiceControl::default();
    let report = thread::scope(|scope| {
        let control = &control;
        let observer = scope.spawn(move || {
            let _cancel = CancelOnDrop(control);
            // Unclean recovery requests retirement at once (latched record).
            received.recv_timeout(SLOW).unwrap();
            priority.raise(RetirementCause::OwnerLost);
            // KILL escalation proceeds on the real clock within its 250 ms.
            received.recv_timeout(SLOW).unwrap();
        });
        let report = recovery.run_guard_service(control, config(5_000));
        observer.join().unwrap();
        report
    });
    assert_eq!(report.exit, GuardServiceExit::Cancelled);
    let status = report.status.unwrap();
    assert_eq!((status.term_sent, status.kill_sent), (1, 1));
    assert_ne!(status.causes & RetirementCause::OwnerLost as u8, 0);
    assert_eq!(calls(&fixtures[0]).signals, ["TERM", "KILL"]);
    assert!(report.storage_ok);
    let record = recovery.record().unwrap();
    assert!(record.latched && record.pause_epoch > epoch);
    assert_eq!(record.roots, armed().roots);
}

#[test]
fn shutdown_settles_reaps_and_durably_removes_exact_roots() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let fixtures = attach(&mut recovery);
    let fixture = fixtures[0].clone();
    {
        let Target::Fixture(target) = &mut recovery.retirement.as_mut().unwrap().targets[0] else {
            unreachable!()
        };
        // Fixture closure settles once TERM was delivered.
        target.before_signal = Some(Arc::new(move || {
            fixture.lock().unwrap().closure_settled = true;
        }));
    }
    let control = GuardServiceControl::default();
    control.request_shutdown();
    let report = recovery.run_guard_service(&control, config(5_000));
    assert_eq!(report.exit, GuardServiceExit::ShutdownSettled);
    assert_eq!(report.status.unwrap().settled, 1);
    assert!(!report.status.unwrap().unknown);
    assert!(matches!(
        recovery.retirement.as_ref().unwrap().targets[0],
        Target::Settled(_)
    ));
    let record = recovery.record().unwrap().clone();
    assert!(record.roots.is_empty());
    // Recovered unclean state stays latched/armed: no Resume is invented.
    assert!(record.latched && record.armed);
    drop(recovery);
    assert_eq!(elected.journal().read().unwrap().unwrap(), record);
}

#[test]
fn unsettled_shutdown_budget_retains_owners_roots_and_failed_reap_is_unknown() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let fixtures = attach(&mut recovery);
    {
        let mut fixture = calls(&fixtures[0]);
        fixture.closure_settled = true;
        fixture.fail_settle = true;
    }
    let control = GuardServiceControl::default();
    control.request_shutdown();
    let started = Instant::now();
    let report = recovery.run_guard_service(&control, config(200));
    assert!(started.elapsed() >= Duration::from_millis(200) && started.elapsed() < SLOW);
    assert_eq!(report.exit, GuardServiceExit::ShutdownBudgetExceeded);
    let status = report.status.unwrap();
    assert!(status.unknown && status.settled == 0);
    assert!(matches!(
        recovery.retirement.as_ref().unwrap().targets[0],
        Target::Fixture(_)
    ));
    let record = recovery.record().unwrap();
    assert!(record.latched);
    assert_eq!(record.roots, armed().roots);
}

/// Cancels on every exit, including assertion unwinds: a failing fixture can
/// never leave a running service (and therefore a hung scoped join).
struct CancelOnDrop<'a>(&'a GuardServiceControl);
impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[test]
fn raised_cause_wakes_parked_signal_lane_without_waiting_for_cadence() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let fixtures = attach(&mut recovery);
    let priority = recovery.session.retirement_requests();
    let (sent, received) = mpsc::sync_channel(4);
    {
        let Target::Fixture(target) = &mut recovery.retirement.as_mut().unwrap().targets[0] else {
            unreachable!()
        };
        target.before_signal = Some(Arc::new(move || {
            let _notify = sent.try_send(());
        }));
    }
    // Private 10 s cadence. Unclean recovery sends TERM on the first pass; KILL
    // needs a later pass >=250 ms on. Arriving within the 5 s bound after the
    // raise is only possible through the unpark wake, never the cadence.
    let parked = GuardServiceConfig {
        cadence: Duration::from_secs(10),
        shutdown_budget: GRACEFUL_SHUTDOWN,
    };
    let control = GuardServiceControl::default();
    thread::scope(|scope| {
        let control = &control;
        scope.spawn(move || {
            let _cancel = CancelOnDrop(control);
            received.recv_timeout(SLOW).unwrap();
            thread::sleep(Duration::from_millis(300));
            // (A spurious park wakeup may already have escalated; that only
            // makes KILL earlier and cannot satisfy the bound below falsely.)
            let raised = Instant::now();
            priority.raise(RetirementCause::WorkerLost);
            received.recv_timeout(SLOW).unwrap();
            assert!(raised.elapsed() < SLOW);
        });
        assert_eq!(
            recovery.run_guard_service(control, parked).exit,
            GuardServiceExit::Cancelled
        );
    });
    assert_eq!(calls(&fixtures[0]).signals, ["TERM", "KILL"]);
}

#[test]
fn closure_errors_are_unknown_and_unattached_causes_are_drained() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let priority = recovery.session.retirement_requests();
    priority.raise(RetirementCause::Shutdown);
    assert!(recovery.service_retirement_sample(Ok(1)).is_none());
    assert_eq!(
        priority.take_causes(),
        0,
        "stale cause left for a later attach"
    );
    let fixtures = attach(&mut recovery);
    calls(&fixtures[0]).fail_closure = true;
    let status = recovery.service_retirement_sample(Ok(2)).unwrap();
    assert!(status.unknown && status.settled == 0);
}

#[test]
fn deadline_aware_parking_targets_escalation_then_unknown() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let _fixtures = attach(&mut recovery);
    let start = 5_000_000_000;
    recovery.service_retirement_sample(Ok(start)).unwrap();
    let dispatch = recovery.retirement.as_ref().unwrap();
    assert_eq!(
        dispatch.next_deadline_ns(start + 100_000_000),
        Some(150_000_000)
    );
    assert_eq!(
        dispatch.next_deadline_ns(start + 300_000_000),
        Some(1_700_000_000)
    );
    recovery
        .service_retirement_sample(Ok(start + 2_000_000_000))
        .unwrap();
    let dispatch = recovery.retirement.as_ref().unwrap();
    assert_eq!(dispatch.next_deadline_ns(start + 2_000_000_001), None);
}

#[test]
fn a_latching_cause_raised_with_shutdown_is_persisted_before_settling() {
    // Regression: with nothing attached, storage could see shutdown plus an
    // earlier "targets settled" pass and settle before the signal lane took
    // the latching cause, losing its durable denial.
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, crate::guard::record::SafetyRecord::initial());
    for round in 0..10_u64 {
        let mut recovery = elected.recover_retained();
        let priority = recovery.session.retirement_requests();
        let control = GuardServiceControl::default();
        let report = thread::scope(|scope| {
            let (control, priority) = (&control, &priority);
            scope.spawn(move || {
                // Let the service publish and settle its idle state first.
                let deadline = Instant::now() + SLOW;
                while control.status().is_none() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(5));
                }
                thread::sleep(Duration::from_millis(20));
                priority.raise(RetirementCause::HumanStop);
                control.request_shutdown();
            });
            recovery.run_guard_service(control, config(5_000))
        });
        assert_eq!(
            report.exit,
            GuardServiceExit::ShutdownSettled,
            "round {round}"
        );
        let record = recovery.record().unwrap();
        assert!(record.latched);
        assert_eq!(record.pause_epoch, round + 1, "round {round}");
    }
}
