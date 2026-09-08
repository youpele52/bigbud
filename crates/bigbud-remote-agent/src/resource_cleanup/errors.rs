use std::io;

use bigbud_protocol::v1;

pub fn outcome(error: &io::Error) -> v1::ResourceCleanupOutcome {
    match error.kind() {
        io::ErrorKind::PermissionDenied => v1::ResourceCleanupOutcome::PermissionDenied,
        io::ErrorKind::TimedOut => v1::ResourceCleanupOutcome::DeadlineExceeded,
        io::ErrorKind::WouldBlock => v1::ResourceCleanupOutcome::Busy,
        io::ErrorKind::Interrupted => v1::ResourceCleanupOutcome::ProcessFailure,
        _ if is_filesystem_loop(error) => v1::ResourceCleanupOutcome::UnsupportedEntry,
        _ if error.to_string().contains("unsupported")
            || error.to_string().contains("mount boundary")
            || error.to_string().contains("bound exceeded") =>
        {
            v1::ResourceCleanupOutcome::UnsupportedEntry
        }
        _ if error.to_string().contains("identity changed") => {
            v1::ResourceCleanupOutcome::IdentityMismatch
        }
        _ => v1::ResourceCleanupOutcome::IoFailure,
    }
}

fn is_filesystem_loop(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ELOOP)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use bigbud_protocol::v1;

    #[test]
    fn classifies_known_byte_bounds_as_terminal_retention() {
        assert_eq!(
            super::outcome(&io::Error::other("known-byte bound exceeded")),
            v1::ResourceCleanupOutcome::UnsupportedEntry
        );
    }
}
