use super::{ErrorCode, Operation, Outcome, Owner, Pipe, RunResult};
use crate::owner_agent_proxy::{ProviderKind, ScopedDuplex};
use std::io::{Read, Write};

impl Owner {
    pub(super) fn execute<R: Read, W: Write>(
        &mut self,
        pipe: &mut Pipe<R, W>,
        id: &[u8],
        operation: Operation,
    ) -> RunResult<Result<Outcome, ErrorCode>> {
        if self.lanes.terminal_uncertain {
            return Ok(Err(ErrorCode::OutcomeUnknown));
        }
        let local_control = !needs_storage(&operation);
        if self.lanes.agent_close_uncertain && !is_agent_control(&operation) {
            return Ok(Err(ErrorCode::OutcomeUnknown));
        }
        // The active target's transport, or a typed refusal. A production owner
        // at rest binds a target before dispatch, so this cannot be reached
        // without one; fixture sessions keep the pinned target bound.
        macro_rules! transport {
            () => {
                match self.transport.as_ref() {
                    Some(transport) => transport,
                    None => return Ok(Err(ErrorCode::OwnerUnavailable)),
                }
            };
        }
        // C15 / W2 T-xfer: both verbs are reserved and fixture-only. No product
        // request policy admits them in S1-S4, so refuse before any resource
        // gate; the native fixture exercises them directly under cfg(test).
        if matches!(
            operation,
            Operation::ProofTransferStream(_) | Operation::ProofPackagedRsync(_)
        ) {
            return Ok(Err(ErrorCode::OperationDenied));
        }
        if !local_control
            && !matches!(operation, Operation::Connect(_) | Operation::Disconnect(_))
            && let Err(error) = self.storage.allow_network()
        {
            return Ok(Err(error));
        }
        match operation {
            operation @ (Operation::ProofWorkspaceGuardedWriteBegin(_)
            | Operation::ProofWorkspaceGuardedWriteChunk(_)
            | Operation::ProofWorkspaceGuardedWriteCommit(_)
            | Operation::ProofWorkspaceGuardedWriteAbort(_)
            | Operation::ProofWorkspaceGuardedWriteApply(_)) => {
                Ok(self.execute_guarded_write(operation))
            }
            Operation::Connect(_) => self.transition(pipe, id, false),
            Operation::Disconnect(_) => self.transition(pipe, id, true),
            Operation::InspectTrust(_) => {
                let transport = transport!();
                #[cfg(target_os = "linux")]
                if let Some(jump) = &mut self.jump_picker {
                    return Ok(jump
                        .inspect_trust(transport, self.generation)
                        .map(Outcome::Trust));
                }
                Ok(self.trust.inspect(transport).map(Outcome::Trust))
            }
            Operation::ApproveTrust(approval) => {
                let transport = transport!();
                #[cfg(target_os = "linux")]
                if let Some(jump) = &mut self.jump_picker {
                    return Ok(jump
                        .approve_trust(transport, self.generation, &approval.challenge)
                        .map(Outcome::Trust));
                }
                Ok(self
                    .trust
                    .approve(transport, &approval.challenge)
                    .map(|trust| {
                        self.reconnect.reset();
                        Outcome::Trust(trust)
                    }))
            }
            #[cfg(target_os = "linux")]
            Operation::ProofUnlockSyntheticPosixPassword(_) => {
                Ok(self.unlock_synthetic_posix_password())
            }
            #[cfg(not(target_os = "linux"))]
            Operation::ProofUnlockSyntheticPosixPassword(_) => Ok(Err(ErrorCode::OperationDenied)),
            Operation::ListFolders(list) => {
                let path = list.path.as_deref().filter(|path| !path.is_empty());
                #[cfg(target_os = "linux")]
                let transport = transport!();
                #[cfg(target_os = "linux")]
                if let Some(picker) = &mut self.jump_picker {
                    return Ok(Ok(match picker.list(transport, self.generation, path) {
                        Ok(folders) => {
                            self.reconnect.reset();
                            Outcome::Folders(folders)
                        }
                        Err(error) => Outcome::Error(error),
                    }));
                }
                Ok(self.list_picker_folders(id, path).map(|folders| {
                    self.reconnect.reset();
                    Outcome::Folders(folders)
                }))
            }
            Operation::ListAliases(_) => match &self.authority {
                Some(authority) => Ok(authority.list_aliases().map(Outcome::ProofAliases)),
                None => Ok(transport!().list_aliases().map(Outcome::ProofAliases)),
            },
            Operation::ProofAgentProxyOpen(open) => {
                Ok(self.open_agent_proxy(&open).map(Outcome::ProofAgentProxy))
            }
            Operation::ProofCodexProbe(probe) => Ok(self
                .probe_provider(ProviderKind::Codex, &probe)
                .map(Outcome::ProofCodexVersion)),
            Operation::ProofCodexOpen(open) => Ok(self
                .open_provider(ProviderKind::Codex, &open)
                .map(Outcome::ProofAgentProxy)),
            Operation::ProofPiProbe(probe) => Ok(self
                .probe_provider(ProviderKind::Pi, &probe)
                .map(Outcome::ProofPiVersion)),
            Operation::ProofPiOpen(open) => Ok(self
                .open_provider(ProviderKind::Pi, &open)
                .map(Outcome::ProofAgentProxy)),
            Operation::ProofPeerRelayOpen(open) => Ok(self
                .open_scoped_duplex(ScopedDuplex::Peer(open))
                .map(Outcome::ProofAgentProxy)),
            Operation::ProofGitAdvertisementOpen(open) => Ok(self
                .open_scoped_duplex(ScopedDuplex::Git(open))
                .map(Outcome::ProofAgentProxy)),
            Operation::ProofGitUploadOpen(open) => Ok(self
                .open_scoped_duplex(ScopedDuplex::GitUpload(open))
                .map(Outcome::ProofAgentProxy)),
            Operation::ProofClientRelayOpen(open) => {
                Ok(self.open_client_relay(&open).map(Outcome::ProofAgentProxy))
            }
            Operation::ProofAgentProxyStatus(status) => Ok(self
                .agent_status(&status.lease)
                .map(Outcome::ProofAgentProxy)),
            Operation::ProofAgentProxyClose(close) => Ok(self
                .close_agent_proxy(&close.lease, close.terminate, close.timeout_ms)
                .map(Outcome::ProofAgentProxy)),
            Operation::ProofDeploymentManifestPut(operand) => Ok(self
                .put_manifest(&operand)
                .map(Outcome::ProofDeploymentHostResult)),
            Operation::ProofDeploymentStageBegin(operand) => Ok(self
                .begin_stage(&operand)
                .map(Outcome::ProofDeploymentHostResult)),
            Operation::ProofDeploymentAction(operand) => Ok(self
                .deployment_action(&operand)
                .map(Outcome::ProofDeploymentHostResult)),
            Operation::ProofDeploymentCompletion(operand) => Ok(transport!()
                .read_deployment_completion(&operand)
                .map(Outcome::ProofDeploymentHostResult)),
            Operation::ProofDeploymentHostProbe(operand) => Ok(transport!()
                .probe_deployment_host(&operand)
                .map(Outcome::ProofDeploymentHostResult)),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Operation::ProofWorkspaceReadiness(operand) => Ok(transport!()
                .probe_workspace_readiness(&operand)
                .map(Outcome::ProofWorkspaceReadiness)),
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Operation::ProofWorkspaceReadiness(_) => Ok(Err(ErrorCode::OperationDenied)),
            Operation::ProofWorkspaceModeInspect(operand) => {
                Ok(self.inspect_workspace_mode(operand.root))
            }
            Operation::ProofWorkspaceModePublish(operand) => {
                Ok(self.publish_workspace_mode(operand))
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Operation::ProofOpencodeOpen(operand) => Ok(self.open_opencode(operand)),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Operation::ProofOpencodeStatus(operand) => {
                Ok(self.observe_opencode(&operand.lease, false))
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Operation::ProofOpencodeClose(operand) => {
                Ok(self.observe_opencode(&operand.lease, true))
            }
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Operation::ProofOpencodeOpen(_)
            | Operation::ProofOpencodeStatus(_)
            | Operation::ProofOpencodeClose(_) => Ok(Err(ErrorCode::OperationDenied)),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Operation::GitUploadOpen(operand) => Ok(self.open_git_upload(operand)),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Operation::GitUploadStatus(operand) => {
                Ok(self.observe_git_upload(&operand.lease, false))
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Operation::GitUploadClose(operand) => Ok(self.observe_git_upload(&operand.lease, true)),
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Operation::GitUploadOpen(_)
            | Operation::GitUploadStatus(_)
            | Operation::GitUploadClose(_) => Ok(Err(ErrorCode::OperationDenied)),
            // U15 production Git receive lease (owner/git_receive.rs).
            operation @ (Operation::GitReceiveOpen(_)
            | Operation::GitReceiveStatus(_)
            | Operation::GitReceiveClose(_)) => Ok(self.dispatch_git_receive(operation)),
            // W2 T-backend production leases (owner/backend.rs).
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            operation @ (Operation::DeploymentStepOpen(_)
            | Operation::DeploymentStepStatus(_)
            | Operation::DeploymentStepCancel(_)
            | Operation::ClientRelayLeaseOpen(_)
            | Operation::ClientRelayLeaseStatus(_)
            | Operation::ClientRelayLeaseClose(_)) => Ok(self.dispatch_backend(operation)),
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Operation::DeploymentStepOpen(_)
            | Operation::DeploymentStepStatus(_)
            | Operation::DeploymentStepCancel(_)
            | Operation::ClientRelayLeaseOpen(_)
            | Operation::ClientRelayLeaseStatus(_)
            | Operation::ClientRelayLeaseClose(_) => Ok(Err(ErrorCode::OperationDenied)),
            // W2 T-prov production provider leases (owner/provider_lease.rs).
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            operation @ (Operation::ProbeProvider(_)
            | Operation::ProviderLeaseOpen(_)
            | Operation::ProviderLeaseStatus(_)
            | Operation::ProviderLeaseClose(_)) => Ok(self.execute_provider_lease(operation)),
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Operation::ProbeProvider(_)
            | Operation::ProviderLeaseOpen(_)
            | Operation::ProviderLeaseStatus(_)
            | Operation::ProviderLeaseClose(_) => Ok(Err(ErrorCode::OperationDenied)),
            Operation::ProofGitTrackedPush(operand) => Ok(Ok(self.receive_tracked_push(*operand))),
            Operation::ProofWorkspaceGit(operand) => Ok(transport!()
                .execute_workspace_git(&operand)
                .map(Outcome::ProofWorkspaceGit)),
            Operation::ProofSampleHealth(_) => {
                Ok(self.sample_picker_health(id).map(Outcome::ProofHealth))
            }
            Operation::ProofWorkspaceContentSearch(search) => Ok(transport!()
                .search_workspace_contents(&search)
                .map(Outcome::ProofWorkspaceContentMatches)),
            Operation::ProofWorkspaceSnapshot(list) => {
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                if let Some(inbox) = &mut self.workspace_snapshot_cancel {
                    let Some(transport) = self.transport.as_ref() else {
                        return Ok(Err(ErrorCode::OwnerUnavailable));
                    };
                    return Ok(inbox
                        .run(id, |cancelled| {
                            transport.snapshot_workspace_directory_cancellable(&list, cancelled)
                        })
                        .map(Outcome::ProofWorkspaceSnapshot));
                }
                Ok(transport!()
                    .snapshot_workspace_directory(&list)
                    .map(Outcome::ProofWorkspaceSnapshot))
            }
            Operation::ProofWorkspaceIndex(index) => Ok(transport!()
                .index_workspace(&index)
                .map(Outcome::ProofWorkspaceIndex)),
            Operation::ProofWorkspaceCreate(operand) => Ok(
                super::super::transport::workspace::create::run(transport!(), &operand)
                    .map(Outcome::ProofWorkspaceCreateResult),
            ),
            Operation::ProofWorkspaceCreateDirectory(operand) => Ok(transport!()
                .create_workspace_directory(&operand)
                .map(Outcome::ProofWorkspaceEntryMutation)),
            Operation::ProofWorkspaceDeleteEntry(operand) => Ok(transport!()
                .delete_workspace_entry(&operand)
                .map(Outcome::ProofWorkspaceEntryMutation)),
            // W2 T-files session-FS verbs (`transport/workspace/entry_ops.rs`).
            operation @ (Operation::WorkspaceEntryInfo(_)
            | Operation::WorkspaceRename(_)
            | Operation::WorkspaceAppend(_)) => Ok(
                crate::transport::workspace::entry_ops::dispatch(transport!(), operation),
            ),
            Operation::ProofWorkspaceWriteBegin(operand) => Ok(transport!()
                .begin_workspace_write(&operand)
                .map(Outcome::ProofWorkspaceWriteStage)),
            Operation::ProofWorkspaceWriteChunk(operand) => Ok(transport!()
                .chunk_workspace_write(&operand)
                .map(Outcome::ProofWorkspaceWriteStage)),
            Operation::ProofWorkspaceWriteCommit(operand) => Ok(transport!()
                .commit_workspace_write(&operand)
                .map(Outcome::ProofWorkspaceWriteStage)),
            Operation::ProofWorkspaceWriteAbort(operand) => Ok(transport!()
                .abort_workspace_write(&operand)
                .map(Outcome::ProofWorkspaceWriteStage)),
            Operation::ProofWorkspaceWrite(write) => Ok(transport!()
                .write_workspace(&write)
                .map(|()| Outcome::ProofWorkspaceWritten(crate::v1::Empty {}))),
            Operation::ProofWorkspaceList(list) => Ok(transport!()
                .list_workspace_directory(&list)
                .map(Outcome::ProofWorkspaceDirectory)),
            Operation::ProofWorkspaceRead(read) => Ok(transport!()
                .read_workspace(&read)
                .map(Outcome::ProofWorkspaceFile)),
            // W2 T-term: every terminal verb, fixture and production (see
            // `owner/terminal_dispatch.rs`).
            operation @ (Operation::ProofPrepareTerminal(_)
            | Operation::ProofCancelTerminalReservation(_)
            | Operation::ProofOpenTerminal(_)
            | Operation::ProofTerminalCwd(_)
            | Operation::ProofTerminalReplay(_)
            | Operation::ProofTerminalStatus(_)
            | Operation::ProofCloseTerminal(_)
            | Operation::ProofTerminalInput(_)
            | Operation::ProofTerminalResize(_)
            | Operation::TerminalInspect(_)
            | Operation::ListTerminalShells(_)) => Ok(self.dispatch_terminal(operation)),
            Operation::ProofRunThreadShell(operand) => Ok(transport!()
                .run_thread_shell(&operand)
                .map(Outcome::ProofThreadShell)),
            Operation::ProofRunProviderWorkspaceShell(operand) => Ok(transport!()
                .run_provider_workspace_shell(&operand)
                .map(Outcome::ProofProviderWorkspaceShell)),
            Operation::ProofRunAcpCommand(operand) => Ok(transport!()
                .run_acp_command(&operand)
                .map(Outcome::ProofAcpCommand)),
            // W2 T-shell production exec leases (see `owner/shell_lease.rs`).
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            operation @ (Operation::RunThreadShell(_)
            | Operation::RunProviderWorkspaceShell(_)
            | Operation::RunAcpCommand(_)
            | Operation::RunAcpShell(_)
            | Operation::ShellStatus(_)
            | Operation::ShellClose(_)) => Ok(self.dispatch_shell(operation)),
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Operation::RunThreadShell(_)
            | Operation::RunProviderWorkspaceShell(_)
            | Operation::RunAcpCommand(_)
            | Operation::RunAcpShell(_)
            | Operation::ShellStatus(_)
            | Operation::ShellClose(_) => Ok(Err(ErrorCode::OperationDenied)),
            Operation::ProofAgentAction(operand) => {
                Ok(self.agent_action(&operand).map(Outcome::ProofAgentAction))
            }
            Operation::ProofEnsurePeerCoordinatorKey(_) => {
                let Some(state_dir) = &self.owner_state_dir else {
                    return Ok(Err(ErrorCode::OperationDenied));
                };
                Ok(transport!()
                    .ensure_peer_coordinator_key(state_dir, &self.profile)
                    .map(Outcome::ProofPeerCoordinatorKey))
            }
            Operation::ProofInspectPeerHostKey(operand) => Ok(transport!()
                .inspect_peer_host_key(&operand)
                .map(Outcome::ProofPeerHostKey)),
            // U24 production peer enrollment and relay (owner-wide).
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            operation @ (Operation::EnsurePeerCoordinatorKey(_)
            | Operation::InspectPeerHostKey(_)
            | Operation::ApprovePeerPin(_)
            | Operation::RevokePeerPin(_)) => Ok(self.dispatch_peer_enrollment(operation)),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            operation @ (Operation::PeerRelayOpen(_)
            | Operation::PeerRelayStatus(_)
            | Operation::PeerRelayClose(_)) => Ok(self.dispatch_peer_relay(operation)),
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Operation::EnsurePeerCoordinatorKey(_)
            | Operation::InspectPeerHostKey(_)
            | Operation::ApprovePeerPin(_)
            | Operation::RevokePeerPin(_)
            | Operation::PeerRelayOpen(_)
            | Operation::PeerRelayStatus(_)
            | Operation::PeerRelayClose(_) => Ok(Err(ErrorCode::OperationDenied)),
            // Reserved transfer boundary (C15). Unreachable here; see the early
            // refusal above and `owner/transfer_fixture*.rs` (cfg(test)).
            Operation::ProofTransferStream(_) | Operation::ProofPackagedRsync(_) => {
                Ok(Err(ErrorCode::OperationDenied))
            }
        }
    }
}

#[path = "dispatch.scope.rs"]
mod scope;
use scope::is_agent_control;
pub(super) use scope::needs_storage;
