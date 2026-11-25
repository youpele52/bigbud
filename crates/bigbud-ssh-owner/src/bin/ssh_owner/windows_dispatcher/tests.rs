#![allow(clippy::expect_used)]

use super::*;
use bigbud_ssh_owner::windows_owner_pipe::OwnerPipe;
use std::{os::windows::io::FromRawHandle, ptr};
use windows_sys::Win32::System::{Pipes::CreatePipe, Threading::GetCurrentProcess};

use crate::{
    owner_pipe::encode_payload,
    v1::{
        ProofStorageHydrate, ProofStorageResult, ProofStorageSnapshot, ProofStorageTransition,
        frame::Payload,
    },
};

#[test]
fn publication_requires_a_nonce_and_exact_local_name() {
    let expected = r"\\.\pipe\bigbud-ssh-owner-00000000000000000000000000000001";
    let mut bytes = Vec::from([0x5a; NONCE_LEN]);
    bytes.extend_from_slice(expected.as_bytes());
    let (nonce, name) = parse_publication(&bytes).expect("valid publication");
    assert_eq!(nonce, [0x5a; NONCE_LEN]);
    assert_eq!(name.as_str(), expected);
    assert!(parse_publication(&[0; NONCE_LEN - 1]).is_err());
    bytes.extend_from_slice(b"\0");
    assert!(parse_publication(&bytes).is_err());
    for name in [
        br"\\host\pipe\bigbud-ssh-owner-00000000000000000000000000000001".as_slice(),
        br"\\.\pipe\unrelated".as_slice(),
        &[0xff],
    ] {
        let mut bytes = Vec::from([0x5a; NONCE_LEN]);
        bytes.extend_from_slice(name);
        assert!(parse_publication(&bytes).is_err());
    }
}

#[test]
fn rejects_oversized_publication_without_waiting_for_its_body() {
    use std::io::Write;

    let (mut reader, mut writer) = byte_pipe();
    writer
        .write_all(&((MAX_PUBLICATION + 1) as u32).to_be_bytes())
        .expect("write header only");
    let error = read_publication(&mut reader, Instant::now())
        .expect_err("reject oversized bootstrap record");
    assert_eq!(
        error.downcast_ref::<io::Error>().map(io::Error::kind),
        Some(io::ErrorKind::InvalidData)
    );
}

#[test]
fn relays_storage_round_trips_and_maximum_length_bytes_without_decoding() {
    let exchanges = [
        (
            vec![0xff; Endpoint::Owner.inbound_max()],
            encode_payload(Payload::ProofStorageHydrate(ProofStorageHydrate::default())),
        ),
        (
            encode_payload(Payload::ProofStorageSnapshot(
                ProofStorageSnapshot::default(),
            )),
            encode_payload(Payload::ProofStorageTransition(
                ProofStorageTransition::default(),
            )),
        ),
        (
            encode_payload(Payload::ProofStorageResult(ProofStorageResult::default())),
            vec![0xfe; Endpoint::Owner.outbound_max()],
        ),
    ];
    let (mut input, mut backend_writer) = byte_pipe();
    let (mut backend_reader, output) = byte_pipe();
    let mut output = output::Writer::start(output).expect("reply writer");
    let (mut bridge, mut owner) = connected();
    let exchanges = &exchanges;
    thread::scope(|scope| {
        scope.spawn(|| {
            for (request, reply) in exchanges {
                let received = owner
                    .read_frame(FRAME_TIMEOUT)
                    .expect("owner reads request");
                assert_eq!(received.as_ref(), Some(request));
                owner
                    .write_frame(reply, FRAME_TIMEOUT)
                    .expect("owner sends reply");
            }
            assert!(
                owner
                    .read_frame(FRAME_TIMEOUT)
                    .expect("bridge closes stream")
                    .is_none()
            );
        });
        let backend = scope.spawn(move || {
            for (request, reply) in exchanges {
                Endpoint::Client
                    .write_frame(&mut backend_writer, request)
                    .expect("backend sends request");
                let received = Endpoint::Client
                    .read_frame(&mut backend_reader)
                    .expect("backend reads reply");
                assert_eq!(received.as_ref(), Some(reply));
            }
        });
        let mut busy = false;
        let result = relay(&mut input, &mut output, &mut bridge, &mut busy);
        drop(bridge);
        output.stop().expect("reply writer stops");
        result.expect("relay completes on backend EOF");
        assert!(!busy);
        backend.join().expect("backend completes");
    });
}

#[test]
fn incomplete_backend_frame_is_rejected_without_forwarding() {
    use std::io::Write;

    let (mut input, mut backend_writer) = byte_pipe();
    let (_backend_reader, output) = byte_pipe();
    let mut output = output::Writer::start(output).expect("reply writer");
    let (mut bridge, mut owner) = connected();
    backend_writer
        .write_all(&[0, 0, 0, 2, 1])
        .expect("partial frame");
    drop(backend_writer);
    let mut busy = false;
    assert!(relay(&mut input, &mut output, &mut bridge, &mut busy).is_err());
    assert!(!busy);
    drop(bridge);
    assert!(
        owner
            .read_frame(FRAME_TIMEOUT)
            .expect("bridge closes stream")
            .is_none()
    );
    output.stop().expect("reply writer stops");
}

#[test]
fn full_backend_pipe_cannot_block_reply_worker_shutdown() {
    let (_backend_reader, output) = byte_pipe();
    let mut output = output::Writer::start(output).expect("reply writer");
    let error = output
        .send(vec![0x54; Endpoint::Owner.outbound_max()])
        .expect_err("backend is not reading");
    assert_eq!(
        error.downcast_ref::<io::Error>().map(io::Error::kind),
        Some(io::ErrorKind::TimedOut)
    );
    output.stop().expect("cancel blocked synchronous writer");
}

fn connected() -> (VerifiedPipe, VerifiedPipe) {
    use std::os::windows::io::BorrowedHandle;

    // SAFETY: the current-process pseudo handle remains valid throughout this
    // test; ExpectedPipePeer duplicates it and does not take ownership of it.
    let current = unsafe { BorrowedHandle::borrow_raw(GetCurrentProcess()) };
    let peer = ExpectedPipePeer::from_handle(current).expect("pin fixture process");
    let listener = OwnerPipe::create().expect("owner endpoint");
    let bridge = connect(listener.name(), &peer, FRAME_TIMEOUT).expect("verify fixture owner");
    let owner = listener
        .accept(&peer, FRAME_TIMEOUT)
        .expect("verify fixture bridge");
    (bridge, owner)
}

fn byte_pipe() -> (File, File) {
    let mut reader = ptr::null_mut();
    let mut writer = ptr::null_mut();
    // SAFETY: on success CreatePipe initializes both owned handles exactly once.
    unsafe {
        assert_ne!(CreatePipe(&mut reader, &mut writer, ptr::null(), 4096), 0);
        (File::from_raw_handle(reader), File::from_raw_handle(writer))
    }
}
