//! W2 T-backend production leases, per target and generation.
//!
//! Each target holds at most one deployment step lease and a bounded set of
//! client relay channels in its own lanes, so a stale generation or another
//! target cannot observe, cancel or close them, and target retirement reaps
//! them. A lease token is the operation's identity: re-opening the same token
//! or reading its status returns the retained outcome and never dispatches
//! the step again.

use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token,
    owner_agent_proxy::relay::Recipe as RelayRecipe,
    owner_backend::{
        deployment_recipe,
        deployment_worker::{self, Settled},
        relay_worker::{self, Outcome as RelayOutcome},
    },
    owner_git_upload,
    v1::{
        ClientRelayLeaseOpen, ClientRelayLeaseState, ClientRelayPhase, DeploymentStepOpen,
        DeploymentStepPhase, DeploymentStepState, request::Operation,
    },
};
use std::path::Path;

/// Concurrent relay channels per target (an HTTP agent keeps a few sockets).
const MAX_RELAY_CHANNELS: usize = 8;

struct DeploymentLease {
    worker: Worker<Settled>,
    kind: i32,
    request_id: String,
}

#[derive(Default)]
pub(crate) struct BackendLanes {
    deployment: Option<DeploymentLease>,
    relays: Vec<Worker<RelayOutcome>>,
}

impl BackendLanes {
    /// Confirmed teardown of every backend lease this target owns.
    pub(crate) fn revoke(&mut self) -> Result<(), ErrorCode> {
        let mut result = Ok(());
        if let Some(lease) = &mut self.deployment
            && lease.worker.retire().is_none()
        {
            result = Err(ErrorCode::OutcomeUnknown);
        }
        for relay in &mut self.relays {
            match relay.retire() {
                Some(RelayOutcome::Unconfirmed) | None => result = Err(ErrorCode::OutcomeUnknown),
                Some(_) => {}
            }
        }
        result
    }
}

impl DeploymentLease {
    fn reply(&mut self) -> Result<Outcome, ErrorCode> {
        let mut state = DeploymentStepState {
            lease: self.worker.token.to_vec(),
            kind: self.kind,
            request_id: self.request_id.clone(),
            ..DeploymentStepState::default()
        };
        let phase = match self.worker.observe() {
            Some(Settled::Exited {
                code,
                stdout,
                stderr,
            }) => {
                state.exit_code = Some(code);
                state.stdout = stdout;
                state.stderr = stderr;
                DeploymentStepPhase::Exited
            }
            Some(Settled::Cancelled) => DeploymentStepPhase::Cancelled,
            Some(Settled::Unknown) => DeploymentStepPhase::OutcomeUnknown,
            Some(Settled::Rejected(code)) => return Err(code),
            // A step without streamed input is dispatched as soon as it is opened.
            None if self.worker.started() || self.worker.socket_path.is_none() => {
                DeploymentStepPhase::Running
            }
            None => {
                state.socket_path = self.worker.socket_path.clone();
                DeploymentStepPhase::Listening
            }
        };
        state.phase = phase.into();
        Ok(Outcome::DeploymentStep(state))
    }
}

fn relay_reply(worker: &mut Worker<RelayOutcome>) -> Result<Outcome, ErrorCode> {
    let mut state = ClientRelayLeaseState {
        lease: worker.token.to_vec(),
        ..ClientRelayLeaseState::default()
    };
    let phase = match worker.observe() {
        Some(RelayOutcome::Exited(code)) => {
            state.exit_code = Some(code);
            ClientRelayPhase::Exited
        }
        Some(RelayOutcome::Refused) => return Err(ErrorCode::OperationDenied),
        Some(RelayOutcome::Closed) => ClientRelayPhase::Closed,
        Some(RelayOutcome::Lost) => ClientRelayPhase::Lost,
        Some(RelayOutcome::Unconfirmed) => ClientRelayPhase::Unconfirmed,
        None if worker.started() => ClientRelayPhase::Streaming,
        None => {
            state.socket_path = worker.socket_path.clone();
            ClientRelayPhase::Listening
        }
    };
    state.phase = phase.into();
    Ok(Outcome::ClientRelayLease(state))
}

fn lease_token(bytes: &[u8]) -> Result<Token, ErrorCode> {
    <&Token>::try_from(bytes)
        .copied()
        .map_err(|_| ErrorCode::InvalidOperands)
}

fn listen() -> Result<
    (
        crate::owner_opencode::ForwardSocket,
        std::os::unix::net::UnixListener,
        String,
    ),
    ErrorCode,
> {
    let (socket, listener) = owner_git_upload::listen().map_err(|_| ErrorCode::OwnerUnavailable)?;
    let path = socket
        .path()
        .to_str()
        .ok_or(ErrorCode::OwnerUnavailable)?
        .to_owned();
    Ok((socket, listener, path))
}

/// The T-backend verbs a production owner admits on macOS and Linux hosts.
pub(super) fn production_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::DeploymentStepOpen(_)
            | Operation::DeploymentStepStatus(_)
            | Operation::DeploymentStepCancel(_)
            | Operation::ClientRelayLeaseOpen(_)
            | Operation::ClientRelayLeaseStatus(_)
            | Operation::ClientRelayLeaseClose(_)
    )
}

impl Owner {
    pub(super) fn dispatch_backend(&mut self, operation: Operation) -> Result<Outcome, ErrorCode> {
        match operation {
            Operation::DeploymentStepOpen(open) => self.open_deployment_step(open),
            Operation::DeploymentStepStatus(lease) => {
                self.observe_deployment_step(&lease.lease, false)
            }
            Operation::DeploymentStepCancel(lease) => {
                self.observe_deployment_step(&lease.lease, true)
            }
            Operation::ClientRelayLeaseOpen(open) => self.open_client_relay_lease(open),
            Operation::ClientRelayLeaseStatus(lease) => {
                self.observe_client_relay_lease(&lease.lease, false)
            }
            Operation::ClientRelayLeaseClose(lease) => {
                self.observe_client_relay_lease(&lease.lease, true)
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    pub(super) fn open_deployment_step(
        &mut self,
        open: DeploymentStepOpen,
    ) -> Result<Outcome, ErrorCode> {
        let token = lease_token(&open.lease)?;
        if let Some(lease) = &mut self.lanes.backend.deployment {
            // The same token reattaches; it never runs the step a second time.
            if lease.worker.token == token {
                return lease.reply();
            }
            if lease.worker.observe().is_none() {
                return Err(ErrorCode::OperationDenied);
            }
        }
        let recipe = deployment_recipe::recipe(&open)?;
        self.lanes.backend.deployment = None;
        let transport = super::present(&self.transport)?;
        let host = transport.host().to_owned();
        let pinned = transport.pinned_backend_ssh()?;
        let (input, socket_path) = if recipe.streamed_input {
            let (socket, listener, path) = listen()?;
            (Some((socket, listener)), Some(path))
        } else {
            (None, None)
        };
        let worker = Worker::spawn(
            token,
            socket_path,
            Settled::Unknown,
            "bigbud-deployment-step",
            move |signals: Signals| {
                deployment_worker::run(
                    pinned,
                    &host,
                    recipe,
                    input,
                    || signals.cancelled(),
                    || signals.streaming(),
                )
            },
        )?;
        let lease = self.lanes.backend.deployment.insert(DeploymentLease {
            worker,
            kind: open.kind,
            request_id: open.request_id,
        });
        lease.reply()
    }

    pub(super) fn observe_deployment_step(
        &mut self,
        token: &[u8],
        cancel: bool,
    ) -> Result<Outcome, ErrorCode> {
        let lease = self
            .lanes
            .backend
            .deployment
            .as_mut()
            .filter(|lease| lease.worker.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)?;
        if cancel && lease.worker.retire().is_none() {
            return Err(ErrorCode::OutcomeUnknown);
        }
        lease.reply()
    }

    pub(super) fn open_client_relay_lease(
        &mut self,
        open: ClientRelayLeaseOpen,
    ) -> Result<Outcome, ErrorCode> {
        let token = lease_token(&open.lease)?;
        let recipe = RelayRecipe::new(
            Path::new(&open.node_binary),
            &open.node_sha256,
            Path::new(&open.helper_entry),
            &open.helper_sha256,
            &open.authority_id,
        )
        .map_err(|_| ErrorCode::InvalidOperands)?;
        let relays = &mut self.lanes.backend.relays;
        // Settled, confirmed channels free their slot; an unconfirmed one keeps it.
        relays.retain_mut(|relay| {
            !matches!(
                relay.observe(),
                Some(
                    RelayOutcome::Exited(_)
                        | RelayOutcome::Closed
                        | RelayOutcome::Lost
                        | RelayOutcome::Refused
                )
            )
        });
        if relays.iter().any(|relay| relay.token == token) {
            return Err(ErrorCode::OperationDenied);
        }
        if relays.len() >= MAX_RELAY_CHANNELS {
            return Err(ErrorCode::SessionQuota);
        }
        let transport = super::present(&self.transport)?;
        let host = transport.host().to_owned();
        let pinned = transport.pinned_backend_ssh()?;
        let command = recipe.command().to_owned();
        let (socket, listener, path) = listen()?;
        let mut worker = Worker::spawn(
            token,
            Some(path),
            RelayOutcome::Unconfirmed,
            "bigbud-client-relay",
            move |signals: Signals| {
                relay_worker::run(
                    pinned,
                    &host,
                    &command,
                    socket,
                    listener,
                    || signals.cancelled(),
                    || signals.streaming(),
                )
            },
        )?;
        let reply = relay_reply(&mut worker);
        self.lanes.backend.relays.push(worker);
        reply
    }

    pub(super) fn observe_client_relay_lease(
        &mut self,
        token: &[u8],
        close: bool,
    ) -> Result<Outcome, ErrorCode> {
        let relay = self
            .lanes
            .backend
            .relays
            .iter_mut()
            .find(|relay| relay.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)?;
        if close && relay.retire().is_none() {
            return Err(ErrorCode::OutcomeUnknown);
        }
        relay_reply(relay)
    }
}

#[path = "backend.worker.rs"]
mod worker;
use super::lease_worker::Signals;
use worker::Worker;

#[cfg(test)]
#[path = "backend.tests.rs"]
mod tests;
