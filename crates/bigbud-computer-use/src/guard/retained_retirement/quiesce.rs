//! Installer/update/repair/reset/restart ownership fence. Replacement may
//! proceed only while holding `QuiescedReplacement`, which exists only after an
//! orderly shutdown settled AND durably removed every attached root, and which
//! exclusively borrows the recovery (no attach/issue/spawn meanwhile). Quiescing
//! never clears pause/latch, Resume, or authorizes replay of any operation.
use super::*;
use crate::{guard::record::SafetyRecord, worker::unix::LaunchGuard};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuiesceOperation {
    Install,
    Update,
    Repair,
    Reset,
    Restart,
}

#[derive(Debug)]
pub enum QuiesceError {
    /// Roots/owners retained; replacement must not proceed.
    Unsettled(GuardServiceReport),
    Storage,
}

/// ```compile_fail
/// use bigbud_computer_use::guard::{GuardServiceConfig, QuiesceOperation, RetainedRecovery};
/// use bigbud_computer_use::worker::unix::LaunchGuard;
/// fn overlap(recovery: &mut RetainedRecovery<'_>, launch: LaunchGuard) {
///     let fence = recovery.quiesce(QuiesceOperation::Update, GuardServiceConfig::default(), launch);
///     let _ = recovery.verify_storage();
///     drop(fence);
/// }
/// ```
#[must_use = "hold for the whole replacement; dropping it ends the fence"]
pub struct QuiescedReplacement<'recovery, 'lock> {
    recovery: &'recovery mut RetainedRecovery<'lock>,
    operation: QuiesceOperation,
    /// Held for the whole fence: no launch can run during replacement.
    _launch: LaunchGuard,
}
impl QuiescedReplacement<'_, '_> {
    pub fn operation(&self) -> QuiesceOperation {
        self.operation
    }
    /// Durable record as fenced: root-free; pause/latch exactly preserved.
    pub fn record(&self) -> Option<&SafetyRecord> {
        self.recovery.record()
    }
}

impl<'lock> RetainedRecovery<'lock> {
    /// Takes the already-acquired process launch exclusion and invalidates
    /// every outstanding permit before retiring roots.
    pub fn quiesce(
        &mut self,
        operation: QuiesceOperation,
        config: GuardServiceConfig,
        launch: LaunchGuard,
    ) -> Result<QuiescedReplacement<'_, 'lock>, QuiesceError> {
        self.launch_fence()
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let control = GuardServiceControl::default();
        control.request_shutdown();
        let report = self.run_guard_service(&control, config);
        if report.exit != GuardServiceExit::ShutdownSettled {
            return Err(QuiesceError::Unsettled(report));
        }
        // A retained session invalidation does not block replacement (which
        // never authorizes Resume); any other storage failure does.
        let storage = match self.verify_storage() {
            Ok(()) | Err(RecoveryFailure::SessionInvalidated(_)) => true,
            Err(_) => false,
        };
        if !storage || self.record().is_none_or(|record| !record.roots.is_empty()) {
            return Err(QuiesceError::Storage);
        }
        Ok(QuiescedReplacement {
            recovery: self,
            operation,
            _launch: launch,
        })
    }
}
