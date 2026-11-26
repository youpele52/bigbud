//! U25 remote-agent control leases, per target and generation.
//!
//! Each target holds at most [`MAX_RUNNING`] dispatched control leases and
//! retains the last [`MAX_RETAINED`] outcomes in its own lanes, so a stale
//! generation or another target cannot observe or cancel them and target
//! retirement reaps them. A lease token is the operation's identity: opening
//! the same token again or reading its status returns the retained outcome and
//! never runs the kind a second time.

use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token,
    owner::lease_worker::{Signals, Worker},
    owner_agent_control,
    owner_backend::deployment_worker::{self, Settled},
    owner_backend::relay_worker::Outcome as RelayOutcome,
    owner_git_upload,
    owner_opencode::ForwardSocket,
    v1::{AgentControlOpen, AgentControlPhase, AgentControlState, request::Operation},
};
use std::{collections::VecDeque, os::unix::net::UnixListener};

/// Concurrent control scripts per target (the legacy manager serializes most).
const MAX_RUNNING: usize = 4;
/// Settled outcomes kept for reattach; the oldest settled one is dropped first.
const MAX_RETAINED: usize = 64;

struct Lease {
    token: Token,
    kind: i32,
    socket_path: Option<String>,
    worker: Worker<Settled>,
}

#[derive(Default)]
pub(crate) struct AgentControlLanes {
    leases: VecDeque<Lease>,
    /// Installed-agent proxy sessions (owner/agent_proxy_lease.rs).
    pub(super) proxies: Vec<super::agent_proxy_lease::ProxyLease>,
}

impl AgentControlLanes {
    /// Confirmed teardown of every running control lease of this target.
    pub(crate) fn revoke(&mut self) -> Result<(), ErrorCode> {
        let mut result = Ok(());
        for lease in &mut self.leases {
            if lease.worker.retire().is_none() {
                result = Err(ErrorCode::OutcomeUnknown);
            }
        }
        for proxy in &mut self.proxies {
            match proxy.retire() {
                Some(RelayOutcome::Unconfirmed) | None => result = Err(ErrorCode::OutcomeUnknown),
                Some(_) => {}
            }
        }
        result
    }

    fn find(&mut self, token: &[u8]) -> Option<&mut Lease> {
        self.leases
            .iter_mut()
            .find(|lease| lease.token.as_slice() == token)
    }

    /// Make room for one more lease: a full running set refuses, and the
    /// oldest settled outcome is dropped once the retained set is full.
    fn admit(&mut self) -> Result<(), ErrorCode> {
        let running = self
            .leases
            .iter_mut()
            .filter_map(|lease| lease.worker.settled().is_none().then_some(()))
            .count();
        if running >= MAX_RUNNING {
            return Err(ErrorCode::SessionQuota);
        }
        if self.leases.len() >= MAX_RETAINED {
            let index = self
                .leases
                .iter_mut()
                .position(|lease| lease.worker.settled().is_some())
                .ok_or(ErrorCode::SessionQuota)?;
            self.leases.remove(index);
        }
        Ok(())
    }
}

impl Lease {
    fn reply(&mut self) -> Result<Outcome, ErrorCode> {
        let mut state = AgentControlState {
            lease: self.token.to_vec(),
            kind: self.kind,
            ..AgentControlState::default()
        };
        let phase = match self.worker.settled() {
            Some(Settled::Exited {
                code,
                stdout,
                stderr,
            }) => {
                state.exit_code = Some(code);
                state.stdout = stdout;
                state.stderr = stderr;
                AgentControlPhase::Exited
            }
            Some(Settled::Cancelled) => AgentControlPhase::Cancelled,
            Some(Settled::Unknown) => AgentControlPhase::OutcomeUnknown,
            Some(Settled::Rejected(code)) => return Err(code),
            None if self.worker.is_streaming() || self.socket_path.is_none() => {
                AgentControlPhase::Running
            }
            None => {
                state.socket_path = self.socket_path.clone();
                AgentControlPhase::Listening
            }
        };
        state.phase = phase.into();
        Ok(Outcome::AgentControl(state))
    }
}

fn listen() -> Result<(ForwardSocket, UnixListener, String), ErrorCode> {
    let (socket, listener) = owner_git_upload::listen().map_err(|_| ErrorCode::OwnerUnavailable)?;
    let path = socket
        .path()
        .to_str()
        .ok_or(ErrorCode::OwnerUnavailable)?
        .to_owned();
    Ok((socket, listener, path))
}

/// The U25 verbs a production owner admits on macOS and Linux hosts.
pub(super) fn production_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::AgentControlOpen(_)
            | Operation::AgentControlStatus(_)
            | Operation::AgentControlCancel(_)
            | Operation::AgentProxyLeaseOpen(_)
            | Operation::AgentProxyLeaseStatus(_)
            | Operation::AgentProxyLeaseClose(_)
    )
}

impl Owner {
    pub(super) fn dispatch_agent_control(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        match operation {
            Operation::AgentControlOpen(open) => self.open_agent_control(*open),
            Operation::AgentControlStatus(lease) => self.observe_agent_control(&lease.lease, false),
            Operation::AgentControlCancel(lease) => self.observe_agent_control(&lease.lease, true),
            Operation::AgentProxyLeaseOpen(open) => self.open_agent_proxy_lease(open),
            Operation::AgentProxyLeaseStatus(lease) => {
                self.observe_agent_proxy_lease(&lease.lease, false)
            }
            Operation::AgentProxyLeaseClose(lease) => {
                self.observe_agent_proxy_lease(&lease.lease, true)
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    fn open_agent_control(&mut self, open: AgentControlOpen) -> Result<Outcome, ErrorCode> {
        let token = <&Token>::try_from(open.lease.as_slice())
            .copied()
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let lanes = &mut self.lanes.agent_control;
        if let Some(lease) = lanes.find(&token) {
            // The same token reattaches; it never runs the kind a second time.
            return lease.reply();
        }
        let recipe = owner_agent_control::recipe(&open)?;
        lanes.admit()?;
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
            "bigbud-agent-control",
            Settled::Unknown,
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
        )
        .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let lanes = &mut self.lanes.agent_control;
        lanes.leases.push_back(Lease {
            token,
            kind: open.kind,
            socket_path,
            worker,
        });
        lanes
            .leases
            .back_mut()
            .ok_or(ErrorCode::OwnerUnavailable)?
            .reply()
    }

    fn observe_agent_control(&mut self, token: &[u8], cancel: bool) -> Result<Outcome, ErrorCode> {
        let lease = self
            .lanes
            .agent_control
            .find(token)
            .ok_or(ErrorCode::OperationDenied)?;
        if cancel && lease.worker.retire().is_none() {
            return Err(ErrorCode::OutcomeUnknown);
        }
        lease.reply()
    }
}

#[cfg(test)]
#[path = "agent_control.tests.rs"]
mod tests;
