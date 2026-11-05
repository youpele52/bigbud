use super::{
    deadline::{FRAME_DEADLINE, FrameClock, watch},
    framing::{ControlReadError, ReadOutcome, read_frame, write_frame},
    session::{Request, classify, guard_hello, protocol_error, revoked_frame, status_frame},
};
use crate::guard::{GuardServiceControl, PriorityRetirement, RetirementCause};
use bigbud_protocol::computer_use::{FrameError, v1};
use std::{
    io::{Read, Write},
    thread,
    time::{Duration, Instant},
};

/// Upper bound for answering Stop; the in-memory revoke is immediate.
pub(crate) const STOP_CONFIRMATION: Duration = Duration::from_secs(2);
const STOP_POLL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Copy)]
pub(crate) struct ControlConfig {
    pub(crate) stop_confirmation: Duration,
    pub(crate) frame_deadline: Duration,
}
impl Default for ControlConfig {
    fn default() -> Self {
        Self {
            stop_confirmation: STOP_CONFIRMATION,
            frame_deadline: FRAME_DEADLINE,
        }
    }
}

/// Output is best effort: losing stdout must not weaken stdin Stop/lifeline.
struct Output<W> {
    writer: W,
    open: bool,
}
impl<W: Write> Output<W> {
    fn send(&mut self, frame: &v1::Frame) {
        if self.open && write_frame(&mut self.writer, frame).is_err() {
            self.open = false;
        }
    }
}

/// Persisted pause epoch once a requested denial is durably latched.
fn await_durable_latch(control: &GuardServiceControl, within: Duration) -> Option<u64> {
    let started = Instant::now();
    loop {
        if let Some(status) = control.status() {
            if !status.storage_ok {
                return None;
            }
            if status.denial_persisted && status.record.latched {
                return Some(status.record.pause_epoch);
            }
        }
        if started.elapsed() >= within {
            return None;
        }
        thread::sleep(STOP_POLL);
    }
}

/// Serves the control channel until the lifeline ends, then requests the
/// guard's orderly shutdown. Malformed or incompatible input also latches.
pub(crate) fn run_control(
    mut input: impl Read,
    output: impl Write,
    control: &GuardServiceControl,
    retirement: &PriorityRetirement,
    instance_id: &str,
    config: ControlConfig,
) {
    let mut output = Output {
        writer: output,
        open: true,
    };
    let clock = FrameClock::default();
    {
        let (control, retirement) = (control.clone(), retirement.clone());
        watch(clock.clone(), config.frame_deadline, move || {
            retirement.raise(RetirementCause::MalformedLifeline);
            control.request_shutdown();
        });
    }
    output.send(&guard_hello(instance_id));
    let mut hello = false;
    loop {
        let read = read_frame(&mut input, || clock.start());
        clock.clear();
        let frame = match read {
            Ok(ReadOutcome::Frame(frame)) => *frame,
            Ok(ReadOutcome::Closed) => break,
            Err(error) => {
                let code = match error {
                    ControlReadError::Io => "lifeline_io",
                    ControlReadError::Frame(FrameError::Channel) => "wrong_channel",
                    ControlReadError::Truncated | ControlReadError::Frame(_) => "malformed_frame",
                };
                output.send(&protocol_error("", code));
                retirement.raise(RetirementCause::MalformedLifeline);
                break;
            }
        };
        match classify(frame, &mut hello) {
            Request::Accepted => {}
            Request::Status { request_id } => {
                output.send(&status_frame(&request_id, control.status().as_ref()));
            }
            Request::Stop { operation_id } => {
                retirement.raise(RetirementCause::HumanStop);
                output.send(
                    &match await_durable_latch(control, config.stop_confirmation) {
                        Some(epoch) => revoked_frame(&operation_id, epoch),
                        None => protocol_error(&operation_id, "stop_unconfirmed"),
                    },
                );
            }
            Request::Refuse { request_id, code } => {
                output.send(&protocol_error(&request_id, code));
            }
            Request::Incompatible => {
                output.send(&protocol_error("", "incompatible"));
                retirement.raise(RetirementCause::MalformedLifeline);
                break;
            }
        }
    }
    clock.finish();
    control.request_shutdown();
}

#[cfg(test)]
#[path = "channel.tests.rs"]
mod tests;
