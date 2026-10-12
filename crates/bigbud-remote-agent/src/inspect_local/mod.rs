//! Bounded, read-only local metadata mode. Never enters a process-control session.
#[cfg(windows)]
#[path = "windows.file.rs"]
mod file;
mod protocol;
#[cfg(windows)]
#[path = "windows.security.rs"]
mod security;
pub use protocol::run_stdio;
