use super::Inspection;
use crate::v1::{
    ProofWorkspaceModeInspection, ProofWorkspaceModeReady, ProofWorkspaceModeRefusal as Refusal,
    proof_workspace_mode_inspection::Result,
};

impl From<Inspection> for ProofWorkspaceModeInspection {
    fn from(value: Inspection) -> Self {
        let result = match value {
            Inspection::Ready {
                physical_root,
                host_identity,
                account_uid,
                realpath_sha256,
                generation,
                current_record,
            } => Result::Ready(ProofWorkspaceModeReady {
                physical_root,
                host_identity,
                account_uid,
                realpath_sha256,
                generation,
                current_record,
                publication_token: Vec::new(),
            }),
            Inspection::NotLinux => Result::Refusal(Refusal::NotLinux.into()),
            Inspection::NoMachineId => Result::Refusal(Refusal::NoMachineId.into()),
            Inspection::MissingFolder => Result::Refusal(Refusal::MissingFolder.into()),
            Inspection::UnsafeStorage => Result::Refusal(Refusal::UnsafeStorage.into()),
        };
        Self {
            result: Some(result),
        }
    }
}
