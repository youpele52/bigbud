//! Native SSH-owner transport and protocol primitives.

pub mod framing;
pub mod git_receive_gate;
#[cfg(unix)]
pub mod opencode_v1;
pub mod storage_digest;
#[cfg(windows)]
pub mod windows_owner_pipe;
#[cfg(all(test, not(windows)))]
mod windows_owner_pipe;
pub mod windows_password_gate;
