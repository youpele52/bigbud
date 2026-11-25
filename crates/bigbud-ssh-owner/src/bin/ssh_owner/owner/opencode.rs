//! One approved, one-shot OpenCode fixture lease per owner generation.
use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token,
    owner_opencode_v1::{Outcome as WorkerOutcome, Recipe},
    v1::{ProofOpencodeOpen, ProofOpencodePhase as Phase, ProofOpencodeState},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU16, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const CLOSE_BUDGET: Duration = Duration::from_millis(1750);
const POLL: Duration = Duration::from_millis(5);

pub(super) struct Lease {
    token: Token,
    cancelled: Arc<AtomicBool>,
    port: Arc<AtomicU16>,
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

    fn reply(&mut self) -> Outcome {
        self.observe();
        let mut local_port = None;
        let mut exit_code = None;
        let phase = match self.settled.as_ref() {
            Some(WorkerOutcome::Exited(code)) => match u32::try_from(*code) {
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
            None if self.cancelled.load(Ordering::Acquire) => Phase::Closing,
            None => match self.port.load(Ordering::Acquire) {
                0 => Phase::Starting,
                port => {
                    local_port = Some(u32::from(port));
                    Phase::Ready
                }
            },
        };
        Outcome::ProofOpencode(ProofOpencodeState {
            lease: self.token.to_vec(),
            phase: phase.into(),
            local_port,
            exit_code,
        })
    }

    fn retire(&mut self) -> Result<(), ErrorCode> {
        self.cancelled.store(true, Ordering::Release);
        let deadline = Instant::now() + CLOSE_BUDGET;
        loop {
            self.observe();
            match self.settled.as_ref() {
                Some(WorkerOutcome::Unconfirmed) => return Err(ErrorCode::OutcomeUnknown),
                Some(_) => return Ok(()),
                None if Instant::now() >= deadline => return Err(ErrorCode::OutcomeUnknown),
                None => thread::sleep(POLL),
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.worker.is_some() {
            let _ = self.retire();
        }
    }
}

impl Owner {
    pub(super) fn open_opencode(
        &mut self,
        request: ProofOpencodeOpen,
    ) -> Result<Outcome, ErrorCode> {
        if let Some(scope) = request.service_scope.clone() {
            return self.open_opencode_service(&request, &scope);
        }
        let token: Token = request
            .lease
            .try_into()
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let scope = request.scope.ok_or(ErrorCode::InvalidOperands)?;
        let recipe: Arc<Recipe> = self
            .opencode_recipe
            .as_ref()
            .cloned()
            .ok_or(ErrorCode::OperationDenied)?;
        if self.opencode_lease.is_some() || !recipe.matches(&scope) {
            return Err(ErrorCode::OperationDenied);
        }
        let host = self.transport.host().to_owned();
        let pinned = self.transport.pinned_opencode_v1_ssh()?;
        self.spawn_opencode(token, move |cancelled, port| {
            recipe.run(
                pinned,
                &host,
                |local| {
                    if cancelled.load(Ordering::Acquire) {
                        return false;
                    }
                    port.store(local, Ordering::Release);
                    !cancelled.load(Ordering::Acquire)
                },
                || cancelled.load(Ordering::Acquire),
            )
        })
    }

    /// Product OpenCode v1: the configured executable, the fixed remote endpoint
    /// and the only `-L` forward are owner-selected.
    fn open_opencode_service(
        &mut self,
        request: &ProofOpencodeOpen,
        scope: &crate::v1::ProviderServiceScope,
    ) -> Result<Outcome, ErrorCode> {
        let token: Token = *<&Token>::try_from(request.lease.as_slice())
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let recipe: Arc<crate::owner_opencode_v1::ProductRecipe> = self
            .opencode_service
            .as_ref()
            .cloned()
            .ok_or(ErrorCode::OperationDenied)?;
        if self.opencode_lease.is_some() || !recipe.matches(scope) {
            return Err(ErrorCode::OperationDenied);
        }
        let host = self.transport.host().to_owned();
        let pinned = self.transport.pinned_opencode_v1_ssh()?;
        self.spawn_opencode(token, move |cancelled, port| {
            recipe.run(
                pinned,
                &host,
                |local| {
                    if cancelled.load(Ordering::Acquire) {
                        return false;
                    }
                    port.store(local, Ordering::Release);
                    !cancelled.load(Ordering::Acquire)
                },
                || cancelled.load(Ordering::Acquire),
            )
        })
    }

    fn spawn_opencode(
        &mut self,
        token: Token,
        work: impl FnOnce(Arc<AtomicBool>, Arc<AtomicU16>) -> WorkerOutcome + Send + 'static,
    ) -> Result<Outcome, ErrorCode> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let port = Arc::new(AtomicU16::new(0));
        let stop = Arc::clone(&cancelled);
        let publish = Arc::clone(&port);
        let worker = thread::Builder::new()
            .name("bigbud-opencode-lease".into())
            .spawn(move || work(stop, publish))
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let mut lease = Lease {
            token,
            cancelled,
            port,
            worker: Some(worker),
            settled: None,
        };
        let outcome = lease.reply();
        self.opencode_lease = Some(lease);
        Ok(outcome)
    }

    pub(super) fn observe_opencode(
        &mut self,
        token: &[u8],
        close: bool,
    ) -> Result<Outcome, ErrorCode> {
        let lease = self
            .opencode_lease
            .as_mut()
            .filter(|lease| lease.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)?;
        if close {
            lease.cancelled.store(true, Ordering::Release);
        }
        Ok(lease.reply())
    }

    pub(super) fn revoke_opencode(&mut self) -> Result<(), ErrorCode> {
        self.opencode_lease.as_mut().map_or(Ok(()), Lease::retire)
    }

    pub(super) fn opencode_prevents_connect(&mut self) -> bool {
        self.opencode_lease.as_mut().is_some_and(|lease| {
            lease.observe();
            lease.settled.is_none() || matches!(lease.settled, Some(WorkerOutcome::Unconfirmed))
        })
    }
}
