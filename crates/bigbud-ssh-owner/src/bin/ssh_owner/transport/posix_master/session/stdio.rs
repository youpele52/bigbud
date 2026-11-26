use super::{Cancel, ErrorCode, LOST, TIMED_OUT, UnixStream, checkpoint};
use std::fs::File;
use std::io::{self, PipeReader, PipeWriter};
use std::mem::size_of;
use std::os::fd::{AsRawFd, RawFd};
use std::time::Instant;

pub(super) struct Stdio {
    stdin: File,
    stdout: PipeWriter,
    stderr: File,
    output: PipeReader,
}

impl Stdio {
    pub(super) fn new() -> Result<Self, ErrorCode> {
        let unavailable = |_| ErrorCode::OwnerUnavailable;
        let stdin = File::open("/dev/null").map_err(unavailable)?;
        let stderr = File::options()
            .write(true)
            .open("/dev/null")
            .map_err(unavailable)?;
        let (output, stdout) = io::pipe().map_err(unavailable)?;
        // SAFETY: this is a fresh owned pipe read endpoint, not passed to the
        // peer. Setting its status flags cannot affect the write endpoint.
        if unsafe { libc::fcntl(output.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
            return Err(ErrorCode::OwnerUnavailable);
        }
        Ok(Self {
            stdin,
            stdout,
            stderr,
            output,
        })
    }

    pub(super) fn send(
        self,
        stream: &UnixStream,
        deadline: Instant,
        cancel: Cancel<'_>,
    ) -> Result<PipeReader, ErrorCode> {
        send_fds(
            stream,
            [
                self.stdin.as_raw_fd(),
                self.stdout.as_raw_fd(),
                self.stderr.as_raw_fd(),
            ],
            deadline,
            cancel,
        )?;
        // Drop our writer before collecting; only the mux's copy can keep the
        // output stream open now. Stderr is never captured or interpreted.
        Ok(self.output)
    }
}

pub(super) fn send_fds<const N: usize>(
    stream: &UnixStream,
    fds: [RawFd; N],
    deadline: Instant,
    cancel: Cancel<'_>,
) -> Result<(), ErrorCode> {
    // OpenSSH expects a separate recvmsg for each descriptor in protocol order.
    for fd in fds {
        loop {
            if Instant::now() >= deadline {
                return Err(TIMED_OUT);
            }
            checkpoint(cancel)?;
            match send_one(stream, fd) {
                Ok(()) => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    super::super::pause(deadline);
                }
                Err(_) => return Err(LOST),
            }
        }
    }
    Ok(())
}

fn send_one(stream: &UnixStream, fd: RawFd) -> io::Result<()> {
    let mut data = [0u8];
    let mut iov = libc::iovec {
        iov_base: data.as_mut_ptr().cast(),
        iov_len: data.len(),
    };
    // Initialized storage with at least cmsghdr's alignment and enough space
    // for a single SCM_RIGHTS integer on Linux and Darwin.
    let mut ancillary = [0usize; 4];
    // SAFETY: all fields/padding of msghdr are valid zero values, and CMSG_SPACE
    // and CMSG_LEN receive a constant, small length for a single descriptor.
    let (mut message, space, length) = unsafe {
        let size = size_of::<RawFd>() as libc::c_uint;
        (
            std::mem::zeroed::<libc::msghdr>(),
            libc::CMSG_SPACE(size),
            libc::CMSG_LEN(size),
        )
    };
    if space as usize > size_of::<[usize; 4]>() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = space as _;
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_NOSIGNAL;
    #[cfg(target_os = "macos")]
    let flags = 0; // probe::connect sets SO_NOSIGPIPE on the verified stream.
    // SAFETY: msg_control points to aligned storage of at least CMSG_SPACE;
    // iov and its one data byte live through the call. Both fds are borrowed
    // and remain valid; the kernel duplicates the passed descriptor on success.
    let result = unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        if header.is_null() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        (*header).cmsg_len = length as _;
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        libc::CMSG_DATA(header).cast::<RawFd>().write_unaligned(fd);
        libc::sendmsg(stream.as_raw_fd(), &message, flags)
    };
    match result {
        1 => Ok(()),
        n if n < 0 => Err(io::Error::last_os_error()),
        _ => Err(io::ErrorKind::WriteZero.into()),
    }
}
