//! W2 T-prov: production Pi and Codex provider leases, per target and
//! generation.
//!
//! The leases live in the target's lanes, so another target or a stale
//! generation cannot observe or close them, and target retirement reaps them.
//! A target holds at most [`MAX_LEASES`] live sessions (one per provider
//! thread). An open is admitted only after a recognized `--version` probe of
//! the same kind, cwd, resume file and Codex home under the current
//! generation (the target checked exactly that scope), which is the
//! production form of the proof binding's probe-before-start rule.
use super::{ErrorCode, Operation, Outcome, Owner};
use crate::{
    Token,
    owner_agent_proxy::{ProviderKind, recognized_version},
    owner_provider_lease::{self as worker, Channel, Kind, Outcome as WorkerOutcome},
    random_token,
    v1::{ProviderLeasePhase as Phase, ProviderLeaseScope, ProviderLeaseState},
};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// Live provider sessions one target may hold at once.
pub(crate) const MAX_LEASES: usize = 8;
/// Shared deadline for reaping every lease of a target (grace plus kill).
const CLOSE_BUDGET: Duration = Duration::from_millis(1750);
const POLL: Duration = Duration::from_millis(5);

struct Lease {
    token: Token,
    sockets: [String; 2],
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    worker: Option<JoinHandle<WorkerOutcome>>,
    settled: Option<WorkerOutcome>,
}

impl Lease {
    fn observe(&mut self) {
        if self.worker.as_ref().is_some_and(JoinHandle::is_finished) {
            self.settled = self
                .worker
                .take()
                .map(|worker| worker.join().unwrap_or(WorkerOutcome::Unconfirmed));
        }
    }

    fn settled_cleanly(&mut self) -> bool {
        self.observe();
        self.settled
            .is_some_and(|outcome| !matches!(outcome, WorkerOutcome::Unconfirmed))
    }

    fn reply(&mut self) -> Outcome {
        self.observe();
        let (mut stdio, mut stderr, mut exit_code) = (None, None, None);
        let phase = match self.settled {
            Some(WorkerOutcome::Exited(code)) => match u32::try_from(code) {
                Ok(code) if code <= 254 => {
                    exit_code = Some(code);
                    Phase::Exited
                }
                _ => Phase::Lost,
            },
            Some(WorkerOutcome::Cancelled) => Phase::Closed,
            Some(WorkerOutcome::Lost) => Phase::Lost,
            Some(WorkerOutcome::Rejected(_)) => Phase::Rejected,
            Some(WorkerOutcome::Unconfirmed) => Phase::Unconfirmed,
            None if self.running.load(Ordering::Acquire) => Phase::Running,
            None => {
                let [io, err] = &self.sockets;
                stdio = Some(io.clone());
                stderr = Some(err.clone());
                Phase::Listening
            }
        };
        Outcome::ProviderLease(ProviderLeaseState {
            lease: self.token.to_vec(),
            phase: phase.into(),
            stdio_socket_path: stdio,
            stderr_socket_path: stderr,
            exit_code,
        })
    }
}

/// The exact scope a recognized probe checked on the target: kind,
/// generation, cwd, resume file and Codex home. An open must match one.
#[derive(Clone, PartialEq, Eq)]
struct Armed {
    kind: Kind,
    generation: Token,
    cwd: String,
    session_file: Option<String>,
    codex_home: Option<String>,
}

impl Armed {
    fn new(kind: Kind, generation: Token, scope: &ProviderLeaseScope) -> Self {
        Self {
            kind,
            generation,
            cwd: scope.cwd.clone(),
            session_file: scope.session_file.clone(),
            codex_home: scope.codex_home.clone(),
        }
    }
}

/// Recently armed scopes kept per target; the oldest is forgotten first.
const MAX_ARMED: usize = 2 * MAX_LEASES;

/// One target's provider leases and its probe-armed scopes.
#[derive(Default)]
pub(crate) struct Leases {
    entries: Vec<Lease>,
    armed: VecDeque<Armed>,
}

impl Leases {
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// Confirmed teardown of every lease: all are cancelled first, then
    /// awaited under one shared deadline. Any unconfirmed lease stays and the
    /// target reports `OutcomeUnknown`.
    pub(crate) fn revoke(&mut self) -> Result<(), ErrorCode> {
        self.armed.clear();
        for lease in &self.entries {
            lease.cancelled.store(true, Ordering::Release);
        }
        let deadline = Instant::now() + CLOSE_BUDGET;
        while self.entries.iter_mut().any(|lease| {
            lease.observe();
            lease.settled.is_none()
        }) && Instant::now() < deadline
        {
            thread::sleep(POLL);
        }
        self.entries.retain_mut(|lease| !lease.settled_cleanly());
        if self.entries.is_empty() {
            Ok(())
        } else {
            Err(ErrorCode::OutcomeUnknown)
        }
    }

    /// Arms one checked scope (or disarms it when the probe failed).
    fn arm(&mut self, armed: Armed, recognized: bool) {
        self.armed.retain(|existing| *existing != armed);
        if recognized {
            if self.armed.len() >= MAX_ARMED {
                self.armed.pop_front();
            }
            self.armed.push_back(armed);
        }
    }

    fn is_armed(&self, armed: &Armed) -> bool {
        self.armed.contains(armed)
    }

    fn find(&mut self, token: &[u8]) -> Result<&mut Lease, ErrorCode> {
        self.entries
            .iter_mut()
            .find(|lease| lease.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)
    }
}

impl Drop for Leases {
    fn drop(&mut self) {
        if !self.entries.is_empty() {
            let _unconfirmed = self.revoke();
        }
    }
}

/// The four production provider verbs, admitted on every POSIX production
/// owner. The remote guard requires a Linux target.
pub(crate) fn production_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::ProbeProvider(_)
            | Operation::ProviderLeaseOpen(_)
            | Operation::ProviderLeaseStatus(_)
            | Operation::ProviderLeaseClose(_)
    )
}

fn provider_kind(kind: Kind) -> ProviderKind {
    match kind {
        Kind::Pi => ProviderKind::Pi,
        Kind::Codex => ProviderKind::Codex,
    }
}

fn hex(token: &Token) -> String {
    token.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Owner {
    /// Dispatches the four production provider verbs.
    pub(super) fn execute_provider_lease(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        match operation {
            Operation::ProbeProvider(probe) => {
                let scope = probe.scope.ok_or(ErrorCode::InvalidOperands)?;
                let kind = worker::admits(&scope, true)?;
                let nonce = hex(&random_token().map_err(|_| ErrorCode::OwnerUnavailable)?);
                let generation = self.generation;
                let transport = super::present(&self.transport)?;
                let armed = Armed::new(kind, generation, &scope);
                self.lanes.providers.arm(armed.clone(), false);
                let version = transport.probe_provider_lease(kind, &scope, &nonce)?;
                let recognized =
                    version.code == 0 && recognized_version(provider_kind(kind), &version.stdout);
                self.lanes.providers.arm(armed, recognized);
                Ok(Outcome::ProviderVersion(version))
            }
            Operation::ProviderLeaseOpen(open) => self.open_provider_lease(open),
            Operation::ProviderLeaseStatus(handle) => {
                observe(self.lanes.providers.find(&handle.lease)?)
            }
            Operation::ProviderLeaseClose(handle) => {
                let lease = self.lanes.providers.find(&handle.lease)?;
                lease.cancelled.store(true, Ordering::Release);
                let deadline = Instant::now() + CLOSE_BUDGET;
                while !lease.settled_cleanly() && Instant::now() < deadline {
                    thread::sleep(POLL);
                }
                observe(lease)
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    fn open_provider_lease(
        &mut self,
        request: crate::v1::ProviderLeaseOpen,
    ) -> Result<Outcome, ErrorCode> {
        let token: Token = *<&Token>::try_from(request.lease.as_slice())
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let scope = request.scope.ok_or(ErrorCode::InvalidOperands)?;
        let kind = worker::admits(&scope, false)?;
        let providers = &mut self.lanes.providers;
        if !providers.is_armed(&Armed::new(kind, self.generation, &scope))
            || providers.entries.iter().any(|lease| lease.token == token)
        {
            return Err(ErrorCode::OperationDenied);
        }
        if providers.entries.len() >= MAX_LEASES {
            // Free the oldest cleanly settled lease; a live or unconfirmed
            // lease keeps its slot.
            let settled = providers
                .entries
                .iter_mut()
                .position(Lease::settled_cleanly);
            let Some(index) = settled else {
                return Err(ErrorCode::SessionQuota);
            };
            providers.entries.remove(index);
        }
        let transport = super::present(&self.transport)?;
        let host = transport.host().to_owned();
        let pinned = transport.pinned_provider_ssh()?;
        let nonce = hex(&random_token().map_err(|_| ErrorCode::OwnerUnavailable)?);
        let command = worker::remote_command(kind, &scope, &nonce, true);
        let channels = [Channel::listen(), Channel::listen()];
        let [Ok(stdio), Ok(stderr)] = channels else {
            return Err(ErrorCode::OwnerUnavailable);
        };
        let sockets = match (stdio.path(), stderr.path()) {
            (Some(io), Some(err)) => [io, err],
            _ => return Err(ErrorCode::OwnerUnavailable),
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(false));
        let (stop, started) = (Arc::clone(&cancelled), Arc::clone(&running));
        let handle = thread::Builder::new()
            .name("bigbud-provider-lease".into())
            .spawn(move || {
                worker::run(
                    pinned,
                    &host,
                    &command,
                    [stdio, stderr],
                    || stop.load(Ordering::Acquire),
                    || started.store(true, Ordering::Release),
                )
            })
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let mut lease = Lease {
            token,
            sockets,
            cancelled,
            running,
            worker: Some(handle),
            settled: None,
        };
        let outcome = lease.reply();
        self.lanes.providers.entries.push(lease);
        Ok(outcome)
    }
}

/// The lease state, or the typed reason a spawn was refused.
fn observe(lease: &mut Lease) -> Result<Outcome, ErrorCode> {
    let reply = lease.reply();
    match lease.settled {
        Some(WorkerOutcome::Rejected(code)) => Err(code),
        _ => Ok(reply),
    }
}

#[cfg(test)]
#[path = "provider_lease.tests.rs"]
mod tests;
