use super::{Outcome, Owner};
use crate::v1::{
    ProofGitTrackedPush, ProofGitTrackedPushReceipt, ProofGitTrackedPushStatus as Status,
};

#[cfg(target_os = "linux")]
use crate::{
    Token,
    owner_agent_proxy::git_receive::{
        fixture_launch::FixtureLauncher,
        tracked_push::{
            Connector, RepositoryIdentity, TrackedDestination, TrackedPushBinding,
            TrackedPushRequest, TrackedPushResult,
        },
    },
    transport::TransportConfig,
};
#[cfg(target_os = "linux")]
use bigbud_ssh_owner::git_receive_gate::DestinationReceipt;
#[cfg(target_os = "linux")]
use std::{
    fmt::Write,
    io,
    path::{Path, PathBuf},
};

#[cfg(target_os = "linux")]
pub(in super::super) struct Startup {
    pub(in super::super) root: PathBuf,
    pub(in super::super) target_id: String,
    pub(in super::super) source_oid: String,
    pub(in super::super) expected_old_oid: String,
}

#[cfg(target_os = "linux")]
pub(super) struct TrackedPushState {
    connector: Connector,
    launcher: FixtureLauncher,
}

#[cfg(target_os = "linux")]
const URL: &str = "ssh://picker@127.0.0.1:22222/receive.git";
#[cfg(target_os = "linux")]
const MAIN: &str = "refs/heads/main";

#[cfg(target_os = "linux")]
impl TrackedPushState {
    pub(super) fn start(
        startup: Startup,
        config: &TransportConfig,
        target_id: &str,
        generation: Token,
    ) -> io::Result<Self> {
        let root = &startup.root;
        if startup.target_id != target_id
            || config.host.to_string() != "127.0.0.1"
            || config.user != "picker"
            || config.port != 22222
            || config.ssh != Path::new("/usr/bin/ssh")
            || config.keyscan != Path::new("/usr/bin/ssh-keyscan")
            || config.alias_config.is_some()
            || config.system_config.is_some()
            || config.workspace_root.is_some()
            || config.dev_interactive_terminal
            || config.identity != root.join("identity")
            || config.known_hosts != root.join("known_hosts")
        {
            return Err(crate::invalid_input());
        }
        let launcher = FixtureLauncher::new(root)?;
        let worktree = root.join("client");
        let worktree = worktree.to_str().ok_or_else(crate::invalid_input)?;
        let git_dir = format!("{worktree}/.git");
        let connector = Connector::new(TrackedPushBinding {
            repository: RepositoryIdentity {
                worktree: worktree.into(),
                git_dir: git_dir.clone(),
                common_dir: git_dir,
            },
            remote_name: "origin".into(),
            source_ref: MAIN.into(),
            destination_ref: MAIN.into(),
            source_oid: startup.source_oid,
            destination: TrackedDestination {
                effective_url: URL.into(),
                execution_target_id: startup.target_id,
                target_generation: token_hex(&generation),
                host: "127.0.0.1".into(),
                user: "picker".into(),
                port: 22222,
                repository_path: "/receive.git".into(),
                expected_old_oid: startup.expected_old_oid,
            },
        })?;
        Ok(Self {
            connector,
            launcher,
        })
    }
}

#[cfg(target_os = "linux")]
fn token_hex(token: &[u8]) -> String {
    let mut result = String::with_capacity(token.len() * 2);
    for part in token {
        // Formatting into String cannot fail.
        let _ = write!(result, "{part:02x}");
    }
    result
}

#[cfg(target_os = "linux")]
fn request(
    raw: ProofGitTrackedPush,
    target: &str,
    generation: Token,
) -> Option<TrackedPushRequest> {
    let repository = raw.repository?;
    let destination = raw.destination?;
    if destination.execution_target_id != target || destination.target_generation != generation {
        return None;
    }
    Some(TrackedPushRequest {
        timeout_ms: raw.timeout_ms,
        binding: TrackedPushBinding {
            repository: RepositoryIdentity {
                worktree: repository.worktree,
                git_dir: repository.git_dir,
                common_dir: repository.common_dir,
            },
            remote_name: raw.remote_name,
            source_ref: raw.source_ref,
            destination_ref: raw.destination_ref,
            source_oid: raw.source_oid,
            destination: TrackedDestination {
                effective_url: destination.effective_url,
                execution_target_id: destination.execution_target_id,
                target_generation: token_hex(&generation),
                host: destination.host,
                user: destination.user,
                port: u16::try_from(destination.port).ok()?,
                repository_path: destination.repository_path,
                expected_old_oid: destination.expected_old_oid,
            },
        },
    })
}

impl Owner {
    pub(super) fn receive_tracked_push(&mut self, raw: ProofGitTrackedPush) -> Outcome {
        let status = Status::DeniedBeforeDispatch;
        #[cfg(target_os = "linux")]
        let status = match (
            self.tracked_push.as_mut(),
            request(raw, &self.target, self.generation),
        ) {
            (Some(state), Some(request)) => {
                match state.connector.run(&request, |binding, deadline| {
                    state.launcher.launch(
                        super::present(&self.transport)
                            .map_err(|_| io::Error::from(io::ErrorKind::NotFound))?,
                        binding,
                        deadline,
                    )
                }) {
                    TrackedPushResult::DeniedBeforeDispatch => status,
                    TrackedPushResult::Finished(receipt) => match receipt {
                        DestinationReceipt::Accepted => Status::Accepted,
                        DestinationReceipt::Unchanged => Status::Unchanged,
                        DestinationReceipt::Rejected => Status::Rejected,
                        DestinationReceipt::Unconfirmed => Status::Unconfirmed,
                    },
                }
            }
            _ => status,
        };
        #[cfg(not(target_os = "linux"))]
        let _ = raw;
        Outcome::ProofGitTrackedPush(ProofGitTrackedPushReceipt {
            status: status.into(),
        })
    }
}
