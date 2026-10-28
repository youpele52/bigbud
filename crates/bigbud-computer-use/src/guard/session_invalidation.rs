//! Deny-only input, not an OS identity reader or proof of event continuity.
//! Any caller may request closure; no caller can assert an interactive session,
//! clear a cause, or produce readiness. Future native/authenticated event sources
//! must separately establish lock/logout/switch/remote-transition coverage.
use super::{PriorityRetirement, RetirementCause};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SessionInvalidationCause {
    Locked = 1,
    Logout = 2,
    UserSwitched = 3,
    DesktopLost = 4,
    RemoteTransition = 5,
    IdentityChanged = 6,
    ObservationLost = 7,
}
impl SessionInvalidationCause {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::Locked => "session_locked",
            Self::Logout => "session_logout",
            Self::UserSwitched => "session_user_switched",
            Self::DesktopLost => "session_desktop_lost",
            Self::RemoteTransition => "session_remote_transition",
            Self::IdentityChanged => "session_identity_changed",
            Self::ObservationLost => "session_observation_lost",
        }
    }
}

/// Cloneable closure-only handle belonging to one retained recovery lifetime.
/// Does not accept UID/session snapshots as authority. Unlock/reconnect is not
/// an operation: once raised, even an identical later identity cannot clear it.
/// Dropping all handles does not clear the recovery's retained copy.
#[derive(Clone)]
pub struct SessionInvalidator {
    first: Arc<AtomicU8>,
    retirement: PriorityRetirement,
    #[cfg(test)]
    checkpoint: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl SessionInvalidator {
    pub(super) fn new() -> Self {
        Self {
            first: Arc::new(AtomicU8::new(0)),
            retirement: PriorityRetirement::default(),
            #[cfg(test)]
            checkpoint: None,
        }
    }

    /// Nonblocking, bounded, no journal I/O or data-queue capacity needed. The
    /// guard must independently service retirement and flush durable invalidation;
    /// raising this request does not prove root death or durable acknowledgement.
    pub fn invalidate(&self, cause: SessionInvalidationCause) {
        self.retirement.revoke();
        #[cfg(test)]
        self.publication_checkpoint();
        // Keep the first cause even if later events coalesce or arrive after an
        // unlock. Losing this race only means another invalidation is retained.
        let _previous =
            self.first
                .compare_exchange(0, cause as u8, Ordering::SeqCst, Ordering::SeqCst);
        #[cfg(test)]
        self.publication_checkpoint();
        // Publish only after retaining the cause: a consumer may drain and flush
        // immediately. SeqCst alone cannot fix notification-before-state order.
        self.retirement.raise(RetirementCause::SessionInvalidated);
        #[cfg(test)]
        self.publication_checkpoint();
    }

    #[cfg(test)]
    fn publication_checkpoint(&self) {
        if let Some(checkpoint) = &self.checkpoint {
            checkpoint();
        }
    }

    /// Existing reserved retirement channel, never execution/Resume authority.
    /// Draining wakeups does not consume the retained invalidation cause.
    pub fn retirement_requests(&self) -> PriorityRetirement {
        self.retirement.clone()
    }

    pub(crate) fn cause(&self) -> Option<SessionInvalidationCause> {
        match self.first.load(Ordering::SeqCst) {
            0 => None,
            1 => Some(SessionInvalidationCause::Locked),
            2 => Some(SessionInvalidationCause::Logout),
            3 => Some(SessionInvalidationCause::UserSwitched),
            4 => Some(SessionInvalidationCause::DesktopLost),
            5 => Some(SessionInvalidationCause::RemoteTransition),
            6 => Some(SessionInvalidationCause::IdentityChanged),
            // Only private, typed writes exist. Conservatively refuse even an
            // unexpected value rather than interpreting it as continuity.
            _ => Some(SessionInvalidationCause::ObservationLost),
        }
    }
}

#[cfg(test)]
#[path = "session_invalidation.tests.rs"]
mod tests;
