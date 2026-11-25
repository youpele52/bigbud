use super::{PROBE_LIFETIME, ProbeBinding, ReleaseRole, TargetGeneration, VerifiedChild};
use std::time::Duration;

const REQUEST_LIFETIME: Duration = Duration::from_secs(2);

/// Untrusted request fields, plus the owner's monotonic arrival time. Stamp
/// `received_at` once per connection; retries of the same request must reuse it.
pub struct HelperRequest<'a> {
    pub token: [u8; 16],
    pub target: TargetGeneration<'a>,
    pub role: ReleaseRole,
    pub received_at: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HelperAdmission<'a> {
    Rejected,
    /// Retry only after child binding changes, strictly before this deadline.
    WaitForChild {
        until: Duration,
    },
    /// A single destination-role claim, not a credential release or an
    /// authentication receipt. Any later delivery must honor both this
    /// deadline and the password lifecycle's own deadline.
    Claimed {
        binding: ProbeBinding<'a>,
        until: Duration,
    },
}

#[derive(Clone, Copy)]
enum State {
    BeforeSpawn,
    Bound(VerifiedChild),
    Closed,
}

/// One owner-local registration for a dedicated destination-password probe.
/// Register before spawn, and serialize binding, claims and revocation under
/// the live target-generation fence. This holds no credentials, queues no
/// helpers, and never starts, waits for, or terminates an SSH child.
#[must_use]
pub struct PasswordHelperGrant<'a> {
    target: TargetGeneration<'a>,
    token: [u8; 16],
    registered_at: Duration,
    expires_at: Duration,
    last_seen_at: Duration,
    state: State,
}

impl<'a> PasswordHelperGrant<'a> {
    /// Registers locally and returns the random token to pass only to the
    /// intended launch. Success is the in-process registration acknowledgement.
    #[cfg(windows)]
    pub fn register(
        target: TargetGeneration<'a>,
        now: Duration,
    ) -> std::io::Result<(Self, [u8; 16])> {
        let token = crate::windows_owner_pipe::random_token()?;
        let grant = Self::with_token(target, now, token)
            .ok_or_else(|| std::io::Error::other("Windows password grant deadline overflow"))?;
        Ok((grant, token))
    }

    #[cfg(any(windows, test))]
    fn with_token(target: TargetGeneration<'a>, now: Duration, token: [u8; 16]) -> Option<Self> {
        Some(Self {
            target,
            token,
            registered_at: now,
            expires_at: now.checked_add(PROBE_LIFETIME)?,
            last_seen_at: now,
            state: State::BeforeSpawn,
        })
    }

    /// Bind once using the identity of the retained, image-verified direct SSH
    /// child, never a PID or binding reported by the request.
    #[must_use]
    pub fn bind_child(
        &mut self,
        live_target: TargetGeneration<'_>,
        child: VerifiedChild,
        now: Duration,
    ) -> bool {
        self.expire(live_target, now);
        if !matches!(self.state, State::BeforeSpawn) {
            return false;
        }
        self.state = State::Bound(child);
        true
    }

    /// `verified_parent` is supplied by the trusted adapter only after checking
    /// the connected helper's process object and image, and that its immediate
    /// parent is the retained SSH child. The helper must also verify the owner.
    /// Do not derive this evidence from request metadata or the prompt text.
    /// Sample `now` after verification, using the same clock as `received_at`.
    #[must_use]
    pub fn admit(
        &mut self,
        live_target: TargetGeneration<'_>,
        request: &HelperRequest<'_>,
        verified_parent: Option<VerifiedChild>,
        now: Duration,
    ) -> HelperAdmission<'a> {
        self.expire(live_target, now);
        if matches!(self.state, State::Closed)
            || request.target != self.target
            || request.role != ReleaseRole::DestinationPassword
            || request.token != self.token
            || request.received_at < self.registered_at
            || request.received_at > now
        {
            return HelperAdmission::Rejected;
        }
        let until = request
            .received_at
            .checked_add(REQUEST_LIFETIME)
            .map_or(self.expires_at, |deadline| self.expires_at.min(deadline));
        if now >= until {
            return HelperAdmission::Rejected;
        }
        match self.state {
            State::BeforeSpawn => HelperAdmission::WaitForChild { until },
            State::Bound(child) if verified_parent == Some(child) => {
                self.revoke();
                HelperAdmission::Claimed {
                    binding: ProbeBinding {
                        target: self.target,
                        child,
                    },
                    until,
                }
            }
            State::Bound(_) | State::Closed => HelperAdmission::Rejected,
        }
    }

    /// Revoke on child exit, cancellation, disconnect or owner retirement.
    pub fn revoke(&mut self) {
        self.state = State::Closed;
    }

    pub fn expire(&mut self, live_target: TargetGeneration<'_>, now: Duration) {
        if live_target != self.target || now < self.last_seen_at || now >= self.expires_at {
            self.revoke();
        } else {
            self.last_seen_at = now;
        }
    }
}

#[cfg(test)]
mod tests;
