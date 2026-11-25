//! The one-shot Windows picker session has no attach or long-lived SSH capabilities.
//!
//! W1.3's per-child retirement journal is POSIX-only. Windows process identity
//! (image + creation time) and private-root ACLs are a tracked W6 gap; this
//! picker binds no persistent child identity.

#[cfg(windows)]
pub(super) mod platform;
#[cfg(test)]
mod tests;

use std::time::Instant;

use crate::{
    RunResult, Token,
    owner_grants::Grants,
    owner_pipe::{PayloadPipe, protocol_error},
    owner_storage::Storage,
    owner_trust::{TrustApproval, TrustTransport},
    random_token,
    v1::{
        Connection, ConnectionState, Error, ErrorCode, Folders, HelloAccepted, ProofGrantReply,
        Reply, Request, frame::Payload, reply::Outcome, request::Operation,
    },
};

const MAJOR: u32 = 1;
const MINOR: u32 = 0;

/// Windows ships key-only (U3): a password-class request is refused with a
/// typed denial before any credential collection, never as `authRequired`.
pub(super) fn password_denial(operation: &Operation) -> Option<ErrorCode> {
    matches!(operation, Operation::ProofUnlockSyntheticPosixPassword(_))
        .then_some(ErrorCode::WindowsPasswordUnsupported)
}

trait PickerTransport: TrustTransport {
    fn list(&self, path: Option<&str>) -> Result<Folders, ErrorCode>;
}

struct Session<T: PickerTransport> {
    target: String,
    epoch: Token,
    generation: Token,
    storage: Storage,
    grants: Grants,
    trust: TrustApproval<T::Key>,
    transport: T,
}

impl<T: PickerTransport> Session<T> {
    fn bootstrap(
        pipe: &mut impl PayloadPipe,
        profile: &[u8],
        target: String,
        transport: impl FnOnce() -> RunResult<T>,
    ) -> RunResult<Self> {
        let Some(Payload::Hello(hello)) = pipe.recv()? else {
            return Err(protocol_error().into());
        };
        if hello.major != MAJOR
            || hello.minor != MINOR
            || hello.profile_binding != profile
            || !hello.proof_attachment_capability.is_empty()
        {
            return Err(protocol_error().into());
        }
        let transport = transport()?;
        let storage = Storage::hydrate(pipe, &target)?;
        let session = Self {
            target,
            epoch: random_token()?,
            generation: random_token()?,
            storage,
            grants: Grants::new(crate::owner_grants::budget::Budget::from_startup_env()),
            trust: TrustApproval::default(),
            transport,
        };
        pipe.send(Payload::HelloAccepted(HelloAccepted {
            major: MAJOR,
            minor: MINOR,
            owner_epoch: session.epoch.to_vec(),
            proof_target_generation: session.generation.to_vec(),
            // The Windows fixture does not yet qualify the saved-alias binding.
            proof_alias_descriptor: Vec::new(),
            profile_binding: profile.to_vec(),
        }))?;
        Ok(session)
    }

    fn dispatch(&mut self, pipe: &mut impl PayloadPipe, message: Payload) -> RunResult<()> {
        let reply = match message {
            Payload::ProofGrantRequest(request) => Payload::ProofGrantReply(self.issue(request)),
            Payload::Request(request) => Payload::Reply(self.request(pipe, request)?),
            _ => return Err(protocol_error().into()),
        };
        pipe.send(reply)
    }

    fn validate(&self, request: &Request) -> Result<Operation, ErrorCode> {
        if request.target_id != self.target
            || request.owner_epoch != self.epoch
            || request.request_id.is_empty()
            || request.request_id.len() > 128
        {
            return Err(ErrorCode::OperationDenied);
        }
        if request.target_generation != self.generation {
            return Err(ErrorCode::StaleGeneration);
        }
        let Some(operation) = &request.operation else {
            return Err(ErrorCode::OperationDenied);
        };
        if let Some(error) = password_denial(operation) {
            return Err(error);
        }
        match operation {
            operation @ (Operation::Connect(_)
            | Operation::Disconnect(_)
            | Operation::InspectTrust(_)
            | Operation::ApproveTrust(_)
            | Operation::ListFolders(_)) => Ok(operation.clone()),
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    fn issue(&mut self, request: Request) -> ProofGrantReply {
        let grant = self.validate(&request).and_then(|operation| {
            self.storage.available()?;
            self.grants.issue(&request, operation, Instant::now())
        });
        let (grant, error) = match grant {
            Ok(token) => (token.to_vec(), ErrorCode::Unspecified),
            Err(error) => (Vec::new(), error),
        };
        ProofGrantReply {
            request_id: request.request_id,
            grant,
            error: error.into(),
        }
    }

    fn request(&mut self, pipe: &mut impl PayloadPipe, request: Request) -> RunResult<Reply> {
        let admitted = self.validate(&request).and_then(|operation| {
            self.grants
                .consume(&request, operation.clone(), Instant::now())?;
            Ok(operation)
        });
        let outcome = match admitted {
            Ok(operation) => self.execute(pipe, &request.request_id, operation)?,
            Err(error) => Err(error),
        };
        Ok(Reply {
            request_id: request.request_id,
            owner_epoch: self.epoch.to_vec(),
            target_generation: self.generation.to_vec(),
            outcome: Some(outcome.unwrap_or_else(|code| {
                Outcome::Error(Error {
                    code: code.into(),
                    jump_failure: None,
                })
            })),
        })
    }

    fn execute(
        &mut self,
        pipe: &mut impl PayloadPipe,
        id: &[u8],
        operation: Operation,
    ) -> RunResult<Result<Outcome, ErrorCode>> {
        if !matches!(operation, Operation::Connect(_) | Operation::Disconnect(_))
            && let Err(error) = self.storage.allow_network()
        {
            return Ok(Err(error));
        }
        let reply = match operation {
            Operation::Connect(_) => return self.transition(pipe, id, false),
            Operation::Disconnect(_) => return self.transition(pipe, id, true),
            Operation::InspectTrust(_) => self.trust.inspect(&self.transport).map(Outcome::Trust),
            Operation::ApproveTrust(approval) => self
                .trust
                .approve(&self.transport, &approval.challenge)
                .map(Outcome::Trust),
            Operation::ListFolders(list) => self
                .transport
                .list(list.path.as_deref().filter(|path| !path.is_empty()))
                .map(Outcome::Folders),
            _ => Err(ErrorCode::OperationDenied),
        };
        Ok(reply)
    }

    fn transition(
        &mut self,
        pipe: &mut impl PayloadPipe,
        id: &[u8],
        disconnected: bool,
    ) -> RunResult<Result<Outcome, ErrorCode>> {
        let result = self
            .storage
            .transition(pipe, &self.target, id, disconnected)?;
        self.grants.revoke_pending();
        self.trust.revoke();
        Ok(result.map(|generation| {
            self.generation = generation;
            let state = if disconnected {
                ConnectionState::Disconnected
            } else {
                ConnectionState::Connected
            };
            Outcome::Connection(Connection {
                state: state.into(),
            })
        }))
    }
}
