//! Launcher-owned lifetime, never a dispatcher credential. Any activity on FD 3 retires the owner.
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    time::Duration,
};

pub(in super::super) struct LauncherLifetime(OwnedFd);

impl LauncherLifetime {
    pub(in super::super) fn bind() -> io::Result<Self> {
        const FD: libc::c_int = 3;
        // SAFETY: supervised macOS interactive startup reserves inherited FD 3 for this socket.
        let mut kind: libc::c_int = 0;
        let mut length = std::mem::size_of_val(&kind) as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                FD,
                libc::SOL_SOCKET,
                libc::SO_TYPE,
                (&mut kind as *mut libc::c_int).cast(),
                &mut length,
            )
        };
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
        if kind != libc::SOCK_STREAM {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // SAFETY: FD 3 is a valid, exclusively reserved inherited descriptor. Do not pass it to ssh.
        if unsafe { libc::fcntl(FD, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the owner startup takes this descriptor exactly once.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(FD) }))
    }

    pub(super) fn wait(
        &self,
        socket: &impl AsRawFd,
        events: libc::c_short,
        timeout: Option<Duration>,
    ) -> io::Result<()> {
        let mut descriptors = [
            libc::pollfd {
                fd: self.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: socket.as_raw_fd(),
                events,
                revents: 0,
            },
        ];
        let ms = timeout.map_or(-1, |time| {
            time.as_millis().clamp(1, i32::MAX as u128) as i32
        });
        // SAFETY: poll receives two initialized, live descriptors and does not retain the pointer.
        let ready = unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, ms) };
        if ready < 0 {
            return Err(io::Error::last_os_error());
        }
        if descriptors[0].revents != 0 {
            return Err(io::ErrorKind::ConnectionAborted.into());
        }
        if ready == 0 {
            return Err(io::ErrorKind::TimedOut.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::net::UnixStream};

    #[test]
    fn launcher_eof_or_signal_takes_priority_over_ready_backend_data() {
        for close in [true, false] {
            let (mut launcher, inherited) = UnixStream::pair().expect("lifetime pair");
            let lifetime = LauncherLifetime(inherited.into());
            let (dispatcher, mut peer) = UnixStream::pair().expect("dispatcher pair");
            peer.write_all(b"request").expect("queue dispatcher data");
            let short = Some(Duration::from_millis(50));
            lifetime
                .wait(&dispatcher, libc::POLLIN, short)
                .expect("dispatcher ready while launcher is quiet");
            if close {
                drop(launcher);
            } else {
                launcher
                    .write_all(b"stop")
                    .expect("queue launcher shutdown");
            }
            assert_eq!(
                lifetime
                    .wait(&dispatcher, libc::POLLIN, short)
                    .expect_err("launcher shutdown must win over queued requests")
                    .kind(),
                io::ErrorKind::ConnectionAborted,
            );
        }
    }
}
