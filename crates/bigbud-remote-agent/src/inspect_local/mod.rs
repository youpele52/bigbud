//! Bounded local metadata and explicitly requested private-file operations. No process control.
#[cfg(windows)]
#[path = "windows.boot.rs"]
mod boot;
#[cfg(any(windows, test))]
#[path = "windows.boot.decode.rs"]
mod boot_decode;
#[cfg(windows)]
#[path = "windows.file.rs"]
mod file;
#[cfg(windows)]
#[path = "windows.fs.rs"]
mod fs;
#[cfg(windows)]
#[path = "windows.fs.handles.rs"]
mod fs_handles;
#[cfg(windows)]
#[path = "windows.fs.lease.rs"]
mod fs_lease;
#[cfg(windows)]
#[path = "windows.fs.read.rs"]
mod fs_read;
#[cfg(windows)]
#[path = "windows.fs.write.rs"]
mod fs_write;
mod protocol;
#[cfg(windows)]
#[path = "windows.security.rs"]
mod security;
#[cfg(windows)]
#[path = "windows.security.create.rs"]
mod security_create;
pub use protocol::run_stdio;
