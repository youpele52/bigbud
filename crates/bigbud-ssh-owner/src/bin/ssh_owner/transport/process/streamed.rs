//! A bounded, cancellable child whose stdin is a caller-owned descriptor.
//!
//! W2 T-backend: a deployment step may read its input from the lease socket
//! the owner accepted. Output capture, the deadline, cancellation checkpoints
//! and the process-group teardown are the shared ones in `process`.

use super::cancellable::PickerFailure;
use super::{CaptureLimits, Failure, Output, collect, teardown};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Instant;

pub(in super::super) fn run_streamed_cancellable(
    command: &mut Command,
    stdin: Stdio,
    deadline: Instant,
    stdout_limit: usize,
    is_cancelled: impl Fn() -> bool,
) -> Result<Output, PickerFailure> {
    let checkpoint = || {
        if is_cancelled() {
            Err(PickerFailure::Cancelled)
        } else {
            Ok(())
        }
    };
    command
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    checkpoint()?;
    if Instant::now() >= deadline {
        command.stdin(Stdio::null());
        return Err(Failure::TimedOut.into());
    }
    let spawned = command.spawn();
    // The command still owns the stdin descriptor; release the owner's copy so
    // the child alone sees the caller's end-of-input.
    command.stdin(Stdio::null());
    let mut child = spawned.map_err(|_| Failure::Spawn)?;
    let result = collect(
        &mut child,
        deadline,
        CaptureLimits::separate(stdout_limit),
        None,
        checkpoint,
    );
    if result.is_err() && !teardown(&mut child) {
        return Err(PickerFailure::CleanupUnconfirmed);
    }
    result
}
