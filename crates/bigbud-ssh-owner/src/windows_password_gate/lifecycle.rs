use std::{mem, time::Duration};

use super::{
    PROBE_LIFETIME, PasswordBytes, PasswordCacheGate, ProbeBinding, ProbeOutcome,
    ProbeQualification, ReleaseRole, TargetGeneration,
};

const USER_IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserAction {
    TerminalInput,
    TerminalOpen,
    Browse,
    Read,
    Turn,
    TransferStart,
    Connect,
    Unlock,
}

/// Only the owner may classify a trusted foreground operation as a user action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Activity {
    User(UserAction),
    Monitor,
    Cleanup,
    Askpass,
}

/// Decision about new authentication work, not about existing sessions or
/// leases. None of these decisions permits delivery to a helper.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Access {
    CacheEligible,
    UnlockRequired,
    UnlockInProgress,
    Paused,
    NoCredentialAccess,
    Revoked,
}

/// Trusted delivery observations, not helper-supplied claims. The timestamp
/// must be sampled after delivery, from the same clock as the other readings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseObservation {
    DeliveredAt(Duration),
    FailedOrUncertain,
}

struct Pending<'a> {
    gate: PasswordCacheGate<'a>,
    last_user_at: Duration,
    password: PasswordBytes,
}

enum State<'a> {
    Locked,
    Probing(Pending<'a>),
    Ready {
        last_user_at: Duration,
        // Held without a retrieval API until cached-use admission is qualified.
        _password: PasswordBytes,
    },
    Revoked,
}

/// Owner-local storage for a single admitted target generation. The owner must
/// serialize calls under its authoritative target-generation fence (including
/// the release callback), tick at deadlines even without work, and revoke on
/// Disconnect, trust change or retirement. Dropping the lifecycle wipes any
/// pending or cached allocation. It never manages SSH children or leases.
pub struct PasswordLifecycle<'a> {
    target: TargetGeneration<'a>,
    last_seen_at: Duration,
    state: State<'a>,
}

impl<'a> PasswordLifecycle<'a> {
    #[must_use]
    pub fn new(target: TargetGeneration<'a>, now: Duration) -> Self {
        Self {
            target,
            last_seen_at: now,
            state: State::Locked,
        }
    }

    /// Expires before accounting for activity: arriving at the idle boundary
    /// cannot revive the cache. Monitor, cleanup and helper traffic never
    /// extend it or request an unlock, even if currently authenticated.
    #[must_use]
    pub fn access(
        &mut self,
        live_target: TargetGeneration<'_>,
        activity: Activity,
        now: Duration,
    ) -> Access {
        self.expire(live_target, now);
        match (&mut self.state, activity) {
            (State::Revoked, _) => Access::Revoked,
            (_, Activity::Askpass | Activity::Cleanup) => Access::NoCredentialAccess,
            (State::Ready { last_user_at, .. }, Activity::User(_)) => {
                *last_user_at = now;
                Access::CacheEligible
            }
            (State::Probing(pending), Activity::User(_)) => {
                pending.last_user_at = now;
                Access::UnlockInProgress
            }
            (State::Ready { .. }, Activity::Monitor) => Access::CacheEligible,
            (_, Activity::User(_)) => Access::UnlockRequired,
            (_, Activity::Monitor) => Access::Paused,
        }
    }

    /// Begins an explicit user unlock after verified child binding. Each
    /// attempt needs a fresh child identity. An unqualified or otherwise
    /// rejected submission is wiped too. This is not runtime admission to
    /// collect a credential on an unqualified build.
    #[must_use]
    pub fn begin_user_unlock(
        &mut self,
        live_target: TargetGeneration<'_>,
        binding: ProbeBinding<'a>,
        qualification: ProbeQualification,
        password: PasswordBytes,
        now: Duration,
    ) -> bool {
        self.expire(live_target, now);
        if !matches!(self.state, State::Locked) || binding.target != self.target {
            return false;
        }
        let Some(gate) = PasswordCacheGate::start(binding, qualification, now) else {
            return false;
        };
        self.state = State::Probing(Pending {
            gate,
            last_user_at: now,
            password,
        });
        true
    }

    /// Borrows the pending allocation for exactly one verified destination
    /// prompt. Only a qualified owner adapter may supply the binding, role
    /// and delivery callback. Delivery must be bounded by the probe deadline;
    /// failure, uncertainty or a late delivery observation discards the bytes.
    /// There is no alternate or cached release path here.
    #[must_use]
    pub fn release_probe_password(
        &mut self,
        live_target: TargetGeneration<'_>,
        event: ProbeBinding<'_>,
        role: ReleaseRole,
        now: Duration,
        deliver: impl FnOnce(&[u8], Duration) -> ReleaseObservation,
    ) -> bool {
        self.expire(live_target, now);
        let State::Probing(pending) = &mut self.state else {
            return false;
        };
        if !pending.gate.claim_prompt(live_target, event, role, now) {
            return false;
        }
        // Take ownership before calling out: unwinding must also wipe the
        // pending allocation and leave no live attempt to complete.
        let State::Probing(mut pending) = mem::replace(&mut self.state, State::Locked) else {
            return false;
        };
        let Some(remaining) = now
            .checked_sub(pending.gate.started_at)
            .and_then(|elapsed| PROBE_LIFETIME.checked_sub(elapsed))
        else {
            return false;
        };
        match deliver(pending.password.as_slice(), remaining) {
            ReleaseObservation::DeliveredAt(delivered_at) => {
                self.expire(live_target, delivered_at);
                if matches!(self.state, State::Locked)
                    && pending
                        .gate
                        .record_release(live_target, event, role, delivered_at)
                {
                    self.state = State::Probing(pending);
                    true
                } else {
                    false
                }
            }
            ReleaseObservation::FailedOrUncertain => false,
        }
    }

    /// Move (not copy) the released allocation on positive verified receipt.
    /// A matching negative or no-prompt completion wipes the pending bytes.
    /// Completion does not move the idle clock.
    #[must_use]
    pub fn complete(
        &mut self,
        live_target: TargetGeneration<'_>,
        receipt: ProbeBinding<'_>,
        outcome: ProbeOutcome,
        now: Duration,
    ) -> bool {
        self.expire(live_target, now);
        if !matches!(&self.state, State::Probing(pending) if pending.gate.binding == receipt) {
            return false;
        }
        let State::Probing(mut pending) = mem::replace(&mut self.state, State::Locked) else {
            return false;
        };
        if !pending.gate.complete(live_target, receipt, outcome, now) {
            return false;
        }
        self.state = State::Ready {
            last_user_at: pending.last_user_at,
            _password: pending.password,
        };
        true
    }

    /// Cancellation, exit or identity loss invalidates only the bound pending
    /// child. A later exit does not undo a completed verified unlock.
    pub fn evict_child(
        &mut self,
        live_target: TargetGeneration<'_>,
        child: ProbeBinding<'_>,
        now: Duration,
    ) {
        self.expire(live_target, now);
        if matches!(&self.state, State::Probing(pending) if pending.gate.binding == child) {
            self.state = State::Locked;
        }
    }

    pub fn revoke(&mut self) {
        self.state = State::Revoked;
    }

    /// The owner must tick even with no callers. This never stops an SSH child
    /// or lease. Use the authoritative live target, not a callback's target.
    pub fn expire(&mut self, live_target: TargetGeneration<'_>, now: Duration) {
        if live_target != self.target || now < self.last_seen_at {
            self.revoke();
            return;
        }
        self.last_seen_at = now;
        let expired = match &mut self.state {
            State::Ready { last_user_at, .. } => now
                .checked_sub(*last_user_at)
                .is_none_or(|elapsed| elapsed >= USER_IDLE_LIMIT),
            State::Probing(pending) => !pending.gate.is_live(live_target, now),
            State::Locked | State::Revoked => false,
        };
        if expired {
            self.state = State::Locked;
        }
    }

    #[cfg(test)]
    pub(super) fn cached_bytes(&self) -> Option<&[u8]> {
        match &self.state {
            State::Ready { _password, .. } => Some(_password.as_slice()),
            _ => None,
        }
    }
}
