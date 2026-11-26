//! The per-PTY spool writer handle. All file I/O runs on the writer's own thread behind a bounded
//! queue; [`SpoolWriter::append`] never blocks the PTY reader (plan §14). Queue overflow or an
//! I/O error disables the spool for that PTY and reports `spool_degraded` once.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::errors::{SpoolError, SpoolLimits};
use super::segment::MAX_RECORD_BYTES;
use super::store::StoreInner;

/// Result of handing one output chunk to the spool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    /// Queued for the writer thread.
    Queued,
    /// This call overflowed the queue (or found the writer gone) and disabled the spool. The
    /// caller emits `spool_degraded` exactly once.
    Degraded,
    /// The spool was already disabled; nothing is recorded.
    Disabled,
    /// The sequence did not advance; the chunk was ignored.
    OutOfOrder,
}

pub(super) enum Message {
    Output {
        sequence: u64,
        /// Shared with the PTY's replay ring and screen feed (R7): queued output is not copied.
        bytes: Arc<[u8]>,
    },
    Checkpoint {
        through_sequence: u64,
        blob: Vec<u8>,
    },
    Flush(SyncSender<Result<(), String>>),
    Shrink,
    /// Wake-up only: the handle disabled the spool and the meta must say so.
    Degraded,
    Stop {
        remove: bool,
    },
}

/// State shared between the handle and its thread.
pub(super) struct WriterShared {
    pub(super) degraded: AtomicBool,
    pub(super) checkpoint_wanted: AtomicBool,
    pub(super) output_since_checkpoint: AtomicBool,
    pub(super) queued_bytes: AtomicUsize,
    /// Milliseconds after `started` at which the last checkpoint became durable.
    pub(super) last_checkpoint_ms: AtomicU64,
    pub(super) started: Instant,
}

impl WriterShared {
    pub(super) fn new() -> Self {
        Self {
            degraded: AtomicBool::new(false),
            checkpoint_wanted: AtomicBool::new(false),
            output_since_checkpoint: AtomicBool::new(false),
            queued_bytes: AtomicUsize::new(0),
            last_checkpoint_ms: AtomicU64::new(0),
            started: Instant::now(),
        }
    }

    pub(super) fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

pub struct SpoolWriter {
    pub(super) pty_id: String,
    pub(super) dir_name: String,
    pub(super) sender: SyncSender<Message>,
    pub(super) shared: Arc<WriterShared>,
    pub(super) thread: Option<JoinHandle<Result<(), String>>>,
    pub(super) store: Weak<StoreInner>,
    pub(super) limits: SpoolLimits,
    /// `last appended sequence + 1`, or 0 before the first append.
    pub(super) next_floor: AtomicU64,
}

impl SpoolWriter {
    pub fn pty_id(&self) -> &str {
        &self.pty_id
    }

    /// Queues one PTY output chunk. Never blocks.
    pub fn append(&self, sequence: u64, bytes: &[u8]) -> AppendOutcome {
        self.append_shared(sequence, Arc::from(bytes))
    }

    /// Queues a chunk the caller shares with other consumers (the host's PTY path).
    pub fn append_shared(&self, sequence: u64, bytes: Arc<[u8]>) -> AppendOutcome {
        if self.shared.degraded.load(Ordering::Acquire) {
            return AppendOutcome::Disabled;
        }
        if sequence < self.next_floor.load(Ordering::Acquire) {
            return AppendOutcome::OutOfOrder;
        }
        self.next_floor
            .store(sequence.saturating_add(1), Ordering::Release);
        if bytes.is_empty() {
            return AppendOutcome::Queued;
        }
        let queued = self.shared.queued_bytes.load(Ordering::Acquire);
        if bytes.len() > MAX_RECORD_BYTES
            || queued.saturating_add(bytes.len()) > self.limits.queue_bytes
        {
            return self.degrade();
        }
        let length = bytes.len();
        self.shared.queued_bytes.fetch_add(length, Ordering::AcqRel);
        let message = Message::Output { sequence, bytes };
        match self.sender.try_send(message) {
            Ok(()) => AppendOutcome::Queued,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.shared.queued_bytes.fetch_sub(length, Ordering::AcqRel);
                self.degrade()
            }
        }
    }

    fn degrade(&self) -> AppendOutcome {
        if self.shared.degraded.swap(true, Ordering::AcqRel) {
            return AppendOutcome::Disabled;
        }
        // Wake the thread so it records the flag durably. A full queue already wakes it.
        if self.sender.try_send(Message::Degraded).is_err() {
            // Full or stopped: the queued messages (or Stop) persist the flag instead.
        }
        AppendOutcome::Degraded
    }

    /// Queues an opaque screen checkpoint covering every chunk up to `through_sequence`.
    pub fn checkpoint(&self, through_sequence: u64, blob: Vec<u8>) -> Result<(), SpoolError> {
        if blob.len() > self.limits.checkpoint_max_bytes {
            return Err(SpoolError::CheckpointTooLarge(
                self.limits.checkpoint_max_bytes,
            ));
        }
        if self.shared.degraded.load(Ordering::Acquire) {
            return Err(SpoolError::Degraded);
        }
        let message = Message::Checkpoint {
            through_sequence,
            blob,
        };
        match self.sender.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(SpoolError::QueueFull),
            Err(TrySendError::Disconnected(_)) => Err(SpoolError::WriterStopped),
        }
    }

    /// True when the host should hand the writer a checkpoint: a segment is half full or just
    /// rotated, or output arrived and the checkpoint interval elapsed (plan §8.3). The idle
    /// transition, graceful shutdown and `PtyCloseAll` checkpoints are requested by the caller.
    pub fn checkpoint_wanted(&self) -> bool {
        if self.shared.degraded.load(Ordering::Acquire) {
            return false;
        }
        if self.shared.checkpoint_wanted.load(Ordering::Acquire) {
            return true;
        }
        let interval =
            u64::try_from(self.limits.checkpoint_interval.as_millis()).unwrap_or(u64::MAX);
        let since = self
            .shared
            .elapsed_ms()
            .saturating_sub(self.shared.last_checkpoint_ms.load(Ordering::Acquire));
        self.shared.output_since_checkpoint.load(Ordering::Acquire) && since >= interval
    }

    /// Output bytes queued for the writer thread (the host gates PTY reads on it, R7).
    pub fn queued_bytes(&self) -> usize {
        self.shared.queued_bytes.load(Ordering::Acquire)
    }

    pub fn is_degraded(&self) -> bool {
        self.shared.degraded.load(Ordering::Acquire)
    }

    /// Waits until everything queued so far is written and fsynced, or `timeout` passes.
    pub fn flush(&self, timeout: Duration) -> Result<(), SpoolError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Message::Flush(reply))
            .map_err(|_| SpoolError::WriterStopped)?;
        match receiver.recv_timeout(timeout) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(SpoolError::Io(std::io::Error::other(error))),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(SpoolError::QueueFull),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(SpoolError::WriterStopped),
        }
    }

    /// Drops the older segment (host budget pressure). Best effort; a full queue skips it.
    pub(super) fn request_shrink(sender: &SyncSender<Message>) -> bool {
        sender.try_send(Message::Shrink).is_ok()
    }

    /// Stops the thread. `remove = true` deletes the spool (any PTY close, plan §8.3);
    /// `remove = false` flushes and keeps it (graceful host shutdown).
    pub fn close(mut self, remove: bool) -> Result<(), SpoolError> {
        self.stop(remove)
    }

    fn stop(&mut self, remove: bool) -> Result<(), SpoolError> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        // A blocking send is safe: the thread drains the queue until it sees Stop.
        let sent = self.sender.send(Message::Stop { remove }).is_ok();
        let joined = thread.join();
        if let Some(store) = self.store.upgrade() {
            store.unregister(&self.dir_name);
        }
        match joined {
            Ok(Ok(())) if sent => Ok(()),
            Ok(Ok(())) => Err(SpoolError::WriterStopped),
            Ok(Err(error)) => Err(SpoolError::Io(std::io::Error::other(error))),
            Err(_) => Err(SpoolError::WriterStopped),
        }
    }
}

impl Drop for SpoolWriter {
    fn drop(&mut self) {
        if self.stop(false).is_err() {
            // Drop cannot report; the spool stays on disk for the startup sweep.
        }
    }
}
