use super::*;

impl RetainedRecovery<'_> {
    /// Compatibility convenience for a single immediate native-clock step. To
    /// service concurrently with journal I/O, use split_retirement() instead.
    /// None means no attached owners, never root-free/ready. No successful signal
    /// grants settlement. Duplicate requests/reborrows never reset deadlines.
    ///
    /// External callers cannot supply synthetic clock evidence:
    /// ```compile_fail
    /// use bigbud_computer_use::guard::RetainedRecovery;
    /// fn fake_clock(recovery: &mut RetainedRecovery<'_>) {
    ///     let _ = recovery.service_retirement_sample(Ok(u64::MAX));
    /// }
    /// ```
    pub fn service_retirement(&mut self) -> Option<RetirementStatus> {
        self.split_retirement().0.service()
    }

    #[cfg(test)]
    pub(super) fn service_retirement_sample(
        &mut self,
        now: std::io::Result<u64>,
    ) -> Option<RetirementStatus> {
        self.split_retirement().0.sample(now)
    }

    /// Storage-only convenience. Use split_retirement() to retain independent
    /// signal access throughout a possibly stalled synchronous flush.
    pub fn flush_retirement_invalidation(&mut self) -> Result<(), &RecoveryFailure> {
        let _result = self.split_retirement().1.flush();
        self.storage_result()
    }
}
