use std::path::{Path, PathBuf};

use super::{ErrorCode, Owner};
use crate::{
    Token,
    transport::deployment_manifest::{ManifestOperands, PutResult, valid_manifest_payload},
    transport::deployment_stage::{BeginResult, FixtureRoot, StageOperands},
    v1::{ProofDeploymentHostResult, ProofDeploymentManifestPut, ProofDeploymentStageBegin},
};

pub(in super::super) struct StageBinding {
    pub(super) root: FixtureRoot,
    pub(super) root_path: PathBuf,
    pub(super) acknowledged_generation: Option<Token>,
    /// The approved stage scope outlives the manifest put so later typed steps can
    /// bind the same request, install and digests to the same staging root.
    pub(super) approved: ProofDeploymentStageBegin,
    pub(super) manifest_put: bool,
}

impl StageBinding {
    pub(in super::super) fn new(
        root: &Path,
        approved: ProofDeploymentStageBegin,
    ) -> Result<Self, ErrorCode> {
        Ok(Self {
            root: FixtureRoot::new(root)?,
            root_path: root.to_owned(),
            acknowledged_generation: None,
            approved,
            manifest_put: false,
        })
    }
}

impl Owner {
    pub(super) fn begin_stage(
        &mut self,
        request: &ProofDeploymentStageBegin,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        if self.stage.as_ref().is_none_or(|binding| {
            &binding.approved != request || binding.acknowledged_generation.is_some()
        }) {
            return Err(ErrorCode::OperationDenied);
        }
        // Once dispatch is attempted, no later request may replay this stage.
        let mut binding = self.stage.take().ok_or(ErrorCode::OperationDenied)?;
        let outcome = super::present(&self.transport)?.begin_graph_stage(
            &binding.root,
            operands(request),
            operands(&binding.approved),
        )?;
        let (code, stdout) = match outcome {
            BeginResult::Present => (0, "present\n"),
            BeginResult::Staged => (0, "staged\n"),
            BeginResult::Conflict => (73, ""),
            BeginResult::FixtureUnavailable => (70, ""),
        };
        if outcome == BeginResult::Staged {
            binding.acknowledged_generation = Some(self.generation);
            self.stage = Some(binding);
        }
        Ok(result(code, stdout))
    }

    pub(super) fn put_manifest(
        &mut self,
        request: &ProofDeploymentManifestPut,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        let mut binding = self.stage.take().ok_or(ErrorCode::OperationDenied)?;
        if binding.acknowledged_generation != Some(self.generation)
            || binding.manifest_put
            || binding.approved.request_id != request.request_id
            || binding.approved.manifest_sha256 != request.manifest_sha256
        {
            self.stage = Some(binding);
            return Err(ErrorCode::OperationDenied);
        }
        if !valid_manifest_payload(&request.manifest_sha256, &request.contents) {
            self.stage = Some(binding);
            return Err(ErrorCode::InvalidOperands);
        }
        // Even if a durable link's reply is lost, this approval is spent and cannot replay.
        // The root and approved scope stay bound for the remaining typed steps.
        binding.manifest_put = true;
        let outcome = super::present(&self.transport)?.put_graph_manifest(
            &binding.root_path,
            ManifestOperands {
                request_id: &request.request_id,
                manifest_sha256: &request.manifest_sha256,
            },
            ManifestOperands {
                request_id: &binding.approved.request_id,
                manifest_sha256: &binding.approved.manifest_sha256,
            },
            &request.contents,
        );
        self.stage = Some(binding);
        let (code, stdout) = match outcome? {
            PutResult::Stored => (0, "manifest-stored\n"),
            PutResult::InputMismatch => (65, ""),
            PutResult::FixtureUnavailable => (70, ""),
            PutResult::Conflict => (73, ""),
            PutResult::WriteFailed => (74, ""),
        };
        Ok(result(code, stdout))
    }
}

fn result(code: i32, stdout: &str) -> ProofDeploymentHostResult {
    ProofDeploymentHostResult {
        code: Some(code),
        stdout: stdout.into(),
        stderr: String::new(),
        state: 0,
    }
}

fn operands(scope: &ProofDeploymentStageBegin) -> StageOperands<'_> {
    StageOperands {
        request_id: &scope.request_id,
        install_name: &scope.install_name,
        archive_sha256: &scope.archive_sha256,
        manifest_sha256: &scope.manifest_sha256,
    }
}
