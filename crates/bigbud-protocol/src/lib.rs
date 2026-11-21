pub mod computer_use;
mod frame;
mod generated;

pub use frame::{
    FrameError, decode_frame, encode_frame, encoded_frame_length, read_frame, write_frame,
};
pub use generated::{service_lease, v1};

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 9;
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Protocol 1.9 terminal lifecycle limits and names (`pty_lifecycle.proto`).
pub mod pty_lifecycle {
    pub const SCREEN_CAPABILITY: &str = "terminal.screen";
    pub const LIFECYCLE_CAPABILITY: &str = "terminal.lifecycle";
    pub const SPOOL_CAPABILITY: &str = "terminal.spool";
    pub const QUERY_RESPONDER_CAPABILITY: &str = "terminal.query-responder";
    pub const LOCAL_LAUNCH_CAPABILITY: &str = "terminal.local-launch";
    /// Largest `PtyScreenSnapshotChunk.bytes`.
    pub const SNAPSHOT_CHUNK_MAX_BYTES: usize = 192 * 1024;
    /// Largest `PtyScreenSnapshotHeader.chunk_count`.
    pub const SNAPSHOT_MAX_CHUNKS: u32 = 16;
    /// Largest `PtyScreenSnapshotHeader.total_ansi_bytes`.
    pub const SNAPSHOT_MAX_TOTAL_BYTES: u64 = 3 * 1024 * 1024;
    /// Largest `PtyScreenSnapshotHeader.pending_escape_tail`.
    pub const SNAPSHOT_MAX_ESCAPE_TAIL_BYTES: usize = 16 * 1024;
    /// Default snapshot cap in UTF-16 units (the web recovery contract).
    pub const SNAPSHOT_DEFAULT_MAX_ANSI_UNITS: u32 = 1_048_576;
    pub const SNAPSHOT_BUSY: &str = "SNAPSHOT_BUSY";
    pub const PTY_LIMIT_REACHED: &str = "PTY_LIMIT_REACHED";
    pub const UNSUPPORTED: &str = "UNSUPPORTED";
}
