//! Read-only process identity and root checks for the retirement journal.
//!
//! A PID is not an identity. Linux combines start time with the PID-namespace
//! inode; macOS has no PID namespaces, so a Linux record is unverifiable there.
//! Nothing in this module signals a process unless automatic retirement is
//! explicitly enabled by the reviewed startup switch.

use super::{DENIED, Identity, RETIRE_WAIT, Record};
use crate::v1::ErrorCode;
use std::{
    fs::{self, File},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Observed {
    Exact,
    Gone,
    Mismatch,
}

pub(super) fn observe(record: &Record) -> Result<Observed, ErrorCode> {
    // A PID without a start time, or a Linux record without a namespace, is
    // not an identity. Refuse it rather than fall back to PID-only ownership.
    if record.pid == 0 || record.start == 0 {
        return Err(DENIED);
    }
    let current = namespace();
    if record.namespace.is_none() && current.is_some() {
        return Err(DENIED);
    }
    if record.namespace.is_some() && record.namespace != current {
        return Ok(Observed::Mismatch);
    }
    let Some(found) = read_identity(record.pid) else {
        return Ok(Observed::Gone);
    };
    if found.start == record.start && found.namespace == record.namespace {
        Ok(Observed::Exact)
    } else {
        // A different start time is PID reuse, not evidence the original exited.
        Ok(Observed::Mismatch)
    }
}

pub(super) fn retire_exact(record: &Record) -> Result<(), ErrorCode> {
    if observe(record)? != Observed::Exact {
        return Err(DENIED);
    }
    signal_exact(record)?;
    let deadline = Instant::now() + RETIRE_WAIT;
    while Instant::now() < deadline {
        if read_identity(record.pid).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(DENIED)
}

#[cfg(target_os = "linux")]
fn signal_exact(record: &Record) -> Result<(), ErrorCode> {
    if record.pid == 0 || record.pid > i32::MAX as u32 {
        return Err(DENIED);
    }
    // SAFETY: pidfd_open takes a bounded positive PID and flags 0. The returned
    // descriptor is closed below and refers to the process instance, not a PID
    // that could be reused between the check and the signal.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, record.pid as libc::c_long, 0) };
    if fd < 0 {
        return Err(DENIED);
    }
    let fd = fd as libc::c_int;
    let result = (|| {
        // The PID might have been reused between the first observation and the
        // pidfd open; re-verify before signalling through the pinned instance.
        if observe(record)? != Observed::Exact {
            return Err(DENIED);
        }
        // SAFETY: the pidfd is live and was opened for this exact instance; a
        // null siginfo and zero flags are the documented simple-signal form.
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd as libc::c_long,
                libc::SIGTERM,
                0 as libc::c_long,
                0 as libc::c_long,
            )
        } != 0
        {
            return Err(DENIED);
        }
        Ok(())
    })();
    // SAFETY: fd was returned by pidfd_open and is not used afterwards.
    unsafe { libc::close(fd) };
    result
}

#[cfg(target_os = "macos")]
fn signal_exact(record: &Record) -> Result<(), ErrorCode> {
    if record.pid == 0 || record.pid > i32::MAX as u32 {
        return Err(DENIED);
    }
    // macOS has no pidfd equivalent. The identity is re-read immediately before
    // kill; a reuse between these two calls remains a bounded review risk, and
    // the switch stays off until the disposable profile evidence passes.
    if observe(record)? != Observed::Exact {
        return Err(DENIED);
    }
    // SAFETY: a strictly positive PID was re-verified immediately above. This
    // signals only that exact instance, never a process group or a PID lookup.
    if unsafe { libc::kill(record.pid as i32, libc::SIGTERM) } != 0 {
        return Err(DENIED);
    }
    Ok(())
}

pub(super) fn private_root(lock: &Path) -> Result<PathBuf, ErrorCode> {
    let root = lock.parent().ok_or(DENIED)?;
    let meta = fs::symlink_metadata(root).map_err(|_| DENIED)?;
    if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o7777 != 0o700 {
        return Err(DENIED);
    }
    Ok(root.to_owned())
}

pub(super) fn sync_dir(path: &Path) -> Result<(), ErrorCode> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| DENIED)
}

pub(super) fn uid() -> u32 {
    // SAFETY: geteuid takes no arguments and observes this process only.
    unsafe { libc::geteuid() }
}

#[cfg(target_os = "linux")]
pub(super) fn namespace() -> Option<u64> {
    let meta = fs::metadata("/proc/self/ns/pid").ok()?;
    Some(pack(meta.dev(), meta.ino()))
}

#[cfg(target_os = "macos")]
pub(super) fn namespace() -> Option<u64> {
    // macOS has no PID namespaces. A Linux record is therefore unverifiable.
    None
}

#[cfg(target_os = "linux")]
pub(super) fn read_identity(pid: u32) -> Option<Identity> {
    let raw = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The comm field can contain spaces and parentheses; fields start after
    // the last ')'. starttime is field 22, i.e. index 19 after that.
    let rest = raw.rsplit_once(')')?.1;
    let start = rest.split_whitespace().nth(19)?.parse().ok()?;
    Some(Identity {
        pid,
        start,
        namespace: namespace(),
    })
}

#[cfg(target_os = "macos")]
pub(super) fn read_identity(pid: u32) -> Option<Identity> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    // SAFETY: `info` is a writable, correctly sized output buffer; pid is
    // bounded. proc_pidinfo only observes process metadata.
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int {
        return None;
    }
    // SAFETY: proc_pidinfo filled the buffer after reporting its full size.
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid {
        return None;
    }
    Some(Identity {
        pid,
        start: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
        namespace: None,
    })
}

#[cfg(target_os = "linux")]
fn pack(dev: u64, ino: u64) -> u64 {
    // Both values fit in their halves on supported hosts; a collision would
    // still require an exact start-time match.
    (dev << 32) ^ ino
}
