#![allow(clippy::unwrap_used)]
use super::*;
use std::{num::NonZeroU32, os::unix::net::UnixListener};

fn root() -> ExecutionRoot {
    let pid = NonZeroU32::new(std::process::id()).unwrap();
    ExecutionRoot {
        pid,
        creation_identity: inspect(pid).unwrap().creation,
        generation: "worker-1".into(),
    }
}
fn socket() -> (UnixStream, UnixStream) {
    let directory = crate::guard::test_support::TestDirectory::new();
    let path = directory.0.join("peer.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let client = UnixStream::connect(&path).unwrap();
    let (server, _) = listener.accept().unwrap();
    (client, server)
}
#[test]
fn authenticates_kernel_peer_and_consumes_once() {
    let (mut capability, secret) = BootstrapCapability::issue(root(), Role::Worker).unwrap();
    let (_client, server) = socket();
    let peer = capability
        .authenticate(server, Role::Worker, &secret)
        .unwrap();
    assert_eq!(peer.role, Role::Worker);
    let (_client, server) = socket();
    assert!(
        capability
            .authenticate(server, Role::Worker, &secret)
            .is_err()
    );
}
fn assert_invalid_credentials_burn_authority(role: Role, change_token: impl FnOnce(&mut Vec<u8>)) {
    // Match the successful control's issued capability and current kernel identity.
    let (mut capability, secret) = BootstrapCapability::issue(root(), Role::Worker).unwrap();
    let mut token = secret.to_vec();
    change_token(&mut token);
    let (_client, server) = socket();
    assert!(
        capability.authenticate(server, role, &token).is_err(),
        "invalid credentials must be rejected"
    );
    let (_client, server) = socket();
    assert!(
        capability
            .authenticate(server, Role::Worker, &secret)
            .is_err(),
        "failed authentication must burn authority even for correct credentials"
    );
}
#[test]
fn wrong_role_rejects_and_burns_authority() {
    assert_invalid_credentials_burn_authority(Role::Owner, |_| {});
}
#[test]
fn short_token_rejects_and_burns_authority() {
    assert_invalid_credentials_burn_authority(Role::Worker, |token| {
        token.truncate(TOKEN_BYTES - 1);
    });
}
#[test]
fn wrong_token_rejects_and_burns_authority() {
    assert_invalid_credentials_burn_authority(Role::Worker, |token| {
        token[0] ^= 1;
    });
}
#[test]
fn deadline_is_absolute_and_boundary_is_closed() {
    let now = Instant::now();
    let capability =
        BootstrapCapability::new(root(), Role::Worker, 0, [7; 32], now + BOOTSTRAP_BUDGET).unwrap();
    assert!(capability.matches(Role::Worker, &[7; 32], &[7; 32], now));
    assert!(!capability.matches(Role::Worker, &[7; 32], &[7; 32], capability.deadline));
}
#[test]
fn inheritable_endpoint_refuses_even_with_correct_secret() {
    use std::os::fd::AsRawFd;
    let (mut capability, secret) = BootstrapCapability::issue(root(), Role::Worker).unwrap();
    let (_client, server) = socket();
    // SAFETY: live test-owned socket; F_SETFD accepts integer flags. No exec or
    // child is started; authentication consumes/closes this descriptor on error.
    assert_eq!(
        unsafe { libc::fcntl(server.as_raw_fd(), libc::F_SETFD, 0) },
        0
    );
    assert!(
        capability
            .authenticate(server, Role::Worker, &secret)
            .is_err()
    );
    assert!(capability.secret.is_none());
}

#[test]
fn credentials_and_creation_mismatch_refuse_even_with_correct_secret() {
    for change in 0..3 {
        let (mut capability, secret) = BootstrapCapability::issue(root(), Role::Worker).unwrap();
        match change {
            0 => capability.uid = capability.uid.wrapping_add(1),
            1 => capability.expected.creation_identity = "stale-creation".into(),
            _ => capability.expected.pid = NonZeroU32::new(2).unwrap(),
        }
        let (_client, server) = socket();
        assert!(
            capability
                .authenticate(server, Role::Worker, &secret)
                .is_err()
        );
        assert!(capability.secret.is_none());
    }
}
