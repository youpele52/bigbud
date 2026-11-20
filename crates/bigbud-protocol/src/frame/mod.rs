mod codec;
mod error;

pub use codec::{decode_frame, encode_frame, encoded_frame_length, read_frame, write_frame};
pub use error::FrameError;

#[cfg(test)]
#[path = "paste_staging.tests.rs"]
mod paste_staging_tests;
#[cfg(test)]
#[path = "pty.tests.rs"]
mod pty_tests;
#[cfg(test)]
#[path = "resource_cleanup.tests.rs"]
mod resource_cleanup_tests;
#[cfg(test)]
#[path = "search.tests.rs"]
mod search_tests;
