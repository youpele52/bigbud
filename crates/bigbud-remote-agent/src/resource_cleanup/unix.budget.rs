use std::ffi::CStr;
use std::io;
use std::os::fd::RawFd;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn check_deadline(deadline: u64) -> io::Result<()> {
    if super::super::cancellation_requested() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "cleanup cancelled",
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis() as u64;
    if now > deadline {
        Err(io::Error::new(io::ErrorKind::TimedOut, "deadline exceeded"))
    } else {
        Ok(())
    }
}

pub(super) fn known_bytes_at(parent: RawFd, name: &CStr) -> io::Result<u64> {
    // SAFETY: zeroed is a valid initial state for libc::stat.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: name is NUL-terminated and parent is live; links are measured, never followed.
    if unsafe { libc::fstatat(parent, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(io::Error::last_os_error());
    }
    u64::try_from(stat.st_size).map_err(|_| io::Error::other("invalid known-byte size"))
}

#[cfg(target_os = "linux")]
pub(super) fn mount_id(fd: RawFd) -> io::Result<u64> {
    // SAFETY: zeroed is a valid initial state for libc::statx.
    let mut stat: libc::statx = unsafe { std::mem::zeroed() };
    let empty = c"";
    // SAFETY: AT_EMPTY_PATH requests metadata for the live descriptor and stat is writable.
    if unsafe {
        libc::statx(
            fd,
            empty.as_ptr(),
            libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
            libc::STATX_MNT_ID,
            &mut stat,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if stat.stx_mask & libc::STATX_MNT_ID == 0 {
        return Err(io::Error::other("unsupported mount identity"));
    }
    Ok(stat.stx_mnt_id)
}

#[cfg(target_os = "macos")]
pub(super) fn mount_id(fd: RawFd) -> io::Result<u64> {
    // SAFETY: zeroed is a valid initial state for statfs and fd remains live.
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: the OS writes the fixed-size filesystem information for the live descriptor.
    if unsafe { libc::fstatfs(fd, &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut bytes = [0u8; 8];
    // SAFETY: fsid_t contains at least eight bytes on supported macOS targets.
    unsafe {
        std::ptr::copy_nonoverlapping(
            std::ptr::from_ref(&stat.f_fsid).cast::<u8>(),
            bytes.as_mut_ptr(),
            bytes.len(),
        );
    }
    Ok(u64::from_ne_bytes(bytes))
}
