use std::collections::BTreeMap;

use super::{assert_frame, reply, v1};
use v1::{
    Empty, Error, ErrorCode, HelloAccepted, Request, TargetAuthMode, TargetDescriptor, TargetKind,
    frame::Payload, reply::Outcome, request::Operation,
};

/// W3.7 additive per-target vectors: a target-free acceptance and one
/// target-scoped request that carries its descriptor.
pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    assert_frame(
        values,
        "hello_accepted",
        Payload::HelloAccepted(HelloAccepted {
            major: 1,
            minor: 0,
            owner_epoch: vec![0, 0x2a],
            proof_target_generation: Vec::new(),
            proof_alias_descriptor: Vec::new(),
            profile_binding: vec![0, 0x61, 0xff],
            multi_target: false,
            ..HelloAccepted::default()
        }),
    );
    assert_frame(
        values,
        "hello_accepted_multi_target",
        Payload::HelloAccepted(HelloAccepted {
            major: 1,
            minor: 0,
            owner_epoch: vec![0, 0x2a],
            proof_target_generation: Vec::new(),
            proof_alias_descriptor: Vec::new(),
            profile_binding: vec![0, 0x61, 0xff],
            multi_target: true,
            ..HelloAccepted::default()
        }),
    );
    assert_frame(
        values,
        "target_descriptor_request",
        Payload::Request(Request {
            request_id: vec![1, 0x80, 0xff],
            owner_epoch: vec![0, 0x2a],
            target_generation: Vec::new(),
            target_id: "ssh:host=a".into(),
            grant: vec![0x80, 0],
            target_descriptor: Some(TargetDescriptor {
                target_id: "ssh:host=a".into(),
                kind: TargetKind::Structured.into(),
                host: "127.0.0.1".into(),
                port: 2222,
                user: "tester".into(),
                auth_mode: TargetAuthMode::Key.into(),
                identity_reference: "/home/fixture/.ssh/id_ed25519".into(),
                host_key_alias: "fixture-host".into(),
                trust_reference: "/home/fixture/.ssh/known_hosts".into(),
                generation: Vec::new(),
            }),
            operation: Some(Operation::InspectTrust(Empty {})),
        }),
    );
    for (name, code) in [
        ("target_unknown", ErrorCode::TargetUnknown),
        ("target_mismatch", ErrorCode::TargetMismatch),
    ] {
        assert_frame(
            values,
            &format!("error_{name}"),
            reply(Outcome::Error(Error {
                code: code.into(),
                jump_failure: None,
            })),
        );
    }
}
