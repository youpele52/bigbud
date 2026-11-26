//! Bounded pack pump for one admitted push. Local pack bytes flow to
//! receive-pack on a scoped thread while the report is read concurrently. The
//! caller's watchdog kills the child group and shuts down the socket on
//! cancellation or deadline, which unblocks both directions.

use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    process::{ChildStdin, ChildStdout},
    thread,
};

/// Largest pack one push may send.
const PACK_CAP: u64 = 1024 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

pub(super) fn exchange(
    client: &UnixStream,
    remote_output: ChildStdout,
    remote_input: ChildStdin,
    report_cap: usize,
) -> io::Result<Vec<u8>> {
    thread::scope(|scope| {
        let pack = scope.spawn(move || forward_pack(client, remote_input));
        let mut report = Vec::new();
        let read = remote_output
            .take(u64::try_from(report_cap).map_err(io::Error::other)? + 1)
            .read_to_end(&mut report);
        let forwarded = pack
            .join()
            .map_err(|_| io::Error::other("pack pump panicked"))?;
        read?;
        forwarded?;
        Ok(report)
    })
}

/// Copy local pack bytes until the client half-closes; then close stdin so
/// receive-pack sees the end of input.
fn forward_pack(mut client: &UnixStream, mut remote_input: ChildStdin) -> io::Result<()> {
    let mut chunk = vec![0; CHUNK];
    let mut total = 0u64;
    loop {
        let count = match client.read(&mut chunk) {
            Ok(0) => return remote_input.flush(),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        total += u64::try_from(count).map_err(io::Error::other)?;
        if total > PACK_CAP {
            return Err(io::ErrorKind::InvalidData.into());
        }
        remote_input.write_all(chunk.get(..count).ok_or(io::ErrorKind::InvalidData)?)?;
    }
}
