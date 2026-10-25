use crate::AgentSession;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Own the accepted shutdown independently of response admission/delivery.
/// Unknown child settlement never reaches the publication seal or process exit.
pub(super) fn complete_restart(
    sessions: &Arc<Mutex<AgentSession>>,
    writer: &super::Writer,
    mut response: bigbud_protocol::v1::Frame,
) -> io::Result<()> {
    if !settle_restart(sessions)? {
        if let Some(bigbud_protocol::v1::frame::Payload::SupervisorShutdownResponse(value)) =
            &mut response.payload
        {
            value.accepted = false;
            value.detail = "shutdown-cleanup-unknown".to_owned();
        }
        return super::write_responses(writer, vec![response]);
    }
    #[cfg(test)]
    let response_pressure = super::test_hooks::after_restart_seal(writer);
    // Nonblocking, best-effort admission: even encoded-budget exhaustion or
    // a full/dead requester cannot abandon a sealed, resource-settled shutdown.
    if let Err(error) = writer.enqueue_terminal(&response) {
        eprintln!("remote agent shutdown response unavailable: {error}");
        writer.cancel();
    }
    #[cfg(test)]
    drop(response_pressure);
    finish_restart()
}

/// The existing restart fence, with socket completion outside the session lock.
pub(super) fn settle_restart(sessions: &Arc<Mutex<AgentSession>>) -> io::Result<bool> {
    let mut settled = wait_until_idle(sessions)?;
    if !settled {
        sessions
            .lock()
            .map_err(|_| io::Error::other("agent session lock poisoned"))?
            .force_restart_work();
        settled = wait_until_idle(sessions)?;
    }
    if !settled {
        eprintln!("remote agent restart shutdown could not verify all owned work stopped");
    }
    Ok(settled)
}

fn finish_restart() -> ! {
    if let Err(error) = super::job_lifecycle::drain_all(Instant::now() + Duration::from_secs(5)) {
        // Owned work was verified settled before sealing. Transport failure
        // requires explicit cancellation, not reopening mutations or hanging.
        eprintln!("remote agent shutdown transport drain incomplete: {error}");
    }
    super::super::control::exit_supervisor();
}

fn wait_until_idle(sessions: &Arc<Mutex<AgentSession>>) -> io::Result<bool> {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if super::job_lifecycle::settled()
            && sessions
                .lock()
                .map_err(|_| io::Error::other("agent session lock poisoned"))?
                .restart_work_idle()
            && super::job_lifecycle::seal()
        {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(false)
}
