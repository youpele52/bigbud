use super::*;
use std::fs::{self, DirBuilder};
use std::net::SocketAddr;
use std::os::unix::{fs::DirBuilderExt, net::UnixListener};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const LIMIT: Duration = Duration::from_secs(2);
// Waiting for the relay worker to accept a connection or publish a closure is
// not a data-transfer deadline: a worker that has not been scheduled yet is not
// an open or a stuck stream. Only the failure path waits this long.
const SETTLE: Duration = Duration::from_secs(30);

struct Fixture {
    dir: PathBuf,
    socket: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        loop {
            let dir = PathBuf::from(format!(
                "/tmp/bigbud-v1-bridge-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => {
                    let socket = dir.join("owner.sock");
                    return Self { dir, socket };
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(error) => panic!("create disposable socket directory: {error}"),
            }
        }
    }

    fn listen(&self) -> UnixListener {
        let listener = UnixListener::bind(&self.socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        listener
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.dir).unwrap();
    }
}

fn connect(addr: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect_timeout(&addr, LIMIT).unwrap();
    stream.set_read_timeout(Some(LIMIT)).unwrap();
    stream.set_write_timeout(Some(LIMIT)).unwrap();
    stream
}

fn accept(listener: &UnixListener) -> UnixStream {
    let deadline = Instant::now() + SETTLE;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(LIMIT)).unwrap();
                stream.set_write_timeout(Some(LIMIT)).unwrap();
                return stream;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("accept disposable socket: {error}"),
        }
    }
}

// A timeout means "the worker has not published the closure yet", never that
// the stream is still open, so it is retried until the settle budget is spent.
fn assert_closed(mut reader: impl Read) {
    let deadline = Instant::now() + SETTLE;
    loop {
        match reader.read(&mut [0]) {
            Ok(0) => return,
            Err(error) if error.kind() == ErrorKind::ConnectionReset => return,
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {}
            other => panic!("expected a closed stream, got {other:?}"),
        }
    }
}

// Reads until the peer closes, retrying a timeout for the same reason. The
// caller still asserts the exact bytes that were relayed.
fn read_to_close(mut reader: impl Read) -> Vec<u8> {
    let deadline = Instant::now() + SETTLE;
    let mut bytes = Vec::new();
    let mut buffer = [0; BUFFER_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return bytes,
            Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {}
            Err(error) => panic!("read relayed bytes: {error:?}"),
        }
    }
}

#[test]
fn readiness_still_requires_the_stdout_marker_and_a_probe_through_the_reserved_listener() {
    let fixture = Fixture::new();
    let listener = fixture.listen();
    let mut startup = Startup::reserve().unwrap();
    let addr = startup.listener().local_addr().unwrap();
    let bridge = Bridge::start(&startup, &fixture.socket).unwrap();

    assert_eq!(startup.poll_ready(|| false), Ok(None));
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    startup.stdout(super::super::MARKER).unwrap();
    startup.stdout(b"\n").unwrap();
    thread::scope(|scope| {
        scope.spawn(|| {
            let mut unix = accept(&listener);
            let request =
                format!("GET /global/health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
            let mut bytes = vec![0; request.len()];
            unix.read_exact(&mut bytes).unwrap();
            assert_eq!(bytes, request.as_bytes());
            unix.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\n\r\n{\"healthy\":true}")
                .unwrap();
        });
        assert_eq!(startup.poll_ready(|| false), Ok(Some(addr.port())));
    });
    assert!(!bridge.is_finished());
    bridge.shutdown().unwrap();
}

#[test]
fn missing_socket_is_local_to_the_connection_and_half_closes_flush_both_directions() {
    let fixture = Fixture::new();
    let startup = Startup::reserve().unwrap();
    let addr = startup.listener().local_addr().unwrap();
    let bridge = Bridge::start(&startup, &fixture.socket).unwrap();
    assert_closed(connect(addr));
    assert!(!bridge.is_finished());

    let listener = fixture.listen();
    let mut client = connect(addr);
    let mut unix = accept(&listener);
    let payload: Vec<_> = (0..=255).cycle().take(4 * BUFFER_BYTES + 17).collect();
    client.write_all(&payload).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_to_close(&mut unix), payload);

    let response = b"response after the request's write half closed";
    unix.write_all(response).unwrap();
    unix.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_to_close(&mut client), response);
    bridge.shutdown().unwrap();
}

#[test]
fn sheds_only_excess_connections_reuses_capacity_and_joins_with_open_streams() {
    let fixture = Fixture::new();
    let listener = fixture.listen();
    let startup = Startup::reserve().unwrap();
    let addr = startup.listener().local_addr().unwrap();
    let bridge = Bridge::start(&startup, &fixture.socket).unwrap();
    let mut admitted: Vec<_> = (0..MAX_CONNECTIONS)
        .map(|_| (connect(addr), accept(&listener)))
        .collect();

    assert_closed(connect(addr));
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    let (mut client, mut unix) = admitted.pop().unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    unix.shutdown(Shutdown::Write).unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert_eq!(unix.read(&mut [0]).unwrap(), 0);
    // The worker published both EOFs before clearing the fully closed slot.
    // A new accept is serviced by the same thread, after that transition.
    let client = connect(addr);
    let unix = accept(&listener);
    admitted.push((client, unix));

    drop(startup);
    assert_eq!(
        TcpListener::bind(addr).unwrap_err().kind(),
        ErrorKind::AddrInUse
    );
    let before = Instant::now();
    bridge.shutdown().unwrap();
    assert!(before.elapsed() < LIMIT);
    assert!(TcpStream::connect_timeout(&addr, LIMIT).is_err());
    for (client, unix) in admitted {
        assert_closed(client);
        assert_closed(unix);
    }
}

#[test]
fn a_backpressured_stream_does_not_stop_other_transfers_or_implicit_shutdown() {
    let fixture = Fixture::new();
    let listener = fixture.listen();
    let startup = Startup::reserve().unwrap();
    let addr = startup.listener().local_addr().unwrap();
    let bridge = Bridge::start(&startup, &fixture.socket).unwrap();
    let mut client = connect(addr);
    let _unread = accept(&listener);
    client.set_nonblocking(true).unwrap();
    let chunk = [0x42; BUFFER_BYTES];
    let mut stalled = false;
    // Large enough to fill kernel socket buffers, without unbounded test work.
    for _ in 0..4096 {
        match client.write(&chunk) {
            Ok(n) => assert!(n > 0),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                stalled = true;
                break;
            }
            Err(error) => panic!("fill relay buffers: {error}"),
        }
    }
    assert!(stalled);
    let mut second_client = connect(addr);
    let mut second_unix = accept(&listener);
    second_client.write_all(b"next").unwrap();
    let mut received = [0; 4];
    second_unix.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"next");

    drop(startup);
    let before = Instant::now();
    drop(bridge);
    assert!(before.elapsed() < LIMIT);
    assert!(TcpStream::connect_timeout(&addr, LIMIT).is_err());
}

#[test]
fn rejects_paths_that_cannot_identify_a_fixed_filesystem_socket() {
    let startup = Startup::reserve().unwrap();
    for path in [
        "relative.sock",
        "/bad\0path",
        &format!("/{}", "x".repeat(256)),
    ] {
        let error = Bridge::start(&startup, Path::new(path)).err().unwrap();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }
}
