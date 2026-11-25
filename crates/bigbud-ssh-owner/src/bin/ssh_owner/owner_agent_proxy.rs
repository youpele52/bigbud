//! One-shot Unix picker proof. SSH owns the agent's three byte streams;
//! the owner control pipe only carries the local child lease and exit status.

mod codex;
mod pi;
mod provider_binding;
mod provider_service;
pub(super) use provider_binding::ProviderKind;
#[cfg_attr(not(target_os = "linux"), allow(unused_imports))]
pub(super) use provider_service::Kind as ProviderServiceKind;
pub(crate) mod agent_action;
pub(super) mod git_receive;
mod git_upload;
mod installed;
mod scoped_duplex;
pub(super) use scoped_duplex::ScopedDuplex;
mod relay;
mod relay_binding;

use super::transport::{PinnedSsh, Transport};
use super::v1::{self, ErrorCode};
use super::{Token, random_token};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus, Stdio};
use std::sync::mpsc::{self, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CLOSE_MS: u32 = 5_000;
const TERM_GRACE: Duration = Duration::from_millis(250);
const POLL: Duration = Duration::from_millis(5);

pub(super) struct AgentProxyFixture {
    binary: PathBuf,
    sha256: String,
    pipes: Option<[File; 3]>,
    installed: Option<installed::Recipe>,
    relay: Option<relay::Recipe>,
    provider: Option<provider_binding::ProviderBinding>,
    scoped: Option<ScopedDuplex>,
}

impl AgentProxyFixture {
    /// # Safety
    /// Call once at startup, before opening other files or spawning anything.
    /// The launcher must have transferred exclusive ownership of fds 3, 4, 5.
    pub(super) unsafe fn new(binary: PathBuf, sha256: String) -> io::Result<Self> {
        // SAFETY: the startup caller transfers the three distinct descriptors.
        let pipes = unsafe { adopt_pipes([3, 4, 5]) }?;
        if !valid_sha256(&sha256) {
            return Err(invalid_fixture());
        }
        fixture_file(&binary)?;
        Ok(Self {
            binary,
            sha256,
            pipes: Some(pipes),
            installed: None,
            relay: None,
            provider: None,
            scoped: None,
        })
    }

    /// Bind the isolated installed proxy to exact remote paths and a SHA-256
    /// supplied by the trusted startup launcher, never by the control client.
    ///
    /// # Safety
    /// As for `new`: transferred fds 3, 4, 5 must be exclusively owned, and
    /// this must be called once at startup before opening other handles.
    pub(super) unsafe fn new_installed(
        binary: PathBuf,
        sha256: String,
        state_dir: PathBuf,
    ) -> io::Result<Self> {
        // SAFETY: the startup caller transfers the three distinct descriptors.
        let pipes = unsafe { adopt_pipes([3, 4, 5]) }?;
        let installed = installed::Recipe::new(&binary, &sha256, &state_dir)?;
        Ok(Self {
            binary,
            sha256,
            pipes: Some(pipes),
            installed: Some(installed),
            relay: None,
            provider: None,
            scoped: None,
        })
    }

    pub(super) fn open(
        &mut self,
        transport: &Transport,
        input: &v1::ProofAgentProxyOpen,
    ) -> Result<AgentProxyLease, ErrorCode> {
        let binary = self.binary.to_str().ok_or(ErrorCode::OperationDenied)?;
        if self.relay.is_some()
            || self.provider.is_some()
            || self.scoped.is_some()
            || self.pipes.is_none()
            || input.binary_path != binary
            || input.sha256 != self.sha256
        {
            return Err(ErrorCode::OperationDenied);
        }
        let remote = match &self.installed {
            Some(recipe) => recipe.command().to_owned(),
            None => {
                verify_digest(&self.binary, &self.sha256)
                    .map_err(|_| ErrorCode::OperationDenied)?;
                format!("exec '{}' --ephemeral", binary.replace('\'', "'\\''"))
            }
        };
        self.launch(transport, &remote)
    }

    fn launch(
        &mut self,
        transport: &Transport,
        remote: &str,
    ) -> Result<AgentProxyLease, ErrorCode> {
        transport.revalidate_policy()?;
        let pinned = transport.pinned_ssh("-T")?;
        let token = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let reap = deferred_reaper().map_err(|_| ErrorCode::OwnerUnavailable)?;
        // Even a failed spawn consumes these exact streams: a request may not
        // retarget them or retry after their ownership has been transferred.
        let pipes = self.pipes.take().ok_or(ErrorCode::OperationDenied)?;
        AgentProxyLease::launch(pinned, transport.host(), remote, pipes, token, reap)
    }
}

fn valid_sha256(sha256: &str) -> bool {
    sha256.len() == 64
        && sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

// Product provider launch over the transferred pipes. The caller must already
// have validated the owner-compiled recipe; this only builds the pinned,
// forward-free SSH invocation.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(super) fn launch_provider_pipes(
    transport: &Transport,
    remote: &str,
    pipes: [File; 3],
) -> Result<AgentProxyLease, ErrorCode> {
    transport.revalidate_policy()?;
    let pinned = transport.pinned_ssh("-T")?;
    let token = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
    let reap = deferred_reaper().map_err(|_| ErrorCode::OwnerUnavailable)?;
    AgentProxyLease::launch(pinned, transport.host(), remote, pipes, token, reap)
}

/// The caller transfers three distinct, live, unowned descriptors in stdio order.
unsafe fn adopt_pipes(fds: [RawFd; 3]) -> io::Result<[File; 3]> {
    for fd in fds {
        // SAFETY: the fd is inherited and exclusively transferred by the caller;
        // fcntl only inspects/changes its descriptor flags.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        // SAFETY: F_SETFD accepts an integer flag word for this live fd.
        if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1
        {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: fcntl confirmed all three distinct fds are live; the caller
    // transferred exclusive ownership and none is passed to File twice.
    let pipes = fds.map(|fd| unsafe { File::from_raw_fd(fd) });
    for (index, pipe) in pipes.iter().enumerate() {
        // SAFETY: file owns the descriptor for this F_GETFL call.
        let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        let access = flags & libc::O_ACCMODE;
        let kind = pipe.metadata()?.file_type();
        let expected = if index == 0 {
            libc::O_RDONLY
        } else {
            libc::O_WRONLY
        };
        if (!kind.is_fifo() && !kind.is_socket()) || (access != expected && access != libc::O_RDWR)
        {
            return Err(invalid_fixture());
        }
    }
    Ok(pipes)
}

fn invalid_fixture() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid proof agent fixture")
}

fn fixture_file(path: &Path) -> io::Result<(File, Metadata)> {
    let name = path.to_str().ok_or_else(invalid_fixture)?;
    if !path.is_absolute()
        || name.chars().any(char::is_control)
        || fs::canonicalize(path)?.as_os_str() != path.as_os_str()
    {
        return Err(invalid_fixture());
    }
    // SAFETY: geteuid observes only the current process.
    let uid = unsafe { libc::geteuid() };
    let parent = fs::symlink_metadata(path.parent().ok_or_else(invalid_fixture)?)?;
    if !parent.is_dir() || parent.uid() != uid || parent.mode() & 0o077 != 0 {
        return Err(invalid_fixture());
    }
    let file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let entry = file.metadata()?;
    if !entry.is_file()
        || entry.uid() != uid
        || entry.nlink() != 1
        || !matches!(entry.mode() & 0o7777, 0o500 | 0o700)
        || !(1..=MAX_BINARY_BYTES).contains(&entry.len())
    {
        return Err(invalid_fixture());
    }
    Ok((file, entry))
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
}

fn verify_digest(path: &Path, expected: &str) -> io::Result<()> {
    let (file, before) = fixture_file(path)?;
    let mut digest = Sha256::new();
    let bytes = io::copy(&mut (&file).take(MAX_BINARY_BYTES + 1), &mut digest)?;
    // Path-based execution is deliberately limited to the same private local
    // fixture. No execution authority is granted to a different remote path.
    if bytes != before.len()
        || bytes > MAX_BINARY_BYTES
        || !same_file(&before, &fs::symlink_metadata(path)?)
        || format!("{:x}", digest.finalize()) != expected
    {
        return Err(invalid_fixture());
    }
    Ok(())
}

type Reaper = SyncSender<(Child, PinnedSsh)>;

struct Running {
    child: Child,
    pin: PinnedSsh,
    reap: Reaper,
}

// Pre-arm the exceptional cleanup path before spawn. A stuck child must not
// make Drop unbounded, nor release the host pin while it is still running.
fn deferred_reaper() -> io::Result<Reaper> {
    let (send, recv) = mpsc::sync_channel::<(Child, PinnedSsh)>(1);
    thread::Builder::new()
        .name("proof-agent-proxy-reap".into())
        .spawn(move || {
            if let Ok((mut child, _pin)) = recv.recv() {
                let _kill_requested = child.kill();
                let _reaped_or_no_child = child.wait();
            }
        })?;
    Ok(send)
}

pub(super) struct AgentProxyLease {
    token: Token,
    pid: u32,
    running: Option<Running>,
    exit: Option<ExitStatus>,
}

impl AgentProxyLease {
    fn launch(
        mut pinned: PinnedSsh,
        host: &str,
        remote: &str,
        [stdin, stdout, stderr]: [File; 3],
        token: Token,
        reap: Reaper,
    ) -> Result<Self, ErrorCode> {
        pinned
            .command
            .args(["-o", "EscapeChar=none", "--", host, remote]);
        Self::launch_pinned(pinned, [stdin, stdout, stderr], token, reap)
    }

    fn launch_pinned(
        mut pinned: PinnedSsh,
        [stdin, stdout, stderr]: [File; 3],
        token: Token,
        reap: Reaper,
    ) -> Result<Self, ErrorCode> {
        let child = pinned
            .command
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(stdin)
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        // Command is reusable and still owns the inherited pipe ends. Close
        // those copies now so only SSH can hold them open, not the pin lease.
        pinned
            .command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Ok(Self {
            token,
            pid: child.id(),
            running: Some(Running {
                child,
                pin: pinned,
                reap,
            }),
            exit: None,
        })
    }

    fn refresh_exit(&mut self) -> Result<bool, ErrorCode> {
        if let Some(running) = &mut self.running {
            let Some(exit) = running
                .child
                .try_wait()
                .map_err(|_| ErrorCode::OutcomeUnknown)?
            else {
                return Ok(false);
            };
            self.exit = Some(exit);
            self.running = None;
        }
        Ok(true)
    }

    pub(super) fn status(&mut self) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        let closed = self.refresh_exit()?;
        Ok(v1::ProofAgentProxyStatus {
            lease: self.token.to_vec(),
            pid: self.pid,
            closed,
            code: self.exit.and_then(|exit| exit.code()),
            signal: self.exit.and_then(|exit| exit.signal()),
        })
    }

    pub(super) fn close(
        &mut self,
        terminate: bool,
        timeout_ms: u32,
    ) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        let timeout = Duration::from_millis(u64::from(timeout_ms.min(MAX_CLOSE_MS)));
        let start = Instant::now();
        if terminate && !self.refresh_exit()? {
            let pid = i32::try_from(self.pid).map_err(|_| ErrorCode::OutcomeUnknown)?;
            // SAFETY: this positive PID belongs to our direct, not-yet-reaped
            // child. Only this lease can wait for it until ownership is moved
            // to the fallback reaper. We never signal a request-supplied PID.
            let _term_requested = unsafe { libc::kill(pid, libc::SIGTERM) };
            if !self.wait_until(start + TERM_GRACE.min(timeout / 2))?
                && let Some(running) = &mut self.running
            {
                // Only reaping confirms termination, even if kill succeeded.
                let _kill_requested = running.child.kill();
            }
        }
        if self.wait_until(start + timeout)? {
            self.status()
        } else {
            Err(ErrorCode::OutcomeUnknown)
        }
    }

    fn wait_until(&mut self, deadline: Instant) -> Result<bool, ErrorCode> {
        loop {
            if self.refresh_exit()? {
                return Ok(true);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            thread::sleep(remaining.min(POLL));
        }
    }
}

impl Drop for AgentProxyLease {
    fn drop(&mut self) {
        let _close = self.close(true, 500);
        if let Some(Running { child, pin, reap }) = self.running.take() {
            // The receiver cannot leave recv before the only send or sender
            // drop. In particular no worker ever waits/reaps concurrently with us.
            let _transferred_to_reaper = reap.send((child, pin));
        }
    }
}

#[cfg(test)]
#[path = "owner_agent_proxy/tests.rs"]
mod tests;
