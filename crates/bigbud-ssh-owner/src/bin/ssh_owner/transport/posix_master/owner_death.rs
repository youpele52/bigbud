//! Local owner-death watchdog for a control master (`ssh -N -o ControlMaster=yes`).
//!
//! Same principle as the provider lease's `local_guard`: the owner keeps the
//! only write end of a close-on-exec pipe, and a small `/bin/sh` watcher,
//! leading its own process group, blocks reading the other end as fd 3. When
//! the owner exits for any reason, including SIGKILL, the kernel closes the
//! write end, the read sees EOF and the watcher kills the master, so no master
//! outlives its owner. The remote sessions end with the master's connection.
//!
//! Unlike the lease guard, the master is not wrapped: it stays the owner's own
//! direct child, because its PID is what the askpass helper's parent check and
//! the retirement record bind to. The watcher therefore signals a PID, which
//! is safe only while that PID cannot be reused: the master is the owner's
//! unreaped child for as long as the write end is open, and `disarm` stops
//! the watcher (without signalling) before the write end closes after a reap.

use std::{
    io,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    process::{Child, Command, Stdio},
};

const WATCH: &str = r#"read -r _ <&3; kill -s KILL "$1" 2>/dev/null"#;

/// An armed watchdog. Dropping it without `disarm` closes the write end, so
/// the watcher kills the master (still an unreaped child of this owner).
pub(super) struct Watch {
    watcher: Child,
    owner_alive: Option<OwnedFd>,
}

/// Arms the watchdog for the master child `pid`.
pub(super) fn arm(pid: u32) -> io::Result<Watch> {
    let (reader, writer) = io::pipe()?;
    let reader = OwnedFd::from(reader);
    let fd = reader.as_raw_fd();
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(WATCH)
        .arg("bigbud-master-guard")
        .arg(pid.to_string())
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    // SAFETY: only async-signal-safe calls (dup2, fcntl) on a descriptor this
    // closure owns a copy of; nothing allocates between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if fd == 3 {
                let flags = libc::fcntl(3, libc::F_GETFD);
                if flags == -1 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1 {
                    return Err(io::Error::last_os_error());
                }
            } else if libc::dup2(fd, 3) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let watcher = command.spawn()?;
    drop(reader);
    Ok(Watch {
        watcher,
        owner_alive: Some(OwnedFd::from(writer)),
    })
}

impl Watch {
    /// After the master has been reaped: stop the watcher first, then close
    /// the write end, so a reused PID is never signalled.
    pub(super) fn disarm(mut self) {
        let _ = self.watcher.kill();
        let _ = self.watcher.wait();
        self.owner_alive = None;
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        // Not disarmed: the master may still run. Closing the write end lets
        // the watcher kill it; then collect the watcher.
        if self.owner_alive.take().is_some() {
            let _ = self.watcher.wait();
        }
    }
}

#[cfg(test)]
#[path = "owner_death.tests.rs"]
mod tests;
