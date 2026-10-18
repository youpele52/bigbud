use super::shutdown_response;
use crate::AgentSession;
use bigbud_protocol::v1;
use bigbud_workspace_watch::WorkspaceWatchRegistry;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
#[cfg(unix)]
pub(super) type Writer = Arc<writer::OutboundWriter>;
#[cfg(unix)]
#[path = "writer.rs"]
mod writer;
#[cfg(unix)]
pub(super) type Subscribers = Arc<Mutex<HashMap<String, Vec<Arc<subscription::Subscription>>>>>;
#[cfg(unix)]
#[path = "admission.rs"]
mod admission;
#[cfg(unix)]
#[path = "attach.rs"]
mod attach;
#[cfg(unix)]
#[path = "drain.rs"]
mod drain;
#[cfg(unix)]
#[path = "frame_reader.rs"]
mod frame_reader;
#[cfg(unix)]
#[path = "io.rs"]
mod io_helpers;
#[cfg(unix)]
#[path = "jobs.lifecycle.rs"]
mod job_lifecycle;
#[cfg(unix)]
#[path = "jobs.rs"]
mod jobs;
#[cfg(unix)]
#[path = "subscription.rs"]
mod subscription;
#[cfg(unix)]
use io_helpers::*;
#[cfg(unix)]
use jobs::{spawn_process_job, spawn_pty_job};
#[cfg(unix)]
#[path = "bootstrap.rs"]
mod bootstrap;
#[cfg(all(test, unix))]
#[path = "test_hooks.rs"]
mod test_hooks;
#[cfg(unix)]
pub use bootstrap::run_supervisor;
#[cfg(not(unix))]
pub fn run_supervisor(_session: AgentSession, _socket_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the remote agent supervisor requires Unix-domain sockets on this platform",
    ))
}
#[cfg(unix)]
fn serve_connection(
    stream: UnixStream,
    sessions: Arc<Mutex<AgentSession>>,
    subscribers: Subscribers,
    watch_subscribers: Subscribers,
    watchers: Arc<WorkspaceWatchRegistry>,
    writer: Writer,
    handshake: frame_reader::HandshakePermit,
) -> io::Result<()> {
    let mut subscriptions = HashSet::new();
    let result = serve_connection_loop(
        stream,
        sessions,
        Arc::clone(&subscribers),
        &watch_subscribers,
        &watchers,
        &mut subscriptions,
        (Arc::clone(&writer), handshake),
    );
    for subscription_id in subscriptions {
        watchers.unsubscribe(&subscription_id);
        remove_all_subscribers(&watch_subscribers, &subscription_id);
    }
    remove_connection(&subscribers, &writer)?;
    remove_connection(&watch_subscribers, &writer)?;
    let drain = if result.is_ok() {
        writer.drain()
    } else {
        Ok(())
    };
    writer.join()?;
    result.and(drain)
}

#[cfg(unix)]
fn serve_connection_loop(
    stream: UnixStream,
    sessions: Arc<Mutex<AgentSession>>,
    subscribers: Subscribers,
    watch_subscribers: &Subscribers,
    watchers: &WorkspaceWatchRegistry,
    watch_ids: &mut HashSet<String>,
    connection: (Writer, frame_reader::HandshakePermit),
) -> io::Result<()> {
    let (writer, handshake) = connection;
    let control_only = handshake.control_only;
    let mut reader = if control_only {
        frame_reader::FrameReader::with_timeout(stream, std::time::Duration::from_secs(1))
    } else {
        frame_reader::FrameReader::new(stream)
    };
    let mut handshake = Some(handshake);
    loop {
        let frame = match reader.next(handshake.is_none() && !control_only) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        };
        if control_only
            && handshake.is_none()
            && !matches!(
                &frame.payload,
                Some(v1::frame::Payload::SupervisorShutdownRequest(_))
            )
        {
            return Err(io::Error::other(
                "reserved control admission requires shutdown request",
            ));
        }
        if handshake.is_some()
            && !matches!(&frame.payload, Some(v1::frame::Payload::ClientHello(_)))
        {
            return Err(io::Error::other("connection hello required"));
        }
        let _publication = if matches!(
            &frame.payload,
            Some(v1::frame::Payload::SupervisorShutdownRequest(_))
        ) {
            None
        } else {
            Some(
                job_lifecycle::Completion::publication()
                    .ok_or_else(|| io::Error::other("supervisor publication fenced"))?,
            )
        };
        if frame.payload.as_ref().is_some_and(crate::is_pty_control) {
            let prepared = sessions
                .lock()
                .map_err(|_| io::Error::other("agent session poisoned"))?
                .prepare_pty_control(
                    frame
                        .payload
                        .ok_or_else(|| io::Error::other("missing payload"))?,
                );
            match prepared.and_then(|prepared| prepared.execute()) {
                Ok(response) => {
                    sessions
                        .lock()
                        .map_err(|_| io::Error::other("agent session poisoned"))?
                        .retain_closed_pty(&response);
                    write_responses(&writer, vec![response])?;
                }
                Err(error) => write_protocol_error(&writer, &error)?,
            }
            continue;
        }
        match frame.payload {
            Some(bigbud_protocol::v1::frame::Payload::WorkspaceWatchStartRequest(request)) => {
                let prepared = {
                    let session = sessions
                        .lock()
                        .map_err(|_| io::Error::other("agent session lock was poisoned"))?;
                    session.prepare_workspace_watch_start(request)
                };
                match prepared {
                    Ok(prepared) => {
                        let subscription_id = prepared.response.subscription_id.clone();
                        add_subscriber(watch_subscribers, &subscription_id, Arc::clone(&writer))?;
                        let response = prepared.register(watchers);
                        let accepted = matches!(
                            &response.payload,
                            Some(bigbud_protocol::v1::frame::Payload::WorkspaceWatchStartResponse(
                                value
                            )) if value.accepted
                        );
                        if accepted {
                            watch_ids.insert(subscription_id);
                        } else {
                            remove_subscriber(watch_subscribers, &subscription_id, &writer)?;
                        }
                        write_responses(&writer, vec![response])?;
                    }
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
            Some(bigbud_protocol::v1::frame::Payload::WorkspaceWatchStopRequest(request)) => {
                let subscription_id = request.subscription_id.clone();
                let stopped = watchers.unsubscribe(&subscription_id);
                watch_ids.remove(&subscription_id);
                remove_subscriber(watch_subscribers, &subscription_id, &writer)?;
                let response = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))?
                    .workspace_watch_stop_response(request, stopped);
                match response {
                    Ok(response) => write_responses(&writer, vec![response])?,
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
            Some(bigbud_protocol::v1::frame::Payload::ProcessRequest(request)) => {
                let prepared = {
                    let mut session = sessions
                        .lock()
                        .map_err(|_| io::Error::other("agent session lock was poisoned"))?;
                    session.prepare_process_request(request)
                };
                match prepared {
                    Ok(prepared) => {
                        let response_result = write_responses(&writer, prepared.responses);
                        if let Some(job) = prepared.job {
                            let operation_id = job.operation_id.clone();
                            #[cfg(test)]
                            test_hooks::wait_before_process_spawn(&operation_id);
                            let subscriber_result =
                                add_subscriber(&subscribers, &operation_id, Arc::clone(&writer));
                            spawn_process_job(Arc::clone(&sessions), Arc::clone(&subscribers), job);
                            subscriber_result?;
                        }
                        response_result?;
                    }
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
            Some(bigbud_protocol::v1::frame::Payload::ProcessAttachRequest(request)) => {
                attach::attach(
                    &sessions,
                    &subscribers,
                    &writer,
                    bigbud_protocol::v1::frame::Payload::ProcessAttachRequest(request),
                )?;
            }
            Some(bigbud_protocol::v1::frame::Payload::PtyCreateRequest(request)) => {
                let prepared = {
                    let mut session = sessions
                        .lock()
                        .map_err(|_| io::Error::other("agent session lock was poisoned"))?;
                    session.prepare_pty_create(request)
                };
                match prepared {
                    Ok((response, job)) => {
                        let pty_id = match &response.payload {
                            Some(bigbud_protocol::v1::frame::Payload::PtyCreateResponse(value)) => {
                                value.pty_id.clone()
                            }
                            _ => String::new(),
                        };
                        let response_result = write_responses(&writer, vec![response]);
                        if let Some(job) = job {
                            let subscriber_result =
                                add_subscriber(&subscribers, &pty_id, Arc::clone(&writer));
                            // A lost response/subscriber cannot orphan an already-created
                            // PTY: its retention/reap worker must still take ownership.
                            spawn_pty_job(Arc::clone(&sessions), Arc::clone(&subscribers), job);
                            subscriber_result?;
                        }
                        response_result?;
                    }
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
            Some(bigbud_protocol::v1::frame::Payload::PtyAttachRequest(request)) => {
                attach::attach(
                    &sessions,
                    &subscribers,
                    &writer,
                    bigbud_protocol::v1::frame::Payload::PtyAttachRequest(request),
                )?;
            }
            Some(bigbud_protocol::v1::frame::Payload::SupervisorShutdownRequest(request)) => {
                let active_watchers = !watch_ids.is_empty() || watchers.has_active_subscriptions();
                let active_subscribers = subscribers
                    .lock()
                    .map_err(|_| io::Error::other("subscriber lock was poisoned"))?
                    .values()
                    .any(|writers| !writers.is_empty());
                let (response, accepted) = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))
                    .map(|mut session| {
                        let result = shutdown_response(
                            &mut session,
                            request,
                            active_watchers,
                            active_subscribers,
                        );
                        if result.1 {
                            session.stop_accepting_work();
                        }
                        result
                    })?;
                if accepted {
                    // This owned worker stops reading requests once shutdown is
                    // accepted. Peer loss is not cancellation of finalization.
                    return drain::complete_restart(&sessions, &writer, response);
                } else {
                    write_responses(&writer, vec![response])?;
                }
            }
            other_payload => {
                let frame = bigbud_protocol::v1::Frame {
                    payload: other_payload,
                };
                let response = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))?
                    .handle(frame);
                match response {
                    Ok(response) => {
                        if matches!(&response.payload, Some(v1::frame::Payload::AgentHello(_))) {
                            handshake.take();
                        }
                        write_responses(&writer, vec![response])?;
                    }
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
        }
    }
}

#[path = "proxy.rs"]
mod proxy;

pub use proxy::run_proxy;

#[path = "prepare.rs"]
mod prepare;

pub use prepare::{SupervisorPreparation, prepare_supervisor};

#[cfg(all(test, unix))]
#[path = "reliability.tests.rs"]
mod reliability_tests;
