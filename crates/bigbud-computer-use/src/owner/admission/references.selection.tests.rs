#![allow(clippy::unwrap_used)]
use super::limits::{MAX_CALLER_SESSIONS, MAX_SELECTION_HANDLES_PER_CALLER};
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
fn identity(window: u64) -> Identity {
    Identity {
        pid: 42,
        process_start: "darwin:42:1000".into(),
        window,
        geometry: (0, 0, 800, 600, 2000),
    }
}
fn windows(count: u64) -> Vec<DiscoveredWindow> {
    (1..=count)
        .map(|window| DiscoveredWindow {
            identity: identity(window),
            modality: Modality::Pixel,
            capture_id: None,
        })
        .collect()
}
fn use_ref(
    refs: &mut References,
    id: &str,
    caller: &str,
    window: u64,
    now: u64,
) -> Result<(), RefRefusal> {
    refs.resolve_target(
        id,
        caller,
        &epochs(),
        &identity(window),
        Modality::Pixel,
        now,
    )
    .map(|_| ())
}

#[test]
fn discovery_returns_a_handle_for_every_window_outside_the_target_cap() {
    let mut refs = References::new("worker-1");
    let ids = refs
        .issue_selections("c1", &epochs(), windows(12), 0)
        .unwrap();
    assert_eq!(ids.len(), 12);
    // Retained target capacity is untouched by discovery.
    for window in 0..4 {
        let binding = Binding {
            caller: "c1".into(),
            epochs: epochs(),
            identity: identity(100 + window),
            modality: Modality::Pixel,
            capture_id: None,
        };
        refs.issue_target(binding, 1).unwrap();
    }
    // ...but promotion is counted: with four retained targets it refuses
    // explicitly and keeps the selection for a later attempt.
    assert_eq!(
        use_ref(&mut refs, &ids[0], "c1", 1, 2),
        Err(RefRefusal::TargetCapacity)
    );
    assert_eq!(
        use_ref(&mut refs, &ids[0], "c1", 1, 3),
        Err(RefRefusal::TargetCapacity)
    );
}

#[test]
fn first_use_promotes_under_the_same_id_up_to_the_cap() {
    let mut refs = References::new("worker-1");
    let ids = refs
        .issue_selections("c1", &epochs(), windows(6), 0)
        .unwrap();
    for (index, id) in ids.iter().take(4).enumerate() {
        let window = u64::try_from(index).unwrap() + 1;
        use_ref(&mut refs, id, "c1", window, SECOND).unwrap();
    }
    assert_eq!(
        use_ref(&mut refs, &ids[4], "c1", 5, SECOND),
        Err(RefRefusal::TargetCapacity)
    );
    // A promoted handle keeps resolving past the selection TTL (target TTL).
    use_ref(&mut refs, &ids[0], "c1", 1, 30 * SECOND).unwrap();
    // Rediscovering a promoted window returns its retained ID.
    let again = refs
        .issue_selections("c1", &epochs(), windows(1), 31 * SECOND)
        .unwrap();
    assert_eq!(again, vec![ids[0].clone()]);
}

#[test]
fn repeated_discovery_reuses_handles_and_refreshes_expiry() {
    let mut refs = References::new("worker-1");
    let first = refs
        .issue_selections("c1", &epochs(), windows(3), 0)
        .unwrap();
    let second = refs
        .issue_selections("c1", &epochs(), windows(3), 10 * SECOND)
        .unwrap();
    assert_eq!(first, second);
    // Duplicate windows inside one discovery share a handle.
    let mut doubled = windows(2);
    doubled.extend(windows(2));
    let third = refs
        .issue_selections("c1", &epochs(), doubled, 11 * SECOND)
        .unwrap();
    assert_eq!(third[..2], third[2..]);
    // Refreshed at 10 s, so still live at 20 s (15 s TTL).
    use_ref(&mut refs, &first[2], "c1", 3, 20 * SECOND).unwrap();
}

#[test]
fn expired_cross_caller_and_drifted_selections_refuse() {
    let mut refs = References::new("worker-1");
    let ids = refs
        .issue_selections("c1", &epochs(), windows(3), 0)
        .unwrap();
    // Another caller's handle is indistinguishable from absent and survives.
    assert_eq!(
        use_ref(&mut refs, &ids[0], "c2", 1, 1),
        Err(RefRefusal::TargetMissing)
    );
    use_ref(&mut refs, &ids[0], "c1", 1, 2).unwrap();
    // Identity drift is stale and removes the handle permanently.
    assert_eq!(
        use_ref(&mut refs, &ids[1], "c1", 99, 3),
        Err(RefRefusal::TargetStale)
    );
    assert_eq!(
        use_ref(&mut refs, &ids[1], "c1", 2, 4),
        Err(RefRefusal::TargetMissing)
    );
    // Expiry at the selection TTL is stale, then gone.
    assert_eq!(
        use_ref(&mut refs, &ids[2], "c1", 3, 15 * SECOND),
        Err(RefRefusal::TargetStale)
    );
    assert_eq!(
        use_ref(&mut refs, &ids[2], "c1", 3, 15 * SECOND),
        Err(RefRefusal::TargetMissing)
    );
}

#[test]
fn selection_bound_refuses_without_changing_live_handles() {
    let mut refs = References::new("worker-1");
    let cap = u64::try_from(MAX_SELECTION_HANDLES_PER_CALLER).unwrap();
    assert_eq!(
        refs.issue_selections("c1", &epochs(), windows(cap + 1), 0),
        Err(RefRefusal::TargetCapacity)
    );
    let ids = refs
        .issue_selections("c1", &epochs(), windows(cap), 0)
        .unwrap();
    let extra = vec![DiscoveredWindow {
        identity: identity(cap + 1),
        modality: Modality::Pixel,
        capture_id: None,
    }];
    assert_eq!(
        refs.issue_selections("c1", &epochs(), extra.clone(), 1),
        Err(RefRefusal::TargetCapacity)
    );
    use_ref(&mut refs, &ids[0], "c1", 1, 2).unwrap();
    // The bound is per caller; promotion frees a selection slot.
    assert!(
        refs.issue_selections("c2", &epochs(), windows(1), 3)
            .is_ok()
    );
    assert!(refs.issue_selections("c1", &epochs(), extra, 4).is_ok());
}

#[test]
fn release_and_superseded_authority_revoke_selections() {
    let mut refs = References::new("worker-1");
    let ids = refs
        .issue_selections("c1", &epochs(), windows(2), 0)
        .unwrap();
    refs.release_caller("c1");
    assert_eq!(
        use_ref(&mut refs, &ids[0], "c1", 1, 1),
        Err(RefRefusal::TargetMissing)
    );

    let ids = refs
        .issue_selections("c1", &epochs(), windows(2), 2)
        .unwrap();
    let newer = Epochs {
        policy_revision: 4,
        ..epochs()
    };
    refs.issue_selections("c2", &newer, windows(1), 3).unwrap();
    // Discovery under the superseded revision is refused, never evicting.
    assert_eq!(
        refs.issue_selections("c1", &epochs(), windows(1), 4),
        Err(RefRefusal::TargetStale)
    );
    // The newer discovery reclaimed the old handles.
    assert_eq!(
        use_ref(&mut refs, &ids[0], "c1", 1, 5),
        Err(RefRefusal::TargetMissing)
    );
}

#[test]
fn promotion_reclaims_expired_targets_before_counting_the_cap() {
    let mut refs = References::new("worker-1");
    let ids = refs
        .issue_selections("c1", &epochs(), windows(5), 0)
        .unwrap();
    for (index, id) in ids.iter().take(4).enumerate() {
        let window = u64::try_from(index).unwrap() + 1;
        use_ref(&mut refs, id, "c1", window, 1).unwrap();
    }
    // Only the fifth window is rediscovered at 50 s (a fresh handle; the
    // targets are not refreshed). At 61 s the four retained targets have
    // expired and no longer occupy the cap.
    let fifth_window = windows(5).split_off(4);
    let again = refs
        .issue_selections("c1", &epochs(), fifth_window, 50 * SECOND)
        .unwrap();
    use_ref(&mut refs, &again[0], "c1", 5, 61 * SECOND).unwrap();
    // A promoted handle is a counted target for direct issuance too.
    for window in 6..9 {
        let binding = Binding {
            caller: "c1".into(),
            epochs: epochs(),
            identity: identity(window),
            modality: Modality::Pixel,
            capture_id: None,
        };
        refs.issue_target(binding, 62 * SECOND).unwrap();
    }
    let fifth = Binding {
        caller: "c1".into(),
        epochs: epochs(),
        identity: identity(9),
        modality: Modality::Pixel,
        capture_id: None,
    };
    assert_eq!(
        refs.issue_target(fifth, 62 * SECOND),
        Err(RefRefusal::TargetCapacity)
    );
}

#[test]
fn rediscovery_refreshes_a_promoted_target_about_to_expire() {
    let mut refs = References::new("worker-1");
    let ids = refs
        .issue_selections("c1", &epochs(), windows(1), 0)
        .unwrap();
    use_ref(&mut refs, &ids[0], "c1", 1, 0).unwrap();
    // Promoted at 0 s (60 s target TTL); rediscovered at 59 s.
    refs.issue_selections("c1", &epochs(), windows(1), 59 * SECOND)
        .unwrap();
    use_ref(&mut refs, &ids[0], "c1", 1, 70 * SECOND).unwrap();
}

#[test]
fn modality_mismatch_keeps_the_selection_unpromoted() {
    let mut refs = References::new("worker-1");
    let ids = refs
        .issue_selections("c1", &epochs(), windows(1), 0)
        .unwrap();
    let wrong = refs.resolve_target(
        &ids[0],
        "c1",
        &epochs(),
        &identity(1),
        Modality::Accessibility,
        1,
    );
    assert_eq!(wrong.map(|_| ()), Err(RefRefusal::ModalityMismatch));
    // Still a selection: it expires at the 15 s selection TTL.
    assert_eq!(
        use_ref(&mut refs, &ids[0], "c1", 1, 15 * SECOND),
        Err(RefRefusal::TargetStale)
    );
}

#[test]
fn a_changed_window_replaces_its_unpromoted_handle() {
    let mut refs = References::new("worker-1");
    let cap = u64::try_from(MAX_SELECTION_HANDLES_PER_CALLER).unwrap();
    let before = refs
        .issue_selections("c1", &epochs(), windows(cap), 0)
        .unwrap();
    // A display-scale change alters every window: rediscovery still fits.
    let rescaled: Vec<DiscoveredWindow> = windows(cap)
        .into_iter()
        .map(|mut window| {
            window.identity.geometry.4 = 1000;
            window
        })
        .collect();
    let after = refs
        .issue_selections("c1", &epochs(), rescaled.clone(), 1)
        .unwrap();
    assert!(before.iter().all(|id| !after.contains(id)));
    // The drifted handle is gone, not merely stale.
    assert_eq!(
        use_ref(&mut refs, &before[0], "c1", 1, 2),
        Err(RefRefusal::TargetMissing)
    );
    let live = rescaled[0].identity.clone();
    assert!(
        refs.resolve_target(&after[0], "c1", &epochs(), &live, Modality::Pixel, 3)
            .is_ok()
    );
    // Duplicates are counted once against the bound.
    let mut doubled = windows(cap);
    doubled.extend(windows(cap));
    refs.release_caller("c1");
    assert!(refs.issue_selections("c1", &epochs(), doubled, 4).is_ok());
}

#[test]
fn the_selection_table_is_bounded_across_callers() {
    let mut refs = References::new("worker-1");
    let cap = u64::try_from(MAX_SELECTION_HANDLES_PER_CALLER).unwrap();
    for caller in 0..MAX_CALLER_SESSIONS {
        refs.issue_selections(&format!("c{caller}"), &epochs(), windows(cap), 0)
            .unwrap();
    }
    // A caller whose session was never released cannot push past the bound.
    assert_eq!(
        refs.issue_selections("late", &epochs(), windows(1), 1),
        Err(RefRefusal::TargetCapacity)
    );
    refs.release_caller("c0");
    assert!(
        refs.issue_selections("late", &epochs(), windows(1), 2)
            .is_ok()
    );
}

#[test]
fn replacement_spares_promoted_targets_and_other_callers() {
    let mut refs = References::new("worker-1");
    let mine = refs
        .issue_selections("c1", &epochs(), windows(2), 0)
        .unwrap();
    let theirs = refs
        .issue_selections("c2", &epochs(), windows(1), 0)
        .unwrap();
    use_ref(&mut refs, &mine[0], "c1", 1, 1).unwrap();
    // Window 1 and 2 move; c1 rediscovers both.
    let moved: Vec<DiscoveredWindow> = windows(2)
        .into_iter()
        .map(|mut window| {
            window.identity.geometry.0 = 5;
            window
        })
        .collect();
    refs.issue_selections("c1", &epochs(), moved, 2).unwrap();
    // Checked against the old identity: the promoted target still exists
    // (replacement never removes targets; drift makes it stale on use), the
    // unpromoted handle is gone, and c2's handle is untouched.
    use_ref(&mut refs, &mine[0], "c1", 1, 3).unwrap();
    assert_eq!(
        use_ref(&mut refs, &mine[1], "c1", 2, 3),
        Err(RefRefusal::TargetMissing)
    );
    use_ref(&mut refs, &theirs[0], "c2", 1, 3).unwrap();
}
