//! The PTY output reader (one owned thread per PTY).
//!
//! - It waits for readiness with `poll(2)` instead of a fixed sleep: a PTY's kernel buffer holds
//!   only a few KiB, so sleeping 5 ms whenever it was empty capped a busy macOS terminal near
//!   0.2 MB/s. The 5 ms poll timeout keeps the child-exit polling cadence.
//! - Each read drains what is ready, up to one 16 KiB chunk, so a flood yields full chunks.
//! - `gate` is the delivery backpressure: while it reports no room, the reader stops reading,
//!   the kernel buffer fills and the child blocks in `write`. Nothing is dropped; every byte
//!   still reaches the callback in order once delivery has room again.

use super::{PtyEvent, PtyHandle, READ_CHUNK_BYTES};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

/// After the child exited, a closed gate may hold its final output this long; then the
/// output is read anyway so an abandoned PTY's worker cannot live forever.
const EXITED_GATE_BOUND: Duration = Duration::from_secs(30);
const POLL_TIMEOUT_MS: i32 = 5;

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

/// Waits up to `timeout_ms` for output.
fn wait_readable(reader: &std::fs::File, timeout_ms: i32) {
    let mut descriptor = libc::pollfd {
        fd: reader.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid pollfd for a descriptor the caller keeps open; poll only writes
    // `revents`. Errors and hangups simply end the wait; the next read reports them.
    let _ready = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
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
        match fill(&mut reader, &mut buffer) {
            Filled::Data(size) => {
                let chunk = buffer.get(..size).map(<[u8]>::to_vec).unwrap_or_default();
                callback(PtyEvent::Output(chunk));
            }
            Filled::Closed => break,
            Filled::Empty if exit.is_some() => break,
            Filled::Empty => wait_readable(&reader, POLL_TIMEOUT_MS),
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
