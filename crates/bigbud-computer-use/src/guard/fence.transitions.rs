//! Durable settlement and writer-lease transitions (M4.uncertainty,
//! M3.controller). Crate-private: the owner's admission layer gates the
//! human-only ones behind `HumanControl`. Every transition builds the next
//! record, validates it, persists it and only then commits it in memory, so a
//! failed write never claims a state that is not durable (the fence stays
//! `persistence_failed`, which keeps admission closed).
use super::{FenceError, GuardFence, SafetySink};
use crate::guard::record::{PolicyBinding, SafetyRecord, parse_revision};

/// The controlling server's identity. The revision namespace is minted by
/// native from the strictly increasing pause epoch, so a caller can never
/// select or reuse one while the safety journal lives. A lost journal
/// restarts at `SafetyRecord::initial()` (epoch 0), which forces a fresh
/// human bind; `ns<epoch>` is a freshness label, not a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControllerLease {
    pub authority: String,
    pub controller_installation: String,
    pub migration_binding: String,
}

/// Nothing is acknowledged yet in a freshly minted namespace: revision `0`
/// with an all-zero digest. Real policy revisions start at 1, so the first
/// genuine acknowledgement is always `New`.
pub const UNACKNOWLEDGED_REVISION: &str = "0";

fn unacknowledged_digest() -> String {
    "0".repeat(64)
}

fn fresh_binding(lease: ControllerLease, epoch: u64) -> PolicyBinding {
    PolicyBinding {
        authority: lease.authority,
        controller_installation: lease.controller_installation,
        profile_generation: format!("ns{epoch}"),
        revision: UNACKNOWLEDGED_REVISION.into(),
        digest: unacknowledged_digest(),
        migration_binding: lease.migration_binding,
    }
}

/// Revocation, physical retirement and input state are distinct facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settlement {
    /// Not latched, nothing recorded as running or uncertain.
    Clear,
    /// Admission revoked (latched); execution settled; input state known.
    Revoked,
    /// Recorded execution roots are not confirmed retired: no replacement,
    /// no Resume and no input-state acknowledgement.
    RetirementUnknown { roots: usize },
    /// Execution retired, but OS-delivered input may still be held. Only an
    /// explicit human acknowledgement clears this; it never proves an effect
    /// was undone and never replays the interrupted action.
    InputUncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionRefusal {
    /// The pause epoch moved since the human saw the prompt.
    StaleEpoch,
    NotLatched,
    /// No controller is bound yet (first binding is a separate human action).
    Unbound,
    AlreadyBound,
    /// The writer lease belongs to another controller, profile or migration.
    ForeignController,
    StaleRevision,
    ConflictingDigest,
    /// Revision 0 is the "nothing acknowledged" sentinel, never a policy.
    SentinelRevision,
}

#[derive(Debug)]
pub enum TransitionError<E> {
    Refused(TransitionRefusal),
    Fence(FenceError<E>),
}
impl<E> From<FenceError<E>> for TransitionError<E> {
    fn from(error: FenceError<E>) -> Self {
        Self::Fence(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Acknowledged {
    New(u64),
    /// Identical revision and digest: idempotent, nothing written.
    Idempotent(u64),
}

fn same_lease(current: &PolicyBinding, next: &PolicyBinding) -> bool {
    current.authority == next.authority
        && current.controller_installation == next.controller_installation
        && current.profile_generation == next.profile_generation
        && current.migration_binding == next.migration_binding
}

impl<S: SafetySink> GuardFence<S> {
    pub fn settlement(&self) -> Settlement {
        let record = &self.record;
        if !record.roots.is_empty() {
            Settlement::RetirementUnknown {
                roots: record.roots.len(),
            }
        } else if record.input_uncertain {
            Settlement::InputUncertain
        } else if record.latched {
            Settlement::Revoked
        } else {
            Settlement::Clear
        }
    }

    /// Persist first, then commit; a failed write leaves the prior record.
    fn commit(&mut self, next: SafetyRecord) -> Result<(), FenceError<S::Error>> {
        if !next.valid() {
            return Err(FenceError::Invalid);
        }
        self.persistence_failed = true;
        self.sink.persist(&next).map_err(FenceError::Persistence)?;
        self.record = next;
        self.persistence_failed = false;
        Ok(())
    }

    /// Human recovery after confirmed retirement: the user has released any
    /// held keys/buttons. Clears only the uncertainty, never the latch.
    /// "Confirmed" here is the in-memory record having no roots; after an
    /// earlier failed write this is still safe, because `commit` persists
    /// that root-free state atomically with the acknowledgement.
    pub(crate) fn acknowledge_input_state(
        &mut self,
        expected_epoch: u64,
    ) -> Result<(), TransitionError<S::Error>> {
        if !self.record.latched {
            return Err(TransitionError::Refused(TransitionRefusal::NotLatched));
        }
        if expected_epoch != self.record.pause_epoch {
            return Err(TransitionError::Refused(TransitionRefusal::StaleEpoch));
        }
        if !self.record.roots.is_empty() {
            return Err(FenceError::Unsettled.into());
        }
        if !self.record.input_uncertain {
            return Ok(());
        }
        let mut next = self.record.clone();
        next.input_uncertain = false;
        Ok(self.commit(next)?)
    }

    /// First human binding of a controller in a freshly minted namespace
    /// with nothing acknowledged; admission stays latched.
    pub(crate) fn bind_controller(
        &mut self,
        lease: ControllerLease,
    ) -> Result<PolicyBinding, TransitionError<S::Error>> {
        if self.record.binding.is_some() {
            return Err(TransitionError::Refused(TransitionRefusal::AlreadyBound));
        }
        let binding = fresh_binding(lease, self.record.pause_epoch);
        let mut next = self.record.clone();
        next.binding = Some(binding.clone());
        self.commit(next)?;
        Ok(binding)
    }

    /// Human takeover: fence first (latch + new epoch, durably), require the
    /// old controller's execution to be settled, then bind the new controller
    /// in a namespace minted from that new epoch (never reused, so the old
    /// controller's revisions can never be acknowledged again) with nothing
    /// acknowledged. Never merges profiles; the latch stays set, so the new
    /// controller needs a fresh Resume.
    pub(crate) fn take_over(
        &mut self,
        lease: ControllerLease,
    ) -> Result<PolicyBinding, TransitionError<S::Error>> {
        if self.record.binding.is_none() {
            return Err(TransitionError::Refused(TransitionRefusal::Unbound));
        }
        if !fresh_binding(lease.clone(), 0).valid() {
            return Err(FenceError::Invalid.into());
        }
        let epoch = self.revoke("controller_takeover")?;
        if !self.record.roots.is_empty() {
            return Err(FenceError::Unsettled.into());
        }
        let binding = fresh_binding(lease, epoch);
        let mut next = self.record.clone();
        next.binding = Some(binding.clone());
        self.commit(next)?;
        Ok(binding)
    }

    /// Durable acknowledgement of an applied policy revision by the current
    /// writer-lease holder, only once old execution has settled. Identical
    /// revision+digest is idempotent; a conflicting digest or lower revision
    /// refuses. Reopening admission is a separate decision (same fence, no
    /// newer Stop); this never clears the latch.
    pub(crate) fn acknowledge_revision(
        &mut self,
        binding: PolicyBinding,
    ) -> Result<Acknowledged, TransitionError<S::Error>> {
        let Some(current) = &self.record.binding else {
            return Err(TransitionError::Refused(TransitionRefusal::Unbound));
        };
        if !same_lease(current, &binding) {
            return Err(TransitionError::Refused(
                TransitionRefusal::ForeignController,
            ));
        }
        let (Some(known), Some(next_revision)) = (
            parse_revision(&current.revision),
            parse_revision(&binding.revision),
        ) else {
            return Err(FenceError::Invalid.into());
        };
        if next_revision == 0 {
            return Err(TransitionError::Refused(
                TransitionRefusal::SentinelRevision,
            ));
        }
        if next_revision < known {
            return Err(TransitionError::Refused(TransitionRefusal::StaleRevision));
        }
        if next_revision == known {
            return if current.digest == binding.digest {
                Ok(Acknowledged::Idempotent(known))
            } else {
                Err(TransitionError::Refused(
                    TransitionRefusal::ConflictingDigest,
                ))
            };
        }
        if !self.record.roots.is_empty() {
            return Err(FenceError::Unsettled.into());
        }
        let mut next = self.record.clone();
        next.binding = Some(binding);
        self.commit(next)?;
        Ok(Acknowledged::New(next_revision))
    }
}
