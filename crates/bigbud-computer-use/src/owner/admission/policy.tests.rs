#![allow(clippy::unwrap_used)]
use super::{
    policy::*,
    policy_canonical::{CanonicalPolicy, CanonicalRefusal, Delivery},
};

/// Canonical bytes plus their real digest for `authority`/`revision`.
fn sealed(authority: &str, revision: u64, enabled: bool) -> (Vec<u8>, [u8; 32]) {
    let bytes = CanonicalPolicy {
        authority: authority.into(),
        revision,
        enabled,
        delivery: Delivery::Foreground,
        check_in_ms: 600_000,
        action_timeout_ms: 900_000,
        diagnostics: false,
        disallowed: Vec::new(),
    }
    .encode();
    let digest = crate::sha256::sha256(&bytes);
    (bytes, digest)
}

#[test]
fn duplicate_is_idempotent_conflicts_and_stale_revisions_refuse() {
    let mut policy = PolicyProjection::new("authority-1", "fence-1").unwrap();
    let (r41, d41) = sealed("authority-1", 41, true);
    let (r41b, d41b) = sealed("authority-1", 41, false);
    let (r40, d40) = sealed("authority-1", 40, true);
    let (r42, d42) = sealed("authority-1", 42, true);
    let apply = |policy: &mut PolicyProjection, revision: &str, digest, bytes: &[u8]| {
        policy.apply("authority-1", "fence-1", revision, digest, bytes)
    };
    assert_eq!(apply(&mut policy, "41", d41, &r41), Ok(Applied::New(41)));
    assert_eq!(
        apply(&mut policy, "41", d41, &r41),
        Ok(Applied::Idempotent(41))
    );
    assert_eq!(
        apply(&mut policy, "41", d41b, &r41b),
        Err(PolicyRefusal::ConflictingDigest)
    );
    assert_eq!(
        apply(&mut policy, "40", d40, &r40),
        Err(PolicyRefusal::StaleRevision)
    );
    assert_eq!(apply(&mut policy, "42", d42, &r42), Ok(Applied::New(42)));
    assert_eq!(policy.applied_revision(), Some(42));
    let (other, other_digest) = sealed("authority-2", 43, true);
    assert_eq!(
        policy.apply("authority-2", "fence-1", "43", other_digest, &other),
        Err(PolicyRefusal::AuthorityMismatch)
    );
    assert_eq!(
        policy.apply("authority-1", "fence-0", "43", d42, &r42),
        Err(PolicyRefusal::FenceMismatch)
    );
    assert_eq!(
        apply(&mut policy, "43", d42, &[]),
        Err(PolicyRefusal::Oversized)
    );
    assert_eq!(
        apply(&mut policy, "43", d42, &vec![b'x'; 64 * 1024 + 1]),
        Err(PolicyRefusal::Oversized)
    );
}

#[test]
fn canonical_bytes_must_verify_and_match_the_request() {
    let mut policy = PolicyProjection::new("authority-1", "fence-1").unwrap();
    let (bytes, digest) = sealed("authority-1", 7, true);
    // Body names a different authority than the authenticated request.
    let (foreign, foreign_digest) = sealed("authority-2", 7, true);
    assert_eq!(
        policy.apply("authority-1", "fence-1", "7", foreign_digest, &foreign),
        Err(PolicyRefusal::AuthorityMismatch)
    );
    assert_eq!(
        policy.apply("authority-1", "fence-1", "8", digest, &bytes),
        Err(PolicyRefusal::InvalidRevision)
    );
    let mut tampered = digest;
    tampered[31] ^= 0x80;
    assert_eq!(
        policy.apply("authority-1", "fence-1", "7", tampered, &bytes),
        Err(PolicyRefusal::Canonical(CanonicalRefusal::DigestMismatch))
    );
    assert_eq!(
        policy.apply("authority-1", "fence-1", "7", digest, b"not canonical\n"),
        Err(PolicyRefusal::Canonical(CanonicalRefusal::Malformed))
    );
    assert_eq!(policy.applied_revision(), None);
    assert_eq!(
        policy.apply("authority-1", "fence-1", "7", digest, &bytes),
        Ok(Applied::New(7))
    );
}

#[test]
fn revision_text_is_canonical_decimal() {
    assert_eq!(parse_revision("0"), Some(0));
    assert_eq!(parse_revision("18446744073709551615"), Some(u64::MAX));
    for bad in [
        "",
        "01",
        "-1",
        "+1",
        "1.0",
        " 1",
        "18446744073709551616",
        "abc",
    ] {
        assert_eq!(parse_revision(bad), None, "{bad}");
    }
}

/// The digest is recomputed on every target; it can never be skipped.
#[test]
fn apply_recomputes_the_digest_and_refuses_a_forged_one() {
    let mut policy = PolicyProjection::new("authority-1", "fence-1").unwrap();
    let bytes = CanonicalPolicy {
        authority: "authority-1".into(),
        revision: 1,
        enabled: false,
        delivery: Delivery::Foreground,
        check_in_ms: 600_000,
        action_timeout_ms: 900_000,
        diagnostics: false,
        disallowed: Vec::new(),
    }
    .encode();
    assert_eq!(
        policy.apply("authority-1", "fence-1", "1", [0; 32], &bytes),
        Err(PolicyRefusal::Canonical(CanonicalRefusal::DigestMismatch))
    );
    assert_eq!(policy.applied_revision(), None);
}

#[test]
fn only_the_applied_revision_and_digest_are_durably_acknowledged() {
    use crate::guard::record::SafetyRecord;
    use crate::guard::{Acknowledged, GuardFence, SafetySink, TransitionError};
    struct Sink;
    impl SafetySink for Sink {
        type Error = ();
        fn persist(&mut self, _: &SafetyRecord) -> Result<(), ()> {
            Ok(())
        }
    }
    let settled = SafetyRecord {
        roots: vec![],
        ..crate::guard::test_support::armed()
    };
    let mut fence = GuardFence::from_recovered(settled, Sink).unwrap();
    // The projection's fence is the lease's revision namespace.
    let mut projection = PolicyProjection::new("authority-1", "profile-1").unwrap();
    let mut stale = PolicyProjection::new("authority-1", "profile-0").unwrap();
    let (bytes, digest) = sealed("authority-1", 43, true);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let binding = |revision: &str, digest: &str| crate::guard::record::PolicyBinding {
        revision: revision.into(),
        digest: digest.into(),
        ..crate::guard::test_support::armed().binding.unwrap()
    };
    // Not applied yet: nothing to acknowledge.
    assert!(matches!(
        acknowledge_applied(&mut fence, &projection, binding("43", &hex)),
        Err(TransitionError::Refused(_))
    ));
    projection
        .apply("authority-1", "profile-1", "43", digest, &bytes)
        .unwrap();
    stale
        .apply("authority-1", "profile-0", "43", digest, &bytes)
        .unwrap();
    // A projection from another (e.g. pre-takeover) namespace cannot ack.
    assert!(matches!(
        acknowledge_applied(&mut fence, &stale, binding("43", &hex)),
        Err(TransitionError::Refused(_))
    ));
    assert!(matches!(
        acknowledge_applied(&mut fence, &projection, binding("43", &"b".repeat(64))),
        Err(TransitionError::Refused(_))
    ));
    assert!(matches!(
        acknowledge_applied(&mut fence, &projection, binding("44", &hex)),
        Err(TransitionError::Refused(_))
    ));
    assert_eq!(
        acknowledge_applied(&mut fence, &projection, binding("43", &hex)).unwrap(),
        Acknowledged::New(43)
    );
    assert_eq!(fence.record().binding.as_ref().unwrap().digest, hex);
}

#[test]
fn revision_zero_is_never_an_applied_policy() {
    let mut policy = PolicyProjection::new("authority-1", "fence-1").unwrap();
    let (bytes, digest) = sealed("authority-1", 0, true);
    assert_eq!(
        policy.apply("authority-1", "fence-1", "0", digest, &bytes),
        Err(PolicyRefusal::InvalidRevision)
    );
    assert_eq!(policy.applied_revision(), None);
}
