use std::io;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}
enum Authority {
    Live,
    Reaping,
    Reaped(Exit),
    Unknown,
}

/// The unreaped direct leader anchors this PID/PGID's identity. No other path
/// may waitpid it. Signals and authority invalidation/reap share one permit.
/// Group signalling does not certify escaped/job-control descendant cleanup.
pub(super) struct Child {
    pid: i32,
    authority: Mutex<Authority>,
}
impl Child {
    pub fn new(pid: i32) -> Self {
        Self {
            pid,
            authority: Mutex::new(Authority::Live),
        }
    }
    pub fn reaped(&self) -> bool {
        self.authority
            .lock()
            .is_ok_and(|state| matches!(*state, Authority::Reaped(_)))
    }
    pub fn signal(&self, signal: i32) -> io::Result<()> {
        self.signal_with(|pid| {
            // SAFETY: permit holds an unreaped, exclusively owned forkpty leader;
            // its positive PID cannot be reused until our serialized reap.
            if unsafe { libc::kill(-pid, signal) } == 0 {
                Ok(())
            } else {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        })
    }
    fn signal_with(&self, call: impl FnOnce(i32) -> io::Result<()>) -> io::Result<()> {
        let authority = self
            .authority
            .lock()
            .map_err(|_| io::Error::other("child authority poisoned"))?;
        match *authority {
            Authority::Live => call(self.pid),
            Authority::Reaped(_) => Ok(()), // Retained handles have no native authority.
            _ => Err(io::Error::other("child cleanup outcome unknown")),
        }
    }
    pub fn poll(&self) -> io::Result<Option<Exit>> {
        self.poll_with(|pid| {
            let mut status = 0;
            // SAFETY: this is the only reaper, under the same signal permit.
            // Authority is invalidated BEFORE waitpid can release/reuse the PID.
            let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if result == 0 {
                return Ok(None);
            }
            if result == -1 {
                return Err(io::Error::last_os_error());
            }
            if result != pid {
                return Err(io::Error::other("unexpected direct-child wait identity"));
            }
            // A traced/stopped notification is not reap evidence. Only final
            // exit/signal status releases the leader's lifetime anchor.
            if !libc::WIFEXITED(status) && !libc::WIFSIGNALED(status) {
                return Ok(None);
            }
            Ok(Some(Exit {
                code: if libc::WIFEXITED(status) {
                    Some(libc::WEXITSTATUS(status))
                } else {
                    None
                },
                signal: if libc::WIFSIGNALED(status) {
                    Some(libc::WTERMSIG(status))
                } else {
                    None
                },
            }))
        })
    }
    pub(super) fn poll_with(
        &self,
        call: impl FnOnce(i32) -> io::Result<Option<Exit>>,
    ) -> io::Result<Option<Exit>> {
        let mut authority = self
            .authority
            .lock()
            .map_err(|_| io::Error::other("child authority poisoned"))?;
        match *authority {
            Authority::Reaped(exit) => return Ok(Some(exit)),
            Authority::Unknown | Authority::Reaping => {
                return Err(io::Error::other("child cleanup unknown"));
            }
            Authority::Live => {}
        }
        *authority = Authority::Reaping;
        match call(self.pid) {
            Ok(Some(exit)) => {
                *authority = Authority::Reaped(exit);
                Ok(Some(exit))
            }
            Ok(None) => {
                *authority = Authority::Live;
                Ok(None)
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                *authority = Authority::Live;
                Ok(None)
            }
            Err(error) => {
                *authority = Authority::Unknown;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
#[path = "child.tests.rs"]
mod tests;
