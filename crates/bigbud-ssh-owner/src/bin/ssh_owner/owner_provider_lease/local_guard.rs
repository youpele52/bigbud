//! Local owner-death guard for a provider lease's SSH client.
//!
//! The SSH client runs under a small `/bin/sh` that leads its own process
//! group. The owner keeps the only write end of a pipe (close-on-exec, never
//! inherited elsewhere); the shell's watcher blocks reading the other end as
//! fd 3. When the owner exits for any reason, including SIGKILL, the kernel
//! closes the write end, the read sees EOF and the watcher kills the whole
//! group, so no SSH client outlives its owner. The remote side then loses its
//! session and the shared remote session guard reaps the provider. This works
//! the same on macOS and Linux (no `PR_SET_PDEATHSIG`, which would also fire
//! when the spawning thread exits).

use std::{
    io,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{fs::PermissionsExt, process::CommandExt},
    },
    process::Command,
};

/// The client keeps the caller's stdio; fd 3 is closed for it. The watcher's
/// `kill 0` targets this shell's own process group. Stdin is saved on fd 4
/// first: dash (Debian `/bin/sh`) points an async list's fd 0 at `/dev/null`
/// before `<&0` is applied, so `<&0` alone would starve the client.
const WATCH: &str = r#"
exec 4<&0
"$@" <&4 3<&- 4<&- &
client=$!
( read -r _ <&3; kill -s KILL 0 ) </dev/null >/dev/null 2>&1 &
watch=$!
exec 3<&- 4<&-
wait "$client"
code=$?
kill -s KILL "$watch" 2>/dev/null
exit "$code"
"#;

/// A guarded command. Drop `reader` right after spawning; hold `owner_alive`
/// until the child has been reaped.
pub(super) struct Guarded {
    pub(super) command: Command,
    pub(super) reader: OwnedFd,
    pub(super) owner_alive: OwnedFd,
}

/// Wraps an already-built command under the owner-death watcher.
pub(super) fn wrap(inner: &Command) -> io::Result<Guarded> {
    // A client that cannot start must stay a spawn refusal, not a shell exit
    // 127 that would read as a provider exit.
    let program = std::path::Path::new(inner.get_program());
    let executable = program.is_absolute()
        && std::fs::metadata(program)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0);
    if !executable {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "SSH client is not an executable absolute path",
        ));
    }
    let (reader, writer) = io::pipe()?;
    let reader = OwnedFd::from(reader);
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(WATCH)
        .arg("bigbud-provider-guard")
        .arg(inner.get_program())
        .args(inner.get_args())
        .env_clear()
        .env("LC_ALL", "C")
        .process_group(0);
    for (key, value) in inner.get_envs() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    let fd = reader.as_raw_fd();
    // SAFETY: only async-signal-safe calls (dup2, fcntl) on descriptors this
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
    Ok(Guarded {
        command,
        reader,
        owner_alive: OwnedFd::from(writer),
    })
}

#[cfg(test)]
#[path = "local_guard.tests.rs"]
mod tests;
