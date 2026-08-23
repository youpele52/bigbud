use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, read_frame, write_frame};

use crate::{AgentSession, ProcessJob, process::ProcessOptions, protocol_error_frame};

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

#[cfg(unix)]
type Writer = Arc<Mutex<BufWriter<UnixStream>>>;

#[cfg(unix)]
type Subscribers = Arc<Mutex<HashMap<String, Vec<Writer>>>>;

#[cfg(unix)]
pub fn run_supervisor(session: AgentSession, socket_path: &Path) -> io::Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(socket_path) {
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "supervisor socket is a symlink",
            ));
        }
        if UnixStream::connect(socket_path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "remote agent supervisor is already running",
            ));
        }
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    set_private_socket_permissions(socket_path)?;
    let sessions = Arc::new(Mutex::new(session));
    let subscribers = Arc::new(Mutex::new(HashMap::new()));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let sessions = Arc::clone(&sessions);
                let subscribers = Arc::clone(&subscribers);
                std::thread::spawn(move || {
                    if let Err(error) = serve_connection(stream, sessions, subscribers) {
                        eprintln!("bigbud remote agent supervisor connection ended: {error}");
                    }
                });
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_socket_permissions(socket_path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o700))
}

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
) -> io::Result<()> {
    let reader_stream = stream.try_clone()?;
    let mut reader = BufReader::new(reader_stream);
    let writer = Arc::new(Mutex::new(BufWriter::new(stream)));
    loop {
        let frame = match read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        };
        match frame.payload {
            Some(bigbud_protocol::v1::frame::Payload::ProcessRequest(request)) => {
                let prepared = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))?
                    .prepare_process_request(request);
                match prepared {
                    Ok(prepared) => {
                        let response_result = write_responses(&writer, prepared.responses);
                        if let Some(job) = prepared.job {
                            let operation_id = job.operation_id.clone();
                            add_subscriber(&subscribers, &operation_id, Arc::clone(&writer))?;
                            spawn_process_job(Arc::clone(&sessions), Arc::clone(&subscribers), job);
                        }
                        response_result?;
                    }
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
            Some(bigbud_protocol::v1::frame::Payload::ProcessAttachRequest(request)) => {
                let operation_id = request.operation_id.clone();
                add_subscriber(&subscribers, &operation_id, Arc::clone(&writer))?;
                let response = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))?
                    .handle_process_attach(request);
                match response {
                    Ok(responses) => {
                        let live = attach_response_is_live(&responses);
                        let result = write_responses(&writer, responses);
                        if !live {
                            remove_subscriber(&subscribers, &operation_id, &writer)?;
                        }
                        result?;
                    }
                    Err(error) => {
                        remove_subscriber(&subscribers, &operation_id, &writer)?;
                        write_protocol_error(&writer, &error)?;
                    }
                }
            }
            Some(bigbud_protocol::v1::frame::Payload::PtyCreateRequest(request)) => {
                let prepared = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))?
                    .prepare_pty_create(request);
                match prepared {
                    Ok((response, job)) => {
                        let pty_id = match &response.payload {
                            Some(bigbud_protocol::v1::frame::Payload::PtyCreateResponse(value)) => {
                                value.pty_id.clone()
                            }
                            _ => String::new(),
                        };
                        write_responses(&writer, vec![response])?;
                        if let Some(job) = job {
                            add_subscriber(&subscribers, &pty_id, Arc::clone(&writer))?;
                            spawn_pty_job(Arc::clone(&sessions), Arc::clone(&subscribers), job);
                        }
                    }
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
            Some(bigbud_protocol::v1::frame::Payload::PtyAttachRequest(request)) => {
                let pty_id = request.pty_id.clone();
                add_subscriber(&subscribers, &pty_id, Arc::clone(&writer))?;
                let response = sessions
                    .lock()
                    .map_err(|_| io::Error::other("agent session lock was poisoned"))?
                    .handle_pty_attach(request);
                match response {
                    Ok(responses) => {
                        let live = pty_attach_response_is_live(&responses);
                        let result = write_responses(&writer, responses);
                        if !live {
                            remove_subscriber(&subscribers, &pty_id, &writer)?;
                        }
                        result?;
                    }
                    Err(error) => {
                        remove_subscriber(&subscribers, &pty_id, &writer)?;
                        write_protocol_error(&writer, &error)?;
                    }
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
                    Ok(response) => write_responses(&writer, vec![response])?,
                    Err(error) => write_protocol_error(&writer, &error)?,
                }
            }
        }
    }
}

#[cfg(unix)]
fn spawn_pty_job(
    sessions: Arc<Mutex<AgentSession>>,
    subscribers: Subscribers,
    job: crate::pty::PtyJob,
) {
    let pty_id = job.handle.id.clone();
    let pid = job.handle.pid;
    std::thread::spawn(move || {
        crate::pty::run_events(job.reader, pid, |event| match event {
            crate::pty::PtyEvent::Output(bytes) => {
                let response = sessions
                    .lock()
                    .ok()
                    .and_then(|mut session| session.record_pty_output(&pty_id, bytes).ok());
                if let Some(response) = response {
                    let _ = broadcast_response(&subscribers, &pty_id, response);
                }
            }
            crate::pty::PtyEvent::Exited { exit_code, signal } => {
                let response = sessions
                    .lock()
                    .ok()
                    .and_then(|mut session| session.complete_pty(&pty_id, exit_code, signal).ok());
                if let Some(response) = response {
                    let _ = broadcast_response(&subscribers, &pty_id, response);
                }
                remove_all_subscribers(&subscribers, &pty_id);
            }
        });
    });
}

#[cfg(unix)]
fn spawn_process_job(
    sessions: Arc<Mutex<AgentSession>>,
    subscribers: Subscribers,
    job: ProcessJob,
) {
    std::thread::spawn(move || {
        let operation_id = job.operation_id.clone();
        let (output_sender, output_receiver) = mpsc::channel();
        let process_thread = std::thread::spawn({
            let process_job = job.clone();
            move || {
                crate::process::run_bounded_process_with_output(
                    &process_job.workspace_root,
                    &process_job.command,
                    &process_job.args,
                    ProcessOptions {
                        environment: &process_job.environment,
                        stdin_bytes: &process_job.stdin,
                        timeout: process_job.timeout,
                        max_output_bytes: process_job.max_output_bytes,
                        cancellation: Some(&process_job.cancellation),
                    },
                    Arc::new(move |stream, bytes| {
                        let _ = output_sender.send((stream, bytes.to_vec()));
                    }),
                )
            }
        });
        for (stream, bytes) in output_receiver {
            let response = sessions.lock().ok().and_then(|mut session| {
                session
                    .record_process_output(&operation_id, stream, bytes)
                    .ok()
            });
            if let Some(response) = response {
                let _ = broadcast_response(&subscribers, &operation_id, response);
            }
        }
        let result = process_thread
            .join()
            .unwrap_or(Err(crate::process::ProcessError::ReaderJoin));
        let responses = sessions
            .lock()
            .ok()
            .and_then(|mut session| session.complete_streamed_process_job(job, result).ok());
        if let Some(responses) = responses {
            let _ = broadcast_responses(&subscribers, &operation_id, responses);
            remove_all_subscribers(&subscribers, &operation_id);
        }
    });
}

#[cfg(unix)]
fn add_subscriber(subscribers: &Subscribers, operation_id: &str, writer: Writer) -> io::Result<()> {
    subscribers
        .lock()
        .map_err(|_| io::Error::other("agent subscriber lock was poisoned"))?
        .entry(operation_id.to_owned())
        .or_default()
        .push(writer);
    Ok(())
}

#[cfg(unix)]
fn remove_subscriber(
    subscribers: &Subscribers,
    operation_id: &str,
    writer: &Writer,
) -> io::Result<()> {
    let mut subscribers = subscribers
        .lock()
        .map_err(|_| io::Error::other("agent subscriber lock was poisoned"))?;
    if let Some(writers) = subscribers.get_mut(operation_id) {
        writers.retain(|candidate| !Arc::ptr_eq(candidate, writer));
        if writers.is_empty() {
            subscribers.remove(operation_id);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn remove_all_subscribers(subscribers: &Subscribers, operation_id: &str) {
    if let Ok(mut subscribers) = subscribers.lock() {
        subscribers.remove(operation_id);
    }
}

#[cfg(unix)]
fn attach_response_is_live(responses: &[bigbud_protocol::v1::Frame]) -> bool {
    responses.iter().any(|response| {
        matches!(
            &response.payload,
            Some(bigbud_protocol::v1::frame::Payload::ProcessAttachResponse(status))
                if status.state == "accepted" || status.state == "running" || status.state == "cancelling"
        )
    })
}

#[cfg(unix)]
fn pty_attach_response_is_live(responses: &[bigbud_protocol::v1::Frame]) -> bool {
    responses.iter().any(|response| {
        matches!(
            &response.payload,
            Some(bigbud_protocol::v1::frame::Payload::PtyAttachResponse(status))
                if status.state == "running"
        )
    })
}

#[cfg(unix)]
fn broadcast_response(
    subscribers: &Subscribers,
    operation_id: &str,
    response: bigbud_protocol::v1::Frame,
) -> io::Result<()> {
    broadcast_responses(subscribers, operation_id, vec![response])
}

#[cfg(unix)]
fn broadcast_responses(
    subscribers: &Subscribers,
    operation_id: &str,
    responses: Vec<bigbud_protocol::v1::Frame>,
) -> io::Result<()> {
    let writers = subscribers
        .lock()
        .map_err(|_| io::Error::other("agent subscriber lock was poisoned"))?
        .get(operation_id)
        .cloned()
        .unwrap_or_default();
    let mut failed = Vec::new();
    for writer in writers {
        if write_responses(&writer, responses.clone()).is_err() {
            failed.push(writer);
        }
    }
    for writer in failed {
        remove_subscriber(subscribers, operation_id, &writer)?;
    }
    Ok(())
}

#[cfg(unix)]
fn write_protocol_error(
    writer: &Arc<Mutex<BufWriter<UnixStream>>>,
    error: &crate::SessionError,
) -> io::Result<()> {
    write_responses(writer, vec![protocol_error_frame(error)])
}

#[cfg(unix)]
fn write_responses(
    writer: &Arc<Mutex<BufWriter<UnixStream>>>,
    responses: Vec<bigbud_protocol::v1::Frame>,
) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("agent writer lock was poisoned"))?;
    for response in responses {
        write_frame(&mut *writer, &response, DEFAULT_MAX_FRAME_BYTES)
            .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
    }
    writer.flush()
}

#[path = "supervisor.proxy.rs"]
mod proxy;

pub use proxy::run_proxy;
