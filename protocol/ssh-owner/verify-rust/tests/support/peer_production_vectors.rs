//! U24 production peer enrollment and relay vectors (Request 130–136, Reply
//! 76–79, ErrorCode 59–62), encoded independently with prost.

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAIRING: &str = "5eb1c0de-1111-4222-8333-444455556666";
const HOST_FINGERPRINT: &str = "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk";

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let challenge = vec![0x24; 32];
    let lease = vec![0x79; 32];
    let coordinator = format!("sha256:{}", "1".repeat(64));
    let inspect = |port| {
        request(Operation::InspectPeerHostKey(v1::InspectPeerHostKey {
            host: "w1.example.test".into(),
            port,
        }))
    };
    let relay = |phase: v1::PeerRelayPhase, socket_path: Option<&str>, exit_code| {
        reply(Outcome::PeerRelay(v1::PeerRelayState {
            lease: lease.clone(),
            phase: phase.into(),
            socket_path: socket_path.map(Into::into),
            exit_code,
            pairing_id: PAIRING.into(),
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
            "ensure_peer_coordinator_key",
            request(Operation::EnsurePeerCoordinatorKey(v1::Empty {})),
        ),
        ("inspect_peer_host_key", inspect(22)),
        ("inspect_peer_host_key_other_port", inspect(2222)),
        (
            "approve_peer_pin",
            request(Operation::ApprovePeerPin(v1::ApprovePeerPin {
                challenge: challenge.clone(),
                pairing_id: PAIRING.into(),
                user: "bbpeer".into(),
            })),
        ),
        (
            "revoke_peer_pin",
            request(Operation::RevokePeerPin(v1::RevokePeerPin {
                pairing_id: PAIRING.into(),
            })),
        ),
        (
            "peer_relay_open",
            request(Operation::PeerRelayOpen(v1::PeerRelayOpen {
                lease: lease.clone(),
                pairing_id: PAIRING.into(),
            })),
        ),
        (
            "peer_relay_status",
            request(Operation::PeerRelayStatus(v1::PeerRelayLease {
                lease: lease.clone(),
            })),
        ),
        (
            "peer_relay_close",
            request(Operation::PeerRelayClose(v1::PeerRelayLease {
                lease: lease.clone(),
            })),
        ),
        (
            "peer_coordinator_key",
            reply(Outcome::PeerCoordinatorKey(v1::PeerCoordinatorKey {
                public_key: format!("ssh-ed25519 {KEY}"),
                fingerprint: coordinator.clone(),
                algorithm: "ssh-ed25519".into(),
            })),
        ),
        (
            "peer_host_key",
            reply(Outcome::PeerHostKey(v1::PeerHostKey {
                key_type: "ssh-ed25519".into(),
                fingerprint: HOST_FINGERPRINT.into(),
                public_key: format!("ssh-ed25519 {KEY}"),
                challenge: challenge.clone(),
            })),
        ),
        (
            "peer_pin",
            reply(Outcome::PeerPin(v1::PeerPin {
                pairing_id: PAIRING.into(),
                host: "w1.example.test".into(),
                port: 22,
                user: "bbpeer".into(),
                host_key_fingerprint: HOST_FINGERPRINT.into(),
                coordinator_key_fingerprint: coordinator.clone(),
            })),
        ),
        (
            "peer_relay_listening",
            relay(
                v1::PeerRelayPhase::Listening,
                Some("/tmp/bigbud-peer-relay/s"),
                None,
            ),
        ),
        (
            "peer_relay_exited",
            relay(v1::PeerRelayPhase::Exited, None, Some(0)),
        ),
        (
            "error_peer_key_corrupt",
            error(v1::ErrorCode::PeerKeyCorrupt),
        ),
        (
            "error_peer_pin_unknown",
            error(v1::ErrorCode::PeerPinUnknown),
        ),
        (
            "error_peer_pin_mismatch",
            error(v1::ErrorCode::PeerPinMismatch),
        ),
        (
            "error_peer_auth_refused",
            error(v1::ErrorCode::PeerAuthRefused),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
