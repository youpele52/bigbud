//! Sampled identity only. No lock detector, transition history, lease or permit.
mod framework;
mod snapshot;
use super::{RetainedRecovery, SessionInvalidationCause, SessionInvalidator};
pub use snapshot::{InteractiveSnapshot, SnapshotError};

#[derive(Default)]
pub(super) struct IdentityBinding(Option<InteractiveSnapshot>);
impl IdentityBinding {
    fn observe(
        &mut self,
        sample: Result<InteractiveSnapshot, SnapshotError>,
        invalidator: &SessionInvalidator,
    ) -> Result<(), SnapshotError> {
        let sample = match sample {
            Ok(sample) => sample,
            Err(error) => {
                invalidator.invalidate(SessionInvalidationCause::ObservationLost);
                return Err(error);
            }
        };
        if invalidator.cause().is_some() {
            return Err(SnapshotError::Invalidated);
        }
        if self.0.as_ref().is_some_and(|prior| *prior != sample) {
            invalidator.invalidate(SessionInvalidationCause::IdentityChanged);
            return Err(SnapshotError::Changed);
        }
        self.0 = Some(sample);
        Ok(())
    }
}
impl RetainedRecovery<'_> {
    /// Explicit dormant framework query, never called by roles or construction.
    /// Success binds one sampled login/console identity to this recovery only.
    /// Security membership + CG console samples cannot prove unlocked state or
    /// lossless logout/login ABA/remote-transition continuity. Even repeated
    /// identical samples cannot open BootstrapPermit, admission or Resume.
    /// Errors/changes raise existing deny-only retirement before any journal I/O;
    /// the independent storage lane still must flush the retained cause.
    pub fn sample_interactive_identity(&mut self) -> Result<(), SnapshotError> {
        self.identity.observe(snapshot::read(), &self.session)
    }

    /// Issuer prerequisite only: one bound sample and no retained invalidation.
    /// Still NOT unlocked-state, continuity or admission evidence.
    pub(crate) fn interactive_identity_bound(&self) -> bool {
        self.identity.0.is_some() && self.session.cause().is_none()
    }

    #[cfg(test)]
    pub(crate) fn bind_fixture_identity(&mut self) -> Result<(), SnapshotError> {
        self.identity
            .observe(Ok(snapshot::fixture_sample()), &self.session)
    }
}

#[cfg(test)]
mod tests;
