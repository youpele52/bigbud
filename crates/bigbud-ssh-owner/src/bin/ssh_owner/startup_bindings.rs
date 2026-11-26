use std::{ffi::OsString, io, path::PathBuf};

use super::{
    invalid_input,
    owner_agent_proxy::{ProviderKind, ScopedDuplex},
    v1,
};

type AliasConfig = (PathBuf, String);

#[path = "startup_bindings.guards.rs"]
mod guards;
pub(super) use guards::lock_profile;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) use guards::validate_snapshot_fixture;

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ServiceProvider {
    Codex,
    Pi,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum PosixPickerFixture {
    #[default]
    Key,
    #[cfg(target_os = "macos")]
    CancellableRead,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    CancellableMuxRead,
    /// Owner-launched restricted `nc` connector feeding an owned master.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Connector,
    #[cfg(target_os = "linux")]
    SyntheticPassword,
}

#[derive(Default)]
pub(super) struct ProofBindings {
    pub(super) alias_config: Option<AliasConfig>,
    pub(super) route_facts: super::startup_route::ProofRouteFacts,
    pub(super) system_config: Option<PathBuf>,
    pub(super) attach_path: Option<PathBuf>,
    pub(super) workspace_root: Option<PathBuf>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) cancellable_workspace_snapshot: bool,
    pub(super) identity_agent_path: Option<PathBuf>,
    pub(super) dev_interactive_terminal: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) posix_picker: Option<PosixPickerFixture>,
    pub(super) agent_fixture: Option<PathBuf>,
    pub(super) agent_sha256: Option<String>,
    pub(super) installed_agent_state: Option<PathBuf>,
    pub(super) client_relay: Option<v1::ProofClientRelayOpen>,
    pub(super) scoped_duplex: Option<ScopedDuplex>,
    pub(super) stage: Option<(PathBuf, v1::ProofDeploymentStageBegin)>,
    pub(super) provider: Option<(ProviderKind, v1::ProofProviderScope, String)>,
    /// Configured remote provider executable for the product provider service.
    #[cfg(target_os = "linux")]
    pub(super) provider_service: Option<(ServiceProvider, PathBuf)>,
    /// Configured remote OpenCode v2 executable; owner-selected argv and credential.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// `Some(None)`: discover the remote executable on the target.
    pub(super) opencode_v2_service: Option<Option<PathBuf>>,
    #[cfg(target_os = "linux")]
    pub(super) tracked_push: Option<super::owner::TrackedPushStartup>,
}

pub(super) fn trailing_args(mut args: impl Iterator<Item = OsString>) -> io::Result<ProofBindings> {
    let mut bindings = ProofBindings::default();
    while let Some(argument) = args.next() {
        let slot = match argument.to_str() {
            Some("--client-relay-fixture")
                if cfg!(target_os = "linux") && bindings.client_relay.is_none() =>
            {
                let mut text = || {
                    args.next()
                        .and_then(|value| value.into_string().ok())
                        .ok_or_else(invalid_input)
                };
                bindings.client_relay = Some(v1::ProofClientRelayOpen {
                    node_binary: text()?,
                    node_sha256: text()?,
                    helper_entry: text()?,
                    helper_sha256: text()?,
                    authority_id: text()?,
                });
                continue;
            }
            Some(flag @ ("--codex-fixture" | "--pi-fixture"))
                if cfg!(target_os = "linux") && bindings.provider.is_none() =>
            {
                let mut text = || {
                    args.next()
                        .and_then(|value| value.into_string().ok())
                        .ok_or_else(invalid_input)
                };
                let binary = text()?;
                let sha256 = text()?;
                let cwd = text()?;
                let thread_id = text()?;
                let session_epoch = text()?.parse().map_err(|_| invalid_input())?;
                let kind = if flag == "--codex-fixture" {
                    ProviderKind::Codex
                } else {
                    ProviderKind::Pi
                };
                bindings.provider = Some((
                    kind,
                    v1::ProofProviderScope {
                        binary,
                        cwd,
                        thread_id,
                        session_epoch,
                        session_file: None,
                    },
                    sha256,
                ));
                continue;
            }
            Some(
                flag @ ("--paired-peer-fixture"
                | "--git-advertisement-fixture"
                | "--git-upload-fixture"),
            ) if (cfg!(target_os = "linux")
                || (cfg!(target_os = "macos") && flag == "--paired-peer-fixture"))
                && bindings.scoped_duplex.is_none() =>
            {
                let mut text = || {
                    args.next()
                        .and_then(|arg| arg.into_string().ok())
                        .ok_or_else(invalid_input)
                };
                bindings.scoped_duplex = Some(if flag == "--paired-peer-fixture" {
                    ScopedDuplex::Peer(v1::ProofPeerRelayOpen {
                        pairing_id: text()?,
                        grant_id: text()?,
                        worker_authority_id: text()?,
                        host_key_fingerprint: text()?,
                        coordinator_key_fingerprint: text()?,
                    })
                } else if flag == "--git-upload-fixture" {
                    ScopedDuplex::GitUpload(v1::ProofGitUploadOpen {
                        repository_path: text()?,
                    })
                } else {
                    ScopedDuplex::Git(v1::ProofGitAdvertisementOpen {
                        repository_path: text()?,
                        source_ref: text()?,
                        destination_ref: text()?,
                        source_oid: text()?,
                    })
                });
                continue;
            }
            #[cfg(target_os = "linux")]
            Some("--git-tracked-push-fixture") if bindings.tracked_push.is_none() => {
                let root = PathBuf::from(args.next().ok_or_else(invalid_input)?);
                let mut text = || {
                    args.next()
                        .and_then(|arg| arg.into_string().ok())
                        .ok_or_else(invalid_input)
                };
                bindings.tracked_push = Some(super::owner::TrackedPushStartup {
                    root,
                    target_id: text()?,
                    source_oid: text()?,
                    expected_old_oid: text()?,
                });
                continue;
            }
            Some("--deployment-stage-fixture")
                if cfg!(target_os = "linux") && bindings.stage.is_none() =>
            {
                let root = PathBuf::from(args.next().ok_or_else(invalid_input)?);
                let mut text = || {
                    args.next()
                        .and_then(|arg| arg.into_string().ok())
                        .ok_or_else(invalid_input)
                };
                bindings.stage = Some((
                    root,
                    v1::ProofDeploymentStageBegin {
                        request_id: text()?,
                        install_name: text()?,
                        archive_sha256: text()?,
                        manifest_sha256: text()?,
                    },
                ));
                continue;
            }
            #[cfg(target_os = "macos")]
            Some("--posix-picker-master") if bindings.posix_picker.is_none() => {
                bindings.posix_picker = Some(PosixPickerFixture::Key);
                continue;
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Some("--posix-connector-picker") if bindings.posix_picker.is_none() => {
                bindings.posix_picker = Some(PosixPickerFixture::Connector);
                continue;
            }
            #[cfg(target_os = "macos")]
            Some("--posix-cancellable-picker") if bindings.posix_picker.is_none() => {
                bindings.posix_picker = Some(PosixPickerFixture::CancellableRead);
                continue;
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Some("--posix-cancellable-mux-picker") if bindings.posix_picker.is_none() => {
                bindings.posix_picker = Some(PosixPickerFixture::CancellableMuxRead);
                continue;
            }
            #[cfg(target_os = "linux")]
            Some("--posix-synthetic-password-picker") if bindings.posix_picker.is_none() => {
                bindings.posix_picker = Some(PosixPickerFixture::SyntheticPassword);
                continue;
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Some("--posix-cancellable-workspace-snapshot")
                if !bindings.cancellable_workspace_snapshot =>
            {
                bindings.cancellable_workspace_snapshot = true;
                continue;
            }
            Some("--dev-interactive-terminal") => {
                if !cfg!(target_os = "macos") || bindings.dev_interactive_terminal {
                    return Err(invalid_input());
                }
                bindings.dev_interactive_terminal = true;
                continue;
            }
            #[cfg(target_os = "linux")]
            Some("--provider-service") if bindings.provider_service.is_none() => {
                let mut text = || {
                    args.next()
                        .and_then(|value| value.into_string().ok())
                        .ok_or_else(invalid_input)
                };
                let kind = match text()?.as_str() {
                    "codex" => ServiceProvider::Codex,
                    "pi" => ServiceProvider::Pi,
                    _ => return Err(invalid_input()),
                };
                let binary = PathBuf::from(text()?);
                if !binary.is_absolute() {
                    return Err(invalid_input());
                }
                bindings.provider_service = Some((kind, binary));
                continue;
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Some("--opencode-v2-service") if bindings.opencode_v2_service.is_none() => {
                let binary = PathBuf::from(
                    args.next()
                        .and_then(|value| value.into_string().ok())
                        .ok_or_else(invalid_input)?,
                );
                if !binary.is_absolute() {
                    return Err(invalid_input());
                }
                bindings.opencode_v2_service = Some(Some(binary));
                continue;
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Some("--opencode-v2-discover") if bindings.opencode_v2_service.is_none() => {
                bindings.opencode_v2_service = Some(None);
                continue;
            }
            Some("--agent-sha256") if bindings.agent_sha256.is_none() => {
                let hash = args
                    .next()
                    .and_then(|value| value.into_string().ok())
                    .ok_or_else(invalid_input)?;
                if hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(invalid_input());
                }
                bindings.agent_sha256 = Some(hash);
                continue;
            }
            Some("--agent-fixture") => &mut bindings.agent_fixture,
            Some("--installed-agent-state") if cfg!(target_os = "linux") => {
                &mut bindings.installed_agent_state
            }
            Some(
                flag @ ("--fixture-local-account"
                | "--fixture-override-host"
                | "--fixture-override-user"
                | "--fixture-override-port"
                | "--fixture-connector-image"
                | "--fixture-connector-path"),
            ) => {
                bindings.route_facts.parse(flag, &mut args)?;
                continue;
            }
            Some("--system-config") => &mut bindings.system_config,
            Some("--attach-socket") => &mut bindings.attach_path,
            Some("--workspace-root") => &mut bindings.workspace_root,
            Some("--identity-agent-path") => &mut bindings.identity_agent_path,
            _ if bindings.alias_config.is_none()
                && bindings.system_config.is_none()
                && bindings.attach_path.is_none()
                && bindings.workspace_root.is_none() =>
            {
                let path = PathBuf::from(argument);
                let alias = args.next().and_then(|value| value.into_string().ok());
                if !path.is_absolute() {
                    return Err(invalid_input());
                }
                bindings.alias_config = Some((path, alias.ok_or_else(invalid_input)?));
                continue;
            }
            _ => return Err(invalid_input()),
        };
        let path = PathBuf::from(args.next().ok_or_else(invalid_input)?);
        if slot.is_some() || !path.is_absolute() {
            return Err(invalid_input());
        }
        *slot = Some(path);
    }
    if bindings.dev_interactive_terminal && bindings.workspace_root.is_none() {
        return Err(invalid_input());
    }
    Ok(bindings)
}
