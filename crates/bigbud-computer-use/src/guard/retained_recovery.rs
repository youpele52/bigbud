//! Storage prerequisite only: no interactive-login, launch or Resume authority.
#[path = "retained_retirement/mod.rs"]
mod retirement;
pub use retirement::{
    AttachRetirementError, AttachRetirementFailure, GRACEFUL_SHUTDOWN, GuardServiceConfig,
    GuardServiceConfigError, GuardServiceControl, GuardServiceExit, GuardServiceReport,
    GuardStatusSnapshot, MAX_CADENCE, QuiesceError, QuiesceOperation, QuiescedReplacement,
    RetirementSignalLane, RetirementStatus, RetirementStorageLane,
};

use super::{
    ControllingLock, FenceError, GuardFence, Journal, JournalError, SessionInvalidationCause,
    SessionInvalidator, record::SafetyRecord,
};

#[derive(Debug)]
pub enum RecoveryFailure {
    Read(JournalError),
    Fence(FenceError<JournalError>),
    Changed,
    Unsettled,
    Interrupted,
    SessionInvalidated(SessionInvalidationCause),
}

/// Exclusively borrows the elected lock through recovery AND failure. No mutable
/// record, journal, lock, Clone, clear-pause or settlement escape is exposed.
/// Dropping this value does not drop the caller's lock or change durable state.
/// All recovered roots remain unsettled: absence/reuse of a leader PID is NOT
/// proof that its known helper closure ended, and never grants signal authority.
///
/// ```compile_fail
/// use bigbud_computer_use::guard::ControllingLock;
/// fn release_early(mut lock: ControllingLock) {
///     let recovery = lock.recover_retained();
///     drop(lock);
///     let _ = recovery.record();
/// }
/// ```
/// ```compile_fail
/// use bigbud_computer_use::guard::ControllingLock;
/// fn bypass(mut lock: ControllingLock) {
///     let recovery = lock.recover_retained();
///     let _ = lock.journal().replace(&bigbud_computer_use::guard::record::SafetyRecord::initial());
///     let _ = recovery.record();
/// }
/// ```
/// ```compile_fail
/// use bigbud_computer_use::guard::RetainedRecovery;
/// let recovery = RetainedRecovery { lock: todo!(), fence: None, failure: None };
/// ```
#[must_use = "retain election and inspect recovery failure; storage is not admission"]
pub struct RetainedRecovery<'lock> {
    pub(super) identity: super::interactive_identity::IdentityBinding,
    lock: &'lock ControllingLock,
    fence: Option<GuardFence<Journal<'lock>>>,
    failure: Option<RecoveryFailure>,
    pub(super) session: SessionInvalidator,
    session_attempted: bool,
    retirement: Option<retirement::OwnedRetirement>,
    retirement_attempted: bool,
    retirement_observation: retirement::Observation,
}

/// Dropping a recovery invalidates every permit it issued.
impl Drop for RetainedRecovery<'_> {
    fn drop(&mut self) {
        self.lock
            .launch_fence
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl ControllingLock {
    /// Explicit dormant recovery I/O under the same retained election. The
    /// exclusive borrow prevents other safe callers mutating its journal during
    /// recovery. Even unreadable/corrupt state returns an owner, not an error that
    /// accidentally releases the election. No role currently invokes this.
    pub fn recover_retained(&mut self) -> RetainedRecovery<'_> {
        let mut recovery = RetainedRecovery {
            identity: super::interactive_identity::IdentityBinding::default(),
            lock: self,
            fence: None,
            failure: None,
            session: SessionInvalidator::new(),
            session_attempted: false,
            retirement: None,
            retirement_attempted: false,
            retirement_observation: retirement::Observation::default(),
        };
        // A new recovery invalidates every permit issued under an older one.
        self.launch_fence
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let record = match self.journal().read() {
            Ok(Some(record)) => record,
            Ok(None) => SafetyRecord::initial(),
            Err(error) => {
                recovery.failure = Some(RecoveryFailure::Read(error));
                return recovery;
            }
        };
        recovery.restore(record);
        recovery
    }
}

impl<'lock> RetainedRecovery<'lock> {
    /// Election-wide launch fence (see ControllingLock::launch_fence).
    pub(crate) fn launch_fence(&self) -> &std::sync::Arc<std::sync::atomic::AtomicU64> {
        &self.lock.launch_fence
    }

    fn restore(&mut self, record: SafetyRecord) {
        let mut fence = match GuardFence::from_recovered(record, self.lock.journal()) {
            Ok(fence) => fence,
            Err(error) => {
                self.failure = Some(RecoveryFailure::Fence(error));
                return;
            }
        };
        // Reuse the existing revoke-before-I/O fence, including overflow and
        // persistence failure behavior. No PID observations can prune roots here.
        let result = if fence.record().armed {
            fence.revoke("unclean_recovery").map(|_| ())
        } else {
            // Missing state durably starts latched. Clean state preserves its
            // existing latch/epoch; this does not make it admission-ready.
            fence.persist()
        };
        self.failure = result.err().map(RecoveryFailure::Fence);
        self.fence = Some(fence);
    }

    pub fn record(&self) -> Option<&SafetyRecord> {
        self.fence.as_ref().map(GuardFence::record)
    }

    pub fn failure(&self) -> Option<&RecoveryFailure> {
        self.failure.as_ref()
    }

    /// A denial-only signal bound to this recovery, never identity authority.
    /// No OS event source is connected yet. This handle alone cannot establish
    /// lock/logout detection, event continuity, or current desktop readiness.
    pub fn session_invalidator(&self) -> SessionInvalidator {
        self.session.clone()
    }

    /// First reported invalidation, retained even before durable processing.
    pub fn session_invalidation(&self) -> Option<SessionInvalidationCause> {
        self.session.cause()
    }

    /// Service once on the guard's independent lane, not the execution queue.
    /// The handle already raised priority retirement without I/O. This method
    /// latches memory before storage reads, then durably revokes only unchanged,
    /// previously healthy recovery. Prior failures never retry or overwrite
    /// ambiguous bytes. Failure stays sticky, even after unlock/reconnect.
    /// An Ok with no pending signal is NOT session health/continuity evidence.
    pub fn flush_session_invalidation(&mut self) -> Result<(), &RecoveryFailure> {
        let _result = self.split_retirement().1.flush_session_invalidation();
        self.storage_result()
    }

    /// Rechecks the retained root/lock/journal identities AND exact record bytes
    /// via the canonical decoder. Failure is sticky for this recovery lifetime,
    /// even if a name, permission or contents are later restored. No retry can
    /// erase a failed persistence acknowledgement or epoch exhaustion.
    ///
    /// Success means only a current, durably acknowledged, root-free storage
    /// prerequisite. Pause/input uncertainty remain untouched. Interactive login,
    /// image, process-wide launch exclusion and FD allow-set are still required;
    /// BootstrapPermit remains unavailable and this cannot open admission.
    pub fn verify_storage(&mut self) -> Result<(), &RecoveryFailure> {
        let _result = self.split_retirement().1.verify();
        self.storage_result()
    }

    fn storage_result(&self) -> Result<(), &RecoveryFailure> {
        match &self.failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "retained_recovery.session_tests.rs"]
mod session_tests;
#[cfg(test)]
#[path = "retained_recovery.tests.rs"]
mod tests;
