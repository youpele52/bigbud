//! Per-PTY lifecycle (plan §7.1, §8.5, §8.9, §14): the screen actor, the scrollback spool, the
//! activity facts and the query responder of one PTY. Only PTYs created by a 1.9 client get
//! one; older clients' PTYs keep today's behavior, and only `lifecycle_managed` PTYs are ever
//! touched by the policy.
//!
//! The PTY reader thread calls [`PtyLifecycle::on_output`] after the session lock is released:
//! the spool append never blocks and the actor feed waits at most 50 ms (§14).

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crate::pty;
use crate::terminal_policy::{ActivityTracker, OwnerHint};
use crate::terminal_screen::{
    ActorEvent, DEFAULT_SCROLLBACK_ROWS, MAX_SCROLLBACK_ROWS, ModelState, ScreenActor,
    ScreenActorConfig,
};
use crate::terminal_spool::{AppendOutcome, SpoolWriter};

use super::pty_lifecycle_host::{HostLifecycle, kind};
use super::pty_lifecycle_responder::Responder;

/// How long the reader may wait for screen-actor queue space. §13 caps the reader's block at
/// 50 ms; 5 ms of the budget is left for the condvar wake-up on a loaded host.
pub(crate) const FEED_DEADLINE: Duration = Duration::from_millis(45);
/// Replay ring of a PTY with a screen model. Restores come from the model and the spool, so
/// the 4 MiB legacy ring would only add 24 x 3.5 MiB to the host RSS (§13: 256 MiB at 24 PTYs).
pub(crate) const SCREEN_RING_BYTES: usize = 256 * 1024;
/// Actor feed queue. At the model's ingest rate a full 1 MiB queue drains well inside the
/// reader's 50 ms bound; a larger one only holds burst copies (24 PTYs x 4 MiB).
const SCREEN_QUEUE_BYTES: usize = 512 * 1024;

/// What the create request asked for.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LifecycleOptions {
    pub managed: bool,
    pub screen_scrollback_rows: usize,
    pub spool: bool,
    pub owner_hint_source: bool,
    pub cols: u16,
    pub rows: u16,
}

impl LifecycleOptions {
    pub(crate) fn scrollback_rows(requested: u32) -> usize {
        match usize::try_from(requested) {
            Ok(0) | Err(_) => DEFAULT_SCROLLBACK_ROWS,
            Ok(rows) => rows.min(MAX_SCROLLBACK_ROWS),
        }
    }
}

pub(crate) struct LifeState {
    pub(crate) activity: ActivityTracker,
    pub(crate) responder: Responder,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    /// Set once the host closed this PTY (idle, pressure, limit, orphan or quit).
    pub(crate) closing: bool,
    pub(crate) exited: bool,
    /// The last `PtyActivity` sent: (idle_busy, pressure_busy, sidebar_busy).
    pub(crate) reported: Option<(bool, bool, bool)>,
    pub(crate) next_probe_at: u64,
}

/// What the actor's event sink needs; never owns the actor, so the actor thread can drop it.
pub(crate) struct PtyShared {
    pub(crate) pty_id: String,
    pub(crate) managed: bool,
    pub(crate) handle: Arc<pty::PtyHandle>,
    pub(crate) host: Arc<HostLifecycle>,
    state: Mutex<LifeState>,
}

impl PtyShared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, LifeState> {
        // Activity facts stay consistent across a panic; recovering keeps the policy running.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn on_screen_event(&self, event: ActorEvent) {
        match event {
            ActorEvent::Queries { sequence, queries } => {
                let mut state = self.lock();
                state
                    .responder
                    .observe(self.handle.as_ref(), sequence, &queries);
            }
            ActorEvent::ModelInvalid { .. } => {
                self.host.notice(&self.pty_id, kind::MODEL_INVALID, 0);
            }
            ActorEvent::Rebuilt { .. } => {}
        }
    }
}

pub(crate) struct PtyLifecycle {
    shared: Arc<PtyShared>,
    screen: Option<ScreenActor>,
    spool: Mutex<Option<SpoolWriter>>,
    scrollback_rows: usize,
}

impl PtyLifecycle {
    pub(crate) fn new(
        handle: Arc<pty::PtyHandle>,
        host: Arc<HostLifecycle>,
        options: LifecycleOptions,
    ) -> Arc<Self> {
        let now = host.now_ms();
        let pty_id = handle.id.clone();
        let shared = Arc::new(PtyShared {
            pty_id: pty_id.clone(),
            managed: options.managed,
            handle,
            host: Arc::clone(&host),
            state: Mutex::new(LifeState {
                activity: ActivityTracker::new(options.managed, now),
                responder: Responder::default(),
                cols: options.cols,
                rows: options.rows,
                closing: false,
                exited: false,
                reported: None,
                next_probe_at: now,
            }),
        });
        if options.owner_hint_source {
            // Direct SSH owners report busy facts; until the first hint, assume busy.
            shared
                .lock()
                .activity
                .set_owner_hint(Some(OwnerHint::Unknown), now);
        }
        let mut config = ScreenActorConfig::new(options.cols, options.rows);
        config.scrollback_rows = options.screen_scrollback_rows;
        config.queue_bytes = SCREEN_QUEUE_BYTES;
        let sink = Arc::clone(&shared);
        let screen = ScreenActor::spawn(config, Box::new(move |event| sink.on_screen_event(event)))
            .map_err(|error| eprintln!("terminal screen unavailable: {error}"))
            .ok();
        if screen.is_some()
            && let Err(error) = shared.handle.limit_output_retention(SCREEN_RING_BYTES)
        {
            eprintln!("terminal replay ring unchanged: {error}");
        }
        // A new PTY reusing a lost id supersedes the lost spool.
        if host.is_lost(&pty_id) {
            host.forget_lost(&pty_id);
            if !options.spool
                && let Some(Err(error)) = host.spool().map(|store| store.remove(&pty_id))
            {
                eprintln!("lost terminal spool left for the sweep: {}", error.code());
            }
        }
        let spool = options
            .spool
            .then(|| host.spool())
            .flatten()
            .and_then(|store| {
                store
                    .writer(&pty_id, now)
                    .map_err(|error| eprintln!("terminal spool unavailable: {}", error.code()))
                    .ok()
            });
        Arc::new(Self {
            shared,
            screen,
            spool: Mutex::new(spool),
            scrollback_rows: options.screen_scrollback_rows,
        })
    }

    pub(crate) fn pty_id(&self) -> &str {
        &self.shared.pty_id
    }

    pub(crate) fn managed(&self) -> bool {
        self.shared.managed
    }

    pub(crate) fn handle(&self) -> &Arc<pty::PtyHandle> {
        &self.shared.handle
    }

    pub(crate) fn host(&self) -> &Arc<HostLifecycle> {
        &self.shared.host
    }

    pub(crate) fn screen(&self) -> Option<&ScreenActor> {
        self.screen.as_ref()
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, LifeState> {
        self.shared.lock()
    }

    fn spool(&self) -> MutexGuard<'_, Option<SpoolWriter>> {
        self.spool.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// One output chunk, in sequence order, on the PTY reader thread (never under the session
    /// lock). Output delivery and the replay ring never depend on the outcome.
    pub(crate) fn on_output(&self, sequence: u64, bytes: Vec<u8>) {
        if let Some(spool) = self.spool().as_ref()
            && spool.append(sequence, &bytes) == AppendOutcome::Degraded
        {
            self.host().notice(self.pty_id(), kind::SPOOL_DEGRADED, 0);
        }
        if let Some(screen) = &self.screen {
            // A timeout invalidates the model; the actor reports `model_invalid` itself.
            let _outcome = screen.try_feed(sequence, bytes, Instant::now() + FEED_DEADLINE);
        }
        let now = self.host().now_ms();
        self.lock().activity.record_output(now);
    }

    /// Accepted client input (never responder replies).
    pub(crate) fn record_input(&self) {
        let now = self.host().now_ms();
        self.lock().activity.record_input(now);
    }

    /// A resize the host applied: queued in stream order and excluded from output activity.
    pub(crate) fn resized(&self, cols: u16, rows: u16) {
        if let Some(screen) = &self.screen
            && !screen.try_resize(cols, rows, Instant::now() + FEED_DEADLINE)
        {
            // The model keeps the old geometry until the next resize; snapshots report it.
        }
        let now = self.host().now_ms();
        let mut state = self.lock();
        state.activity.record_resize_applied(now);
        state.cols = cols;
        state.rows = rows;
    }

    /// The PTY child exited: the spool is deleted (any close, §8.3) and replies stop.
    pub(crate) fn on_exit(&self) {
        if let Some(spool) = self.spool().take()
            && let Err(error) = spool.close(true)
        {
            eprintln!("terminal spool removal deferred to sweep: {}", error.code());
        }
        let mut state = self.lock();
        state.exited = true;
        state.responder.stop();
    }

    pub(crate) fn keep_open(&self) {
        let now = self.host().now_ms();
        self.lock().activity.keep_open(now);
    }

    pub(crate) fn model_state(&self) -> Option<ModelState> {
        self.screen.as_ref().map(ScreenActor::state)
    }

    /// Checkpoints the spool from a fence copy when the spool wants one, or when `force`.
    pub(crate) fn checkpoint(&self, force: bool, deadline: Instant) {
        let wanted = self
            .spool()
            .as_ref()
            .is_some_and(|spool| force || spool.checkpoint_wanted());
        let Some(screen) = self.screen.as_ref().filter(|_| wanted) else {
            return;
        };
        let Ok(copy) = screen.snapshot_fenced(deadline) else {
            return;
        };
        let through = copy.through_sequence();
        let Ok(blob) = copy.checkpoint(self.scrollback_rows) else {
            return;
        };
        if let Some(spool) = self.spool().as_ref()
            && let Err(error) = spool.checkpoint(through, blob)
        {
            eprintln!("terminal spool checkpoint skipped: {}", error.code());
        }
    }

    /// §14 rebuild: fence the live feed at the ring's newest sequence, then replay the ring.
    pub(crate) fn try_rebuild(&self) {
        let Some(screen) = self
            .screen
            .as_ref()
            .filter(|screen| screen.state() == ModelState::Invalid)
        else {
            return;
        };
        let fenced = self
            .handle()
            .rebuild_ring(|newest| screen.begin_rebuild(newest).ok());
        if let Ok(Some((ticket, (ring, starts_clean)))) = fenced
            && let Err(error) = screen.submit_rebuild(ticket, ring, starts_clean)
        {
            eprintln!("terminal screen rebuild skipped: {error}");
        }
    }

    /// Re-checks `still` under the PTY lock and closes with `terminate = true` (§8.5 close,
    /// §9.1 atomic eviction). Returns whether this call closed the PTY.
    pub(crate) fn close_if(
        &self,
        notice: &str,
        still: impl FnOnce(&ActivityTracker, u64) -> bool,
    ) -> bool {
        let now = self.host().now_ms();
        let mut state = self.lock();
        if state.closing || state.exited || !self.handle().is_running() {
            return false;
        }
        if !still(&state.activity, now) {
            return false;
        }
        if let Err(error) = self.handle().close(true) {
            eprintln!("terminal lifecycle close failed: {error}");
            return false;
        }
        state.closing = true;
        state.responder.stop();
        drop(state);
        self.host().notice(self.pty_id(), notice, 0);
        true
    }

    /// Live, not closing: counts toward the limit and is visible to the policy.
    pub(crate) fn is_live(&self) -> bool {
        let state = self.lock();
        !state.closing && !state.exited && self.handle().is_running()
    }
}

impl Drop for PtyLifecycle {
    fn drop(&mut self) {
        // A retired session's spool was already removed on exit; a still-open one (graceful
        // host shutdown) is kept for the next host's sweep.
        if let Some(spool) = self.spool().take()
            && let Err(error) = spool.close(false)
        {
            eprintln!("terminal spool close failed: {}", error.code());
        }
    }
}
