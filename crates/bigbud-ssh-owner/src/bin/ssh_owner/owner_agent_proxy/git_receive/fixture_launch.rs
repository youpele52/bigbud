//! Disposable Linux graph: stock Git → private pipes → native connector → pinned SSH.
//! The trusted startup owner freezes the same-UID fixture and selects a direct,
//! loopback Transport. No pathname, executable or remote command comes from IPC.

use super::tracked_push::{ActivePush, PushLease, TrackedPushBinding};
use crate::transport::Transport;
use bigbud_ssh_owner::git_receive_gate::DestinationReceipt;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

#[path = "fixture_launch.graph.rs"]
mod graph;
#[path = "fixture_launch.scope.rs"]
mod scope;

const HOST: &str = "127.0.0.1";
const USER: &str = "picker";
const PORT: u16 = 22222;
const URL: &str = "ssh://picker@127.0.0.1:22222/receive.git";
const REMOTE_PATH: &str = "/receive.git";
const REMOTE_COMMAND: &str = "git-receive-pack '/receive.git'";
const BRANCH: &str = "refs/heads/main";

pub(crate) struct FixtureLauncher {
    scope: scope::Scope,
    busy: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

impl FixtureLauncher {
    pub(crate) fn new(root: &Path) -> io::Result<Self> {
        Self::new_with_cancel(root, Arc::new(AtomicBool::new(false)))
    }

    pub(crate) fn new_with_cancel(root: &Path, cancelled: Arc<AtomicBool>) -> io::Result<Self> {
        Ok(Self {
            scope: scope::Scope::new(root)?,
            busy: Arc::new(AtomicBool::new(false)),
            cancelled,
        })
    }

    pub(crate) fn launch(
        &self,
        transport: &Transport,
        binding: &TrackedPushBinding,
        deadline: Instant,
    ) -> io::Result<ActivePush<FixtureLease>> {
        if !self.scope.matches(binding) || transport.host() != HOST {
            return Err(denied());
        }
        self.check_deadline(deadline)?;
        self.scope.revalidate()?;
        transport.revalidate_policy().map_err(|_| denied())?;
        let mut pin = transport.pinned_ssh("-T").map_err(|_| denied())?;
        // Reject changed fixture paths before starting either child. The
        // owner pin snapshot stays with the graph until SSH has been reaped.
        self.scope.revalidate()?;
        self.check_deadline(deadline)?;
        let mut graph = graph::Graph::new(Arc::clone(&self.busy))?;
        let (git_input, to_owner) = io::pipe()?;
        let (from_owner, git_output) = io::pipe()?;
        let read_fd = from_owner.as_raw_fd();
        let write_fd = to_owner.as_raw_fd();
        let mut git = git_command(&self.scope.worktree, &binding.source_oid, read_fd, write_fd);
        isolate(&mut git, Some((read_fd, write_fd)));
        graph.set_git(git.spawn()?);
        drop((from_owner, to_owner));

        self.check_deadline(deadline)?;
        let ssh = &mut pin.command;
        ssh.env_clear()
            .env("LC_ALL", "C")
            .args(["-o", "EscapeChar=none", "--", HOST, REMOTE_COMMAND])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        isolate(ssh, None);
        let child = ssh.spawn()?;
        let child = graph.set_ssh(child, pin);
        let receive_output = child.stdout.take().ok_or_else(denied)?;
        let receive_input = child.stdin.take().ok_or_else(denied)?;
        Ok(ActivePush {
            git_input: File::from(OwnedFd::from(git_input)),
            git_output: File::from(OwnedFd::from(git_output)),
            receive_output: File::from(OwnedFd::from(receive_output)),
            receive_input: File::from(OwnedFd::from(receive_input)),
            lease: FixtureLease {
                graph,
                cancelled: Arc::clone(&self.cancelled),
            },
        })
    }

    fn check_deadline(&self, deadline: Instant) -> io::Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        Ok(())
    }
}

pub(crate) struct FixtureLease {
    graph: graph::Graph,
    cancelled: Arc<AtomicBool>,
}

impl PushLease for FixtureLease {
    fn is_current(&mut self) -> bool {
        // Both reservations are exclusively owned until retirement. The only
        // asynchronous policy change admitted by this startup lane is abort.
        !self.is_cancelled() && self.graph.children_running()
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn retire(self, deadline: Instant, receipt: DestinationReceipt) {
        self.graph.retire(deadline, receipt);
    }
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "unsupported Git push fixture scope",
    )
}

fn git_command(worktree: &Path, source: &str, read_fd: i32, write_fd: i32) -> Command {
    let mut command = Command::new("/usr/bin/git");
    command
        .current_dir(worktree)
        .env_clear()
        .env("LC_ALL", "C")
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_EXEC_PATH", "/usr/lib/git-core")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ALLOW_PROTOCOL", "fd")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .args([
            "--git-dir=.git",
            "--work-tree=.",
            "-c",
            "protocol.version=0",
            "-c",
            "core.hooksPath=/dev/null",
            "push",
            "--no-signed",
            "--no-verify",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--",
        ])
        .arg(format!("fd::{read_fd},{write_fd}"))
        .arg(format!("{source}:{BRANCH}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn isolate(command: &mut Command, inherit: Option<(i32, i32)>) {
    command.process_group(0);
    // SAFETY: these process queries take no pointer arguments. The post-fork
    // closure uses only simple syscalls; the captured pipe ends outlive spawn.
    // CLOEXEC (not close) preserves Rust's spawn-error pipe until exec.
    unsafe {
        let owner = libc::getpid();
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            // Detect owner death in the interval before installing the signal.
            if libc::getppid() != owner {
                return Err(io::Error::from_raw_os_error(libc::ECHILD));
            }
            if libc::syscall(
                libc::SYS_close_range,
                3u32,
                u32::MAX,
                libc::CLOSE_RANGE_CLOEXEC,
            ) < 0
            {
                return Err(io::Error::last_os_error());
            }
            if let Some((read_fd, write_fd)) = inherit {
                for fd in [read_fd, write_fd] {
                    if fd <= 2 || libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
            }
            Ok(())
        });
    }
}

#[cfg(test)]
#[path = "fixture_launch.tests.rs"]
mod tests;
