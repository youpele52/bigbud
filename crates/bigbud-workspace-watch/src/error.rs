#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct WorkspaceWatchHostError {
    message: String,
}

impl WorkspaceWatchHostError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceWatchError {
    #[error("workspace watch subscription ID is already active")]
    DuplicateSubscription,
    #[error("workspace watch worker stopped unexpectedly")]
    WorkerStopped,
    #[error("workspace watch resource limit reached")]
    ResourceLimit,
    #[error("workspace watch backend failed: {0}")]
    Backend(#[from] notify::Error),
    #[error("workspace watch host failed: {0}")]
    Host(#[from] WorkspaceWatchHostError),
}

impl WorkspaceWatchError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DuplicateSubscription => "DUPLICATE_SUBSCRIPTION",
            Self::WorkerStopped => "WATCH_WORKER_STOPPED",
            Self::ResourceLimit => "RESOURCE_LIMIT",
            Self::Backend(_) => "WATCH_BACKEND_FAILED",
            Self::Host(_) => "WORKSPACE_ERROR",
        }
    }
}
