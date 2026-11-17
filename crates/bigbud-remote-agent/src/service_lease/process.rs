//! Original monitor-child ownership; no renderer command or persistent secret.
use super::{Error, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::{
    fd::{AsRawFd, FromRawFd, OwnedFd},
    unix::{fs::MetadataExt, net::UnixStream, process::CommandExt},
};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[path = "process.monitor.rs"]
mod monitor;
#[path = "process.readiness.rs"]
pub(super) mod readiness;
#[path = "process.wire.rs"]
mod wire;
pub(super) fn run_monitor() -> Result<()> {
    monitor::run()
}

/// Never Debug/serialized into a journal/status. Transport bootstrap is private.
#[derive(Clone)]
pub struct SecretEnvironment(pub Vec<(String, String)>);
pub struct Launch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub environment: SecretEnvironment,
    pub guard: Option<super::Guard>,
    pub assets: Option<super::AssetsResource>,
}
impl Launch {
    pub(crate) fn validate_gateway_readiness(&self) -> Result<()> {
        readiness::expected(&self.args)?.ok_or(Error::Invalid)?;
        Ok(())
    }

    pub(super) fn fingerprint(&self, digest: &[u8; 32]) -> Result<[u8; 32]> {
        Ok(Sha256::digest(wire::encode(self, digest)?).into())
    }
    pub(super) fn validate(&self, expected: &[u8; 32]) -> Result<std::fs::File> {
        if !self.executable.is_absolute()
            || self.args.len() > 128
            || self.args.iter().any(|s| s.contains('\0'))
            || self.environment.0.len() > 64
            || self.environment.0.iter().any(|(name, value)| {
                name.is_empty() || name.contains(['=', '\0']) || value.contains('\0')
            })
        {
            return Err(Error::Invalid);
        }
        let metadata = std::fs::symlink_metadata(&self.executable)?;
        // SAFETY: geteuid only reads the actual operating-system account identity.
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o7777 != 0o700
            || metadata.nlink() != 1
            || std::fs::canonicalize(&self.executable)? != self.executable
            || metadata.len() > 256 * 1024 * 1024
        {
            return Err(Error::Invalid);
        }
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.executable)?;
        let opened = file.metadata()?;
        if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
            return Err(Error::Invalid);
        }
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = [0; 65536];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > metadata.len() {
                return Err(Error::Invalid);
            }
            hasher.update(buffer.get(..count).ok_or(Error::Invalid)?);
        }
        let after = std::fs::symlink_metadata(&self.executable)?;
        if total != metadata.len()
            || metadata.dev() != after.dev()
            || metadata.ino() != after.ino()
            || metadata.ctime() != after.ctime()
            || metadata.ctime_nsec() != after.ctime_nsec()
            || metadata.len() != after.len()
            || <[u8; 32]>::from(hasher.finalize()) != *expected
        {
            return Err(Error::Invalid);
        }
        Ok(file)
    }
}

pub(super) struct Monitor {
    child: Child,
    socket: UnixStream,
    pub child_pid: u32,
    /// Original-child listener proof and kernel start ticks, for readiness launches only.
    pub original: wire::Original,
    pub stopped: bool,
}
impl Monitor {
    pub(super) fn start(
        executable: &Path,
        launch: Launch,
        expected: [u8; 32],
    ) -> Result<(Self, Result<()>)> {
        if !cfg!(target_os = "linux") {
            return Err(Error::Unsupported);
        }
        launch.validate(&expected)?;
        let gateway = readiness::expected(&launch.args)?.is_some();
        let frame = wire::encode(&launch, &expected)?;
        let (owner, peer) = UnixStream::pair()?;
        owner.set_read_timeout(Some(Duration::from_secs(12)))?;
        owner.set_write_timeout(Some(Duration::from_secs(3)))?;
        // Use fd >=4 so dup2 cannot clobber the original socket accidentally.
        // SAFETY: valid borrowed socket and a fresh owned descriptor on success.
        let fd = unsafe { libc::fcntl(peer.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: successful fcntl returned a unique descriptor.
        let descriptor = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut command = Command::new(executable);
        command
            .env_clear()
            .arg("--service-lease-monitor")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: only async-signal-safe syscalls before exec in the child.
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0
                    || libc::dup2(fd, 3) < 0
                    || libc::fcntl(3, libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop((descriptor, peer));
        let mut result = Self {
            child,
            socket: owner,
            child_pid: 0,
            original: None,
            stopped: false,
        };
        let readiness = (|| {
            result
                .socket
                .write_all(&(frame.len() as u32).to_be_bytes())?;
            result.socket.write_all(&frame)?;
            let mut reply = [0; wire::READY_FRAME];
            result.socket.read_exact(&mut reply)?;
            (result.child_pid, result.original) = wire::parse_ready(&reply, gateway)?;
            Ok(())
        })();
        let reset = result
            .socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(Error::from);
        Ok((result, readiness.and(reset)))
    }
    pub(super) fn observe(&mut self) -> Result<()> {
        self.socket.write_all(b"?")?;
        let mut reply = [0];
        self.socket.read_exact(&mut reply)?;
        match reply[0] {
            b'R' => Ok(()),
            b'S' => {
                self.stopped = true;
                Ok(())
            }
            _ => Err(Error::Uncertain),
        }
    }
    pub(super) fn refresh_validity(&mut self) -> Result<bool> {
        self.socket.write_all(b"V")?;
        let mut reply = [0];
        self.socket.read_exact(&mut reply)?;
        match reply[0] {
            b'V' => Ok(true),
            b'S' => {
                self.stopped = true;
                Ok(false)
            }
            _ => Err(Error::Uncertain),
        }
    }
    pub(super) fn stop(&mut self) -> Result<()> {
        let _cancel = self.socket.write_all(b"!");
        let _close = self.socket.shutdown(std::net::Shutdown::Write);
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait()? {
                if status.success() {
                    self.stopped = true;
                    return Ok(());
                }
                return Err(Error::Uncertain);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Err(Error::Uncertain)
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        // EOF cancels the monitor, whose separate process retains the gateway's
        // original group until settlement. Never signal a PID obtained elsewhere.
        let _settled = self.stop();
        let _closed = self.socket.shutdown(std::net::Shutdown::Both);
    }
}
