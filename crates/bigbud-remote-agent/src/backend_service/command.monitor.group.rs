//! Exact owned-group observation while its direct leader remains unreaped.
use super::{Result, ServiceError};

pub(super) fn prepare() -> Result<()> {
    // SAFETY: this isolated, single-threaded monitor must retain child zombies as PID leases.
    if unsafe { libc::signal(libc::SIGCHLD, libc::SIG_DFL) } == libc::SIG_ERR {
        return Err(std::io::Error::last_os_error().into());
    }
    #[cfg(target_os = "linux")]
    // SAFETY: affects only this dedicated monitor, never the backend process.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub(super) fn exited(pid: i32) -> Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: valid output buffer; WNOWAIT preserves our direct child's PID lease.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: waitid initialized the zeroed siginfo buffer on success.
    let info = unsafe { info.assume_init() };
    #[cfg(target_os = "linux")]
    // SAFETY: waitid returned a child-status siginfo.
    let observed = unsafe { info.si_pid() };
    #[cfg(not(target_os = "linux"))]
    let observed = info.si_pid;
    Ok(observed == pid)
}

pub(super) fn signal(pid: i32) -> Result<()> {
    // SAFETY: callers retain this direct leader unreaped for every group signal.
    if unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error.into())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn descendants_remain(leader: i32) -> Result<bool> {
    let path = format!("/proc/self/task/{}/children", std::process::id());
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(path)?
        .take(65537)
        .read_to_string(&mut text)?;
    if text.len() > 65536 {
        return Err(ServiceError::Manager);
    }
    let mut remaining = false;
    for word in text.split_whitespace() {
        let pid = word.parse::<i32>().map_err(|_| ServiceError::Manager)?;
        if pid == leader {
            continue;
        }
        if pid <= 1 {
            return Err(ServiceError::Manager);
        }
        // SAFETY: these are only this isolated subreaper's own unreaped children.
        if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        // SAFETY: exact direct child; reaping it does not release the held leader's lease.
        let result = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        if result < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        remaining = true; // Require another clean observation after any adopted child.
    }
    Ok(remaining)
}

#[cfg(target_os = "macos")]
pub(super) fn descendants_remain(leader: i32) -> Result<bool> {
    let mut pids = [0_i32; 4096];
    let capacity = std::mem::size_of_val(&pids) as i32;
    // SAFETY: bounded writable PID buffer, restricted to our leased process group only.
    let size = unsafe { libc::proc_listpids(2, leader as u32, pids.as_mut_ptr().cast(), capacity) };
    for &pid in checked_members(&pids, size, leader)? {
        if pid == leader {
            continue;
        }
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: exact observed group member and correctly sized writable kernel structure.
        let count = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        if count == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                continue;
            }
            return Err(error.into());
        }
        if count as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
            return Err(ServiceError::Manager);
        }
        // SAFETY: successful full-sized proc_pidinfo initialized the structure.
        let info = unsafe { info.assume_init() };
        if info.pbi_pgid != leader as u32 {
            return Err(ServiceError::Manager);
        }
        if info.pbi_status != 5 {
            return Ok(true);
        } // SZOMB has no runnable descendants to fork.
    }
    Ok(false)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn descendants_remain(_leader: i32) -> Result<bool> {
    Err(ServiceError::Unsupported)
}

#[cfg(target_os = "macos")]
fn checked_members(pids: &[i32], bytes: i32, leader: i32) -> Result<&[i32]> {
    let bytes = usize::try_from(bytes).map_err(|_| ServiceError::Manager)?;
    let width = std::mem::size_of::<i32>();
    if bytes == 0 || bytes >= std::mem::size_of_val(pids) || !bytes.is_multiple_of(width) {
        return Err(ServiceError::Manager);
    }
    let members = pids.get(..bytes / width).ok_or(ServiceError::Manager)?;
    // The unreaped leader MUST still appear; an empty/missing view cannot prove cleanup.
    if !members.contains(&leader) || members.iter().any(|pid| *pid <= 0) {
        return Err(ServiceError::Manager);
    }
    Ok(members)
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn failed_truncated_or_leaderless_group_views_are_never_stopped_proof() {
        let pids = [42, 43, 0, 0];
        assert!(matches!(checked_members(&pids, 8, 42), Ok([42, 43])));
        for bytes in [-1, 0, 1, 3, 5, 16, 20] {
            assert!(checked_members(&pids, bytes, 42).is_err());
        }
        assert!(checked_members(&pids, 4, 43).is_err());
        assert!(checked_members(&pids, 12, 42).is_err());
    }
}
