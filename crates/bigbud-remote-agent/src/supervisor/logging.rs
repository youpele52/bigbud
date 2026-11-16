//! Process-owned stderr capture. Diagnostic loss never cancels remote work.
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[path = "logging.files.rs"]
mod files;

const FILE_BYTES: u64 = 8 * 1024 * 1024;
const CHUNK_BYTES: usize = 16 * 1024;
const QUEUE_CHUNKS: usize = 8;
const POLL: Duration = Duration::from_millis(50);
const JOIN_TIMEOUT: Duration = Duration::from_secs(2);
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static EXIT_REGISTERED: OnceLock<bool> = OnceLock::new();

/// Installed exactly once by supervisor startup, before accepting work. FD2 is
/// process-owned: shutdown redirects it to /dev/null, never an uncapped old log.
/// The kernel socket plus eight 16KiB chunks bound buffering; overflow discards
/// diagnostics with an omission marker when the disk sink can write again.
pub struct SupervisorLogging {
    active: bool,
}

impl SupervisorLogging {
    pub fn start(root: &Path) -> io::Result<Self> {
        Self::start_with_limit(root, FILE_BYTES)
    }

    fn start_with_limit(root: &Path, limit: u64) -> io::Result<Self> {
        let mut slot = RUNNING
            .lock()
            .map_err(|_| io::Error::other("logger poisoned"))?;
        if slot.is_some() {
            return Err(io::Error::other("supervisor logger already installed"));
        }
        if !EXIT_REGISTERED.get_or_init(|| {
            // SAFETY: the callback has C ABI, no captured pointers, never unwinds,
            // and remains valid for the process lifetime. exit bypasses Drop.
            unsafe { libc::atexit(exit_logging) == 0 }
        }) {
            return Err(io::Error::other("cannot register logger exit cleanup"));
        }
        let sink = files::RotatingLog::open(root, limit)?;
        let null = File::options().write(true).open("/dev/null")?;
        let emergency_null = null.try_clone()?;
        let (reader, writer) = UnixStream::pair()?;
        reader.set_read_timeout(Some(POLL))?;
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CHUNKS);
        let stop = Arc::new(AtomicBool::new(false));
        let omitted = Arc::new(AtomicU64::new(0));
        let sink_omitted = Arc::clone(&omitted);
        let sink_worker = thread::Builder::new()
            .name("supervisor-log-disk".into())
            .spawn(move || write_log(sink, receiver, &sink_omitted))?;
        let mut running = Running {
            null,
            stop: Arc::clone(&stop),
            workers: vec![sink_worker],
            captured: false,
        };
        let reader_worker = thread::Builder::new()
            .name("supervisor-log-drain".into())
            .spawn(move || {
                let result = drain(reader, sender, &stop, &omitted);
                if result.is_err() {
                    // A failed reader must not leave future eprintln! calls with
                    // EPIPE. Logging failure affects diagnostics only.
                    redirect(emergency_null.as_raw_fd())?;
                }
                result
            });
        match reader_worker {
            Ok(worker) => running.workers.push(worker),
            Err(error) => {
                drop(writer);
                // The failed spawn drops its sender; the sink will finish.
                let _cleanup = running.stop();
                return Err(error);
            }
        }
        if let Err(error) = redirect(writer.as_raw_fd()) {
            drop(writer);
            let _cleanup = running.stop();
            return Err(error);
        }
        running.captured = true;
        *slot = Some(running);
        Ok(Self { active: true })
    }

    pub fn finish(mut self) -> io::Result<()> {
        self.active = false;
        stop_logging()
    }
}

impl Drop for SupervisorLogging {
    fn drop(&mut self) {
        // Normal callers use finish to observe errors. During unwinding/exit
        // there is no safe diagnostic destination; never recurse through FD2.
        if self.active {
            let _best_effort = stop_logging();
        }
    }
}

extern "C" fn exit_logging() {
    // No unwrap/panic/formatting; callbacks cannot unwind through the C runtime.
    let _best_effort = stop_logging();
}

fn stop_logging() -> io::Result<()> {
    let running = RUNNING
        .lock()
        .map_err(|_| io::Error::other("logger poisoned"))?
        .take();
    match running {
        Some(running) => running.stop(),
        None => Ok(()),
    }
}

struct Running {
    null: File,
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<io::Result<()>>>,
    captured: bool,
}

impl Running {
    fn stop(self) -> io::Result<()> {
        self.stop_until(Instant::now() + JOIN_TIMEOUT)
    }

    fn stop_until(self, deadline: Instant) -> io::Result<()> {
        if self.captured {
            redirect(self.null.as_raw_fd())?;
        }
        self.stop.store(true, Ordering::Release);
        let mut failure = None;
        for worker in self.workers {
            while !worker.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if !worker.is_finished() {
                // Regular-file I/O cannot be cancelled portably. At process
                // teardown an OS-stalled sink is explicitly unconfirmed; never
                // wait forever or signal unrelated work to force a join.
                failure = Some(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "logger shutdown unconfirmed",
                ));
                continue;
            }
            match worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failure = Some(error),
                Err(_) => failure = Some(io::Error::other("logger worker panicked")),
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn redirect(fd: RawFd) -> io::Result<()> {
    // SAFETY: fd is a live borrowed socket/file descriptor; dup2 atomically
    // replaces process-owned stderr without transferring ownership of fd.
    if unsafe { libc::dup2(fd, libc::STDERR_FILENO) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn drain(
    mut reader: UnixStream,
    sender: mpsc::SyncSender<Vec<u8>>,
    stop: &AtomicBool,
    omitted: &AtomicU64,
) -> io::Result<()> {
    let mut buffer = [0; CHUNK_BYTES];
    let mut deadline = None;
    loop {
        if stop.load(Ordering::Acquire) {
            let until = deadline.get_or_insert_with(|| Instant::now() + POLL * 2);
            if Instant::now() >= *until {
                return Ok(());
            }
        }
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => {
                // read cannot return more than the supplied buffer length.
                let bytes = buffer
                    .get(..count)
                    .ok_or_else(|| io::Error::other("invalid log read length"))?;
                if sender.try_send(bytes.to_vec()).is_err() {
                    // Full OR failed disk sink: continue draining FD2. This
                    // counter contains only byte counts, never secret contents.
                    omitted.fetch_add(count as u64, Ordering::Relaxed);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

fn write_log(
    mut sink: impl Write,
    receiver: mpsc::Receiver<Vec<u8>>,
    omitted: &AtomicU64,
) -> io::Result<()> {
    let mut reported = 0;
    for bytes in receiver {
        write_omission(&mut sink, omitted, &mut reported)?;
        sink.write_all(&bytes)?;
    }
    write_omission(&mut sink, omitted, &mut reported)?;
    sink.flush()
}

fn write_omission(
    sink: &mut impl Write,
    omitted: &AtomicU64,
    reported: &mut u64,
) -> io::Result<()> {
    let total = omitted.load(Ordering::Relaxed);
    if total > *reported {
        writeln!(
            sink,
            "\n[bigbud: {} diagnostic bytes omitted]\n",
            total - *reported
        )?;
        *reported = total;
    }
    Ok(())
}

#[cfg(test)]
#[path = "logging.tests.rs"]
mod tests;
