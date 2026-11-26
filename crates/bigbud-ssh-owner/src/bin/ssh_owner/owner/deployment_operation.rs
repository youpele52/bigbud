//! Retained typed deployment operations.
//!
//! A dispatch is recorded before the transport runs. A confirmed result is kept
//! for `reattach`; an ambiguous one is retained as unknown and never replayed.
//! Cancellation names exactly this request's operation and cannot reach any
//! other lease or the host.

use super::{ErrorCode, Owner};
use crate::v1::{
    ProofDeploymentAction, ProofDeploymentActionKind, ProofDeploymentHostResult,
    ProofDeploymentOperationState,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in super::super) enum State {
    Started,
    Completed,
    Cancelled,
    OutcomeUnknown,
    Refused,
}

impl State {
    fn wire(self) -> ProofDeploymentOperationState {
        match self {
            State::Started => ProofDeploymentOperationState::Started,
            State::Completed => ProofDeploymentOperationState::Completed,
            State::Cancelled => ProofDeploymentOperationState::Cancelled,
            State::OutcomeUnknown => ProofDeploymentOperationState::OutcomeUnknown,
            State::Refused => ProofDeploymentOperationState::Refused,
        }
    }
}

pub(in super::super) struct DeploymentOperation {
    request_id: String,
    state: State,
    result: Option<ProofDeploymentHostResult>,
}

impl DeploymentOperation {
    fn new(request_id: &str) -> Self {
        Self {
            request_id: request_id.to_owned(),
            state: State::Started,
            result: None,
        }
    }

    fn snapshot(&self) -> ProofDeploymentHostResult {
        let mut result = self.result.clone().unwrap_or(ProofDeploymentHostResult {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            state: 0,
        });
        result.state = self.state.wire().into();
        result
    }
}

impl Owner {
    /// Dispatch or observe one typed deployment step. Only an exact request id
    /// bound at startup may mutate. A retained terminal state is returned rather
    /// than re-dispatched, so a lost acknowledgement is never replayed.
    pub(super) fn deployment_action(
        &mut self,
        action: &ProofDeploymentAction,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        let kind = ProofDeploymentActionKind::try_from(action.kind)
            .map_err(|_| ErrorCode::InvalidOperands)?;
        match kind {
            ProofDeploymentActionKind::Cancel => self.cancel_deployment(action),
            ProofDeploymentActionKind::Reattach => self.reattach_deployment(action),
            ProofDeploymentActionKind::Unspecified => Err(ErrorCode::InvalidOperands),
            _ => self.dispatch_deployment(action),
        }
    }

    fn cancel_deployment(
        &mut self,
        action: &ProofDeploymentAction,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        let operation = self
            .deployment_operation
            .as_mut()
            .filter(|operation| operation.request_id == action.request_id)
            .ok_or(ErrorCode::OperationDenied)?;
        // Cancellation is terminal and idempotent; it never rewrites a confirmed result.
        if operation.state == State::Started {
            operation.state = State::Cancelled;
            operation.result = None;
        }
        Ok(operation.snapshot())
    }

    fn reattach_deployment(
        &self,
        action: &ProofDeploymentAction,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        self.deployment_operation
            .as_ref()
            .filter(|operation| operation.request_id == action.request_id)
            .map(DeploymentOperation::snapshot)
            .ok_or(ErrorCode::OperationDenied)
    }

    fn dispatch_deployment(
        &mut self,
        action: &ProofDeploymentAction,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        let (root, request_id) = {
            let binding = self.stage.as_ref().ok_or(ErrorCode::OperationDenied)?;
            if binding.acknowledged_generation != Some(self.generation)
                || binding.approved.request_id != action.request_id
                || binding.approved.install_name != action.install_name
            {
                return Err(ErrorCode::OperationDenied);
            }
            // Publishing needs the acknowledged manifest in this same stage.
            if ProofDeploymentActionKind::try_from(action.kind)
                == Ok(ProofDeploymentActionKind::Publish)
                && !binding.manifest_put
            {
                return Err(ErrorCode::OperationDenied);
            }
            (
                binding.root_path.clone(),
                binding.approved.request_id.clone(),
            )
        };
        if let Some(existing) = &self.deployment_operation
            && existing.request_id == request_id
        {
            return match existing.state {
                // A started step holds the lease; do not run a second copy of it.
                State::Started => Err(ErrorCode::OperationDenied),
                _ => Ok(existing.snapshot()),
            };
        }
        self.deployment_operation = Some(DeploymentOperation::new(&request_id));
        match super::present(&self.transport)?.deployment_step(&root, action) {
            Ok(result) => {
                let state = if result.code == Some(0) {
                    State::Completed
                } else {
                    State::Refused
                };
                if let Some(operation) = &mut self.deployment_operation {
                    operation.state = state;
                    operation.result = Some(result.clone());
                }
                Ok(result)
            }
            Err(ErrorCode::OutcomeUnknown) => {
                if let Some(operation) = &mut self.deployment_operation {
                    operation.state = State::OutcomeUnknown;
                    operation.result = None;
                }
                Err(ErrorCode::OutcomeUnknown)
            }
            Err(error) => {
                if let Some(operation) = &mut self.deployment_operation {
                    operation.state = State::Refused;
                    operation.result = None;
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(code: Option<i32>, stdout: &str) -> ProofDeploymentHostResult {
        ProofDeploymentHostResult {
            code,
            stdout: stdout.into(),
            stderr: String::new(),
            state: 0,
        }
    }

    #[test]
    fn a_started_operation_reports_started_without_a_result() {
        let operation = DeploymentOperation::new("request-a");
        let snapshot = operation.snapshot();
        assert_eq!(
            snapshot.state,
            ProofDeploymentOperationState::Started as i32
        );
        assert_eq!(snapshot.code, None);
    }

    #[test]
    fn a_confirmed_result_is_retained_for_reattach() {
        let mut operation = DeploymentOperation::new("request-a");
        operation.state = State::Completed;
        operation.result = Some(result(Some(0), "published\n"));
        let snapshot = operation.snapshot();
        assert_eq!(snapshot.stdout, "published\n");
        assert_eq!(
            snapshot.state,
            ProofDeploymentOperationState::Completed as i32
        );
    }

    #[test]
    fn every_terminal_state_has_one_wire_value() {
        for (state, wire) in [
            (State::Started, ProofDeploymentOperationState::Started),
            (State::Completed, ProofDeploymentOperationState::Completed),
            (State::Cancelled, ProofDeploymentOperationState::Cancelled),
            (
                State::OutcomeUnknown,
                ProofDeploymentOperationState::OutcomeUnknown,
            ),
            (State::Refused, ProofDeploymentOperationState::Refused),
        ] {
            assert_eq!(state.wire(), wire);
        }
    }
}
