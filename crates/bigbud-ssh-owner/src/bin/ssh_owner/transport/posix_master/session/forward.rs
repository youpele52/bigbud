//! Proof of the descriptor handoff for an owner-created OpenSSH mux master.
//! The caller must verify the master's peer and the next endpoint beforehand.

use super::{ErrorCode, Instant, LOST, UnixStream, probe, stdio, words};
use std::io::{PipeReader, PipeWriter, pipe};
use std::net::SocketAddr;
use std::os::fd::AsRawFd;

const NEW_STDIO_FORWARD: u32 = 0x1000_0008;
const SESSION_OPENED: u32 = 0x8000_0006;
const REQUEST: u32 = 2; // The verified control stream used request 1 for alive-check.

pub(in crate::transport::posix_master) struct ForwardIo {
    pub(in crate::transport::posix_master) input: PipeReader,
    pub(in crate::transport::posix_master) output: PipeWriter,
}

/// Returns both the byte stream and its control channel. Closing the control
/// channel revokes the exact forward. It does not stop or replace the master.
pub(in crate::transport::posix_master) fn open_forward(
    control: UnixStream,
    endpoint: SocketAddr,
    deadline: Instant,
) -> Result<(ForwardIo, UnixStream), ErrorCode> {
    if !endpoint.ip().is_loopback() || endpoint.port() == 0 {
        return Err(ErrorCode::InvalidOperands);
    }
    let host = endpoint.ip().to_string();
    let host_len = u32::try_from(host.len()).map_err(|_| ErrorCode::InvalidOperands)?;
    let header = [20 + host_len, NEW_STDIO_FORWARD, REQUEST, 0, host_len];
    let mut packet = Vec::with_capacity(24 + host.len());
    packet.extend(header.into_iter().flat_map(u32::to_be_bytes));
    packet.extend_from_slice(host.as_bytes());
    packet.extend_from_slice(&u32::from(endpoint.port()).to_be_bytes());

    let (input, from_master) = pipe().map_err(|_| ErrorCode::OwnerUnavailable)?;
    let (to_master, output) = pipe().map_err(|_| ErrorCode::OwnerUnavailable)?;
    let mut channel = &control;
    probe::write_with(&mut channel, &packet, deadline, None)?;
    // Only the master-side ends cross the mux. Distinct pipes also keep
    // the two directions' EOF and status flags independent.
    stdio::send_fds(
        channel,
        [to_master.as_raw_fd(), from_master.as_raw_fd()],
        deadline,
        None,
    )?;
    drop(to_master);
    drop(from_master);
    let mut reply = [0; 16];
    probe::read_with(&mut channel, &mut reply, deadline, None)?;
    let [length, kind, request, _session] = words(&reply);
    if (length, kind, request) != (12, SESSION_OPENED, REQUEST) {
        return Err(LOST);
    }
    Ok((ForwardIo { input, output }, control))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::posix_master::session::tests::receive_fd;
    use std::io::{Read, Write};
    use std::thread;
    use std::time::Duration;

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    #[test]
    fn forwards_one_bound_endpoint_in_both_directions_without_a_listener() {
        let (owner, master) = UnixStream::pair().expect("private control sockets");
        owner.set_nonblocking(true).expect("bounded owner control");
        master
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("bounded master control");
        let peer = thread::spawn(move || {
            let mut frame = [0; 33];
            (&master).read_exact(&mut frame).expect("forward request");
            let mut expected: Vec<_> = [29u32, NEW_STDIO_FORWARD, REQUEST, 0, 9]
                .into_iter()
                .flat_map(u32::to_be_bytes)
                .collect();
            expected.extend_from_slice(b"127.0.0.1");
            expected.extend_from_slice(&2222u32.to_be_bytes());
            assert_eq!(frame.as_slice(), expected.as_slice());
            let mut from_child = PipeReader::from(receive_fd(&master));
            let mut to_child = PipeWriter::from(receive_fd(&master));
            (&master)
                .write_all(
                    &[12u32, SESSION_OPENED, REQUEST, 7]
                        .into_iter()
                        .flat_map(u32::to_be_bytes)
                        .collect::<Vec<_>>(),
                )
                .expect("forward opened");
            let mut data = [0; 4];
            from_child.read_exact(&mut data).expect("forwarded input");
            assert_eq!(&data, b"ping");
            to_child.write_all(b"pong").expect("forwarded output");
            let mut end = [0];
            assert_eq!((&master).read(&mut end).expect("control EOF"), 0);
        });
        let (mut io, control) =
            open_forward(owner, "127.0.0.1:2222".parse().unwrap(), deadline()).unwrap();
        io.output.write_all(b"ping").expect("child input");
        let mut data = [0; 4];
        io.input.read_exact(&mut data).expect("child output");
        assert_eq!(&data, b"pong");
        drop(control);
        peer.join().expect("private forwarding peer");
    }

    #[test]
    fn rejects_non_fixture_endpoints_without_a_control_message() {
        for endpoint in ["127.0.0.1:0", "192.0.2.1:22"] {
            let (owner, mut master) = UnixStream::pair().unwrap();
            master
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            assert!(matches!(
                open_forward(owner, endpoint.parse().unwrap(), deadline()),
                Err(ErrorCode::InvalidOperands)
            ));
            assert_eq!(master.read(&mut [0]).unwrap(), 0);
        }
    }
}
