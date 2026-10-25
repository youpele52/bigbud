use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, v1};
use std::collections::VecDeque;
use std::io::{self, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const BYTE_LIMIT: usize = 256 * 1024;
const ITEM_LIMIT: usize = 256;
static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
static CONTROL_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
struct ConnectionPermit(&'static AtomicUsize);
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
#[path = "writer.budget.rs"]
pub(super) mod budget;
use budget::EncodedFrame;
#[path = "writer.lifecycle.rs"]
mod lifecycle;

struct Queue {
    frames: VecDeque<(EncodedFrame, bool)>,
    bytes: usize,
    items: usize,
    stream_bytes: usize,
    stream_items: usize,
}
struct Shared {
    queue: Mutex<Queue>,
    changed: Condvar,
    closed: AtomicBool,
    socket: UnixStream,
}

/// A socket has one FIFO writer; producers only perform bounded, nonblocking admission.
pub(in crate::supervisor) struct OutboundWriter {
    shared: Arc<Shared>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    terminal_join_deadline: Mutex<Option<Instant>>,
}

impl OutboundWriter {
    pub(super) fn start(stream: UnixStream) -> io::Result<Arc<Self>> {
        Self::start_with_kind(stream, false)
    }

    pub(super) fn start_with_kind(stream: UnixStream, control_only: bool) -> io::Result<Arc<Self>> {
        Self::start_worker(stream, control_only, || {})
    }

    fn start_worker(
        mut stream: UnixStream,
        control_only: bool,
        after_run: impl FnOnce() + Send + 'static,
    ) -> io::Result<Arc<Self>> {
        let (counter, limit) = if control_only {
            (&CONTROL_CONNECTIONS, 4)
        } else {
            (&CONNECTIONS, 60)
        };
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < limit).then_some(count + 1)
            })
            .map_err(|_| io::Error::other("supervisor connection budget exceeded"))?;
        let connection = ConnectionPermit(counter);
        (|| {
            stream.set_write_timeout(Some(Duration::from_millis(100)))?;
            let shared = Arc::new(Shared {
                queue: Mutex::new(Queue {
                    frames: VecDeque::new(),
                    bytes: 0,
                    items: 0,
                    stream_bytes: 0,
                    stream_items: 0,
                }),
                changed: Condvar::new(),
                closed: AtomicBool::new(false),
                socket: stream.try_clone()?,
            });
            let state = Arc::clone(&shared);
            let worker = std::thread::Builder::new()
                .name("subscriber-writer".to_owned())
                .spawn(move || {
                    let _connection = connection;
                    run(&state, &mut stream);
                    after_run();
                })?;
            let writer = Arc::new(Self {
                shared,
                worker: Mutex::new(Some(worker)),
                terminal_join_deadline: Mutex::new(None),
            });
            super::job_lifecycle::register(&writer)?;
            Ok(writer)
        })()
    }

    #[cfg(test)]
    pub(super) fn enqueue(&self, response: &v1::Frame) -> io::Result<()> {
        self.admit(response, true)
    }

    // Legacy file/attach replies may exceed a subscriber window. Pace these on
    // the connection thread, never on a PTY/process/watch producer or state lock.
    pub(super) fn enqueue_response(&self, response: &v1::Frame) -> io::Result<()> {
        self.admit(response, false)
    }

    pub(super) fn enqueue_terminal(&self, response: &v1::Frame) -> io::Result<()> {
        self.admit(response, true)
    }

    fn admit(&self, response: &v1::Frame, streaming: bool) -> io::Result<()> {
        // Cap before serialization. The protocol encoder verifies its length before allocating.
        let maximum = if streaming {
            BYTE_LIMIT - 4
        } else {
            DEFAULT_MAX_FRAME_BYTES
        };
        let frame = budget::encode(response, maximum)?;
        self.enqueue_encoded(frame, streaming)
    }

    pub(super) fn enqueue_encoded(&self, frame: EncodedFrame, streaming: bool) -> io::Result<()> {
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| io::Error::other("writer queue poisoned"))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if self.is_closed() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            let full = if streaming {
                queue.stream_bytes + frame.len() > BYTE_LIMIT || queue.stream_items >= ITEM_LIMIT
            } else {
                queue.bytes - queue.stream_bytes + frame.len() > DEFAULT_MAX_FRAME_BYTES + 4
                    || queue.items - queue.stream_items >= ITEM_LIMIT
            };
            if !full {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if streaming || remaining.is_zero() {
                drop(queue);
                self.cancel();
                return Err(io::Error::other(
                    "subscriber window exhausted; reconnect required",
                ));
            }
            queue = self
                .shared
                .changed
                .wait_timeout(queue, remaining)
                .map_err(|_| io::Error::other("writer queue poisoned"))?
                .0;
        }
        queue.bytes += frame.len();
        queue.items += 1;
        if streaming {
            queue.stream_bytes += frame.len();
            queue.stream_items += 1;
        }
        queue.frames.push_back((frame, streaming));
        self.shared.changed.notify_one();
        Ok(())
    }

    pub(super) fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub(super) fn worker_joined(&self) -> bool {
        self.worker.lock().unwrap().is_none()
    }
    #[cfg(test)]
    pub(super) fn retained_encoded_bytes() -> usize {
        budget::PROFILE_BYTES.load(Ordering::Acquire)
    }
    pub(super) fn drain(&self) -> io::Result<()> {
        self.drain_until(Instant::now() + Duration::from_secs(5))
    }
    pub(super) fn drain_until(&self, deadline: Instant) -> io::Result<()> {
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| io::Error::other("writer queue poisoned"))?;
        while queue.items != 0 {
            if self.is_closed() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            queue = self
                .shared
                .changed
                .wait_timeout(queue, remaining)
                .map_err(|_| io::Error::other("writer queue poisoned"))?
                .0;
        }
        Ok(())
    }
    pub(super) fn cancel(&self) {
        self.shared.closed.store(true, Ordering::Release);
        // Shutdown wakes a blocked reader/writer; a close error cannot reopen admission.
        let _ = self.shared.socket.shutdown(Shutdown::Both);
        self.shared.changed.notify_all();
    }
}

fn run(shared: &Shared, stream: &mut UnixStream) {
    loop {
        let frame = {
            let mut queue = match shared.queue.lock() {
                Ok(queue) => queue,
                Err(_) => break,
            };
            while queue.frames.is_empty() && !shared.closed.load(Ordering::Acquire) {
                queue = match shared.changed.wait(queue) {
                    Ok(queue) => queue,
                    Err(_) => return,
                };
            }
            if shared.closed.load(Ordering::Acquire) {
                break;
            }
            queue.frames.pop_front()
        };
        let Some((frame, streaming)) = frame else {
            continue;
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut offset = 0;
        while offset < frame.len()
            && !shared.closed.load(Ordering::Acquire)
            && Instant::now() < deadline
        {
            let Some(bytes) = frame.bytes.get(offset..) else {
                break;
            };
            match stream.write(bytes) {
                Ok(0) => break,
                Ok(count) => offset += count,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted
                            | io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                Err(_) => break,
            }
        }
        if let Ok(mut queue) = shared.queue.lock() {
            queue.bytes -= frame.len();
            queue.items -= 1;
            if streaming {
                queue.stream_bytes -= frame.len();
                queue.stream_items -= 1;
            }
            shared.changed.notify_all();
        }
        if offset != frame.len() {
            break;
        }
    }
    shared.closed.store(true, Ordering::Release);
    let _ = shared.socket.shutdown(Shutdown::Both);
    if let Ok(mut queue) = shared.queue.lock() {
        queue.frames.clear();
        queue.bytes = 0;
        queue.items = 0;
        queue.stream_bytes = 0;
        queue.stream_items = 0;
    }
    shared.changed.notify_all();
}

#[cfg(test)]
#[path = "writer.shutdown.tests.rs"]
mod shutdown_tests;
#[cfg(test)]
#[path = "writer.tests.rs"]
mod tests;
