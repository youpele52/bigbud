//! Synthetic-only completion lab. Exercise the existing eligibility state
//! without a cache, production credential, or native inbox qualification.

use super::*;
use crate::windows_password_gate::{PasswordCacheGate, ProbeOutcome, ReleaseRole};

const FIXTURE_PASSWORD: &[u8] = b"public-synthetic-windows-completion-fixture";

// Own the exact probe and retain its binding for the lifetime of the test.
// Neither a fixture-selected PID nor a caller-supplied status can be evidence.
struct SyntheticCompletion<'target> {
    probe: PasswordUnlockProbe<'target>,
    binding: ProbeBinding<'target>,
    gate: PasswordCacheGate<'target>,
    delivered: bool,
}

impl<'target> SyntheticCompletion<'target> {
    fn begin(probe: PasswordUnlockProbe<'target>) -> io::Result<Self> {
        let (_, child) = probe.attempt.ssh.as_ref().ok_or_else(denied)?;
        let binding = ProbeBinding {
            target: probe.attempt.target,
            child: *child,
        };
        let gate =
            PasswordCacheGate::start(binding, QUALIFICATION, Duration::ZERO).ok_or_else(denied)?;
        Ok(Self {
            probe,
            binding,
            gate,
            delivered: false,
        })
    }

    fn deliver_fixture(
        &mut self,
        live_target: TargetGeneration<'_>,
        timeout: Duration,
    ) -> io::Result<()> {
        self.deliver_synthetic(live_target, timeout, FIXTURE_PASSWORD)
    }

    fn deliver_synthetic(
        &mut self,
        live_target: TargetGeneration<'_>,
        timeout: Duration,
        fixture: &'static [u8],
    ) -> io::Result<()> {
        let result = self.deliver_once(live_target, timeout, fixture);
        if result.is_err() {
            self.gate.abort();
            self.delivered = false;
            self.probe.revoke();
        }
        result
    }

    fn deliver_once(
        &mut self,
        live_target: TargetGeneration<'_>,
        timeout: Duration,
        fixture: &'static [u8],
    ) -> io::Result<()> {
        if self.delivered {
            return Err(denied());
        }
        let started = self.probe.attempt.started;
        let prompt = self.probe.receive(live_target, timeout)?;
        let binding = prompt.binding();
        let role = ReleaseRole::DestinationPassword;
        if binding != self.binding
            || !self
                .gate
                .claim_prompt(live_target, binding, role, started.elapsed())
        {
            return Err(denied());
        }
        // Only the real helper's completed, one-use destination pipe receipt
        // is admitted to eligibility. A claim or pipe write is insufficient.
        prompt.deliver(live_target, PasswordBytes::from_boxed_slice(fixture.into()))?;
        if !self
            .gate
            .record_release(live_target, binding, role, started.elapsed())
        {
            return Err(denied());
        }
        self.delivered = true;
        Ok(())
    }

    /// Consume the probe. The same handle that was bound before resume must
    /// signal and report zero after the helper receipt, within both budgets.
    /// No output is examined. Even positive synthetic eligibility retains no
    /// credential and attests nothing about real inbox OpenSSH behavior.
    fn finish(mut self, live_target: TargetGeneration<'_>, timeout: Duration) -> bool {
        if !self.delivered || live_target != self.binding.target {
            return false;
        }
        let now = Instant::now();
        // Cap before addition so a caller cannot overflow or extend the job.
        let remaining = timeout.min(self.probe.deadline.saturating_duration_since(now));
        if remaining.is_zero() {
            return false;
        }
        let Some(child) = self.probe.active.as_ref() else {
            return false;
        };
        let status = child.wait_for_exit(remaining);
        let completed_at = Instant::now();
        let outcome = if status.is_ok_and(|code| code == 0)
            && completed_at.saturating_duration_since(now) < remaining
            && completed_at < self.probe.deadline
        {
            ProbeOutcome::AuthenticatedProbeCompleted
        } else {
            ProbeOutcome::Unverified
        };
        self.gate.complete(
            live_target,
            self.binding,
            outcome,
            completed_at.saturating_duration_since(self.probe.attempt.started),
        )
    }
}

mod inbox;
mod tests;
