#![allow(clippy::unwrap_used)]
use super::references::*;

const SECOND: u64 = 1_000_000_000;
fn epochs() -> Epochs {
    Epochs {
        policy_revision: 3,
        pause_epoch: 7,
        worker_generation: "worker-1".into(),
        session_generation: 1,
    }
}
fn identity() -> Identity {
    Identity {
        pid: 42,
        process_start: "darwin:42:1000".into(),
        window: 9,
        geometry: (0, 0, 800, 600, 2000),
    }
}
fn binding(caller: &str, modality: Modality) -> Binding {
    Binding {
        caller: caller.into(),
        epochs: epochs(),
        identity: identity(),
        modality,
        capture_id: Some("capture-1".into()),
    }
}

#[test]
fn targets_resolve_only_for_their_caller_and_unchanged_identity() {
    let mut refs = References::new("worker-1");
    let id = refs
        .issue_target(binding("c1", Modality::Accessibility), 0)
        .unwrap();
    let ok = refs.resolve_target(
        &id,
        "c1",
        &epochs(),
        &identity(),
        Modality::Accessibility,
        1,
    );
    assert!(ok.is_ok());
    let missing = |r: Result<&Binding, RefRefusal>| r.unwrap_err();
    // Cross-caller use is indistinguishable from an absent reference.
    let other = refs.resolve_target(
        &id,
        "c2",
        &epochs(),
        &identity(),
        Modality::Accessibility,
        1,
    );
    assert_eq!(missing(other), RefRefusal::TargetMissing);
    let reused = Identity {
        process_start: "darwin:42:2000".into(),
        ..identity()
    };
    let moved = Identity {
        geometry: (10, 0, 800, 600, 2000),
        ..identity()
    };
    let stale_epochs = [
        Epochs {
            policy_revision: 4,
            ..epochs()
        },
        Epochs {
            pause_epoch: 8,
            ..epochs()
        },
        Epochs {
            worker_generation: "worker-2".into(),
            ..epochs()
        },
        Epochs {
            session_generation: 2,
            ..epochs()
        },
    ];
    // Each stale case gets a fresh reference: a stale one is removed.
    let fresh = |refs: &mut References| {
        refs.release_caller("c1");
        refs.issue_target(binding("c1", Modality::Accessibility), 0)
            .unwrap()
    };
    for live in [&reused, &moved] {
        let id = fresh(&mut refs);
        let refusal = refs
            .resolve_target(&id, "c1", &epochs(), live, Modality::Accessibility, 1)
            .unwrap_err();
        assert_eq!(refusal, RefRefusal::TargetStale);
        assert!(refusal.observe_again());
    }
    for changed in &stale_epochs {
        let id = fresh(&mut refs);
        let refusal = refs
            .resolve_target(&id, "c1", changed, &identity(), Modality::Accessibility, 1)
            .unwrap_err();
        assert_eq!(refusal.code(), "target_stale");
    }
    let id = fresh(&mut refs);
    let wrong = refs.resolve_target(&id, "c1", &epochs(), &identity(), Modality::Pixel, 1);
    assert_eq!(missing(wrong), RefRefusal::ModalityMismatch);
    // A modality mismatch keeps the reference for its own modality.
    let ok = refs.resolve_target(
        &id,
        "c1",
        &epochs(),
        &identity(),
        Modality::Accessibility,
        1,
    );
    assert!(ok.is_ok());
    let expired = refs.resolve_target(
        &id,
        "c1",
        &epochs(),
        &identity(),
        Modality::Accessibility,
        60 * SECOND,
    );
    assert_eq!(missing(expired), RefRefusal::TargetStale);
}

#[test]
fn observations_are_consumed_once_and_bounded_without_eviction() {
    let mut refs = References::new("worker-1");
    let id = refs
        .issue_observation(binding("c1", Modality::Pixel), 1024, 0)
        .unwrap();
    refs.admit_mutation(Some(&id), "c1", &epochs(), &identity(), 1)
        .unwrap();
    assert_eq!(
        refs.admit_mutation(Some(&id), "c1", &epochs(), &identity(), 1),
        Err(RefRefusal::ObservationMissing)
    );
    let accessibility = refs
        .issue_observation(binding("c1", Modality::Accessibility), 1, 0)
        .unwrap();
    assert_eq!(
        refs.admit_mutation(Some(&accessibility), "c1", &epochs(), &identity(), 1),
        Err(RefRefusal::ModalityMismatch)
    );
    let mut refs = References::new("worker-1");
    for _ in 0..32 {
        refs.issue_observation(binding("c1", Modality::Pixel), 1, 0)
            .unwrap();
    }
    assert_eq!(
        refs.issue_observation(binding("c2", Modality::Pixel), 1, 0),
        Err(RefRefusal::ObservationCapacity)
    );
    // Expiry (60 s TTL) reclaims capacity; live authority is never evicted.
    assert!(
        refs.issue_observation(binding("c2", Modality::Pixel), 1, 60 * SECOND)
            .is_ok()
    );
    let mut refs = References::new("worker-1");
    refs.issue_observation(binding("c1", Modality::Pixel), 64 * 1024 * 1024, 0)
        .unwrap();
    assert_eq!(
        refs.issue_observation(binding("c1", Modality::Pixel), 1, 0),
        Err(RefRefusal::ObservationCapacity)
    );
    refs.release_caller("c1");
    assert!(
        refs.issue_observation(binding("c1", Modality::Pixel), 1, 0)
            .is_ok()
    );
}

#[test]
fn four_targets_per_caller_and_release_revokes() {
    let mut refs = References::new("worker-1");
    let ids: Vec<_> = (0..4)
        .map(|_| {
            refs.issue_target(binding("c1", Modality::Pixel), 0)
                .unwrap()
        })
        .collect();
    assert_eq!(
        refs.issue_target(binding("c1", Modality::Pixel), 0),
        Err(RefRefusal::TargetCapacity)
    );
    assert!(refs.issue_target(binding("c2", Modality::Pixel), 0).is_ok());
    refs.release_caller("c1");
    let first = ids.first().unwrap();
    assert_eq!(
        refs.resolve_target(first, "c1", &epochs(), &identity(), Modality::Pixel, 1)
            .unwrap_err(),
        RefRefusal::TargetMissing
    );
    assert!(ids.iter().all(|id| id.len() <= 128));
}

#[test]
fn any_admitted_mutation_invalidates_every_callers_observations() {
    let mut refs = References::new("worker-1");
    let a = refs
        .issue_observation(binding("c1", Modality::Pixel), 10, 0)
        .unwrap();
    let b = refs
        .issue_observation(binding("c2", Modality::Pixel), 10, 0)
        .unwrap();
    // Caller c2 types (no observation named): c1's screenshot is now stale.
    assert_eq!(
        refs.admit_mutation(None, "c2", &epochs(), &identity(), 1),
        Ok(None)
    );
    for (id, caller) in [(&a, "c1"), (&b, "c2")] {
        assert_eq!(
            refs.admit_mutation(Some(id), caller, &epochs(), &identity(), 2),
            Err(RefRefusal::ObservationMissing)
        );
    }
    // A refused mutation invalidates nothing else.
    let keep = refs
        .issue_observation(binding("c1", Modality::Pixel), 10, 3)
        .unwrap();
    assert!(
        refs.admit_mutation(Some("o999"), "c1", &epochs(), &identity(), 4)
            .is_err()
    );
    assert!(
        refs.admit_mutation(Some(&keep), "c1", &epochs(), &identity(), 5)
            .is_ok()
    );
}

#[test]
fn stale_references_are_removed_and_superseded_ones_free_capacity() {
    let mut refs = References::new("worker-1");
    let id = refs
        .issue_target(binding("c1", Modality::Pixel), 0)
        .unwrap();
    let moved = Identity {
        geometry: (5, 5, 800, 600, 2000),
        ..identity()
    };
    let stale = refs.resolve_target(&id, "c1", &epochs(), &moved, Modality::Pixel, 1);
    assert_eq!(stale.unwrap_err(), RefRefusal::TargetStale);
    // Moving back never revives it.
    let back = refs.resolve_target(&id, "c1", &epochs(), &identity(), Modality::Pixel, 2);
    assert_eq!(back.unwrap_err(), RefRefusal::TargetMissing);
    for _ in 0..4 {
        refs.issue_target(binding("c1", Modality::Pixel), 3)
            .unwrap();
    }
    // A policy change makes all four permanently stale; they no longer block.
    let mut newer = binding("c1", Modality::Pixel);
    newer.epochs.policy_revision += 1;
    assert!(refs.issue_target(newer, 4).is_ok());
}

#[test]
fn superseded_issuance_is_refused_and_never_evicts_newer_references() {
    let mut refs = References::new("worker-1");
    let mut newer = binding("c2", Modality::Pixel);
    newer.epochs.pause_epoch += 1;
    let live = refs.issue_observation(newer.clone(), 10, 0).unwrap();
    // A slow capture still bound to the older pause epoch arrives late.
    assert_eq!(
        refs.issue_observation(binding("c1", Modality::Pixel), 10, 1),
        Err(RefRefusal::ObservationStale)
    );
    assert_eq!(
        refs.issue_target(binding("c1", Modality::Pixel), 1),
        Err(RefRefusal::TargetStale)
    );
    assert!(
        refs.admit_mutation(Some(&live), "c2", &newer.epochs, &identity(), 2)
            .is_ok()
    );
}

#[test]
fn a_stale_named_observation_is_removed_without_invalidating_others() {
    let mut refs = References::new("worker-1");
    let named = refs
        .issue_observation(binding("c1", Modality::Pixel), 10, 0)
        .unwrap();
    let other = refs
        .issue_observation(binding("c2", Modality::Pixel), 10, 0)
        .unwrap();
    let moved = Identity {
        window: 10,
        ..identity()
    };
    assert_eq!(
        refs.admit_mutation(Some(&named), "c1", &epochs(), &moved, 1),
        Err(RefRefusal::ObservationStale)
    );
    assert_eq!(
        refs.admit_mutation(Some(&named), "c1", &epochs(), &identity(), 2),
        Err(RefRefusal::ObservationMissing)
    );
    assert!(
        refs.admit_mutation(Some(&other), "c2", &epochs(), &identity(), 3)
            .is_ok()
    );
}

#[test]
fn late_issuance_from_an_older_session_or_worker_never_evicts() {
    let mut refs = References::new("worker-1");
    let mut session2 = binding("c1", Modality::Accessibility);
    session2.epochs.session_generation = 2;
    let live = refs.issue_target(session2.clone(), 0).unwrap();
    // A slow capture still bound to session 1 arrives after session 2.
    assert_eq!(
        refs.issue_target(binding("c1", Modality::Accessibility), 1),
        Err(RefRefusal::TargetStale)
    );
    let mut worker2 = binding("c2", Modality::Accessibility);
    worker2.epochs.worker_generation = "worker-2".into();
    // Another generation only issues after an explicit owner rotation.
    assert_eq!(
        refs.issue_target(worker2.clone(), 2),
        Err(RefRefusal::TargetStale)
    );
    let check = |refs: &mut References, epochs: &Epochs| {
        refs.resolve_target(&live, "c1", epochs, &identity(), Modality::Accessibility, 3)
            .map(|_| ())
    };
    assert_eq!(check(&mut refs, &session2.epochs), Ok(()));
    refs.rotate_worker("worker-2");
    assert_eq!(
        check(&mut refs, &session2.epochs),
        Err(RefRefusal::TargetMissing)
    );
    assert!(refs.issue_target(worker2, 4).is_ok());
    // ...and the retired generation can no longer issue.
    assert_eq!(refs.issue_target(session2, 5), Err(RefRefusal::TargetStale));
}

#[test]
fn an_empty_table_never_adopts_a_late_worker_generation() {
    // Worker 1 died before issuing anything; the owner started worker 2.
    let mut refs = References::new("worker-2");
    assert_eq!(
        refs.issue_target(binding("c1", Modality::Pixel), 0),
        Err(RefRefusal::TargetStale)
    );
    let mut current = binding("c1", Modality::Pixel);
    current.epochs.worker_generation = "worker-2".into();
    assert!(refs.issue_target(current, 1).is_ok());
}
