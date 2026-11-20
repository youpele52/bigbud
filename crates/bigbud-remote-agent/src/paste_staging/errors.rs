use std::io;
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct PasteLimits {
    pub max_chunk_bytes: u64,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_uploads: usize,
    pub upload_idle: Duration,
    pub ttl: Duration,
}

impl Default for PasteLimits {
    fn default() -> Self {
        Self {
            // Leaves room for frame overhead under the 1 MiB agent frame cap.
            max_chunk_bytes: 512 * 1024,
            max_file_bytes: 256 * 1024 * 1024,
            max_total_bytes: 512 * 1024 * 1024,
            max_uploads: 8,
            upload_idle: Duration::from_secs(10 * 60),
            ttl: Duration::from_secs(24 * 60 * 60),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PasteError {
    #[error("invalid paste staging request: {0}")]
    InvalidArgument(&'static str),
    #[error("the file exceeds the paste size limit")]
    TooLarge,
    #[error("paste staging limit reached: {0}")]
    ResourceLimit(&'static str),
    #[error("unknown or expired paste upload")]
    UnknownUpload,
    #[error("paste chunk does not continue the upload")]
    OutOfOrder,
    #[error("the paste upload is incomplete")]
    Incomplete,
    #[error("the pasted file digest does not match")]
    DigestMismatch,
    #[error("the paste folder is not private: {0}")]
    Insecure(String),
    #[error("paste staging I/O failed: {0}")]
    Io(#[from] io::Error),
}

impl PasteError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArgument(_) => "INVALID_ARGUMENT",
            Self::TooLarge => "TOO_LARGE",
            Self::ResourceLimit(_) => "RESOURCE_LIMIT",
            Self::UnknownUpload => "UNKNOWN_UPLOAD",
            Self::OutOfOrder => "OUT_OF_ORDER",
            Self::Incomplete => "INCOMPLETE",
            Self::DigestMismatch => "DIGEST_MISMATCH",
            Self::Insecure(_) => "INSECURE",
            Self::Io(_) => "IO",
        }
    }
}
