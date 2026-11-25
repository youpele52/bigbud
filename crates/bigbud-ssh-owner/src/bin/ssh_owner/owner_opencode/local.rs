use super::POLL;
use crate::transport::PinnedSsh;
use std::{
    fs,
    io::{self, Read, Write},
    net::SocketAddrV4,
    os::{
        fd::{AsFd, AsRawFd},
        unix::{ffi::OsStrExt, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant},
};

const KILL_GRACE: Duration = Duration::from_millis(250);
const DIR_TEMPLATE: &[u8] = b"/tmp/bigbud-oc1-XXXXXXXXXXXXXXXX\0";

pub(crate) struct ForwardSocket {
    directory: PathBuf,
    socket: PathBuf,
    closed: bool,
}

impl ForwardSocket {
    pub(crate) fn new() -> io::Result<Self> {
        // Never consult TMPDIR or a wire operand. mkdtemp creates the unpredictable
        // socket parent atomically with mode 0700 before it can be substituted.
        let mut template = DIR_TEMPLATE.to_vec();
        // SAFETY: writable NUL-terminated template, exclusively borrowed here.
        if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
            return Err(io::Error::last_os_error());
        }
        let directory = PathBuf::from(std::ffi::OsStr::from_bytes(
            std::ffi::CStr::from_bytes_with_nul(&template)
                .map_err(io::Error::other)?
                .to_bytes(),
        ));
        let socket = directory.join("s");
        Ok(Self {
            directory,
            socket,
            closed: false,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.socket
    }

    pub(crate) fn close(mut self) -> io::Result<()> {
        self.remove()?;
        self.closed = true;
        Ok(())
    }

    fn remove(&self) -> io::Result<()> {
        match fs::remove_file(&self.socket) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        fs::remove_dir(&self.directory)
    }
}

impl Drop for ForwardSocket {
    fn drop(&mut self) {
        if !self.closed {
            // Best effort on unwind. Explicit close is checked on normal paths.
            let _cleanup_on_drop = self.remove();
        }
    }
}

struct Running {
    child: Child,
    _pin: PinnedSsh,
}

pub(crate) struct SshChild {
    running: Option<Running>,
    deferred: SyncSender<Running>,
    reaped: bool,
}

impl SshChild {
    /// `remote` is the owner-selected loopback endpoint; `socket` is the
    /// owner-generated local path. Neither comes from a request or child output.
    pub(crate) fn spawn(
        mut pinned: PinnedSsh,
        host: &str,
        command: &str,
        socket: &Path,
        remote: SocketAddrV4,
        worker: &str,
    ) -> io::Result<Self> {
        // Only the fixed transport constructor can enable forwarding; this
        // module adds the sole -L from the owner-generated path and endpoint.
        let forward = format!("{}:{remote}", socket.display());
        let (deferred, recv) = mpsc::sync_channel::<Running>(1);
        thread::Builder::new()
            .name(worker.to_owned())
            .spawn(move || {
                if let Ok(mut running) = recv.recv() {
                    let _reaped_or_no_child = running.child.wait();
                }
            })?;
        let child = pinned
            .command
            .args(["-L", &forward, "--", host, command])
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()?;
        Ok(Self {
            running: Some(Running {
                child,
                _pin: pinned,
            }),
            deferred,
            reaped: false,
        })
    }

    pub(crate) fn setup(&mut self) -> io::Result<()> {
        let child = self.child()?;
        nonblocking(child.stdin.as_ref().ok_or_else(no_pipe)?)?;
        nonblocking(child.stdout.as_ref().ok_or_else(no_pipe)?)?;
        nonblocking(child.stderr.as_ref().ok_or_else(no_pipe)?)
    }

    pub(crate) fn send(&mut self, byte: u8) -> io::Result<bool> {
        let stdin = self.child()?.stdin.as_mut().ok_or_else(no_pipe)?;
        match stdin.write(&[byte]) {
            Ok(1) => Ok(true),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "SSH control write failed",
            )),
            Err(e) if would_block(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Writes as much of `pending` as the nonblocking pipe accepts and removes
    /// the written prefix. `true` means the entire payload was written.
    pub(crate) fn send_all(&mut self, pending: &mut Vec<u8>) -> io::Result<bool> {
        if pending.is_empty() {
            return Ok(true);
        }
        let stdin = self.child()?.stdin.as_mut().ok_or_else(no_pipe)?;
        match stdin.write(pending) {
            Ok(0) => Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "SSH control write failed",
            )),
            Ok(written) if written <= pending.len() => {
                pending.drain(..written);
                Ok(pending.is_empty())
            }
            Ok(_) => Err(io::Error::other("SSH control write overran its payload")),
            Err(e) if would_block(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub(crate) fn close_input(&mut self) {
        if let Some(running) = &mut self.running {
            drop(running.child.stdin.take());
        }
    }

    pub(crate) fn read(&mut self, stdout: bool, buffer: &mut [u8]) -> io::Result<usize> {
        let child = self.child()?;
        let pipe: &mut dyn Read = if stdout {
            child.stdout.as_mut().ok_or_else(no_pipe)?
        } else {
            child.stderr.as_mut().ok_or_else(no_pipe)?
        };
        match pipe.read(buffer) {
            Err(e) if would_block(&e) => Ok(0),
            result => result,
        }
    }

    pub(crate) fn reaped(&mut self) -> io::Result<bool> {
        if !self.reaped {
            self.reaped = self.child()?.try_wait()?.is_some();
        }
        Ok(self.reaped)
    }

    pub(crate) fn kill_and_reap(&mut self) -> bool {
        self.close_input();
        let status = self.reaped();
        if matches!(status, Ok(true)) {
            return true;
        }
        if matches!(status, Ok(false))
            && let Ok(child) = self.child()
        {
            let pid = i32::try_from(child.id()).ok().filter(|&pid| pid > 0);
            // SAFETY: process_group(0) created this group and its owned leader
            // remains unreaped; no other local worker is waiting for this child.
            if !pid.is_some_and(|pid| unsafe { libc::kill(-pid, libc::SIGKILL) == 0 }) {
                let _kill_requested = child.kill();
            }
        }
        let deadline = Instant::now() + KILL_GRACE;
        while Instant::now() < deadline {
            match self.reaped() {
                Ok(true) => return true,
                Ok(false) => thread::sleep(POLL),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if let Some(running) = self.running.take() {
            // Transfer the unreaped child and its exact pin; this is explicitly
            // not confirmed teardown and must not authorize another startup.
            let _deferred = self.deferred.send(running);
        }
        false
    }

    fn child(&mut self) -> io::Result<&mut Child> {
        self.running
            .as_mut()
            .map(|running| &mut running.child)
            .ok_or_else(no_pipe)
    }
}

impl Drop for SshChild {
    fn drop(&mut self) {
        if self.running.is_some() && !self.reaped {
            let _cleanup_on_drop = self.kill_and_reap();
        }
    }
}

fn would_block(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

fn no_pipe() -> io::Error {
    io::Error::other("SSH control pipe unavailable")
}

fn nonblocking(pipe: &impl AsFd) -> io::Result<()> {
    let fd = pipe.as_fd().as_raw_fd();
    // SAFETY: this operation inspects an owned initialized pipe descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    // SAFETY: descriptor is exclusively used by this worker; preserve its flags.
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
