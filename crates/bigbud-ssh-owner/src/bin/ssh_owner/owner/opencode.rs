//! One approved, one-shot OpenCode lease per owner target and generation.
//!
//! Only the owner-selected OpenCode v2 recipe uses this lane (the v1 SSH
//! transport is retired). The worker publishes exactly one ready result, and
//! only that result may carry a credential. The credential is cleared as soon
//! as the lease settles, is revoked, or is lost.
use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token,
    owner_opencode::{Outcome as WorkerOutcome, ReadyPort},
    owner_opencode_v2::ProductRecipe as V2Recipe,
    v1::{ProofOpencodeOpen, ProofOpencodePhase as Phase, ProofOpencodeState},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU16, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const CLOSE_BUDGET: Duration = Duration::from_millis(1750);
const POLL: Duration = Duration::from_millis(5);

/// Published readiness for one worker. The credential is written before the
/// port so that a visible port always has its exact secret.
#[derive(Default)]
struct Publication {
    port: AtomicU16,
    password: Mutex<Option<String>>,
}

impl Publication {
    fn publish(&self, ready: ReadyPort) -> bool {
        let Ok(mut password) = self.password.lock() else {
            return false;
        };
        *password = ready.secret;
        self.port.store(ready.port, Ordering::Release);
        true
    }

    fn secret(&self) -> Option<String> {
        self.password.lock().ok().and_then(|slot| slot.clone())
    }

    fn forget(&self) {
        if let Ok(mut slot) = self.password.lock() {
            *slot = None;
        }
    }
}

pub(super) struct Lease {
    token: Token,
    cancelled: Arc<AtomicBool>,
    published: Arc<Publication>,
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
            // No settled lease retains a credential.
            self.published.forget();
        }
    }

    fn reply(&mut self) -> Outcome {
        self.observe();
        let mut local_port = None;
        let mut exit_code = None;
        let mut password = None;
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
            None => match self.published.port.load(Ordering::Acquire) {
                0 => Phase::Starting,
                port => {
                    local_port = Some(u32::from(port));
                    password = self.published.secret();
                    Phase::Ready
                }
            },
        };
        if !matches!(phase, Phase::Ready) {
            self.published.forget();
        }
        Outcome::ProofOpencode(ProofOpencodeState {
            lease: self.token.to_vec(),
            phase: phase.into(),
            local_port,
            exit_code,
            password,
        })
    }

    pub(super) fn retire(&mut self) -> Result<(), ErrorCode> {
        self.cancelled.store(true, Ordering::Release);
        self.published.forget();
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
    /// A request without a v2 service scope (the retired v1 fixture and
    /// product transports) is refused before any lane or SSH child exists.
    pub(super) fn open_opencode(
        &mut self,
        request: ProofOpencodeOpen,
    ) -> Result<Outcome, ErrorCode> {
        match request.service_scope.clone() {
            Some(scope) if scope.transport() == crate::v1::ProviderServiceTransport::V2 => {
                self.open_opencode_v2(&request, &scope)
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    /// Product OpenCode v2: the configured executable, `serve --stdio` argv,
    /// remote port, local listener, forward spec and credential are all
    /// owner-selected. The request names only the authorized workspace.
    fn open_opencode_v2(
        &mut self,
        request: &ProofOpencodeOpen,
        scope: &crate::v1::ProviderServiceScope,
    ) -> Result<Outcome, ErrorCode> {
        let token: Token = *<&Token>::try_from(request.lease.as_slice())
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let recipe: Arc<V2Recipe> = self
            .opencode_v2
            .as_ref()
            .cloned()
            .ok_or(ErrorCode::OperationDenied)?;
        self.reclaim_settled_opencode();
        if self.lanes.opencode.is_some() || !recipe.matches(scope) {
            return Err(ErrorCode::OperationDenied);
        }
        let host = super::present(&self.transport)?.host().to_owned();
        let pinned = super::present(&self.transport)?.pinned_opencode_ssh()?;
        // `matches` admitted this exact cwd; the remote guard re-checks it.
        let cwd = scope.cwd.clone();
        self.spawn_opencode(token, move |cancelled, published| {
            recipe.run(
                &cwd,
                pinned,
                &host,
                |ready| publish(&cancelled, &published, ready),
                || cancelled.load(Ordering::Acquire),
            )
        })
    }

    /// A lease whose teardown was confirmed (closed, exited, lost, rejected)
    /// frees this target's lane, so the same target can start a new server.
    /// An unconfirmed or still-running lease keeps the lane occupied.
    fn reclaim_settled_opencode(&mut self) {
        let settled = self.lanes.opencode.as_mut().is_some_and(|lease| {
            lease.observe();
            lease
                .settled
                .as_ref()
                .is_some_and(|outcome| !matches!(outcome, WorkerOutcome::Unconfirmed))
        });
        if settled {
            self.lanes.opencode = None;
        }
    }

    fn spawn_opencode(
        &mut self,
        token: Token,
        work: impl FnOnce(Arc<AtomicBool>, Arc<Publication>) -> WorkerOutcome + Send + 'static,
    ) -> Result<Outcome, ErrorCode> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let published = Arc::new(Publication::default());
        let stop = Arc::clone(&cancelled);
        let publish = Arc::clone(&published);
        let worker = thread::Builder::new()
            .name("bigbud-opencode-lease".into())
            .spawn(move || work(stop, publish))
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let mut lease = Lease {
            token,
            cancelled,
            published,
            worker: Some(worker),
            settled: None,
        };
        let outcome = lease.reply();
        self.lanes.opencode = Some(lease);
        Ok(outcome)
    }

    pub(super) fn observe_opencode(
        &mut self,
        token: &[u8],
        close: bool,
    ) -> Result<Outcome, ErrorCode> {
        let lease = self
            .lanes
            .opencode
            .as_mut()
            .filter(|lease| lease.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)?;
        if close {
            lease.cancelled.store(true, Ordering::Release);
            lease.published.forget();
        }
        let reply = lease.reply();
        // A missing or untrusted remote executable is reported as its typed
        // reason, not as a generic rejected phase.
        if let Some(WorkerOutcome::Rejected(ErrorCode::ProviderExecutableUnavailable)) =
            lease.settled
        {
            return Err(ErrorCode::ProviderExecutableUnavailable);
        }
        Ok(reply)
    }

    pub(super) fn revoke_opencode(&mut self) -> Result<(), ErrorCode> {
        self.lanes.revoke_opencode()
    }

    pub(super) fn opencode_prevents_connect(&mut self) -> bool {
        self.lanes.opencode.as_mut().is_some_and(|lease| {
            lease.observe();
            lease.settled.is_none() || matches!(lease.settled, Some(WorkerOutcome::Unconfirmed))
        })
    }
}

fn publish(cancelled: &AtomicBool, published: &Publication, ready: ReadyPort) -> bool {
    !cancelled.load(Ordering::Acquire) && published.publish(ready)
}
