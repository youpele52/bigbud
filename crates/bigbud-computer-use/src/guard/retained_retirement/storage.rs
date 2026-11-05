use super::{
    lanes::{ObserveUnwind, RetirementStorageLane},
    *,
};
use crate::guard::GuardFence;
use std::sync::atomic::Ordering;

impl RetirementStorageLane<'_, '_> {
    fn record(&self) -> Option<&crate::guard::record::SafetyRecord> {
        self.fence.as_ref().map(GuardFence::record)
    }

    fn retain_interruption(&mut self) {
        if self.failure.is_none() && self.observation.interrupted.load(Ordering::SeqCst) {
            *self.failure = Some(RecoveryFailure::Interrupted);
        }
    }

    fn result(&mut self) -> Result<(), &RecoveryFailure> {
        self.retain_interruption();
        if let Some(error) = self.failure.as_ref() {
            if !matches!(error, RecoveryFailure::SessionInvalidated(_)) {
                self.observation.fail();
            }
            Err(error)
        } else {
            Ok(())
        }
    }

    /// Memory latch precedes storage inspection. Every error remains sticky;
    /// never retry/repair ambiguous storage or overwrite a changed record.
    pub fn flush_session_invalidation(&mut self) -> Result<(), &RecoveryFailure> {
        let _on_unwind = ObserveUnwind(self.observation, self.session);
        self.retain_interruption();
        if let Some(cause) = self.session.cause()
            && !*self.session_attempted
        {
            *self.session_attempted = true;
            if let Some(fence) = self.fence.as_mut() {
                let previous = fence.record().clone();
                fence.latch();
                if self.failure.is_none() {
                    *self.failure = Some(match self.lock.journal().read() {
                        Ok(Some(record)) if record == previous => {
                            match fence.revoke(cause.reason()) {
                                Ok(_) => RecoveryFailure::SessionInvalidated(cause),
                                Err(error) => RecoveryFailure::Fence(error),
                            }
                        }
                        Ok(_) => RecoveryFailure::Changed,
                        Err(error) => RecoveryFailure::Read(error),
                    });
                }
            }
        }
        self.result()
    }

    /// Durable priority denial without taking the signal lane or any dispatch
    /// lock. A signal syscall/clock stall cannot prevent this publication/flush;
    /// conversely journal I/O cannot exclusively borrow signal state.
    pub fn flush(&mut self) -> Result<(), &RecoveryFailure> {
        let _on_unwind = ObserveUnwind(self.observation, self.session);
        let _session_result = self.flush_session_invalidation();
        if self.observation.requested() && !*self.retirement_attempted {
            *self.retirement_attempted = true;
            if let Some(fence) = self.fence.as_mut() {
                let previous = fence.record().clone();
                fence.latch();
                if self.failure.is_none() {
                    *self.failure = match self.lock.journal().read() {
                        Ok(Some(record)) if record == previous => fence
                            .revoke("priority_retirement")
                            .err()
                            .map(RecoveryFailure::Fence),
                        Ok(_) => Some(RecoveryFailure::Changed),
                        Err(error) => Some(RecoveryFailure::Read(error)),
                    };
                }
            }
        }
        self.persist_settlement();
        self.result()
    }

    /// Durably removes reaped roots under an unchanged journal. Any other
    /// prior failure leaves them recorded (next recovery stays unsettled).
    fn persist_settlement(&mut self) {
        if !matches!(
            self.failure,
            None | Some(RecoveryFailure::SessionInvalidated(_))
        ) {
            return;
        }
        let Some(fence) = self.fence.as_mut() else {
            return;
        };
        let pending = std::mem::take(
            &mut *self
                .observation
                .settled
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        if pending.is_empty() {
            return;
        }
        let previous = fence.record().clone();
        let failure = match self.lock.journal().read() {
            Ok(Some(record)) if record == previous => fence
                .settle_roots(&pending)
                .err()
                .map(RecoveryFailure::Fence),
            Ok(_) => Some(RecoveryFailure::Changed),
            Err(error) => Some(RecoveryFailure::Read(error)),
        };
        if failure.is_some() {
            *self.failure = failure;
        }
    }

    /// Storage view of completed retirement: every attached root reaped AND
    /// durably removed. Not admission, Resume or neutral-input evidence.
    pub fn settlement_persisted(&self) -> bool {
        self.observation.targets_settled.load(Ordering::SeqCst)
            && self
                .failure
                .as_ref()
                .is_none_or(|failure| matches!(failure, RecoveryFailure::SessionInvalidated(_)))
            && self.record().is_some_and(|record| record.roots.is_empty())
    }

    /// Only root-free, unchanged, durably recovered storage can verify. This is
    /// NOT current interactive-session evidence or permission to open admission.
    pub fn verify(&mut self) -> Result<(), &RecoveryFailure> {
        let _on_unwind = ObserveUnwind(self.observation, self.session);
        let _session_result = self.flush_session_invalidation();
        if self.failure.is_none() {
            *self.failure = match self.lock.journal().read() {
                Ok(Some(record)) if Some(&record) == self.record() => {
                    if record.roots.is_empty() {
                        None
                    } else {
                        Some(RecoveryFailure::Unsettled)
                    }
                }
                Ok(_) => Some(RecoveryFailure::Changed),
                Err(error) => Some(RecoveryFailure::Read(error)),
            };
        }
        self.result()
    }
}
