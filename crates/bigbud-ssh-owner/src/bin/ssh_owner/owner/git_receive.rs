//! U15: one production Git receive (push) lease per target and generation.
//!
//! Like the upload lease it lives in the target's lanes, so a stale generation
//! or another target cannot observe or close it, and retirement reaps it. The
//! approval (destination ref, expected old OID, source OID) is fixed at open.
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::lease_worker::{Signals, Worker};
use super::{ErrorCode, Outcome, Owner};
use crate::v1::request::Operation;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::{
    Token,
    owner_git_receive::{self, Approval, Outcome as WorkerOutcome, Receipt as WorkerReceipt},
    owner_git_upload,
    v1::{GitReceiveOpen, GitReceivePhase as Phase, GitReceiveReceipt, GitReceiveState},
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) struct Lease {
    token: Token,
    socket_path: String,
    worker: Worker<WorkerOutcome>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Lease {
    fn reply(&mut self) -> Outcome {
        let mut socket_path = None;
        let mut receipt = GitReceiveReceipt::Unspecified;
        let phase = match self.worker.settled() {
            Some(WorkerOutcome::Finished(settled)) => {
                receipt = match settled {
                    WorkerReceipt::Accepted => GitReceiveReceipt::Accepted,
                    WorkerReceipt::Unchanged => GitReceiveReceipt::Unchanged,
                    WorkerReceipt::Rejected => GitReceiveReceipt::Rejected,
                    WorkerReceipt::Stale => GitReceiveReceipt::Stale,
                    WorkerReceipt::Refused => GitReceiveReceipt::Refused,
                };
                Phase::Finished
            }
            Some(WorkerOutcome::Cancelled) => Phase::Closed,
            Some(WorkerOutcome::Lost) => Phase::Lost,
            Some(WorkerOutcome::Rejected(_)) => Phase::Rejected,
            Some(WorkerOutcome::Unconfirmed) => Phase::Unconfirmed,
            None if self.worker.is_streaming() => Phase::Streaming,
            None => {
                socket_path = Some(self.socket_path.clone());
                Phase::Listening
            }
        };
        Outcome::GitReceive(GitReceiveState {
            lease: self.token.to_vec(),
            phase: phase.into(),
            socket_path,
            receipt: receipt.into(),
        })
    }

    /// A lease frees the lane only once settled with a known outcome.
    fn settled_cleanly(&mut self) -> bool {
        self.worker
            .settled()
            .is_some_and(|outcome| !matches!(outcome, WorkerOutcome::Unconfirmed))
    }

    pub(crate) fn retire(&mut self) -> Result<(), ErrorCode> {
        match self.worker.retire() {
            Some(WorkerOutcome::Unconfirmed) | None => Err(ErrorCode::OutcomeUnknown),
            Some(_) => Ok(()),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for Lease {
    fn drop(&mut self) {
        if self.worker.settled().is_none() {
            let _ = self.retire();
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Owner {
    pub(super) fn dispatch_git_receive(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        match operation {
            Operation::GitReceiveOpen(open) => self.open_git_receive(open),
            Operation::GitReceiveStatus(lease) => self.observe_git_receive(&lease.lease, false),
            Operation::GitReceiveClose(lease) => self.observe_git_receive(&lease.lease, true),
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    /// Owner-checked operands and approval, one live lease per target, the
    /// target's own pinned trust policy. The request selects no command.
    pub(super) fn open_git_receive(
        &mut self,
        request: GitReceiveOpen,
    ) -> Result<Outcome, ErrorCode> {
        let token: Token = *<&Token>::try_from(request.lease.as_slice())
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let approval = Approval {
            destination_ref: request.destination_ref,
            expected_old_oid: request.expected_old_oid,
            source_oid: request.source_oid,
        };
        if !owner_git_upload::admits(&request.workspace_root, &request.repository_path)
            || !approval.is_valid()
        {
            return Err(ErrorCode::InvalidOperands);
        }
        if self
            .lanes
            .git_receive
            .as_mut()
            .is_some_and(|lease| !lease.settled_cleanly())
        {
            return Err(ErrorCode::OperationDenied);
        }
        self.lanes.git_receive = None;
        let transport = super::present(&self.transport)?;
        let host = transport.host().to_owned();
        let pinned = transport.pinned_git_upload_ssh()?;
        let command =
            owner_git_receive::remote_command(&request.workspace_root, &request.repository_path);
        let (socket, listener) =
            owner_git_upload::listen().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let socket_path = socket
            .path()
            .to_str()
            .ok_or(ErrorCode::OwnerUnavailable)?
            .to_owned();
        let worker = Worker::spawn(
            "bigbud-git-receive-lease",
            WorkerOutcome::Unconfirmed,
            move |signals: Signals| {
                owner_git_receive::run(
                    pinned,
                    &host,
                    &command,
                    socket,
                    listener,
                    &approval,
                    || signals.cancelled(),
                    || signals.streaming(),
                )
            },
        )
        .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let mut lease = Lease {
            token,
            socket_path,
            worker,
        };
        let outcome = lease.reply();
        self.lanes.git_receive = Some(lease);
        Ok(outcome)
    }

    pub(super) fn observe_git_receive(
        &mut self,
        token: &[u8],
        close: bool,
    ) -> Result<Outcome, ErrorCode> {
        let lease = self
            .lanes
            .git_receive
            .as_mut()
            .filter(|lease| lease.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)?;
        if close {
            lease.retire()?;
        }
        let reply = lease.reply();
        if let Some(WorkerOutcome::Rejected(code)) = lease.worker.settled() {
            return Err(code);
        }
        Ok(reply)
    }
}

/// Other platforms have no production Git lease.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl Owner {
    pub(super) fn dispatch_git_receive(&mut self, _: Operation) -> Result<Outcome, ErrorCode> {
        Err(ErrorCode::OperationDenied)
    }
}
