//! Caller-side operations. None of them holds the lock while the model works, and every wait
//! is bounded by the caller's deadline.

use super::{
    ActorEvent, ActorSpawnError, Buffered, FeedOutcome, FenceError, Inner, InvalidReason, Message,
    ModelState, Rebuild, RebuildError, RebuildTicket, ScreenActor, ScreenActorConfig, ScreenCopy,
    ScreenModel, Shared, worker,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::Instant;

pub(super) fn spawn(
    config: ScreenActorConfig,
    events: Box<dyn FnMut(ActorEvent) + Send>,
) -> Result<ScreenActor, ActorSpawnError> {
    let model = ScreenModel::new(config.cols, config.rows, config.scrollback_rows)?;
    let shared = Arc::new(Shared {
        inner: Mutex::new(Inner {
            queue: VecDeque::new(),
            queued_bytes: 0,
            state: ModelState::Live,
            stopping: false,
            accepted: config.start_sequence,
            rebuild: None,
            retry_at: None,
            tickets: 0,
            pending_invalid: None,
        }),
        changed: std::sync::Condvar::new(),
        config,
        applied: AtomicU64::new(config.start_sequence),
        model_bytes: AtomicUsize::new(model.estimated_bytes()),
    });
    let state = Arc::clone(&shared);
    let worker = std::thread::Builder::new()
        .name("pty-screen".to_owned())
        .spawn(move || worker::run(&state, model, events))
        .map_err(ActorSpawnError::Thread)?;
    Ok(ScreenActor {
        shared,
        worker: Mutex::new(Some(worker)),
    })
}

impl ScreenActor {
    /// Queues output chunk `sequence`, waiting no later than `deadline` for queue space.
    pub fn try_feed(
        &self,
        sequence: u64,
        bytes: impl Into<Arc<[u8]>>,
        deadline: Instant,
    ) -> FeedOutcome {
        let bytes = bytes.into();
        let shared = &self.shared;
        let mut inner = shared.lock();
        if inner.stopping {
            return FeedOutcome::Stopped;
        }
        if sequence <= inner.accepted {
            return FeedOutcome::Duplicate;
        }
        let expected = inner.accepted + 1;
        inner.accepted = sequence;
        match inner.state {
            ModelState::Invalid => FeedOutcome::Invalid,
            ModelState::Rebuilding if sequence != expected => {
                if let Some(rebuild) = inner.rebuild.as_mut() {
                    rebuild.overflowed = true;
                    rebuild.buffer.clear();
                }
                FeedOutcome::Invalid
            }
            ModelState::Rebuilding => buffer(&mut inner, shared, Buffered::Feed(sequence, bytes)),
            ModelState::Live if sequence != expected => {
                let reason = InvalidReason::SequenceGap {
                    expected,
                    actual: sequence,
                };
                invalidate(&mut inner, shared, reason);
                FeedOutcome::Invalid
            }
            ModelState::Live => {
                let message = Message::Feed { sequence, bytes };
                match enqueue(shared, inner, message, deadline) {
                    Ok(()) => FeedOutcome::Queued,
                    Err(inner) if inner.stopping => FeedOutcome::Stopped,
                    Err(mut inner) => {
                        invalidate(&mut inner, shared, InvalidReason::FeedTimeout);
                        FeedOutcome::Invalid
                    }
                }
            }
        }
    }

    /// Queues a resize in stream order. Returns false if it could not be queued in time.
    pub fn try_resize(&self, cols: u16, rows: u16, deadline: Instant) -> bool {
        let shared = &self.shared;
        let mut inner = shared.lock();
        match inner.state {
            _ if inner.stopping => false,
            ModelState::Rebuilding => {
                let _outcome = buffer(&mut inner, shared, Buffered::Resize(cols, rows));
                true
            }
            _ => enqueue(shared, inner, Message::Resize { cols, rows }, deadline).is_ok(),
        }
    }

    /// Waits (until `deadline`) for a copy that includes every chunk accepted before the call.
    pub fn snapshot_fenced(&self, deadline: Instant) -> Result<ScreenCopy, FenceError> {
        let (reply, response) = mpsc::sync_channel(1);
        {
            let inner = self.shared.lock();
            if inner.stopping {
                return Err(FenceError::Stopped);
            }
            if inner.state == ModelState::Invalid {
                return Err(FenceError::Invalid);
            }
            if enqueue(&self.shared, inner, Message::Fence(reply), deadline).is_err() {
                return Err(FenceError::Timeout);
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match response.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(FenceError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(FenceError::Stopped),
        }
    }

    /// Fences live feed at the ring's newest sequence. Call while holding the ring lock so
    /// every later chunk has a higher sequence and lands in the rebuild buffer.
    pub fn begin_rebuild(&self, newest_ring_sequence: u64) -> Result<RebuildTicket, RebuildError> {
        let mut inner = self.shared.lock();
        if inner.stopping {
            return Err(RebuildError::Stopped);
        }
        if inner.state != ModelState::Invalid {
            return Err(RebuildError::NotInvalid);
        }
        if newest_ring_sequence < inner.accepted {
            // Every chunk is appended to the ring before it is fed, so a ring that ends
            // before the newest fed chunk cannot cover the dropped output.
            return Err(RebuildError::RingBehindFeed {
                accepted: inner.accepted,
            });
        }
        let now = Instant::now();
        if let Some(retry_at) = inner.retry_at.filter(|retry_at| *retry_at > now) {
            return Err(RebuildError::TooSoon(retry_at - now));
        }
        inner.tickets += 1;
        let id = inner.tickets;
        inner.state = ModelState::Rebuilding;
        inner.accepted = newest_ring_sequence;
        inner.rebuild = Some(Rebuild {
            ticket: id,
            through: newest_ring_sequence,
            buffer: Vec::new(),
            bytes: 0,
            overflowed: false,
        });
        Ok(RebuildTicket {
            id,
            through_sequence: newest_ring_sequence,
        })
    }

    /// Replays `ring` (every chunk up to the ticket's sequence, oldest first) on the actor.
    /// `starts_clean` when the ring starts at sequence 1 or at a full-screen reset.
    pub fn submit_rebuild(
        &self,
        ticket: RebuildTicket,
        ring: Vec<(u64, impl Into<Arc<[u8]>>)>,
        starts_clean: bool,
    ) -> Result<(), RebuildError> {
        let ring = ring
            .into_iter()
            .map(|(sequence, bytes)| (sequence, bytes.into()))
            .collect();
        let mut inner = self.shared.lock();
        if inner.stopping {
            return Err(RebuildError::Stopped);
        }
        if inner.rebuild.as_ref().map(|rebuild| rebuild.ticket) != Some(ticket.id) {
            return Err(RebuildError::StaleTicket);
        }
        // The rebuild message bypasses the queue caps: it is the only work while rebuilding.
        inner.queue.push_back(Message::Rebuild {
            ticket: ticket.id,
            ring,
            starts_clean,
        });
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn state(&self) -> ModelState {
        self.shared.lock().state
    }

    /// The last output sequence applied to the model.
    pub fn applied_sequence(&self) -> u64 {
        self.shared.applied.load(Ordering::Acquire)
    }

    /// The model's estimated heap use, refreshed after every message.
    pub fn estimated_bytes(&self) -> usize {
        self.shared.model_bytes.load(Ordering::Acquire)
    }

    /// Stops accepting work; queued fences fail with `Stopped`. Idempotent.
    pub fn stop(&self) {
        let mut inner = self.shared.lock();
        inner.stopping = true;
        inner.queue.clear();
        inner.queued_bytes = 0;
        self.shared.changed.notify_all();
    }

    /// Waits for the actor thread after `stop`. Each message is bounded, so this is too.
    pub fn join(&self) {
        let handle = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(handle) = handle {
            // A panic escaping the worker was already contained; nothing else to recover.
            let _joined = handle.join();
        }
    }

    #[cfg(test)]
    pub(crate) fn inspect(&self, action: Box<dyn FnOnce(&mut ScreenModel) + Send>) {
        let mut inner = self.shared.lock();
        inner.queue.push_back(Message::Inspect(action));
        self.shared.changed.notify_all();
    }
}

/// Waits for room until `deadline`; gives the guard back on failure so callers can react.
fn enqueue<'a>(
    shared: &'a Shared,
    mut inner: MutexGuard<'a, Inner>,
    message: Message,
    deadline: Instant,
) -> Result<(), MutexGuard<'a, Inner>> {
    let bytes = message.bytes();
    loop {
        if inner.stopping {
            return Err(inner);
        }
        let full = inner.queue.len() >= shared.config.queue_messages
            || (inner.queued_bytes > 0 && inner.queued_bytes + bytes > shared.config.queue_bytes);
        if !full {
            inner.queued_bytes += bytes;
            inner.queue.push_back(message);
            shared.changed.notify_all();
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(inner);
        }
        inner = shared
            .changed
            .wait_timeout(inner, remaining)
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0;
    }
}

fn buffer(inner: &mut Inner, shared: &Shared, item: Buffered) -> FeedOutcome {
    let Some(rebuild) = inner.rebuild.as_mut() else {
        return FeedOutcome::Invalid;
    };
    let bytes = match &item {
        Buffered::Feed(_, bytes) => bytes.len(),
        Buffered::Resize(..) => 0,
    };
    if rebuild.overflowed || rebuild.bytes + bytes > shared.config.rebuild_buffer_bytes {
        rebuild.overflowed = true;
        rebuild.buffer.clear();
        return FeedOutcome::Invalid;
    }
    rebuild.bytes += bytes;
    rebuild.buffer.push(item);
    FeedOutcome::Buffered
}

/// Marks the model invalid, failing queued fences and dropping queued feeds.
pub(super) fn invalidate(inner: &mut Inner, shared: &Shared, reason: InvalidReason) {
    inner.state = ModelState::Invalid;
    inner.rebuild = None;
    for message in inner.queue.drain(..) {
        if let Message::Fence(reply) = message {
            // The waiter may have timed out already; nothing else depends on delivery.
            let _sent = reply.try_send(Err(FenceError::Invalid));
        }
    }
    inner.queued_bytes = 0;
    inner.pending_invalid = Some(reason);
    shared.changed.notify_all();
}
