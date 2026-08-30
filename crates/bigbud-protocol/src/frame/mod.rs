mod codec;
mod error;

pub use codec::{decode_frame, encode_frame, read_frame, write_frame};
pub use error::FrameError;

#[cfg(test)]
#[path = "resource_cleanup.tests.rs"]
mod resource_cleanup_tests;
