use super::*;

impl RetainedRecovery<'_> {
    /// Takes only inseparably spawned, privately retained direct-child anchors.
    /// Exact durable PID/creation/generation and order must match before attach;
    /// recovered PID metadata alone cannot construct these owners. No role calls
    /// this dormant path yet. No successful helper-closure proof exists.
    ///
    /// Root metadata cannot substitute for private live ownership:
    /// ```compile_fail
    /// use bigbud_computer_use::{guard::RetainedRecovery, worker::ExecutionRoot};
    /// fn forge(recovery: &mut RetainedRecovery<'_>, roots: Vec<ExecutionRoot>) {
    ///     let _ = recovery.attach_retirement(roots);
    /// }
    /// ```
    pub fn attach_retirement(
        &mut self,
        anchors: Vec<AnchoredGroup>,
    ) -> Result<(), AttachRetirementError> {
        let failure = self.check_retirement_targets(anchors.iter().map(AnchoredGroup::root));
        if let Err(failure) = failure {
            return Err(AttachRetirementError { anchors, failure });
        }
        self.retirement = Some(OwnedRetirement::new(
            anchors.into_iter().map(Target::Owned).collect(),
        ));
        self.retirement_observation
            .targets_settled
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    pub(super) fn check_retirement_targets<'a>(
        &mut self,
        roots: impl Iterator<Item = &'a crate::worker::ExecutionRoot>,
    ) -> Result<(), AttachRetirementFailure> {
        if self.retirement.is_some() {
            return Err(AttachRetirementFailure::AlreadyAttached);
        }
        let Some(record) = self.record() else {
            return Err(AttachRetirementFailure::Storage);
        };
        if record.roots.is_empty() || !roots.eq(record.roots.iter()) {
            return Err(AttachRetirementFailure::RootMismatch);
        }
        match self.lock.journal().read() {
            Ok(Some(record)) if Some(&record) == self.record() => Ok(()),
            result => {
                if let Some(fence) = &mut self.fence {
                    fence.latch();
                }
                self.session
                    .retirement_requests()
                    .raise(RetirementCause::LifelineIo);
                if self.failure.is_none() {
                    self.failure = Some(match result {
                        Err(error) => RecoveryFailure::Read(error),
                        _ => RecoveryFailure::Changed,
                    });
                }
                Err(AttachRetirementFailure::Storage)
            }
        }
    }
}
