#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    guard::{PriorityRetirement, RetirementCause},
    owner::{IndependentLifeline, WatcherOutcome},
};
use std::{io::Write, net::Shutdown, num::NonZeroU32, os::unix::net::UnixListener, thread};

fn root(generation: &str) -> ExecutionRoot {
    let pid = NonZeroU32::new(std::process::id()).unwrap();
    ExecutionRoot {
        pid,
        creation_identity: inspect(pid).unwrap().creation,
        generation: generation.into(),
    }
}
fn socket() -> (UnixStream, UnixStream) {
    let directory = crate::guard::test_support::TestDirectory::new();
    let path = directory.0.join("bootstrap.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let client = UnixStream::connect(&path).unwrap();
    let (server, _) = listener.accept().unwrap();
    (client, server)
}
fn frame(secret: &[u8; 32]) -> Vec<u8> {
    let mut bytes = 34_u32.to_be_bytes().to_vec();
    bytes.extend([1, 3]);
    bytes.extend(secret);
    bytes
}
fn retry_refused(capability: &mut BootstrapCapability, secret: &[u8; 32]) {
    let (mut client, server) = socket();
    client.write_all(&frame(secret)).unwrap();
    assert!(
        capability.authenticate_stream(server).is_err(),
        "attempt must consume authority"
    );
}
fn assert_closed(mut client: UnixStream) {
    // Darwin can reject SO_RCVTIMEO on an already disconnected socket. A
    // nonblocking read proves closure without a timing-dependent setsockopt.
    client.set_nonblocking(true).unwrap();
    match client.read(&mut [0]) {
        Ok(0) => {}
        Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
        result => panic!("failed bootstrap retained its endpoint: {result:?}"),
    }
}

#[test]
fn valid_bootstrap_retains_lifetime_generation_and_consumes_authority() {
    let expected = root("worker-boot-1");
    let (mut capability, secret) =
        BootstrapCapability::issue(expected.clone(), Role::Worker).unwrap();
    let (mut client, server) = socket();
    client.write_all(&frame(&secret)).unwrap();
    let peer = capability.authenticate_stream(server).unwrap();
    assert_eq!(peer.execution_root(), &expected);
    assert_eq!(peer.role, Role::Worker);
    retry_refused(&mut capability, &secret);
}

#[test]
fn malformed_frames_wrong_role_and_token_consume_authority_and_close_socket() {
    for mutation in 0..6 {
        let (mut capability, secret) =
            BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
        let mut bytes = frame(&secret);
        match mutation {
            0 => bytes[..4].copy_from_slice(&u32::MAX.to_be_bytes()),
            1 => bytes[..4].copy_from_slice(&33_u32.to_be_bytes()),
            2 => bytes[4] = 2,
            3 => bytes[5] = 0,
            4 => bytes[5] = 2, // valid owner tag, wrong bound role
            _ => bytes[6] ^= 1,
        }
        let (mut client, server) = socket();
        client.write_all(&bytes).unwrap();
        assert!(capability.authenticate_stream(server).is_err());
        assert_closed(client);
        retry_refused(&mut capability, &secret);
    }
}

#[test]
fn eof_at_every_frame_offset_burns_authority_and_closes_socket() {
    for length in 0..38 {
        let (mut capability, secret) =
            BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
        let (mut client, server) = socket();
        client.write_all(&frame(&secret)[..length]).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        assert_eq!(
            capability.authenticate_stream(server).err().unwrap().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_closed(client);
        retry_refused(&mut capability, &secret);
    }
}

#[test]
fn silent_or_partial_peer_times_out_and_cannot_retry() {
    for length in [0, 3, 4, 20, 37] {
        let (mut capability, secret) =
            BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
        let (mut client, server) = socket();
        client.write_all(&frame(&secret)[..length]).unwrap();
        capability.deadline = Instant::now() + Duration::from_millis(40);
        let start = Instant::now();
        assert_eq!(
            capability.authenticate_stream(server).err().unwrap().kind(),
            io::ErrorKind::TimedOut,
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "read did not honor deadline"
        );
        assert_closed(client);
        // Renew only the test clock to distinguish consumption from expiry rejection.
        capability.deadline = Instant::now() + BOOTSTRAP_BUDGET;
        retry_refused(&mut capability, &secret);
    }
}

#[test]
fn already_expired_authority_is_consumed_before_reading() {
    let (mut capability, secret) =
        BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
    capability.deadline = Instant::now();
    let (client, server) = socket();
    assert!(capability.authenticate_stream(server).is_err());
    assert_closed(client);
    capability.deadline = Instant::now() + BOOTSTRAP_BUDGET;
    retry_refused(&mut capability, &secret);
}

#[test]
fn endpoint_identity_or_inheritance_failure_burns_before_any_read() {
    use std::os::fd::AsRawFd;
    for change in 0..4 {
        let (mut capability, secret) =
            BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
        let original = capability.expected.clone();
        let uid = capability.uid;
        let (client, server) = socket();
        match change {
            0 => capability.uid = uid.wrapping_add(1),
            1 => capability.expected.pid = NonZeroU32::new(2).unwrap(),
            2 => capability.expected.creation_identity = "stale-creation".into(),
            _ => {
                // SAFETY: test-owned live FD, integer flags; no exec or child.
                assert_eq!(
                    unsafe { libc::fcntl(server.as_raw_fd(), libc::F_SETFD, 0) },
                    0
                );
            }
        }
        assert!(capability.authenticate_stream(server).is_err());
        assert_closed(client);
        capability.expected = original;
        capability.uid = uid;
        retry_refused(&mut capability, &secret);
    }
}

#[test]
fn a_new_generation_does_not_accept_previous_generation_capability() {
    let (_old, old_secret) = BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
    let (mut current, secret) = BootstrapCapability::issue(root("worker-2"), Role::Worker).unwrap();
    let (mut client, server) = socket();
    client.write_all(&frame(&old_secret)).unwrap();
    assert!(current.authenticate_stream(server).is_err());
    retry_refused(&mut current, &secret);
}

#[test]
fn bootstrap_composes_with_lifeline_and_preserves_extra_data_for_revocation() {
    for suffix in [false, true] {
        let (mut capability, secret) =
            BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
        let (mut client, server) = socket();
        let mut bytes = frame(&secret);
        if suffix {
            bytes.push(99);
        }
        client.write_all(&bytes).unwrap();
        let requests = PriorityRetirement::default();
        let watcher =
            IndependentLifeline::bootstrap(&mut capability, server, requests.clone()).unwrap();
        if !suffix {
            client.shutdown(Shutdown::Write).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let expected = if suffix {
            RetirementCause::MalformedLifeline
        } else {
            RetirementCause::WorkerLost
        };
        let mut observed = 0;
        while observed == 0 && Instant::now() < deadline {
            observed = requests.take_causes();
            thread::sleep(Duration::from_millis(1));
        }
        let outcome = match watcher.stop_and_join(Duration::from_secs(1)) {
            Ok(outcome) => outcome,
            Err(_) => panic!("watcher did not join"),
        };
        assert_eq!(observed, expected as u8);
        assert_eq!(
            outcome,
            if suffix {
                WatcherOutcome::Malformed
            } else {
                WatcherOutcome::ParentLost
            }
        );
        assert!(requests.admission_closed());
    }
}

#[test]
fn failed_composed_bootstrap_raises_priority_revocation_without_a_watcher() {
    let (mut capability, secret) =
        BootstrapCapability::issue(root("worker-1"), Role::Worker).unwrap();
    let (client, server) = socket();
    client.shutdown(Shutdown::Write).unwrap();
    let requests = PriorityRetirement::default();
    assert!(IndependentLifeline::bootstrap(&mut capability, server, requests.clone()).is_err());
    assert_eq!(requests.take_causes(), RetirementCause::LifelineIo as u8);
    assert!(requests.admission_closed());
    assert_closed(client);
    retry_refused(&mut capability, &secret);
}
