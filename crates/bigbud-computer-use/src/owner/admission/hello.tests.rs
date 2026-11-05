use super::hello::*;
use crate::Role;

fn local() -> HelloFields {
    HelloFields {
        major: 1,
        minor: 0,
        tuple_digest: "a".repeat(64),
        role: "guard".into(),
        owner_generation: "owner-1".into(),
        worker_generation: "worker-1".into(),
        qualification_profile: "profile-1".into(),
        control_frame_bytes: 64 * 1024,
        data_frame_bytes: 25 * 1024 * 1024,
        instance_id: "guard-instance".into(),
    }
}
fn peer() -> HelloFields {
    HelloFields {
        role: "owner".into(),
        instance_id: "owner-instance".into(),
        control_frame_bytes: 32 * 1024,
        minor: 7,
        ..local()
    }
}

#[test]
fn compatible_peer_negotiates_minimum_limits_and_minor() {
    let negotiated = negotiate(&local(), &peer(), Role::Owner);
    assert_eq!(
        negotiated,
        Ok(Negotiated {
            minor: 0,
            control_frame_bytes: 32 * 1024,
            data_frame_bytes: 25 * 1024 * 1024,
            owner_generation: "owner-1".into(),
            worker_generation: "worker-1".into(),
        })
    );
}

#[test]
fn every_incompatibility_refuses_before_operations() {
    type Mutation = fn(&mut HelloFields);
    let cases: Vec<(Mutation, HelloRefusal)> = vec![
        (|p| p.major = 2, HelloRefusal::Major),
        (|p| p.tuple_digest = "b".repeat(64), HelloRefusal::Tuple),
        (|p| p.tuple_digest = "A".repeat(64), HelloRefusal::Tuple),
        (|p| p.role = "worker".into(), HelloRefusal::Role),
        (
            |p| p.owner_generation = "owner-0".into(),
            HelloRefusal::Generation,
        ),
        (
            |p| p.worker_generation = "bad gen".into(),
            HelloRefusal::Generation,
        ),
        (
            |p| p.qualification_profile = "profile-2".into(),
            HelloRefusal::Profile,
        ),
        (
            |p| p.instance_id = "guard-instance".into(),
            HelloRefusal::Instance,
        ),
        (|p| p.control_frame_bytes = 0, HelloRefusal::Limits),
    ];
    for (mutate, expected) in cases {
        let mut candidate = peer();
        mutate(&mut candidate);
        assert_eq!(negotiate(&local(), &candidate, Role::Owner), Err(expected));
    }
    let mut oversized = local();
    oversized.control_frame_bytes = u32::MAX;
    let mut big_peer = peer();
    big_peer.control_frame_bytes = u32::MAX;
    assert_eq!(
        negotiate(&oversized, &big_peer, Role::Owner),
        Err(HelloRefusal::Limits)
    );
    // A local Hello advertising an unimplemented minor is refused too.
    let mut future = local();
    future.minor = PROTOCOL_MINOR + 1;
    assert_eq!(
        negotiate(&future, &peer(), Role::Owner),
        Err(HelloRefusal::Major)
    );
}
