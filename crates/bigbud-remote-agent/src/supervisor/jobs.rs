use std::sync::{Arc, Mutex, mpsc};

use super::Subscribers;
use super::io_helpers::{broadcast_response, broadcast_responses, remove_all_subscribers};
use crate::{AgentSession, ProcessJob, process::ProcessOptions};

pub(super) fn spawn_pty_job(
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

pub(super) fn spawn_process_job(
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
