//! Terminating close (terminal lifecycle R8), matching what node-pty does for a local
//! terminal: the PTY's foreground job and its session get SIGHUP (and SIGCONT, so stopped
//! jobs receive it), then SIGTERM; the master is closed; after `CLOSE_GRACE` whatever is left
//! of the process groups gets SIGKILL. Interactive shells ignore SIGTERM but not SIGHUP, and
//! a child that traps both still ends with the SIGKILL.
//!
//! The PTY's job thread stays the only reaper. A close is complete when the child is reaped;
//! if it is still not reaped a while after the SIGKILL (a zombie or an unreapable process),
//! the outcome is recorded as unknown instead of being reported as closed.

use super::*;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

/// Time between SIGHUP/SIGTERM and the SIGKILL escalation. With the 1 s reap wait the worst
/// case stays under the server's 3 s quit deadline.
pub const CLOSE_GRACE: Duration = Duration::from_millis(1_500);
/// After the SIGKILL, how long a reap may take before the outcome is unknown.
const KILL_SETTLE: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseOutcome {
    /// The child was reaped.
    Reaped,
    /// Not reaped by the deadline (still escalating, or a zombie/unreapable process).
    Unknown,
}

/// Sends `signal` to process group `group` (a foreground job the terminal reported).
#[cfg(unix)]
fn signal_group(group: i32, signal: i32) {
    if group <= 1 {
        return;
    }
    // SAFETY: kill only sends a signal. The group came from this PTY's own terminal
    // (`tcgetpgrp`), so it is one of the PTY session's jobs; ESRCH means it already ended.
    let _sent = unsafe { libc::kill(-group, signal) };
}

impl PtyHandle {
    /// Starts terminating the PTY's processes and returns at once; the SIGKILL escalation
    /// runs on its own short-lived thread. Idempotent.
    #[cfg(unix)]
    pub fn terminate(&self) -> Result<(), PtyError> {
        {
            let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
            state.state = PtyState::Closed;
        }
        if self.inner.terminating.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let foreground = {
            let master = self.inner.master.lock().map_err(|_| poisoned())?;
            master.as_ref().map_or(-1, |master| {
                // SAFETY: tcgetpgrp only reads the terminal's foreground group of an open fd.
                unsafe { libc::tcgetpgrp(master.as_raw_fd()) }
            })
        };
        let leader = i32::try_from(self.pid).unwrap_or(-1);
        let job = (foreground != leader).then_some(foreground);
        for signal in [libc::SIGHUP, libc::SIGCONT, libc::SIGTERM] {
            // The leader's group (on Linux every session member); failures mean it is gone.
            let _sent = self.inner.child.signal(signal);
            if let Some(job) = job {
                signal_group(job, signal);
            }
        }
        // Input stops before the master closes; the reader keeps its own descriptor until
        // the slave side is gone, so no output is lost.
        let input = self.inner.input.shutdown();
        drop(self.inner.master.lock().map_err(|_| poisoned())?.take());
        let inner = Arc::clone(&self.inner);
        let escalation = std::thread::Builder::new()
            .name("pty-close".to_owned())
            .spawn(move || escalate(&inner, job));
        if let Err(error) = escalation {
            // Without the thread, escalate here rather than leave a survivor.
            eprintln!("PTY close escalation thread unavailable: {error}");
            escalate(&self.inner, job);
        }
        input
    }

    #[cfg(not(unix))]
    pub fn terminate(&self) -> Result<(), PtyError> {
        Err(PtyError::Unsupported)
    }

    /// Waits until the child is reaped or `deadline` passes.
    pub fn wait_closed(&self, deadline: Instant) -> CloseOutcome {
        loop {
            if self.child_reaped() {
                return CloseOutcome::Reaped;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return CloseOutcome::Unknown;
            }
            std::thread::sleep(remaining.min(POLL));
        }
    }

    /// The deadline by which a terminating close has either reaped or given up.
    pub fn close_deadline() -> Instant {
        Instant::now() + CLOSE_GRACE + KILL_SETTLE + Duration::from_millis(250)
    }

    /// True when the escalation finished without a reap.
    pub fn close_outcome_unknown(&self) -> bool {
        #[cfg(unix)]
        {
            self.inner.outcome_unknown.load(Ordering::Acquire)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

#[cfg(unix)]
fn escalate(inner: &PtyInner, job: Option<i32>) {
    let reaped = |until: Instant| loop {
        if inner.child.reaped() {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(POLL);
    };
    if reaped(Instant::now() + CLOSE_GRACE) {
        return;
    }
    let _sent = inner.child.signal(libc::SIGKILL);
    if let Some(job) = job {
        signal_group(job, libc::SIGKILL);
    }
    if !reaped(Instant::now() + KILL_SETTLE) {
        inner.outcome_unknown.store(true, Ordering::Release);
    }
}

#[cfg(test)]
#[cfg(unix)]
#[path = "close.tests.rs"]
mod tests;
