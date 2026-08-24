mod backend;
mod error;
mod events;
mod manager;
mod manager_helpers;
mod recovery;
mod registry;

use std::path::{Path, PathBuf};

pub use error::{WorkspaceWatchError, WorkspaceWatchHostError};
pub use registry::WorkspaceWatchRegistry;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceWatchEntry {
    pub path: String,
    pub is_directory: bool,
    pub is_file: bool,
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
}

pub trait WorkspaceWatchHost: Send + Sync {
    fn canonical_root(&self) -> &Path;
    fn resolve_directory(&self, relative_path: &str) -> Result<PathBuf, WorkspaceWatchHostError>;
    fn relative_path(&self, path: &Path) -> Result<String, WorkspaceWatchHostError>;
    fn list_directory(
        &self,
        relative_path: &str,
    ) -> Result<Vec<WorkspaceWatchEntry>, WorkspaceWatchHostError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceWatchBackend {
    Native,
    Poll,
}

impl WorkspaceWatchBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Poll => "poll",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceChangeKind {
    Create,
    Modify,
    Remove,
    Unknown,
}

impl WorkspaceChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Modify => "modify",
            Self::Remove => "remove",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceChange {
    pub path: String,
    pub kind: WorkspaceChangeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceRescanReason {
    Overflow,
    WatchInvalidated,
}

impl WorkspaceRescanReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Overflow => "overflow",
            Self::WatchInvalidated => "watchInvalidated",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceWatchEvent {
    pub subscription_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub changes: Vec<WorkspaceChange>,
    pub rescan_reason: Option<WorkspaceRescanReason>,
    pub backend: WorkspaceWatchBackend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceWatchStart {
    pub generation: u64,
    pub backend: WorkspaceWatchBackend,
}
