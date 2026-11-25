use super::*;
use crate::framing::FrameError;
use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED};

const SHORT: Duration = Duration::from_millis(40);

#[test]
fn idle_wait_preserves_pipe_but_a_stalled_frame_retires_it() {
    let (mut owner, mut client) = pair();
    assert_eq!(
        owner.wait_for_input(SHORT).expect("idle wait"),
        PipeReadiness::Idle
    );
    client.write_frame(b"frame", WAIT).expect("send after idle");
    assert_eq!(
        owner.wait_for_input(WAIT).expect("ready"),
        PipeReadiness::Ready
    );
    assert_eq!(
        owner.read_frame(WAIT).expect("read frame").as_deref(),
        Some(&b"frame"[..])
    );
    raw_write(&client, &[0, 0]);
    assert_eq!(
        owner.wait_for_input(WAIT).expect("partial header arrived"),
        PipeReadiness::Ready
    );
    assert_eq!(kind(owner.read_frame(SHORT)), io::ErrorKind::TimedOut);
    closed(&mut owner);
}

#[test]
fn empty_and_oversized_inbound_headers_close_both_roles() {
    for (end, bad_length) in [
        (Endpoint::Owner, 0_u32),
        (Endpoint::Owner, 64 * 1024 + 1),
        (Endpoint::Client, 8 * 1024 * 1024 + 1),
    ] {
        let (mut receiver, sender) = pair_for_role(end);
        raw_write(&sender, &bad_length.to_be_bytes());
        let result = receiver.read_frame(WAIT);
        if bad_length == 0 {
            assert!(matches!(result, Err(FrameError::Empty)), "{result:?}");
        } else {
            assert!(
                matches!(result, Err(FrameError::Oversized { actual, maximum })
                if actual == bad_length as usize && maximum == end.inbound_max()),
                "{result:?}"
            );
        }
        closed(&mut receiver);
    }
}

#[test]
fn stalled_header_and_body_cancel_and_close_instead_of_resuming() {
    for prefix in [&[][..], &[0, 0][..], &[0, 0, 0, 2, b'x'][..]] {
        let (mut owner, mut client) = pair();
        if !prefix.is_empty() {
            raw_write(&client, prefix);
        }
        let start = Instant::now();
        let result = owner.read_frame(SHORT);
        assert_eq!(kind(result), io::ErrorKind::TimedOut);
        assert!(
            start.elapsed() < WAIT,
            "cancellation should not wait for the idle peer"
        );
        closed(&mut owner);
        assert!(
            client
                .read_frame(WAIT)
                .expect("peer handle was closed")
                .is_none()
        );
    }
}

#[test]
fn blocked_write_cancels_with_live_nonreading_client() {
    let (mut owner, _client) = pair();
    let payload = vec![0xa5; Endpoint::Owner.outbound_max()];
    let start = Instant::now();
    assert_eq!(
        kind(owner.write_frame(&payload, SHORT)),
        io::ErrorKind::TimedOut
    );
    assert!(
        start.elapsed() < WAIT,
        "cancellation should not wait for the nonreading peer"
    );
    closed(&mut owner);
}

#[test]
fn client_cannot_write_owner_sized_frame() {
    let (mut owner, mut client) = pair();
    assert!(matches!(
        client.write_frame(&vec![1; Endpoint::Client.outbound_max() + 1], WAIT),
        Err(FrameError::Oversized { .. })
    ));
    closed(&mut client);
    assert!(owner.read_frame(WAIT).expect("no prefix escaped").is_none());
    closed(&mut owner);
}

#[test]
fn multi_chunk_frame_round_trips_without_consuming_next_frame() {
    let (mut owner, mut client) = pair();
    let payload = vec![0xa5; 256 * 1024];
    thread::scope(|scope| {
        scope.spawn(|| {
            owner
                .write_frame(&payload, WAIT)
                .expect("write large frame");
            owner.write_frame(b"next", WAIT).expect("write next frame");
        });
        let received = client
            .read_frame(WAIT)
            .expect("read large frame")
            .expect("frame");
        assert_eq!(received, payload);
        assert_eq!(
            client.read_frame(WAIT).expect("read next frame").as_deref(),
            Some(&b"next"[..])
        );
    });
}

#[test]
fn peer_close_after_a_complete_frame_reports_eof_once_in_both_roles() {
    for end in [Endpoint::Owner, Endpoint::Client] {
        let (mut receiver, mut sender) = pair_for_role(end);
        sender.write_frame(b"last frame", WAIT).expect("send frame");
        assert_eq!(
            receiver.read_frame(WAIT).expect("read frame").as_deref(),
            Some(&b"last frame"[..])
        );
        // Consume the whole frame before close so the test does not depend on
        // whether Windows retains unread pipe data when a handle closes.
        drop(sender);
        assert!(receiver.read_frame(WAIT).expect("clean EOF").is_none());
        closed(&mut receiver);
    }
}

#[test]
fn writing_to_a_disconnected_peer_fails_and_closes_both_roles() {
    for end in [Endpoint::Owner, Endpoint::Client] {
        let (mut writer, peer) = pair_for_role(end);
        drop(peer);
        let result = writer.write_frame(b"cannot be delivered", WAIT);
        assert!(
            matches!(&result, Err(FrameError::Write(error)) if matches!(
                error.raw_os_error().map(|code| code as u32),
                Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED)
            )),
            "expected a Windows disconnect error, got {result:?}"
        );
        closed(&mut writer);
    }
}

fn pair_for_role(end: Endpoint) -> (VerifiedPipe, VerifiedPipe) {
    let (owner, client) = pair();
    match end {
        Endpoint::Owner => (owner, client),
        Endpoint::Client => (client, owner),
    }
}

fn pair() -> (VerifiedPipe, VerifiedPipe) {
    let me = this_process();
    let listener = OwnerPipe::create().expect("fresh pipe");
    let client = connect(listener.name(), &me, WAIT).expect("verify server");
    let owner = listener.accept(&me, WAIT).expect("verify client");
    (owner, client)
}

fn raw_write(pipe: &VerifiedPipe, prefix: &[u8]) {
    let deadline = Deadline::new(WAIT).expect("deadline");
    let handle = pipe.handle.as_ref().expect("fixture pipe is open");
    let mut operation = Operation::new(handle, &deadline).expect("fixture writer");
    assert_eq!(
        operation.write(prefix).expect("write fixture bytes"),
        prefix.len()
    );
}

fn closed(pipe: &mut VerifiedPipe) {
    assert_eq!(kind(pipe.read_frame(WAIT)), io::ErrorKind::NotConnected);
    assert_eq!(
        kind(pipe.write_frame(b"unused", WAIT)),
        io::ErrorKind::NotConnected
    );
}

fn kind<T: std::fmt::Debug>(result: Result<T, FrameError>) -> io::ErrorKind {
    let error = result.expect_err("operation should fail");
    std::error::Error::source(&error)
        .and_then(|source| source.downcast_ref::<io::Error>())
        .expect("I/O error")
        .kind()
}
