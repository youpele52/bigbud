//! One-attempt Windows helper admission and reply. This is not a platform
//! capability advertisement and is not wired into product credential routing.

use super::{
    HelperAdmission, HelperRequest, PROBE_LIFETIME, PasswordBytes, PasswordCacheGate,
    PasswordHelperGrant, ProbeBinding, ProbeQualification, ReleaseRole, TargetGeneration,
    VerifiedChild,
};
use crate::windows_owner_pipe::{ExpectedPipePeer, PipeName, helper};
use std::{
    io,
    os::windows::io::BorrowedHandle,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const IO_BUDGET: Duration = Duration::from_secs(2);

pub use helper::entry::{PasswordHelperBootstrap, run_password_helper_prompt};
pub mod probe;

/// One registration for one dedicated, directly spawned SSH probe. The
/// authoritative target-generation owner must serialize binding, admission and
/// revocation. A claim reserves the configured destination role; it does not
/// prove which prompt OpenSSH invoked, password delivery, or authentication.
#[must_use]
pub struct PasswordHelperAttempt<'a> {
    grant: PasswordHelperGrant<'a>,
    target: TargetGeneration<'a>,
    started: Instant,
    name: PipeName,
    ssh: Option<(ExpectedPipePeer, VerifiedChild)>,
}

/// Separate from the grant so a held early request does not prevent binding
/// the SSH child. Holds at most one connection, with no queue of helpers.
#[must_use]
pub struct PasswordHelperEndpoint {
    pipe: helper::Listener,
    image: PathBuf,
    started: Instant,
}

#[must_use]
pub struct PendingHelperRequest<'a>(helper::Request<'a>);

#[must_use]
pub enum Admission<'target, 'pipe> {
    Rejected,
    /// Keep only until `until`, and retry only after binding. Drop the
    /// request on cancellation or deadline expiry.
    WaitForChild {
        request: PendingHelperRequest<'pipe>,
        until: Instant,
    },
    Claimed {
        binding: ProbeBinding<'target>,
        until: Instant,
        reply: ClaimedHelperReply<'target, 'pipe>,
    },
}

impl<'a> PasswordHelperAttempt<'a> {
    /// Create the private endpoint and register a one-use token before spawn.
    /// `helper_image` must be the independently qualified helper image path
    /// (exact DOS spelling); a prompt, request or ambient PATH is not evidence
    /// of image trust. Path matching alone does not qualify a build.
    pub fn register(
        target: TargetGeneration<'a>,
        helper_image: &Path,
    ) -> io::Result<(Self, PasswordHelperEndpoint, [u8; 16])> {
        if !helper_image.is_absolute() {
            return Err(rejected());
        }
        let pipe = helper::Listener::create()?;
        let name = pipe.name().clone();
        let started = Instant::now();
        let (grant, token) = PasswordHelperGrant::register(target, Duration::ZERO)?;
        Ok((
            Self {
                grant,
                target,
                started,
                name,
                ssh: None,
            },
            PasswordHelperEndpoint {
                pipe,
                image: helper_image.to_owned(),
                started,
            },
            token,
        ))
    }

    /// Bind an independently retained launch handle, never a PID from the
    /// helper or from its environment. Verify the exact trusted SSH image.
    pub fn bind_child(
        &mut self,
        live_target: TargetGeneration<'_>,
        handle: BorrowedHandle<'_>,
        ssh_image: &Path,
    ) -> io::Result<ProbeBinding<'a>> {
        if live_target != self.target {
            self.revoke();
            return Err(rejected());
        }
        let peer = ExpectedPipePeer::from_spawned_image(handle, ssh_image)?;
        let child = VerifiedChild::from_verified_identity(helper::verify_child(&peer)?);
        if !self
            .grant
            .bind_child(live_target, child, self.started.elapsed())
        {
            return Err(rejected());
        }
        self.ssh = Some((peer, child));
        Ok(ProbeBinding {
            target: self.target,
            child,
        })
    }

    /// Run under the live generation fence. The target and generation are
    /// assigned to this endpoint locally, never decoded from a helper message.
    /// A rejected connection is closed without consuming a valid grant.
    pub fn admit<'pipe>(
        &mut self,
        live_target: TargetGeneration<'_>,
        request: PendingHelperRequest<'pipe>,
    ) -> Admission<'a, 'pipe> {
        if live_target != self.target {
            self.revoke();
            return Admission::Rejected;
        }
        self.grant.expire(live_target, self.started.elapsed());
        if request.0.name != &self.name {
            return Admission::Rejected;
        }
        let verified_parent = match &self.ssh {
            Some((peer, child)) if request.0.verify_parent(peer).is_ok() => Some(*child),
            Some(_) => return Admission::Rejected,
            None => None,
        };
        let Some(received_at) = request.0.arrived_at.checked_duration_since(self.started) else {
            return Admission::Rejected;
        };
        let input = HelperRequest {
            token: request.0.token,
            target: self.target,
            role: ReleaseRole::DestinationPassword,
            received_at,
        };
        match self
            .grant
            .admit(live_target, &input, verified_parent, self.started.elapsed())
        {
            HelperAdmission::Rejected => Admission::Rejected,
            HelperAdmission::WaitForChild { until } => match self.started.checked_add(until) {
                Some(until) => Admission::WaitForChild { request, until },
                None => Admission::Rejected,
            },
            HelperAdmission::Claimed { binding, until } => match self.started.checked_add(until) {
                Some(until) => Admission::Claimed {
                    binding,
                    until,
                    reply: ClaimedHelperReply {
                        request: request.0,
                        binding,
                        until,
                    },
                },
                None => Admission::Rejected,
            },
        }
    }

    /// Consume this claim and its zeroizing password under the live generation
    /// fence. Delivery is only for a dedicated destination-password-only probe
    /// with independently established launch facts, never an arbitrary prompt.
    /// A successful return attests to the helper's stdout handoff, not SSH
    /// authentication. Any error is terminal for this delivery; do not retry.
    pub fn deliver(
        &mut self,
        live_target: TargetGeneration<'_>,
        reply: ClaimedHelperReply<'_, '_>,
        qualification: ProbeQualification,
        bytes: PasswordBytes,
    ) -> io::Result<()> {
        if *reply.request.name != self.name {
            return Err(rejected());
        }
        let ssh = self.ssh.take();
        self.revoke();
        let Some((peer, child)) = ssh else {
            return Err(rejected());
        };
        if reply.binding.target != live_target
            || self.target != live_target
            || reply.binding.child != child
            || Instant::now() >= reply.until
            || PasswordCacheGate::start(reply.binding, qualification, self.started.elapsed())
                .is_none()
        {
            return Err(rejected());
        }
        reply.request.deliver(&peer, reply.until, bytes.as_slice())
    }

    /// Revoke on child exit, cancellation, disconnect or owner retirement;
    /// drop the corresponding pending request and endpoint at the same fence.
    pub fn revoke(&mut self) {
        self.grant.revoke();
        self.ssh = None;
    }
}

impl PasswordHelperEndpoint {
    pub fn name(&self) -> &PipeName {
        self.pipe.name()
    }

    /// A single overlapped accept + fixed-size request read, outside the
    /// generation fence. Neither accepts a queued connection after expiry nor
    /// extends the registration or request deadline.
    pub fn receive(&mut self, timeout: Duration) -> io::Result<PendingHelperRequest<'_>> {
        let remaining = PROBE_LIFETIME
            .checked_sub(self.started.elapsed())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::TimedOut, "password helper grant expired")
            })?;
        self.pipe
            .receive(&self.image, timeout.min(remaining))
            .map(PendingHelperRequest)
    }
}

/// The caller must independently pin the owner process from trusted bootstrap
/// state; a pipe-supplied PID, or an untrusted env value, is not sufficient.
/// Admission-only compatibility probe; it never reads a password. Returning
/// successfully means only the verified connection was closed.
pub fn submit_helper_request(
    name: &PipeName,
    expected_owner: &ExpectedPipePeer,
    token: [u8; 16],
) -> io::Result<()> {
    helper::submit(name, expected_owner, token, IO_BUDGET)
}

fn rejected() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "password helper admission rejected",
    )
}

/// One admitted destination request tied to its endpoint, target and child.
/// Dropping it closes the connection without delivery.
#[must_use]
pub struct ClaimedHelperReply<'target, 'pipe> {
    request: helper::Request<'pipe>,
    binding: ProbeBinding<'target>,
    until: Instant,
}

#[cfg(test)]
mod tests;
