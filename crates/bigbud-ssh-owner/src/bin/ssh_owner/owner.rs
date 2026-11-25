mod admission;
mod agent_proxy;
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
pub(crate) use retirement::Retirement;
mod state;
pub(crate) use state::Owner;
mod stage;
mod terminal;
mod tracked_push;
#[cfg(test)]
mod transfer_fixture;
#[cfg(target_os = "linux")]
pub(super) use tracked_push::Startup as TrackedPushStartup;
mod workspace_mode;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod workspace_readiness;
pub(super) use deployment_operation::DeploymentOperation;
use reconnect::ReconnectAdmission;
pub(super) use stage::StageBinding;
use terminal::TerminalPreparation;

use std::{
    io::{Read, Write},
    path::Path,
    time::Instant,
};

use crate::{
    RunResult, Token,
    owner_agent_proxy::AgentProxyFixture,
    owner_attachment::Attachment,
    owner_grants::Grants,
    owner_pipe::{Pipe, protocol_error},
    owner_storage::Storage,
    owner_trust::TrustApproval,
    random_token,
    transport::{Transport, TransportConfig},
    v1::{
        Error, ErrorCode, Hello, HelloAccepted, ProofGrantReply, Reply, Request, frame::Payload,
        reply::Outcome, request::Operation,
    },
};

const MAJOR: u32 = 1;
const MINOR: u32 = 0;

pub(super) struct OwnerStartup<'a> {
    pub(super) profile: &'a [u8],
    pub(super) target: String,
    pub(super) config: TransportConfig,
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

pub(super) fn bootstrap<R: Read, W: Write>(
    pipe: &mut Pipe<R, W>,
    startup: OwnerStartup<'_>,
) -> RunResult<(Owner, Option<Attachment>)> {
    let OwnerStartup {
        profile,
        target,
        config,
        route_facts,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        profile_lock_path,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        posix_picker,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        workspace_snapshot_cancel,
        attach_path,
        agent_fixture,
        identity_agent_path,
        stage,
        #[cfg(target_os = "linux")]
        tracked_push,
        #[cfg(target_os = "linux")]
        opencode_recipe,
        #[cfg(target_os = "linux")]
        opencode_service,
    } = startup;
    let Some(Payload::Hello(hello)) = pipe.recv()? else {
        return Err(protocol_error().into());
    };
    if !valid_hello(&hello, profile) {
        return Err(protocol_error().into());
    }
    #[cfg(target_os = "macos")]
    posix_picker::fence_residual_leases(profile_lock_path, &config, posix_picker.is_some())
        .map_err(|_| protocol_error())?;
    #[cfg(target_os = "linux")]
    posix_picker::fence_linux_password_leases(profile_lock_path, &config, posix_picker)
        .map_err(|_| protocol_error())?;
    let epoch = random_token()?;
    // The owner intent is written before any owned child can spawn. A prior
    // unresolved intent or unverifiable child record refuses admission here.
    #[cfg(target_os = "macos")]
    let disposable = profile_lock_path
        .parent()
        .is_some_and(posix_picker::is_disposable_root);
    #[cfg(target_os = "linux")]
    let disposable = profile_lock_path
        .parent()
        .is_some_and(posix_picker::is_linux_disposable_root);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let retirement = match Retirement::open(profile_lock_path, epoch, disposable) {
        Ok(value) => Some(value),
        Err(code) => {
            crate::owner::retirement::report_refusal(code);
            return Err(protocol_error().into());
        }
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let retirement: Option<Retirement> = None;
    let attachment = match attach_path {
        Some(path) => {
            let capability = hello
                .proof_attachment_capability
                .as_slice()
                .try_into()
                .map_err(|_| protocol_error())?;
            Some(Attachment::bind(path, capability)?)
        }
        None if hello.proof_attachment_capability.is_empty() => None,
        None => return Err(protocol_error().into()),
    };
    let generation = random_token()?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let guarded_write = guarded_write::for_startup(
        &config,
        profile_lock_path,
        generation,
        guarded_write::Blockers {
            agent_fixture: agent_fixture.is_some(),
            identity_agent: identity_agent_path.is_some(),
            stage: stage.is_some(),
            posix_picker: posix_picker.is_some(),
            connector: route_facts.connector().is_some(),
            snapshot_cancel: workspace_snapshot_cancel.is_some(),
            #[cfg(target_os = "linux")]
            tracked_push_or_opencode: tracked_push.is_some()
                || opencode_recipe.is_some()
                || opencode_service.is_some(),
            #[cfg(not(target_os = "linux"))]
            tracked_push_or_opencode: false,
        },
    );
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let (workspace_readiness_fixture, snapshot_only_fixture) =
        workspace_readiness::fixture_selection(
            &config,
            profile_lock_path,
            attach_path.is_some(),
            identity_agent_path.is_some(),
            agent_fixture.is_some(),
            stage.is_some(),
            workspace_snapshot_cancel.is_some(),
        );
    #[cfg(target_os = "linux")]
    let tracked_push = tracked_push
        .map(|binding| tracked_push::TrackedPushState::start(binding, &config, &target, generation))
        .transpose()?;
    #[cfg(target_os = "linux")]
    let (mut transport, jump_picker) = if std::env::var_os("BIGBUD_SSH_OWNER_PICKER_JUMP")
        .as_deref()
        == Some(std::ffi::OsStr::new("approved-disposable"))
    {
        if posix_picker.is_some()
            || attach_path.is_some()
            || agent_fixture.is_some()
            || identity_agent_path.is_some()
            || stage.is_some()
            || tracked_push.is_some()
            || opencode_recipe.is_some()
            || opencode_service.is_some()
            || guarded_write.is_some()
        {
            return Err(protocol_error().into());
        }
        let (transport, picker) = crate::transport::jump_binding::JumpPicker::bind(
            config,
            profile_lock_path,
            &route_facts,
            retirement.clone(),
        )
        .map_err(|_| protocol_error())?;
        (transport, Some(picker))
    } else {
        (
            Transport::new_with_facts(config, &route_facts).map_err(|_| protocol_error())?,
            None,
        )
    };
    #[cfg(not(target_os = "linux"))]
    let mut transport =
        Transport::new_with_facts(config, &route_facts).map_err(|_| protocol_error())?;
    if let Some(path) = identity_agent_path {
        transport
            .bind_proof_agent(path)
            .map_err(|_| protocol_error())?;
    }
    #[cfg(target_os = "linux")]
    if workspace_snapshot_cancel.is_some() {
        transport
            .require_snapshot_fixture_image()
            .map_err(|_| protocol_error())?;
    }
    #[cfg(target_os = "linux")]
    let picker_cancel = match posix_picker {
        Some(crate::startup_bindings::PosixPickerFixture::CancellableMuxRead) => {
            Some(picker_cancel::CancelInbox::bind()?)
        }
        _ => None,
    };
    #[cfg(target_os = "macos")]
    let (posix_picker, picker_cancel) = match posix_picker {
        Some(crate::startup_bindings::PosixPickerFixture::CancellableRead) => {
            (None, Some(picker_cancel::CancelInbox::bind()?))
        }
        mode @ Some(crate::startup_bindings::PosixPickerFixture::CancellableMuxRead) => {
            (mode, Some(picker_cancel::CancelInbox::bind()?))
        }
        mode => (mode, None),
    };
    let storage = Storage::hydrate(pipe, &target)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let peer_state_dir = profile_lock_path.parent().map(std::path::Path::to_path_buf);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let peer_state_dir = None;
    let owner = Owner {
        target,
        epoch,
        generation,
        profile: profile.to_vec(),
        peer_state_dir,
        storage,
        retirement: retirement.clone(),
        transport,
        grants: Grants::new(crate::owner_grants::budget::Budget::from_startup_env()),
        trust: TrustApproval::default(),
        reconnect: ReconnectAdmission::default(),
        #[cfg(target_os = "linux")]
        jump_picker,
        terminal: None,
        supervised_terminal: false,
        preparation: None,
        terminal_uncertain: false,
        agent_fixture,
        agent_proxy: None,
        agent_close_uncertain: false,
        agent_actions: Default::default(),
        stage,
        deployment_operation: None,
        guarded_write,
        workspace_mode_observation: None,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        workspace_readiness_fixture,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        picker_cancel,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        workspace_snapshot_cancel,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        snapshot_only_fixture,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        picker_master: posix_picker
            .map(|mode| posix_picker::MasterPicker::new(mode, retirement.clone())),
        #[cfg(target_os = "linux")]
        opencode_recipe: opencode_recipe.map(std::sync::Arc::new),
        #[cfg(target_os = "linux")]
        opencode_service: opencode_service.map(std::sync::Arc::new),
        #[cfg(target_os = "linux")]
        opencode_lease: None,
        #[cfg(target_os = "linux")]
        tracked_push,
    };
    owner.send_accepted(pipe)?;
    Ok((owner, attachment))
}

pub(super) fn valid_hello(hello: &Hello, profile: &[u8]) -> bool {
    // Exact compatibility for the fixture-only proof messages.
    hello.major == MAJOR && hello.minor == MINOR && hello.profile_binding == profile
}

impl Owner {
    pub(super) fn retire_for_launcher(&mut self) -> RunResult<()> {
        self.revoke_network_leases()
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
        self.preparation = None;
        self.workspace_mode_observation = None;
    }

    pub(super) fn rebind<R: Read, W: Write>(&mut self, pipe: &mut Pipe<R, W>) -> RunResult<()> {
        self.reset_guarded_write();
        let generation = random_token()?;
        let storage = Storage::hydrate(pipe, &self.target)?;
        if self.terminal_uncertain
            || self.agent_close_uncertain
            || storage.allow_network() == Err(ErrorCode::TargetDisconnected)
        {
            // A previous writer may have committed Disconnect without delivering its reply.
            // Do not acknowledge this new binding until all tracked local transports are gone.
            self.revoke_network_leases().map_err(|_| protocol_error())?;
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(picker) = &mut self.picker_master {
            picker.rebind_generation().map_err(|_| protocol_error())?;
        }
        self.storage = storage;
        self.generation = generation;
        self.reset_guarded_write();
        self.send_accepted(pipe)
    }

    fn send_accepted<R: Read, W: Write>(&self, pipe: &mut Pipe<R, W>) -> RunResult<()> {
        pipe.send(Payload::HelloAccepted(HelloAccepted {
            major: MAJOR,
            minor: MINOR,
            owner_epoch: self.epoch.to_vec(),
            proof_target_generation: self.generation.to_vec(),
            proof_alias_descriptor: self
                .transport
                .alias_descriptor()
                .map_or_else(Vec::new, Vec::from),
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
