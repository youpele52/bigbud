//! Inspect a bounded amount of local OpenSSH diagnostic output after failure.
//! An unavailable or ambiguous diagnostic never changes the transport outcome.

use super::{ErrorCode, LOST, UNAVAILABLE};
use std::{os::fd::OwnedFd, os::unix::net::UnixDatagram, process::Stdio};

pub(super) struct Diagnostics(UnixDatagram);

impl Diagnostics {
    pub(super) fn new() -> Result<(Self, Stdio), ErrorCode> {
        let (reader, writer) = UnixDatagram::pair().map_err(|_| UNAVAILABLE)?;
        reader.set_nonblocking(true).map_err(|_| UNAVAILABLE)?;
        // Diagnostics must never keep the SSH child blocked, even if it or
        // the remote sends more text than the kernel buffer can hold.
        writer.set_nonblocking(true).map_err(|_| UNAVAILABLE)?;
        Ok((Self(reader), Stdio::from(OwnedFd::from(writer))))
    }

    pub(super) fn classify(&self, error: ErrorCode) -> ErrorCode {
        if error != LOST {
            return error;
        }
        let mut bytes = [0; 2048];
        for _ in 0..16 {
            let Ok(count) = self.0.recv(&mut bytes) else {
                break;
            };
            let Some(data) = bytes.get(..count) else {
                break;
            };
            // Stock C-locale client, strict checking and an existing exact
            // Ed25519 pin. Never treat banners or status as auth acceptance.
            if data.split(|&b| b == b'\n').any(|line| {
                line == b"Host key verification failed.\r"
                    || line == b"Host key verification failed."
            }) {
                return ErrorCode::HostKeyChanged;
            }
        }
        error
    }
}
