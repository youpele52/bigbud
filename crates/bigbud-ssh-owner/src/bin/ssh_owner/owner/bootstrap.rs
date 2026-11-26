//! Owner bootstrap: handshake, fences, target binding and startup bindings.
//!
//! Production starts without a target (W3.7); fixture modes keep the one pinned
//! target and all of their proof bindings. The owner intent, retirement record,
//! attachment capability and generation are established here, before any
//! request is admitted.

use super::super::owner_storage::Storage;
use super::super::{
    RunResult, owner_attachment::Attachment, owner_grants::Grants, owner_grants::budget::Budget,
    owner_trust::TrustApproval, random_token,
};
use super::reconnect::ReconnectAdmission;
use super::retirement::Retirement;
#[cfg(target_os = "linux")]
use super::tracked_push;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::workspace_readiness;
use super::{
    Owner, OwnerStartup, Payload, Pipe, Read, TargetStartup, Write, guarded_write, picker_cancel,
    posix_picker, protocol_error, targets, valid_hello,
};
use crate::transport::Transport;
use targets::Registry as TargetRegistry;

pub(crate) fn bootstrap<R: Read, W: Write>(
    pipe: &mut Pipe<R, W>,
    startup: OwnerStartup<'_>,
) -> RunResult<(Owner, Option<Attachment>)> {
    let OwnerStartup {
        profile,
        startup,
        route_facts,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        profile_lock_path,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        posix_picker,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        workspace_snapshot_cancel,
        attach_path,
        agent_fixture,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        agent_service,
        identity_agent_path,
        stage,
        #[cfg(target_os = "linux")]
        tracked_push,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        opencode_v2,
    } = startup;
    let (target, config, authority) = match startup {
        TargetStartup::Pinned { target, config } => (target, Some(config), None),
        TargetStartup::Unpinned(authority) => {
            // Production starts without a target: a fixture-only binding is a
            // conflict, not a silently ignored option.
            if posix_picker.is_some()
                || workspace_snapshot_cancel.is_some()
                || agent_fixture.is_some()
                || identity_agent_path.is_some()
                || stage.is_some()
            {
                return Err(protocol_error().into());
            }
            #[cfg(target_os = "linux")]
            if tracked_push.is_some() {
                return Err(protocol_error().into());
            }
            (String::new(), None, Some(authority))
        }
    };
    let Some(Payload::Hello(hello)) = pipe.recv()? else {
        return Err(protocol_error().into());
    };
    if !valid_hello(&hello, profile) {
        crate::startup_profile::report_hello_if_production(route_facts.production());
        return Err(protocol_error().into());
    }
    if let Some(config) = config.as_ref() {
        #[cfg(target_os = "macos")]
        posix_picker::fence_residual_leases(profile_lock_path, config, posix_picker.is_some())
            .map_err(|_| protocol_error())?;
        #[cfg(target_os = "linux")]
        posix_picker::fence_linux_password_leases(profile_lock_path, config, posix_picker)
            .map_err(|_| protocol_error())?;
    }
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
    let guarded_write = config.as_ref().and_then(|config| {
        guarded_write::for_startup(
            config,
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
                tracked_push_or_opencode: tracked_push.is_some() || opencode_v2.is_some(),
                #[cfg(target_os = "macos")]
                tracked_push_or_opencode: opencode_v2.is_some(),
                #[cfg(not(any(target_os = "macos", target_os = "linux")))]
                tracked_push_or_opencode: false,
                production: route_facts.production(),
            },
        )
    });
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let (workspace_readiness_fixture, snapshot_only_fixture) =
        config.as_ref().map_or((false, false), |config| {
            workspace_readiness::fixture_selection(
                config,
                profile_lock_path,
                attach_path.is_some(),
                identity_agent_path.is_some(),
                agent_fixture.is_some(),
                stage.is_some(),
                workspace_snapshot_cancel.is_some(),
            )
        });
    #[cfg(target_os = "linux")]
    let tracked_push = tracked_push
        .map(|binding| {
            tracked_push::TrackedPushState::start(
                binding,
                config.as_ref().ok_or_else(protocol_error)?,
                &target,
                generation,
            )
        })
        .transpose()?;
    #[cfg(target_os = "linux")]
    let (mut transport, jump_picker) = match config {
        Some(config) => {
            if !route_facts.production()
                && std::env::var_os("BIGBUD_SSH_OWNER_PICKER_JUMP").as_deref()
                    == Some(std::ffi::OsStr::new("approved-disposable"))
            {
                if posix_picker.is_some()
                    || attach_path.is_some()
                    || agent_fixture.is_some()
                    || identity_agent_path.is_some()
                    || stage.is_some()
                    || tracked_push.is_some()
                    || opencode_v2.is_some()
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
                (Some(transport), Some(picker))
            } else {
                (
                    Some(
                        Transport::new_with_facts(config, &route_facts)
                            .map_err(|_| protocol_error())?,
                    ),
                    None,
                )
            }
        }
        None => (None, None),
    };
    #[cfg(not(target_os = "linux"))]
    let mut transport = match config {
        Some(config) => {
            Some(Transport::new_with_facts(config, &route_facts).map_err(|_| protocol_error())?)
        }
        None => None,
    };
    if let (Some(path), Some(transport)) = (identity_agent_path, transport.as_mut()) {
        transport
            .bind_proof_agent(path)
            .map_err(|_| protocol_error())?;
    }
    #[cfg(target_os = "linux")]
    if workspace_snapshot_cancel.is_some()
        && let Some(transport) = transport.as_ref()
    {
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
    // A pinned fixture target hydrates before HelloAccepted, exactly as before.
    // Production has no target: each target hydrates on its first request.
    // The pinned fixture target's master lane starts with it; every other
    // resolved target starts with empty lanes.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut lanes = super::targets::Lanes::default();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        lanes.master =
            posix_picker.map(|mode| posix_picker::MasterPicker::new(mode, retirement.clone()));
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let lanes = super::targets::Lanes::default();
    let (target, generation, transport, storage, trust, reconnect, lanes, targets) = match transport
    {
        Some(transport) => {
            let storage = Storage::hydrate(pipe, &target)?;
            let mut registry =
                TargetRegistry::with_pinned(target.clone(), generation, transport, storage, lanes);
            let slot = registry.take(&target).map_err(|_| protocol_error())?;
            let (target, generation, transport, storage, trust, reconnect, lanes) =
                slot.into_fields();
            (
                target, generation, transport, storage, trust, reconnect, lanes, registry,
            )
        }
        None => (
            target,
            generation,
            None,
            Storage::unhydrated(),
            TrustApproval::default(),
            ReconnectAdmission::default(),
            lanes,
            TargetRegistry::default(),
        ),
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let owner_state_dir = profile_lock_path.parent().map(std::path::Path::to_path_buf);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let owner_state_dir = None;
    let mut owner = Owner {
        target,
        epoch,
        generation,
        profile: profile.to_vec(),
        owner_state_dir,
        storage,
        reconciliation: None,
        admission_error: crate::v1::ErrorCode::Unspecified,
        retirement: retirement.clone(),
        transport,
        targets,
        production: route_facts.production(),
        authority,
        grants: Grants::new(Budget::for_startup(route_facts.production())),
        trust,
        reconnect,
        lanes,
        #[cfg(target_os = "linux")]
        jump_picker,
        supervised_terminal: false,
        agent_fixture,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        agent_service: agent_service.map(std::sync::Arc::new),
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
        opencode_v2: opencode_v2.map(std::sync::Arc::new),
        #[cfg(target_os = "linux")]
        tracked_push,
    };
    // Production admits only after the owner verified the backend's unresolved
    // retirement mirror and retained pane bindings. The acknowledgement travels
    // in HelloAccepted; a refusal keeps owner-side admission closed.
    if owner.production {
        let ack = super::reconciliation::reconcile(pipe, &owner.epoch, &[])?;
        owner.admission_error = ack.error;
        owner.reconciliation = Some(ack);
    }
    owner.send_accepted(pipe)?;
    Ok((owner, attachment))
}
