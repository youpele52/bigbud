#[cfg(target_os = "linux")]
use super::Outcome;
use super::{ErrorCode, Owner};

impl Owner {
    pub(super) fn list_picker_folders(
        &mut self,
        request_id: &[u8],
        path: Option<&str>,
    ) -> Result<crate::v1::Folders, ErrorCode> {
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = request_id;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(inbox) = &mut self.picker_cancel {
            use crate::transport::ListFailure;
            return inbox.run(request_id, |is_cancelled| {
                let result = match &mut self.picker_master {
                    Some(master) => master.list_cancellable(
                        super::present(&self.transport)?,
                        self.generation,
                        path,
                        is_cancelled,
                    ),
                    #[cfg(target_os = "macos")]
                    None => super::present(&self.transport)?
                        .list_folders_cancellable(path, is_cancelled),
                    // Linux binds the inbox only to the owned mux lane.
                    #[cfg(target_os = "linux")]
                    None => Err(ErrorCode::OperationDenied.into()),
                };
                result.map_err(|failure| match failure {
                    ListFailure::Cancelled => ErrorCode::ListCancelled,
                    ListFailure::CleanupUnconfirmed => ErrorCode::OutcomeUnknown,
                    ListFailure::Error(code) => code,
                })
            });
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(master) = &mut self.picker_master {
            return master.list(super::present(&self.transport)?, self.generation, path);
        }
        super::present(&self.transport)?.list_folders(path)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn unlock_synthetic_posix_password(&mut self) -> Result<Outcome, ErrorCode> {
        let master = self
            .picker_master
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?;
        master.unlock_synthetic(super::present(&self.transport)?, self.generation)?;
        Ok(Outcome::ProofSyntheticPosixPasswordUnlocked(
            crate::v1::Empty {},
        ))
    }

    pub(super) fn retire_picker_master(&mut self) -> Result<(), ErrorCode> {
        #[cfg(target_os = "linux")]
        if let Some(picker) = &mut self.jump_picker {
            return picker.retire();
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(master) = &mut self.picker_master {
            return master.retire();
        }
        Ok(())
    }
}
