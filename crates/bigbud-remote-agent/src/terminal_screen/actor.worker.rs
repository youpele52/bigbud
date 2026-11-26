//! The actor thread. The model is only ever touched here, outside the lock; every feed and
//! replay runs under `catch_unwind`, and a panic replaces the model and marks it invalid.

use super::handle::invalidate;
use super::{ActorEvent, Buffered, InvalidReason, Message, ModelState, ScreenModel, Shared};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::Ordering;
use std::time::Instant;

type Events = Box<dyn FnMut(ActorEvent) + Send>;

enum Work {
    Message(Message, ModelState),
    Report(InvalidReason),
}

pub(super) fn run(shared: &Shared, mut model: ScreenModel, mut events: Events) {
    let mut applied = shared.config.start_sequence;
    while let Some(work) = next(shared) {
        match work {
            Work::Report(reason) => emit(&mut events, ActorEvent::ModelInvalid { reason }),
            Work::Message(message, state) => {
                handle(
                    shared,
                    &mut model,
                    &mut applied,
                    &mut events,
                    message,
                    state,
                );
            }
        }
        shared
            .model_bytes
            .store(model.estimated_bytes(), Ordering::Release);
    }
}

/// Runs the owner's event sink; a panic there must not take the actor thread down.
fn emit(events: &mut Events, event: ActorEvent) {
    if catch_unwind(AssertUnwindSafe(|| events(event))).is_err() {
        // The event is lost; the model itself is unaffected, so the actor keeps running.
    }
}

fn next(shared: &Shared) -> Option<Work> {
    let mut inner = shared.lock();
    loop {
        if let Some(reason) = inner.pending_invalid.take() {
            return Some(Work::Report(reason));
        }
        if inner.stopping {
            return None;
        }
        if let Some(message) = inner.queue.pop_front() {
            inner.queued_bytes = inner.queued_bytes.saturating_sub(message.bytes());
            shared.changed.notify_all();
            return Some(Work::Message(message, inner.state));
        }
        inner = shared
            .changed
            .wait(inner)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

fn handle(
    shared: &Shared,
    model: &mut ScreenModel,
    applied: &mut u64,
    events: &mut Events,
    message: Message,
    state: ModelState,
) {
    match message {
        Message::Feed { sequence, bytes } => {
            if state == ModelState::Live && feed(shared, model, events, sequence, &bytes) {
                *applied = sequence;
                shared.applied.store(sequence, Ordering::Release);
            }
        }
        Message::Resize { cols, rows } => {
            // Geometry was validated by the PTY layer; a zero size leaves the model unchanged.
            let _ignored = model.resize(cols, rows);
        }
        Message::Fence(reply) => {
            let result = match state {
                ModelState::Live => Ok(model.copy(*applied)),
                _ => Err(super::FenceError::Invalid),
            };
            // The waiter may have timed out; the copy is simply dropped then.
            let _sent = reply.try_send(result);
        }
        Message::Rebuild {
            ticket,
            ring,
            starts_clean,
        } => rebuild(shared, model, applied, events, ticket, &ring, starts_clean),
        #[cfg(test)]
        Message::Inspect(action) => {
            if catch_unwind(AssertUnwindSafe(|| action(model))).is_err() {
                replace_after_panic(shared, model);
            }
        }
    }
}

/// Applies one chunk; returns false if the feed panicked (the model is then replaced).
fn feed(
    shared: &Shared,
    model: &mut ScreenModel,
    events: &mut Events,
    sequence: u64,
    bytes: &[u8],
) -> bool {
    match catch_unwind(AssertUnwindSafe(|| model.feed(bytes))) {
        Ok(output) => {
            if !output.queries.is_empty() {
                emit(
                    events,
                    ActorEvent::Queries {
                        sequence,
                        queries: output.queries,
                    },
                );
            }
            true
        }
        Err(_) => {
            replace_after_panic(shared, model);
            false
        }
    }
}

fn replace_after_panic(shared: &Shared, model: &mut ScreenModel) {
    let geometry = model.geometry();
    if let Ok(fresh) = ScreenModel::new(geometry.cols, geometry.rows, model.scrollback_capacity()) {
        *model = fresh;
    }
    let mut inner = shared.lock();
    invalidate(&mut inner, shared, InvalidReason::Panic);
}

fn rebuild(
    shared: &Shared,
    model: &mut ScreenModel,
    applied: &mut u64,
    events: &mut Events,
    ticket: u64,
    ring: &[(u64, std::sync::Arc<[u8]>)],
    starts_clean: bool,
) {
    let through = {
        let inner = shared.lock();
        match &inner.rebuild {
            Some(rebuild) if rebuild.ticket == ticket => rebuild.through,
            _ => return,
        }
    };
    let contiguous = ring
        .iter()
        .zip(ring.iter().skip(1))
        .all(|(earlier, later)| later.0 == earlier.0.saturating_add(1));
    let ends_at_through = ring.last().map_or(through == 0, |chunk| chunk.0 == through);
    let geometry = model.geometry();
    let replayed = (contiguous && ends_at_through)
        .then(|| ScreenModel::new(geometry.cols, geometry.rows, model.scrollback_capacity()).ok())
        .flatten()
        .and_then(|mut fresh| {
            let replay = catch_unwind(AssertUnwindSafe(|| {
                for (_, bytes) in ring {
                    // Queries in already-delivered output are never answered after the fact.
                    let _past_queries = fresh.feed(bytes);
                }
            }));
            replay.is_ok().then_some(fresh)
        });
    let buffer = {
        let mut inner = shared.lock();
        let Some(rebuild) = inner.rebuild.take() else {
            return;
        };
        let failure = match (&replayed, rebuild.overflowed) {
            (None, _) => Some(InvalidReason::RebuildRejected),
            (Some(_), true) => Some(InvalidReason::RebuildOverflow),
            (Some(_), false) => None,
        };
        if let Some(reason) = failure {
            inner.retry_at = Some(Instant::now() + shared.config.rebuild_retry);
            invalidate(&mut inner, shared, reason);
            return;
        }
        // Later chunks queue behind the buffer, which is applied before the queue resumes.
        inner.state = ModelState::Live;
        rebuild.buffer
    };
    let Some(mut fresh) = replayed else {
        return;
    };
    if !starts_clean {
        fresh.mark_partial();
    }
    *model = fresh;
    *applied = through;
    shared.applied.store(through, Ordering::Release);
    for item in buffer {
        match item {
            Buffered::Feed(sequence, bytes) => {
                if !feed(shared, model, events, sequence, &bytes) {
                    return;
                }
                *applied = sequence;
                shared.applied.store(sequence, Ordering::Release);
            }
            Buffered::Resize(cols, rows) => {
                let _ignored = model.resize(cols, rows);
            }
        }
    }
    emit(
        events,
        ActorEvent::Rebuilt {
            through_sequence: *applied,
            partial: model.is_partial(),
        },
    );
}
