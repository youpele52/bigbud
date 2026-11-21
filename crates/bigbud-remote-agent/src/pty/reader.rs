//! The PTY output reader (one owned thread per PTY).
//!
//! - It waits for readiness with `poll(2)` instead of a fixed sleep: a PTY's kernel buffer holds
//!   only a few KiB, so sleeping 5 ms whenever it was empty capped a busy macOS terminal near
//!   0.2 MB/s. The 5 ms poll timeout keeps the child-exit polling cadence.
//! - Each read drains what is ready. A large first read means a flood: the reader then keeps
//!   draining for up to 2 ms or one 64 KiB chunk, so a macOS PTY (about 1 KiB per read)
//!   yields one frame per batch instead of one per read. Small reads (interactive echo) are
//!   emitted at once, so they gain no latency.
//! - `gate` is the delivery backpressure: while it reports no room, the reader stops reading,
//!   the kernel buffer fills and the child blocks in `write`. Nothing is dropped; every byte
//!   still reaches the callback in order once delivery has room again.

use super::{PtyEvent, PtyHandle, READ_CHUNK_BYTES};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// After the child exited, a closed gate may hold its final output this long; then the
/// output is read anyway so an abandoned PTY's worker cannot live forever.
const EXITED_GATE_BOUND: Duration = Duration::from_secs(30);
const POLL_TIMEOUT_MS: i32 = 5;
/// How long a flood batch may keep draining before it is emitted.
const BATCH_WINDOW: Duration = Duration::from_millis(2);
/// A first read at least this large starts a batch; smaller reads are emitted immediately.
const BATCH_THRESHOLD: usize = 512;

enum Filled {
    Data(usize),
    Empty,
    Closed,
}

/// Reads until `buffer` is full or nothing more is ready.
fn fill(reader: &mut std::fs::File, buffer: &mut [u8]) -> Filled {
    let mut total = 0;
    loop {
        let Some(free) = buffer.get_mut(total..) else {
            return Filled::Data(total);
        };
        if free.is_empty() {
            return Filled::Data(total);
        }
        match reader.read(free) {
            Ok(0) => {
                return if total > 0 {
                    Filled::Data(total)
                } else {
                    Filled::Closed
                };
            }
            Ok(size) => total += size,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return if total > 0 {
                    Filled::Data(total)
                } else {
                    Filled::Empty
                };
            }
            // EIO (the slave side closed) and any other error end the stream after the data
            // already read is delivered; the next call reports the error again.
            Err(_) => {
                return if total > 0 {
                    Filled::Data(total)
                } else {
                    Filled::Closed
                };
            }
        }
    }
}

/// Drains a flood for up to `BATCH_WINDOW` or a full buffer, whichever comes first.
fn fill_batch(reader: &mut std::fs::File, buffer: &mut [u8]) -> Filled {
    let first = fill(reader, buffer);
    let Filled::Data(mut total) = first else {
        return first;
    };
    if total < BATCH_THRESHOLD {
        return Filled::Data(total);
    }
    let deadline = Instant::now() + BATCH_WINDOW;
    while total < buffer.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let timeout = i32::try_from(remaining.as_millis().max(1)).unwrap_or(1);
        if !wait_readable(reader, timeout) {
            break;
        }
        let Some(rest) = buffer.get_mut(total..) else {
            break;
        };
        match fill(reader, rest) {
            Filled::Data(size) => total += size,
            Filled::Empty => continue,
            // The next read reports the end again, after this batch is delivered.
            Filled::Closed => break,
        }
    }
    Filled::Data(total)
}

/// Waits up to `timeout_ms` for output; true when the descriptor is readable (or hung up).
fn wait_readable(reader: &std::fs::File, timeout_ms: i32) -> bool {
    let mut descriptor = libc::pollfd {
        fd: reader.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid pollfd for a descriptor the caller keeps open; poll only writes
    // `revents`. Errors and hangups simply end the wait; the next read reports them.
    let ready = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
    ready > 0
}

pub fn run_events(reader: std::fs::File, handle: &PtyHandle, callback: impl FnMut(PtyEvent)) {
    run_events_gated(reader, handle, || true, callback);
}

/// `gate` returns whether delivery has room for another chunk; it may wait, briefly and
/// boundedly, for room. While it returns false nothing is read.
pub fn run_events_gated(
    mut reader: std::fs::File,
    handle: &PtyHandle,
    mut gate: impl FnMut() -> bool,
    mut callback: impl FnMut(PtyEvent),
) {
    let mut buffer = vec![0; READ_CHUNK_BYTES];
    let mut exit = None;
    let mut gated_after_exit: Option<Instant> = None;
    while let Ok(result) = handle.inner.child.poll() {
        exit = result;
        if !gate() {
            let held = exit.is_some()
                && gated_after_exit.get_or_insert_with(Instant::now).elapsed() >= EXITED_GATE_BOUND;
            if !held {
                continue;
            }
        }
        match fill_batch(&mut reader, &mut buffer) {
            Filled::Data(size) => {
                // The only copy: this allocation is shared by the ring, model and spool.
                let chunk: super::OutputBytes = Arc::from(buffer.get(..size).unwrap_or_default());
                callback(PtyEvent::Output(chunk));
            }
            Filled::Closed => break,
            Filled::Empty if exit.is_some() => break,
            Filled::Empty => {
                let _readable = wait_readable(&reader, POLL_TIMEOUT_MS);
            }
        }
    }
    // EOF can precede actual child exit. This owned worker polls without holding
    // state locks; restart escalation can still signal the live leader authority.
    while exit.is_none() {
        match handle.inner.child.poll() {
            Ok(result) => exit = result,
            Err(_) => return,
        }
        if exit.is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    if let Some(exit) = exit {
        if handle.inner.input.shutdown().is_err() {
            return;
        }
        callback(PtyEvent::Exited {
            exit_code: exit.code,
            signal: exit.signal,
        });
    }
}
