use super::HostPolicy;
use super::admission::{
    AdmissionDecision, AdmissionEntry, AdmissionRequest, EvictionCandidate, decide,
};

fn policy(limit: u32) -> HostPolicy {
    HostPolicy {
        lifecycle_enabled: true,
        max_live_ptys: limit,
        ..HostPolicy::default()
    }
}

fn entry(pty_id: &str, last_used_ms: u64) -> AdmissionEntry<'_> {
    AdmissionEntry {
        pty_id,
        managed: true,
        visible: false,
        last_used_ms,
        busy: false,
    }
}

const MANAGED: AdmissionRequest<'static> = AdmissionRequest {
    managed: true,
    evict_pty_id: None,
};

#[test]
fn admits_when_policy_is_off_the_request_is_unmanaged_or_under_the_limit() {
    let live = [entry("a", 1), entry("b", 2)];
    assert_eq!(
        decide(&HostPolicy::default(), &live, MANAGED),
        AdmissionDecision::Admit
    );
    let unmanaged = AdmissionRequest {
        managed: false,
        evict_pty_id: None,
    };
    assert_eq!(
        decide(&policy(2), &live, unmanaged),
        AdmissionDecision::Admit
    );
    assert_eq!(decide(&policy(3), &live, MANAGED), AdmissionDecision::Admit);
    // Unmanaged PTYs do not count toward the limit.
    let mixed = [
        entry("a", 1),
        AdmissionEntry {
            managed: false,
            ..entry("x", 0)
        },
    ];
    assert_eq!(
        decide(&policy(2), &mixed, MANAGED),
        AdmissionDecision::Admit
    );
}

#[test]
fn refuses_at_the_limit_with_the_least_recently_used_hidden_candidate() {
    let live = [
        AdmissionEntry {
            visible: true,
            ..entry("visible", 1)
        },
        AdmissionEntry {
            busy: true,
            ..entry("busy-old", 2)
        },
        entry("newer", 3),
        AdmissionEntry {
            managed: false,
            ..entry("unmanaged", 0)
        },
    ];
    let decision = decide(&policy(3), &live, MANAGED);
    assert_eq!(
        decision,
        AdmissionDecision::Refuse {
            limit: 3,
            live_count: 3,
            candidate: Some(EvictionCandidate {
                pty_id: "busy-old".into(),
                last_used_ms: 2,
                busy: true
            }),
        },
        "busy or not, never visible or unmanaged"
    );
    let all_visible = [AdmissionEntry {
        visible: true,
        ..entry("v", 1)
    }];
    assert!(matches!(
        decide(&policy(1), &all_visible, MANAGED),
        AdmissionDecision::Refuse {
            candidate: None,
            ..
        }
    ));
}

#[test]
fn evicts_only_a_confirmed_candidate_that_is_still_live_managed_and_hidden() {
    let live = [
        entry("a", 1),
        entry("b", 2),
        AdmissionEntry {
            visible: true,
            ..entry("v", 0)
        },
    ];
    let request = |id| AdmissionRequest {
        managed: true,
        evict_pty_id: Some(id),
    };
    assert_eq!(
        decide(&policy(3), &live, request("b")),
        AdmissionDecision::Evict { pty_id: "b".into() }
    );
    for refused in ["v", "gone"] {
        let decision = decide(&policy(3), &live, request(refused));
        let AdmissionDecision::Refuse {
            candidate: Some(candidate),
            ..
        } = decision
        else {
            panic!("{refused} must be refused with a fresh candidate");
        };
        assert_eq!(candidate.pty_id, "a");
    }
    // A lowered limit cannot be met by one eviction.
    assert!(matches!(
        decide(&policy(1), &live, request("a")),
        AdmissionDecision::Refuse { .. }
    ));
}
