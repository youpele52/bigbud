use super::*;
use crate::paste_staging::{PasteError, PasteLimits, PasteStore, set_image_clipboard};

const UNAVAILABLE: &str = "UNAVAILABLE";

fn error_fields(error: &PasteError) -> (String, String) {
    (error.code().to_owned(), error.to_string())
}

fn unavailable() -> (String, String) {
    (
        UNAVAILABLE.to_owned(),
        "paste staging is not configured for this agent".to_owned(),
    )
}

impl AgentSession {
    /// Enables `terminal.paste-staging` with a private folder (normally `~/.bigbud/agent/paste`).
    pub fn enable_paste_staging(
        &mut self,
        root: impl AsRef<std::path::Path>,
    ) -> Result<(), PasteError> {
        self.paste_staging = Some(PasteStore::open(root, PasteLimits::default())?);
        Ok(())
    }

    pub(super) fn has_paste_staging(&self) -> bool {
        self.paste_staging.is_some()
    }

    pub(super) fn handle_paste_stage_begin(
        &mut self,
        request: v1::PasteStageBeginRequest,
    ) -> v1::Frame {
        let result = match self.paste_staging.as_mut() {
            Some(store) => store
                .begin(
                    &request.scope,
                    &request.upload_id,
                    request.total_bytes,
                    &request.extension,
                    &request.image_mime_type,
                )
                .map_err(|error| error_fields(&error)),
            None => Err(unavailable()),
        };
        let (accepted, (error_code, error_message)) = match result {
            Ok(()) => (true, (String::new(), String::new())),
            Err(fields) => (false, fields),
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::PasteStageBeginResponse(
                v1::PasteStageBeginResponse {
                    request_id: request.request_id,
                    upload_id: request.upload_id,
                    accepted,
                    max_chunk_bytes: PasteLimits::default().max_chunk_bytes,
                    error_code,
                    error_message,
                },
            )),
        }
    }

    pub(super) fn handle_paste_stage_chunk(
        &mut self,
        request: v1::PasteStageChunkRequest,
    ) -> v1::Frame {
        let result = match self.paste_staging.as_mut() {
            Some(store) => store
                .chunk(&request.upload_id, request.offset, &request.data)
                .map_err(|error| error_fields(&error)),
            None => Err(unavailable()),
        };
        let (received_bytes, (error_code, error_message)) = match result {
            Ok(received) => (received, (String::new(), String::new())),
            Err(fields) => (0, fields),
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::PasteStageChunkResponse(
                v1::PasteStageChunkResponse {
                    request_id: request.request_id,
                    upload_id: request.upload_id,
                    received_bytes,
                    error_code,
                    error_message,
                },
            )),
        }
    }

    pub(super) fn handle_paste_stage_commit(
        &mut self,
        request: v1::PasteStageCommitRequest,
    ) -> v1::Frame {
        let result = match self.paste_staging.as_mut() {
            Some(store) => store
                .commit(&request.upload_id, &request.sha256)
                .map_err(|error| error_fields(&error)),
            None => Err(unavailable()),
        };
        let (path, clipboard, (error_code, error_message)) = match result {
            Ok(committed) => {
                let clipboard = match committed.image_mime_type.as_deref() {
                    Some(mime_type) => set_image_clipboard(&committed.path, mime_type).as_str(),
                    None => "skipped",
                };
                (
                    committed.path.to_string_lossy().into_owned(),
                    clipboard.to_owned(),
                    (String::new(), String::new()),
                )
            }
            Err(fields) => (String::new(), String::new(), fields),
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::PasteStageCommitResponse(
                v1::PasteStageCommitResponse {
                    request_id: request.request_id,
                    upload_id: request.upload_id,
                    path,
                    clipboard,
                    error_code,
                    error_message,
                },
            )),
        }
    }

    pub(super) fn handle_paste_stage_discard(
        &mut self,
        request: v1::PasteStageDiscardRequest,
    ) -> v1::Frame {
        let result = match self.paste_staging.as_mut() {
            Some(store) => store
                .discard(&request.scope, &request.upload_id)
                .map_err(|error| error_fields(&error)),
            None => Err(unavailable()),
        };
        let (removed, (error_code, error_message)) = match result {
            Ok(removed) => (removed, (String::new(), String::new())),
            Err(fields) => (0, fields),
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::PasteStageDiscardResponse(
                v1::PasteStageDiscardResponse {
                    request_id: request.request_id,
                    removed,
                    error_code,
                    error_message,
                },
            )),
        }
    }
}
