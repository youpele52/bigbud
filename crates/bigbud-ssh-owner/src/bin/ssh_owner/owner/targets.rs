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
//! admission path. Each entry also owns that target's master, PTY, agent proxy
//! and OpenCode lanes, so a lease never crosses a target boundary.

#[path = "targets.descriptor.rs"]
mod descriptor;
#[path = "targets.lanes.rs"]
mod lanes;
#[path = "targets.registry.rs"]
mod registry;

pub(crate) use descriptor::{Descriptor, Host, MAX_TARGETS};
pub(crate) use lanes::{Lanes, LeaseScope};
pub(crate) use registry::{Registry, Slot};

use self::descriptor::Kind;
use crate::{
    config::{self, RouteFacts},
    transport::TransportConfig,
    v1::{self, ErrorCode},
};
use std::{net::IpAddr, path::PathBuf, sync::Arc};

#[path = "targets.dns.rs"]
mod dns;
pub(crate) use dns::HostResolver;

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
#[derive(Clone)]
pub(crate) struct TargetAuthority {
    ssh: PathBuf,
    keyscan: PathBuf,
    system_config: Option<PathBuf>,
    /// Absolute alias config scope. The alias name comes from the descriptor.
    alias_config: Option<PathBuf>,
    workspace_root: Option<PathBuf>,
    /// Owner-side DNS for descriptor host names; the system resolver in
    /// production, replaceable in tests.
    resolver: Arc<dyn HostResolver>,
}

impl std::fmt::Debug for TargetAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TargetAuthority")
            .field("ssh", &self.ssh)
            .field("keyscan", &self.keyscan)
            .field("system_config", &self.system_config)
            .field("alias_config", &self.alias_config)
            .field("workspace_root", &self.workspace_root)
            .finish_non_exhaustive()
    }
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
            resolver: Arc::new(dns::SystemResolver),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_resolver(mut self, resolver: Arc<dyn HostResolver>) -> Self {
        self.resolver = resolver;
        self
    }

    /// Resolves the descriptor host now. The address lands only in the
    /// returned transport config, which the registry entry owns, so it never
    /// outlives that entry; every re-verification resolves again.
    fn resolve_host(&self, descriptor: &Descriptor) -> Result<IpAddr, ErrorCode> {
        match &descriptor.host {
            Host::Ip(ip) => Ok(*ip),
            Host::Name(name) => self
                .resolver
                .resolve(name, descriptor.port)
                .ok_or(ErrorCode::TargetHostUnresolved),
        }
    }
}

impl TargetAuthority {
    /// The owner-started OpenSSH client and keyscan images (U24 peer routes).
    pub(super) fn openssh(&self) -> (&std::path::Path, &std::path::Path) {
        (&self.ssh, &self.keyscan)
    }

    /// U24: resolve a stored peer host (IP literal or DNS name) now. The pin
    /// file is derived per open under the dialled address, and the key itself
    /// is the trust anchor, so the name never selects a known-hosts label.
    pub(super) fn resolve_peer_host(&self, host: &str, port: u16) -> Result<IpAddr, ErrorCode> {
        if let Ok(address) = host.parse::<IpAddr>() {
            return Ok(address);
        }
        self.resolver
            .resolve(host, port)
            .ok_or(ErrorCode::TargetHostUnresolved)
    }

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
                // Compare like with like before any lookup: the policy's
                // `HostName` and the descriptor host are both unresolved (a name
                // against a name, an address against an address). An explicit
                // descriptor alias must agree with the policy's `HostKeyAlias`.
                if resolved.host != descriptor.host
                    || descriptor
                        .host_key_alias
                        .as_ref()
                        .is_some_and(|alias| resolved.host_key_alias.as_ref() != Some(alias))
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
        // Resolve only after the policy agreed; the address is dialled while
        // host keys stay checked under the name (or explicit alias).
        let host = self.resolve_host(descriptor)?;
        Ok(TransportConfig {
            ssh: self.ssh.clone(),
            keyscan: self.keyscan.clone(),
            host,
            port: descriptor.port,
            user: descriptor.user.clone(),
            identity: descriptor.identity.clone(),
            known_hosts: descriptor.trust.clone(),
            alias_config,
            system_config,
            workspace_root: self.workspace_root.clone(),
            dev_interactive_terminal: false,
            host_identity: crate::transport::HostIdentity {
                dns_name: descriptor.host.name().map(str::to_owned),
                key_alias: descriptor.host_key_alias.clone(),
            },
        })
    }
}

#[cfg(test)]
#[path = "targets.dns.tests.rs"]
mod dns_tests;
#[cfg(test)]
#[path = "targets.lanes.tests.rs"]
mod lane_tests;
#[cfg(test)]
#[path = "targets.tests.rs"]
mod tests;
