#![allow(clippy::expect_used, clippy::indexing_slicing)]

use super::*;
use bigbud_ssh_owner::windows_owner_pipe::{PipeName, connect};
use windows_sys::Win32::{Foundation::GetHandleInformation, System::Pipes::CreatePipe};

#[test]
fn private_streams_do_not_pass_through_to_descendants() {
    let (reader, _writer) = byte_pipe();
    // SAFETY: the test owns this pipe handle and no other thread uses it.
    assert_ne!(
        unsafe {
            SetHandleInformation(
                reader.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            )
        },
        0
    );
    let duplicate = private_pipe(reader.as_handle()).expect("open private stream");
    for handle in [reader.as_raw_handle(), duplicate.as_raw_handle()] {
        let mut flags = 0;
        // SAFETY: both owners remain in scope and flags is a valid output pointer.
        assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
    }
}

#[test]
fn passes_only_the_verified_pipe_to_dispatch() {
    exercise_bootstrap(false);
}

#[test]
fn wrong_nonce_closes_pipe_without_dispatching() {
    exercise_bootstrap(true);
}

fn exercise_bootstrap(change_nonce: bool) {
    let (input, mut dispatcher_output) = byte_pipe();
    let (mut dispatcher_input, output) = byte_pipe();
    let pid = std::process::id();
    let expected_child = pin_dispatcher(pid).expect("pin the fixture process");
    send(&mut dispatcher_output, &pid.to_le_bytes());
    // Both ends run in this fixture process; the Windows pipe suite separately
    // checks distinct process identity, ACLs, and process-bound rejection.
    thread::scope(|scope| {
        let worker = scope.spawn(|| {
            with_verified_dispatcher(input, output, |pipe| {
                pipe.read_frame(TIMEOUT).map_err(io::Error::other)
            })
        });
        let publication = Endpoint::Client
            .read_frame(&mut dispatcher_input)
            .expect("read bootstrap publication")
            .expect("publication before EOF");
        let (nonce, name) = publication
            .split_at_checked(NONCE_LEN)
            .expect("one nonce plus pipe name");
        let name = PipeName::parse(std::str::from_utf8(name).expect("ASCII pipe name"))
            .expect("local owner pipe");
        let mut pipe = connect(&name, &expected_child, TIMEOUT).expect("verify fixture server");
        let mut nonce: [u8; NONCE_LEN] = nonce.try_into().expect("32-byte nonce");
        if change_nonce {
            nonce[0] ^= 1;
        }
        send(&mut dispatcher_output, &nonce);
        if !change_nonce {
            pipe.write_frame(b"fixture", TIMEOUT)
                .expect("send fixture frame");
        }
        let result = worker.join().expect("bootstrap worker does not panic");
        if change_nonce {
            assert_eq!(
                result.expect_err("reject wrong nonce").kind(),
                io::ErrorKind::PermissionDenied
            );
            assert!(
                pipe.read_frame(TIMEOUT)
                    .expect("read closed pipe")
                    .is_none()
            );
        } else {
            assert_eq!(
                result.expect("bootstrap callback succeeds").as_deref(),
                Some(b"fixture".as_slice())
            );
        }
    });
}

#[test]
fn rejects_wrong_length_before_waiting_for_body() {
    let (mut input, mut output) = byte_pipe();
    output
        .write_all(&32_u32.to_be_bytes())
        .expect("send wrong header");
    let error = read_record::<4>(&mut input, Instant::now()).expect_err("reject wrong length");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn truncated_record_does_not_dispatch() {
    let (mut input, mut output) = byte_pipe();
    output
        .write_all(&[0, 0, 0, 4, 1])
        .expect("send incomplete PID");
    drop(output);
    assert!(read_record::<4>(&mut input, Instant::now()).is_err());
}

fn send(output: &mut File, bytes: &[u8]) {
    Endpoint::Client
        .write_frame(output, bytes)
        .expect("write bootstrap record");
}

fn byte_pipe() -> (File, File) {
    let mut reader = ptr::null_mut();
    let mut writer = ptr::null_mut();
    // SAFETY: out pointers are valid; null attributes request non-inheritable
    // handles. On success both handles are fresh and each is owned once.
    unsafe {
        assert_ne!(CreatePipe(&mut reader, &mut writer, ptr::null(), 4096), 0);
        (File::from_raw_handle(reader), File::from_raw_handle(writer))
    }
}
