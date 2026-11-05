use std::{io, num::NonZeroU32};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: NonZeroU32,
    pub parent: u32,
    pub group: u32,
    pub creation: String,
}

/// Native creation evidence only. Failure is uncertainty, never proof of death.
/// Linux binds start ticks to boot UUID; macOS binds start timeval to boot UUID.
/// This observation alone does NOT authorize a race-prone PID/group signal.
pub fn inspect(pid: NonZeroU32) -> io::Result<ProcessIdentity> {
    if pid.get() > i32::MAX as u32 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"));
    }
    #[cfg(target_os = "macos")]
    return super::identity_macos::inspect(pid);
    #[cfg(target_os = "linux")]
    return super::identity_linux::inspect(pid);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process identity unavailable",
    ))
}

pub(super) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid process identity")
}

pub(super) fn boot_uuid(bytes: &[u8]) -> io::Result<&str> {
    let value = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(invalid());
    }
    Ok(value)
}
