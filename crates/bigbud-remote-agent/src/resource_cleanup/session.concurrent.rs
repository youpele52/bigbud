use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, read_frame, v1, write_frame};

use super::{
    AcceptedRequest, PlatformExecutor, admit_cleanup_request, handle_cleanup_request, hello_frame,
    protocol_error,
};

enum Input {
    Frame(v1::Frame),
    Eof,
    Failed(String),
}

struct Completed {
    executor: PlatformExecutor,
    accepted: VecDeque<AcceptedRequest>,
    response: v1::Frame,
}

pub(super) fn run(reader: impl Read + Send + 'static, mut writer: impl Write) -> io::Result<()> {
    let (input_tx, input_rx) = mpsc::sync_channel(8);
    let _reader_thread = std::thread::spawn(move || {
        let mut reader = reader;
        loop {
            match read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES) {
                Ok(Some(frame)) => {
                    if input_tx.send(Input::Frame(frame)).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ignored = input_tx.send(Input::Eof);
                    return;
                }
                Err(error) => {
                    let _ignored = input_tx.send(Input::Failed(error.to_string()));
                    return;
                }
            }
        }
    });
    let (completed_tx, completed_rx) = mpsc::sync_channel::<Completed>(1);
    let mut executor = Some(PlatformExecutor::new());
    let mut accepted = Some(VecDeque::new());
    let mut active_operation: Option<String> = None;
    let mut ready = false;
    let mut last_activity = Instant::now();
    let mut closing_at: Option<Instant> = None;

    loop {
        if let Ok(completed) = completed_rx.try_recv() {
            active_operation = None;
            executor = Some(completed.executor);
            accepted = Some(completed.accepted);
            write(&mut writer, &completed.response)?;
            if closing_at.is_some() {
                break;
            }
        }
        if closing_at.is_some_and(|started| started.elapsed() >= Duration::from_secs(2)) {
            break;
        }
        if active_operation.is_none() && last_activity.elapsed() >= Duration::from_secs(60) {
            break;
        }

        match input_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(Input::Frame(frame)) => {
                last_activity = Instant::now();
                let response = match frame.payload {
                    Some(v1::frame::Payload::ClientHello(hello)) if !ready => {
                        if hello.protocol_major != bigbud_protocol::PROTOCOL_MAJOR
                            || hello.protocol_minor < bigbud_protocol::PROTOCOL_MINOR
                            || hello.client_instance_id.is_empty()
                        {
                            Some(protocol_error(
                                "UNSUPPORTED_PROTOCOL",
                                "incompatible cleanup client",
                            ))
                        } else {
                            ready = true;
                            Some(hello_frame())
                        }
                    }
                    Some(v1::frame::Payload::ResourceCleanupRootBootstrapRequest(request))
                        if ready && active_operation.is_none() =>
                    {
                        let request_id = request.request_id.clone();
                        let result = super::validate_bootstrap(&request).and_then(|()| {
                            executor
                                .as_mut()
                                .ok_or_else(|| "EXECUTOR_BUSY".to_owned())?
                                .bootstrap(request.roots)
                        });
                        Some(v1::Frame {
                            payload: Some(
                                v1::frame::Payload::ResourceCleanupRootBootstrapResponse(
                                    match result {
                                        Ok(roots) => v1::ResourceCleanupRootBootstrapResponse {
                                            request_id,
                                            accepted: true,
                                            error_code: String::new(),
                                            roots,
                                        },
                                        Err(error_code) => {
                                            v1::ResourceCleanupRootBootstrapResponse {
                                                request_id,
                                                accepted: false,
                                                error_code,
                                                roots: Vec::new(),
                                            }
                                        }
                                    },
                                ),
                            ),
                        })
                    }
                    Some(v1::frame::Payload::ResourceCleanupRequest(request)) if ready => {
                        if active_operation.is_some() {
                            Some(protocol_error(
                                "EXECUTOR_BUSY",
                                "cleanup request already active",
                            ))
                        } else {
                            let admission = admit_cleanup_request(
                                &request,
                                executor.as_ref().ok_or_else(|| {
                                    io::Error::other("cleanup executor ownership was lost")
                                })?,
                                accepted.as_ref().ok_or_else(|| {
                                    io::Error::other("cleanup replay state ownership was lost")
                                })?,
                            );
                            match admission {
                                Err(response) => Some(*response),
                                Ok(()) => {
                                    active_operation = Some(request.operation_id.clone());
                                    super::super::reset_cancellation();
                                    let mut owned_executor = executor.take().ok_or_else(|| {
                                        io::Error::other("cleanup executor ownership was lost")
                                    })?;
                                    let mut owned_accepted = accepted.take().ok_or_else(|| {
                                        io::Error::other("cleanup replay state ownership was lost")
                                    })?;
                                    let completed_tx = completed_tx.clone();
                                    std::thread::spawn(move || {
                                        let response = handle_cleanup_request(
                                            request,
                                            &mut owned_executor,
                                            &mut owned_accepted,
                                        );
                                        let _ignored = completed_tx.send(Completed {
                                            executor: owned_executor,
                                            accepted: owned_accepted,
                                            response,
                                        });
                                    });
                                    None
                                }
                            }
                        }
                    }
                    Some(v1::frame::Payload::ResourceCleanupCancelRequest(request)) if ready => {
                        let cancellation_requested = active_operation
                            .as_ref()
                            .is_some_and(|operation| operation == &request.operation_id);
                        if cancellation_requested {
                            super::super::request_cancellation();
                        }
                        Some(v1::Frame {
                            payload: Some(v1::frame::Payload::ResourceCleanupCancelResponse(
                                v1::ResourceCleanupCancelResponse {
                                    request_id: request.request_id,
                                    operation_id: request.operation_id,
                                    cancellation_requested,
                                    terminal: !cancellation_requested,
                                },
                            )),
                        })
                    }
                    Some(v1::frame::Payload::ResourceCleanupKeepAliveRequest(request)) if ready => {
                        Some(v1::Frame {
                            payload: Some(v1::frame::Payload::ResourceCleanupKeepAliveResponse(
                                v1::ResourceCleanupKeepAliveResponse {
                                    request_id: request.request_id,
                                },
                            )),
                        })
                    }
                    _ => Some(protocol_error(
                        "UNEXPECTED_MESSAGE",
                        "cleanup mode accepts cleanup frames only",
                    )),
                };
                if let Some(response) = response {
                    write(&mut writer, &response)?;
                }
            }
            Ok(Input::Eof) => {
                if active_operation.is_some() {
                    super::super::request_cancellation();
                    closing_at = Some(Instant::now());
                } else {
                    break;
                }
            }
            Ok(Input::Failed(detail)) => {
                return Err(io::Error::new(io::ErrorKind::InvalidData, detail));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    super::super::request_cancellation();
    Ok(())
}

fn write(writer: &mut impl Write, frame: &v1::Frame) -> io::Result<()> {
    write_frame(writer, frame, DEFAULT_MAX_FRAME_BYTES)
        .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
    writer.flush()
}
