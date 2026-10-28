//! Priority Stop and human-only Resume semantics (native side of M4.stop).
//! Stop closes admission and advances the pause epoch before anything else,
//! is idempotent per operation ID, and is never rejected for capacity. Resume
//! needs a `HumanControl` capability (only the trusted human-control channel
//! constructs it; no model/provider/renderer route), a fresh one-use challenge
//! bound to the current epoch/authority/policy revision/episode, and every
//! settlement prerequisite. A delayed Resume can never clear a newer Stop.
//! Resume is also compared with the owner's CURRENT authority/policy/episode,
//! so a policy apply or episode change after issuance refuses it.
//!
//! Ordinary control requests (everything except Stop) share a separate bound
//! of `MAX_ORDINARY_CONTROL_REQUESTS` in flight; Stop never consumes it.
use super::limits::MAX_ORDINARY_CONTROL_REQUESTS;
use crate::guard::record::valid_id;
use std::collections::VecDeque;

const MAX_REMEMBERED_STOPS: usize = 64;
/// Challenge freshness bound; a renderer/human must answer promptly.
pub const CHALLENGE_TTL_NS: u64 = 60_000_000_000;

/// Constructed only by the authenticated human-control channel. The public
/// type resolves (first block), but its private field cannot be constructed.
/// ```
/// fn named(_: &bigbud_computer_use::owner::admission::control::HumanControl) {}
/// ```
/// ```compile_fail,E0423
/// let human = bigbud_computer_use::owner::admission::control::HumanControl(());
/// ```
pub struct HumanControl(());
impl HumanControl {
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revoked {
    pub operation_id: String,
    pub pause_epoch: u64,
    pub settlement_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeRequest {
    pub expected_pause_epoch: u64,
    pub challenge: String,
    pub authority_id: String,
    pub policy_revision: u64,
    pub episode_id: String,
}

/// The owner's state at the moment Resume is evaluated (never the requester's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeContext {
    pub authority_id: String,
    pub policy_revision: u64,
    pub episode_id: String,
}

/// Settlement facts supplied by the guard/owner, never by the requester.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResumePrerequisites {
    pub retirement_confirmed: bool,
    pub input_state_acknowledged: bool,
    pub policy_acknowledged: bool,
    pub control_healthy: bool,
    pub feature_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeRefusal {
    NotPaused,
    StaleEpoch,
    ChallengeMissing,
    ChallengeMismatch,
    ChallengeExpired,
    /// Authority, applied policy or episode changed since the challenge.
    StateChanged,
    RetirementUnknown,
    InputUnacknowledged,
    PolicyPending,
    ControlUnavailable,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Challenge {
    value: String,
    epoch: u64,
    authority: String,
    revision: u64,
    episode: String,
    issued_ns: u64,
}

pub struct ControlState {
    pause_epoch: u64,
    latched: bool,
    /// Pause epoch space exhausted: stays latched; Resume always refuses.
    exhausted: bool,
    stops: VecDeque<Revoked>,
    challenge: Option<Challenge>,
}

impl ControlState {
    /// Restored from the durable safety record; unclean recovery is latched.
    pub fn restored(pause_epoch: u64, latched: bool) -> Self {
        Self {
            pause_epoch,
            latched,
            exhausted: false,
            stops: VecDeque::new(),
            challenge: None,
        }
    }
    pub fn pause_epoch(&self) -> u64 {
        self.pause_epoch
    }
    pub fn latched(&self) -> bool {
        self.latched
    }

    /// Never refused, not even for a malformed operation ID (that Stop is
    /// anonymous: it still stops but is not remembered for retries). A retried
    /// remembered ID observes the same revocation; one older than the last 64
    /// stops advances the epoch again (fail-safe). Outstanding challenges die.
    pub fn stop(&mut self, operation_id: &str) -> Revoked {
        let remembered = valid_id(operation_id);
        if let Some(prior) = self
            .stops
            .iter()
            .find(|stop| remembered && stop.operation_id == operation_id)
        {
            return prior.clone();
        }
        self.latched = true;
        self.challenge = None;
        match self.pause_epoch.checked_add(1) {
            Some(epoch) => self.pause_epoch = epoch,
            None => self.exhausted = true,
        }
        let revoked = Revoked {
            operation_id: if remembered {
                operation_id.into()
            } else {
                String::new()
            },
            pause_epoch: self.pause_epoch,
            settlement_id: format!("settlement-{}", self.pause_epoch),
        };
        if !remembered {
            return revoked;
        }
        if self.stops.len() >= MAX_REMEMBERED_STOPS {
            self.stops.pop_front();
        }
        self.stops.push_back(revoked.clone());
        revoked
    }

    /// Issues a fresh one-use challenge (replacing any older one). `nonce` must
    /// come from the OS CSPRNG in the trusted caller.
    pub fn challenge(
        &mut self,
        _human: &HumanControl,
        authority: &str,
        revision: u64,
        episode: &str,
        nonce: [u8; 16],
        now_ns: u64,
    ) -> Option<String> {
        if !valid_id(authority) || !valid_id(episode) {
            return None;
        }
        let value: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        self.challenge = Some(Challenge {
            value: value.clone(),
            epoch: self.pause_epoch,
            authority: authority.into(),
            revision,
            episode: episode.into(),
            issued_ns: now_ns,
        });
        Some(value)
    }

    /// One attempt consumes the challenge whatever the result.
    pub fn resume(
        &mut self,
        _human: &HumanControl,
        request: &ResumeRequest,
        current: &ResumeContext,
        facts: ResumePrerequisites,
        now_ns: u64,
    ) -> Result<u64, ResumeRefusal> {
        let challenge = self
            .challenge
            .take()
            .ok_or(ResumeRefusal::ChallengeMissing)?;
        if !self.latched {
            return Err(ResumeRefusal::NotPaused);
        }
        if self.exhausted
            || request.expected_pause_epoch != self.pause_epoch
            || challenge.epoch != self.pause_epoch
        {
            return Err(ResumeRefusal::StaleEpoch);
        }
        if challenge.value != request.challenge
            || challenge.authority != request.authority_id
            || challenge.revision != request.policy_revision
            || challenge.episode != request.episode_id
        {
            return Err(ResumeRefusal::ChallengeMismatch);
        }
        if now_ns.saturating_sub(challenge.issued_ns) >= CHALLENGE_TTL_NS {
            return Err(ResumeRefusal::ChallengeExpired);
        }
        if challenge.authority != current.authority_id
            || challenge.revision != current.policy_revision
            || challenge.episode != current.episode_id
        {
            return Err(ResumeRefusal::StateChanged);
        }
        let refusal = [
            (facts.feature_enabled, ResumeRefusal::Disabled),
            (facts.retirement_confirmed, ResumeRefusal::RetirementUnknown),
            (
                facts.input_state_acknowledged,
                ResumeRefusal::InputUnacknowledged,
            ),
            (facts.policy_acknowledged, ResumeRefusal::PolicyPending),
            (facts.control_healthy, ResumeRefusal::ControlUnavailable),
        ]
        .into_iter()
        .find(|(ok, _)| !ok);
        if let Some((_, refusal)) = refusal {
            return Err(refusal);
        }
        self.latched = false;
        Ok(self.pause_epoch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlBusy;

/// In-flight bound for ordinary (non-Stop) control requests.
#[derive(Debug, Default)]
pub struct OrdinaryControl {
    in_flight: usize,
}
impl OrdinaryControl {
    pub fn begin(&mut self) -> Result<(), ControlBusy> {
        if self.in_flight >= MAX_ORDINARY_CONTROL_REQUESTS {
            return Err(ControlBusy);
        }
        self.in_flight += 1;
        Ok(())
    }
    /// Unmatched `finish` is a caller bug; it never underflows the bound.
    pub fn finish(&mut self) {
        debug_assert!(self.in_flight > 0, "unmatched ordinary-control finish");
        self.in_flight = self.in_flight.saturating_sub(1);
    }
}
