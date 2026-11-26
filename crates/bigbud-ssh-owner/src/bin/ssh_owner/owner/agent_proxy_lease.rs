//! U25 installed-agent proxy leases, per target and generation.
//!
//! One lease is one `--proxy` session for one registry runtime, as the legacy
//! pinned proxy (`buildPinnedRemoteAgentProxy`). The owner compiles the
//! installed-agent recipe from the validated runtime; that recipe re-verifies
//! the private directories and the SHA-256 of the opened binary before it
//! executes anything. Bytes flow over a per-lease socket through the shared
//! relay worker, so backpressure and half-close match the client relay lane.

use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token,
    owner::lease_worker::{Signals, Worker},
    owner_agent_control,
    owner_agent_proxy::ServiceRecipe,
    owner_backend::relay_worker::{self, Outcome as RelayOutcome},
    owner_git_upload,
    v1::{AgentProxyLeaseOpen, ClientRelayLeaseState, ClientRelayPhase},
};
use std::path::Path;

/// Concurrent proxy sessions per target (pool connections plus recovery).
const MAX_PROXIES: usize = 8;

pub(crate) struct ProxyLease {
    token: Token,
    socket_path: String,
    worker: Worker<RelayOutcome>,
}

impl ProxyLease {
    fn reply(&mut self) -> Result<Outcome, ErrorCode> {
        let mut state = ClientRelayLeaseState {
            lease: self.token.to_vec(),
            ..ClientRelayLeaseState::default()
        };
        let phase = match self.worker.settled() {
            Some(RelayOutcome::Exited(code)) => {
                state.exit_code = Some(code);
                ClientRelayPhase::Exited
            }
            Some(RelayOutcome::Refused) => return Err(ErrorCode::OperationDenied),
            Some(RelayOutcome::Closed) => ClientRelayPhase::Closed,
            Some(RelayOutcome::Lost) => ClientRelayPhase::Lost,
            Some(RelayOutcome::Unconfirmed) => ClientRelayPhase::Unconfirmed,
            None if self.worker.is_streaming() => ClientRelayPhase::Streaming,
            None => {
                state.socket_path = Some(self.socket_path.clone());
                ClientRelayPhase::Listening
            }
        };
        state.phase = phase.into();
        Ok(Outcome::AgentProxyLease(state))
    }

    pub(crate) fn retire(&mut self) -> Option<RelayOutcome> {
        self.worker.retire()
    }
}

impl Owner {
    pub(super) fn open_agent_proxy_lease(
        &mut self,
        open: AgentProxyLeaseOpen,
    ) -> Result<Outcome, ErrorCode> {
        let token = <&Token>::try_from(open.lease.as_slice())
            .copied()
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let runtime = open.runtime.as_ref().ok_or(ErrorCode::InvalidOperands)?;
        owner_agent_control::runtime_operands(runtime)?;
        let recipe = ServiceRecipe::new(
            Path::new(&runtime.binary_path),
            &runtime.sha256,
            Path::new(&runtime.state_path),
        )
        .map_err(|_| ErrorCode::InvalidOperands)?;
        let proxies = &mut self.lanes.agent_control.proxies;
        // Settled, confirmed sessions free their slot; an unconfirmed one keeps it.
        proxies.retain_mut(|proxy| {
            !matches!(
                proxy.worker.settled(),
                Some(
                    RelayOutcome::Exited(_)
                        | RelayOutcome::Closed
                        | RelayOutcome::Lost
                        | RelayOutcome::Refused
                )
            )
        });
        if proxies.iter().any(|proxy| proxy.token == token) {
            return Err(ErrorCode::OperationDenied);
        }
        if proxies.len() >= MAX_PROXIES {
            return Err(ErrorCode::SessionQuota);
        }
        let transport = super::present(&self.transport)?;
        let host = transport.host().to_owned();
        let pinned = transport.pinned_backend_ssh()?;
        let command = recipe.command().to_owned();
        let (socket, listener) =
            owner_git_upload::listen().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let socket_path = socket
            .path()
            .to_str()
            .ok_or(ErrorCode::OwnerUnavailable)?
            .to_owned();
        let worker = Worker::spawn(
            "bigbud-agent-proxy-lease",
            RelayOutcome::Unconfirmed,
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
        )
        .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let proxies = &mut self.lanes.agent_control.proxies;
        proxies.push(ProxyLease {
            token,
            socket_path,
            worker,
        });
        proxies
            .last_mut()
            .ok_or(ErrorCode::OwnerUnavailable)?
            .reply()
    }

    pub(super) fn observe_agent_proxy_lease(
        &mut self,
        token: &[u8],
        close: bool,
    ) -> Result<Outcome, ErrorCode> {
        let proxy = self
            .lanes
            .agent_control
            .proxies
            .iter_mut()
            .find(|proxy| proxy.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)?;
        if close && proxy.worker.retire().is_none() {
            return Err(ErrorCode::OutcomeUnknown);
        }
        proxy.reply()
    }
}
