//! Spool and screen maintenance for one PTY: the read gate on the spool backlog, deferred
//! checkpoints from fence copies, and the fenced rebuild (plan §8.3, §14; R7).

use std::time::{Duration, Instant};

use super::{CHECKPOINT_MAX_DEFER_MS, CHECKPOINT_QUIET_MS, PtyLifecycle, SPOOL_BACKLOG_BYTES};
use crate::terminal_screen::ModelState;
use crate::terminal_spool::SpoolWriter;

impl PtyLifecycle {
    /// Read gate (R7): true once the spool's queue is at most `SPOOL_BACKLOG_BYTES`, waiting
    /// until `deadline`. Pausing the read here throttles the child instead of letting 24
    /// flooding PTYs pile shared chunks into their spool queues (memory high-water) or
    /// overflow them (`spool_degraded`).
    pub(crate) fn output_backlog_ready(&self, deadline: Instant) -> bool {
        loop {
            let backlog = self.spool().as_ref().map_or(0, SpoolWriter::queued_bytes);
            if backlog <= SPOOL_BACKLOG_BYTES {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            std::thread::sleep(remaining.min(Duration::from_millis(1)));
        }
    }

    /// The spool wants a checkpoint and output paused, or the last one is old enough.
    pub(crate) fn checkpoint_due(&self, now: u64) -> bool {
        let wanted = self
            .spool()
            .as_ref()
            .is_some_and(SpoolWriter::checkpoint_wanted);
        if !wanted {
            return false;
        }
        let state = self.lock();
        let quiet = state
            .activity
            .last_output()
            .is_none_or(|at| now.saturating_sub(at) >= CHECKPOINT_QUIET_MS);
        quiet || now.saturating_sub(state.last_checkpoint_ms) >= CHECKPOINT_MAX_DEFER_MS
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
        let now = self.host().now_ms();
        self.lock().last_checkpoint_ms = now;
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
        if let Ok(Some((ticket, (ring, starts_clean)))) = fenced {
            self.advance_epoch();
            if let Err(error) = screen.submit_rebuild(ticket, ring, starts_clean) {
                eprintln!("terminal screen rebuild skipped: {error}");
            }
        }
    }
}
