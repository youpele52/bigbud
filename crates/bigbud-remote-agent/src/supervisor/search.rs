use std::io;
use std::sync::{Arc, Mutex};

use bigbud_protocol::v1;

use super::Writer;
use super::io_helpers::write_responses;
use crate::AgentSession;
use crate::search::SearchWorkers;

/// Prepares a search under the session lock, then runs it on a connection-owned worker so the
/// lock is free for every other connection and this reader stays free for `CancelRequest`.
pub(super) fn start(
    sessions: &Arc<Mutex<AgentSession>>,
    writer: &Writer,
    searches: &mut SearchWorkers,
    request: v1::WorkspaceSearchRequest,
) -> io::Result<()> {
    let prepared = sessions
        .lock()
        .map_err(|_| io::Error::other("agent session lock was poisoned"))?
        .prepare_workspace_search(request);
    match prepared {
        Ok(prepared) => {
            let writer = Arc::clone(writer);
            let operation_id = prepared.operation_id().to_owned();
            searches.spawn(operation_id, move || {
                prepared.execute(&mut |frame| write_responses(&writer, vec![frame]).is_ok());
            })
        }
        Err(refusal) => write_responses(writer, vec![*refusal]),
    }
}

/// The connection's search workers, sharing the session's registry.
pub(super) fn workers(sessions: &Arc<Mutex<AgentSession>>) -> io::Result<SearchWorkers> {
    let registry = sessions
        .lock()
        .map_err(|_| io::Error::other("agent session lock was poisoned"))?
        .search_registry()
        .clone();
    Ok(SearchWorkers::new(registry))
}
