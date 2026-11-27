//! A reattached backend's first use of a target this owner already resolved
//! (W6 defect b): it knows no generation yet, so an empty generation adopts the
//! current one; a named, different generation is still stale.

use crate::{
    owner::terminal::production_tests::support::Fixture,
    v1::{ErrorCode, Request},
};

fn named(fixture: &Fixture, generation: &[u8]) -> Request {
    let mut descriptor = fixture.descriptor("ssh:host=a", 22222);
    descriptor.generation = generation.to_vec();
    Request {
        request_id: vec![2],
        target_id: "ssh:host=a".into(),
        target_generation: generation.to_vec(),
        target_descriptor: Some(descriptor),
        ..Request::default()
    }
}

#[test]
fn a_reattached_writer_adopts_a_known_target_with_an_empty_generation() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    fixture.bind(&mut owner, "ssh:host=a", 22222);
    owner.leave_target();
    let current = owner.targets.generation("ssh:host=a").unwrap();
    let mut resolve = |generation: &[u8]| {
        owner
            .targets
            .resolve(owner.authority.as_ref(), &named(&fixture, generation), None)
            .err()
    };
    assert_eq!(resolve(&[]), None);
    assert_eq!(resolve(&current), None);
    assert_eq!(resolve(&[7; 32]), Some(ErrorCode::StaleGeneration));
}
