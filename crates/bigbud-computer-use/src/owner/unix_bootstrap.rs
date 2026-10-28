//! Private bootstrap framing (not the operation/Hello protocol): u32 big-endian
//! payload length = 34, version = 1, role byte, then the 32-byte capability.
//! Role tags: guard=1, owner=2, worker=3, broker=4. No claimed PID/generation:
//! those are trusted issuance bindings verified against kernel peer identity.
//!
//! Exactly one frame is consumed, without read-ahead. Any following bytes belong
//! to the silent lifeline and MUST reach IndependentLifeline, which revokes on
//! any data. We do not peek and pretend to rule out a later malicious suffix.
//! No listener, inherited-FD transfer, operation admission or role activation.
use crate::Role;
use std::{
    io::{self, Read},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

const PAYLOAD_BYTES: usize = 34;
const READ_POLL: Duration = Duration::from_millis(100);

pub(super) fn read_handshake(
    mut stream: &UnixStream,
    deadline: Instant,
) -> io::Result<(Role, [u8; 32])> {
    // This API consumes exclusive stream ownership at the authentication boundary.
    // Normalize an accepted nonblocking socket; each blocking read is time-bounded.
    stream.set_nonblocking(false)?;
    read_frame(deadline, Instant::now, |bytes, remaining| {
        stream.set_read_timeout(Some(remaining.min(READ_POLL)))?;
        stream.read(bytes)
    })
}

pub(super) fn read_frame(
    deadline: Instant,
    mut now: impl FnMut() -> Instant,
    mut read: impl FnMut(&mut [u8], Duration) -> io::Result<usize>,
) -> io::Result<(Role, [u8; 32])> {
    let mut header = [0; 4];
    read_exact_before(&mut header, deadline, &mut now, &mut read)?;
    if u32::from_be_bytes(header) != PAYLOAD_BYTES as u32 {
        return Err(malformed());
    }
    let mut payload = [0; PAYLOAD_BYTES];
    read_exact_before(&mut payload, deadline, &mut now, &mut read)?;
    if payload[0] != 1 {
        return Err(malformed());
    }
    let role = match payload[1] {
        1 => Role::Guard,
        2 => Role::Owner,
        3 => Role::Worker,
        4 => Role::Broker,
        _ => return Err(malformed()),
    };
    let mut token = [0; 32];
    token.copy_from_slice(&payload[2..]);
    Ok((role, token))
}

fn read_exact_before(
    mut bytes: &mut [u8],
    deadline: Instant,
    now: &mut impl FnMut() -> Instant,
    read: &mut impl FnMut(&mut [u8], Duration) -> io::Result<usize>,
) -> io::Result<()> {
    while !bytes.is_empty() {
        let remaining = deadline
            .checked_duration_since(now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(expired)?;
        let result = read(bytes, remaining);
        // Even a ready final byte cannot authenticate at/after the original deadline.
        if now() >= deadline {
            return Err(expired());
        }
        match result {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete bootstrap frame",
                ));
            }
            Ok(count) => bytes = bytes.get_mut(count..).ok_or_else(malformed)?,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
fn malformed() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid bootstrap frame")
}
fn expired() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "bootstrap deadline expired")
}

#[cfg(test)]
#[path = "unix_bootstrap.tests.rs"]
mod tests;
