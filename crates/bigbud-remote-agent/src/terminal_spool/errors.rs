use std::io;
use std::time::Duration;

/// Spool sizes and cadences (terminal lifecycle plan §8.3). Tests shrink them; production uses
/// [`SpoolLimits::default`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpoolLimits {
    /// Size of each of the two rotating raw segments.
    pub segment_bytes: u64,
    /// Largest opaque checkpoint blob accepted.
    pub checkpoint_max_bytes: usize,
    /// Total on-disk budget for every spool under one host.
    pub host_budget_bytes: u64,
    /// Segment writes are buffered up to this size before hitting the file.
    pub buffer_bytes: usize,
    /// Buffered segment bytes are flushed at least this often.
    pub flush_interval: Duration,
    /// A checkpoint is requested this often while output arrives.
    pub checkpoint_interval: Duration,
    /// `lost` spools are kept this long unless dismissed first.
    pub lost_retention_ms: u64,
    /// Writer queue capacity in messages.
    pub queue_messages: usize,
    /// Writer queue capacity in output bytes; overflow degrades the spool.
    pub queue_bytes: usize,
}

impl Default for SpoolLimits {
    fn default() -> Self {
        Self {
            segment_bytes: 4 * 1024 * 1024,
            checkpoint_max_bytes: 2 * 1024 * 1024,
            host_budget_bytes: 512 * 1024 * 1024,
            buffer_bytes: 64 * 1024,
            flush_interval: Duration::from_secs(2),
            checkpoint_interval: Duration::from_secs(30),
            lost_retention_ms: 7 * 24 * 60 * 60 * 1000,
            queue_messages: 512,
            queue_bytes: 8 * 1024 * 1024,
        }
    }
}

impl SpoolLimits {
    /// Worst-case bytes one spool may occupy: two segments plus a checkpoint (≤ 10 MiB by default).
    pub fn per_terminal_bytes(&self) -> u64 {
        let checkpoint = u64::try_from(self.checkpoint_max_bytes).unwrap_or(u64::MAX);
        self.segment_bytes
            .saturating_mul(2)
            .saturating_add(checkpoint)
            .saturating_add(super::checkpoint::HEADER_BYTES)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpoolError {
    #[error("invalid spool request: {0}")]
    InvalidArgument(&'static str),
    #[error("the spool checkpoint exceeds {0} bytes")]
    CheckpointTooLarge(usize),
    #[error("the spool writer queue is full")]
    QueueFull,
    #[error("the spool writer has stopped")]
    WriterStopped,
    #[error("the spool is degraded and no longer records output")]
    Degraded,
    #[error("a writer is still active for this spool")]
    Busy,
    #[error("unknown spool")]
    Unknown,
    #[error("the spool metadata is corrupt")]
    Corrupt,
    #[error("the spool folder is not private: {0}")]
    Insecure(String),
    #[error("spool I/O failed: {0}")]
    Io(#[from] io::Error),
}

impl SpoolError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArgument(_) => "INVALID_ARGUMENT",
            Self::CheckpointTooLarge(_) => "TOO_LARGE",
            Self::QueueFull => "QUEUE_FULL",
            Self::WriterStopped => "WRITER_STOPPED",
            Self::Degraded => "SPOOL_DEGRADED",
            Self::Busy => "BUSY",
            Self::Unknown => "UNKNOWN",
            Self::Corrupt => "CORRUPT",
            Self::Insecure(_) => "INSECURE",
            Self::Io(_) => "IO",
        }
    }
}
