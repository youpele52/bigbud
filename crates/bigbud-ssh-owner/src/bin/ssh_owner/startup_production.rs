//! Explicit production launch mode for the native SSH owner (W3.7).
//!
//! Production argv is deliberately small:
//!
//! `--production --profile <binding> --state-dir <dir> <target> <ssh>
//!  <keyscan> <host> <port> <user> <identity> <known-hosts>
//!  [--attach-socket <path>] [--workspace-root <path>]
//!  [--system-config <path>] [--alias-config <path> <alias>]`
//!
//! The profile and state directory require each other. No fixture flag is
//! accepted, the picker-proof environment is never read, and the profile lock
//! is derived inside the state directory. The OpenSSH image, policy, trust,
//! approval and grant fences remain the same as every other mode.

use super::{
    RunResult, invalid_input,
    startup_bindings::lock_profile,
    startup_profile::{ProductionProfile, ProfileRefusal, report_startup_refusal},
    transport::TransportConfig,
};
use std::{
    ffi::OsString,
    fs, io,
    net::IpAddr,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub(super) struct ProductionBindings {
    pub(super) profile: ProductionProfile,
    pub(super) state_directory: PathBuf,
    pub(super) target: String,
    pub(super) ssh: PathBuf,
    pub(super) keyscan: PathBuf,
    pub(super) host: IpAddr,
    pub(super) port: u16,
    pub(super) user: String,
    pub(super) identity: PathBuf,
    pub(super) known_hosts: PathBuf,
    pub(super) system_config: Option<PathBuf>,
    pub(super) alias_config: Option<(PathBuf, String)>,
    pub(super) attach_path: Option<PathBuf>,
    pub(super) workspace_root: Option<PathBuf>,
}

struct Parsed {
    profile: Option<String>,
    state_directory: Option<PathBuf>,
    system_config: Option<PathBuf>,
    alias_config: Option<(PathBuf, String)>,
    attach_path: Option<PathBuf>,
    workspace_root: Option<PathBuf>,
    positionals: Vec<OsString>,
}

fn text(value: OsString) -> io::Result<String> {
    value.into_string().map_err(|_| invalid_input())
}

fn parse(mut args: impl Iterator<Item = OsString>) -> Result<ProductionBindings, ProfileRefusal> {
    let mut parsed = Parsed {
        profile: None,
        state_directory: None,
        system_config: None,
        alias_config: None,
        attach_path: None,
        workspace_root: None,
        positionals: Vec::new(),
    };
    while let Some(argument) = args.next() {
        let Some(flag) = argument.to_str() else {
            parsed.positionals.push(argument);
            continue;
        };
        if !flag.starts_with("--") {
            parsed.positionals.push(argument);
            continue;
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
            "--system-config" if parsed.system_config.is_none() => {
                parsed.system_config = Some(
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
            "--workspace-root" if parsed.workspace_root.is_none() => {
                parsed.workspace_root = Some(
                    take()
                        .map(PathBuf::from)
                        .map_err(|_| ProfileRefusal::MissingFlag)?,
                );
            }
            "--alias-config" if parsed.alias_config.is_none() => {
                let path = take()
                    .map(PathBuf::from)
                    .map_err(|_| ProfileRefusal::MissingFlag)?;
                let alias = take()?
                    .into_string()
                    .map_err(|_| ProfileRefusal::MalformedProfile)?;
                parsed.alias_config = Some((path, alias));
            }
            // Every fixture flag and every unknown flag is a conflict.
            _ => return Err(ProfileRefusal::Conflict),
        }
    }
    let profile = parsed.profile.ok_or(ProfileRefusal::MissingFlag)?;
    let state_directory = parsed.state_directory.ok_or(ProfileRefusal::MissingFlag)?;
    if !state_directory.is_absolute() {
        return Err(ProfileRefusal::StateDirectoryNotCanonical);
    }
    let profile = ProductionProfile::parse(&profile)?;
    let state_directory = profile.verify(&state_directory)?;
    for path in [
        parsed.system_config.as_ref(),
        parsed.alias_config.as_ref().map(|(path, _)| path),
        parsed.attach_path.as_ref(),
        parsed.workspace_root.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if !path.is_absolute() {
            return Err(ProfileRefusal::MalformedProfile);
        }
    }
    let [
        target,
        ssh,
        keyscan,
        host,
        port,
        user,
        identity,
        known_hosts,
    ]: [OsString; 8] = parsed
        .positionals
        .try_into()
        .map_err(|_| ProfileRefusal::MissingFlag)?;
    let target = target
        .into_string()
        .map_err(|_| ProfileRefusal::MalformedProfile)?;
    let user = user
        .into_string()
        .map_err(|_| ProfileRefusal::MalformedProfile)?;
    let host = text(host)
        .map_err(|_| ProfileRefusal::MalformedProfile)?
        .parse::<IpAddr>()
        .map_err(|_| ProfileRefusal::MalformedProfile)?;
    let port = text(port)
        .map_err(|_| ProfileRefusal::MalformedProfile)?
        .parse::<u16>()
        .map_err(|_| ProfileRefusal::MalformedProfile)?;
    if target.is_empty()
        || target.len() > 1024
        || port == 0
        || user.is_empty()
        || user.len() > 64
        || !user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        || host.is_unspecified()
    {
        return Err(ProfileRefusal::MalformedProfile);
    }
    Ok(ProductionBindings {
        profile,
        state_directory,
        target,
        ssh: PathBuf::from(ssh),
        keyscan: PathBuf::from(keyscan),
        host,
        port,
        user,
        identity: PathBuf::from(identity),
        known_hosts: PathBuf::from(known_hosts),
        system_config: parsed.system_config,
        alias_config: parsed.alias_config,
        attach_path: parsed.attach_path,
        workspace_root: parsed.workspace_root,
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
    let directory = ensure_owner_directory(&bindings.state_directory)?;
    let lock_path = directory.join("owner.lock");
    let _profile_lock = lock_profile(&lock_path)?;
    let route_facts = super::config::RouteFacts::default().with_production();
    let transport = TransportConfig {
        ssh: bindings.ssh,
        keyscan: bindings.keyscan,
        host: bindings.host,
        port: bindings.port,
        user: bindings.user,
        identity: bindings.identity,
        known_hosts: bindings.known_hosts,
        alias_config: bindings.alias_config,
        system_config: bindings.system_config,
        workspace_root: bindings.workspace_root,
        dev_interactive_terminal: false,
    };
    let mut pipe = super::owner_pipe::Pipe::new(io::stdin().lock(), io::stdout().lock());
    let startup = super::owner::OwnerStartup {
        profile: &bindings.profile.digest,
        target: bindings.target,
        route_facts,
        config: transport,
        profile_lock_path: &lock_path,
        posix_picker: None,
        workspace_snapshot_cancel: None,
        attach_path: bindings.attach_path.as_deref(),
        agent_fixture: None,
        identity_agent_path: None,
        stage: None,
        #[cfg(target_os = "linux")]
        tracked_push: None,
        #[cfg(target_os = "linux")]
        opencode_recipe: None,
        #[cfg(target_os = "linux")]
        opencode_service: None,
    };
    let (mut owner, attachment) = super::owner::bootstrap(&mut pipe, startup)?;
    owner.supervised_terminal = false;
    let result = owner.serve_primary_session(&mut pipe);
    drop(pipe);
    match attachment {
        Some(attachment) => {
            drop(result);
            attachment.serve(&mut owner, &bindings.profile.digest, None)
        }
        None => result,
    }
}

#[cfg(test)]
#[path = "startup_production_tests.rs"]
mod tests;
