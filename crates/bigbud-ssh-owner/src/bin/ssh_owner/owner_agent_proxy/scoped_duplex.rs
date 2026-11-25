use std::{io, path::PathBuf};

use super::{
    AgentProxyFixture, AgentProxyLease, ErrorCode, Transport, adopt_pipes, deferred_reaper,
    git_receive, git_upload, random_token, v1,
};
use v1::request::Operation;

pub(in super::super) enum ScopedDuplex {
    Peer(v1::ProofPeerRelayOpen),
    Git(v1::ProofGitAdvertisementOpen),
    GitUpload(v1::ProofGitUploadOpen),
}

impl AgentProxyFixture {
    /// # Safety
    /// The isolated launcher must transfer exclusive ownership of descriptors 3–5.
    pub(in super::super) unsafe fn new_scoped(scope: ScopedDuplex) -> io::Result<Self> {
        validate_scope(&scope)?;
        // SAFETY: reserved inherited descriptors, transferred exclusively by startup.
        let pipes = unsafe { adopt_pipes([3, 4, 5]) }?;
        Ok(Self {
            binary: PathBuf::new(),
            sha256: String::new(),
            pipes: Some(pipes),
            installed: None,
            relay: None,
            provider: None,
            scoped: Some(scope),
        })
    }

    pub(in super::super) fn allows_scoped(&self, operation: &Operation) -> bool {
        match &self.scoped {
            None => true,
            Some(ScopedDuplex::Peer(_)) => matches!(
                operation,
                Operation::ProofPeerRelayOpen(_)
                    | Operation::ProofAgentProxyStatus(_)
                    | Operation::ProofAgentProxyClose(_)
                    | Operation::Connect(_)
                    | Operation::Disconnect(_)
            ),
            Some(ScopedDuplex::GitUpload(_)) => matches!(
                operation,
                Operation::ProofGitUploadOpen(_)
                    | Operation::ProofAgentProxyStatus(_)
                    | Operation::ProofAgentProxyClose(_)
                    | Operation::Connect(_)
                    | Operation::Disconnect(_)
                    | Operation::InspectTrust(_)
                    | Operation::ApproveTrust(_)
            ),
            Some(ScopedDuplex::Git(_)) => matches!(
                operation,
                Operation::ProofGitAdvertisementOpen(_)
                    | Operation::ProofAgentProxyStatus(_)
                    | Operation::ProofAgentProxyClose(_)
                    | Operation::Connect(_)
                    | Operation::Disconnect(_)
                    | Operation::InspectTrust(_)
                    | Operation::ApproveTrust(_)
            ),
        }
    }

    pub(in super::super) fn open_scoped(
        &mut self,
        transport: &Transport,
        request: &ScopedDuplex,
    ) -> Result<AgentProxyLease, ErrorCode> {
        if self.pipes.is_none() {
            return Err(ErrorCode::OperationDenied);
        }
        let pinned = match (self.scoped.as_ref(), request) {
            (Some(ScopedDuplex::Peer(expected)), ScopedDuplex::Peer(actual))
                if expected == actual =>
            {
                transport.pinned_peer_ssh(
                    &expected.host_key_fingerprint,
                    &expected.coordinator_key_fingerprint,
                )?
            }
            (Some(ScopedDuplex::Git(expected)), ScopedDuplex::Git(actual))
                if expected == actual =>
            {
                let recipe = git_recipe(expected).map_err(|_| ErrorCode::InvalidOperands)?;
                if !recipe.matches_binding(
                    &actual.repository_path,
                    &actual.destination_ref,
                    &actual.source_oid,
                ) {
                    return Err(ErrorCode::OperationDenied);
                }
                transport.revalidate_policy()?;
                let mut pinned = transport.pinned_ssh("-T")?;
                // No client bytes can be sent to Git, even if the local client writes stdin.
                pinned.command.args([
                    "-n",
                    "-o",
                    "EscapeChar=none",
                    "--",
                    transport.host(),
                    recipe.command(),
                ]);
                pinned
            }
            (Some(ScopedDuplex::GitUpload(expected)), ScopedDuplex::GitUpload(actual))
                if expected == actual =>
            {
                let recipe = upload_recipe(expected).map_err(|_| ErrorCode::InvalidOperands)?;
                if !recipe.matches_binding(&actual.repository_path) {
                    return Err(ErrorCode::OperationDenied);
                }
                transport.revalidate_policy()?;
                let mut pinned = transport.pinned_ssh("-T")?;
                pinned.command.args([
                    "-o",
                    "EscapeChar=none",
                    "--",
                    transport.host(),
                    recipe.command(),
                ]);
                pinned
            }
            _ => return Err(ErrorCode::OperationDenied),
        };
        let token = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let reap = deferred_reaper().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let pipes = self.pipes.take().ok_or(ErrorCode::OperationDenied)?;
        AgentProxyLease::launch_pinned(pinned, pipes, token, reap)
    }
}

fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, byte)| match i {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => lower_hex(byte),
        })
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

fn validate_scope(scope: &ScopedDuplex) -> io::Result<()> {
    match scope {
        ScopedDuplex::Git(git) => git_recipe(git).map(|_| ()),
        ScopedDuplex::GitUpload(git) => upload_recipe(git).map(|_| ()),
        ScopedDuplex::Peer(peer) => {
            let host_pin = peer
                .host_key_fingerprint
                .strip_prefix("SHA256:")
                .is_some_and(|s| {
                    s.len() == 43
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
                });
            let coordinator_pin = peer
                .coordinator_key_fingerprint
                .strip_prefix("sha256:")
                .is_some_and(|s| s.len() == 64 && s.bytes().all(lower_hex));
            if uuid(&peer.pairing_id)
                && uuid(&peer.grant_id)
                && peer.worker_authority_id.len() == 32
                && peer.worker_authority_id.bytes().all(lower_hex)
                && host_pin
                && coordinator_pin
            {
                Ok(())
            } else {
                Err(invalid_scope())
            }
        }
    }
}

fn git_recipe(scope: &v1::ProofGitAdvertisementOpen) -> io::Result<git_receive::Recipe> {
    // The only approved path class is the bare repo in a disposable Linux fixture.
    let root = scope
        .repository_path
        .strip_suffix("/receive.git")
        .ok_or_else(invalid_scope)?;
    let fixture = root
        .strip_prefix("/tmp/bigbud-picker-linux-")
        .ok_or_else(invalid_scope)?;
    if fixture.is_empty()
        || fixture.len() > 64
        || !fixture.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(invalid_scope());
    }
    // Source ref is part of exact approval even though advertisement cannot update refs.
    git_receive::Recipe::new(
        root,
        &scope.repository_path,
        &scope.source_ref,
        &scope.source_oid,
    )?;
    git_receive::Recipe::new(
        root,
        &scope.repository_path,
        &scope.destination_ref,
        &scope.source_oid,
    )
}

fn upload_recipe(scope: &v1::ProofGitUploadOpen) -> io::Result<git_upload::Recipe> {
    let root = scope
        .repository_path
        .strip_suffix("/upload.git")
        .ok_or_else(invalid_scope)?;
    git_upload::Recipe::new(root, &scope.repository_path)
}

fn invalid_scope() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid scoped native duplex binding",
    )
}
