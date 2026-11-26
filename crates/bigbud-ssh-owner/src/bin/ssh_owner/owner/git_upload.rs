//! U15: one production Git upload lease per target and generation.
//!
//! The lease lives in the target's lanes, so a stale generation or another
//! target cannot observe or close it, and target retirement reaps it.
use super::{
    ErrorCode, Outcome, Owner,
    lease_worker::{Signals, Worker},
};
use crate::{
    Token,
    owner_git_upload::{self, Outcome as WorkerOutcome},
    v1::{GitUploadOpen, GitUploadPhase as Phase, GitUploadState},
};

pub(crate) struct Lease {
    token: Token,
    socket_path: String,
    worker: Worker<WorkerOutcome>,
}

impl Lease {
    fn reply(&mut self) -> Outcome {
        let mut socket_path = None;
        let mut exit_code = None;
        let phase = match self.worker.settled() {
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
            None if self.worker.is_streaming() => Phase::Streaming,
            None => {
                socket_path = Some(self.socket_path.clone());
                Phase::Listening
            }
        };
        Outcome::GitUpload(GitUploadState {
            lease: self.token.to_vec(),
            phase: phase.into(),
            socket_path,
            exit_code,
        })
    }

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

impl Drop for Lease {
    fn drop(&mut self) {
        if self.worker.settled().is_none() {
            let _ = self.retire();
        }
    }
}

impl Owner {
    /// Owner-checked operands, one live lease per target, the target's own
    /// pinned trust policy. The request selects no command or environment.
    pub(super) fn open_git_upload(&mut self, request: GitUploadOpen) -> Result<Outcome, ErrorCode> {
        let token: Token = *<&Token>::try_from(request.lease.as_slice())
            .map_err(|_| ErrorCode::InvalidOperands)?;
        if !owner_git_upload::admits(&request.workspace_root, &request.repository_path) {
            return Err(ErrorCode::InvalidOperands);
        }
        if self
            .lanes
            .git_upload
            .as_mut()
            .is_some_and(|lease| !lease.settled_cleanly())
        {
            return Err(ErrorCode::OperationDenied);
        }
        self.lanes.git_upload = None;
        let transport = super::present(&self.transport)?;
        let host = transport.host().to_owned();
        let pinned = transport.pinned_git_upload_ssh()?;
        let command =
            owner_git_upload::remote_command(&request.workspace_root, &request.repository_path);
        let (socket, listener) =
            owner_git_upload::listen().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let socket_path = socket
            .path()
            .to_str()
            .ok_or(ErrorCode::OwnerUnavailable)?
            .to_owned();
        let worker = Worker::spawn(
            "bigbud-git-upload-lease",
            WorkerOutcome::Unconfirmed,
            move |signals: Signals| {
                owner_git_upload::run(
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
        let mut lease = Lease {
            token,
            socket_path,
            worker,
        };
        let outcome = lease.reply();
        self.lanes.git_upload = Some(lease);
        Ok(outcome)
    }

    pub(super) fn observe_git_upload(
        &mut self,
        token: &[u8],
        close: bool,
    ) -> Result<Outcome, ErrorCode> {
        let lease = self
            .lanes
            .git_upload
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
