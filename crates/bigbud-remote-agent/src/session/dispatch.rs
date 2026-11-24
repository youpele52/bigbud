use super::*;

impl AgentSession {
    pub fn handle(&mut self, frame: v1::Frame) -> Result<v1::Frame, SessionError> {
        match frame.payload {
            Some(v1::frame::Payload::ClientHello(hello)) => self.handle_client_hello(hello),
            Some(v1::frame::Payload::DiagnosticRequest(request)) if self.ready => {
                self.handle_diagnostic_request(request)
            }
            Some(v1::frame::Payload::CancelRequest(request)) if self.ready => {
                self.handle_cancel_request(request)
            }
            Some(v1::frame::Payload::WriteReceiptRequest(request)) if self.ready => {
                Ok(self.handle_write_receipt(request))
            }
            Some(v1::frame::Payload::PtyListRequest(request)) if self.ready => {
                Ok(self.handle_pty_list(request))
            }
            Some(v1::frame::Payload::PtyInputReconcileRequest(request)) if self.ready => {
                Ok(self.handle_pty_input_reconcile(request))
            }
            Some(payload)
                if self.ready && operation_handlers::is_pty_lifecycle_request(&payload) =>
            {
                Ok(self.handle_pty_lifecycle_request(payload))
            }
            _ if self.ready && !self.accepting_work => Err(SessionError::Restarting),
            Some(v1::frame::Payload::WorkspaceOpenRequest(request)) if self.ready => {
                Ok(self.handle_workspace_open(request))
            }
            Some(v1::frame::Payload::ReadFileRequest(request)) if self.ready => {
                self.handle_read_file(request)
            }
            Some(v1::frame::Payload::ListDirectoryRequest(request)) if self.ready => {
                self.handle_list_directory(request)
            }
            Some(v1::frame::Payload::FilenameSearchRequest(request)) if self.ready => {
                self.handle_filename_search(request)
            }
            Some(v1::frame::Payload::ContentSearchRequest(request)) if self.ready => {
                self.handle_content_search(request)
            }
            Some(v1::frame::Payload::OsIndexSearchRequest(request)) if self.ready => {
                Ok(self.refuse_os_index_search(&request))
            }
            Some(v1::frame::Payload::WriteFileRequest(request)) if self.ready => {
                self.handle_write_file(request)
            }
            Some(v1::frame::Payload::CreateDirectoryRequest(request)) if self.ready => {
                self.handle_create_directory(request)
            }
            Some(v1::frame::Payload::DeleteEntryRequest(request)) if self.ready => {
                self.handle_delete_entry(request)
            }
            Some(v1::frame::Payload::ProcessRequest(request)) if self.ready => self
                .handle_process_request(request)
                .and_then(|mut responses| responses.pop().ok_or(SessionError::UnexpectedMessage)),
            Some(v1::frame::Payload::ProcessAttachRequest(request)) if self.ready => self
                .handle_process_attach(request)
                .and_then(|mut responses| responses.pop().ok_or(SessionError::UnexpectedMessage)),
            Some(v1::frame::Payload::ProcessOutputAck(request)) if self.ready => {
                Ok(self.handle_process_output_ack(request))
            }
            Some(v1::frame::Payload::PtyInput(request)) if self.ready => {
                Ok(self.handle_pty_input(request))
            }
            Some(v1::frame::Payload::PtyOutputAck(request)) if self.ready => {
                Ok(self.handle_pty_output_ack(request))
            }
            Some(v1::frame::Payload::PtyResizeRequest(request)) if self.ready => {
                Ok(self.handle_pty_resize(request))
            }
            Some(v1::frame::Payload::PtySignalRequest(request)) if self.ready => {
                Ok(self.handle_pty_signal(request))
            }
            Some(v1::frame::Payload::PtyCloseRequest(request)) if self.ready => {
                Ok(self.handle_pty_close(request))
            }
            Some(v1::frame::Payload::PasteStageBeginRequest(request)) if self.ready => {
                Ok(self.handle_paste_stage_begin(request))
            }
            Some(v1::frame::Payload::PasteStageChunkRequest(request)) if self.ready => {
                Ok(self.handle_paste_stage_chunk(request))
            }
            Some(v1::frame::Payload::PasteStageCommitRequest(request)) if self.ready => {
                Ok(self.handle_paste_stage_commit(request))
            }
            Some(v1::frame::Payload::PasteStageDiscardRequest(request)) if self.ready => {
                Ok(self.handle_paste_stage_discard(request))
            }
            _ if !self.ready => Err(SessionError::HelloRequired),
            _ => Err(SessionError::UnexpectedMessage),
        }
    }
}
