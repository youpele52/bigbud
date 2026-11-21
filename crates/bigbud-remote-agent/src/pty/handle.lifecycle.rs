//! PTY accessors the terminal lifecycle needs (plan §8.5, §8.9, §14): query-responder replies,
//! the foreground probe on the master descriptor, and the fenced ring read for a screen rebuild.

use super::*;
#[cfg(unix)]
use crate::terminal_policy::probe::{ProbeSource, ProcessProbe};

/// The replay ring up to the fenced sequence, oldest first, and whether it starts at the first
/// output chunk (so a rebuild reproduces the whole screen).
pub type RebuildRing = (Vec<(u64, OutputBytes)>, bool);

impl PtyHandle {
    /// Writes a query-responder reply in order with client input. Replies are not client input:
    /// they take no input sequence and never count as activity.
    #[cfg(unix)]
    pub fn write_host_reply(&self, bytes: &[u8]) -> Result<(), PtyError> {
        if self.snapshot()?.state != PtyState::Running {
            return Err(PtyError::InputFenced);
        }
        self.inner.input.submit_reply(bytes)
    }

    #[cfg(not(unix))]
    pub fn write_host_reply(&self, _bytes: &[u8]) -> Result<(), PtyError> {
        Err(PtyError::Unsupported)
    }

    /// The `foreground_program` fact (plan §8.5), or `None` once the master is closed.
    #[cfg(unix)]
    pub fn foreground_program<S: ProbeSource>(&self, probe: &ProcessProbe<S>) -> Option<bool> {
        let master = self.inner.master.lock().ok()?;
        let fd = master.as_ref()?.as_raw_fd();
        // The probe only issues read-only queries on the descriptor, which the lock keeps open.
        Some(probe.foreground_program(fd, i32::try_from(self.pid).ok()?))
    }

    /// Runs `fence` with the ring's newest sequence while the ring lock is held, so every later
    /// chunk has a higher sequence (§14 step 1), then returns the ring up to that sequence.
    /// `fence` returning `None` skips the copy.
    #[cfg(unix)]
    pub fn rebuild_ring<T>(
        &self,
        fence: impl FnOnce(u64) -> Option<T>,
    ) -> Result<Option<(T, RebuildRing)>, PtyError> {
        let state = self.inner.state.lock().map_err(|_| poisoned())?;
        let newest = state.next_sequence.saturating_sub(1);
        let Some(ticket) = fence(newest) else {
            return Ok(None);
        };
        let ring = state
            .output
            .iter()
            .filter(|chunk| chunk.sequence <= newest)
            .map(|chunk| (chunk.sequence, chunk.bytes.clone()))
            .collect::<Vec<_>>();
        let starts_clean = state.first_retained_sequence <= 1;
        Ok(Some((ticket, (ring, starts_clean))))
    }

    #[cfg(not(unix))]
    pub fn rebuild_ring<T>(
        &self,
        _fence: impl FnOnce(u64) -> Option<T>,
    ) -> Result<Option<(T, RebuildRing)>, PtyError> {
        Err(PtyError::Unsupported)
    }

    /// Lowers (never raises) the replay ring cap. A lifecycle PTY restores from its screen
    /// model; a reattach beyond the ring reports a replay gap and takes a fresh snapshot.
    #[cfg(unix)]
    pub fn limit_output_retention(&self, bytes: usize) -> Result<(), PtyError> {
        let mut state = self.inner.state.lock().map_err(|_| poisoned())?;
        state.retention_bytes = state.retention_bytes.min(bytes.max(READ_CHUNK_BYTES));
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn limit_output_retention(&self, _bytes: usize) -> Result<(), PtyError> {
        Err(PtyError::Unsupported)
    }

    /// Whether the PTY still runs (neither exited nor closed).
    pub fn is_running(&self) -> bool {
        self.snapshot()
            .is_ok_and(|snapshot| snapshot.state == PtyState::Running)
    }
}
