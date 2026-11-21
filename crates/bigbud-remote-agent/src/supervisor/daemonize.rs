//! Detaching the local terminal host from its launcher (plan §7.1, §7.3 item 7). The desktop
//! spawns the host with `detached: true` (its own session); this makes the guarantee hold for
//! any launcher: the host leads its own session, so a backend's process-group kill or a
//! terminal hangup never reaches it. Only `--local-desktop-host` calls this.

use std::io;

/// Starts a new session unless this process already leads one.
pub fn detach_from_launcher() -> io::Result<()> {
    // SAFETY: getsid(0) and getpid have no preconditions.
    let (session, pid) = unsafe { (libc::getsid(0), libc::getpid()) };
    if session == pid {
        return Ok(());
    }
    // SAFETY: setsid has no memory effects; it fails with EPERM only for a group leader.
    if unsafe { libc::setsid() } == -1 {
        let error = io::Error::last_os_error();
        // A process-group leader cannot start a session; it is still detached from the
        // launcher's terminal job control as long as the launcher used its own group.
        if error.raw_os_error() != Some(libc::EPERM) {
            return Err(error);
        }
    }
    Ok(())
}
