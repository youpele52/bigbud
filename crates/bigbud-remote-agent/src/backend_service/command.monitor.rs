//! Private same-artifact worker. Owns the direct leader until cancellation is settled.
use super::{Result, ServiceError};
#[cfg(test)]
use crate::process::owned_group_monitor::cleanup_observing;
use crate::process::owned_group_monitor::{self as group, cleanup};
use std::io::{Read, Write};
use std::os::{
    fd::FromRawFd,
    unix::{net::UnixStream, process::CommandExt},
};
#[cfg(all(test, target_os = "macos"))]
use std::process::Child;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn authorization(owner: &mut UnixStream) -> Result<()> {
    owner.write_all(b"armed\n")?;
    owner.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut permit = [0; 4];
    owner.read_exact(&mut permit)?;
    if permit != *b"run\n" {
        return Err(ServiceError::Manager);
    }
    owner.set_nonblocking(true)?;
    Ok(())
}

fn cancelled(owner: &mut UnixStream) -> Result<bool> {
    let mut byte = [0];
    match owner.read(&mut byte) {
        Ok(0) => Ok(true),
        Ok(_) => Err(ServiceError::Manager),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn run(mut arguments: impl Iterator<Item = std::ffi::OsString>) -> Result<()> {
    group::prepare()?;
    let timeout = arguments
        .next()
        .ok_or(ServiceError::Manager)?
        .to_str()
        .ok_or(ServiceError::Manager)?
        .parse::<u64>()
        .map_err(|_| ServiceError::Manager)?;
    if timeout == 0 || timeout > 120000 {
        return Err(ServiceError::Manager);
    }
    let program = arguments.next().ok_or(ServiceError::Manager)?;
    let mut bounded_arguments = Vec::new();
    let mut bytes = program.len();
    if bytes > 65536 {
        return Err(ServiceError::Manager);
    }
    for argument in arguments {
        bytes = bytes
            .checked_add(argument.len())
            .ok_or(ServiceError::Manager)?;
        if bounded_arguments.len() >= 128 || bytes > 65536 {
            return Err(ServiceError::Manager);
        }
        bounded_arguments.push(argument);
    }
    // SAFETY: the private parent supplies its unique owner socket as fd3 before exec.
    // Reject non-sockets before creating any command process.
    let mut owner = unsafe { UnixStream::from_raw_fd(3) };
    owner.peer_addr()?;
    authorization(&mut owner)?;
    let mut command = Command::new(program);
    command
        .args(bounded_arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::null())
        .process_group(0);
    // SAFETY: close is async-signal-safe; children must never retain the owner socket.
    unsafe {
        command.pre_exec(|| {
            libc::close(3);
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    // SAFETY: worker output belongs only to the command now. Closing our inherited fd ensures
    // the parent sees EOF once command descendants have all closed their output descriptors.
    unsafe {
        libc::close(1);
    }
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let observation: Result<bool> = (|| {
        loop {
            if group::exited(child.id() as i32)? {
                return Ok(true);
            }
            if cancelled(&mut owner)? || Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    })();
    // Read the exit code without consuming the PID lease. The command may have exited while
    // background descendants are still running; cleanup must precede reporting success.
    let natural = matches!(observation, Ok(true));
    let code = if natural {
        exit_code(child.id() as i32)
    } else {
        Ok(255)
    };
    let settled = cleanup(&mut child);
    settled?;
    observation?;
    let code = code?;
    if natural {
        owner.write_all(format!("{code}\n").as_bytes())?;
    }
    Ok(())
}

fn exit_code(pid: i32) -> Result<u8> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: exact unreaped direct child, preserving its identity until cleanup completes.
    if unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful waitid initialized this child-status structure.
    let info = unsafe { info.assume_init() };
    #[cfg(target_os = "linux")]
    // SAFETY: waitid returned child-status siginfo.
    let status = unsafe { info.si_status() };
    #[cfg(not(target_os = "linux"))]
    let status = info.si_status;
    if info.si_code == libc::CLD_EXITED {
        u8::try_from(status).map_err(|_| ServiceError::Manager)
    } else {
        Ok(255)
    }
}

#[cfg(test)]
#[path = "command.monitor.tests.rs"]
mod tests;
