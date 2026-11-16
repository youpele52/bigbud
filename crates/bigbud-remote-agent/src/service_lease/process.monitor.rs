//! Linux-only isolated subreaper. Owner EOF cancels; backend detach does not.
use super::{Error, Result, wire};
use crate::process::owned_group_monitor as group;
use crate::service_lease::guard::Worker;
use std::io::{Read, Write};
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::{net::UnixStream, process::CommandExt},
};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) fn run() -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(Error::Unsupported);
    }
    group::prepare().map_err(|_| Error::Uncertain)?;
    // SAFETY: the owning Rust process supplies the unique private socket at fd3.
    let mut owner = unsafe { UnixStream::from_raw_fd(3) };
    owner.peer_addr()?;
    owner.set_read_timeout(Some(Duration::from_secs(3)))?;
    owner.set_write_timeout(Some(Duration::from_secs(3)))?;
    let (launch, digest) = wire::read(&mut owner)?;
    let executable = launch.validate(&digest)?;
    let configuration = launch.fingerprint(&digest)?;
    let mut validity = launch
        .guard
        .clone()
        .map(|guard| {
            Worker::start(
                guard.bind_configuration(configuration),
                launch.assets.clone(),
            )
        })
        .transpose()?;
    if let Some(worker) = validity.as_mut() {
        owner.set_nonblocking(true)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !worker.fresh() {
            if worker.invalid() || Instant::now() >= deadline {
                worker.finish()?;
                return Ok(());
            }
            let mut control = [0];
            match owner.read(&mut control) {
                Ok(0) => {
                    worker.finish()?;
                    return Ok(());
                }
                Ok(_) if control[0] == b'!' => {
                    worker.finish()?;
                    return Ok(());
                }
                Ok(_) => return Err(Error::Invalid),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(error) => return Err(error.into()),
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        owner.set_nonblocking(false)?;
    }
    let fd = executable.as_raw_fd();
    // Execute the verified open inode, never re-resolve the caller's filename.
    let mut command = Command::new(format!("/proc/self/fd/{fd}"));
    command
        .env_clear()
        .args(&launch.args)
        .envs(launch.environment.0.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    // SAFETY: async-signal-safe fd operations before exec; fd3 must never reach a descendant.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(3);
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let mut lifeline = child.stdin.take();
    let mut cleanup_attempted = false;
    let result = (|| {
        let mut ready = [b'R', 0, 0, 0, 0];
        ready[1..].copy_from_slice(&child.id().to_be_bytes());
        owner.write_all(&ready)?;
        owner.set_nonblocking(true)?;
        let mut stopped = false;
        let mut refresh = None;
        loop {
            if !stopped
                && (group::exited(child.id() as i32).map_err(|_| Error::Uncertain)?
                    || validity.as_mut().is_some_and(|worker| !worker.fresh()))
            {
                lifeline.take();
                cleanup_attempted = true;
                group::cleanup(&mut child).map_err(|_| Error::Uncertain)?;
                stopped = true;
                if let Some(worker) = validity.as_mut() {
                    worker.finish()?;
                }
            }
            if refresh.is_some_and(|target| {
                stopped
                    || validity
                        .as_mut()
                        .is_none_or(|worker| worker.refreshed(target))
            }) {
                owner.write_all(if stopped { b"S" } else { b"V" })?;
                refresh = None;
            }
            let mut request = [0];
            match owner.read(&mut request) {
                Ok(0) => break,
                Ok(_) if request[0] == b'!' => break,
                Ok(_) if request[0] == b'V' && refresh.is_none() => {
                    if stopped {
                        owner.write_all(b"S")?;
                    } else {
                        refresh = Some(match validity.as_mut() {
                            Some(worker) => worker.request_refresh()?,
                            None => 0,
                        });
                    }
                }
                Ok(_) if request[0] == b'?' => {
                    owner.write_all(if stopped { b"S" } else { b"R" })?
                }
                Ok(_) => return Err(Error::Invalid),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(error) => return Err(error.into()),
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if !stopped {
            lifeline.take();
            cleanup_attempted = true;
            group::cleanup(&mut child).map_err(|_| Error::Uncertain)?;
        }
        if let Some(worker) = validity.as_mut() {
            worker.finish()?;
        }
        Ok(())
    })();
    if result.is_err() && !cleanup_attempted {
        lifeline.take();
        // An uncertain cleanup is returned, never converted to a successful exit receipt.
        group::cleanup(&mut child).map_err(|_| Error::Uncertain)?;
    }
    if let Some(worker) = validity.as_mut() {
        worker.finish()?;
    }
    result
}
