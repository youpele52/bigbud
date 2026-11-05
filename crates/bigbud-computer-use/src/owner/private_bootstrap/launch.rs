use super::{ChildBootstrap, endpoint::Endpoint, exchange::ParentExchange, route::Route};
use crate::{
    Role,
    guard::SessionInvalidator,
    owner::{
        AuthenticatedPeer, BootstrapCapability, image_preflight::ImagePreflight,
        issuer::LaunchGuard,
    },
    worker::unix::{AnchoredGroup, BootstrapError},
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::{
    io,
    os::{
        fd::{FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::PathBuf,
    process::{Command, Stdio},
    time::Instant,
};

/// One-use launch authority. The ONLY constructor is the trusted issuer
/// (`RetainedRecovery::issue_bootstrap`), which binds retained election and
/// verified root-free storage, a fresh interactive-identity sample, an approved
/// first-party digest and a clean FD audit. No approved generation exists yet
/// (M6.2), so production never mints one. Spawn consumes it and rechecks
/// session invalidation and the recovery launch fence (quiesce bumps it).
///
/// Every type and path below resolves; only privacy refuses the forgeries.
/// ```
/// use bigbud_computer_use::{Role, owner::{image_preflight::ImagePreflight,
///     issuer::ApprovedGeneration, private_bootstrap::BootstrapPermit}};
/// fn named(_: BootstrapPermit, _: ImagePreflight) -> std::io::Result<ApprovedGeneration> {
///     ApprovedGeneration::selected(Role::Owner)
/// }
/// ```
/// ```compile_fail,E0451
/// use bigbud_computer_use::{Role, owner::{image_preflight::ImagePreflight,
///     private_bootstrap::BootstrapPermit}};
/// fn forge(image: ImagePreflight) -> BootstrapPermit {
///     BootstrapPermit { executable: std::path::PathBuf::new(), image, digest: [0; 32],
///         role: Role::Owner, generation: String::new(), bound: todo!() }
/// }
/// ```
/// ```compile_fail,E0451
/// use bigbud_computer_use::{Role, owner::issuer::ApprovedGeneration};
/// let forged = ApprovedGeneration { role: Role::Owner, generation: String::new(), digest: [0; 32] };
/// ```
/// ```compile_fail,E0599
/// use bigbud_computer_use::{Role, owner::issuer::ApprovedGeneration};
/// let forged = ApprovedGeneration::fixture(Role::Owner, "owner-1", [0; 32]);
/// ```
/// ```compile_fail,E0277
/// fn send<T: Send>() {}
/// send::<bigbud_computer_use::owner::private_bootstrap::BootstrapPermit>();
/// ```
pub struct BootstrapPermit {
    executable: PathBuf,
    image: ImagePreflight,
    digest: [u8; 32],
    role: Role,
    generation: String,
    bound: IssuerBinding,
    /// `!Send`/`!Sync`: issue, fence checks and spawn stay on one thread.
    _thread_bound: std::marker::PhantomData<*const ()>,
}
/// Live recovery state a permit must still satisfy at spawn time.
pub(in crate::owner) struct IssuerBinding {
    pub(in crate::owner) session: SessionInvalidator,
    pub(in crate::owner) fence: Arc<AtomicU64>,
    pub(in crate::owner) fence_epoch: u64,
}
impl BootstrapPermit {
    /// Production path: always refuses. The only constructor is the trusted
    /// issuer (`RetainedRecovery::issue_bootstrap`), which needs an approved
    /// first-party generation that does not exist yet (M6.2 blocked).
    pub fn verify() -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "bootstrap requires the trusted issuer and an approved first-party generation",
        ))
    }

    pub(in crate::owner) fn issued(
        executable: PathBuf,
        image: ImagePreflight,
        digest: [u8; 32],
        (role, generation): (Role, String),
        bound: IssuerBinding,
    ) -> Self {
        Self {
            executable,
            image,
            digest,
            role,
            generation,
            bound,
            _thread_bound: std::marker::PhantomData,
        }
    }

    /// Test-only: simulates content drift that metadata revalidation missed.
    #[cfg(test)]
    pub(in crate::owner) fn with_digest_for_test(mut self, digest: [u8; 32]) -> Self {
        self.digest = digest;
        self
    }

    pub fn role(&self) -> Role {
        self.role
    }

    fn still_valid(&self) -> io::Result<()> {
        if self.bound.session.cause().is_some() {
            return Err(io::Error::other("session invalidated after issuance"));
        }
        if self.bound.fence.load(Ordering::SeqCst) != self.bound.fence_epoch {
            return Err(io::Error::other("launch fenced after issuance"));
        }
        if self.image.sha256()? != self.digest {
            return Err(io::Error::other("first-party image changed after issuance"));
        }
        Ok(())
    }

    /// Dormant source only. Must be the first startup action after exec, before
    /// threads, stdin readers or other launches. The future permit must prove
    /// that phase and exclusive ownership of this first-party stdin slot.
    pub fn read_inherited_stdin(self) -> io::Result<ChildBootstrap> {
        let deadline = BootstrapCapability::startup_deadline()?;
        read_startup_stdin(deadline)
    }
}

// Shared dedicated-startup implementation; production entry still requires the
// unavailable permit. Only the private cfg(test) dummy fixture calls it directly.
fn read_startup_stdin(deadline: Instant) -> io::Result<ChildBootstrap> {
    // SAFETY: the unavailable production permit must establish this dedicated
    // startup phase and exclusive ownership of fd 0. No existing Driver/MCP
    // or generic stdin caller is routed through this boundary.
    let fd = unsafe { OwnedFd::from_raw_fd(libc::STDIN_FILENO) };
    // SAFETY: live exclusively owned stdin; F_GETFD reads flags, no pointer.
    let flags = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: same owned fd; process-wide launch exclusion must remain held
    // until CLOEXEC is restored after the authorized child stdin mapping.
    if unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    ChildBootstrap::read(UnixStream::from(fd), deadline)
}

#[cfg(test)]
#[allow(dead_code)] // Used only by the explicitly invoked dummy integration target.
pub(super) fn read_dummy_startup_stdin(deadline: Instant) -> io::Result<ChildBootstrap> {
    read_startup_stdin(deadline)
}

#[must_use = "deliver or abort and retain the unsettled child anchor"]
pub struct PendingChild {
    anchor: AnchoredGroup,
    exchange: ParentExchange,
    endpoint: Endpoint,
    route: Route,
    role: Role,
}
#[must_use = "authenticate or abort and retain the unsettled child anchor"]
pub struct AwaitingChild {
    anchor: AnchoredGroup,
    capability: BootstrapCapability,
    endpoint: Endpoint,
    deadline: Instant,
}
pub struct ConnectedChild {
    pub anchor: AnchoredGroup,
    pub peer: AuthenticatedPeer,
}
pub struct DeliveryFailure {
    pub anchor: AnchoredGroup,
    pub error: io::Error,
}
impl PendingChild {
    /// Constructs its command exclusively from the permit's first-party image.
    /// No arbitrary Command/argv/env or legacy MCP escape. std's stdin file action
    /// maps only the courier to fd 0; original descriptors stay CLOEXEC in parent.
    /// Command is dropped after spawn on success AND failure to close its copy.
    /// Consumes the permit (one-use); a refused spawn never returns it.
    pub fn spawn(
        permit: BootstrapPermit,
        guard: &LaunchGuard,
        role: Role,
        generation: &str,
    ) -> Result<Self, BootstrapError> {
        if role != permit.role || generation != permit.generation {
            return Err(BootstrapError::BeforeSpawn(io::Error::other(
                "permit role/generation mismatch",
            )));
        }
        // Checked early (deterministic refusal before any resource creation)
        // and again immediately before exec below.
        permit.still_valid().map_err(BootstrapError::BeforeSpawn)?;
        let deadline =
            BootstrapCapability::startup_deadline().map_err(BootstrapError::BeforeSpawn)?;
        let endpoint = Endpoint::create(deadline).map_err(BootstrapError::BeforeSpawn)?;
        let route =
            Route::current(endpoint.directory.nonce).map_err(BootstrapError::BeforeSpawn)?;
        let (exchange, child) =
            ParentExchange::pair(deadline).map_err(BootstrapError::BeforeSpawn)?;
        let mut command = Command::new(&permit.executable);
        command.env_clear().arg(match role {
            Role::Guard => "guard",
            Role::Owner => "owner",
            Role::Worker => "worker",
            Role::Broker => "broker",
        });
        command
            .stdin(Stdio::from(OwnedFd::from(child)))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Courier/endpoint descriptors exist now; nothing else may be inherited.
        guard
            .audit_descriptors(&[])
            .map_err(BootstrapError::BeforeSpawn)?;
        // Re-check binding and re-hash as late as possible before exec.
        permit.still_valid().map_err(BootstrapError::BeforeSpawn)?;
        let result = AnchoredGroup::spawn_bootstrap(&mut command, generation, guard);
        drop(command);
        let anchor = result?;
        Ok(Self {
            anchor,
            exchange,
            endpoint,
            route,
            role,
        })
    }

    /// Consumes issuance; no retry can reuse this child/courier/secret binding.
    /// ```compile_fail
    /// use bigbud_computer_use::owner::private_bootstrap::PendingChild;
    /// fn retry(pending: PendingChild) {
    ///     let _ = pending.deliver();
    ///     let _ = pending.deliver();
    /// }
    /// ```
    pub fn deliver(self) -> Result<AwaitingChild, Box<DeliveryFailure>> {
        let Self {
            anchor,
            exchange,
            endpoint,
            route,
            role,
        } = self;
        let deadline = exchange.deadline;
        match exchange.deliver_routed(anchor.root().clone(), role, &route) {
            Ok(capability) => Ok(AwaitingChild {
                anchor,
                capability,
                endpoint,
                deadline,
            }),
            Err(error) => Err(Box::new(DeliveryFailure { anchor, error })),
        }
    }

    pub fn abort(self) -> AnchoredGroup {
        drop(self.exchange);
        self.anchor
    }
}
impl AwaitingChild {
    /// Accept and authentication share this ORIGINAL pre-spawn deadline.
    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn accept(self) -> Result<ConnectedChild, Box<DeliveryFailure>> {
        let Self {
            anchor,
            mut capability,
            endpoint,
            deadline,
        } = self;
        // One owned listener and one candidate; never use inherited creator
        // credentials as child identity, nor retry an invalid connecting peer.
        let result = endpoint
            .accept(deadline)
            .and_then(|stream| capability.authenticate_stream(stream));
        match result {
            Ok(peer) => Ok(ConnectedChild { anchor, peer }),
            Err(error) => Err(Box::new(DeliveryFailure { anchor, error })),
        }
    }

    pub fn abort(self) -> AnchoredGroup {
        self.anchor
    }
}
