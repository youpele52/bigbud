use super::*;
use crate::workspace::EntryKind;

impl AgentSession {
    /// Accepts the operation identity, runs `action` once, and forgets the identity again when
    /// the action failed or named an unknown workspace (so a retry is not reported as done).
    fn run_entry_operation<T>(
        &mut self,
        operation_id: &str,
        request_digest: Vec<u8>,
        workspace_handle: &str,
        duplicate_result: T,
        action: impl FnOnce(&WorkspaceRoot) -> Result<T, WorkspaceError>,
    ) -> Result<Result<T, WorkspaceError>, SessionError> {
        if self.accept_operation(operation_id, request_digest)? {
            return Ok(Ok(duplicate_result));
        }
        let result = match self.workspace(workspace_handle) {
            Ok(workspace) => action(workspace),
            Err(error) => {
                self.accepted_operations.remove(operation_id);
                return Err(error);
            }
        };
        if result.is_err() {
            self.accepted_operations.remove(operation_id);
        }
        Ok(result)
    }

    /// `workspace.mkdir` 1.0: create one folder whose parent exists.
    pub(super) fn handle_create_directory(
        &mut self,
        request: v1::CreateDirectoryRequest,
    ) -> Result<v1::Frame, SessionError> {
        let path = request.path.clone();
        let result = self.run_entry_operation(
            &request.operation_id,
            request.request_digest,
            &request.workspace_handle,
            (),
            |workspace| workspace.create_directory(&path),
        )?;
        let (error_code, error_message) = match &result {
            Ok(()) => (String::new(), String::new()),
            Err(error) => (workspace_error_code(error).to_owned(), error.to_string()),
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::CreateDirectoryResponse(
                v1::CreateDirectoryResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    terminal: true,
                    error_code,
                    error_message,
                },
            )),
        })
    }

    /// `workspace.delete` 1.0: permanently delete one entry (never the root, never via a link).
    pub(super) fn handle_delete_entry(
        &mut self,
        request: v1::DeleteEntryRequest,
    ) -> Result<v1::Frame, SessionError> {
        let path = request.path.clone();
        let expected = EntryKind::parse_expected(&request.expected_kind);
        let result = self.run_entry_operation(
            &request.operation_id,
            request.request_digest,
            &request.workspace_handle,
            // A duplicate of an applied delete reports the confirmed kind; nothing runs twice.
            expected.as_ref().map_or(EntryKind::File, |kind| *kind),
            |workspace| workspace.delete_entry(&path, expected?),
        )?;
        let (error_code, error_message, deleted_kind) = match &result {
            Ok(kind) => (String::new(), String::new(), kind.as_str().to_owned()),
            Err(error) => (
                workspace_error_code(error).to_owned(),
                error.to_string(),
                String::new(),
            ),
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::DeleteEntryResponse(
                v1::DeleteEntryResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    terminal: true,
                    error_code,
                    error_message,
                    deleted_kind,
                },
            )),
        })
    }
}
