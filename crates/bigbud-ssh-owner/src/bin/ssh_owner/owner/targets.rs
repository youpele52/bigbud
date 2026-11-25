//! Per-target resolution for one owner (W3.7).
//!
//! A production owner starts without a target. Every target-scoped request
//! carries an additive [`v1::TargetDescriptor`]; the owner validates it against
//! the same policy, identity, trust and connector rules as the pinned fixture,
//! caches the resolved transport per target id and binds every grant to that
//! exact target and generation. Nothing here opens a socket or starts an SSH
//! process: resolution is filesystem and config work only, so an unsupported
//! target is refused before any dial while other targets keep working.
//!
//! The one pinned fixture target is also a registry entry. Fixture requests
//! omit the descriptor and address the pinned id, so both modes share the same
//! admission path.

#[path = "targets.descriptor.rs"]
mod descriptor;
#[path = "targets.registry.rs"]
mod registry;

pub(crate) use descriptor::{Descriptor, MAX_TARGETS};
pub(crate) use registry::{Registry, Slot};

use self::descriptor::Kind;
use crate::{
    config::{self, RouteFacts},
    transport::TransportConfig,
    v1::{self, ErrorCode},
};
use std::path::PathBuf;

/// How the owner is started (W3.7). Fixture modes pin exactly one target;
/// production starts with no target and resolves one per request descriptor.
pub(crate) enum TargetStartup {
    Pinned {
        target: String,
        config: TransportConfig,
    },
    Unpinned(TargetAuthority),
}

/// Owner-started image and configuration roots. Target descriptors select a
/// target; they never select an executable, argv or transport option.
#[derive(Clone, Debug)]
pub(crate) struct TargetAuthority {
    ssh: PathBuf,
    keyscan: PathBuf,
    system_config: Option<PathBuf>,
    /// Absolute alias config scope. The alias name comes from the descriptor.
    alias_config: Option<PathBuf>,
    workspace_root: Option<PathBuf>,
}

impl TargetAuthority {
    pub(crate) fn new(
        ssh: PathBuf,
        keyscan: PathBuf,
        system_config: Option<PathBuf>,
        alias_config: Option<PathBuf>,
        workspace_root: Option<PathBuf>,
    ) -> Self {
        Self {
            ssh,
            keyscan,
            system_config,
            alias_config,
            workspace_root,
        }
    }
}

impl TargetAuthority {
    /// Read-only alias discovery over the owner's own config scope. No dial, DNS
    /// or credential path; the caller has already consumed a control grant.
    pub(super) fn list_aliases(&self) -> Result<v1::ProofAliases, ErrorCode> {
        let path = self
            .alias_config
            .as_ref()
            .ok_or(ErrorCode::ConfigUnsupported)?;
        config::aliases::list(
            path,
            self.system_config.as_deref(),
            &RouteFacts::default().with_production(),
        )
    }

    /// Builds the immutable per-target config the existing transport already
    /// understands. Alias targets are re-resolved through the same parser and
    /// must agree with the descriptor on every effective fact.
    pub(super) fn bind(&self, descriptor: &Descriptor) -> Result<TransportConfig, ErrorCode> {
        let (alias_config, system_config) = match descriptor.kind {
            Kind::Alias => {
                let path = self
                    .alias_config
                    .as_ref()
                    .ok_or(ErrorCode::ConfigUnsupported)?;
                let resolved = config::resolve_for_startup(
                    path,
                    self.system_config.as_deref(),
                    &descriptor.target_id,
                    &RouteFacts::default().with_production(),
                    true,
                )
                .map_err(|_| ErrorCode::ConfigUnsupported)?;
                if resolved.host != descriptor.host
                    || resolved.port != descriptor.port
                    || resolved.user != descriptor.user
                    || resolved.identity != descriptor.identity
                    || resolved.known_hosts.as_ref() != Some(&descriptor.trust)
                {
                    return Err(ErrorCode::ConfigUnsupported);
                }
                (
                    Some((path.clone(), descriptor.target_id.clone())),
                    self.system_config.clone(),
                )
            }
            // Explicit structured fields win; no alias policy is consulted and a
            // system config alone cannot define a target.
            Kind::Structured => (None, None),
        };
        Ok(TransportConfig {
            ssh: self.ssh.clone(),
            keyscan: self.keyscan.clone(),
            host: descriptor.host,
            port: descriptor.port,
            user: descriptor.user.clone(),
            identity: descriptor.identity.clone(),
            known_hosts: descriptor.trust.clone(),
            alias_config,
            system_config,
            workspace_root: self.workspace_root.clone(),
            dev_interactive_terminal: false,
        })
    }
}

#[cfg(test)]
#[path = "targets.tests.rs"]
mod tests;
