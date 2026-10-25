#![allow(clippy::unwrap_used, clippy::panic)]
use super::{Rig, fixture::*};
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1};
use std::fs;
use std::io;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::time::Duration;

const SEAL_BARRIER: &str = "BIGBUD_TEST_SHUTDOWN_SEAL_BARRIER";

#[test]
fn lost_requester_after_publication_seal_cannot_abandon_owned_shutdown() {
    let mut rig = Rig::new("lost-shutdown-requester", Some(SEAL_BARRIER));
    let (mut terminal, _) = rig.connect();
    rig.open(&mut terminal);
    let pid = rig.pty(&mut terminal, "shutdown-child", "printf READY; sleep 100");
    read_until(
        &mut terminal,
        |p| matches!(p, v1::frame::Payload::PtyOutput(v) if v.bytes.ends_with(b"READY")),
    );
    let (mut control, hello) = rig.connect();
    Rig::shutdown(&mut control, &hello);
    rig.wait_barrier();
    assert!(rig.child.try_wait().unwrap().is_none());
    assert_publication_remains_fenced(&rig);
    // SAFETY: signal zero only probes the already-reaped direct child.
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    control.shutdown(Shutdown::Both).unwrap();
    drop(control);
    // Observe the disconnected requester's closed writer deterministically
    // before final response admission, rather than relying on socket timing.
    fs::write(rig.root.join("barrier/lost-requester"), b"closed").unwrap();
    rig.release();
    wait_for_exit(&mut rig.child);
    assert!(rig.child.try_wait().unwrap().unwrap().success());
    assert!(rig.root.join("barrier/disposed").exists());
}

#[test]
fn failed_sibling_drain_after_seal_disposes_transports_and_finishes_shutdown() {
    sibling_drain_failure("failed-drain");
}

#[test]
fn expired_sibling_drain_after_seal_disposes_transports_and_finishes_shutdown() {
    sibling_drain_failure("expired-drain");
}

#[test]
fn exhausted_response_encoding_budget_cannot_abandon_sealed_shutdown() {
    let mut rig = Rig::new("shutdown-encoded-budget", Some(SEAL_BARRIER));
    let (mut control, hello) = rig.connect();
    Rig::shutdown(&mut control, &hello);
    rig.wait_barrier();
    fs::write(rig.root.join("barrier/encoded-budget"), b"exhaust").unwrap();
    rig.release();
    wait_for_exit(&mut rig.child);
    assert!(rig.child.try_wait().unwrap().unwrap().success());
    assert!(rig.root.join("barrier/profile-exhausted").exists());
    assert!(rig.root.join("barrier/disposed").exists());
    assert!(
        read_frame(&mut control, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .is_none()
    );
}

fn sibling_drain_failure(fault: &str) {
    let mut rig = Rig::new(fault, Some(SEAL_BARRIER));
    let (mut sibling, _) = rig.connect();
    rig.open(&mut sibling);
    let (mut control, hello) = rig.connect();
    Rig::shutdown(&mut control, &hello);
    rig.wait_barrier();
    assert!(rig.child.try_wait().unwrap().is_none());
    fs::write(rig.root.join("barrier").join(fault), b"inject").unwrap();
    rig.release();
    read_until(
        &mut control,
        |p| matches!(p, v1::frame::Payload::SupervisorShutdownResponse(v) if v.accepted && v.terminal),
    );
    wait_for_exit(&mut rig.child);
    assert!(rig.child.try_wait().unwrap().unwrap().success());
    assert_eq!(
        fs::read(rig.root.join("barrier/drain-failed")).unwrap(),
        fault.as_bytes()
    );
    assert!(rig.root.join("barrier/disposed").exists());
    assert!(
        read_frame(&mut sibling, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .is_none()
    );
}

fn assert_publication_remains_fenced(rig: &Rig) {
    let mut newcomer = UnixStream::connect(&rig.socket).unwrap();
    newcomer
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write_request(
        &mut newcomer,
        v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "after-seal".into(),
            connection_id: "after-seal".into(),
            server_nonce: "after-seal".into(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }),
    );
    assert!(
        read_frame(&mut newcomer, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .is_none()
    );
}
