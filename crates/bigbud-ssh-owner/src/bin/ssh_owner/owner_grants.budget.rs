//! Owner-wide admission budget with capacity reserved for interactive work.
//!
//! One grant is admitted at issue time and released at consume, expiry or
//! revocation, so the budget is a **grant-issuance bound**, not a live
//! concurrent-session count. A serialized client settles under the cap.
//! Background work may never consume the interactive reserve. An exhausted
//! budget is `SessionQuota`, which is distinct from authentication and from an
//! unavailable owner.
//!
//! `sshd`'s `MaxSessions` refusal is a destination-side form of the same
//! condition. It maps to `SessionQuota` at the transport boundary and never to
//! `AuthRequired`.

use crate::v1::{ErrorCode, request::Operation};

const DEFAULT_CAPACITY: usize = 32;
const DEFAULT_INTERACTIVE_RESERVE: usize = 8;
const MIN_CAPACITY: usize = 2;
const MAX_CAPACITY: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Class {
    /// Connect, trust, folders and the terminal lane.
    Interactive,
    /// Workspace, Git, deployment, providers and relays.
    Background,
}

impl Class {
    pub(super) fn of(operation: &Operation) -> Self {
        match operation {
            Operation::InspectTrust(_)
            | Operation::ApproveTrust(_)
            | Operation::Connect(_)
            | Operation::Disconnect(_)
            | Operation::ListFolders(_)
            | Operation::ListAliases(_)
            | Operation::ProofOpenTerminal(_)
            | Operation::ProofTerminalStatus(_)
            | Operation::ProofCloseTerminal(_)
            | Operation::ProofTerminalInput(_)
            | Operation::ProofTerminalResize(_)
            | Operation::ProofPrepareTerminal(_)
            | Operation::ProofCancelTerminalReservation(_)
            | Operation::ProofTerminalReplay(_)
            | Operation::ProofTerminalCwd(_)
            | Operation::ProofUnlockSyntheticPosixPassword(_)
            | Operation::ProofRunAcpCommand(_) => Self::Interactive,
            _ => Self::Background,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Budget {
    capacity: usize,
    reserve: usize,
    interactive: usize,
    background: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY, DEFAULT_INTERACTIVE_RESERVE)
    }
}

impl Budget {
    pub(super) const fn new(capacity: usize, reserve: usize) -> Self {
        let reserve = if reserve < capacity {
            reserve
        } else {
            capacity
        };
        Self {
            capacity,
            reserve,
            interactive: 0,
            background: 0,
        }
    }

    /// Fixture-only capacity override. An invalid or absent value keeps the
    /// production default, so a normal startup cannot disable admission.
    pub(crate) fn from_startup_env() -> Self {
        let raw = std::env::var("BIGBUD_SSH_OWNER_SESSION_BUDGET_PROOF").ok();
        Self::from_fixture_capacity(raw.as_deref())
    }

    /// Fixture override when dev; production always uses the default bound budget.
    pub(crate) fn for_startup(production: bool) -> Self {
        if production {
            Self::default()
        } else {
            Self::from_startup_env()
        }
    }

    fn from_fixture_capacity(raw: Option<&str>) -> Self {
        let Some(capacity) = raw
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (MIN_CAPACITY..=MAX_CAPACITY).contains(value))
        else {
            return Self::default();
        };
        Self::new(capacity, DEFAULT_INTERACTIVE_RESERVE.min(capacity / 2))
    }

    pub(super) fn admit(&mut self, class: Class) -> Result<(), ErrorCode> {
        if self.interactive + self.background >= self.capacity {
            return Err(ErrorCode::SessionQuota);
        }
        match class {
            Class::Interactive => {
                self.interactive += 1;
                Ok(())
            }
            Class::Background if self.background < self.capacity - self.reserve => {
                self.background += 1;
                Ok(())
            }
            Class::Background => Err(ErrorCode::SessionQuota),
        }
    }

    pub(super) fn release(&mut self, class: Class) {
        match class {
            Class::Interactive => self.interactive = self.interactive.saturating_sub(1),
            Class::Background => self.background = self.background.saturating_sub(1),
        }
    }

    #[cfg(test)]
    pub(super) fn active(&self, class: Class) -> usize {
        match class {
            Class::Interactive => self.interactive,
            Class::Background => self.background,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::owner_grants::{Binding, Grants};
    use crate::v1::{Empty, ListFolders, ProofWorkspaceIndex, Request};

    fn request(id: u8) -> Request {
        Request {
            request_id: vec![id],
            target_id: "ssh:fixture".into(),
            ..Request::default()
        }
    }

    fn binding() -> Binding {
        Binding {
            target_id: "ssh:fixture".into(),
            generation: Vec::new(),
        }
    }

    fn list() -> Operation {
        Operation::ListFolders(ListFolders { path: None })
    }

    fn index() -> Operation {
        Operation::ProofWorkspaceIndex(ProofWorkspaceIndex {
            workspace_root: "/fixture/root".into(),
        })
    }

    #[test]
    fn budget_reserves_interactive_capacity_and_never_underflows() {
        let mut budget = Budget::new(4, 2);
        assert_eq!(budget.admit(Class::Background), Ok(()));
        assert_eq!(budget.admit(Class::Background), Ok(()));
        assert_eq!(
            budget.admit(Class::Background),
            Err(ErrorCode::SessionQuota)
        );
        // The reserve stays available to interactive work.
        assert_eq!(budget.admit(Class::Interactive), Ok(()));
        assert_eq!(budget.admit(Class::Interactive), Ok(()));
        assert_eq!(
            budget.admit(Class::Interactive),
            Err(ErrorCode::SessionQuota)
        );
        assert_eq!(budget.active(Class::Interactive), 2);
        assert_eq!(budget.active(Class::Background), 2);
        budget.release(Class::Interactive);
        budget.release(Class::Interactive);
        budget.release(Class::Interactive);
        assert_eq!(budget.active(Class::Interactive), 0);
        assert_eq!(budget.admit(Class::Interactive), Ok(()));
    }

    #[test]
    fn budget_classifies_interactive_and_background_operations() {
        assert_eq!(Class::of(&list()), Class::Interactive);
        assert_eq!(Class::of(&Operation::Connect(Empty {})), Class::Interactive);
        assert_eq!(
            Class::of(&Operation::ProofUnlockSyntheticPosixPassword(Empty {})),
            Class::Interactive
        );
        assert_eq!(Class::of(&index()), Class::Background);
        assert_eq!(
            Class::of(&Operation::ProofSampleHealth(Empty {})),
            Class::Background
        );
    }

    #[test]
    fn budget_is_released_when_a_grant_is_consumed_expired_or_revoked() {
        let now = Instant::now();
        let mut grants = Grants::new(Budget::new(4, 2));
        let mut first = request(1);
        first.grant = grants
            .issue(&first, binding(), index(), now)
            .unwrap()
            .to_vec();
        let mut second = request(2);
        second.grant = grants
            .issue(&second, binding(), index(), now)
            .unwrap()
            .to_vec();
        let mut interactive = request(3);
        interactive.grant = grants
            .issue(&interactive, binding(), list(), now)
            .unwrap()
            .to_vec();
        assert_eq!(grants.budget.active(Class::Background), 2);
        assert_eq!(grants.budget.active(Class::Interactive), 1);

        // Consume releases the background slot.
        assert_eq!(grants.consume(&first, index(), now), Ok(binding()));
        assert_eq!(grants.budget.active(Class::Background), 1);

        // Expiry releases the interactive slot without a consume.
        assert_eq!(
            grants.consume(
                &interactive,
                list(),
                now + std::time::Duration::from_secs(16)
            ),
            Err(ErrorCode::OperationDenied)
        );
        assert_eq!(grants.budget.active(Class::Interactive), 0);

        // Revocation releases every pending slot.
        grants.revoke_pending();
        assert_eq!(grants.budget.active(Class::Background), 0);
        assert_eq!(grants.budget.active(Class::Interactive), 0);
        let _ = second;
    }

    #[test]
    fn budget_exhaustion_is_session_quota_not_owner_unavailable() {
        let now = Instant::now();
        let mut grants = Grants::new(Budget::new(4, 2));
        for id in 1..=2 {
            let mut request = request(id);
            request.grant = grants
                .issue(&request, binding(), index(), now)
                .unwrap()
                .to_vec();
        }
        let blocked = request(3);
        assert_eq!(
            grants.issue(&blocked, binding(), index(), now),
            Err(ErrorCode::SessionQuota)
        );
        // Interactive capacity is still admitted on the same owner.
        let interactive = request(4);
        assert!(grants.issue(&interactive, binding(), list(), now).is_ok());
    }

    #[test]
    fn budget_fixture_override_keeps_a_safe_default() {
        for (raw, expected) in [
            (None, DEFAULT_CAPACITY),
            (Some("0"), DEFAULT_CAPACITY),
            (Some("1"), DEFAULT_CAPACITY),
            (Some("129"), DEFAULT_CAPACITY),
            (Some("nope"), DEFAULT_CAPACITY),
            (Some("2"), 2),
            (Some("8"), 8),
        ] {
            assert_eq!(
                Budget::from_fixture_capacity(raw).capacity,
                expected,
                "{raw:?}"
            );
        }
    }
}
