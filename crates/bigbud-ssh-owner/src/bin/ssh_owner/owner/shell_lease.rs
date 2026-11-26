//! W2 T-shell production exec leases (thread shell, provider workspace shell
//! and the fixed ACP recipe).
//!
//! Each lease lives in its target's lanes and is scoped to the exact target and
//! generation, so another target or a rotated generation can neither observe
//! nor close it. Opening returns at once; the SSH child runs on a worker thread
//! so a long command never blocks the owner's single request loop. A lease of
//! one role never answers a status or close naming another role. A running
//! command is only ever killed, never replayed.
use super::targets::LeaseScope;
use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token,
    transport::{ShellLaunch, ShellRun, Transport},
    v1::{ShellClose, ShellPhase, ShellRole, ShellState, ShellStatus, request::Operation},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// Live or unread leases per target (each holds one SSH session while running).
const MAX_LEASES: usize = 4;
/// A settled lease the client never closed is dropped after this.
const SETTLED_TTL: Duration = Duration::from_secs(60);
const CLOSE_BUDGET: Duration = Duration::from_millis(1750);
const POLL: Duration = Duration::from_millis(5);
/// One status reply carries at most this much output.
const CHUNK: usize = 1024 * 1024;

pub(crate) struct Lease {
    token: Token,
    role: ShellRole,
    scope: LeaseScope,
    thread: Option<String>,
    cancelled: Arc<AtomicBool>,
    worker: Option<JoinHandle<ShellRun>>,
    settled: Option<ShellRun>,
    settled_at: Option<Instant>,
}

impl Lease {
    fn observe(&mut self) {
        if self.worker.as_ref().is_some_and(JoinHandle::is_finished)
            && let Some(worker) = self.worker.take()
        {
            // A panicked worker has no confirmed teardown: report it as such.
            self.settled = Some(match worker.join() {
                Ok(run) => run,
                Err(_) => ShellRun::Unconfirmed,
            });
            self.settled_at = Some(Instant::now());
        }
    }

    fn unconfirmed(&self) -> bool {
        matches!(self.settled, Some(ShellRun::Unconfirmed))
    }

    /// Kill (if running) and confirm the process group is gone within a bound.
    fn retire(&mut self) -> Result<(), ErrorCode> {
        self.cancelled.store(true, Ordering::Release);
        let deadline = Instant::now() + CLOSE_BUDGET;
        loop {
            self.observe();
            match self.settled {
                Some(ShellRun::Unconfirmed) => return Err(ErrorCode::OutcomeUnknown),
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
            // Best-effort teardown on drop; the checked path is `Leases::revoke`.
            let _ = self.retire();
        }
    }
}

/// The target's shell leases. Unconfirmed leases are retained so they keep
/// counting against the bound and are reported, never silently forgotten.
#[derive(Default)]
pub(crate) struct Leases(Vec<Lease>);

impl Leases {
    /// Confirmed teardown of every shell lease; the first failure is returned
    /// after all attempts and the unconfirmed leases are kept.
    pub(crate) fn revoke(&mut self) -> Result<(), ErrorCode> {
        let mut result = Ok(());
        for lease in &mut self.0 {
            if let Err(error) = lease.retire() {
                result = result.and(Err(error));
            }
        }
        self.0.retain(Lease::unconfirmed);
        result
    }

    /// Retire leases from another generation and drop expired settled ones.
    fn sweep(&mut self, target: &str, generation: Token) {
        let now = Instant::now();
        for lease in &mut self.0 {
            lease.observe();
            if !lease.scope.admits(target, generation) {
                // A failed reap leaves the lease marked unconfirmed below.
                let _ = lease.retire();
            }
        }
        self.0.retain(|lease| {
            lease.unconfirmed()
                || (lease.scope.admits(target, generation)
                    && lease
                        .settled_at
                        .is_none_or(|at| now.duration_since(at) < SETTLED_TTL))
        });
    }

    fn position(&self, token: &[u8], role: i32) -> Result<usize, ErrorCode> {
        self.0
            .iter()
            .position(|lease| lease.token.as_slice() == token && lease.role as i32 == role)
            .ok_or(ErrorCode::OperationDenied)
    }
}

fn state(lease: &Lease, phase: ShellPhase, output: Vec<u8>, size: u64) -> Outcome {
    let (exit_code, truncated) = match &lease.settled {
        Some(ShellRun::Exited {
            exit_code,
            truncated,
            ..
        }) => (Some(*exit_code), *truncated),
        _ => (None, false),
    };
    Outcome::Shell(ShellState {
        lease: lease.token.to_vec(),
        role: lease.role.into(),
        phase: phase.into(),
        output,
        output_size: size,
        exit_code: exit_code.filter(|_| phase == ShellPhase::Exited),
        truncated,
    })
}

impl Owner {
    /// The single dispatch entry for the five shell verbs.
    pub(super) fn dispatch_shell(&mut self, operation: Operation) -> Result<Outcome, ErrorCode> {
        match operation {
            Operation::RunThreadShell(open) => self.open_shell(
                ShellRole::Thread,
                &open.lease,
                Some(&open.thread_id),
                |t, p| t.thread_shell_launch(&open, p),
            ),
            Operation::RunProviderWorkspaceShell(open) => {
                self.open_shell(ShellRole::ProviderWorkspace, &open.lease, None, |t, p| {
                    t.provider_shell_launch(&open, p)
                })
            }
            Operation::RunAcpCommand(open) => {
                self.open_shell(ShellRole::Acp, &open.lease, None, |t, p| {
                    t.acp_command_launch(&open, p)
                })
            }
            // U21: an approved ACP terminal command, its own role and grant.
            Operation::RunAcpShell(open) => {
                self.open_shell(ShellRole::AcpShell, &open.lease, None, |t, p| {
                    t.acp_shell_launch(&open, p)
                })
            }
            Operation::ShellStatus(status) => self.shell_status(&status),
            Operation::ShellClose(close) => self.shell_close(&close),
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    /// Open one owner-selected command for the bound target. `launch` validates
    /// the operands and pins the target's own trust policy before any spawn.
    pub(super) fn open_shell(
        &mut self,
        role: ShellRole,
        lease: &[u8],
        thread_id: Option<&str>,
        launch: impl FnOnce(&Transport, bool) -> Result<ShellLaunch, ErrorCode>,
    ) -> Result<Outcome, ErrorCode> {
        let token: Token = *<&Token>::try_from(lease).map_err(|_| ErrorCode::InvalidOperands)?;
        let (target, generation) = (self.target.clone(), self.generation);
        self.lanes.shell.sweep(&target, generation);
        self.lanes.shell.admit(&token, thread_id)?;
        let launch = launch(super::present(&self.transport)?, self.production)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&cancelled);
        let worker = thread::Builder::new()
            .name("bigbud-shell-lease".into())
            .spawn(move || launch.run(|| stop.load(Ordering::Acquire)))
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let lease = Lease {
            token,
            role,
            scope: LeaseScope::new(&target, generation),
            thread: thread_id.map(str::to_owned),
            cancelled,
            worker: Some(worker),
            settled: None,
            settled_at: None,
        };
        let reply = state(&lease, ShellPhase::Running, Vec::new(), 0);
        self.lanes.shell.0.push(lease);
        Ok(reply)
    }

    pub(super) fn shell_status(&mut self, request: &ShellStatus) -> Result<Outcome, ErrorCode> {
        let (target, generation) = (self.target.clone(), self.generation);
        self.lanes.shell.sweep(&target, generation);
        self.lanes.shell.status(request)
    }

    pub(super) fn shell_close(&mut self, request: &ShellClose) -> Result<Outcome, ErrorCode> {
        let (target, generation) = (self.target.clone(), self.generation);
        self.lanes.shell.sweep(&target, generation);
        self.lanes.shell.close(request)
    }
}

impl Leases {
    /// Fresh token, one running command per thread, and the per-target bound.
    fn admit(&mut self, token: &Token, thread_id: Option<&str>) -> Result<(), ErrorCode> {
        if self.0.iter().any(|lease| lease.token == *token) {
            return Err(ErrorCode::InvalidOperands);
        }
        if let Some(thread_id) = thread_id
            && self.0.iter_mut().any(|lease| {
                lease.observe();
                lease.settled.is_none() && lease.thread.as_deref() == Some(thread_id)
            })
        {
            // One active command per thread, enforced by the owner as well.
            return Err(ErrorCode::OperationDenied);
        }
        if self.0.len() >= MAX_LEASES {
            return Err(ErrorCode::SessionQuota);
        }
        Ok(())
    }

    fn status(&mut self, request: &ShellStatus) -> Result<Outcome, ErrorCode> {
        let index = self.position(&request.lease, request.role)?;
        let lease = self.0.get_mut(index).ok_or(ErrorCode::OperationDenied)?;
        lease.observe();
        let failure = match &lease.settled {
            None => return Ok(state(lease, ShellPhase::Running, Vec::new(), 0)),
            Some(ShellRun::Exited { output, .. }) => {
                let size = output.len();
                let start = usize::try_from(request.offset)
                    .ok()
                    .filter(|start| *start <= size)
                    .ok_or(ErrorCode::InvalidOperands)?;
                let end = size.min(start.saturating_add(CHUNK));
                let chunk = output.get(start..end).ok_or(ErrorCode::InvalidOperands)?;
                let chunk = chunk.to_vec();
                return Ok(state(lease, ShellPhase::Exited, chunk, size as u64));
            }
            Some(ShellRun::Unconfirmed) => return Err(ErrorCode::OutcomeUnknown),
            Some(ShellRun::TimedOut) => ErrorCode::ShellTimedOut,
            Some(ShellRun::Cancelled) => ErrorCode::ShellCancelled,
            Some(ShellRun::Failed(code)) => *code,
        };
        // A typed failure is reported once and the settled lease is released.
        self.0.remove(index);
        Err(failure)
    }

    fn close(&mut self, request: &ShellClose) -> Result<Outcome, ErrorCode> {
        let index = self.position(&request.lease, request.role)?;
        self.0
            .get_mut(index)
            .ok_or(ErrorCode::OperationDenied)?
            .retire()?;
        let lease = self.0.remove(index);
        Ok(state(&lease, ShellPhase::Closed, Vec::new(), 0))
    }
}

#[cfg(test)]
#[path = "shell_lease.tests.rs"]
mod tests;
