//! One-shot Unix picker proof. SSH owns the agent's three byte streams;
//! the owner control pipe only carries the local child lease and exit status.

mod codex;
mod pi;
mod provider_binding;
mod provider_service;
pub(super) use provider_binding::ProviderKind;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) use provider_binding::recognized_version;
#[cfg_attr(not(target_os = "linux"), allow(unused_imports))]
pub(super) use provider_service::Kind as ProviderServiceKind;
pub(crate) mod agent_action;
pub(super) mod git_receive;
mod git_upload;
mod installed;
mod lease;
pub(crate) use lease::AgentProxy;
pub(crate) use lease::AgentProxyLease;
pub(crate) use lease::deferred_reaper;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod production;
#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(crate) use production::test_support;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) use production::{ProductionProxy, ServiceRecipe};
mod scoped_duplex;
pub(super) use scoped_duplex::ScopedDuplex;
pub(crate) mod relay;
mod relay_binding;

use super::random_token;
use super::transport::Transport;
use super::v1::{self, ErrorCode};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;

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

#[cfg(test)]
#[path = "owner_agent_proxy/tests.rs"]
mod tests;
