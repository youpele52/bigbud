use std::sync::{Arc, Mutex};

#[path = "jobs.backpressure.rs"]
mod backpressure;
#[path = "jobs.output.rs"]
mod output;

use super::Subscribers;
use super::io_helpers::{broadcast_response, broadcast_responses, remove_all_subscribers};
use crate::{AgentSession, ProcessJob, process::ProcessOptions};

pub(super) fn spawn_pty_job(
    sessions: Arc<Mutex<AgentSession>>,
    subscribers: Subscribers,
    job: crate::pty::PtyJob,
) {
    let completion = super::job_lifecycle::Completion::begin();
    let pty_id = job.handle.id.clone();
    std::thread::spawn(move || {
        let _completion = completion;
        // Resolved once; lifecycle work runs after the session lock is released (plan §14).
        let lifecycle = sessions
            .lock()
            .ok()
            .and_then(|mut session| session.pty_lifecycle(&pty_id).ok());
        let mut gate = backpressure::Gate::new(&pty_id, &subscribers, lifecycle.clone());
        let ready = move || gate.ready();
        crate::pty::run_events_gated(job.reader, &job.handle, ready, |event| match event {
            crate::pty::PtyEvent::Output(bytes) => {
                let recorded = sessions
                    .lock()
                    .ok()
                    .and_then(|mut session| session.record_pty_output(&pty_id, bytes).ok());
                if let Some((response, chunk)) = recorded {
                    // Delivery first: the screen feed may wait up to 45 ms for actor space.
                    backpressure::broadcast_paced(&subscribers, &pty_id, &response);
                    drop(response);
                    if let Some(lifecycle) = &lifecycle {
                        lifecycle.on_output(chunk.sequence, chunk.bytes);
                    }
                }
            }
            crate::pty::PtyEvent::Exited { exit_code, signal } => {
                if let Some(lifecycle) = &lifecycle {
                    lifecycle.on_exit();
                }
                let response = sessions
                    .lock()
                    .ok()
                    .and_then(|mut session| session.complete_pty(&pty_id, exit_code, signal).ok());
                if let Some(response) = response {
                    backpressure::broadcast_paced(&subscribers, &pty_id, &response);
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
    let completion = super::job_lifecycle::Completion::begin();
    std::thread::spawn(move || {
        let _completion = completion;
        let operation_id = job.operation_id.clone();
        let (output_sender, output_receiver) = output::channel();
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
                        // Only loss of this job's consumer can disconnect this
                        // handoff; client detach never drops the receiver.
                        let _consumer_gone = output_sender.send(stream, bytes);
                    }),
                )
            }
        });
        // Keep draining even after cancellation: the runner must join its
        // readers, and completion must follow all admitted output chunks.
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
            #[cfg(test)]
            super::test_hooks::completion_barrier(&operation_id);
            let _ = broadcast_responses(&subscribers, &operation_id, responses);
            remove_all_subscribers(&subscribers, &operation_id);
        }
    });
}
