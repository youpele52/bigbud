//! Workspace search engine built on ripgrep's library crates (`ignore`, `grep-searcher`,
//! `grep-regex`). Serves the streaming `WorkspaceSearchRequest` frames and backs the legacy
//! content search.

mod content;
mod priority;
pub(crate) mod rank;
mod registry;
mod request;
mod run;
mod walk;
mod workers;

#[cfg(test)]
#[path = "run.tests.rs"]
mod run_tests;
#[cfg(test)]
mod tests;

pub use content::{LineMatch, MAX_CONTENT_FILE_BYTES, MAX_EXCERPT_CHARS, MAX_MATCHES_PER_FILE};
pub use priority::lower_current_thread_priority;
pub use registry::{MAX_CONCURRENT_SEARCHES, SearchRegisterError, SearchRegistry, SearchTicket};
pub use request::{
    MAX_SEARCH_DEADLINE, MAX_SEARCH_ROOTS, RootFailure, SearchMode, SearchRequest,
    SearchRequestError, SearchRoot, default_thread_count,
};
pub use run::{
    ContentHit, MAX_BATCH_BYTES, MAX_BATCH_HITS, NameHit, SearchBatch, SearchOutcome, StopReason,
    run_search,
};
pub use walk::ALWAYS_SKIPPED_DIRECTORIES;
pub use workers::SearchWorkers;
