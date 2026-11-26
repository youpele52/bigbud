//! `ScreenActor`: one thread per PTY owning a [`ScreenModel`] (§9.1 snapshot worker, §14).
//!
//! - The PTY reader calls [`ScreenActor::try_feed`]; it waits at most until its deadline
//!   (50 ms in R5). On timeout the chunk is dropped, the model becomes `invalid`, and output
//!   delivery is unaffected.
//! - [`ScreenActor::snapshot_fenced`] queues a fence behind everything already accepted; the
//!   actor answers with an immutable [`ScreenCopy`] and resumes feeding at once (F1).
//! - Rebuild (§14): [`ScreenActor::begin_rebuild`] records the ring's newest sequence `R`
//!   (call it while holding the ring lock); later chunks go to a bounded rebuild buffer; the
//!   ring up to `R` is replayed by [`ScreenActor::submit_rebuild`], then the buffer, then live
//!   feed resumes. An overflowing buffer leaves the model invalid for 30 s.

use super::copy::ScreenCopy;
use super::model::{DEFAULT_SCROLLBACK_ROWS, ScreenError, ScreenModel};
use super::query::DetectedQuery;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[path = "actor.handle.rs"]
mod handle;
#[path = "actor.worker.rs"]
mod worker;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenActorConfig {
    pub cols: u16,
    pub rows: u16,
    pub scrollback_rows: usize,
    /// The last output sequence already reflected in the model (0 for a new PTY).
    pub start_sequence: u64,
    pub queue_bytes: usize,
    pub queue_messages: usize,
    pub rebuild_buffer_bytes: usize,
    pub rebuild_retry: Duration,
}

impl ScreenActorConfig {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            scrollback_rows: DEFAULT_SCROLLBACK_ROWS,
            start_sequence: 0,
            queue_bytes: 4 * 1024 * 1024,
            queue_messages: 1024,
            rebuild_buffer_bytes: 2 * 1024 * 1024,
            rebuild_retry: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelState {
    Live,
    Rebuilding,
    Invalid,
}

impl ModelState {
    /// The wire value for `PtyScreenSnapshotHeader.model_state` (`cold` is the spool's).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Rebuilding | Self::Invalid => "invalid",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidReason {
    FeedTimeout,
    SequenceGap { expected: u64, actual: u64 },
    Panic,
    RebuildOverflow,
    RebuildRejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActorEvent {
    /// Queries in output chunk `sequence`; R5 replies only up to the cut `C` (§8.9).
    Queries {
        sequence: u64,
        queries: Vec<DetectedQuery>,
    },
    /// The model stopped tracking output (`model_invalid` notice).
    ModelInvalid { reason: InvalidReason },
    /// A rebuild finished; `partial` unless the ring started at a reset boundary.
    Rebuilt {
        through_sequence: u64,
        partial: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedOutcome {
    Queued,
    /// Already applied or covered by the rebuild ring.
    Duplicate,
    /// Held in the rebuild buffer.
    Buffered,
    /// The model is invalid; the chunk was not applied.
    Invalid,
    Stopped,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FenceError {
    #[error("the screen model is invalid")]
    Invalid,
    #[error("the snapshot fence missed its deadline")]
    Timeout,
    #[error("the screen actor has stopped")]
    Stopped,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RebuildError {
    #[error("a rebuild is only possible while the model is invalid")]
    NotInvalid,
    #[error("the next rebuild attempt is allowed in {0:?}")]
    TooSoon(Duration),
    #[error("the rebuild ticket is stale")]
    StaleTicket,
    #[error("the ring ends before sequence {accepted}, which was already fed")]
    RingBehindFeed { accepted: u64 },
    #[error("the screen actor has stopped")]
    Stopped,
}

/// Proof that `begin_rebuild` fenced the live feed at `through_sequence`.
#[derive(Debug, PartialEq, Eq)]
pub struct RebuildTicket {
    id: u64,
    pub through_sequence: u64,
}

pub(crate) type FenceReply = mpsc::SyncSender<Result<ScreenCopy, FenceError>>;

pub(crate) enum Message {
    Feed {
        sequence: u64,
        /// Shared with the PTY's replay ring and spool queue (R7): queued output is not copied.
        bytes: Arc<[u8]>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Fence(FenceReply),
    Rebuild {
        ticket: u64,
        ring: Vec<(u64, Arc<[u8]>)>,
        starts_clean: bool,
    },
    #[cfg(test)]
    Inspect(Box<dyn FnOnce(&mut ScreenModel) + Send>),
}

impl Message {
    fn bytes(&self) -> usize {
        match self {
            Self::Feed { bytes, .. } => bytes.len(),
            _ => 0,
        }
    }
}

pub(crate) enum Buffered {
    Feed(u64, Arc<[u8]>),
    Resize(u16, u16),
}

pub(crate) struct Rebuild {
    ticket: u64,
    through: u64,
    buffer: Vec<Buffered>,
    bytes: usize,
    overflowed: bool,
}

pub(crate) struct Inner {
    queue: VecDeque<Message>,
    queued_bytes: usize,
    state: ModelState,
    stopping: bool,
    /// Highest sequence accepted into the queue or the rebuild buffer.
    accepted: u64,
    rebuild: Option<Rebuild>,
    retry_at: Option<Instant>,
    tickets: u64,
    /// Set by callers; the worker reports it through the event sink on its own thread.
    pending_invalid: Option<InvalidReason>,
}

pub(crate) struct Shared {
    inner: Mutex<Inner>,
    /// Signals the worker (new message, stop) and blocked feeders (space freed).
    changed: Condvar,
    config: ScreenActorConfig,
    applied: AtomicU64,
    model_bytes: AtomicUsize,
}

impl Shared {
    /// The guarded data is plain bookkeeping that stays consistent across a panic (feeds run
    /// outside the lock), so a poisoned lock is recovered rather than propagated.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub struct ScreenActor {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ActorSpawnError {
    #[error(transparent)]
    Screen(#[from] ScreenError),
    #[error("failed to start the screen actor thread: {0}")]
    Thread(#[source] std::io::Error),
}

impl ScreenActor {
    /// Starts the actor thread. `events` runs on that thread and must not block for long.
    pub fn spawn(
        config: ScreenActorConfig,
        events: Box<dyn FnMut(ActorEvent) + Send>,
    ) -> Result<Self, ActorSpawnError> {
        handle::spawn(config, events)
    }
}

impl Drop for ScreenActor {
    fn drop(&mut self) {
        self.stop();
        self.join();
    }
}
