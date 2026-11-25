//! Isolated loopback-only Windows password launcher. This is not product
//! runtime admission and cannot promote an unlock or cache a credential.

mod guarded_path;
mod recipe;
mod spawn;

#[cfg(test)]
mod completion;

pub use guarded_path::{GuardedLocalFile, GuardedLocalPath};
pub use recipe::{LoopbackPasswordTarget, PasswordProbeFiles, inbox_system_directory};

use super::{
    Admission, ClaimedHelperReply, ExpectedPipePeer, IO_BUDGET, PROBE_LIFETIME, PasswordBytes,
    PasswordHelperAttempt, PasswordHelperBootstrap, PasswordHelperEndpoint, ProbeBinding,
    ProbeQualification, TargetGeneration,
};
use std::{
    io,
    time::{Duration, Instant},
};

const QUALIFICATION: ProbeQualification = ProbeQualification {
    dedicated_owner_probe: true,
    fresh_connection: true,
    strict_host_verification: true,
    no_master_or_agent_reuse: true,
    password_only_without_fallback: true,
};

/// Prepared, immutable inputs for one dedicated loopback SSH attempt. Holds
/// the independently verified owner binding and pins the two images and
/// exact known-hosts file. Nothing is learned from a remote or ambient input.
#[must_use]
pub struct PasswordProbePlan<'target> {
    owner: ExpectedPipePeer,
    target: TargetGeneration<'target>,
    recipe: recipe::Recipe,
}

impl<'target> PasswordProbePlan<'target> {
    /// Prepare without collecting or accepting any password. The owner must
    /// supply the authoritative target generation, approved pin and external
    /// image digests from its isolated test context.
    pub fn prepare(
        owner: ExpectedPipePeer,
        target: LoopbackPasswordTarget<'target>,
        files: PasswordProbeFiles<'_>,
    ) -> io::Result<Self> {
        let recipe = recipe::Recipe::prepare(&target, &files)?;
        Ok(Self {
            owner,
            target: target.generation,
            recipe,
        })
    }
}

/// One live probe; no reconnect, success inference, or cache path. The job
/// kills the complete descendant tree at expiry, owner exit, or revocation.
#[must_use]
pub struct PasswordUnlockProbe<'target> {
    active: Option<spawn::Active>,
    endpoint: Option<PasswordHelperEndpoint>,
    attempt: PasswordHelperAttempt<'target>,
    deadline: Instant,
    // Keep image and trust immutability across the entire SSH handshake.
    _recipe: recipe::Recipe,
}

impl<'target> PasswordUnlockProbe<'target> {
    /// Launch a fresh, isolated SSH child and bind its retained native handle
    /// while suspended, before the askpass helper can connect. The exact
    /// retained owner must be this process; no inherited PID is trusted.
    pub fn launch(
        live_target: TargetGeneration<'_>,
        plan: PasswordProbePlan<'target>,
    ) -> io::Result<Self> {
        if live_target != plan.target {
            return Err(denied());
        }
        let (mut attempt, endpoint, token) =
            PasswordHelperAttempt::register(plan.target, plan.recipe.helper.dos_path())?;
        let deadline = attempt
            .started
            .checked_add(PROBE_LIFETIME)
            .ok_or_else(denied)?;
        let bootstrap = PasswordHelperBootstrap::prepare(endpoint.name(), token)?;
        plan.owner
            .verify_spawned_process(bootstrap.owner_handle())?;
        let process = spawn::Suspended::spawn(&plan.recipe, &bootstrap)?;
        drop(bootstrap);
        attempt.bind_child(live_target, process.process(), plan.recipe.ssh.dos_path())?;
        let active = process.resume(deadline)?;
        Ok(Self {
            active: Some(active),
            endpoint: Some(endpoint),
            attempt,
            deadline,
            _recipe: plan.recipe,
        })
    }

    /// Wait at most the smaller of the caller's budget, the registration
    /// remainder, and two seconds. Success is an admitted helper request,
    /// not a prompt classification or any kind of authentication receipt.
    pub fn receive(
        &mut self,
        live_target: TargetGeneration<'_>,
        timeout: Duration,
    ) -> io::Result<PasswordProbePrompt<'_, 'target>> {
        if live_target != self.attempt.target
            || !self.active.as_ref().is_some_and(spawn::Active::running)
        {
            self.revoke();
            return Err(denied());
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            self.revoke();
            return Err(denied());
        }
        // A shorter poll timeout does not extend or revoke the grant. The
        // watchdog independently closes the job at the absolute deadline.
        let endpoint = self.endpoint.as_mut().ok_or_else(denied)?;
        let pending = endpoint.receive(timeout.min(IO_BUDGET).min(remaining))?;
        let Admission::Claimed { binding, reply, .. } = self.attempt.admit(live_target, pending)
        else {
            return Err(denied());
        };
        Ok(PasswordProbePrompt {
            binding,
            reply,
            attempt: &mut self.attempt,
        })
    }

    /// Close the listener and kill the job. A new generation needs a new
    /// independently prepared plan, endpoint, and child.
    pub fn revoke(&mut self) {
        self.attempt.revoke();
        drop(self.endpoint.take());
        drop(self.active.take());
    }
}

impl Drop for PasswordUnlockProbe<'_> {
    fn drop(&mut self) {
        self.revoke();
    }
}

/// Consuming capability for the existing, verified helper handoff. No user
/// prompt, password collection, cache, or SSH success handling is provided.
#[must_use]
pub struct PasswordProbePrompt<'pipe, 'target> {
    binding: ProbeBinding<'target>,
    reply: ClaimedHelperReply<'target, 'pipe>,
    attempt: &'pipe mut PasswordHelperAttempt<'target>,
}

impl<'target> PasswordProbePrompt<'_, 'target> {
    pub fn binding(&self) -> ProbeBinding<'target> {
        self.binding
    }

    pub fn deliver(
        self,
        live_target: TargetGeneration<'_>,
        password: PasswordBytes,
    ) -> io::Result<()> {
        self.attempt
            .deliver(live_target, self.reply, QUALIFICATION, password)
    }
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "isolated Windows password probe rejected",
    )
}

#[cfg(test)]
mod tests;
