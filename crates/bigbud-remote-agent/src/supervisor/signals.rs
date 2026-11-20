//! Graceful supervisor termination on SIGTERM, SIGINT and SIGHUP.
//!
//! A self-pipe handler (installed with `SA_RESTART`) only writes one byte; one
//! owned thread turns the first byte into the existing restart drain. A blocked
//! mask plus `sigwait` is deliberately avoided: a blocked mask is inherited
//! across exec into PTY children, while a handled disposition resets to the
//! default on exec.
use crate::AgentSession;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

/// Matches the systemd unit's `TimeoutStopSec`.
const TERMINATION_CAP: Duration = Duration::from_secs(15);
/// Shell convention for SIGTERM; `launch.exit` classification depends on it.
const SETTLED_EXIT: i32 = 143;
const UNSETTLED_EXIT: i32 = 1;
const TERMINATION_SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

static WRITE_FD: AtomicI32 = AtomicI32::new(-1);
static OWNER_PID: AtomicI32 = AtomicI32::new(0);

extern "C" fn deliver(signal: libc::c_int) {
    let errno = errno_location();
    // SAFETY: libc's thread-local errno pointer is valid for this thread.
    let saved = unsafe { *errno };
    let fd = WRITE_FD.load(Ordering::Acquire);
    // SAFETY: getpid is async-signal-safe and touches no shared memory.
    // A forked PTY child before exec still runs this handler: never let it
    // write the supervisor's pipe.
    if fd >= 0 && unsafe { libc::getpid() } == OWNER_PID.load(Ordering::Acquire) {
        let byte = signal as u8;
        // SAFETY: async-signal-safe write of one stack byte to the
        // process-lifetime, nonblocking pipe. A full pipe already holds a
        // pending wakeup, so EAGAIN is intentionally ignored.
        let _written = unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
    }
    // SAFETY: restore the interrupted code's errno through the same pointer.
    unsafe { *errno = saved };
}

fn errno_location() -> *mut libc::c_int {
    #[cfg(target_os = "linux")]
    // SAFETY: libc returns this thread's errno pointer; async-signal-safe.
    unsafe {
        libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    // SAFETY: libc returns this thread's errno pointer; async-signal-safe.
    unsafe {
        libc::__error()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    compile_error!("supervisor signal handling needs an async-signal-safe errno accessor");
}

fn pipe_cloexec_nonblock() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [-1; 2];
    #[cfg(target_os = "linux")]
    {
        // SAFETY: fds is a valid two-element array for pipe2 to fill.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // SAFETY: fds is a valid two-element array for pipe to fill.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let [read, write] = fds;
    // SAFETY: a successful pipe call returned two fresh descriptors we own.
    let pair = unsafe { (OwnedFd::from_raw_fd(read), OwnedFd::from_raw_fd(write)) };
    #[cfg(not(target_os = "linux"))]
    configure_pipe(&pair)?;
    Ok(pair)
}

#[cfg(not(target_os = "linux"))]
fn configure_pipe(pair: &(OwnedFd, OwnedFd)) -> io::Result<()> {
    for fd in [pair.0.as_raw_fd(), pair.1.as_raw_fd()] {
        // SAFETY: fcntl on owned, open descriptors. Installation precedes PTY
        // spawns, so no concurrent exec can inherit the brief non-CLOEXEC pipe.
        let configured = unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) == 0
                && libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) == 0
        };
        if !configured {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn set_disposition(signal: libc::c_int, handler: libc::sighandler_t) -> io::Result<()> {
    // SAFETY: zeroed sigaction is a valid starting value; every field used is set.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = handler;
    action.sa_flags = libc::SA_RESTART;
    // SAFETY: sa_mask is owned by action. Masking the other termination
    // signals keeps one handler invocation from nesting inside another.
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        for other in TERMINATION_SIGNALS {
            libc::sigaddset(&mut action.sa_mask, other);
        }
    }
    // SAFETY: action is fully initialized; the old action is not requested.
    if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn restore_defaults() {
    for signal in TERMINATION_SIGNALS {
        if let Err(error) = set_disposition(signal, libc::SIG_DFL) {
            eprintln!("remote agent could not restore default signal {signal}: {error}");
        }
    }
}

/// The read end of the process-lifetime self-pipe.
pub(super) struct SignalReceiver {
    read: OwnedFd,
}

/// Installs the handler once per process. The write end is intentionally never
/// closed: a handler may run at any time until exit, and a closed descriptor
/// number could be reused by unrelated I/O.
pub(super) fn install() -> io::Result<SignalReceiver> {
    let (read, write) = pipe_cloexec_nonblock()?;
    // SAFETY: getpid has no preconditions.
    OWNER_PID.store(unsafe { libc::getpid() }, Ordering::Release);
    WRITE_FD
        .compare_exchange(-1, write.as_raw_fd(), Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| io::Error::new(io::ErrorKind::AlreadyExists, "signal pipe installed"))?;
    let _process_lifetime = write.into_raw_fd();
    let handler = deliver as extern "C" fn(libc::c_int) as libc::sighandler_t;
    for signal in TERMINATION_SIGNALS {
        if let Err(error) = set_disposition(signal, handler) {
            restore_defaults();
            return Err(error);
        }
    }
    Ok(SignalReceiver { read })
}

impl SignalReceiver {
    fn wait(&self) -> io::Result<libc::c_int> {
        loop {
            let mut event = libc::pollfd {
                fd: self.read.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: event is one valid pollfd for an owned open descriptor.
            if unsafe { libc::poll(&mut event, 1, -1) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            let mut byte = 0_u8;
            // SAFETY: reads at most one byte into an owned stack byte.
            match unsafe { libc::read(self.read.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) } {
                1 => return Ok(libc::c_int::from(byte)),
                0 => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
                _ => {
                    let error = io::Error::last_os_error();
                    if !matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) {
                        return Err(error);
                    }
                }
            }
        }
    }
}

/// The bound socket's identity, so a successor's socket is never unlinked.
pub(super) struct BoundSocket {
    path: PathBuf,
    identity: (u64, u64),
}

impl BoundSocket {
    pub(super) fn capture(path: &Path) -> io::Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            identity: (metadata.dev(), metadata.ino()),
        })
    }

    fn remove(&self) {
        match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) if (metadata.dev(), metadata.ino()) == self.identity => {
                if let Err(error) = std::fs::remove_file(&self.path) {
                    eprintln!("remote agent supervisor socket removal failed: {error}");
                }
            }
            Ok(_) => eprintln!("remote agent supervisor socket was replaced; left in place"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("remote agent supervisor socket inspection failed: {error}"),
        }
    }
}

/// Owns the terminal signal path. The first signal starts one bounded drain;
/// later signals stay queued in the pipe and are ignored until exit.
pub(super) fn spawn(
    receiver: SignalReceiver,
    sessions: Arc<Mutex<AgentSession>>,
    socket: BoundSocket,
) -> io::Result<()> {
    let _detached = std::thread::Builder::new()
        .name("supervisor-signals".to_owned())
        .spawn(move || {
            let signal = match receiver.wait() {
                Ok(signal) => signal,
                Err(error) => {
                    // Without a receiver, default dispositions still terminate.
                    eprintln!("remote agent signal receiver failed: {error}");
                    restore_defaults();
                    return;
                }
            };
            let code = terminate(signal, sessions, &socket);
            super::super::control::exit_supervisor_with(code);
        })?;
    Ok(())
}

fn terminate(signal: libc::c_int, sessions: Arc<Mutex<AgentSession>>, socket: &BoundSocket) -> i32 {
    eprintln!("remote agent supervisor received signal {signal}; draining owned work");
    let deadline = Instant::now() + TERMINATION_CAP;
    let (done, outcome) = mpsc::sync_channel(1);
    let worker = std::thread::Builder::new()
        .name("supervisor-signal-drain".to_owned())
        .spawn(move || {
            let result = super::drain::terminate_on_signal(&sessions, deadline);
            // The receiver only disappears after the cap already chose exit 1.
            let _delivered = done.send(result);
        });
    let settled = match worker {
        Ok(_worker) => {
            match outcome.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Ok(settled)) => settled,
                Ok(Err(error)) => {
                    eprintln!("remote agent signal drain failed: {error}");
                    false
                }
                Err(_) => {
                    eprintln!("remote agent signal drain exceeded {TERMINATION_CAP:?}");
                    false
                }
            }
        }
        Err(error) => {
            eprintln!("remote agent signal drain could not start: {error}");
            false
        }
    };
    socket.remove();
    if settled {
        SETTLED_EXIT
    } else {
        eprintln!("remote agent supervisor shutdown-cleanup-unknown");
        UNSETTLED_EXIT
    }
}
