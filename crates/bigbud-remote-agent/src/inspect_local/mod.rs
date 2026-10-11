//! Bounded, read-only local metadata mode. Never enters a process-control session.
#[cfg(windows)]
#[path = "windows.file.rs"]
mod file;
#[cfg(windows)]
#[path = "windows.object.rs"]
mod object;
mod protocol;
#[cfg(windows)]
#[path = "windows.security.rs"]
mod security;
#[cfg(windows)]
mod windows;
pub use protocol::run_stdio;
