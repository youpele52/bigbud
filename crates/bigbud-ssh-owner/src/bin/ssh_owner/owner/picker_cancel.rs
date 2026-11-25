//! Private inherited cancellation inbox for explicit disposable owner fixtures.
//! Only an exact 16-byte request ID can cancel an active read. No commands or
//! secrets travel on this channel, and it cannot execute a cancellation itself.
use super::ErrorCode;
use std::{
    cell::{Cell, RefCell},
    fs::File,
    io::{self, Read},
    mem::MaybeUninit,
    os::fd::{FromRawFd, OwnedFd},
};

const FD: i32 = 3;
pub(super) const ID_BYTES: usize = 16;
const MAX_READ_ATTEMPTS: usize = 16;

pub(in super::super) struct CancelInbox {
    input: File,
    pending: [u8; ID_BYTES],
    filled: usize,
    closed: bool,
    cleanup_uncertain: bool,
}

impl CancelInbox {
    /// Call only after selecting a private cancellation fixture, never from an
    /// ordinary owner, attachment, or agent-proxy launch.
    pub(in super::super) fn bind() -> io::Result<Self> {
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: fstat writes to initialized storage on success; no Rust reference is aliased.
        if unsafe { libc::fstat(FD, stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mode = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
        if mode != libc::S_IFIFO && mode != libc::S_IFSOCK {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // SAFETY: this selected startup exclusively owns FD 3 and transfers it once.
        let fd = unsafe { OwnedFd::from_raw_fd(FD) };
        // SAFETY: fd remains live throughout these calls. Preserve status flags.
        let flags = unsafe { libc::fcntl(FD, libc::F_GETFL) };
        if flags == -1
            || unsafe { libc::fcntl(FD, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
            || unsafe { libc::fcntl(FD, libc::F_SETFD, libc::FD_CLOEXEC) } == -1
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self::new(fd))
    }

    pub(super) fn new(fd: OwnedFd) -> Self {
        Self {
            input: File::from(fd),
            pending: [0; ID_BYTES],
            filled: 0,
            closed: false,
            cleanup_uncertain: false,
        }
    }

    pub(super) fn run<T>(
        &mut self,
        id: &[u8],
        operation: impl FnOnce(&dyn Fn() -> bool) -> Result<T, ErrorCode>,
    ) -> Result<T, ErrorCode> {
        let id: &[u8; ID_BYTES] = id.try_into().map_err(|_| ErrorCode::InvalidOperands)?;
        let inbox = RefCell::new(&mut *self);
        let cancelled = Cell::new(false);
        let result = operation(&|| {
            let matches = cancelled.get() || inbox.borrow_mut().cancelled(id);
            cancelled.set(matches);
            matches
        });
        if matches!(result, Err(ErrorCode::OutcomeUnknown)) {
            self.cleanup_uncertain = true;
        }
        result
    }

    pub(super) fn cleanup_uncertain(&self) -> bool {
        self.cleanup_uncertain
    }

    pub(super) fn cancelled(&mut self, request_id: &[u8; ID_BYTES]) -> bool {
        if self.closed {
            return true;
        }
        for _ in 0..MAX_READ_ATTEMPTS {
            let Some(remaining) = self.pending.get_mut(self.filled..) else {
                self.closed = true;
                return true;
            };
            match self.input.read(remaining) {
                Ok(0) => {
                    self.closed = true;
                    return true;
                }
                Ok(count) => {
                    self.filled += count;
                    if self.filled == ID_BYTES {
                        self.filled = 0;
                        if &self.pending == request_id {
                            return true;
                        }
                        // A late frame for a completed read does not affect a new one.
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return false,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.closed = true;
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
#[test]
fn ignores_late_ids_and_waits_for_the_whole_matching_frame() {
    use std::{io::Write, os::unix::net::UnixStream};
    let (reader, mut writer) = UnixStream::pair().expect("private test pair");
    reader.set_nonblocking(true).expect("nonblocking reader");
    let mut inbox = CancelInbox::new(reader.into());
    writer.write_all(&[1; ID_BYTES]).expect("late cancellation");
    writer
        .write_all(&[2; ID_BYTES / 2])
        .expect("partial current frame");
    assert!(!inbox.cancelled(&[2; ID_BYTES]));
    writer
        .write_all(&[2; ID_BYTES / 2])
        .expect("remaining current frame");
    assert!(inbox.cancelled(&[2; ID_BYTES]));
    assert!(!inbox.cancelled(&[3; ID_BYTES]));
    drop(writer);
    assert!(inbox.cancelled(&[3; ID_BYTES]));
}
