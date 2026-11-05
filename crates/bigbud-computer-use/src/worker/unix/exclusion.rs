//! Process-wide launch exclusion for the dedicated guard executable. Every
//! launch in this crate takes the same guard (`AnchoredGroup::spawn_bootstrap`
//! requires it), and an FD allow-set audit proves that, at spawn time, no
//! descriptor other than the stdio slots (replaced by the child's file
//! actions) can be inherited. Foreign launchers in a shared process are not
//! policed; the guard role is its own process, so none exist there.
use std::{
    io,
    sync::{Mutex, MutexGuard},
};
#[cfg(target_os = "macos")]
use std::{mem::size_of, os::fd::RawFd};

static LAUNCH: Mutex<()> = Mutex::new(());
/// Upper bound on audited descriptors; more is refused, not truncated.
#[cfg(target_os = "macos")]
const MAX_DESCRIPTORS: usize = 4096;

#[must_use = "hold across descriptor audit, issuance and spawn"]
pub struct LaunchGuard {
    _held: MutexGuard<'static, ()>,
}

impl LaunchGuard {
    /// A poisoned exclusion means a launch unwound mid-flight: refuse.
    pub fn acquire() -> io::Result<Self> {
        LAUNCH
            .lock()
            .map(|held| Self { _held: held })
            .map_err(|_| io::Error::other("launch exclusion poisoned"))
    }

    /// Every open descriptor except 0/1/2 and `also_inherited` must be CLOEXEC.
    #[cfg(target_os = "macos")]
    pub fn audit_descriptors(&self, also_inherited: &[RawFd]) -> io::Result<()> {
        for fd in open_descriptors()? {
            if fd <= 2 || also_inherited.contains(&fd) {
                continue;
            }
            // SAFETY: read-only flag query; a concurrently closed fd fails
            // EBADF, which is refused (no launch while descriptors change).
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags < 0 {
                return Err(io::Error::last_os_error());
            }
            if flags & libc::FD_CLOEXEC == 0 {
                return Err(io::Error::other("inheritable descriptor outside allow-set"));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn open_descriptors() -> io::Result<Vec<RawFd>> {
    let pid = i32::try_from(std::process::id()).map_err(|_| io::Error::other("invalid pid"))?;
    let mut entries = vec![
        libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0
        };
        MAX_DESCRIPTORS + 1
    ];
    let bytes = i32::try_from(entries.len() * size_of::<libc::proc_fdinfo>())
        .map_err(|_| io::Error::other("invalid buffer"))?;
    // SAFETY: writable buffer of exactly `bytes` length for this process's own
    // descriptor table; returns the number of bytes filled, retains no pointer.
    let filled = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            entries.as_mut_ptr().cast(),
            bytes,
        )
    };
    let filled = usize::try_from(filled).map_err(|_| io::Error::last_os_error())?;
    if filled == 0 || filled % size_of::<libc::proc_fdinfo>() != 0 {
        return Err(io::Error::other("descriptor listing unavailable"));
    }
    let count = filled / size_of::<libc::proc_fdinfo>();
    if count > MAX_DESCRIPTORS {
        return Err(io::Error::other("descriptor table exceeds audit bound"));
    }
    Ok(entries
        .get(..count)
        .unwrap_or_default()
        .iter()
        .map(|entry| entry.proc_fd)
        .collect())
}

/// No descriptor enumerator here yet: every launch audit fails closed.
#[cfg(not(target_os = "macos"))]
impl LaunchGuard {
    pub fn audit_descriptors(&self, _also_inherited: &[i32]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "descriptor audit unavailable",
        ))
    }
}
