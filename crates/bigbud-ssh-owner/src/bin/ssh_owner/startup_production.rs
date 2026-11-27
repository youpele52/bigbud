//! Explicit production launch mode for the native SSH owner (W3.7).
//!
//! Production argv names no target:
//!
//! `--production --profile <binding> --state-dir <dir> --ssh <path>
//!  --keyscan <path> [--system-config <path>] [--alias-config <path>]
//!  [--attach-socket <path>] [--workspace-root <path>] [--launcher-lifetime]`
//!
//! `--launcher-lifetime` is required for a non-surviving profile kind
//! (`desktop-dev`) and refused for every surviving one: the launcher passes a
//! socket at FD 3 and the owner retires as soon as that socket reports activity
//! or hang-up, so its life is tied to the launcher's.
//!
//! One owner serves many targets: every target-scoped request carries its own
//! descriptor. The profile and state directory require each other. No target,
//! host, port, user, identity or known-hosts argument is accepted here; those
//! remain fixture-only argv. No fixture flag is accepted, the picker-proof
//! environment is never read, and the profile lock is derived inside the state
//! directory. The OpenSSH image, policy, trust, approval and grant fences remain
//! the same as every other mode.

use super::{
    RunResult, invalid_input,
    owner::TargetAuthority,
    startup_bindings::lock_profile,
    startup_profile::{ProductionProfile, ProfileRefusal, report_startup_refusal},
};
use std::{
    ffi::OsString,
    fs, io,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub(super) struct ProductionBindings {
    pub(super) profile: ProductionProfile,
    pub(super) state_directory: PathBuf,
    pub(super) ssh: PathBuf,
    pub(super) keyscan: PathBuf,
    pub(super) system_config: Option<PathBuf>,
    pub(super) alias_config: Option<PathBuf>,
    pub(super) attach_path: Option<PathBuf>,
    pub(super) workspace_root: Option<PathBuf>,
    /// Bind the launcher-lifetime socket at FD 3 (non-surviving profiles only).
    pub(super) launcher_lifetime: bool,
    /// Owner-selected installed agent for the per-target production proxy.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) agent_service: Option<crate::owner_agent_proxy::ServiceRecipe>,
    /// Owner-selected OpenCode executable; its listener is per target.
    /// Owner-selected OpenCode v2 executable; listener, argv and credential are
    /// per target and per lease.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) opencode_v2: Option<crate::owner_opencode_v2::ProductRecipe>,
}

impl ProductionBindings {
    fn authority(&self) -> TargetAuthority {
        TargetAuthority::new(
            self.ssh.clone(),
            self.keyscan.clone(),
            self.system_config.clone(),
            self.alias_config.clone(),
            self.workspace_root.clone(),
        )
    }
}

struct Parsed {
    profile: Option<String>,
    state_directory: Option<PathBuf>,
    ssh: Option<PathBuf>,
    keyscan: Option<PathBuf>,
    system_config: Option<PathBuf>,
    alias_config: Option<PathBuf>,
    attach_path: Option<PathBuf>,
    workspace_root: Option<PathBuf>,
    agent_binary: Option<PathBuf>,
    agent_sha256: Option<String>,
    agent_state: Option<PathBuf>,
    launcher_lifetime: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// `Some(None)`: discover the remote executable on each target.
    opencode_v2_binary: Option<Option<PathBuf>>,
}

fn parse(mut args: impl Iterator<Item = OsString>) -> Result<ProductionBindings, ProfileRefusal> {
    let mut parsed = Parsed {
        profile: None,
        state_directory: None,
        ssh: None,
        keyscan: None,
        system_config: None,
        alias_config: None,
        attach_path: None,
        workspace_root: None,
        agent_binary: None,
        agent_sha256: None,
        agent_state: None,
        launcher_lifetime: false,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        opencode_v2_binary: None,
    };
    while let Some(argument) = args.next() {
        let Some(flag) = argument.to_str() else {
            return Err(ProfileRefusal::Conflict);
        };
        if !flag.starts_with("--") {
            // Target/host/port/user/identity/known-hosts positionals are
            // fixture-only argv and are a conflict in production mode.
            return Err(ProfileRefusal::Conflict);
        }
        let mut take = || args.next().ok_or(ProfileRefusal::MissingFlag);
        match flag {
            "--profile" if parsed.profile.is_none() => {
                parsed.profile = Some(
                    take()?
                        .into_string()
                        .map_err(|_| ProfileRefusal::MalformedProfile)?,
                );
            }
            "--state-dir" if parsed.state_directory.is_none() => {
                parsed.state_directory = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--ssh" if parsed.ssh.is_none() => {
                parsed.ssh = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--keyscan" if parsed.keyscan.is_none() => {
                parsed.keyscan = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--system-config" if parsed.system_config.is_none() => {
                parsed.system_config = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--alias-config" if parsed.alias_config.is_none() => {
                parsed.alias_config = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--attach-socket" if parsed.attach_path.is_none() => {
                parsed.attach_path = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--launcher-lifetime" if !parsed.launcher_lifetime => {
                parsed.launcher_lifetime = true;
            }
            "--workspace-root" if parsed.workspace_root.is_none() => {
                parsed.workspace_root = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--agent-binary" if parsed.agent_binary.is_none() => {
                parsed.agent_binary = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--agent-sha256" if parsed.agent_sha256.is_none() => {
                parsed.agent_sha256 = Some(
                    take()?
                        .into_string()
                        .map_err(|_| ProfileRefusal::MalformedProfile)?,
                );
            }
            "--agent-state" if parsed.agent_state.is_none() => {
                parsed.agent_state = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            "--opencode-v2-service" if parsed.opencode_v2_binary.is_none() => {
                parsed.opencode_v2_binary = Some(Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                ));
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            "--opencode-v2-discover" if parsed.opencode_v2_binary.is_none() => {
                parsed.opencode_v2_binary = Some(None);
            }
            // Every fixture flag and every unknown flag is a conflict.
            _ => return Err(ProfileRefusal::Conflict),
        }
    }
    let profile = parsed.profile.ok_or(ProfileRefusal::MissingFlag)?;
    let state_directory = parsed.state_directory.ok_or(ProfileRefusal::MissingFlag)?;
    let ssh = parsed.ssh.ok_or(ProfileRefusal::MissingFlag)?;
    let keyscan = parsed.keyscan.ok_or(ProfileRefusal::MissingFlag)?;
    if !state_directory.is_absolute() {
        return Err(ProfileRefusal::StateDirectoryNotCanonical);
    }
    if !ssh.is_absolute() || !keyscan.is_absolute() {
        return Err(ProfileRefusal::MalformedProfile);
    }
    // A system config cannot define a target on its own; descriptors either
    // resolve through an alias scope or carry explicit structured fields.
    if parsed.system_config.is_some() && parsed.alias_config.is_none() {
        return Err(ProfileRefusal::MalformedProfile);
    }
    let profile = ProductionProfile::parse(&profile)?;
    // A non-surviving owner must be tied to its launcher; a surviving one never is.
    if parsed.launcher_lifetime == profile.kind.survives_launcher() {
        return Err(ProfileRefusal::Conflict);
    }
    let state_directory = profile.verify(&state_directory)?;
    for path in [
        parsed.system_config.as_ref(),
        parsed.alias_config.as_ref(),
        parsed.attach_path.as_ref(),
        parsed.workspace_root.as_ref(),
        parsed.agent_binary.as_ref(),
        parsed.agent_state.as_ref(),
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        parsed.opencode_v2_binary.as_ref().and_then(Option::as_ref),
    ]
    .into_iter()
    .flatten()
    {
        if !path.is_absolute() {
            return Err(ProfileRefusal::MalformedProfile);
        }
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let agent_service = match (
        parsed.agent_binary.clone(),
        parsed.agent_sha256.clone(),
        parsed.agent_state.clone(),
    ) {
        (None, None, None) => None,
        (Some(binary), Some(sha256), Some(state)) => Some(
            crate::owner_agent_proxy::ServiceRecipe::new(&binary, &sha256, &state)
                .map_err(|_| ProfileRefusal::MalformedProfile)?,
        ),
        _ => return Err(ProfileRefusal::Conflict),
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let opencode_v2 = match parsed.opencode_v2_binary.clone() {
        None => None,
        // A production owner serves many targets, each with its own remote
        // workspace, so the recipe takes the request's absolute cwd. An explicit
        // workspace root still pins it, as in fixture mode.
        Some(binary) => Some(
            crate::owner_opencode_v2::ProductRecipe::new(
                binary.as_deref(),
                parsed.workspace_root.as_deref(),
            )
            .map_err(|_| ProfileRefusal::MalformedProfile)?,
        ),
    };
    Ok(ProductionBindings {
        profile,
        state_directory,
        ssh,
        keyscan,
        system_config: parsed.system_config,
        alias_config: parsed.alias_config,
        attach_path: parsed.attach_path,
        workspace_root: parsed.workspace_root,
        launcher_lifetime: parsed.launcher_lifetime,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        agent_service,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        opencode_v2,
    })
}

fn ensure_owner_directory(state_directory: &Path) -> io::Result<PathBuf> {
    let directory = state_directory.join("ssh-owner");
    if !directory.exists() {
        fs::DirBuilder::new().mode(0o700).create(&directory)?;
    }
    let metadata = fs::symlink_metadata(&directory)?;
    // SAFETY: geteuid takes no arguments and observes only this process.
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o777 != 0o700 {
        return Err(invalid_input());
    }
    Ok(directory)
}

pub(super) fn run(mut args: impl Iterator<Item = OsString>) -> RunResult<()> {
    let bindings = parse(args.by_ref()).map_err(|refusal| {
        report_startup_refusal(refusal);
        invalid_input()
    })?;
    // Bind FD 3 before any child is spawned, so no child inherits it.
    let lifetime = if bindings.launcher_lifetime {
        Some(super::owner_attachment::LauncherLifetime::bind()?)
    } else {
        None
    };
    let directory = ensure_owner_directory(&bindings.state_directory)?;
    let lock_path = directory.join("owner.lock");
    let _profile_lock = lock_profile(&lock_path)?;
    let route_facts = super::config::RouteFacts::default().with_production();
    let mut pipe = super::owner_pipe::Pipe::new(io::stdin().lock(), io::stdout().lock());
    let startup = super::owner::OwnerStartup {
        profile: &bindings.profile.digest,
        route_facts,
        startup: super::owner::TargetStartup::Unpinned(bindings.authority()),
        profile_lock_path: &lock_path,
        posix_picker: None,
        workspace_snapshot_cancel: None,
        attach_path: bindings.attach_path.as_deref(),
        agent_fixture: None,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        agent_service: bindings.agent_service,
        identity_agent_path: None,
        stage: None,
        #[cfg(target_os = "linux")]
        tracked_push: None,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        opencode_v2: bindings.opencode_v2,
    };
    let (mut owner, attachment) = super::owner::bootstrap(&mut pipe, startup)?;
    owner.supervised_terminal = false;
    let result = owner.serve_primary_session(&mut pipe);
    drop(pipe);
    if owner.shutdown_requested {
        // `owner_shutdown` on the launch pipe: dropping the attachment removes
        // its socket; never wait for another backend.
        drop(attachment);
        return result;
    }
    match attachment {
        Some(attachment) => {
            drop(result);
            attachment.serve(&mut owner, &bindings.profile.digest, lifetime.as_ref())
        }
        None => result,
    }
}

#[cfg(test)]
#[path = "startup_production_tests.rs"]
mod tests;
