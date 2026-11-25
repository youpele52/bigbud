//! Constrained terminal lease. The lease owns the local OpenSSH PTY, not the
//! backend pipe; reconnecting a pipe cannot replace or restart it.

use super::transport::{PinnedSsh, ssh_failure};
use super::v1::ErrorCode;
use bigbud_remote_agent::pty::{
    CloseOutcome, PtyError, PtyEvent, PtyHandle, PtyJob, PtyState, pending_cleanup_settled,
    run_events,
};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[path = "owner_terminal/expiry.rs"]
mod expiry;

const READY: &[u8] = b"BIGBUD_SSH_OWNER_PROOF_PTY_READY";
// Require a remote TTY even if SSH continues after a rejected allocation.
// Bash supplies a timed read on both macOS and Linux. Keep the 60s remote
// budget across lines, and only echo printable lines with a fixed format.
pub(super) const FIXTURE_COMMAND: &str = r#"exec /bin/bash -c '
    test -t 0 && test -t 1 || exit 1
    export LC_ALL=C
    stty -echo -echonl || exit 1
    SECONDS=0
    printf "%s\n" BIGBUD_SSH_OWNER_PROOF_PTY_READY
    printf "BIGBUD_SSH_OWNER_PROOF_PTY_SIZE:%s\n" "$(stty size)"
    while (( SECONDS < 60 )); do
        remaining=$((60 - SECONDS))
        (( remaining > 0 )) || break
        IFS= read -r -t "$remaining" line || break
        case "$line" in *[![:print:]]*) continue ;; esac
        printf "BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:%s\n" "$line"
    done
'"#;
pub(super) const DEV_PROMPT: &str = "BIGBUD_SSH_OWNER_DEV_PTY_READY> ";
pub(super) const DEV_TERM: &str = "xterm-256color";
/// Printed by the resolved login shell wrapper after it enters the requested
/// directory, before it execs the target's own login shell. It is a launch
/// witness, not a fixture command.
pub(super) const LOGIN_READY: &str = "BIGBUD_SSH_OWNER_LOGIN_PTY_READY";
const MAX_LEASE: Duration = Duration::from_secs(75);
const DEV_MAX_LEASE: Duration = Duration::from_secs(30 * 60);
const MAX_INPUT_BYTES: usize = 4 * 1024;
const MAX_COLS: u16 = 400;
const MAX_ROWS: u16 = 200;
// The shared PTY retains at least one full native read batch (64 KiB).
const SAMPLE_CAPACITY: usize = 64 * 1024;
const POLL: Duration = Duration::from_millis(5);
static NEXT_LAUNCH: AtomicU64 = AtomicU64::new(1);

pub(super) struct TerminalStatus {
    pub pid: u32,
    pub live: bool,
    pub sample: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct TerminalReplay {
    pub first_retained_sequence: u64,
    pub next_sequence: u64,
    pub chunks: Vec<(u64, Vec<u8>)>,
    pub gap: bool,
}

#[derive(Clone, Copy)]
pub(super) enum TerminalMode {
    Proof,
    DevInteractive,
    /// A production target's own login shell. Interactive lifetime and ring
    /// retention apply; readiness is the owner's launch witness.
    LoginShell,
}

impl TerminalMode {
    fn interactive(self) -> bool {
        matches!(self, Self::DevInteractive | Self::LoginShell)
    }

    fn ready(self, sample: &[u8]) -> bool {
        sample.split(|&byte| byte == b'\n').any(|line| match self {
            Self::Proof => line
                .strip_prefix(READY)
                .is_some_and(|rest| rest.iter().all(|&byte| byte == b'\r')),
            Self::DevInteractive => {
                // macOS /bin/sh's Readline may enable xterm meta keys before PS1.
                line.strip_prefix(b"\x1b[?1034h").unwrap_or(line) == DEV_PROMPT.as_bytes()
            }
            Self::LoginShell => line.strip_suffix(b"\r").unwrap_or(line) == LOGIN_READY.as_bytes(),
        })
    }
}

pub(super) struct TerminalLease {
    handle: Arc<PtyHandle>,
    reader: Option<JoinHandle<()>>,
    mode: TerminalMode,
}

impl TerminalLease {
    pub(super) fn launch_sized(
        pinned: PinnedSsh,
        ready_deadline: Instant,
        size: (u16, u16),
        mode: TerminalMode,
    ) -> Result<Self, ErrorCode> {
        if Instant::now() >= ready_deadline {
            return Err(ErrorCode::TransportLost);
        }
        let lease = Self::spawn(pinned, size, mode)?;
        // The PTY API does not attest successful exec. Require a live child
        // and the authenticated remote TTY marker rather than a launch receipt.
        if let Err(error) = lease.wait_ready(ready_deadline) {
            lease.revoke()?;
            return Err(error);
        }
        Ok(lease)
    }

    fn spawn(pinned: PinnedSsh, size: (u16, u16), mode: TerminalMode) -> Result<Self, ErrorCode> {
        let (lifetime, term) = match mode {
            TerminalMode::Proof => (MAX_LEASE, "dumb"),
            TerminalMode::DevInteractive | TerminalMode::LoginShell => (DEV_MAX_LEASE, DEV_TERM),
        };
        let program = pinned
            .command
            .get_program()
            .to_str()
            .ok_or(ErrorCode::ConfigUnsupported)?;
        let args = pinned
            .command
            .get_args()
            .map(|arg| arg.to_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or(ErrorCode::ConfigUnsupported)?;
        let launch_id = NEXT_LAUNCH
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let (launch, next_job) = mpsc::sync_channel(1);
        let (done, reader_done) = mpsc::channel::<()>();
        // Start the reaper before spawning the child so worker creation failure
        // cannot leave an already-launched SSH child without a reaper.
        let reader = thread::Builder::new()
            .name("s2-proof-pty-reader".into())
            .spawn(move || {
                if let Ok((job, pin)) = next_job.recv() {
                    read_job(job, pin);
                }
                drop(done);
            })
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let expires_at = Instant::now() + lifetime;
        let job = match PtyHandle::spawn_with_launch(
            format!("s2-proof-pty-{launch_id}"),
            Path::new("/"),
            program,
            &args,
            size,
            &[("LC_ALL".into(), "C".into()), ("TERM".into(), term.into())],
            false,
        ) {
            Ok(job) => job,
            // The shared PTY owner retains failed post-fork setup in its
            // cleanup registry. Do not report a retryable failure until settled.
            Err(_) => return Err(settle_failed_launch()),
        };
        let lease = Self {
            handle: Arc::clone(&job.handle),
            reader: Some(reader),
            mode,
        };
        // Keep the private pin in the reader's ownership until the child exits.
        launch
            .send((job, pinned))
            .map_err(|_| ErrorCode::OutcomeUnknown)?;
        if expiry::start(Arc::clone(&lease.handle), reader_done, expires_at).is_err() {
            lease.revoke()?;
            return Err(ErrorCode::OwnerUnavailable);
        }
        Ok(lease)
    }

    fn wait_ready(&self, deadline: Instant) -> Result<(), ErrorCode> {
        loop {
            let status = self.snapshot()?;
            if status.live
                && self.mode.ready(&status.sample)
                && (!self.mode.interactive() || !self.handle.child_reaped())
            {
                return Ok(());
            }
            if !status.live && self.reader_finished() {
                return Err(ssh_failure(&status.sample));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ErrorCode::TransportLost);
            }
            thread::sleep(remaining.min(POLL));
        }
    }

    pub(super) fn snapshot(&self) -> Result<TerminalStatus, ErrorCode> {
        let state = self
            .handle
            .snapshot()
            .map_err(|_| ErrorCode::TransportLost)?;
        if self.mode.interactive() {
            // Publish exit only after the reaper has drained the final PTY
            // output. Take a single ring cut even while the shell is noisy.
            let live = match state.state {
                PtyState::Running if !self.reader_finished() => true,
                _ if self.handle.child_reaped() => false,
                _ => return Err(ErrorCode::OutcomeUnknown),
            };
            let Some(((), (ring, _))) = self
                .handle
                .rebuild_ring(|_| Some(()))
                .map_err(|_| ErrorCode::TransportLost)?
            else {
                return Err(ErrorCode::TransportLost);
            };
            return Ok(TerminalStatus {
                pid: state.pid,
                live,
                sample: ring
                    .iter()
                    .flat_map(|(_, bytes)| bytes.iter().copied())
                    .collect(),
            });
        }
        let chunks = self
            .handle
            .replay(state.first_retained_sequence - 1)
            .map_err(|_| ErrorCode::TransportLost)?;
        let live = if self.handle.child_reaped() {
            false
        } else if state.state == PtyState::Running && !self.reader_finished() {
            true
        } else {
            // Closed/reader failure alone is not evidence of a reaped child.
            return Err(ErrorCode::OutcomeUnknown);
        };
        Ok(TerminalStatus {
            pid: state.pid,
            live,
            sample: chunks
                .iter()
                .flat_map(|chunk| chunk.bytes.iter().copied())
                .collect(),
        })
    }

    /// Returns retained output after the exclusive cursor, without acknowledging it.
    pub(super) fn replay_proof_terminal(&self, after: u64) -> Result<TerminalReplay, ErrorCode> {
        // The fence and the retained chunks are captured under one native ring
        // lock. Project the shared bytes after unlocking, without chasing writes
        // or consulting a later snapshot for either watermark.
        let (next_sequence, (ring, _starts_clean)) = self
            .handle
            .rebuild_ring(|newest| {
                // `newest` is the native next sequence minus one.
                (after <= newest).then_some(newest + 1)
            })
            .map_err(|_| ErrorCode::TransportLost)?
            .ok_or(ErrorCode::InvalidOperands)?;

        // The ring evicts from the front only. If it is empty, everything
        // produced so far has been evicted (or no output has been produced).
        let first_retained_sequence = ring
            .first()
            .map_or(next_sequence, |(sequence, _)| *sequence);
        let gap = after + 1 < first_retained_sequence;
        let chunks = if gap {
            Vec::new()
        } else {
            ring.into_iter()
                .filter(|(sequence, _)| *sequence > after)
                .map(|(sequence, bytes)| (sequence, bytes.to_vec()))
                .collect()
        };
        Ok(TerminalReplay {
            first_retained_sequence,
            next_sequence,
            chunks,
            gap,
        })
    }

    /// Acknowledges the local PTY write, not consumption by the remote fixture.
    pub(super) fn write_proof_input(&self, sequence: u64, data: &[u8]) -> Result<(), ErrorCode> {
        if sequence == 0 || data.is_empty() || data.len() > MAX_INPUT_BYTES {
            return Err(ErrorCode::InvalidOperands);
        }
        self.require_running()?;
        // Both a newly written sequence and a retained identical receipt are
        // success. The shared ledger decides once, before any bytes are issued.
        self.handle
            .write_input(sequence, data)
            .map(|_newly_written| ())
            .map_err(|error| match error {
                PtyError::InputSequence { .. } | PtyError::InputConflict => {
                    ErrorCode::InvalidOperands
                }
                // Expired or fenced writes cannot be retried under a new sequence.
                _ => ErrorCode::OutcomeUnknown,
            })
    }

    pub(super) fn resize_proof_terminal(&self, cols: u16, rows: u16) -> Result<(), ErrorCode> {
        if !(1..=MAX_COLS).contains(&cols) || !(1..=MAX_ROWS).contains(&rows) {
            return Err(ErrorCode::InvalidOperands);
        }
        self.require_running()?;
        self.handle
            .resize(cols, rows)
            .map_err(|_| ErrorCode::OutcomeUnknown)
    }

    fn require_running(&self) -> Result<(), ErrorCode> {
        if self.handle.child_reaped() {
            return Err(ErrorCode::OperationDenied);
        }
        match self.handle.snapshot() {
            Ok(state) if state.state == PtyState::Running && !self.reader_finished() => Ok(()),
            _ => Err(ErrorCode::OutcomeUnknown),
        }
    }

    pub(super) fn pid(&self) -> u32 {
        self.handle.pid
    }

    pub(super) fn revoke(&self) -> Result<(), ErrorCode> {
        close(&self.handle)
    }

    fn reader_finished(&self) -> bool {
        self.reader.as_ref().is_none_or(JoinHandle::is_finished)
    }
}

fn read_job(PtyJob { handle, reader }: PtyJob, _pin: PinnedSsh) {
    // Configured before the reader can start collecting output. An error leaves
    // the reaper running; snapshot still fails closed on any poisoned ring.
    let _limit = handle.limit_output_retention(SAMPLE_CAPACITY);
    run_events(reader, &handle, |event| match event {
        PtyEvent::Output(bytes) => {
            // Closing the lease can reject late output; it cannot reject reap.
            let _recorded = handle.append_output(bytes);
        }
        PtyEvent::Exited { exit_code, signal } => {
            let _recorded = handle.mark_exited(exit_code, signal);
        }
    });
}

fn settle_failed_launch() -> ErrorCode {
    let deadline = PtyHandle::close_deadline();
    loop {
        if pending_cleanup_settled() {
            return ErrorCode::OwnerUnavailable;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return ErrorCode::OutcomeUnknown;
        }
        thread::sleep(remaining.min(POLL));
    }
}

fn close(handle: &PtyHandle) -> Result<(), ErrorCode> {
    if !handle.child_reaped() {
        // A termination request (even a successful one) is not exit evidence.
        let _requested = handle.terminate();
    }
    match handle.wait_closed(PtyHandle::close_deadline()) {
        CloseOutcome::Reaped => Ok(()),
        CloseOutcome::Unknown => Err(ErrorCode::OutcomeUnknown),
    }
}

impl Drop for TerminalLease {
    fn drop(&mut self) {
        // Drop cannot report uncertainty; explicit revocation does. Never signal
        // a numeric PID here: the PTY handle retains and fences child authority.
        let _cleanup = self.revoke();
        if self.reader_finished()
            && let Some(reader) = self.reader.take()
        {
            let _joined = reader.join();
        }
    }
}

#[cfg(test)]
#[path = "owner_terminal/tests.rs"]
mod tests;
