//! Trusted per-caller authority projection (server-supplied thread/provider
//! generation and runtime-mode revision), revoked independently of the data
//! queue. Tickets carry the caller epoch at admission; every helper dispatch
//! rechecks it with pause/policy/control/worker/deadline state. A model-sent
//! flag has no route here: only the authenticated server projection updates it.
use super::{limits::MAX_CALLER_SESSIONS, session::CallerSession};
use crate::guard::record::valid_id;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Caller {
    /// None for a revocation tombstone that arrived before any projection.
    provider_generation: Option<String>,
    runtime_mode_revision: u64,
    full_access: bool,
    epoch: u64,
    /// Projections at or below this revision are refused (revoke-before-project).
    revoked_through: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchRefusal {
    Paused,
    PolicyPending,
    ControlUnavailable,
    WorkerReplaced,
    AuthorityConflict,
    FullAccessRequired,
    DeadlineExceeded,
    CallerCapacity,
}
impl DispatchRefusal {
    /// Frozen public v2 error codes; never carry identities or content.
    pub fn code(self) -> &'static str {
        match self {
            Self::Paused => "paused",
            Self::PolicyPending => "policy_pending",
            Self::ControlUnavailable => "control_unavailable",
            Self::WorkerReplaced => "retirement_unknown",
            Self::AuthorityConflict => "authority_conflict",
            Self::FullAccessRequired => "authority_conflict",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::CallerCapacity => "queue_full",
        }
    }
}

/// Keyed by the ledger's owner-issued, never-reused `CallerSession`, which
/// only `Ledger::session` lends while the session is live: once retired (and
/// forgotten here) no projection or revocation can name it again.
#[derive(Default)]
pub struct AuthorityTable {
    callers: BTreeMap<String, Caller>,
    /// Table-wide and never reset (not even by `forget`): every epoch handed
    /// out is unique, so no stamp can ever match a later projection.
    last_epoch: u64,
    /// Epoch space exhausted: every projection and dispatch refuses forever.
    exhausted: bool,
}
impl AuthorityTable {
    fn fresh_epoch(&mut self) -> Result<u64, DispatchRefusal> {
        match self.last_epoch.checked_add(1) {
            Some(epoch) if !self.exhausted => {
                self.last_epoch = epoch;
                Ok(epoch)
            }
            _ => {
                self.exhausted = true;
                Err(DispatchRefusal::AuthorityConflict)
            }
        }
    }

    /// Server projection. A newer revision always yields a fresh epoch,
    /// invalidating every outstanding ticket; an identical projection is
    /// idempotent; a conflicting one at the same revision refuses.
    pub fn project(
        &mut self,
        session: &CallerSession,
        provider_generation: &str,
        runtime_mode_revision: u64,
        full_access: bool,
    ) -> Result<u64, DispatchRefusal> {
        let caller = session.as_str();
        if !valid_id(caller) || !valid_id(provider_generation) || self.exhausted {
            return Err(DispatchRefusal::AuthorityConflict);
        }
        let projected = Some(provider_generation.to_string());
        if let Some(entry) = self.callers.get(caller) {
            let revoked = entry
                .revoked_through
                .is_some_and(|through| runtime_mode_revision <= through);
            if revoked || runtime_mode_revision < entry.runtime_mode_revision {
                return Err(DispatchRefusal::AuthorityConflict);
            }
            if runtime_mode_revision == entry.runtime_mode_revision {
                let same =
                    entry.provider_generation == projected && entry.full_access == full_access;
                return same
                    .then_some(entry.epoch)
                    .ok_or(DispatchRefusal::AuthorityConflict);
            }
        } else if self.callers.len() >= MAX_CALLER_SESSIONS {
            return Err(DispatchRefusal::CallerCapacity);
        }
        let epoch = self.fresh_epoch()?;
        let revoked_through = self.callers.get(caller).and_then(|c| c.revoked_through);
        self.callers.insert(
            caller.into(),
            Caller {
                provider_generation: projected,
                runtime_mode_revision,
                full_access,
                epoch,
                revoked_through,
            },
        );
        Ok(epoch)
    }

    /// RevokeCaller: closes the caller now, before any queue processing, and
    /// refuses every projection at or below `through_revision` afterwards,
    /// including one delayed behind a revocation for a not-yet-known caller.
    /// Refuses (CallerCapacity) only when an unknown caller cannot be recorded.
    pub fn revoke(
        &mut self,
        session: &CallerSession,
        through_revision: u64,
    ) -> Result<(), DispatchRefusal> {
        let caller = session.as_str();
        if !valid_id(caller) {
            return Err(DispatchRefusal::AuthorityConflict);
        }
        if !self.callers.contains_key(caller) && self.callers.len() >= MAX_CALLER_SESSIONS {
            return Err(DispatchRefusal::CallerCapacity);
        }
        // Exhaustion already refuses every dispatch; still record the revocation.
        let epoch = self.fresh_epoch().unwrap_or(0);
        let entry = self.callers.entry(caller.into()).or_insert(Caller {
            provider_generation: None,
            runtime_mode_revision: through_revision,
            full_access: false,
            epoch,
            revoked_through: None,
        });
        let through = through_revision.max(entry.runtime_mode_revision);
        entry.revoked_through = Some(entry.revoked_through.map_or(through, |r| r.max(through)));
        entry.full_access = false;
        entry.epoch = epoch;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn near_exhaustion() -> Self {
        Self {
            last_epoch: u64::MAX - 1,
            ..Self::default()
        }
    }

    /// Consumes the session `Ledger::retire_caller` returned: forgetting is
    /// only possible after retirement succeeded, so a still-live session
    /// never loses its revocation history.
    pub fn forget(&mut self, session: CallerSession) {
        self.callers.remove(session.as_str());
    }

    fn check(&self, caller: &str, epoch: u64, mutation: bool) -> Result<(), DispatchRefusal> {
        let entry = self
            .callers
            .get(caller)
            .filter(|entry| !self.exhausted && entry.provider_generation.is_some())
            .ok_or(DispatchRefusal::AuthorityConflict)?;
        if entry.epoch != epoch || entry.revoked_through >= Some(entry.runtime_mode_revision) {
            return Err(DispatchRefusal::AuthorityConflict);
        }
        if mutation && !entry.full_access {
            return Err(DispatchRefusal::FullAccessRequired);
        }
        Ok(())
    }
}

/// Owner-held global state consulted immediately before every helper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gate {
    pub pause_epoch: u64,
    pub latched: bool,
    pub applied_policy_revision: Option<u64>,
    pub control_lease_until_ns: Option<u64>,
    pub worker_generation: String,
}

/// Admission-time stamp bound into the ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub caller: String,
    pub caller_epoch: u64,
    pub pause_epoch: u64,
    pub policy_revision: u64,
    pub worker_generation: String,
    pub deadline_ns: u64,
    pub mutation: bool,
}

pub fn check_dispatch(
    gate: &Gate,
    authority: &AuthorityTable,
    stamp: &Stamp,
    now_ns: u64,
) -> Result<(), DispatchRefusal> {
    if gate.latched || gate.pause_epoch != stamp.pause_epoch {
        return Err(DispatchRefusal::Paused);
    }
    if gate.applied_policy_revision != Some(stamp.policy_revision) {
        return Err(DispatchRefusal::PolicyPending);
    }
    if gate
        .control_lease_until_ns
        .is_none_or(|until| now_ns >= until)
    {
        return Err(DispatchRefusal::ControlUnavailable);
    }
    if gate.worker_generation != stamp.worker_generation {
        return Err(DispatchRefusal::WorkerReplaced);
    }
    if now_ns >= stamp.deadline_ns {
        return Err(DispatchRefusal::DeadlineExceeded);
    }
    authority.check(&stamp.caller, stamp.caller_epoch, stamp.mutation)
}
