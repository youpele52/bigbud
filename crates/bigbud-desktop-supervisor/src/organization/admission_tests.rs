use super::super::protocol::{policy::v1::Policy, v1::Hello};
use super::*;

fn limits() -> Limits {
    Limits {
        frame_bytes: 1_048_576,
        page_rows: 256,
        live_rows: 100_000,
        state_bytes: 64 * 1024 * 1024,
        pending_facts: 2_000,
        pending_bytes: 8 * 1024 * 1024,
    }
}
fn row(id: &str, version: u64) -> ThreadFacts {
    ThreadFacts {
        thread_id: id.into(),
        fact_version: version,
        section: 2,
        work: 3,
        eligible: true,
        inactivity_at_ms: Some(0),
        ..Default::default()
    }
}
fn frame(payload: Payload) -> Frame {
    Frame {
        backend_nonce: "backend".into(),
        generation: 7,
        payload: Some(payload),
    }
}
fn send(state: &mut CompactState, payload: Payload) -> Result<Admission, AdmissionError> {
    state.admit(&frame(payload).encode_to_vec())
}
fn hello(state: &mut CompactState, limits: Limits) {
    assert_eq!(
        send(
            state,
            Payload::Hello(Hello {
                major: 1,
                minor: 0,
                capability: "compact-facts-v1".into(),
                limits: Some(limits)
            })
        ),
        Ok(Admission::Negotiated)
    );
}
fn begin() -> Payload {
    Payload::Begin(SnapshotBegin {
        snapshot_id: "snapshot".into(),
        sequence: 10,
        source_frontier: 100,
        policy: Some(Policy {
            scheduling: None,
            version: 2,
            fingerprint: "policy".into(),
            older_policy_changed_at_ms: Some(0),
        }),
    })
}
fn page(rows: Vec<ThreadFacts>) -> Payload {
    Payload::Page(SnapshotPage {
        snapshot_id: "snapshot".into(),
        index: 0,
        rows,
    })
}
fn end(rows: &[ThreadFacts]) -> Payload {
    let mut digest = Sha256::new();
    for row in rows {
        let encoded = row.encode_to_vec();
        digest.update((encoded.len() as u32).to_be_bytes());
        digest.update(encoded);
    }
    Payload::End(SnapshotEnd {
        snapshot_id: "snapshot".into(),
        pages: u32::from(!rows.is_empty()),
        rows: rows.len() as u32,
        digest: digest.finalize().to_vec(),
        policy_version: 2,
    })
}
fn fact(sequence: u64, version: u64) -> Payload {
    Payload::Fact(Fact {
        sequence,
        source_frontier: 101,
        row: Some(row("a", version)),
        deleted: false,
    })
}
fn staging(limits: Limits) -> CompactState {
    let mut state = CompactState::new("backend".into(), 7);
    hello(&mut state, limits);
    assert_eq!(send(&mut state, begin()), Ok(Admission::Staged));
    state
}
fn active() -> CompactState {
    let mut state = staging(limits());
    assert!(send(&mut state, page(vec![row("a", 1)])).is_ok());
    assert_eq!(
        send(&mut state, end(&[row("a", 1)])),
        Ok(Admission::Activated)
    );
    state
}

#[test]
fn snapshot_is_hidden_until_digest_and_buffered_suffix_validate() {
    let mut state = staging(limits());
    assert!(send(&mut state, page(vec![row("a", 1)])).is_ok());
    assert_eq!(send(&mut state, fact(11, 2)), Ok(Admission::Staged));
    assert_eq!(send(&mut state, fact(11, 2)), Ok(Admission::Duplicate));
    assert!(state.rows().is_none());
    assert_eq!(
        send(&mut state, end(&[row("a", 1)])),
        Ok(Admission::Activated)
    );
    assert_eq!(state.rows().unwrap().next().unwrap().fact_version, 2);
    assert_eq!(state.frontier(), Some((11, 101, 2)));
    assert_eq!(state.policy().unwrap().older_policy_changed_at_ms, Some(0));
}

#[test]
fn ordered_suffix_preserves_attention_manual_and_snooze_transitions() {
    let mut state = active();
    let mut attention = row("a", 2);
    attention.actionable = true;
    attention.attention_watermark = 1;
    attention.snooze_until_ms = Some(500);
    attention.snooze_identity = "snooze".into();
    let first = Payload::Fact(Fact {
        sequence: 11,
        source_frontier: 102,
        row: Some(attention.clone()),
        deleted: false,
    });
    assert_eq!(send(&mut state, first.clone()), Ok(Admission::Applied));
    let mut manual = attention;
    manual.fact_version = 3;
    manual.manual_until_ms = Some(600);
    manual.snooze_until_ms = None;
    manual.snooze_identity.clear();
    assert!(
        send(
            &mut state,
            Payload::Fact(Fact {
                sequence: 12,
                source_frontier: 102,
                row: Some(manual.clone()),
                deleted: false
            })
        )
        .is_ok()
    );
    assert_eq!(send(&mut state, first), Ok(Admission::Duplicate));
    assert_eq!(state.rows().unwrap().next(), Some(&manual));
}

#[test]
fn conflicts_gaps_regressions_and_stale_versions_fence_until_new_generation() {
    for invalid in [
        fact(12, 2),
        fact(11, 1),
        Payload::Fact(Fact {
            sequence: 11,
            source_frontier: 99,
            row: Some(row("a", 2)),
            deleted: false,
        }),
    ] {
        let mut state = active();
        assert_eq!(send(&mut state, invalid), Err(AdmissionError::Resync));
        assert!(state.rows().is_none());
        assert_eq!(send(&mut state, begin()), Err(AdmissionError::Resync));
    }
    let mut state = active();
    assert!(send(&mut state, fact(11, 2)).is_ok());
    assert_eq!(send(&mut state, fact(11, 3)), Err(AdmissionError::Resync));
    let mut stale = frame(fact(11, 2));
    stale.generation = 6;
    assert_eq!(
        active().admit(&stale.encode_to_vec()),
        Err(AdmissionError::Resync)
    );
    stale.generation = 7;
    stale.backend_nonce = "old".into();
    assert_eq!(
        active().admit(&stale.encode_to_vec()),
        Err(AdmissionError::Resync)
    );
}

#[test]
fn invalid_snapshot_never_activates() {
    for invalid in [
        page(vec![row("b", 1), row("a", 1)]),
        page(vec![row("a", 1), row("a", 2)]),
        end(&[row("a", 1)]),
    ] {
        let mut state = staging(limits());
        assert_eq!(send(&mut state, invalid), Err(AdmissionError::Resync));
        assert!(state.frontier().is_none());
    }
    let mut state = staging(limits());
    assert!(send(&mut state, page(vec![row("a", 1)])).is_ok());
    let Payload::End(mut invalid) = end(&[row("a", 1)]) else {
        panic!()
    };
    invalid.digest[0] ^= 1;
    assert_eq!(
        send(&mut state, Payload::End(invalid)),
        Err(AdmissionError::Resync)
    );
    let mut state = staging(limits());
    assert!(send(&mut state, page(vec![row("a", 1)])).is_ok());
    assert!(send(&mut state, fact(11, 1)).is_ok());
    assert_eq!(
        send(&mut state, end(&[row("a", 1)])),
        Err(AdmissionError::Resync)
    );
    assert!(state.rows().is_none());
}

#[test]
fn bounds_fail_closed_and_tombstones_prevent_resurrection() {
    let small = Limits {
        pending_facts: 1,
        ..limits()
    };
    let mut state = staging(small);
    assert!(send(&mut state, fact(11, 2)).is_ok());
    assert_eq!(send(&mut state, fact(12, 3)), Err(AdmissionError::Capacity));
    let mut state = staging(Limits {
        pending_bytes: 1,
        ..limits()
    });
    assert_eq!(send(&mut state, fact(11, 2)), Err(AdmissionError::Capacity));
    let mut state = staging(Limits {
        live_rows: 1,
        ..limits()
    });
    assert_eq!(
        send(&mut state, page(vec![row("a", 1), row("b", 1)])),
        Err(AdmissionError::Capacity)
    );
    let mut state = staging(Limits {
        state_bytes: 1,
        ..limits()
    });
    assert_eq!(
        send(&mut state, page(vec![row("a", 1)])),
        Err(AdmissionError::Capacity)
    );
    let mut state = active();
    let Payload::Fact(mut deleted) = fact(11, 2) else {
        panic!()
    };
    deleted.deleted = true;
    assert!(send(&mut state, Payload::Fact(deleted)).is_ok());
    assert_eq!(state.rows().unwrap().count(), 0);
    assert_eq!(send(&mut state, fact(12, 2)), Err(AdmissionError::Resync));
}

#[test]
fn empty_snapshots_optional_zero_and_bounded_duplicate_retention() {
    let mut state = staging(limits());
    assert_eq!(send(&mut state, end(&[])), Ok(Admission::Activated));
    assert_eq!(state.rows().unwrap().count(), 0);
    let mut state = staging(Limits {
        pending_facts: 1,
        ..limits()
    });
    assert!(send(&mut state, end(&[])).is_ok());
    assert!(send(&mut state, fact(11, 1)).is_ok());
    assert_eq!(
        state.rows().unwrap().next().unwrap().inactivity_at_ms,
        Some(0)
    );
    assert!(send(&mut state, fact(12, 2)).is_ok());
    assert_eq!(send(&mut state, fact(11, 1)), Err(AdmissionError::Resync));
}

#[test]
fn snapshot_identity_page_policy_and_version_regressions_require_resync() {
    let cases = [
        Payload::Page(SnapshotPage {
            snapshot_id: "wrong".into(),
            index: 0,
            rows: vec![row("a", 1)],
        }),
        Payload::Page(SnapshotPage {
            snapshot_id: "snapshot".into(),
            index: 1,
            rows: vec![row("a", 1)],
        }),
    ];
    for invalid in cases {
        assert_eq!(
            send(&mut staging(limits()), invalid),
            Err(AdmissionError::Resync)
        );
    }
    let mut state = staging(limits());
    assert!(send(&mut state, page(vec![row("a", 1)])).is_ok());
    let Payload::End(mut invalid) = end(&[row("a", 1)]) else {
        panic!()
    };
    invalid.policy_version = 3;
    assert_eq!(
        send(&mut state, Payload::End(invalid)),
        Err(AdmissionError::Resync)
    );
    let mut state = active();
    let mut newer = row("a", 2);
    newer.organization_revision = 2;
    newer.attention_watermark = 10;
    assert!(
        send(
            &mut state,
            Payload::Fact(Fact {
                sequence: 11,
                source_frontier: 101,
                row: Some(newer),
                deleted: false
            })
        )
        .is_ok()
    );
    assert_eq!(send(&mut state, fact(12, 3)), Err(AdmissionError::Resync));
}

#[test]
fn malformed_oversized_unnegotiated_and_unknown_facts_are_rejected() {
    let mut state = active();
    assert_eq!(
        state.admit(&vec![0; MAX_FRAME_BYTES + 1]),
        Err(AdmissionError::Capacity)
    );
    for bytes in [vec![], vec![0xff], vec![0x0a, 0xff]] {
        assert!(
            CompactState::new("backend".into(), 7)
                .admit(&bytes)
                .is_err()
        );
    }
    assert_eq!(
        send(&mut CompactState::new("backend".into(), 7), begin()),
        Err(AdmissionError::Resync)
    );
    let invalid_rows = [
        ThreadFacts {
            work: 0,
            ..row("a", 2)
        },
        ThreadFacts {
            fact_version: MAX_SAFE_UINT + 1,
            ..row("a", 2)
        },
        ThreadFacts {
            snooze_until_ms: Some(0),
            ..row("a", 2)
        },
    ];
    for invalid in invalid_rows {
        assert_eq!(
            send(&mut staging(limits()), page(vec![invalid])),
            Err(AdmissionError::Resync)
        );
    }
}
