//! Terminal paste staging: pasted or dropped files land in the agent's private paste folder and
//! are returned as absolute paths on this host, grouped by terminal-generation scope.

mod clipboard;
mod errors;
mod names;
mod store;

pub use clipboard::{ClipboardOutcome, set_image_clipboard};
pub use errors::{PasteError, PasteLimits};
pub use names::{is_valid_extension, is_valid_image_mime_type, is_valid_scope, is_valid_upload_id};
pub use store::{CommittedPaste, PasteStore};

#[cfg(test)]
#[path = "store.tests.rs"]
mod store_tests;
