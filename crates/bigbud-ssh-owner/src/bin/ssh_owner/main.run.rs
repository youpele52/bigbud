//! Fixture and development launch path (the unchanged proof-gated mode).

use super::*;
use crate::{owner_pipe::Pipe, transport::TransportConfig};
use std::{
    env,
    ffi::{OsStr, OsString},
    net::IpAddr,
};

pub(super) fn run(args: impl Iterator<Item = OsString>) -> RunResult<()> {
    if env::var_os("BIGBUD_SSH_OWNER_PICKER_PROOF").as_deref() != Some(OsStr::new("1")) {
        return Err(invalid_input().into());
    }
    let mut args = args;
    let [
        profile,
        target,
        lock,
        ssh,
        keyscan,
        host,
        port,
        user,
        identity,
        known_hosts,
    ] = args
        .by_ref()
        .take(10)
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| invalid_input())?;
    if !openssh_image::accepts_paths(std::path::Path::new(&ssh), std::path::Path::new(&keyscan)) {
        return Err(invalid_input().into());
    }
    let ProofBindings {
        alias_config,
        route_facts,
        system_config,
        attach_path,
        workspace_root,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        cancellable_workspace_snapshot,
        dev_interactive_terminal,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        posix_picker,
        agent_fixture,
        agent_sha256,
        installed_agent_state,
        client_relay,
        scoped_duplex,
        provider,
        identity_agent_path,
        stage,
        #[cfg(target_os = "linux")]
        provider_service,
        #[cfg(target_os = "linux")]
        opencode_service,
        #[cfg(target_os = "linux")]
        tracked_push,
        #[cfg(target_os = "linux")]
        opencode,
    } = trailing_args(args)?;
    let profile = profile_binding(profile.to_str().ok_or_else(invalid_input)?)?;
    let target = target.into_string().map_err(|_| invalid_input())?;
    let host: IpAddr = host.to_str().ok_or_else(invalid_input)?.parse()?;
    let port: u16 = port.to_str().ok_or_else(invalid_input)?.parse()?;
    let user = user.into_string().map_err(|_| invalid_input())?;
    if !host.is_loopback()
        || port == 0
        || target.is_empty()
        || target.len() > 1024
        || user.is_empty()
    {
        return Err(invalid_input().into());
    }
    #[cfg(target_os = "linux")]
    if provider_service.is_some()
        && (agent_fixture.is_some()
            || provider.is_some()
            || installed_agent_state.is_some()
            || client_relay.is_some()
            || scoped_duplex.is_some()
            || stage.is_some()
            || tracked_push.is_some()
            || opencode.is_some()
            || workspace_root.is_none())
    {
        return Err(invalid_input().into());
    }
    #[cfg(target_os = "linux")]
    if opencode_service.is_some()
        && (agent_fixture.is_some()
            || provider.is_some()
            || installed_agent_state.is_some()
            || client_relay.is_some()
            || scoped_duplex.is_some()
            || stage.is_some()
            || tracked_push.is_some()
            || opencode.is_some()
            || workspace_root.is_none())
    {
        return Err(invalid_input().into());
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let workspace_snapshot_cancel = if cancellable_workspace_snapshot {
        if host != std::net::Ipv4Addr::LOCALHOST
            || port < 1024
            || posix_picker.is_some()
            || attach_path.is_some()
            || system_config.is_some()
            || identity_agent_path.is_some()
            || agent_fixture.is_some()
            || agent_sha256.is_some()
            || installed_agent_state.is_some()
            || client_relay.is_some()
            || scoped_duplex.is_some()
            || provider.is_some()
            || stage.is_some()
        {
            return Err(invalid_input().into());
        }
        startup_bindings::validate_snapshot_fixture(
            std::path::Path::new(&identity),
            std::path::Path::new(&known_hosts),
            std::path::Path::new(&lock),
            workspace_root.as_deref(),
            alias_config.as_ref(),
            dev_interactive_terminal,
        )?;
        Some(owner::SnapshotCancelInbox::bind()?)
    } else {
        None
    };
    let agent_fixture = match (
        agent_fixture,
        agent_sha256,
        installed_agent_state,
        client_relay,
        scoped_duplex,
        provider,
    ) {
        (None, None, None, None, None, None) => None,
        (None, None, None, None, Some(scope), None)
            if attach_path.is_none()
                && alias_config.is_none()
                && system_config.is_none()
                && workspace_root.is_none()
                && identity_agent_path.is_none()
                && !dev_interactive_terminal =>
        {
            // SAFETY: explicit one-shot fixture mode transfers all three descriptors.
            Some(unsafe { owner_agent_proxy::AgentProxyFixture::new_scoped(scope)? })
        }
        (None, None, None, None, None, Some((kind, scope, sha256))) if attach_path.is_none() => {
            if workspace_root.as_deref().and_then(std::path::Path::to_str)
                != Some(scope.cwd.as_str())
            {
                return Err(invalid_input().into());
            }
            // SAFETY: explicit one-shot provider fixture transfers all three descriptors.
            Some(unsafe {
                owner_agent_proxy::AgentProxyFixture::new_provider(kind, scope, sha256)?
            })
        }
        (None, None, None, Some(binding), None, None) if attach_path.is_none() => {
            // SAFETY: explicit one-shot relay launch transfers all three descriptors.
            Some(unsafe { owner_agent_proxy::AgentProxyFixture::new_relay(binding)? })
        }
        (Some(binary), Some(sha256), state, None, None, None) if attach_path.is_none() => {
            // SAFETY: the only launcher for this explicit fixture mode transfers
            // byte pipes on fds 3 through 5. Take them before opening other handles,
            // once, and never inherit them into an unrelated transport.
            Some(unsafe {
                match state {
                    Some(dir) => {
                        owner_agent_proxy::AgentProxyFixture::new_installed(binary, sha256, dir)?
                    }
                    None => owner_agent_proxy::AgentProxyFixture::new(binary, sha256)?,
                }
            })
        }
        _ => return Err(invalid_input().into()),
    };
    #[cfg(target_os = "linux")]
    let agent_fixture = match provider_service {
        None => agent_fixture,
        Some((kind, binary)) => {
            let root = workspace_root.as_deref().ok_or_else(invalid_input)?;
            let kind = match kind {
                startup_bindings::ServiceProvider::Codex => ProviderServiceKind::Codex,
                startup_bindings::ServiceProvider::Pi => ProviderServiceKind::Pi,
            };
            // SAFETY: explicit one-shot provider service mode transfers all three descriptors.
            Some(unsafe {
                owner_agent_proxy::AgentProxyFixture::new_provider_service(kind, &binary, root)?
            })
        }
    };
    let stage = match stage {
        None => None,
        Some((root, approved))
            if agent_fixture.is_none()
                && attach_path.is_none()
                && alias_config.is_none()
                && system_config.is_none()
                && identity_agent_path.is_none()
                && workspace_root.is_none()
                && !dev_interactive_terminal =>
        {
            Some(owner::StageBinding::new(&root, approved).map_err(|_| invalid_input())?)
        }
        _ => return Err(invalid_input().into()),
    };
    #[cfg(target_os = "linux")]
    if tracked_push.is_some()
        && (stage.is_some()
            || agent_fixture.is_some()
            || attach_path.is_some()
            || identity_agent_path.is_some())
    {
        return Err(invalid_input().into());
    }
    #[cfg(target_os = "linux")]
    let opencode_recipe = match opencode {
        None => None,
        Some((scope, sha256))
            if stage.is_none()
                && agent_fixture.is_none()
                && attach_path.is_none()
                && identity_agent_path.is_none()
                && tracked_push.is_none()
                && alias_config.is_none()
                && system_config.is_none()
                && !dev_interactive_terminal
                && workspace_root.as_deref().and_then(std::path::Path::to_str)
                    == Some(scope.cwd.as_str()) =>
        {
            Some(owner_opencode_v1::Recipe::new(scope, sha256)?)
        }
        _ => return Err(invalid_input().into()),
    };
    #[cfg(target_os = "linux")]
    let opencode_service = match opencode_service {
        None => None,
        Some(binary) if workspace_root.is_some() => {
            let root = workspace_root.as_deref().ok_or_else(invalid_input)?;
            Some(owner_opencode_v1::ProductRecipe::new(&binary, root)?)
        }
        Some(_) => return Err(invalid_input().into()),
    };
    let _profile_lock = startup_bindings::lock_profile(std::path::Path::new(&lock))?;
    let transport = TransportConfig {
        ssh: ssh.into(),
        keyscan: keyscan.into(),
        host,
        port,
        user,
        identity: identity.into(),
        known_hosts: known_hosts.into(),
        alias_config,
        system_config,
        workspace_root,
        dev_interactive_terminal,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if posix_picker.is_some_and(|mode| {
        !owner::is_disposable_picker(&transport, mode, attach_path.as_deref())
            || agent_fixture.is_some()
            || stage.is_some()
            || identity_agent_path.is_some()
    }) {
        return Err(invalid_input().into());
    }
    #[cfg(target_os = "linux")]
    if (posix_picker.is_some() || workspace_snapshot_cancel.is_some())
        && (tracked_push.is_some() || opencode_recipe.is_some())
    {
        return Err(invalid_input().into());
    }
    let lifetime = (dev_interactive_terminal && attach_path.is_some())
        .then(owner_attachment::LauncherLifetime::bind)
        .transpose()?;
    let mut pipe = Pipe::new(io::stdin().lock(), io::stdout().lock());
    let (mut owner, attachment) = owner::bootstrap(
        &mut pipe,
        owner::OwnerStartup {
            profile: &profile,
            route_facts: route_facts.bind(&transport)?,
            startup: owner::TargetStartup::Pinned {
                target,
                config: transport,
            },
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            profile_lock_path: std::path::Path::new(&lock),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            posix_picker,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            workspace_snapshot_cancel,
            attach_path: attach_path.as_deref(),
            agent_fixture,
            identity_agent_path: identity_agent_path.as_deref(),
            stage,
            #[cfg(target_os = "linux")]
            tracked_push,
            #[cfg(target_os = "linux")]
            opencode_recipe,
            #[cfg(target_os = "linux")]
            opencode_service,
        },
    )?;
    owner.supervised_terminal = lifetime.is_some();
    let result = owner.serve_primary_session(&mut pipe);
    drop(pipe);
    match attachment {
        // Any inherited-channel failure closes admission on that channel. An
        // established opt-in owner can only resume via authentication + hydrate.
        Some(attachment) => {
            drop(result);
            attachment.serve(&mut owner, &profile, lifetime.as_ref())
        }
        None => result,
    }
}
