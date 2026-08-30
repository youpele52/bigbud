use std::collections::VecDeque;
use std::io::{self, BufReader, BufWriter};
#[cfg(test)]
use std::io::{Read, Write};
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, v1};
#[cfg(test)]
use bigbud_protocol::{read_frame, write_frame};

use super::contract::{validate_bootstrap, validate_request};

const REPLAY_CAPACITY: usize = 1;

struct AcceptedRequest {
    request: v1::ResourceCleanupRequest,
    response: v1::ResourceCleanupResponse,
}

pub fn run_stdio() -> io::Result<()> {
    concurrent::run(BufReader::new(io::stdin()), BufWriter::new(io::stdout()))
}

#[cfg(test)]
fn run(reader: impl Read, writer: impl Write, activity: Option<&AtomicU64>) -> io::Result<()> {
    let mut reader = reader;
    let mut writer = writer;
    let mut executor = PlatformExecutor::new();
    let mut ready = false;
    let mut accepted = VecDeque::new();
    while let Some(frame) = read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
    {
        if let Some(activity) = activity {
            activity.store(now_unix_seconds(), Ordering::Release);
        }
        let response = match frame.payload {
            Some(v1::frame::Payload::ClientHello(hello)) if !ready => {
                if hello.protocol_major != PROTOCOL_MAJOR
                    || hello.protocol_minor < PROTOCOL_MINOR
                    || hello.client_instance_id.is_empty()
                {
                    protocol_error("UNSUPPORTED_PROTOCOL", "incompatible cleanup client")
                } else {
                    ready = true;
                    hello_frame()
                }
            }
            Some(v1::frame::Payload::ResourceCleanupRootBootstrapRequest(request)) if ready => {
                let request_id = request.request_id.clone();
                match validate_bootstrap(&request).and_then(|()| executor.bootstrap(request.roots))
                {
                    Ok(roots) => v1::Frame {
                        payload: Some(v1::frame::Payload::ResourceCleanupRootBootstrapResponse(
                            v1::ResourceCleanupRootBootstrapResponse {
                                request_id,
                                accepted: true,
                                error_code: String::new(),
                                roots,
                            },
                        )),
                    },
                    Err(code) => v1::Frame {
                        payload: Some(v1::frame::Payload::ResourceCleanupRootBootstrapResponse(
                            v1::ResourceCleanupRootBootstrapResponse {
                                request_id,
                                accepted: false,
                                error_code: code,
                                roots: Vec::new(),
                            },
                        )),
                    },
                }
            }
            Some(v1::frame::Payload::ResourceCleanupRequest(request)) if ready => {
                match admit_cleanup_request(&request, &executor, &accepted) {
                    Ok(()) => {
                        super::reset_cancellation();
                        handle_cleanup_request(request, &mut executor, &mut accepted)
                    }
                    Err(response) => *response,
                }
            }
            Some(v1::frame::Payload::ResourceCleanupKeepAliveRequest(request)) if ready => {
                v1::Frame {
                    payload: Some(v1::frame::Payload::ResourceCleanupKeepAliveResponse(
                        v1::ResourceCleanupKeepAliveResponse {
                            request_id: request.request_id,
                        },
                    )),
                }
            }
            _ => protocol_error(
                "UNEXPECTED_MESSAGE",
                "cleanup mode accepts cleanup frames only",
            ),
        };
        write_frame(&mut writer, &response, DEFAULT_MAX_FRAME_BYTES)
            .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
        writer.flush()?;
    }
    Ok(())
}

fn handle_cleanup_request(
    request: v1::ResourceCleanupRequest,
    executor: &mut PlatformExecutor,
    accepted: &mut VecDeque<AcceptedRequest>,
) -> v1::Frame {
    let request_id = request.request_id.clone();
    let operation_id = request.operation_id.clone();
    let accepted_request = request.clone();
    let results = executor.execute(request);
    let record = AcceptedRequest {
        request: accepted_request,
        response: v1::ResourceCleanupResponse {
            request_id,
            operation_id,
            results,
        },
    };
    let response = record.response.clone();
    if accepted.len() == REPLAY_CAPACITY {
        accepted.pop_front();
    }
    accepted.push_back(record);
    v1::Frame {
        payload: Some(v1::frame::Payload::ResourceCleanupResponse(response)),
    }
}

fn admit_cleanup_request(
    request: &v1::ResourceCleanupRequest,
    executor: &PlatformExecutor,
    accepted: &VecDeque<AcceptedRequest>,
) -> Result<(), Box<v1::Frame>> {
    if let Some(previous) = accepted
        .iter()
        .find(|previous| previous.request.request_id == request.request_id)
    {
        return Err(Box::new(if previous.request == *request {
            v1::Frame {
                payload: Some(v1::frame::Payload::ResourceCleanupResponse(
                    previous.response.clone(),
                )),
            }
        } else {
            protocol_error("REQUEST_ID_CONFLICT", "cleanup request identity changed")
        }));
    }
    if let Some(previous) = accepted
        .iter()
        .find(|previous| previous.request.operation_id == request.operation_id)
    {
        if previous.request.plan_digest != request.plan_digest
            || previous.request.finalize_proof_digest != request.finalize_proof_digest
        {
            return Err(Box::new(protocol_error(
                "OPERATION_DIGEST_CONFLICT",
                "cleanup operation proof changed",
            )));
        }
        if previous.request.page_digest == request.page_digest {
            let mut prior = previous.request.clone();
            let mut replay = request.clone();
            prior.request_id.clear();
            replay.request_id.clear();
            return Err(Box::new(if prior == replay {
                let mut response = previous.response.clone();
                response.request_id = request.request_id.clone();
                v1::Frame {
                    payload: Some(v1::frame::Payload::ResourceCleanupResponse(response)),
                }
            } else {
                protocol_error("OPERATION_PAGE_CONFLICT", "cleanup page identity changed")
            }));
        }
    }
    if let Err(code) = validate_request(request).and_then(|()| executor.validate_handles(request)) {
        return Err(Box::new(protocol_error(&code, "cleanup request rejected")));
    }
    Ok(())
}

#[cfg(test)]
fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

#[path = "session.concurrent.rs"]
mod concurrent;

fn hello_frame() -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::AgentHello(v1::AgentHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            agent_version: crate::identity::build_version().to_owned(),
            build_digest: crate::identity::build_digest().to_owned(),
            os: std::env::consts::OS.to_owned(),
            architecture: std::env::consts::ARCH.to_owned(),
            agent_instance_id: format!("cleanup-{}", std::process::id()),
            agent_epoch: String::new(),
            capabilities: vec![v1::Capability {
                name: "resource.cleanup".to_owned(),
                major: 1,
                minor: 0,
            }],
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
            max_operation_output_bytes: 0,
            max_journal_bytes: 0,
        })),
    }
}

fn protocol_error(code: &str, message: &str) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ProtocolError(v1::ProtocolError {
            request_id: String::new(),
            code: code.to_owned(),
            message: message.to_owned(),
        })),
    }
}

#[cfg(unix)]
type PlatformExecutor = super::unix::UnixExecutor;
#[cfg(windows)]
type PlatformExecutor = super::windows::WindowsExecutor;

#[cfg(test)]
#[path = "session.tests.rs"]
mod tests;
