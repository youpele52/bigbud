//! Disjoint borrows, not a background scheduler or transferable ownership.
use super::*;
use crate::guard::{GuardFence, Journal, SessionInvalidator};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub(in crate::guard::retained_recovery) struct Observation {
    requested: AtomicBool,
    unknown: AtomicBool,
    pub(super) interrupted: AtomicBool,
    /// Signal lane: every attached root settled (reaped). Not durable yet.
    pub(super) targets_settled: AtomicBool,
    /// Bounded (<=MAX_ROOTS) reaped roots awaiting durable removal. The signal
    /// lane only pushes and the storage lane only takes; neither does I/O held.
    pub(super) settled: std::sync::Mutex<Vec<crate::worker::ExecutionRoot>>,
}
impl Observation {
    pub(super) fn requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }
    pub(super) fn fail(&self) {
        self.unknown.store(true, Ordering::SeqCst);
    }
}

pub(super) struct ObserveUnwind<'a>(
    pub(super) &'a Observation,
    pub(super) &'a SessionInvalidator,
);
impl Drop for ObserveUnwind<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.requested.store(true, Ordering::SeqCst);
            self.0.interrupted.store(true, Ordering::SeqCst);
            self.0.fail();
            self.1
                .retirement_requests()
                .raise(RetirementCause::LifelineIo);
        }
    }
}

/// Exclusive signal-state borrow. Contains no lock/journal/fence capability and
/// performs no storage I/O. A caller may service it on a separate scoped thread
/// while the storage lane is blocked. No thread/cadence is created here.
///
/// Dropping/returning this lane only returns its borrow: exact owners and first
/// deadlines remain in recovery. It is NOT cancellation, retirement or shutdown.
#[must_use = "service independently of storage; returning the borrow is not settlement"]
pub struct RetirementSignalLane<'recovery> {
    dispatch: &'recovery mut Option<OwnedRetirement>,
    session: &'recovery SessionInvalidator,
    observation: &'recovery Observation,
    revoked: bool,
}

/// Exclusive storage-state borrow under the SAME retained election. It cannot
/// access/lock signal targets. Storage failure publishes sticky uncertainty,
/// without suppressing signal retries or taking their state/clock lock.
#[must_use = "persist denial separately; storage success is not admission or settlement"]
pub struct RetirementStorageLane<'recovery, 'lock> {
    pub(super) lock: &'lock crate::guard::ControllingLock,
    pub(super) fence: &'recovery mut Option<GuardFence<Journal<'lock>>>,
    pub(super) failure: &'recovery mut Option<RecoveryFailure>,
    pub(super) session: &'recovery SessionInvalidator,
    pub(super) session_attempted: &'recovery mut bool,
    pub(super) retirement_attempted: &'recovery mut bool,
    pub(super) observation: &'recovery Observation,
}

impl<'lock> RetainedRecovery<'lock> {
    /// Disjoint exclusive lanes bound to this recovery's existing lock borrow.
    /// No owned anchors, election or journal escape their lifetime. Neither lane
    /// can be publicly constructed, attach replacement roots or authorize reap.
    ///
    /// ```compile_fail
    /// use bigbud_computer_use::guard::ControllingLock;
    /// fn release(mut lock: ControllingLock) {
    ///     let mut recovery = lock.recover_retained();
    ///     let (mut signals, _storage) = recovery.split_retirement();
    ///     drop(recovery);
    ///     drop(lock);
    ///     let _ = signals.service();
    /// }
    /// ```
    /// ```compile_fail
    /// use bigbud_computer_use::guard::RetirementSignalLane;
    /// let lane = RetirementSignalLane { dispatch: todo!(), session: todo!(), observation: todo!(), revoked: true };
    /// ```
    /// ```compile_fail
    /// use bigbud_computer_use::guard::RetainedRecovery;
    /// fn detach(recovery: &mut RetainedRecovery<'_>) {
    ///     let (mut lane, _storage) = recovery.split_retirement();
    ///     std::thread::spawn(move || lane.service());
    /// }
    /// ```
    /// ```compile_fail
    /// use bigbud_computer_use::guard::RetainedRecovery;
    /// fn fake_clock(recovery: &mut RetainedRecovery<'_>) {
    ///     let (mut lane, _storage) = recovery.split_retirement();
    ///     let _ = lane.sample(Ok(u64::MAX));
    /// }
    /// ```
    /// ```compile_fail
    /// use bigbud_computer_use::guard::RetainedRecovery;
    /// fn overlap(recovery: &mut RetainedRecovery<'_>) {
    ///     let (mut first, _storage) = recovery.split_retirement();
    ///     let _second = recovery.split_retirement();
    ///     let _ = first.service();
    /// }
    /// ```
    pub fn split_retirement(
        &mut self,
    ) -> (RetirementSignalLane<'_>, RetirementStorageLane<'_, 'lock>) {
        let revoked = self.record().is_some_and(|record| record.latched);
        if self.failure.is_some() && !self.session_failure_only() {
            self.retirement_observation.fail();
        }
        (
            RetirementSignalLane {
                dispatch: &mut self.retirement,
                session: &self.session,
                observation: &self.retirement_observation,
                revoked,
            },
            RetirementStorageLane {
                lock: self.lock,
                fence: &mut self.fence,
                failure: &mut self.failure,
                session: &self.session,
                session_attempted: &mut self.session_attempted,
                retirement_attempted: &mut self.retirement_attempted,
                observation: &self.retirement_observation,
            },
        )
    }

    fn session_failure_only(&self) -> bool {
        matches!(self.failure, Some(RecoveryFailure::SessionInvalidated(_)))
    }
}

impl RetirementSignalLane<'_> {
    /// One native-clock pass (the runtime module supplies cadence/wakeup).
    /// Native syscalls have no arbitrary-stall bound.
    pub fn service(&mut self) -> Option<RetirementStatus> {
        self.sample(clock::now_ns())
    }

    /// Wait bound until the next escalation/unknown deadline, if any.
    pub(super) fn next_deadline(&self) -> Option<std::time::Duration> {
        let now = clock::now_ns().ok()?;
        let wait = self.dispatch.as_ref()?.next_deadline_ns(now)?;
        Some(std::time::Duration::from_nanos(wait))
    }

    /// Publishes durable denial for the storage lane (e.g. shutdown budget
    /// exhausted with unsettled roots). Never signals or removes roots.
    pub(super) fn require_durable_denial(&mut self) {
        self.observation.requested.store(true, Ordering::SeqCst);
    }

    pub(super) fn sample(&mut self, now: std::io::Result<u64>) -> Option<RetirementStatus> {
        let causes = self.session.retirement_requests().take_causes();
        // Orderly shutdown retires roots WITHOUT inventing a pause latch; any
        // other cause, revocation or later uncertainty latches durably.
        let latching = causes & !(RetirementCause::Shutdown as u8);
        let Some(dispatch) = self.dispatch.as_mut() else {
            // Nothing attached: causes are drained (never left to TERM a later
            // attachment) and non-shutdown causes still publish durable denial.
            if latching != 0 {
                self.observation.requested.store(true, Ordering::SeqCst);
            }
            self.observation
                .targets_settled
                .store(true, Ordering::SeqCst);
            return None;
        };
        let _on_unwind = ObserveUnwind(self.observation, self.session);
        let revoked =
            self.revoked || self.session.cause().is_some() || self.observation.requested();
        // Publish denial BEFORE settlement handoff and fallible/native signal
        // work: a disarming settlement can never precede a pending latch, and
        // a blocked signal never delays storage persisting revocation.
        if latching != 0 || revoked {
            self.observation.requested.store(true, Ordering::SeqCst);
        }
        // Natural worker death settles too; observing never signals.
        dispatch.observe_settlement(&self.observation.settled);
        if dispatch.all_settled() {
            self.observation
                .targets_settled
                .store(true, Ordering::SeqCst);
        }
        dispatch.step(causes, revoked, now);
        dispatch.status.unknown |= self.observation.unknown.load(Ordering::SeqCst);
        if dispatch.status.unknown {
            self.observation.requested.store(true, Ordering::SeqCst);
            self.observation.fail();
        }
        Some(dispatch.status)
    }
}
