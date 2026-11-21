//! Lifecycle frames that must stay off the session lock and the read loop (plan §9.1): screen
//! snapshots go to the snapshot worker, and close-all closes PTYs outside the session lock.

use super::host_runtime::HostRuntime;
use super::job_lifecycle::Completion;
use super::snapshot_worker::{self, SnapshotJob};
use super::{Writer, io_helpers::write_responses};
use crate::AgentSession;
use bigbud_protocol::v1;
use std::io;
use std::sync::{Arc, Mutex};

pub(super) fn is_offloaded(payload: &v1::frame::Payload) -> bool {
    matches!(
        payload,
        v1::frame::Payload::PtyScreenSnapshotRequest(_) | v1::frame::Payload::PtyCloseAllRequest(_)
    )
}

pub(super) fn handle(
    sessions: &Arc<Mutex<AgentSession>>,
    runtime: &HostRuntime,
    writer: &Writer,
    payload: Option<v1::frame::Payload>,
) -> io::Result<()> {
    match payload {
        Some(v1::frame::Payload::PtyScreenSnapshotRequest(request)) => {
            snapshot(sessions, runtime, writer, request)
        }
        Some(v1::frame::Payload::PtyCloseAllRequest(request)) => {
            close_all(sessions, writer, request)
        }
        _ => Ok(()),
    }
}

/// The connection loop only resolves the PTY and enqueues the request (N4).
fn snapshot(
    sessions: &Arc<Mutex<AgentSession>>,
    runtime: &HostRuntime,
    writer: &Writer,
    request: v1::PtyScreenSnapshotRequest,
) -> io::Result<()> {
    let source = sessions
        .lock()
        .map_err(|_| io::Error::other("agent session lock was poisoned"))?
        .snapshot_source(&request.pty_id);
    let publication = Completion::publication()
        .ok_or_else(|| io::Error::other("supervisor publication fenced"))?;
    let job = SnapshotJob {
        request,
        source,
        writer: Arc::clone(writer),
        publication,
    };
    match runtime.snapshots.submit(job) {
        Ok(()) => Ok(()),
        Err(job) => write_responses(writer, vec![snapshot_worker::busy(&job.request)]),
    }
}

fn close_all(
    sessions: &Arc<Mutex<AgentSession>>,
    writer: &Writer,
    request: v1::PtyCloseAllRequest,
) -> io::Result<()> {
    let prepared = sessions
        .lock()
        .map_err(|_| io::Error::other("agent session lock was poisoned"))?
        .prepare_close_all(request);
    let (response, closed) = prepared.execute();
    {
        let mut session = sessions
            .lock()
            .map_err(|_| io::Error::other("agent session lock was poisoned"))?;
        for pty_id in &closed {
            session.note_pty_closed(pty_id);
        }
    }
    write_responses(writer, vec![response])
}
