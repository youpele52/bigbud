mod connection;
mod frame;
mod generated;
mod owner_session;
mod supervisor;

pub use connection::{ConnectionAction, ConnectionState, TransportHealth};
pub use frame::{FrameError, read_frame, write_frame};
pub use generated::v1;
pub use owner_session::{OwnerSession, SessionResult, error_frame, recovery_frame};
pub use supervisor::{
    ConsumerState, Delivery, Limits, RecoveryAction, Supervisor, SupervisorError,
    canonical_batch_id,
};

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 1;
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;
