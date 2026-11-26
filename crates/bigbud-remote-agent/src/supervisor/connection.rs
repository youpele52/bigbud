//! One supervisor connection's request loop. Lifecycle frames that must not run under the
//! session lock (snapshots, close-all) are routed to `connection.lifecycle.rs`.

use super::*;

pub(super) fn serve_connection_loop(
    stream: UnixStream,
    sessions: Arc<Mutex<AgentSession>>,
    subscribers: Subscribers,
    watch_subscribers: &Subscribers,
    watchers: &WorkspaceWatchRegistry,
    watch_ids: &mut HashSet<String>,
    connection: (
        Writer,
        frame_reader::HandshakePermit,
        &mut crate::search::SearchWorkers,
        Option<&Arc<host_runtime::HostRuntime>>,
    ),
) -> io::Result<()> {
    // Ordinary connections remain available if managed-only peer evidence cannot be obtained.
    let service_peer = crate::service_lease::Peer::read(&stream).ok();
    let (writer, handshake, searches, runtime) = connection;
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
        if frame
            .payload
            .as_ref()
            .is_some_and(crate::service_lease::is_request)
        {
            let prepared = match service_peer.clone() {
                Some(peer) => sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session poisoned"))?
                    .prepare_service_lease(
                        frame
                            .payload
                            .ok_or_else(|| io::Error::other("missing payload"))?,
                        peer,
                    ),
                None => Err(crate::SessionError::ServiceLeaseUnavailable),
            };
            match prepared {
                Ok(work) => write_responses(&writer, vec![work.execute()])?,
                Err(error) => write_protocol_error(&writer, &error)?,
            }
            continue;
        }
        if let Some(runtime) = runtime
            && frame
                .payload
                .as_ref()
                .is_some_and(connection_lifecycle::is_offloaded)
        {
            connection_lifecycle::handle(&sessions, runtime, &writer, frame.payload)?;
            continue;
        }
        if frame
            .payload
            .as_ref()
            .is_some_and(crate::session::is_blocking_pty_control)
        {
            // A terminating close waits for its escalation; keep this read loop free (R8).
            connection_lifecycle::close_off_loop(&sessions, &writer, frame.payload)?;
            continue;
        }
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
            Some(v1::frame::Payload::PtyDetachRequest(request)) => {
                detach::detach(&subscribers, &writer, request)?;
            }
            Some(v1::frame::Payload::WorkspaceSearchRequest(request)) => {
                search::start(&sessions, &writer, searches, request)?;
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
                // Unsolicited 1.9 lifecycle frames go only to clients that know them.
                let lifecycle_client = matches!(&other_payload,
                    Some(v1::frame::Payload::ClientHello(hello)) if hello.protocol_minor >= 9);
                let frame = bigbud_protocol::v1::Frame {
                    payload: other_payload,
                };
                let response = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))?
                    .handle(frame);
                match response {
                    Ok(mut response) => {
                        let mut admitted_owner = false;
                        if let Some(v1::frame::Payload::AgentHello(hello)) = &mut response.payload {
                            // Detach is a supervisor connection capability, not stdio session control.
                            hello.capabilities.push(v1::Capability {
                                name: "terminal.pty-detach".to_owned(),
                                major: 1,
                                minor: 0,
                            });
                            handshake.take();
                            admitted_owner = !control_only;
                        }
                        write_responses(&writer, vec![response])?;
                        // Data connections are owners (they stop the orphan timer); registered
                        // after the hello so no lifecycle frame can precede it.
                        if admitted_owner && let Some(runtime) = runtime {
                            runtime.add_owner(&writer, lifecycle_client);
                        }
                    }
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
        }
    }
}
