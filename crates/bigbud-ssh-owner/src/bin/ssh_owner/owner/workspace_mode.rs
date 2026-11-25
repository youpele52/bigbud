use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token, random_token,
    transport::workspace_mode::{Inspection, Publication},
    v1::{
        ProofWorkspaceModeInspection, ProofWorkspaceModePublication, ProofWorkspaceModePublish,
        ProofWorkspaceModePublishStatus as Status, proof_workspace_mode_inspection,
    },
};
use std::time::{Duration, Instant};

const OBSERVATION_TTL: Duration = Duration::from_secs(30);

pub(super) struct Observation {
    token: Token,
    generation: Token,
    root: String,
    data: Inspection,
    expires: Instant,
}

impl Owner {
    pub(super) fn inspect_workspace_mode(&mut self, root: String) -> Result<Outcome, ErrorCode> {
        self.workspace_mode_observation = None;
        let data = self.transport.inspect_workspace_mode(&root)?;
        let mut reply = ProofWorkspaceModeInspection::from(data.clone());
        if let Some(proof_workspace_mode_inspection::Result::Ready(ready)) = &mut reply.result {
            let token = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
            ready.publication_token = token.to_vec();
            self.workspace_mode_observation = Some(Observation {
                token,
                generation: self.generation,
                root,
                data,
                expires: Instant::now() + OBSERVATION_TTL,
            });
        }
        Ok(Outcome::ProofWorkspaceModeInspection(reply))
    }

    pub(super) fn publish_workspace_mode(
        &mut self,
        request: ProofWorkspaceModePublish,
    ) -> Result<Outcome, ErrorCode> {
        let matching = self
            .workspace_mode_observation
            .as_ref()
            .is_some_and(|observed| {
                observed.generation == self.generation
                    && observed.root == request.root
                    && observed.token.as_slice() == request.publication_token
                    && Instant::now() < observed.expires
            });
        if !matching {
            return Err(ErrorCode::OperationDenied);
        }
        // Consume before any possible publication. Lost replies require a new inspection.
        let observed = self
            .workspace_mode_observation
            .take()
            .ok_or(ErrorCode::OperationDenied)?;
        let status = match self.transport.publish_workspace_mode(
            &request.root,
            &observed.data,
            &request.next_record,
        )? {
            Publication::Committed => Status::Committed,
            Publication::Conflict => Status::Conflict,
            Publication::Uncertain => Status::Uncertain,
            Publication::MissingFolder => Status::MissingFolder,
            Publication::UnsafeStorage => Status::UnsafeStorage,
            Publication::NotLinux | Publication::NoMachineId | Publication::ScopeChanged => {
                Status::Refused
            }
        };
        Ok(Outcome::ProofWorkspaceModePublication(
            ProofWorkspaceModePublication {
                status: status.into(),
            },
        ))
    }
}
