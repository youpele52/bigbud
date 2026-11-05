use super::{ProcessIdentity, inspect};
use crate::worker::ExecutionRoot;
use std::{
    io,
    num::NonZeroU32,
    os::unix::process::CommandExt,
    process::{Child, Command},
};

#[derive(Debug, Clone, Copy)]
pub enum RetirementSignal {
    Terminate,
    Kill,
}

/// Retains the child even when identity validation fails. The caller must keep
/// it fenced and resolve ownership; silently dropping it is not settlement.
#[derive(Debug)]
pub struct AnchorError {
    pub child: Child,
    pub error: io::Error,
}

#[derive(Debug)]
pub enum BootstrapError {
    BeforeSpawn(io::Error),
    Unsettled(AnchorError),
}

/// Sole owner of the unreaped direct child. No wait/try_wait/into_child API is
/// exposed: the only reap is `settle()`, after a fresh observation that the
/// known non-detaching closure settled (reaping earlier enables PGID reuse).
/// Spawn/signal refuse SIGCHLD auto-reaping; no competing waitpid may exist.
///
/// A stale/reaped Child must never be adoptable:
/// ```compile_fail
/// use bigbud_computer_use::worker::unix::AnchoredGroup;
/// fn adopt(child: std::process::Child) {
///     let _ = AnchoredGroup::retain(child, "worker-1");
/// }
/// ```
#[must_use = "retain until independently qualified helper-closure settlement"]
pub struct AnchoredGroup {
    _child: Child,
    /// Set only by confirmed settlement (or private test teardown) after reap.
    reaped: bool,
    #[cfg(test)]
    signal_attempts: std::sync::atomic::AtomicUsize,
    identity: ProcessIdentity,
    root: ExecutionRoot,
    #[cfg(target_os = "linux")]
    pidfd: Option<std::os::fd::OwnedFd>,
}
impl AnchoredGroup {
    /// Dormant source: only the future trusted first-party bootstrap, blocked
    /// awaiting authenticated admission, may be passed here. No role calls this
    /// yet. Driver/helper work is forbidden until durable roots/full gates pass.
    /// Spawn and retention are inseparable: accepting an arbitrary Child would
    /// allow a previously reaped handle's PID to refer to a replacement child.
    // Only the macOS private bootstrap launches anchors until other owners exist.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn spawn_bootstrap(
        command: &mut Command,
        generation: &str,
        launch: &super::LaunchGuard,
    ) -> Result<Self, BootstrapError> {
        if !crate::guard::record::valid_id(generation) {
            return Err(BootstrapError::BeforeSpawn(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid generation",
            )));
        }
        refuse_child_auto_reap().map_err(BootstrapError::BeforeSpawn)?;
        // Held exclusion: no concurrent crate launch can be creating/CLOEXEC-
        // repairing descriptors that this child might inherit.
        let _held: &super::LaunchGuard = launch;
        command.process_group(0);
        let child = command.spawn().map_err(BootstrapError::BeforeSpawn)?;
        Self::retain(child, generation).map_err(BootstrapError::Unsettled)
    }

    // Private: no caller can supply a cached/already-reaped std Child handle.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn retain(child: Child, generation: &str) -> Result<Self, AnchorError> {
        let prepare = || -> io::Result<_> {
            if !crate::guard::record::valid_id(generation) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid generation",
                ));
            }
            let pid =
                NonZeroU32::new(child.id()).ok_or_else(|| io::Error::other("invalid child"))?;
            let identity = inspect(pid)?;
            validate_anchor(&identity, std::process::id())?;
            Ok(identity)
        };
        let identity = match prepare() {
            Ok(identity) => identity,
            Err(error) => return Err(AnchorError { child, error }),
        };
        #[cfg(target_os = "linux")]
        let pidfd = match super::pidfd::open(identity.pid) {
            Ok(fd) => fd,
            Err(error) => return Err(AnchorError { child, error }),
        };
        let root = ExecutionRoot {
            pid: identity.pid,
            creation_identity: identity.creation.clone(),
            generation: generation.into(),
        };
        Ok(Self {
            _child: child,
            reaped: false,
            #[cfg(test)]
            signal_attempts: std::sync::atomic::AtomicUsize::new(0),
            identity,
            root,
            #[cfg(target_os = "linux")]
            pidfd,
        })
    }
    pub fn root(&self) -> &ExecutionRoot {
        &self.root
    }

    /// Leader exit is NOT helper-closure settlement. Do not reap or replace.
    pub fn leader_exited(&self) -> io::Result<bool> {
        #[cfg(target_os = "linux")]
        if let Some(fd) = &self.pidfd {
            return super::pidfd::exited(fd);
        }
        observe_unreaped_child(self.identity.pid)
    }

    /// Invoke out of band after revocation, never on the blocked MCP lane. A
    /// successful signal is NOT observed retirement, neutral input or permission
    /// to reap/replace. Retained anchor prevents PGID reuse under sole-wait ownership.
    pub fn signal(&self, signal: RetirementSignal) -> io::Result<()> {
        if self.reaped {
            return Err(io::Error::other("anchor already reaped"));
        }
        validate_anchor(&self.identity, std::process::id())?;
        if self._child.id() != self.identity.pid.get() {
            return Err(io::Error::other("anchor owner changed"));
        }
        // Darwin proc_pidinfo refuses zombie leaders (ESRCH), although waitid
        // still proves this exact direct child is retained unreaped. Observe
        // FIRST: requiring a live-process inspector after exit would prevent
        // emergency signals to remaining members of the pinned group.
        refuse_child_auto_reap()?;
        let leader_exited = observe_unreaped_child(self.identity.pid)?;
        if !leader_exited {
            match inspect(self.identity.pid) {
                Ok(current) => {
                    validate_anchor(&current, std::process::id())?;
                    if current != self.identity {
                        return Err(io::Error::other("anchor identity changed"));
                    }
                }
                // The leader may exit between observation and inspection
                // (Darwin refuses zombie inspection). Only a fresh, genuine
                // exit event replaces live validation; otherwise keep the error.
                Err(error) => {
                    if !observe_unreaped_child(self.identity.pid)? {
                        return Err(error);
                    }
                }
            }
        }
        // WNOWAIT + sole Child ownership pins the original group even after
        // exit; no reaping/adoption API exists. This grants ONLY the previously
        // retained signal authority, never closure settlement or replacement.
        let pid = i32::try_from(self.identity.pid.get())
            .map_err(|_| io::Error::other("invalid anchor pid"))?;
        let signal = match signal {
            RetirementSignal::Terminate => libc::SIGTERM,
            RetirementSignal::Kill => libc::SIGKILL,
        };
        #[cfg(test)]
        self.signal_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // SAFETY: negative PGID is the verified owned group leader (>1), retained
        // unreaped with sole wait ownership. No arbitrary PID/name is accepted.
        let result = unsafe { libc::kill(-pid, signal) };
        if result != 0 {
            let error = io::Error::last_os_error();
            // A zombie-only pinned group refuses killpg (ESRCH, or EPERM on
            // some hosts). With the leader's exit confirmed, that is "nothing
            // live to signal" ONLY if every other member is also a zombie.
            // This is never settlement; closure() alone confirms that.
            if leader_exited
                && matches!(error.raw_os_error(), Some(libc::ESRCH | libc::EPERM))
                && self.live_members_after_exit()? == 0
            {
                return Ok(());
            }
            return Err(error);
        }
        Ok(())
    }
}

/// Abandonment is owner loss: an unsettled owner is never silently released.
/// Best-effort exact-group KILL (identity-checked by `signal`) WITHOUT reaping;
/// the durable root stays recorded, so the next recovery starts paused and
/// unsettled. Drop cannot report failure; it is not retirement evidence.
impl Drop for AnchoredGroup {
    fn drop(&mut self) {
        if !self.reaped {
            let _abandoned = self.signal(RetirementSignal::Kill);
        }
    }
}

pub(super) fn validate_anchor(identity: &ProcessIdentity, parent: u32) -> io::Result<()> {
    if identity.pid.get() <= 1
        || identity.pid.get() > i32::MAX as u32
        || identity.pid.get() != identity.group
        || identity.parent != parent
        || !crate::guard::record::valid_id(&identity.creation)
    {
        return Err(io::Error::other("not an owned group anchor"));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn observe_unreaped_child(pid: NonZeroU32) -> io::Result<bool> {
    // SAFETY: zero is a valid siginfo storage representation; initializing it
    // covers kernels leaving the buffer untouched for a WNOHANG non-event.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: valid siginfo storage; positive owned PID. WNOWAIT leaves even a
    // zombie leader unreaped. WNOHANG forbids waiting on execution progress.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid.get(),
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful waitid initialized SIGCHLD fields (or left zero for
    // no event); si_pid reads only the matching signal-info process field.
    let observed = unsafe { info.si_pid() };
    if observed == 0 {
        return Ok(false);
    }
    let expected = i32::try_from(pid.get()).map_err(|_| io::Error::other("invalid anchor pid"))?;
    if observed != expected
        || info.si_signo != libc::SIGCHLD
        || ![libc::CLD_EXITED, libc::CLD_KILLED, libc::CLD_DUMPED].contains(&info.si_code)
    {
        return Err(io::Error::other("unexpected child event"));
    }
    Ok(true)
}
/// Kernel auto-reaping (SIG_IGN or SA_NOCLDWAIT, inheritable across exec)
/// would let a PID/PGID be reused while we believe the leader is pinned.
fn refuse_child_auto_reap() -> io::Result<()> {
    // SAFETY: zeroed sigaction is valid output storage; a NULL new action makes
    // this a read-only query of this process's SIGCHLD disposition.
    let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
    // SAFETY: valid signal number, NULL new action and writable old storage.
    if unsafe { libc::sigaction(libc::SIGCHLD, std::ptr::null(), &mut current) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if current.sa_sigaction == libc::SIG_IGN || current.sa_flags & libc::SA_NOCLDWAIT != 0 {
        return Err(io::Error::other(
            "SIGCHLD auto-reaping forbids anchor ownership",
        ));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn observe_unreaped_child(_: NonZeroU32) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "anchor unavailable",
    ))
}

#[path = "closure.rs"]
mod closure;
pub use closure::{ClosureState, SettleError, SettledRoot};
#[cfg(test)]
#[path = "dummy_cleanup.rs"]
mod dummy_cleanup;
