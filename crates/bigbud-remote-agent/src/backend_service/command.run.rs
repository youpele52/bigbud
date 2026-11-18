use super::{Result, ServiceError};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn nonblocking(fd: i32) -> Result<()> {
    // SAFETY: live borrowed descriptor; fcntl does not dereference pointers.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: same live descriptor, preserving its existing flags.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

struct Monitor {
    child: Child,
    owner: Option<UnixStream>,
}
impl Monitor {
    fn finish(&mut self) -> Result<()> {
        drop(self.owner.take()); // Active monitor sees EOF even if the backend is SIGKILLed.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = self.child.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(ServiceError::Manager)
                };
            }
            if Instant::now() >= deadline {
                return Err(ServiceError::Manager);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        // Never kill the external monitor before it finishes its owned-group cleanup.
        drop(self.owner.take());
    }
}

pub(super) fn run(command: Command, timeout: Duration, maximum: usize) -> Result<(String, u8)> {
    #[cfg(target_os = "linux")]
    let executable = std::path::PathBuf::from("/proc/self/exe");
    #[cfg(not(target_os = "linux"))]
    let executable = std::env::current_exe()?;
    run_with_executable(command, timeout, maximum, &executable)
}

pub(crate) fn run_with_executable(
    command: Command,
    timeout: Duration,
    maximum: usize,
    executable: &std::path::Path,
) -> Result<(String, u8)> {
    let milliseconds = u64::try_from(timeout.as_millis()).map_err(|_| ServiceError::Manager)?;
    if milliseconds == 0 || milliseconds > 120000 {
        return Err(ServiceError::Manager);
    }
    let (owner, child_owner) = UnixStream::pair()?;
    // SAFETY: live source; duplicate above fixed fd3 to avoid mapping/source collisions.
    let descriptor = unsafe { libc::fcntl(child_owner.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful duplication returned a new unique descriptor.
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let child_fd = descriptor.as_raw_fd();
    let mut wrapper = Command::new(executable);
    wrapper
        .env_clear()
        .arg("--backend-service-command-monitor")
        .arg(milliseconds.to_string())
        .arg(command.get_program())
        .args(command.get_args());
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            wrapper.env(key, value);
        }
    }
    wrapper
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: only async-signal-safe syscalls; exec follows immediately. The independent
    // monitor is outside its command's later process group and owns only inherited fd3.
    unsafe {
        wrapper.pre_exec(move || {
            if libc::setsid() < 0
                || libc::dup2(child_fd, 3) < 0
                || libc::fcntl(3, libc::F_SETFD, 0) < 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = wrapper.spawn()?;
    drop((child_owner, descriptor));
    let mut monitor = Monitor {
        child,
        owner: Some(owner),
    };
    let result = collect(&mut monitor, timeout, maximum);
    let cleanup = monitor.finish();
    cleanup?;
    result
}

fn collect(monitor: &mut Monitor, timeout: Duration, maximum: usize) -> Result<(String, u8)> {
    let mut stdout = monitor.child.stdout.take().ok_or(ServiceError::Manager)?;
    let owner = monitor.owner.as_mut().ok_or(ServiceError::Manager)?;
    nonblocking(stdout.as_raw_fd())?;
    owner.set_nonblocking(true)?;
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut report = Vec::new();
    let mut armed = false;
    let mut output_ended = false;
    let mut owner_ended = false;
    let mut buffer = [0_u8; 4096];
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => output_ended = true,
            Ok(count) => {
                output.extend_from_slice(buffer.get(..count).ok_or(ServiceError::Manager)?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
            Err(error) => return Err(error.into()),
        }
        match owner.read(&mut buffer) {
            Ok(0) => owner_ended = true,
            Ok(count) => {
                report.extend_from_slice(buffer.get(..count).ok_or(ServiceError::Manager)?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
            Err(error) => return Err(error.into()),
        }
        if !armed && report.starts_with(b"armed\n") {
            owner.write_all(b"run\n")?;
            drop(report.drain(..6));
            armed = true;
        }
        if output.len() > maximum
            || report.len() > if armed { 4 } else { 6 }
            || (!armed && !b"armed\n".starts_with(&report))
            || Instant::now() >= deadline
        {
            return Err(ServiceError::Manager);
        }
        if armed && output_ended && report.ends_with(b"\n") {
            let status = std::str::from_utf8(&report)
                .map_err(|_| ServiceError::Manager)?
                .strip_suffix('\n')
                .ok_or(ServiceError::Manager)?;
            if status.is_empty() || !status.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(ServiceError::Manager);
            }
            return Ok((
                String::from_utf8(output).map_err(|_| ServiceError::Manager)?,
                status.parse::<u8>().map_err(|_| ServiceError::Manager)?,
            ));
        }
        if owner_ended {
            return Err(ServiceError::Manager);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
