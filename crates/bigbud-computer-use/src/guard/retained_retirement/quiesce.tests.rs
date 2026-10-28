#![allow(clippy::unwrap_used, clippy::unreachable)]
use super::tests::{attach, lock};
use super::*;
use crate::guard::test_support::{TestDirectory, armed};
use std::{sync::Arc, time::Duration};

fn launch() -> crate::worker::unix::LaunchGuard {
    crate::worker::unix::LaunchGuard::acquire().unwrap()
}
fn short() -> GuardServiceConfig {
    GuardServiceConfig::new(MAX_CADENCE, Duration::from_millis(300)).unwrap()
}

#[test]
fn settled_shutdown_yields_root_free_fence_preserving_latch() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let fixtures = attach(&mut recovery);
    let fixture = fixtures[0].clone();
    let Target::Fixture(target) = &mut recovery.retirement.as_mut().unwrap().targets[0] else {
        unreachable!()
    };
    target.before_signal = Some(Arc::new(move || {
        fixture.lock().unwrap().closure_settled = true;
    }));
    let epoch = recovery.record().unwrap().pause_epoch;
    let fence = recovery
        .quiesce(QuiesceOperation::Update, short(), launch())
        .unwrap();
    assert_eq!(fence.operation(), QuiesceOperation::Update);
    let record = fence.record().unwrap();
    assert!(record.roots.is_empty() && record.latched);
    // Latched recovery may durably re-revoke (epoch advance), never clear.
    assert!(record.pause_epoch >= epoch);
}

#[test]
fn unsettled_or_unowned_durable_roots_refuse_replacement() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let _fixtures = attach(&mut recovery);
    let Err(QuiesceError::Unsettled(report)) =
        recovery.quiesce(QuiesceOperation::Install, short(), launch())
    else {
        unreachable!()
    };
    assert_eq!(report.exit, GuardServiceExit::ShutdownBudgetExceeded);
    assert_eq!(recovery.record().unwrap().roots, armed().roots);
    // Recovered roots without any live owner can never quiesce.
    let other = TestDirectory::new();
    let mut elected = lock(&other, armed());
    let mut recovery = elected.recover_retained();
    assert!(matches!(
        recovery.quiesce(QuiesceOperation::Repair, short(), launch()),
        Err(QuiesceError::Unsettled(_))
    ));
}
