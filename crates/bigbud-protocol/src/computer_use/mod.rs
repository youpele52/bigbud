//! Independent computer-use IPC. No remote-agent versions or frame limits.
mod frame;
#[cfg(test)]
mod tests;
mod validation;
mod wire;

pub use frame::{Channel, FrameError, decode_frame, encode_frame};
pub use validation::{validate_frame, validate_hello};

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;
pub const CONTROL_FRAME_BYTES: usize = 64 * 1024;
pub const DATA_FRAME_BYTES: usize = 25 * 1024 * 1024;
pub const QUALIFICATION_PROFILE: &str = "computer-use-stage1-v1";

pub mod common {
    include!(concat!(env!("OUT_DIR"), "/bigbud.computer_use.common.rs"));
}
pub mod policy {
    include!(concat!(env!("OUT_DIR"), "/bigbud.computer_use.policy.rs"));
}
pub mod episode {
    include!(concat!(env!("OUT_DIR"), "/bigbud.computer_use.episode.rs"));
}
pub mod control {
    include!(concat!(env!("OUT_DIR"), "/bigbud.computer_use.control.rs"));
}
pub mod execution {
    include!(concat!(
        env!("OUT_DIR"),
        "/bigbud.computer_use.execution.rs"
    ));
}
pub mod outcome {
    include!(concat!(env!("OUT_DIR"), "/bigbud.computer_use.outcome.rs"));
}
pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.computer_use.v1.rs"));
}
