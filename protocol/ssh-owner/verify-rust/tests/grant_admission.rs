//! S0 admission model, not a live owner. The peer, active lease, owner-held
//! grant record, and clock are test inputs; admission has no external I/O.

use sha2::{Digest, Sha256};

#[path = "support/operands.rs"]
mod operands;
use operands::operand_preimage;

#[allow(dead_code)]
mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.ssh_owner.v1.rs"));
}

use v1::{ErrorCode, Request, request::Operation};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    Dispatcher,
    Control,
    Picker,
}

impl Class {
    fn permits(self, verb: Verb) -> bool {
        match verb {
            Verb::InspectTrust | Verb::ApproveTrust | Verb::Connect | Verb::Disconnect => {
                self == Self::Control
            }
            // Connection UI / SSH control: read-only alias metadata, never monitor.
            Verb::ListAliases => self == Self::Control,
            Verb::ListFolders => self == Self::Picker,
            // Exec-class authority is dispatcher-only and never shared with a
            // picker, monitor, read or PTY grant. Each verb keeps its own grant.
            Verb::RunThreadShell | Verb::RunProviderWorkspaceShell | Verb::RunAcpCommand => {
                self == Self::Dispatcher
            }
            // Peer enrollment is coordinator-dispatcher authority. Ordinary
            // host trust (control) and monitor/read classes can never satisfy it.
            Verb::EnsurePeerCoordinatorKey | Verb::InspectPeerHostKey => self == Self::Dispatcher,
            // Reserved transfer handoff (C15 / W2 T-xfer). No class admits it in
            // S1-S4 and it never shares a grant with PTY, shell, peer or
            // ordinary trust.
            Verb::TransferStream | Verb::PackagedRsync => false,
            Verb::OtherFixtureOperation => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verb {
    InspectTrust,
    ApproveTrust,
    Connect,
    Disconnect,
    ListFolders,
    ListAliases,
    RunThreadShell,
    RunProviderWorkspaceShell,
    RunAcpCommand,
    EnsurePeerCoordinatorKey,
    InspectPeerHostKey,
    TransferStream,
    PackagedRsync,
    OtherFixtureOperation,
}

fn normalized_operand(operation: &Operation) -> (Verb, [u8; 32]) {
    let verb = match operation {
        Operation::InspectTrust(_) => Verb::InspectTrust,
        Operation::ApproveTrust(_) => Verb::ApproveTrust,
        Operation::Connect(_) => Verb::Connect,
        Operation::Disconnect(_) => Verb::Disconnect,
        Operation::ListFolders(_) => Verb::ListFolders,
        Operation::ListAliases(_) => Verb::ListAliases,
        Operation::ProofRunThreadShell(_) => Verb::RunThreadShell,
        Operation::ProofRunProviderWorkspaceShell(_) => Verb::RunProviderWorkspaceShell,
        Operation::ProofRunAcpCommand(_) => Verb::RunAcpCommand,
        Operation::ProofEnsurePeerCoordinatorKey(_) => Verb::EnsurePeerCoordinatorKey,
        Operation::ProofInspectPeerHostKey(_) => Verb::InspectPeerHostKey,
        Operation::ProofTransferStream(_) => Verb::TransferStream,
        Operation::ProofPackagedRsync(_) => Verb::PackagedRsync,
        Operation::ProofPrepareTerminal(_)
        | Operation::ProofCancelTerminalReservation(_)
        | Operation::ProofOpenTerminal(_)
        | Operation::ProofTerminalStatus(_)
        | Operation::ProofCloseTerminal(_)
        | Operation::ProofTerminalInput(_)
        | Operation::ProofTerminalResize(_)
        | Operation::ProofTerminalReplay(_)
        | Operation::ProofTerminalCwd(_)
        | Operation::ProofPiProbe(_)
        | Operation::ProofPiOpen(_)
        | Operation::ProofCodexProbe(_)
        | Operation::ProofCodexOpen(_)
        | Operation::ProofWorkspaceModeInspect(_)
        | Operation::ProofWorkspaceModePublish(_)
        | Operation::ProofGitTrackedPush(_)
        | Operation::ProofUnlockSyntheticPosixPassword(_)
        | Operation::ProofOpencodeOpen(_)
        | Operation::ProofOpencodeStatus(_)
        | Operation::ProofOpencodeClose(_)
        | Operation::ProofDeploymentManifestPut(_)
        | Operation::ProofGitUploadOpen(_)
        | Operation::ProofDeploymentStageBegin(_)
        | Operation::ProofPeerRelayOpen(_)
        | Operation::ProofGitAdvertisementOpen(_)
        | Operation::ProofClientRelayOpen(_)
        | Operation::ProofAgentProxyOpen(_)
        | Operation::ProofAgentProxyStatus(_)
        | Operation::ProofAgentProxyClose(_)
        | Operation::ProofWorkspaceRead(_)
        | Operation::ProofWorkspaceReadiness(_)
        | Operation::ProofWorkspaceList(_)
        | Operation::ProofWorkspaceSnapshot(_)
        | Operation::ProofWorkspaceIndex(_)
        | Operation::ProofWorkspaceWrite(_)
        | Operation::ProofWorkspaceContentSearch(_)
        | Operation::ProofSampleHealth(_)
        | Operation::ProofDeploymentCompletion(_)
        | Operation::ProofDeploymentHostProbe(_)
        | Operation::ProofWorkspaceGit(_)
        | Operation::ProofWorkspaceGuardedWriteBegin(_)
        | Operation::ProofWorkspaceGuardedWriteChunk(_)
        | Operation::ProofWorkspaceGuardedWriteCommit(_)
        | Operation::ProofWorkspaceGuardedWriteAbort(_)
        | Operation::ProofWorkspaceGuardedWriteApply(_)
        | Operation::ProofWorkspaceCreate(_)
        | Operation::ProofWorkspaceCreateDirectory(_)
        | Operation::ProofWorkspaceDeleteEntry(_)
        | Operation::ProofWorkspaceWriteBegin(_)
        | Operation::ProofWorkspaceWriteChunk(_)
        | Operation::ProofWorkspaceWriteCommit(_)
        | Operation::ProofWorkspaceWriteAbort(_)
        | Operation::ProofAgentAction(_)
        | Operation::ProofDeploymentAction(_) => Verb::OtherFixtureOperation,
    };
    let digest = Sha256::digest(operand_preimage(operation.clone()));
    (verb, digest.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Peer {
    profile: u8,
    session: u8,
    class: Class,
    lease: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Session {
    peer: Peer,
    epoch: u8,
}

#[derive(Clone, Copy)]
struct Owner {
    profile: u8,
    epoch: u8,
    target: &'static str,
    generation: u8,
    active_lease: u8,
    disconnected: bool,
}

impl Owner {
    fn bind_session(
        self,
        authenticated_peer: Option<Peer>,
        claimed_profile: u8,
    ) -> Option<Session> {
        let peer = authenticated_peer?;
        (peer.profile == claimed_profile && peer.profile == self.profile).then_some(Session {
            peer,
            epoch: self.epoch,
        })
    }

    fn has_current_session(self, session: Session) -> bool {
        session.epoch == self.epoch
            && session.peer.profile == self.profile
            && session.peer.lease == self.active_lease
    }

    fn issue_grant(
        self,
        issuer: Session,
        request: GrantIssue<'_>,
        approved: ProductApproval,
        owner_token: u8, // fixture input in place of owner-generated randomness
        now: u64,
    ) -> Result<Grant, ErrorCode> {
        let denied = ErrorCode::OperationDenied;
        if issuer.peer.class != Class::Dispatcher
            || !self.has_current_session(issuer)
            || !self.has_current_session(request.session)
            || request.session != approved.session
            || request.target != self.target
            || request.target != approved.target
            || request.generation != self.generation
            || request.generation != approved.generation
            || now >= approved.expires_at
        {
            return Err(denied);
        }
        let (verb, digest) = normalized_operand(request.operation);
        if !request.session.peer.class.permits(verb)
            || verb != approved.verb
            || digest != approved.digest
        {
            return Err(denied);
        }
        Ok(Grant {
            token: owner_token,
            session: request.session,
            target: approved.target,
            generation: approved.generation,
            verb,
            expires_at: approved.expires_at,
            digest,
        })
    }
}

// These are trusted fixture inputs, not renderer-supplied role or permission claims.
#[derive(Clone, Copy)]
struct ProductApproval {
    session: Session,
    target: &'static str,
    generation: u8,
    verb: Verb,
    digest: [u8; 32],
    expires_at: u64,
}

#[derive(Clone, Copy)]
struct GrantIssue<'a> {
    session: Session,
    target: &'a str,
    generation: u8,
    operation: &'a Operation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Grant {
    // An opaque synthetic credential and its trusted lookup record. The wire
    // request carries only the credential, never these rights or a lease claim.
    token: u8,
    session: Session,
    target: &'static str,
    generation: u8,
    verb: Verb,
    expires_at: u64,
    digest: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
enum Admission {
    Executed,
    DuplicateReceipt,
}

#[derive(Default)]
struct DummyTransport {
    // Local to one test. A receipt models consumption before the counter changes.
    receipts: Vec<(Vec<u8>, Grant)>,
    calls: usize,
}

impl DummyTransport {
    fn submit(
        &mut self,
        owner: Owner,
        session: Option<Session>,
        grant: Option<Grant>,
        request: &Request,
        now: u64,
    ) -> Result<Admission, ErrorCode> {
        let denied = ErrorCode::OperationDenied;
        let session = session.ok_or(denied)?;
        let grant = grant.ok_or(denied)?;
        let (verb, digest) = normalized_operand(request.operation.as_ref().ok_or(denied)?);
        if request.request_id.is_empty()
            || request.grant != [grant.token]
            || session.peer.profile != owner.profile
            || session.epoch != owner.epoch
            || request.owner_epoch != [owner.epoch]
            || session.peer.lease != owner.active_lease
            || !session.peer.class.permits(verb)
            || grant.session != session
            || request.target_id != owner.target
            || grant.target != owner.target
            || request.target_generation != [owner.generation]
            || grant.generation != owner.generation
            || grant.verb != verb
            || grant.digest != digest
            || now >= grant.expires_at
        {
            return Err(denied);
        }

        for (id, used) in &self.receipts {
            if used.session == session && *id == request.request_id {
                return if *used == grant {
                    Ok(Admission::DuplicateReceipt)
                } else {
                    Err(denied)
                };
            }
            if used.token == grant.token {
                return Err(denied);
            }
        }

        // Narrow fixture only: no durable transitions or reconnect logic.
        if owner.disconnected
            && matches!(
                verb,
                Verb::InspectTrust | Verb::ApproveTrust | Verb::ListFolders
            )
        {
            return Err(ErrorCode::TargetDisconnected);
        }
        self.receipts.push((request.request_id.clone(), grant));
        self.calls += 1;
        Ok(Admission::Executed)
    }
}

#[path = "support/grant_admission_cases.rs"]
mod cases;
#[path = "support/exec_grant_cases.rs"]
mod exec_cases;
#[path = "support/peer_enrollment_cases.rs"]
mod peer_cases;
#[path = "support/transfer_cases.rs"]
mod transfer_cases;
