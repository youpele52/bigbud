//! ApplyPolicy projection state: desired vs applied are distinct (the server
//! persists desired; this acknowledges applied). Duplicate same revision and
//! digest is idempotent; a conflicting digest or stale revision is refused.
//! The owner keeps only this in-memory projection, never a policy journal.
//! The canonical bytes are decoded and their digest recomputed before any
//! acknowledgement; their authority and revision must equal the request's.
use super::policy_canonical::{CanonicalPolicy, CanonicalRefusal};
pub use crate::guard::record::parse_revision;
use crate::guard::record::{PolicyBinding, valid_id};
use crate::guard::{Acknowledged, GuardFence, SafetySink, TransitionError, TransitionRefusal};

pub const MAX_CANONICAL_POLICY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyRefusal {
    AuthorityMismatch,
    InvalidRevision,
    StaleRevision,
    ConflictingDigest,
    Oversized,
    FenceMismatch,
    /// Canonical bytes malformed or digest mismatch.
    Canonical(CanonicalRefusal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    New(u64),
    Idempotent(u64),
}

pub struct PolicyProjection {
    authority: String,
    fence: String,
    applied: Option<(u64, [u8; 32])>,
}

impl PolicyProjection {
    /// A writer lease names one authority and fence; takeover = new projection.
    pub fn new(authority: &str, fence: &str) -> Option<Self> {
        (valid_id(authority) && valid_id(fence)).then(|| Self {
            authority: authority.into(),
            fence: fence.into(),
            applied: None,
        })
    }
    pub fn applied_revision(&self) -> Option<u64> {
        self.applied.map(|(revision, _)| revision)
    }

    pub fn apply(
        &mut self,
        authority: &str,
        fence: &str,
        revision: &str,
        digest: [u8; 32],
        canonical: &[u8],
    ) -> Result<Applied, PolicyRefusal> {
        if authority != self.authority {
            return Err(PolicyRefusal::AuthorityMismatch);
        }
        if fence != self.fence {
            return Err(PolicyRefusal::FenceMismatch);
        }
        if canonical.is_empty() || canonical.len() > MAX_CANONICAL_POLICY_BYTES {
            return Err(PolicyRefusal::Oversized);
        }
        // Revision 0 is the native "nothing acknowledged" sentinel; real
        // policy revisions start at 1.
        let revision = parse_revision(revision)
            .filter(|revision| *revision > 0)
            .ok_or(PolicyRefusal::InvalidRevision)?;
        let policy =
            CanonicalPolicy::verify(canonical, digest).map_err(PolicyRefusal::Canonical)?;
        if policy.authority != authority {
            return Err(PolicyRefusal::AuthorityMismatch);
        }
        if policy.revision != revision {
            return Err(PolicyRefusal::InvalidRevision);
        }
        match self.applied {
            Some((current, current_digest)) if current == revision => {
                if current_digest == digest {
                    Ok(Applied::Idempotent(revision))
                } else {
                    Err(PolicyRefusal::ConflictingDigest)
                }
            }
            Some((current, _)) if revision < current => Err(PolicyRefusal::StaleRevision),
            _ => {
                self.applied = Some((revision, digest));
                Ok(Applied::New(revision))
            }
        }
    }
}

/// Durable acknowledgement (M3 transaction order: validate and apply the
/// projection, then durably acknowledge exactly that revision and digest
/// under the current writer lease). The projection's fence is the lease's
/// minted revision namespace, so a projection from before a takeover cannot
/// acknowledge under the new lease. Anything this projection has not applied
/// refuses as a conflict; reopening admission stays a separate decision.
pub fn acknowledge_applied<S: SafetySink>(
    fence: &mut GuardFence<S>,
    projection: &PolicyProjection,
    binding: PolicyBinding,
) -> Result<Acknowledged, TransitionError<S::Error>> {
    let applied = projection.applied.map(|(revision, digest)| {
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        (revision, hex)
    });
    let matches = applied.is_some_and(|(revision, hex)| {
        projection.authority == binding.authority
            && projection.fence == binding.profile_generation
            && parse_revision(&binding.revision) == Some(revision)
            && hex == binding.digest
    });
    if !matches {
        return Err(TransitionError::Refused(
            TransitionRefusal::ConflictingDigest,
        ));
    }
    fence.acknowledge_revision(binding)
}
