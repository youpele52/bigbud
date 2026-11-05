//! Executable role entry points. Only the guard lifecycle exists, on macOS in
//! debug builds; release builds keep refusing every role until the switch.
#[cfg(all(target_os = "macos", debug_assertions))]
pub mod guard;
#[cfg(all(target_os = "macos", debug_assertions))]
mod guard_control;
