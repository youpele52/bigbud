use super::protocol::scheduling::v1::{Outcome, Proposal, Reason, Receipt};
use super::scheduler::{Movement, MovementReason};
use prost::Message;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};

const MAX_ACK_RETRIES: u8 = 3;
struct Pending {
    proposal: Proposal,
    sent_ms: u64,
    retries: u8,
}
struct Deferred {
    proposal: Proposal,
    due_ms: u64,
}
/// A settled thread is not re-proposed until ITS OWN fact version changes. A stale receipt can
/// also be caused by row-independent reasons (owner sample age, policy switch, clock skew), so
/// it additionally lifts after a capped exponential backoff; unrelated facts never lift it.
struct Blocked {
    fact_version: u64,
    stale: Option<Stale>,
}
struct Stale {
    count: u32,
    until_ms: u64,
}
pub const STALE_BACKOFF_MIN_MS: u64 = 1_000;
pub const STALE_BACKOFF_MAX_MS: u64 = 60_000;

#[derive(Default)]
pub struct Operations {
    pending: Option<Pending>,
    deferred: BTreeMap<String, Deferred>,
    blocked: BTreeMap<String, Blocked>,
    receipts: VecDeque<Receipt>,
    /// Count of attempt-0 proposals started in this session. Mixed into the occurrence digest
    /// so a re-proposal of an unchanged movement after a stale receipt (no intervening facts)
    /// is a NEW attempt identity; retransmissions reuse the stored proposal byte for byte.
    started: u64,
}
impl Operations {
    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }
    pub fn allows_thread(&self, thread_id: &str, version: u64, mono_ms: u64) -> bool {
        !self.deferred.contains_key(thread_id)
            && self.blocked.get(thread_id).is_none_or(|blocked| {
                blocked.fact_version != version
                    || blocked
                        .stale
                        .as_ref()
                        .is_some_and(|stale| mono_ms >= stale.until_ms)
            })
    }
    pub fn start(
        &mut self,
        movement: Movement,
        nonce: &str,
        generation: u64,
        sequence: u64,
        now_ms: u64,
        mono_ms: u64,
    ) -> Proposal {
        let reason = match movement.reason {
            MovementReason::Attention => Reason::Attention,
            MovementReason::Active => Reason::Active,
            MovementReason::SnoozeExpired => Reason::SnoozeExpired,
            MovementReason::Older => Reason::Older,
            MovementReason::Idle => Reason::Idle,
            MovementReason::Target => Reason::Target,
            MovementReason::Resolved => Reason::Resolved,
        };
        let mut proposal = Proposal {
            operation_id: String::new(),
            occurrence_id: String::new(),
            attempt: 0,
            thread_id: movement.thread_id,
            fact_version: movement.fact_version,
            expected_revision: movement.expected_revision,
            policy_version: movement.policy_version,
            from: movement.from as i32,
            destination: movement.destination as i32,
            reason: reason as i32,
            snooze_identity: movement.snooze_identity,
            inactivity_cutoff_ms: movement.inactivity_cutoff_ms,
            created_at_ms: 0,
        };
        let mut digest = Sha256::new();
        digest.update((nonce.len() as u64).to_be_bytes());
        digest.update(nonce);
        digest.update(generation.to_be_bytes());
        digest.update(sequence.to_be_bytes());
        digest.update(self.started.to_be_bytes());
        digest.update(proposal.encode_to_vec());
        self.started = self.started.wrapping_add(1);
        proposal.occurrence_id = format!("inyosira:{:x}", digest.finalize());
        proposal.operation_id = identity(&proposal.occurrence_id, 0);
        proposal.created_at_ms = now_ms;
        self.pending = Some(Pending {
            proposal: proposal.clone(),
            sent_ms: mono_ms,
            retries: 0,
        });
        proposal
    }
    /// No new identity is allocated until an authoritative not-due receipt confirms the old
    /// attempt. Unknown/lost acknowledgements always retransmit the identical protobuf value.
    pub fn receive(&mut self, receipt: Receipt, mono_ms: u64) -> Result<(), &'static str> {
        if let Some(previous) = self
            .receipts
            .iter()
            .find(|previous| previous.operation_id == receipt.operation_id)
        {
            return if previous == &receipt {
                Ok(())
            } else {
                Err("conflicting duplicate receipt")
            };
        }
        let Some(pending) = self.pending.as_ref() else {
            return Err("unexpected receipt");
        };
        if receipt.operation_id != pending.proposal.operation_id {
            return Err("receipt identity mismatch");
        }
        let outcome = Outcome::try_from(receipt.outcome).map_err(|_| "invalid receipt outcome")?;
        if outcome == Outcome::Unspecified {
            return Err("unspecified receipt outcome");
        }
        let proposal = pending.proposal.clone();
        if outcome == Outcome::NotDue {
            let due = receipt
                .retry_not_before_ms
                .ok_or("not-due receipt lacks deadline")?;
            if due.saturating_sub(proposal.created_at_ms) < 1000 || due > 9_007_199_254_740_991 {
                return Err("invalid retry deadline");
            }
            // Cap retry pacing independently of repeated early replies, up to60s.
            let spacing = 1000u64
                .saturating_mul(1u64 << proposal.attempt.min(6))
                .min(60_000);
            if self.deferred.len() >= 32 {
                return Err("deferred proposal capacity exceeded");
            }
            self.deferred.insert(
                proposal.thread_id.clone(),
                Deferred {
                    due_ms: due.max(proposal.created_at_ms.saturating_add(spacing)),
                    proposal,
                },
            );
        } else {
            let stale = (outcome == Outcome::Stale).then(|| {
                let count = self
                    .blocked
                    .get(&proposal.thread_id)
                    .filter(|blocked| blocked.fact_version == proposal.fact_version)
                    .and_then(|blocked| blocked.stale.as_ref())
                    .map_or(1, |stale| stale.count.saturating_add(1));
                let backoff = STALE_BACKOFF_MIN_MS
                    .saturating_mul(1u64 << (count - 1).min(6))
                    .min(STALE_BACKOFF_MAX_MS);
                Stale {
                    count,
                    until_ms: mono_ms.saturating_add(backoff),
                }
            });
            self.blocked.insert(
                proposal.thread_id.clone(),
                Blocked {
                    fact_version: proposal.fact_version,
                    stale,
                },
            );
        }
        self.pending = None;
        self.receipts.push_back(receipt);
        if self.receipts.len() > 32 {
            self.receipts.pop_front();
        }
        Ok(())
    }
    pub fn tick(
        &mut self,
        wall_ms: u64,
        mono_ms: u64,
        current: impl Fn(&Proposal) -> bool,
    ) -> Result<Option<Proposal>, &'static str> {
        if let Some(pending) = self.pending.as_mut() {
            let wait = 5000
                + match pending.retries {
                    0 => 200,
                    1 => 400,
                    _ => 800,
                };
            if mono_ms.saturating_sub(pending.sent_ms) < wait {
                return Ok(None);
            }
            if pending.retries >= MAX_ACK_RETRIES {
                return Err("organisation proposal acknowledgement timed out");
            }
            pending.retries += 1;
            pending.sent_ms = mono_ms;
            return Ok(Some(pending.proposal.clone()));
        }
        self.deferred
            .retain(|_, deferred| current(&deferred.proposal));
        let due_id = self
            .deferred
            .iter()
            .find(|(_, deferred)| wall_ms >= deferred.due_ms)
            .map(|(id, _)| id.clone());
        if let Some(id) = due_id {
            let deferred = self
                .deferred
                .get(&id)
                .ok_or("deferred proposal disappeared")?;
            let mut proposal = deferred.proposal.clone();
            proposal.attempt = proposal
                .attempt
                .checked_add(1)
                .filter(|attempt| *attempt <= 9_007_199_254_740_991)
                .ok_or("attempt exhausted")?;
            proposal.operation_id = identity(&proposal.occurrence_id, proposal.attempt);
            proposal.created_at_ms = wall_ms;
            self.deferred.remove(&id);
            self.pending = Some(Pending {
                proposal: proposal.clone(),
                sent_ms: mono_ms,
                retries: 0,
            });
            return Ok(Some(proposal));
        }
        Ok(None)
    }
    /// Earliest future monotonic instant at which a stale backoff lifts (decision wake-up).
    pub fn next_unblock_ms(&self, mono_ms: u64) -> Option<u64> {
        self.blocked
            .values()
            .filter_map(|blocked| blocked.stale.as_ref().map(|stale| stale.until_ms))
            .filter(|until| *until > mono_ms)
            .min()
    }
    pub fn at_capacity(&self) -> bool {
        self.deferred.len() >= 32
    }
    pub fn retain_threads(&mut self, retained: impl Fn(&str) -> bool) {
        self.blocked.retain(|id, _| retained(id));
    }
}
fn identity(occurrence: &str, attempt: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(occurrence);
    digest.update(attempt.to_be_bytes());
    format!("inyosira:{:x}", digest.finalize())
}
