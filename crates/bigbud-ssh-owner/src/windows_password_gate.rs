//! Owner-local storage and lifecycle for a Windows password unlock probe.
//!
//! Windows password runtime support remains unqualified (`windowsPasswordUnsupported`);
//! The standalone Windows helper is not selected by the product; its bounded
//! handoff is not proof of inbox interoperability or SSH authentication.
//! A qualified runtime must establish the remaining launch and receipt facts. Do not
//! construct them from prompt or diagnostic text, a PID alone, or an exit code.

#[cfg(any(windows, test))]
mod helper_grant;
mod lifecycle;
#[cfg(windows)]
pub mod native;
mod secret;

#[cfg(any(windows, test))]
pub use helper_grant::{HelperAdmission, HelperRequest, PasswordHelperGrant};
pub use lifecycle::{Access, Activity, PasswordLifecycle, ReleaseObservation, UserAction};
pub use secret::PasswordBytes;

use std::time::Duration;

/// One deadline from probe start, shared by the prompt, release and completion.
/// None extends it. This is not a timeout for the underlying SSH child.
const PROBE_LIFETIME: Duration = Duration::from_secs(20);

/// Windows ships key-only (U3). This is a constant product decision, not a
/// probe result.
pub const fn key_only() -> bool {
    true
}

/// Whether a destination's remaining OpenSSH methods are only ones Windows
/// never collects. Decided from the authenticated method list only, never from
/// prompt or diagnostic text.
#[must_use]
pub fn requires_unsupported_password(methods: &str) -> bool {
    let mut any = false;
    for method in methods.split(',').map(str::trim) {
        if method.is_empty() {
            continue;
        }
        any = true;
        if method.eq_ignore_ascii_case("publickey") || method.eq_ignore_ascii_case("hostbased") {
            return false;
        }
    }
    any
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TargetGeneration<'a> {
    pub target: &'a str,
    pub generation: u64,
}

/// Opaque adapter-assigned identity, distinct for every registered child.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerifiedChild(u128);

impl VerifiedChild {
    /// The adapter may mint or match this identity only after checking the
    /// retained process handle, resolved image and creation time. Never reuse
    /// a binding for a new attempt, even if the OS reuses the child's PID.
    pub const fn from_verified_identity(binding: u128) -> Self {
        Self(binding)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProbeBinding<'a> {
    pub target: TargetGeneration<'a>,
    pub child: VerifiedChild,
}

/// Explicit launch facts attested by the adapter for the bound child.
#[derive(Clone, Copy, Debug)]
pub struct ProbeQualification {
    pub dedicated_owner_probe: bool,
    pub fresh_connection: bool,
    pub strict_host_verification: bool,
    pub no_master_or_agent_reuse: bool,
    /// After the initial `none` request, password is the sole eligible
    /// destination method, with no fallback or additional auth method.
    pub password_only_without_fallback: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseRole {
    /// Verified destination password role, not inferred from text.
    DestinationPassword,
    /// Includes trust prompts, jump hops, keyboard-interactive and unknown roles.
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeOutcome {
    /// Positive receipt for successful completion of the fixed authenticated
    /// probe, tied to this child and its sole-method password flow.
    AuthenticatedProbeCompleted,
    PasswordRejected,
    PartialAuthentication,
    TransportLost,
    /// Includes generic command success, exit status or connection state alone.
    Unverified,
}

#[derive(Debug, Eq, PartialEq)]
enum State {
    AwaitingPrompt,
    PromptClaimed,
    Released,
    Closed,
}

/// Serial, one-shot policy. Times are absolute readings from one monotonic
/// clock. The caller must supply the authoritative live target generation
/// separately from the event binding, and abort on cancellation or uncertainty
/// about what happened. The gate does not hold or move any secret.
#[derive(Debug)]
pub struct PasswordCacheGate<'a> {
    binding: ProbeBinding<'a>,
    started_at: Duration,
    last_seen_at: Duration,
    state: State,
}

impl<'a> PasswordCacheGate<'a> {
    #[must_use]
    pub fn start(
        binding: ProbeBinding<'a>,
        qualification: ProbeQualification,
        now: Duration,
    ) -> Option<Self> {
        let ProbeQualification {
            dedicated_owner_probe,
            fresh_connection,
            strict_host_verification,
            no_master_or_agent_reuse,
            password_only_without_fallback,
        } = qualification;
        (dedicated_owner_probe
            && fresh_connection
            && strict_host_verification
            && no_master_or_agent_reuse
            && password_only_without_fallback)
            .then_some(Self {
                binding,
                started_at: now,
                last_seen_at: now,
                state: State::AwaitingPrompt,
            })
    }

    /// Claims the destination prompt once, after the adapter has verified its
    /// identity and role. Rejected requests are not observed releases and do
    /// not burn the destination claim. A claim is not evidence of delivery.
    #[must_use]
    pub fn claim_prompt(
        &mut self,
        live_target: TargetGeneration<'_>,
        event: ProbeBinding<'_>,
        role: ReleaseRole,
        now: Duration,
    ) -> bool {
        if !self.is_live(live_target, now)
            || self.binding != event
            || role != ReleaseRole::DestinationPassword
            || self.state != State::AwaitingPrompt
        {
            return false;
        }
        self.state = State::PromptClaimed;
        true
    }

    /// Records an observed release. `true` means it counts toward cache
    /// eligibility, not permission to retrieve or send a password. Foreign
    /// events do not consume the bound child's release opportunity. A repeated
    /// or wrong-role release on the bound child invalidates this probe.
    #[must_use]
    pub fn record_release(
        &mut self,
        live_target: TargetGeneration<'_>,
        event: ProbeBinding<'_>,
        role: ReleaseRole,
        now: Duration,
    ) -> bool {
        if !self.is_live(live_target, now) || self.binding != event {
            return false;
        }
        if self.state == State::PromptClaimed && role == ReleaseRole::DestinationPassword {
            self.state = State::Released;
            true
        } else {
            self.abort();
            false
        }
    }

    /// Makes a one-time eligibility decision. A matching completion closes
    /// the probe regardless of outcome. Use a positive decision immediately
    /// under the same target-generation fence; it is not a durable permit.
    #[must_use]
    pub fn complete(
        &mut self,
        live_target: TargetGeneration<'_>,
        receipt: ProbeBinding<'_>,
        outcome: ProbeOutcome,
        now: Duration,
    ) -> bool {
        if !self.is_live(live_target, now) || self.binding != receipt {
            return false;
        }
        let released = self.state == State::Released;
        self.abort();
        released && outcome == ProbeOutcome::AuthenticatedProbeCompleted
    }

    /// Permanently invalidates this probe (e.g. cancellation or disconnect).
    pub fn abort(&mut self) {
        self.state = State::Closed;
    }

    fn is_live(&mut self, live_target: TargetGeneration<'_>, now: Duration) -> bool {
        if self.state == State::Closed {
            return false;
        }
        if live_target != self.binding.target
            || now < self.last_seen_at
            || now
                .checked_sub(self.started_at)
                .is_none_or(|elapsed| elapsed >= PROBE_LIFETIME)
        {
            self.abort();
            return false;
        }
        self.last_seen_at = now;
        true
    }
}

#[cfg(test)]
mod tests;
