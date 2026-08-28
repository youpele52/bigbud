use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SupervisorError {
    #[error("consumer limit reached")]
    ConsumerLimit,
    #[error("consumer is not attached")]
    ConsumerMissing,
    #[error("consumer generation is stale")]
    StaleConsumerGeneration,
    #[error("consumer attach would move the applied sequence backward")]
    AttachSequenceRollback,
    #[error("consumer attach conflicts with the live generation state")]
    AttachStateConflict,
    #[error("server epoch does not match the consumer")]
    ServerEpochMismatch,
    #[error("event batch is empty")]
    EmptyBatch,
    #[error("event batch sequence is not contiguous")]
    NonContiguousSequence,
    #[error("event batch exceeds the in-flight event limit")]
    InFlightLimit,
    #[error("acknowledgement identifies an unknown batch")]
    UnknownBatch,
    #[error("acknowledgement exceeds the sent sequence")]
    AckBeyondSent,
    #[error("acknowledgement does not confirm the complete contiguous batch")]
    IncompleteAck,
    #[error("acknowledgement moves the applied sequence backward")]
    AckMovedBackward,
    #[error("event batch identity conflicts with an earlier batch")]
    BatchIdentityConflict,
    #[error("event batch identity does not match its canonical protobuf content")]
    InvalidBatchIdentity,
}

impl SupervisorError {
    pub fn is_fatal_session_error(&self) -> bool {
        matches!(
            self,
            Self::BatchIdentityConflict | Self::InvalidBatchIdentity
        )
    }
}
