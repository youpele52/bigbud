//! Known non-detaching helper-closure settlement for an owned group anchor.
//! Settled = the exact unreaped leader has a genuine WNOWAIT exit event AND the
//! group it pins lists no member except that leader. Helpers that detach with
//! setsid/setpgid escape this observation and must be separately qualified; no
//! such helper is admitted by the Stage 1 allow set. Linux/other platforms have
//! no group enumerator here and therefore never settle (fail closed).
use super::{AnchoredGroup, observe_unreaped_child, validate_anchor};
use crate::worker::ExecutionRoot;
use std::{io, process::ExitStatus};

/// Bound on listed members; a full buffer is "members remain", never settled.
pub(super) const MAX_LISTED: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClosureState {
    /// No exit event for the exact leader yet.
    LeaderLive,
    /// Leader exited (still unreaped, pinning the PGID) but members remain.
    MembersRemain,
    /// Only the unreaped leader remains in its pinned group.
    Settled,
}

/// Proof that ONE exact recorded root's known closure settled and its leader
/// was reaped by its sole owner. Not neutral-input or application-effect proof.
#[derive(Debug)]
pub struct SettledRoot {
    root: ExecutionRoot,
    status: ExitStatus,
}
impl SettledRoot {
    pub fn root(&self) -> &ExecutionRoot {
        &self.root
    }
    pub fn status(&self) -> ExitStatus {
        self.status
    }
}

/// Settlement refusal returns the still-unreaped owner; it is never dropped.
pub struct SettleError {
    pub anchor: AnchoredGroup,
    pub error: io::Error,
}
impl std::fmt::Debug for SettleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SettleError")
            .field("root", self.anchor.root())
            .field("error", &self.error)
            .finish()
    }
}

impl AnchoredGroup {
    /// Observation only. Errors are uncertainty, never settlement evidence.
    pub fn closure(&self) -> io::Result<ClosureState> {
        if self.reaped {
            return Err(io::Error::other("anchor already reaped"));
        }
        validate_anchor(&self.identity, std::process::id())?;
        if !observe_unreaped_child(self.identity.pid)? {
            return Ok(ClosureState::LeaderLive);
        }
        let mut members = [0_i32; MAX_LISTED + 1];
        let count = group_members(self.identity.group, &mut members)?;
        let leader = i32::try_from(self.identity.pid.get())
            .map_err(|_| io::Error::other("invalid anchor pid"))?;
        if count > MAX_LISTED {
            return Ok(ClosureState::MembersRemain);
        }
        let listed = members.get(..count).unwrap_or_default();
        // The zombie leader is always listed while we retain it; its absence
        // means the observation is inconsistent, not that the group is empty.
        if !listed.contains(&leader) {
            return Err(io::Error::other("pinned leader missing from group"));
        }
        if count == 1 {
            Ok(ClosureState::Settled)
        } else {
            Ok(ClosureState::MembersRemain)
        }
    }

    /// After a confirmed leader exit, whether any OTHER listed member is still
    /// live (Darwin refuses zombie inspection with ESRCH). Errors propagate.
    pub(super) fn live_members_after_exit(&self) -> io::Result<usize> {
        let mut members = [0_i32; MAX_LISTED + 1];
        let count = group_members(self.identity.group, &mut members)?;
        if count > MAX_LISTED {
            return Ok(count);
        }
        let leader = i32::try_from(self.identity.pid.get())
            .map_err(|_| io::Error::other("invalid anchor pid"))?;
        let mut live = 0;
        for pid in members.get(..count).unwrap_or_default() {
            let Some(pid) = u32::try_from(*pid).ok().and_then(std::num::NonZeroU32::new) else {
                return Err(io::Error::other("invalid group member"));
            };
            if pid.get() == leader.unsigned_abs() {
                continue;
            }
            match super::inspect(pid) {
                Ok(_) => live += 1,
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(live)
    }

    /// Consumes the owner ONLY after a fresh Settled observation, then reaps
    /// exactly its direct Child with WNOHANG. Any refusal returns the owner.
    pub fn settle(mut self) -> Result<SettledRoot, Box<SettleError>> {
        match self.closure() {
            Ok(ClosureState::Settled) => {}
            Ok(state) => {
                let error = io::Error::other(format!("closure not settled: {state:?}"));
                return Err(Box::new(SettleError {
                    anchor: self,
                    error,
                }));
            }
            Err(error) => {
                return Err(Box::new(SettleError {
                    anchor: self,
                    error,
                }));
            }
        }
        match self._child.try_wait() {
            Ok(Some(status)) => {
                self.reaped = true;
                Ok(SettledRoot {
                    root: self.root.clone(),
                    status,
                })
            }
            Ok(None) => Err(Box::new(SettleError {
                anchor: self,
                error: io::Error::other("exit event lost before reap"),
            })),
            Err(error) => Err(Box::new(SettleError {
                anchor: self,
                error,
            })),
        }
    }
}

#[cfg(target_os = "macos")]
fn group_members(group: u32, output: &mut [i32; MAX_LISTED + 1]) -> io::Result<usize> {
    let group = i32::try_from(group).map_err(|_| io::Error::other("invalid group"))?;
    let bytes = i32::try_from(std::mem::size_of_val(output))
        .map_err(|_| io::Error::other("invalid buffer"))?;
    // SAFETY: writable bounded i32 (pid_t) storage of exactly `bytes` length;
    // libproc copies at most that many bytes and retains no pointer. Read-only
    // enumeration of a group we pin; zombies are included by the kernel.
    let listed = unsafe { libc::proc_listpgrppids(group, output.as_mut_ptr().cast(), bytes) };
    // Public libproc returns a PID COUNT here (proc_listpids bytes / sizeof
    // int); its error path yields 0 or -1. Our retained leader makes 0 invalid.
    let count = usize::try_from(listed).map_err(|_| io::Error::last_os_error())?;
    if count == 0 {
        return Err(io::Error::last_os_error());
    }
    if count > output.len() {
        return Err(io::Error::other("invalid group listing"));
    }
    // count == MAX_LISTED + 1 means truncated: members remain beyond our bound.
    Ok(count)
}

#[cfg(not(target_os = "macos"))]
fn group_members(_: u32, _: &mut [i32; MAX_LISTED + 1]) -> io::Result<usize> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "group closure enumeration unavailable",
    ))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn own_group_listing_includes_this_process_and_is_bounded() {
        // SAFETY: getpgrp has no inputs and only reads this process's group.
        let group = unsafe { libc::getpgrp() };
        let mut members = [0_i32; MAX_LISTED + 1];
        let count = group_members(u32::try_from(group).unwrap(), &mut members).unwrap();
        assert!((1..=MAX_LISTED + 1).contains(&count));
        let own = i32::try_from(std::process::id()).unwrap();
        // A full buffer may omit us; otherwise this process must be listed.
        assert!(count > MAX_LISTED || members[..count].contains(&own));
    }
}
