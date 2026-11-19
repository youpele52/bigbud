use super::request::{MAX_OS_INDEX_QUERY_CHARS, MAX_OS_INDEX_SCOPES};

/// Why an OS-index search could not run. Messages never include the query or any path.
#[derive(Debug, Clone, Copy, thiserror::Error, PartialEq, Eq)]
pub enum OsIndexError {
    #[error("os index search query cannot be empty")]
    EmptyQuery,
    #[error("os index search query is longer than {MAX_OS_INDEX_QUERY_CHARS} characters")]
    QueryTooLong,
    #[error("os index search query contains a control character")]
    ControlCharacter,
    #[error("os index search requires at least one scope")]
    NoScopes,
    #[error("os index search carries more than {MAX_OS_INDEX_SCOPES} scopes")]
    TooManyScopes,
    #[error("os index search scopes must be existing, canonical, absolute UTF-8 folders")]
    InvalidScope,
    #[error("os index search scope is excluded")]
    ExcludedScope,
    #[error("the home folder cannot be resolved or read")]
    HomeUnavailable,
    #[error("the embedded os index exclusion list is invalid")]
    ExclusionsInvalid,
    #[error("searching this computer is not supported on this platform")]
    Unsupported,
    #[error("the os index rejected the query")]
    QueryRejected,
    #[error("the os index could not start the query")]
    Unavailable,
}

impl OsIndexError {
    /// Stable wire code for the later `OsIndexSearchCompleted` frame.
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyQuery => "EMPTY_SEARCH_QUERY",
            Self::TooManyScopes => "TOO_MANY_ROOTS",
            Self::QueryTooLong
            | Self::ControlCharacter
            | Self::NoScopes
            | Self::InvalidScope
            | Self::ExcludedScope => "INVALID_ARGUMENT",
            Self::Unsupported => "UNSUPPORTED",
            Self::HomeUnavailable
            | Self::ExclusionsInvalid
            | Self::QueryRejected
            | Self::Unavailable => "UNAVAILABLE",
        }
    }
}
