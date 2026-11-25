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
            #[cfg(target_os = "linux")]
            Operation::ProofOpencodeOpen(operand) => Ok(self.open_opencode(operand)),
            #[cfg(target_os = "linux")]
            Operation::ProofOpencodeStatus(operand) => {
                Ok(self.observe_opencode(&operand.lease, false))
            }
            #[cfg(target_os = "linux")]
            Operation::ProofOpencodeClose(operand) => {
                Ok(self.observe_opencode(&operand.lease, true))
            }
            #[cfg(not(target_os = "linux"))]
            Operation::ProofOpencodeOpen(_)
            | Operation::ProofOpencodeStatus(_)
            | Operation::ProofOpencodeClose(_) => Ok(Err(ErrorCode::OperationDenied)),
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
            Operation::ProofPrepareTerminal(request) => Ok(self
                .prepare_terminal(request)
                .map(Outcome::ProofTerminalReservation)),
            Operation::ProofCancelTerminalReservation(request) => Ok(self
                .cancel_terminal_reservation(&request.lease)
                .map(Outcome::ProofTerminalReservation)),
            Operation::ProofOpenTerminal(request) => Ok(self
                .open_terminal(&request.lease)
                .map(Outcome::ProofTerminal)),
            Operation::ProofTerminalCwd(request) => Ok(transport!()
                .probe_terminal_cwd(request)
                .map(Outcome::ProofTerminalCwd)),
            Operation::ProofTerminalReplay(request) => Ok(self
                .replay_terminal(&request.lease, request.after_sequence)
                .map(Outcome::ProofTerminalReplay)),
            Operation::ProofTerminalStatus(handle) => Ok(self
                .terminal_status(&handle.lease)
                .map(Outcome::ProofTerminal)),
            Operation::ProofCloseTerminal(handle) => Ok(self
                .close_terminal(&handle.lease)
                .map(Outcome::ProofTerminal)),
            Operation::ProofTerminalInput(input) => Ok(self
                .write_terminal_input(&input.lease, input.sequence, &input.data)
                .and_then(|()| self.terminal_status(&input.lease))
                .map(Outcome::ProofTerminal)),
            Operation::ProofTerminalResize(input) => Ok(self
                .leased_terminal(&input.lease)
                .and_then(|terminal| {
                    let cols = u16::try_from(input.cols).map_err(|_| ErrorCode::InvalidOperands)?;
                    let rows = u16::try_from(input.rows).map_err(|_| ErrorCode::InvalidOperands)?;
                    terminal.resize_proof_terminal(cols, rows)
                })
                .and_then(|()| self.terminal_status(&input.lease))
                .map(Outcome::ProofTerminal)),
            Operation::ProofRunThreadShell(operand) => Ok(transport!()
                .run_thread_shell(&operand)
                .map(Outcome::ProofThreadShell)),
            Operation::ProofRunProviderWorkspaceShell(operand) => Ok(transport!()
                .run_provider_workspace_shell(&operand)
                .map(Outcome::ProofProviderWorkspaceShell)),
            Operation::ProofRunAcpCommand(operand) => Ok(transport!()
                .run_acp_command(&operand)
                .map(Outcome::ProofAcpCommand)),
            Operation::ProofAgentAction(operand) => {
                Ok(self.agent_action(&operand).map(Outcome::ProofAgentAction))
            }
            Operation::ProofEnsurePeerCoordinatorKey(_) => {
                let Some(state_dir) = &self.peer_state_dir else {
                    return Ok(Err(ErrorCode::OperationDenied));
                };
                Ok(transport!()
                    .ensure_peer_coordinator_key(state_dir, &self.profile)
                    .map(Outcome::ProofPeerCoordinatorKey))
            }
            Operation::ProofInspectPeerHostKey(operand) => Ok(transport!()
                .inspect_peer_host_key(&operand)
                .map(Outcome::ProofPeerHostKey)),
            // Reserved transfer boundary (C15). Unreachable here; see the early
            // refusal above and `owner/transfer_fixture*.rs` (cfg(test)).
            Operation::ProofTransferStream(_) | Operation::ProofPackagedRsync(_) => {
                Ok(Err(ErrorCode::OperationDenied))
            }
        }
    }
}

/// Lease-local control reads or closes an owner-owned resource; it opens no
/// transport and never needs the target's durable state.
fn is_agent_control(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::ProofAgentProxyStatus(_)
            | Operation::ProofAgentProxyClose(_)
            | Operation::ProofOpencodeStatus(_)
            | Operation::ProofOpencodeClose(_)
    )
}

/// Operations that must hydrate the target's durable state before dispatch.
/// Local-only enrollment reads, lease control and owner-scoped alias discovery
/// carry no network admission and are excluded.
pub(super) fn needs_storage(operation: &Operation) -> bool {
    !(is_agent_control(operation)
        || matches!(
            operation,
            Operation::ProofEnsurePeerCoordinatorKey(_) | Operation::ListAliases(_)
        ))
}
