mod frame;
mod generated;

pub use frame::{FrameError, decode_frame, encode_frame, read_frame, write_frame};
pub use generated::v1;

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 1;
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;
