use crate::workspace::WorkspaceError;

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
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
}

impl WorkspaceWatchError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DuplicateSubscription => "DUPLICATE_SUBSCRIPTION",
            Self::WorkerStopped => "WATCH_WORKER_STOPPED",
            Self::ResourceLimit => "RESOURCE_LIMIT",
            Self::Backend(_) => "WATCH_BACKEND_FAILED",
            Self::Workspace(_) => "WORKSPACE_ERROR",
        }
    }
}
