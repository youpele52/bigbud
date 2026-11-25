use super::*;
use std::fs::File;
use std::io::Write;
use std::net::Shutdown;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::thread;
use std::time::Duration;

const SID: u32 = 173;
const LIMIT: Duration = Duration::from_secs(2);

#[test]
fn fixed_picker_receives_only_owned_stdio_and_drains_after_final() {
    let path = "-x; $(touch sentinel) 'quote'";
    let picker = Picker::new(Some(path)).expect("valid path");
    let (client, server) = endpoints();
    let peer = thread::spawn(move || {
        let mut stdout = open_session(&server, Some(path));
        let mut server = &server;
        let exit = packet(EXIT_MESSAGE, SID, 0);
        server.write_all(&exit[..7]).expect("first status fragment");
        server
            .write_all(&exit[7..])
            .expect("second status fragment");
        // Larger than the OS pipe; the client has to drain even after learning status.
        stdout
            .write_all(b"BIGBUD_REMOTE_FOLDERS_V1\0/home\0/home/project\0g\tchild\0")
            .expect("listing");
        stdout
            .write_all(&vec![b'x'; OUTPUT_CAP + 1])
            .expect("excess output drained");
    });
    let output = picker
        .run(&client, Instant::now() + LIMIT)
        .expect("picker completes");
    assert_eq!(output.bytes.len(), OUTPUT_CAP);
    let folders = output.folders().expect("bounded listing");
    assert_eq!(folders.path, "/home/project");
    assert_eq!(folders.entries[0].name, "child");
    assert_eq!(folders.truncated, Some(true));
    peer.join().expect("mux fixture");
}

#[test]
fn final_remote_status_is_not_transport_loss() {
    for (status, error) in [
        (3, ErrorCode::ListPathUnavailable),
        (255, ErrorCode::ListFailed),
    ] {
        let (client, server) = endpoints();
        let peer = thread::spawn(move || {
            let _stdout = open_session(&server, None);
            (&server)
                .write_all(&packet(EXIT_MESSAGE, SID, status))
                .expect("final exit status");
        });
        let result = Picker::new(None)
            .expect("request")
            .run(&client, Instant::now() + LIMIT)
            .expect("final status received")
            .folders();
        assert!(matches!(result, Err(actual) if actual == error));
        peer.join().expect("mux fixture");
    }
}

#[test]
fn absent_truncated_wrong_or_duplicate_final_is_transport_loss() {
    for final_bytes in [
        vec![],
        packet(EXIT_MESSAGE, SID, 0)[..15].to_vec(),
        packet(EXIT_MESSAGE, SID + 1, 0).to_vec(),
        packet(EXIT_MESSAGE, SID, 0).repeat(2),
    ] {
        let (client, server) = endpoints();
        let peer = thread::spawn(move || {
            let mut stdout = open_session(&server, None);
            // Even valid stdout cannot turn missing/invalid final status into success.
            stdout
                .write_all(b"BIGBUD_REMOTE_FOLDERS_V1\0/home\0/home\0")
                .expect("valid output");
            (&server).write_all(&final_bytes).expect("test status");
        });
        let result = Picker::new(None)
            .expect("request")
            .run(&client, Instant::now() + LIMIT);
        assert!(matches!(result, Err(LOST)));
        peer.join().expect("mux fixture");
    }
}

#[test]
fn quiet_open_session_uses_the_supplied_absolute_deadline() {
    let (client, server) = endpoints();
    let peer = thread::spawn(move || {
        let _stdout = open_session(&server, None);
        // Do not publish a final message or close stdout until the client quits.
        assert_eq!((&server).read(&mut [0]).expect("client closes"), 0);
    });
    let result = Picker::new(None)
        .expect("request")
        .run(&client, Instant::now() + Duration::from_millis(100));
    assert!(matches!(result, Err(TIMED_OUT)));
    client.shutdown(Shutdown::Both).expect("close control");
    peer.join().expect("mux fixture");
}

#[cfg(target_os = "macos")]
#[test]
fn cancellation_after_descriptor_pass_closes_the_exact_session() {
    use super::super::CANCELLED;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    let (client, server) = endpoints();
    let cancelled = Arc::new(AtomicBool::new(false));
    let trigger = Arc::clone(&cancelled);
    let peer = thread::spawn(move || {
        let _stdout = receive_request(&server, None);
        trigger.store(true, Ordering::Release);
        assert_eq!((&server).read(&mut [0]).expect("mux EOF"), 0);
    });
    let is_cancelled = || cancelled.load(Ordering::Acquire);
    let result = Picker::new(None).expect("request").run_with(
        &client,
        Instant::now() + LIMIT,
        Some(&is_cancelled),
    );
    drop(client);
    assert!(matches!(result, Err(CANCELLED)));
    peer.join().expect("mux fixture");
}

#[cfg(target_os = "macos")]
#[test]
fn quiet_collector_wakes_and_checks_for_cancel_without_remote_output() {
    use super::super::CANCELLED;
    use std::cell::Cell;

    let (client, _server) = endpoints();
    let (stdout, _writer) = io::pipe().expect("fixture pipe");
    let attempts = Cell::new(0);
    let is_cancelled = || {
        let count = attempts.get();
        attempts.set(count + 1);
        count != 0
    };
    let result = collect(
        &client,
        stdout,
        SID,
        Instant::now() + LIMIT,
        Some(&is_cancelled),
    );
    assert!(matches!(result, Err(CANCELLED)));
    assert_eq!(attempts.get(), 2);
}

fn endpoints() -> (UnixStream, UnixStream) {
    let (client, server) = UnixStream::pair().expect("fixture endpoints");
    client.set_nonblocking(true).expect("nonblocking client");
    server
        .set_read_timeout(Some(LIMIT))
        .expect("bounded fixture");
    server
        .set_write_timeout(Some(LIMIT))
        .expect("bounded fixture");
    (client, server)
}

fn open_session(mut server: &UnixStream, path: Option<&str>) -> File {
    let stdout = receive_request(server, path);
    server
        .write_all(&packet(SESSION_OPENED, REQUEST_ID, SID))
        .expect("open reply");
    stdout
}

fn receive_request(mut server: &UnixStream, path: Option<&str>) -> File {
    let expected = folders::command(path).expect("fixed picker script");
    let mut request = [0; 44];
    server.read_exact(&mut request).expect("session header");
    let words: Vec<_> = request
        .chunks_exact(4)
        .map(|chunk| u32::from_be_bytes(chunk.try_into().expect("word")))
        .collect();
    let length = u32::try_from(expected.len()).expect("bounded command");
    assert_eq!(
        words,
        [
            40 + length,
            0x1000_0002,
            2,
            0,
            0,
            0,
            0,
            0,
            u32::MAX,
            0,
            length
        ]
    );
    let mut command = vec![0; expected.len()];
    server
        .read_exact(&mut command)
        .expect("fixed command bytes");
    assert_eq!(command, expected.as_bytes());

    let mut stdin = File::from(receive_fd(server));
    let stdout = File::from(receive_fd(server));
    let mut stderr = File::from(receive_fd(server));
    assert_eq!(stdin.read(&mut [0]).expect("stdin EOF"), 0);
    stderr
        .write_all(b"ignored stderr")
        .expect("stderr can accept output");
    stdout
}

fn packet(kind: u32, first: u32, second: u32) -> Vec<u8> {
    [12, kind, first, second]
        .into_iter()
        .flat_map(u32::to_be_bytes)
        .collect()
}

pub(super) fn receive_fd(stream: &UnixStream) -> OwnedFd {
    let mut data = [0u8];
    let mut iov = libc::iovec {
        iov_base: data.as_mut_ptr().cast(),
        iov_len: data.len(),
    };
    let mut control = [0usize; 4];
    // SAFETY: message fields are nullable pointers and integer lengths; the
    // recvmsg buffers are valid for writes and CMSG_DATA is read only after
    // checking for one SCM_RIGHTS control message of the expected size.
    unsafe {
        let mut message: libc::msghdr = std::mem::zeroed();
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control) as _;
        assert_eq!(libc::recvmsg(stream.as_raw_fd(), &mut message, 0), 1);
        assert_eq!(message.msg_flags & libc::MSG_CTRUNC, 0);
        let header = libc::CMSG_FIRSTHDR(&message);
        assert!(!header.is_null());
        assert_eq!((*header).cmsg_level, libc::SOL_SOCKET);
        assert_eq!((*header).cmsg_type, libc::SCM_RIGHTS);
        assert_eq!(
            (*header).cmsg_len as usize,
            libc::CMSG_LEN(std::mem::size_of::<RawFd>() as _) as usize
        );
        let received = libc::CMSG_DATA(header).cast::<RawFd>().read_unaligned();
        assert!(received >= 0);
        assert_eq!(libc::fcntl(received, libc::F_SETFD, libc::FD_CLOEXEC), 0);
        OwnedFd::from_raw_fd(received)
    }
}
