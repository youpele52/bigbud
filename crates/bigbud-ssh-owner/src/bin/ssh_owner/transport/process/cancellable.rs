use super::{CaptureLimits, Failure, Output, run_command};
use std::process::Command;
use std::time::Instant;

pub(in super::super) enum PickerFailure {
    Cancelled,
    CleanupUnconfirmed,
    Process(Failure),
}

impl From<Failure> for PickerFailure {
    fn from(failure: Failure) -> Self {
        Self::Process(failure)
    }
}

pub(in super::super) fn run_picker_cancellable(
    command: Command,
    deadline: Instant,
    limit: usize,
    is_cancelled: impl Fn() -> bool,
) -> Result<Output, PickerFailure> {
    run_cancellable(
        command,
        deadline,
        CaptureLimits::separate(limit),
        is_cancelled,
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(in super::super) fn run_with_combined_output_limit_cancellable(
    command: Command,
    deadline: Instant,
    limit: usize,
    is_cancelled: impl Fn() -> bool,
) -> Result<Output, PickerFailure> {
    run_cancellable(
        super::clean(command),
        deadline,
        CaptureLimits::combined(limit),
        is_cancelled,
    )
}

fn run_cancellable(
    command: Command,
    deadline: Instant,
    limits: CaptureLimits,
    is_cancelled: impl Fn() -> bool,
) -> Result<Output, PickerFailure> {
    run_command(
        command,
        deadline,
        limits,
        None,
        || {
            if is_cancelled() {
                Err(PickerFailure::Cancelled)
            } else {
                Ok(())
            }
        },
        Some(PickerFailure::CleanupUnconfirmed),
    )
}
