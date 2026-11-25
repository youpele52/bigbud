//! Unix loopback fixture only. No ambient SSH policy, agent, hops or masters.

mod agent_identity;
mod auth_methods;
mod command;
#[cfg(unix)]
mod connector;
#[cfg(unix)]
pub(super) use connector::ConnectorApproval;
mod deployment;
mod deployment_action;
pub(super) mod deployment_manifest;
pub(super) mod deployment_stage;
mod folders;
mod health;
mod host_key;
mod identity;
#[cfg(target_os = "linux")]
pub(super) mod jump_binding;
mod listing;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) use listing::ListFailure;
#[cfg(target_os = "linux")]
mod opencode;
mod peer;
mod peer_enrollment;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) mod posix_master;
mod provider_probe;
#[cfg(test)]
pub(super) use identity::write_identity_fixture;
mod process;
pub(super) use process::ssh_failure;
mod recipe;
pub(crate) use recipe::RecipeOutput;
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "transport/workspace/guarded_recipe.rs"]
pub(super) mod guarded_recipe;
mod shell;
mod terminal;
mod trust;
mod trust_store;
pub(super) mod workspace;
pub(super) mod workspace_mode;

use super::config::{self, HostVerification, ResolvedConfig, SshTimers};
use super::openssh_image::Images;
use super::v1::{self, ErrorCode, Folder, Folders};
use host_key::HostKey;
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEADLINE: Duration = Duration::from_secs(10);

/// Key-mode method configuration. Keyboard-interactive must stay ineligible so
/// U2 is decided from this list, never from prompt text.
pub(super) const AUTH_METHOD_OPTIONS: &[&str] = &[
    "BatchMode=yes",
    "PreferredAuthentications=publickey",
    "PubkeyAcceptedAlgorithms=ssh-ed25519",
    "IdentitiesOnly=yes",
    "CertificateFile=none",
    "AddKeysToAgent=no",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    config::GSSAPI_INERT_OVERRIDE,
    "HostbasedAuthentication=no",
];

pub(super) struct TransportConfig {
    pub ssh: PathBuf,
    pub keyscan: PathBuf,
    pub host: IpAddr,
    pub port: u16,
    pub user: String,
    pub identity: PathBuf,
    pub known_hosts: PathBuf,
    pub alias_config: Option<(PathBuf, String)>,
    pub system_config: Option<PathBuf>,
    // Trusted proof startup authority, never sourced from a wire request.
    pub workspace_root: Option<PathBuf>,
    pub dev_interactive_terminal: bool,
}

#[derive(Clone)]
pub(super) struct ObservedHostKey {
    pub verified: bool,
    pub fingerprint: String,
    pub key_type: String,
    raw: HostKey,
    scope: Arc<TransportConfig>,
    trust_stamp: Option<[u8; 32]>,
}

pub(super) struct Transport {
    config: Arc<TransportConfig>,
    host: String,
    family: &'static str,
    scan_label: String,
    host_label: String,
    policy: Option<ResolvedConfig>,
    facts: config::RouteFacts,
    identities: identity::IdentityFiles,
    images: Images,
    proof_agent: Option<agent_identity::ProofAgent>,
    /// Qualified restricted connector, or why it is unavailable. Any policy
    /// with a connector refuses every direct SSH and scan launch.
    #[cfg(unix)]
    connector: Option<Result<connector::PinnedConnector, ErrorCode>>,
    /// One bounded staged overwrite draft, held without remote work.
    pub(super) workspace_write_stage: workspace::staged_write::Stage,
}

// Keep the exact pin alive while the SSH client can still be authenticating.
pub(super) struct PinnedSsh {
    pub command: Command,
    _snapshot: trust_store::Snapshot,
}

impl Transport {
    #[cfg(test)]
    pub(super) fn new(config: TransportConfig) -> Result<Self, ErrorCode> {
        Self::new_with_facts(config, &config::RouteFacts::default())
    }

    pub(super) fn new_with_facts(
        config: TransportConfig,
        facts: &config::RouteFacts,
    ) -> Result<Self, ErrorCode> {
        let mut transport = Self::new_with_policy(config, |config| {
            config
                .alias_config
                .as_ref()
                .map(|(path, alias)| {
                    config::resolve_for_startup(path, config.system_config.as_deref(), alias, facts)
                })
                .transpose()
        })?;
        #[cfg(unix)]
        transport.bind_connector(facts);
        transport.facts = facts.clone();
        Ok(transport)
    }

    /// Read-only alias discovery over this owner's bound config scope. The
    /// caller has already authenticated and consumed a control grant; discovery
    /// itself opens no socket and starts no process.
    pub(super) fn list_aliases(&self) -> Result<v1::ProofAliases, ErrorCode> {
        let Some((path, _alias)) = &self.config.alias_config else {
            return Err(ErrorCode::ConfigUnsupported);
        };
        config::aliases::list(path, self.config.system_config.as_deref(), &self.facts)
    }

    fn new_with_policy(
        config: TransportConfig,
        resolve: impl FnOnce(&TransportConfig) -> Result<Option<ResolvedConfig>, ErrorCode>,
    ) -> Result<Self, ErrorCode> {
        if !config.host.is_loopback()
            || config.port == 0
            || config.user.is_empty()
            || config.user.len() > 64
            || !config
                .user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            || !config.ssh.is_absolute()
            || !config.keyscan.is_absolute()
            || !identity::literal_path(&config.identity)
            || !(if config.alias_config.is_some() {
                config::valid_configured_trust_path(&config.known_hosts)
            } else {
                identity::literal_path(&config.known_hosts)
            })
            || config.identity == config.known_hosts
            || config
                .workspace_root
                .as_deref()
                .is_some_and(|root| workspace::configured_root(root).is_none())
        {
            return Err(ErrorCode::ConfigUnsupported);
        }
        let images = Images::bind(&config.ssh, &config.keyscan)?;
        trust_store::check_directory(&config.known_hosts)?;
        let policy = resolve(&config)?;
        if let Some(resolved) = &policy {
            if resolved.host != config.host
                || resolved.port != config.port
                || resolved.user != config.user
                || resolved.identity != config.identity
                || resolved
                    .known_hosts
                    .as_ref()
                    .is_some_and(|first| first != &config.known_hosts)
            {
                return Err(ErrorCode::ConfigUnsupported);
            }
            if resolved.known_hosts.is_none() {
                trust::check_snapshot_anchor(&config.known_hosts, &resolved.global_known_hosts)?;
            }
        } else if config.system_config.is_some() {
            return Err(ErrorCode::ConfigUnsupported);
        }
        let identities = identity::IdentityFiles::bind(
            std::iter::once(config.identity.as_path()).chain(
                policy
                    .iter()
                    .flat_map(|policy| policy.additional_identities.iter().map(PathBuf::as_path)),
            ),
        )?;
        let proof_agent = agent_identity::ProofAgent::from_policy(policy.as_ref())?;
        let host = config.host.to_string();
        let scan_label = if config.port == 22 {
            host.clone()
        } else {
            format!("[{host}]:{}", config.port)
        };
        let host_label = policy
            .as_ref()
            .and_then(|policy| policy.host_key_alias.clone())
            .unwrap_or_else(|| scan_label.clone());
        let family = if config.host.is_ipv4() { "-4" } else { "-6" };
        Ok(Self {
            config: Arc::new(config),
            host,
            family,
            scan_label,
            host_label,
            policy,
            facts: config::RouteFacts::default(),
            identities,
            images,
            proof_agent,
            #[cfg(unix)]
            connector: None,
            workspace_write_stage: workspace::staged_write::Stage::new(),
        })
    }

    pub(super) fn read_workspace(
        &self,
        operand: &v1::ProofWorkspaceRead,
    ) -> Result<v1::ProofWorkspaceFile, ErrorCode> {
        workspace::read(self, operand)
    }

    pub(super) fn list_workspace_directory(
        &self,
        operand: &v1::ProofWorkspaceList,
    ) -> Result<v1::ProofWorkspaceDirectory, ErrorCode> {
        workspace::directory::list(self, operand)
    }

    pub(super) fn snapshot_workspace_directory(
        &self,
        operand: &v1::ProofWorkspaceList,
    ) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
        workspace::snapshot::snapshot(self, operand)
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn snapshot_workspace_directory_cancellable(
        &self,
        operand: &v1::ProofWorkspaceList,
        cancelled: impl Fn() -> bool,
    ) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
        workspace::snapshot::snapshot_cancellable(self, operand, cancelled)
    }

    pub(super) fn index_workspace(
        &self,
        operand: &v1::ProofWorkspaceIndex,
    ) -> Result<v1::ProofWorkspaceIndexResult, ErrorCode> {
        workspace::index::index(self, operand)
    }

    pub(super) fn write_workspace(
        &self,
        operand: &v1::ProofWorkspaceWrite,
    ) -> Result<(), ErrorCode> {
        workspace::write::write(self, operand)
    }

    pub(super) fn create_workspace_directory(
        &self,
        operand: &v1::ProofWorkspaceCreateDirectory,
    ) -> Result<v1::ProofWorkspaceEntryMutation, ErrorCode> {
        workspace::directory_ops::create_directory(self, operand)
    }

    pub(super) fn delete_workspace_entry(
        &self,
        operand: &v1::ProofWorkspaceDeleteEntry,
    ) -> Result<v1::ProofWorkspaceEntryMutation, ErrorCode> {
        workspace::directory_ops::delete_entry(self, operand)
    }

    pub(super) fn search_workspace_contents(
        &self,
        operand: &v1::ProofWorkspaceContentSearch,
    ) -> Result<v1::ProofWorkspaceContentMatches, ErrorCode> {
        workspace::search::search(self, operand)
    }

    pub(super) fn execute_workspace_git(
        &self,
        operand: &v1::ProofWorkspaceGit,
    ) -> Result<v1::ProofWorkspaceGitResult, ErrorCode> {
        workspace::git::execute(self, operand)
    }

    pub(super) fn sample_health(&self) -> Result<v1::ProofHealth, ErrorCode> {
        health::sample(self)
    }

    pub(super) fn host(&self) -> &str {
        &self.host
    }

    pub(super) fn pinned_ssh(&self, tty: &str) -> Result<PinnedSsh, ErrorCode> {
        self.pinned_ssh_with_timers(tty, None, false)
    }

    fn pinned_ssh_with_timers(
        &self,
        tty: &str,
        timers: Option<&SshTimers>,
        fixed_forward: bool,
    ) -> Result<PinnedSsh, ErrorCode> {
        let pin = self.pin()?.ok_or(ErrorCode::TrustRequired)?;
        self.ssh_for_pin(
            tty,
            timers,
            fixed_forward,
            &pin,
            HostVerification::Ed25519Key,
        )
    }

    fn ssh_for_pin(
        &self,
        tty: &str,
        timers: Option<&SshTimers>,
        fixed_forward: bool,
        pin: &trust_store::Pin,
        verification: HostVerification,
    ) -> Result<PinnedSsh, ErrorCode> {
        self.require_direct_route()?;
        self.build_ssh_for_pin(tty, timers, fixed_forward, pin, verification)
    }

    pub(super) fn alias_descriptor(&self) -> Option<[u8; 32]> {
        self.policy.as_ref().map(ResolvedConfig::descriptor_digest)
    }

    pub(super) fn revalidate_policy(&self) -> Result<(), ErrorCode> {
        self.revalidate_proof_agent()?;
        self.policy
            .as_ref()
            .map_or(Ok(()), ResolvedConfig::revalidate)
    }
}
