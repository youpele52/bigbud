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

/// The service manager stops a unit by signalling its whole control group, this monitor
/// included. Only the owner channel (EOF or `!`) may end the monitor: it must outlive that
/// signal to reap the original group and report the exit the supervisor drain settles on.
const OWNER_ONLY_SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

fn set_termination_disposition(handler: libc::sighandler_t) -> std::io::Result<()> {
    for signal in OWNER_ONLY_SIGNALS {
        // SAFETY: signal(2) only replaces this process's disposition; it is async-signal-safe,
        // so the pre-exec child may call it too.
        if unsafe { libc::signal(signal, handler) } == libc::SIG_ERR {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

pub(super) fn run() -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(Error::Unsupported);
    }
    set_termination_disposition(libc::SIG_IGN)?;
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
    let readiness = super::readiness::expected(&launch.args)?;
    // Execute the verified open inode, never re-resolve the caller's filename.
    let mut command = Command::new(format!("/proc/self/fd/{fd}"));
    command
        .env_clear()
        .args(&launch.args)
        .envs(launch.environment.0.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(if readiness.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::null())
        .process_group(0);
    // SAFETY: async-signal-safe fd and signal-disposition operations before exec; fd3 must
    // never reach a descendant.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(3);
            // An ignored disposition survives exec: the original child keeps the defaults.
            set_termination_disposition(libc::SIG_DFL)
        });
    }
    let mut child = command.spawn()?;
    let mut lifeline = child.stdin.take();
    let mut cleanup_attempted = false;
    let result = (|| {
        let proof = match readiness {
            Some(expected) => {
                let child_pid = child.id();
                let stdout = child.stdout.as_mut().ok_or(Error::Uncertain)?;
                let proof = super::readiness::await_child(child_pid, stdout, expected)?;
                // The unreaped original child cannot be replaced by PID reuse here.
                let started = crate::service_lease::Controller::read(child_pid)?
                    .started
                    .parse::<u64>()
                    .map_err(|_| Error::Uncertain)?;
                Some((proof, started))
            }
            None => None,
        };
        owner.write_all(&wire::ready(child.id(), proof))?;
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
