use super::*;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

fn accept_health(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match listener.accept() {
            Ok((mut stream, peer)) => {
                assert!(peer.ip().is_loopback());
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let expected = format!(
                    "GET /global/health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                    listener.local_addr().unwrap()
                );
                let mut request = vec![0; expected.len()];
                stream.read_exact(&mut request).unwrap();
                assert_eq!(request, expected.as_bytes());
                return stream;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(1));
            }
            other => panic!("disposable health listener: {other:?}"),
        }
    }
}

fn announce(startup: &mut Startup) {
    startup.stdout(MARKER).unwrap();
    startup.stdout(b"\n").unwrap();
}

fn reply(startup: &mut Startup, chunks: &[&[u8]]) -> Result<Option<u16>, StartupError> {
    let listener = startup.listener().try_clone().unwrap();
    thread::scope(|scope| {
        scope.spawn(move || {
            let mut stream = accept_health(&listener);
            for chunk in chunks {
                stream.write_all(chunk).unwrap();
            }
        });
        startup.poll_ready(|| false)
    })
}

#[test]
fn reserves_one_exact_loopback_port_until_drop_and_publishes_after_both_signals() {
    let mut startup = Startup::reserve().unwrap();
    let address = startup.listener().local_addr().unwrap();
    assert_eq!(address.ip(), Ipv4Addr::LOCALHOST);
    assert_ne!(address.port(), 0);
    assert_eq!(
        REMOTE_ENDPOINT,
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 4096)
    );
    assert_eq!(
        TcpListener::bind(address).unwrap_err().kind(),
        ErrorKind::AddrInUse
    );

    startup.stderr(MARKER).unwrap();
    startup.stderr(b"\n").unwrap();
    startup.stdout(b"prefix ").unwrap();
    startup.stdout(MARKER).unwrap();
    startup.stdout(b"\n").unwrap();
    startup
        .stdout(b"opencode server listening on http://127.0.0.1:4097\n")
        .unwrap();
    startup.stdout(MARKER).unwrap();
    assert_eq!(startup.poll_ready(|| false), Ok(None));
    assert_eq!(
        startup.listener().accept().unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
    startup.stdout(b"\r").unwrap();
    startup.stdout(b"\n").unwrap();
    assert_eq!(
        reply(
            &mut startup,
            &[
                b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\n\r",
                b"\n{\"healthy\":true}",
            ],
        ),
        Ok(Some(address.port()))
    );
    startup.stdout(&[b'x'; OUTPUT_LIMIT + 1]).unwrap();
    assert_eq!(startup.poll_ready(|| true), Err(StartupError::Cancelled));
    assert_eq!(startup.poll_ready(|| false), Err(StartupError::Cancelled));
    drop(startup);
    assert!(TcpStream::connect(address).is_err());
}

#[test]
fn shares_one_startup_output_budget_and_fences_failure() {
    let mut startup = Startup::reserve().unwrap();
    announce(&mut startup);
    startup
        .stderr(&vec![b'x'; OUTPUT_LIMIT - MARKER.len() - 1])
        .unwrap();
    assert_eq!(startup.stdout(b"x"), Err(StartupError::OutputLimit));
    assert_eq!(startup.poll_ready(|| false), Err(StartupError::OutputLimit));
    assert_eq!(
        startup.listener().accept().unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
}

#[test]
fn refuses_redirects_malformed_oversized_and_unhealthy_responses() {
    let responses: &[&[u8]] = &[
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1234/\r\nContent-Length: 0\r\n\r\n",
        b"HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\n",
        b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nContent-Length: 16\r\n\r\n{\"healthy\":true}",
        b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n{\"healthy\":false}",
        b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{\"healthy\":true}",
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    ];
    for response in responses {
        let mut startup = Startup::reserve().unwrap();
        announce(&mut startup);
        assert_eq!(
            reply(&mut startup, &[response]),
            Err(StartupError::InvalidHealthResponse)
        );
    }
}

#[test]
fn handles_unavailable_forward_and_cancellation_without_publication() {
    let mut startup = Startup::reserve().unwrap();
    announce(&mut startup);
    assert_eq!(reply(&mut startup, &[]), Ok(None));
    let cancelled = AtomicBool::new(false);
    let listener = startup.listener().try_clone().unwrap();
    thread::scope(|scope| {
        scope.spawn(|| {
            let stream = accept_health(&listener);
            cancelled.store(true, Ordering::Release);
            stream.shutdown(Shutdown::Both).unwrap();
        });
        assert_eq!(
            startup.poll_ready(|| cancelled.load(Ordering::Acquire)),
            Err(StartupError::Cancelled)
        );
    });
    assert_eq!(startup.poll_ready(|| false), Err(StartupError::Cancelled));
}

#[test]
fn deadlines_cover_silent_start_and_stalled_health() {
    let mut startup = Startup::reserve().unwrap();
    startup.deadline = Instant::now();
    assert_eq!(startup.poll_ready(|| false), Err(StartupError::TimedOut));

    let mut startup = Startup::reserve().unwrap();
    announce(&mut startup);
    let listener = startup.listener().try_clone().unwrap();
    thread::scope(|scope| {
        scope.spawn(|| {
            let mut stream = accept_health(&listener);
            stream.write_all(b"HTTP/1.1 200 OK\r\n").unwrap();
            let mut buffer = [0];
            assert_eq!(stream.read(&mut buffer).unwrap(), 0, "probe socket leaked");
        });
        assert_eq!(startup.poll_ready(|| false), Ok(None));
    });
}
