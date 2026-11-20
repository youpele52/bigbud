use super::*;
use crate::os_index::{
    OS_INDEX_SOURCE, OsIndexError, OsIndexOutcome, OsIndexRequest, OsIndexScopeLevel, home_folder,
    resolve_scopes, search_names,
};
use crate::search::{SearchRegistry, SearchTicket};

/// Default deadline when the request leaves it at 0 (the plan's T5 budget is 700 ms).
const DEFAULT_OS_INDEX_DEADLINE: Duration = Duration::from_millis(1_500);

/// A validated, registered "this computer" search. Preparing happens on the frame thread;
/// `execute` blocks a worker thread until Spotlight answers, the deadline passes or it is
/// cancelled, so the reader stays free for `CancelRequest`.
pub struct PreparedOsIndexSearch {
    request_id: String,
    operation_id: String,
    request: OsIndexRequest,
    ticket: SearchTicket,
}

impl AgentSession {
    /// Only `--ephemeral --os-index` (the desktop-embedded local agent) calls this. Remote,
    /// supervisor and plain stdio agents never advertise or serve `os-index.search`.
    pub fn enable_os_index(&mut self) {
        self.os_index = true;
    }

    pub(super) fn has_os_index(&self) -> bool {
        self.os_index
    }

    pub fn os_index_registry(&self) -> &SearchRegistry {
        &self.os_index_registry
    }

    /// Validates the request, resolves the scope folders for its File Access level under the
    /// agent's home folder and registers a cancel flag. A refusal is the single terminal frame.
    pub fn prepare_os_index_search(
        &mut self,
        request: v1::OsIndexSearchRequest,
    ) -> Result<PreparedOsIndexSearch, Box<v1::Frame>> {
        // `USERPROFILE` on Windows (where `HOME` is normally unset), `HOME` elsewhere.
        self.prepare_os_index_search_in(request, home_folder())
    }

    pub(super) fn prepare_os_index_search_in(
        &mut self,
        request: v1::OsIndexSearchRequest,
        home: Option<std::path::PathBuf>,
    ) -> Result<PreparedOsIndexSearch, Box<v1::Frame>> {
        if !self.ready {
            return Err(Box::new(protocol_error_frame(&SessionError::HelloRequired)));
        }
        if !self.os_index {
            return Err(refused_os_index(&request, &OsIndexError::Unsupported));
        }
        if !self.accepting_work {
            return Err(refused(
                &request,
                "AGENT_SHUTTING_DOWN",
                "agent is shutting down",
            ));
        }
        let level = match v1::OsIndexScopeLevel::try_from(request.scope_level) {
            Ok(v1::OsIndexScopeLevel::CommonFolders) => OsIndexScopeLevel::CommonFolders,
            Ok(v1::OsIndexScopeLevel::Unrestricted) => OsIndexScopeLevel::Unrestricted,
            _ => {
                return Err(refused(
                    &request,
                    "INVALID_ARGUMENT",
                    "scope level is required",
                ));
            }
        };
        let home =
            home.ok_or_else(|| refused_os_index(&request, &OsIndexError::HomeUnavailable))?;
        let scopes =
            resolve_scopes(&home, level).map_err(|error| refused_os_index(&request, &error))?;
        let deadline = match request.deadline_ms {
            0 => DEFAULT_OS_INDEX_DEADLINE,
            milliseconds => Duration::from_millis(u64::from(milliseconds)),
        };
        let parsed = OsIndexRequest::new(
            &request.query,
            scopes,
            request.max_results as usize,
            deadline,
        )
        .map_err(|error| refused_os_index(&request, &error))?;
        let ticket = self
            .os_index_registry
            .register(&request.operation_id)
            .map_err(|error| refused(&request, error.code(), &error.to_string()))?;
        Ok(PreparedOsIndexSearch {
            request_id: request.request_id,
            operation_id: request.operation_id,
            request: parsed,
            ticket,
        })
    }

    /// Any agent mode that reaches the generic frame handler refuses OS-index search.
    pub(super) fn refuse_os_index_search(&self, request: &v1::OsIndexSearchRequest) -> v1::Frame {
        *refused_os_index(request, &OsIndexError::Unsupported)
    }
}

impl PreparedOsIndexSearch {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    /// Runs the query, then writes at most one batch and exactly one completion frame. Every row
    /// already passed the scope and exclusion checks inside `os_index`.
    pub fn execute(self, write: &mut dyn FnMut(v1::Frame) -> bool) {
        let result = search_names(&self.request, self.ticket.cancel_flag());
        let frame = match result {
            Ok(outcome) => {
                let batches = u64::from(!outcome.hits.is_empty());
                if batches == 1 && !write(self.batch_frame(&outcome)) {
                    return;
                }
                self.completed(&outcome, batches)
            }
            Err(error) => completed_error(&self.request_id, &self.operation_id, &error),
        };
        let _delivered = write(frame);
        drop(self.ticket);
    }

    fn batch_frame(&self, outcome: &OsIndexOutcome) -> v1::Frame {
        let hits = outcome
            .hits
            .iter()
            .map(|hit| v1::OsIndexSearchHit {
                path: hit.path.clone(),
                is_directory: hit.is_directory,
                content_type: hit.content_type.clone(),
                size_bytes: hit.size_bytes,
                modified_unix_ms: i64::try_from(hit.modified_unix_ms).unwrap_or(i64::MAX),
                last_used_unix_ms: i64::try_from(hit.last_used_unix_ms).unwrap_or(i64::MAX),
                score: hit.score,
            })
            .collect();
        v1::Frame {
            payload: Some(v1::frame::Payload::OsIndexSearchBatch(
                v1::OsIndexSearchBatch {
                    request_id: self.request_id.clone(),
                    operation_id: self.operation_id.clone(),
                    sequence: 1,
                    hits,
                },
            )),
        }
    }

    fn completed(&self, outcome: &OsIndexOutcome, batches: u64) -> v1::Frame {
        v1::Frame {
            payload: Some(v1::frame::Payload::OsIndexSearchCompleted(
                v1::OsIndexSearchCompleted {
                    request_id: self.request_id.clone(),
                    operation_id: self.operation_id.clone(),
                    stop_reason: outcome.stop.as_wire().to_owned(),
                    truncated: outcome.truncated,
                    source: OS_INDEX_SOURCE.unwrap_or_default().to_owned(),
                    availability: "ready".to_owned(),
                    excluded: outcome.excluded,
                    batches,
                    ..Default::default()
                },
            )),
        }
    }
}

fn completed_error(request_id: &str, operation_id: &str, error: &OsIndexError) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::OsIndexSearchCompleted(
            v1::OsIndexSearchCompleted {
                request_id: request_id.to_owned(),
                operation_id: operation_id.to_owned(),
                stop_reason: "error".to_owned(),
                source: OS_INDEX_SOURCE.unwrap_or_default().to_owned(),
                availability: if matches!(error.code(), "UNAVAILABLE" | "UNSUPPORTED") {
                    "unavailable".to_owned()
                } else {
                    "ready".to_owned()
                },
                // Messages never contain the query or any path.
                error_code: error.code().to_owned(),
                error_message: error.to_string(),
                ..Default::default()
            },
        )),
    }
}

fn refused_os_index(request: &v1::OsIndexSearchRequest, error: &OsIndexError) -> Box<v1::Frame> {
    Box::new(completed_error(
        &request.request_id,
        &request.operation_id,
        error,
    ))
}

fn refused(request: &v1::OsIndexSearchRequest, code: &str, message: &str) -> Box<v1::Frame> {
    Box::new(v1::Frame {
        payload: Some(v1::frame::Payload::OsIndexSearchCompleted(
            v1::OsIndexSearchCompleted {
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
