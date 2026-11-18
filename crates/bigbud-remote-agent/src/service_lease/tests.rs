#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn capability_hash_and_immutable_binding_are_bounded() {
    let binding = Binding {
        authority: "a".repeat(32),
        installation: format!("sha256:{}", "b".repeat(64)),
        native_epoch: "epoch".into(),
        nonce: "nonce".into(),
        publication_sha256: [1; 32],
        executable_sha256: [2; 32],
        assets_sha256: [3; 32],
        configuration_sha256: [4; 32],
        guard_sha256: [0; 32],
    };
    binding.validate().unwrap();
    let mut bad = binding.clone();
    bad.authority = "A".repeat(32);
    assert!(bad.validate().is_err());
    bad = binding;
    bad.nonce = "../escape".into();
    assert!(bad.validate().is_err());
    assert!(identity::capability_hash(&[0; 31]).is_err());
    assert!(identity::capability_hash(&[0; 65]).is_err());
    let hash = identity::capability_hash(&[1; 32]).unwrap();
    assert!(identity::capability_matches(&hash, &[1; 32]));
    assert!(!identity::capability_matches(&hash, &[2; 32]));
}
#[cfg(all(unix, not(target_os = "linux")))]
#[test]
fn unsupported_platform_never_constructs_an_account_service_owner() {
    assert!(matches!(
        LeaseOwner::new("epoch".into()),
        Err(Error::Unsupported)
    ));
}

#[test]
fn ordinary_agent_never_advertises_managed_service_lease() {
    let mut session = crate::AgentSession::new().unwrap();
    let reply = session
        .handle(bigbud_protocol::v1::Frame {
            payload: Some(bigbud_protocol::v1::frame::Payload::ClientHello(
                bigbud_protocol::v1::ClientHello {
                    protocol_major: bigbud_protocol::PROTOCOL_MAJOR,
                    client_instance_id: "fixture".into(),
                    ..Default::default()
                },
            )),
        })
        .unwrap();
    let Some(bigbud_protocol::v1::frame::Payload::AgentHello(hello)) = reply.payload else {
        panic!("hello reply expected")
    };
    assert!(
        !hello
            .capabilities
            .iter()
            .any(|capability| capability.name == "service.lease")
    );
}
