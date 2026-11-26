//! Disposable POSIX SSH fixture. One slot per target, serialized by its
//! owner. Neither the socket path nor a generic mux client escapes the slot.
//! Local invalidation uses a retained Child. Recovery primitives require the
//! same live supervisor state; startup does not yet attach to that state.

#![cfg(any(target_os = "macos", target_os = "linux"))]

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod cancellable;
#[cfg(target_os = "linux")]
pub(in crate::transport) mod jump;
#[cfg(target_os = "linux")]
pub(crate) use jump::maybe_observe_key;
mod launch;
mod lease;
mod link;
mod master;
#[cfg(any(test, target_os = "linux"))]
mod password;
#[cfg(target_os = "linux")]
pub(in super::super) use password::maybe_run_password_helper;
mod paths;
mod probe;
mod production;
pub(in super::super) use production::validate_production_image;
mod recovery;
mod session;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use session::agent::open as open_agent_session;
pub(crate) use session::agent::{AgentIo, RemoteExit, read_exit};

use link::{Binding, LinkMode, TrustRead};
use master::Master;

use super::{ErrorCode, Folders, HostKey, PinnedSsh, Transport, TransportConfig, trust_store};
use crate::Token;
#[cfg(test)]
use launch::master_command;
#[cfg(test)]
use launch::validate_fixture;

use paths::{PrivatePaths, Stamp};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const SSH: &str = "/usr/bin/ssh";
const READY_LIMIT: Duration = Duration::from_secs(10);
const CHECK_LIMIT: Duration = Duration::from_millis(500);
const REAP_LIMIT: Duration = Duration::from_millis(500);
const TICK: Duration = Duration::from_millis(5);
const LOST: ErrorCode = ErrorCode::TransportLost;
const UNAVAILABLE: ErrorCode = ErrorCode::OwnerUnavailable;
const CANCELLED: ErrorCode = ErrorCode::ListCancelled;
type Cancel<'a> = Option<&'a dyn Fn() -> bool>;

fn checkpoint(cancel: Cancel<'_>) -> Result<(), ErrorCode> {
    if cancel.is_some_and(|is_cancelled| is_cancelled()) {
        Err(CANCELLED)
    } else {
        Ok(())
    }
}

#[derive(Default)]
pub(in super::super) struct PosixMasterSlot {
    master: Option<Master>,
    retirement: Option<crate::owner::retirement::Retirement>,
}

impl PosixMasterSlot {
    pub(in super::super) fn new(retirement: Option<crate::owner::retirement::Retirement>) -> Self {
        Self {
            master: None,
            retirement,
        }
    }

    #[cfg(test)]
    pub(in super::super) fn has_live_master(&self) -> bool {
        self.master.is_some()
    }

    #[cfg(test)]
    pub(in super::super) fn test_live_pid(&mut self) -> Option<u32> {
        self.master
            .as_mut()
            .and_then(|master| master.live_pid().ok())
    }

    pub(in super::super) fn require_no_residual_lease(root: &Path) -> Result<(), ErrorCode> {
        paths::require_no_residual_lease(root)
    }

    #[cfg(target_os = "linux")]
    pub(in super::super) fn require_no_residual_fixture_entry(
        root: &Path,
    ) -> Result<(), ErrorCode> {
        paths::require_no_residual_fixture_entry(root)
    }

    #[cfg(test)]
    fn open_fixture(&mut self, transport: &Transport, generation: Token) -> Result<(), ErrorCode> {
        let deadline = Instant::now() + READY_LIMIT;
        if self.master.is_some() {
            return self.check(transport, generation);
        }
        self.open_before(transport, generation, deadline, PrivatePaths::new)
    }

    fn open_before(
        &mut self,
        transport: &Transport,
        generation: Token,
        deadline: Instant,
        allocate: impl FnOnce() -> Result<PrivatePaths, ErrorCode>,
    ) -> Result<(), ErrorCode> {
        let ready_by = deadline.min(Instant::now() + READY_LIMIT);
        // A connector policy has no direct launch; its master runs over the
        // owner-launched helper's pipes with `ProxyCommand=-`.
        let via_connector = transport.connector().is_some();
        let mut command = self.prepare_link(
            transport,
            generation,
            allocate,
            &[],
            TrustRead::Default,
            LinkMode {
                forwarded: via_connector,
                production: false,
            },
        )?;
        let master = self.master.as_mut().ok_or(UNAVAILABLE)?;
        let result = (|| {
            if via_connector {
                master.attach_connector(transport, &mut command)?;
            }
            master.spawn(&mut command, ready_by)?;
            master.await_ready(ready_by)?;
            master.binding.revalidate(transport)
        })();
        self.finish_check(generation, result)
    }

    #[cfg(test)]
    fn check(&mut self, transport: &Transport, generation: Token) -> Result<(), ErrorCode> {
        let master = self.admit(transport, generation)?;
        let result = master
            .connect(transport, Instant::now() + CHECK_LIMIT)
            .map(drop);
        self.finish_check(generation, result)
    }

    /// Only for the approved disposable fixture. Establish an absent lease
    /// before opening the fixed picker, but never retry or replace a failed
    /// existing lease. The picker has no independent SSH launch path.
    pub(in super::super) fn open_and_list_folders(
        &mut self,
        transport: &Transport,
        generation: Token,
        path: Option<&str>,
        deadline: Instant,
    ) -> Result<Folders, ErrorCode> {
        let picker = session::Picker::new(path)?;
        if Instant::now() >= deadline {
            return Err(ErrorCode::ListTimedOut);
        }
        if self.master.is_none() {
            let root = transport.config.identity.parent().ok_or(UNAVAILABLE)?;
            self.open_before(transport, generation, deadline, || {
                PrivatePaths::new_in(root)
            })
            .map_err(|error| classify_list_io(error, deadline))?;
        }
        self.list(transport, generation, picker, deadline, false)
    }

    fn list(
        &mut self,
        transport: &Transport,
        generation: Token,
        picker: session::Picker,
        deadline: Instant,
        password: bool,
    ) -> Result<Folders, ErrorCode> {
        let master = self.admit(transport, generation)?;
        if master.binding.password != password {
            return Err(ErrorCode::OperationDenied);
        }
        let result = (|| {
            let stream = master.connect(transport, deadline)?;
            let output = picker.run(&stream, deadline)?;
            master.binding.revalidate(transport)?;
            Ok(output)
        })()
        .map_err(|error| classify_list_io(error, deadline));
        self.finish_check(generation, result)?.folders()
    }

    fn admit(
        &mut self,
        transport: &Transport,
        generation: Token,
    ) -> Result<&mut Master, ErrorCode> {
        let master = self.master.as_mut().ok_or(UNAVAILABLE)?;
        // A stale caller cannot use or close a newer/different target's master.
        if master.binding.generation != generation {
            return Err(ErrorCode::StaleGeneration);
        }
        if !Arc::ptr_eq(&master.binding.scope, &transport.config) {
            return Err(ErrorCode::OperationDenied);
        }
        if master.closing {
            return Err(UNAVAILABLE);
        }
        Ok(master)
    }

    pub(in super::super) fn invalidate(&mut self, generation: Token) -> Result<(), ErrorCode> {
        if let Some(master) = &mut self.master {
            if master.binding.generation != generation {
                return Err(ErrorCode::StaleGeneration);
            }
            // Close admission before any potentially failing cleanup. Uncertain
            // cleanup retains this slot and blocks a replacement.
            master.closing = true;
            master.reap()?;
            master.paths.remove(master.socket)?;
            self.master = None;
        }
        Ok(())
    }

    fn finish_check<T>(
        &mut self,
        generation: Token,
        result: Result<T, ErrorCode>,
    ) -> Result<T, ErrorCode> {
        if result.is_err() {
            self.invalidate(generation)?;
        }
        result
    }
}

impl Drop for PosixMasterSlot {
    fn drop(&mut self) {
        if let Some(master) = &self.master {
            // Best effort on unwind. Normal owners must use checked invalidation.
            let _cleanup_on_drop = self.invalidate(master.binding.generation);
        }
    }
}

fn classify_list_io(error: ErrorCode, deadline: Instant) -> ErrorCode {
    if error == LOST && Instant::now() >= deadline {
        ErrorCode::ListTimedOut
    } else {
        error
    }
}

fn pause(deadline: Instant) {
    thread::sleep(TICK.min(deadline.saturating_duration_since(Instant::now())));
}
