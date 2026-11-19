use super::*;
use crate::search::{SearchBatch, SearchOutcome, SearchRequest, SearchTicket, run_search};

/// A validated, registered search. Preparing happens under the session lock; `execute` runs on a
/// worker thread so the frame reader stays free for `CancelRequest`.
pub struct PreparedSearch {
    request_id: String,
    operation_id: String,
    request: SearchRequest,
    ticket: SearchTicket,
    root_errors: Vec<v1::WorkspaceSearchRootError>,
}

impl AgentSession {
    /// Validates the request, opens its roots and registers a cancel flag. A refused request is
    /// answered with its single terminal `WorkspaceSearchCompleted` frame.
    pub fn prepare_workspace_search(
        &mut self,
        request: v1::WorkspaceSearchRequest,
    ) -> Result<PreparedSearch, Box<v1::Frame>> {
        if !self.ready {
            return Err(Box::new(protocol_error_frame(&SessionError::HelloRequired)));
        }
        if !self.accepting_work {
            return Err(refused(
                &request,
                "AGENT_SHUTTING_DOWN",
                "agent is shutting down",
            ));
        }
        let (parsed, failures) = SearchRequest::from_proto(&request)
            .map_err(|error| refused(&request, error.code(), &error.to_string()))?;
        let ticket = self
            .search_registry
            .register(&request.operation_id)
            .map_err(|error| refused(&request, error.code(), &error.to_string()))?;
        Ok(PreparedSearch {
            request_id: request.request_id,
            operation_id: request.operation_id,
            request: parsed,
            ticket,
            root_errors: failures
                .into_iter()
                .map(|failure| v1::WorkspaceSearchRootError {
                    root_id: failure.root_id,
                    error_code: workspace_error_code(&failure.error).to_owned(),
                })
                .collect(),
        })
    }

    pub fn search_registry(&self) -> &crate::search::SearchRegistry {
        &self.search_registry
    }
}

impl PreparedSearch {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    /// Runs the search, writing batches with monotonic sequence numbers and then exactly one
    /// completion frame. `write` returning `false` (connection gone) stops the search.
    pub fn execute(self, write: &mut dyn FnMut(v1::Frame) -> bool) {
        let mut sequence = 0_u64;
        let request_id = self.request_id.clone();
        let operation_id = self.operation_id.clone();
        let outcome = run_search(&self.request, self.ticket.cancel_flag(), &mut |batch| {
            sequence += 1;
            write(batch_frame(&request_id, &operation_id, sequence, batch))
        });
        let _delivered = write(self.completed_frame(outcome));
        // The registry slot is released only after the terminal frame is written.
        drop(self.ticket);
    }

    fn completed_frame(&self, outcome: SearchOutcome) -> v1::Frame {
        let mut root_errors = self.root_errors.clone();
        root_errors.extend(outcome.root_errors.into_iter().map(|(root_id, code)| {
            v1::WorkspaceSearchRootError {
                root_id,
                error_code: code.to_owned(),
            }
        }));
        v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceSearchCompleted(
                v1::WorkspaceSearchCompleted {
                    request_id: self.request_id.clone(),
                    operation_id: self.operation_id.clone(),
                    stop_reason: outcome.stop.as_wire().to_owned(),
                    truncated: outcome.truncated,
                    files_scanned: outcome.files_scanned,
                    root_errors,
                    batches: outcome.batches,
                    ..Default::default()
                },
            )),
        }
    }
}

fn refused(request: &v1::WorkspaceSearchRequest, code: &str, message: &str) -> Box<v1::Frame> {
    Box::new(v1::Frame {
        payload: Some(v1::frame::Payload::WorkspaceSearchCompleted(
            v1::WorkspaceSearchCompleted {
                request_id: request.request_id.clone(),
                operation_id: request.operation_id.clone(),
                stop_reason: "error".to_owned(),
                error_code: code.to_owned(),
                error_message: message.to_owned(),
                ..Default::default()
            },
        )),
    })
}

fn batch_frame(
    request_id: &str,
    operation_id: &str,
    sequence: u64,
    batch: SearchBatch,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::WorkspaceSearchBatch(
            v1::WorkspaceSearchBatch {
                request_id: request_id.to_owned(),
                operation_id: operation_id.to_owned(),
                sequence,
                names: batch
                    .names
                    .into_iter()
                    .map(|hit| v1::WorkspaceSearchNameHit {
                        root_id: hit.root_id,
                        path: hit.entry.path,
                        is_directory: hit.entry.is_directory,
                        size_bytes: hit.entry.size_bytes,
                        modified_unix_ms: i64::try_from(hit.entry.modified_unix_ms)
                            .unwrap_or(i64::MAX),
                        score: hit.score,
                    })
                    .collect(),
                contents: batch
                    .contents
                    .into_iter()
                    .map(|hit| v1::WorkspaceSearchContentHit {
                        root_id: hit.root_id,
                        path: hit.path,
                        line: hit.matched.line,
                        column: hit.matched.column,
                        excerpt: hit.matched.excerpt,
                    })
                    .collect(),
            },
        )),
    }
}
