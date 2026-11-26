//! In-app SSH password and key-passphrase vectors (Request 190–193, Reply
//! 106–107, ErrorCode 79–81; v1.credential.proto), encoded independently with
//! prost. No frame carries a secret.

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let lease = vec![0xc1; 32];
    let open = |kind: v1::CredentialKind| {
        request(Operation::CredentialUnlockOpen(v1::CredentialUnlockOpen {
            lease: lease.clone(),
            kind: kind.into(),
        }))
    };
    let error = |code: v1::ErrorCode| {
        reply(Outcome::Error(v1::Error {
            code: code.into(),
            jump_failure: None,
        }))
    };
    for (name, payload) in [
        (
            "inspect_credential",
            request(Operation::InspectCredential(v1::InspectCredential {})),
        ),
        (
            "credential_unlock_open_password",
            open(v1::CredentialKind::Password),
        ),
        (
            "credential_unlock_open_passphrase",
            open(v1::CredentialKind::KeyPassphrase),
        ),
        (
            "credential_unlock_commit",
            request(Operation::CredentialUnlockCommit(
                v1::CredentialUnlockCommit {
                    lease: lease.clone(),
                },
            )),
        ),
        (
            "credential_lock",
            request(Operation::CredentialLock(v1::CredentialLock {})),
        ),
        (
            "credential_state_password_locked",
            reply(Outcome::CredentialState(v1::CredentialState {
                kind: v1::CredentialKind::Password.into(),
                unlocked: false,
                attempts_remaining: 3,
                identity: String::new(),
            })),
        ),
        (
            "credential_state_passphrase_unlocked",
            reply(Outcome::CredentialState(v1::CredentialState {
                kind: v1::CredentialKind::KeyPassphrase.into(),
                unlocked: true,
                attempts_remaining: 3,
                identity: "/home/u/.ssh/id_ed25519".into(),
            })),
        ),
        (
            "credential_unlock_lease",
            reply(Outcome::CredentialUnlockLease(v1::CredentialUnlockLease {
                lease: lease.clone(),
                socket_path: "/tmp/bigbud-oc1-0123456789abcdef/s".into(),
            })),
        ),
        (
            "error_credential_required",
            error(v1::ErrorCode::CredentialRequired),
        ),
        (
            "error_credential_rejected",
            error(v1::ErrorCode::CredentialRejected),
        ),
        (
            "error_credential_attempts_exhausted",
            error(v1::ErrorCode::CredentialAttemptsExhausted),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
