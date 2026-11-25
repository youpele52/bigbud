mod activation;
mod admission;
mod agent_proxy;
mod bootstrap;
mod deployment_operation;
mod dispatch;
mod guarded_write;
mod guarded_write_stage;
#[cfg(all(target_os = "linux", test))]
mod jump_picker_tests;
mod lifecycle;
#[cfg(target_os = "linux")]
mod opencode;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod picker_cancel;
mod session;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) use picker_cancel::CancelInbox as SnapshotCancelInbox;
mod picker_dispatch;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod posix_picker;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) use posix_picker::is_disposable_picker;
#[cfg(all(test, target_os = "macos"))]
mod rebind_tests;
mod reconnect;
pub(crate) mod retirement;
mod state;
pub(crate) use state::Owner;
mod stage;
mod targets;
mod terminal;
mod tracked_push;
#[cfg(test)]
mod transfer_fixture;
#[cfg(target_os = "linux")]
pub(super) use tracked_push::Startup as TrackedPushStartup;
mod workspace_mode;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod workspace_readiness;
pub(crate) use bootstrap::bootstrap;
pub(super) use deployment_operation::DeploymentOperation;
pub(super) use stage::StageBinding;
pub(crate) use targets::{TargetAuthority, TargetStartup};

use std::{
    io::{Read, Write},
    path::Path,
    time::Instant,
};

use crate::{
    RunResult, Token,
    owner_agent_proxy::AgentProxyFixture,
    owner_grants::Grants,
    owner_pipe::{Pipe, protocol_error},
    owner_storage::Storage,
    random_token,
    transport::TransportConfig,
    v1::{
        Error, ErrorCode, Hello, HelloAccepted, ProofGrantReply, Reply, Request, frame::Payload,
        reply::Outcome, request::Operation,
    },
};

const MAJOR: u32 = 1;
const MINOR: u32 = 0;

pub(super) struct OwnerStartup<'a> {
    pub(super) profile: &'a [u8],
    pub(super) startup: TargetStartup,
    pub(super) route_facts: crate::config::RouteFacts,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) profile_lock_path: &'a Path,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) posix_picker: Option<crate::startup_bindings::PosixPickerFixture>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) workspace_snapshot_cancel: Option<SnapshotCancelInbox>,
    pub(super) attach_path: Option<&'a Path>,
    pub(super) agent_fixture: Option<AgentProxyFixture>,
    pub(super) identity_agent_path: Option<&'a Path>,
    pub(super) stage: Option<StageBinding>,
    #[cfg(target_os = "linux")]
    pub(super) opencode_recipe: Option<crate::owner_opencode_v1::Recipe>,
    #[cfg(target_os = "linux")]
    pub(super) opencode_service: Option<crate::owner_opencode_v1::ProductRecipe>,
    #[cfg(target_os = "linux")]
    pub(super) tracked_push: Option<TrackedPushStartup>,
}

pub(super) fn valid_hello(hello: &Hello, profile: &[u8]) -> bool {
    // Exact compatibility for the fixture-only proof messages.
    hello.major == MAJOR && hello.minor == MINOR && hello.profile_binding == profile
}

/// Borrows the active target transport. Only a production owner at rest has
/// none, and it admits no transport operation before binding a target.
pub(super) fn present<T>(slot: &Option<T>) -> Result<&T, ErrorCode> {
    slot.as_ref().ok_or(ErrorCode::OwnerUnavailable)
}

impl Owner {
    pub(super) fn retire_for_launcher(&mut self) -> RunResult<()> {
        self.revoke_all_network_leases()
            .map_err(|_| protocol_error().into())
    }

    /// Only a graceful end clears the owner intent. An unreaped child record
    /// still blocks the next owner.
    fn clear_retirement(&self) {
        if let Some(retirement) = &self.retirement {
            retirement.clear_owner();
        }
    }

    pub(super) fn park(&mut self) {
        self.reset_guarded_write();
        self.grants = Grants::default();
        self.trust.revoke();
        self.lanes.preparation = None;
        self.targets.clear_preparations();
        self.workspace_mode_observation = None;
    }

    pub(super) fn rebind<R: Read, W: Write>(&mut self, pipe: &mut Pipe<R, W>) -> RunResult<()> {
        self.reset_guarded_write();
        let generation = random_token()?;
        // Cached target snapshots are stale after a writer rebind; each target
        // re-hydrates on its next admitted request. The bound target hydrates
        // now, exactly as the single-target owner did.
        self.targets.invalidate_storage();
        let storage = if self.transport.is_some() {
            Storage::hydrate(pipe, &self.target)?
        } else {
            Storage::unhydrated()
        };
        if self.lanes.terminal_uncertain
            || self.lanes.agent_close_uncertain
            || self.targets.has_uncertain_lanes()
            || storage.allow_network() == Err(ErrorCode::TargetDisconnected)
        {
            // A previous writer may have committed Disconnect without delivering its reply.
            // Do not acknowledge this new binding until all tracked local transports are gone.
            self.revoke_all_network_leases()
                .map_err(|_| protocol_error())?;
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(picker) = &mut self.lanes.master {
            picker.rebind_generation().map_err(|_| protocol_error())?;
        }
        self.storage = storage;
        self.generation = generation;
        self.reset_guarded_write();
        self.send_accepted(pipe)
    }

    fn send_accepted<R: Read, W: Write>(&self, pipe: &mut Pipe<R, W>) -> RunResult<()> {
        // A production owner has no pinned target: it reports no generation and
        // each target's generation is learned per request.
        let multi_target = self.targets.pinned().is_none();
        pipe.send(Payload::HelloAccepted(HelloAccepted {
            major: MAJOR,
            minor: MINOR,
            owner_epoch: self.epoch.to_vec(),
            proof_target_generation: if multi_target {
                Vec::new()
            } else {
                self.generation.to_vec()
            },
            proof_alias_descriptor: self
                .transport
                .as_ref()
                .and_then(crate::transport::Transport::alias_descriptor)
                .map_or_else(Vec::new, Vec::from),
            profile_binding: self.profile.clone(),
            multi_target,
        }))
    }

    pub(super) fn serve_primary_session<R: Read, W: Write>(
        &mut self,
        pipe: &mut Pipe<R, W>,
    ) -> RunResult<()> {
        let result = self.serve_session(pipe, |_| Ok(()));
        result.and(
            self.retire_picker_master()
                .map_err(|_| protocol_error().into()),
        )
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        // Children are not signalled here: their own records stay until a
        // verified reap, so an unreaped child still blocks the next owner.
        // This clears only the owner liveness marker on a normal return.
        self.clear_retirement();
    }
}
