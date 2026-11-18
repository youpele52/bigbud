use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub pid: i32,
    pub session: i32,
    pub started: u64,
}

impl Identity {
    pub fn read(pid: i32) -> io::Result<Self> {
        let mut bytes = Vec::new();
        File::open(format!("/proc/{pid}/stat"))?
            .take(4097)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(io::Error::other("PTY process identity exceeds bound"));
        }
        Self::parse(pid, &bytes)
    }

    fn parse(pid: i32, stat: &[u8]) -> io::Result<Self> {
        let invalid = || io::Error::other("invalid PTY process identity");
        // Linux comm is an opaque byte name and may contain parentheses or
        // non-UTF-8. Decode only numeric identity fields outside its last ')'.
        let close = stat
            .iter()
            .rposition(|byte| *byte == b')')
            .ok_or_else(invalid)?;
        let space = stat
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or_else(invalid)?;
        if space + 1 >= close || stat.get(space + 1) != Some(&b'(') {
            return Err(invalid());
        }
        let observed_pid = std::str::from_utf8(stat.get(..space).ok_or_else(invalid)?)
            .map_err(|_| invalid())?
            .parse::<i32>()
            .map_err(|_| invalid())?;
        let mut fields = stat
            .get(close + 1..)
            .ok_or_else(invalid)?
            .split(u8::is_ascii_whitespace)
            .filter(|field| !field.is_empty());
        let session = std::str::from_utf8(fields.nth(3).ok_or_else(invalid)?)
            .map_err(|_| invalid())?
            .parse()
            .map_err(|_| invalid())?;
        let started = std::str::from_utf8(fields.nth(15).ok_or_else(invalid)?)
            .map_err(|_| invalid())?
            .parse()
            .map_err(|_| invalid())?;
        if pid <= 0 || observed_pid != pid {
            return Err(invalid());
        }
        Ok(Self {
            pid,
            session,
            started,
        })
    }
}

pub(super) struct Process {
    pub identity: Identity,
    fd: OwnedFd,
    signalled: Option<i32>,
}

impl Process {
    pub fn open(identity: Identity) -> io::Result<Option<Self>> {
        // SAFETY: pidfd_open consumes a positive PID and no pointers. The
        // returned owned descriptor is adopted once and never signals by number.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, identity.pid, 0) };
        if fd < 0 {
            let error = io::Error::last_os_error();
            return if vanished(&error) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        // SAFETY: successful pidfd_open returned a fresh, owned descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        let process = Self {
            identity,
            fd,
            signalled: None,
        };
        let after = match Identity::read(identity.pid) {
            Ok(after) => after,
            Err(error) if vanished(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        // A pinned fd that is still live after rereading stat proves the numeric
        // PID still denotes its original task. Never fall back on naked PIDs.
        if process.exited()? {
            return Ok(None);
        }
        if after != identity {
            return Err(io::Error::other(
                "PTY process identity changed during discovery",
            ));
        }
        Ok(Some(process))
    }

    pub fn exited(&self) -> io::Result<bool> {
        let mut event = libc::pollfd {
            fd: self.fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: event is a live single pollfd; zero timeout never blocks.
        if unsafe { libc::poll(&mut event, 1, 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if event.revents & (libc::POLLNVAL | libc::POLLERR) != 0 {
            return Err(io::Error::other(
                "PTY process descriptor observation failed",
            ));
        }
        Ok(event.revents & (libc::POLLIN | libc::POLLHUP) != 0)
    }

    pub fn signal(&self, signal: i32) -> io::Result<()> {
        // SAFETY: the owned pidfd pins the verified session member; null siginfo
        // uses kernel-generated signal metadata. No PID reuse can redirect it.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }

    pub fn request(&mut self, signal: i32) -> io::Result<()> {
        // Discovery retries observe state; they must not repeatedly trigger a
        // member's signal trap. A new member or explicit escalation is distinct.
        if self.signalled != Some(signal) {
            self.signal(signal)?;
            self.signalled = Some(signal);
        }
        Ok(())
    }
}

pub(super) fn vanished(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_identity_handles_parentheses_and_rejects_malformed_records() {
        let stat = b"42 (job \xff) name) S 1 43 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 91";
        assert_eq!(
            Identity::parse(42, stat).unwrap(),
            Identity {
                pid: 42,
                session: 42,
                started: 91
            }
        );
        assert!(Identity::parse(43, stat).is_err());
        assert!(Identity::parse(42, b"42 (bad) S 1").is_err());
    }
}
