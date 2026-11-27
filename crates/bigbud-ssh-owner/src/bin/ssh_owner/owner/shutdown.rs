//! Drain-time owner shutdown (v1.owner_shutdown.proto; Request 194, Reply 108).
//!
//! The drain asks the owner to close every master and lease (confirmed teardown),
//! clear its retirement intent and the profile's durable attach record, and
//! exit. The serving loop ends once `shutdown_requested` is set; the attachment
//! layer then removes the attach socket and the process exits, bounded by
//! [`arm_exit_watchdog`].

use std::{fs, io, path::Path, time::Duration};

use super::{ErrorCode, Outcome, Owner, Pipe, Read, RunResult, Write, protocol_error};
use crate::v1::OwnerShutdownReport;

/// The profile's durable attach record, written beside the owner lock.
pub(crate) const ATTACH_RECORD: &str = "attach.json";

/// Graceful exit budget after a shutdown began; then the process hard-exits.
pub(crate) const EXIT_DEADLINE: Duration = Duration::from_secs(10);

impl Owner {
    /// Tears down every lease and master, then clears the durable intent. A
    /// failed reap keeps the owner (and its fence) alive and reports typed.
    pub(super) fn shutdown_for_drain(&mut self) -> Result<Outcome, ErrorCode> {
        // Only a production owner has a drain; fixtures keep their own lifetimes.
        if !self.production {
            return Err(ErrorCode::OperationDenied);
        }
        let (active_masters, active_leases) = self.lanes.shutdown_counts();
        let (cached_masters, cached_leases) = self.targets.shutdown_counts();
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let peer = self.peer.relays.len();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let peer = 0;
        // Close admission first: nothing is admitted while the teardown runs.
        self.admission_error = ErrorCode::OwnerUnavailable;
        arm_exit_watchdog(EXIT_DEADLINE);
        self.revoke_all_network_leases()?;
        self.clear_retirement();
        let attach_cleared = self
            .owner_state_dir
            .as_deref()
            .is_none_or(|directory| remove_attach_record(directory).is_ok());
        self.shutdown_requested = true;
        Ok(Outcome::OwnerShutdown(OwnerShutdownReport {
            masters_closed: count(active_masters + cached_masters),
            leases_closed: count(active_leases + cached_leases + peer),
            attach_cleared,
        }))
    }
}

impl Owner {
    /// Answers an attach from another artifact with the typed refusal (no
    /// hydration, no admission), then shuts down as for a drain.
    pub(crate) fn refuse_foreign_artifact<R: Read, W: Write>(
        &mut self,
        pipe: &mut Pipe<R, W>,
    ) -> RunResult<()> {
        self.reconciliation = None;
        self.admission_error = ErrorCode::OwnerArtifactMismatch;
        self.send_accepted(pipe)?;
        // A failed teardown keeps this owner (and its fence) running; the
        // refused backend then reports the typed mismatch.
        self.shutdown_for_drain()
            .map(drop)
            .map_err(|_| protocol_error().into())
    }
}

fn count(value: usize) -> u32 {
    // Bounded by the target and lease caps; saturate rather than wrap.
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Removes the attach record only when it is a regular file in the owner's
/// private directory. The owner holds the profile lock, so any record there
/// names this owner. A missing record is already cleared.
pub(crate) fn remove_attach_record(directory: &Path) -> io::Result<()> {
    let path = directory.join(ATTACH_RECORD);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(&path),
        Ok(_) => Err(io::Error::from(io::ErrorKind::InvalidData)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Hard-exit fallback: a detached timer thread ends the process when the
/// graceful path (reply, socket removal, return from main) stalls. Exiting
/// here is the documented bounded-shutdown contract, not error handling.
#[allow(clippy::exit)]
pub(crate) fn arm_exit_watchdog(deadline: Duration) {
    // Unit tests run many owners in one process; never arm a process exit there.
    if cfg!(test) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("owner-exit-watchdog".into())
        .spawn(move || {
            std::thread::sleep(deadline);
            eprintln!("ssh owner shutdown exceeded its exit deadline; exiting");
            std::process::exit(0);
        });
    // Without a watchdog the graceful path still exits; the deadline is only a
    // fallback, so a failed spawn does not block the shutdown.
    if spawned.is_err() {
        eprintln!("ssh owner exit watchdog unavailable");
    }
}

#[cfg(test)]
#[path = "shutdown.tests.rs"]
mod tests;
