use super::*;

mod lifecycle;

#[test]
fn windows_password_denial_is_decided_from_methods_only() {
    for denied in [
        "password",
        "keyboard-interactive",
        "password,keyboard-interactive",
        "gssapi-with-mic",
        " keyboard-interactive ",
    ] {
        assert!(requires_unsupported_password(denied), "{denied}");
    }
    for admitted in ["publickey", "publickey,password", "hostbased", ""] {
        assert!(!requires_unsupported_password(admitted), "{admitted}");
    }
}

const START: Duration = Duration::from_secs(10);
const RELEASE: Duration = Duration::from_secs(11);
const COMPLETE: Duration = Duration::from_secs(12);
const DEADLINE: Duration = Duration::from_secs(30);
const TARGET: TargetGeneration<'static> = TargetGeneration {
    target: "destination",
    generation: 7,
};
const NEXT_GENERATION: TargetGeneration<'static> = TargetGeneration {
    generation: 8,
    ..TARGET
};
const BINDING: ProbeBinding<'static> = ProbeBinding {
    target: TARGET,
    child: VerifiedChild::from_verified_identity(42),
};
const QUALIFIED: ProbeQualification = ProbeQualification {
    dedicated_owner_probe: true,
    fresh_connection: true,
    strict_host_verification: true,
    no_master_or_agent_reuse: true,
    password_only_without_fallback: true,
};

fn gate() -> PasswordCacheGate<'static> {
    PasswordCacheGate::start(BINDING, QUALIFIED, START).unwrap()
}

fn release(gate: &mut PasswordCacheGate<'_>, now: Duration) -> bool {
    gate.claim_prompt(TARGET, BINDING, ReleaseRole::DestinationPassword, now)
        && gate.record_release(TARGET, BINDING, ReleaseRole::DestinationPassword, now)
}

fn authenticated(gate: &mut PasswordCacheGate<'_>, now: Duration) -> bool {
    gate.complete(
        TARGET,
        BINDING,
        ProbeOutcome::AuthenticatedProbeCompleted,
        now,
    )
}

#[test]
fn qualifies_once_after_one_release_and_positive_same_child_receipt() {
    let mut gate = gate();
    assert!(release(&mut gate, RELEASE));
    assert!(authenticated(&mut gate, COMPLETE));
    assert!(!authenticated(&mut gate, COMPLETE));
    assert!(!release(&mut gate, COMPLETE));
}

#[test]
fn requires_every_launch_qualification_including_no_method_fallback() {
    for qualification in [
        ProbeQualification {
            dedicated_owner_probe: false,
            ..QUALIFIED
        },
        ProbeQualification {
            fresh_connection: false,
            ..QUALIFIED
        },
        ProbeQualification {
            strict_host_verification: false,
            ..QUALIFIED
        },
        ProbeQualification {
            no_master_or_agent_reuse: false,
            ..QUALIFIED
        },
        // Includes rejected password with an alternate method available and
        // any keyboard-interactive, OTP/MFA or multi-method configuration.
        ProbeQualification {
            password_only_without_fallback: false,
            ..QUALIFIED
        },
    ] {
        assert!(PasswordCacheGate::start(BINDING, qualification, START).is_none());
    }
}

#[test]
fn no_prompt_success_is_not_cacheable_and_cannot_be_followed_by_a_release() {
    let mut gate = gate();
    assert!(!authenticated(&mut gate, RELEASE));
    assert!(!release(&mut gate, COMPLETE));
    assert!(!authenticated(&mut gate, COMPLETE));
}

#[test]
fn rejects_wrong_roles_and_multiple_releases() {
    let mut wrong_role = gate();
    // The adapter classifies keyboard-interactive (including OTP/MFA), trust
    // challenges and inner-hop password events as non-destination roles.
    assert!(!wrong_role.record_release(TARGET, BINDING, ReleaseRole::Other, RELEASE));
    assert!(!release(&mut wrong_role, COMPLETE));
    assert!(!authenticated(&mut wrong_role, COMPLETE));

    let mut repeated = gate();
    assert!(release(&mut repeated, RELEASE));
    assert!(!repeated.record_release(TARGET, BINDING, ReleaseRole::DestinationPassword, COMPLETE));
    assert!(!authenticated(&mut repeated, COMPLETE));
}

#[test]
fn rejects_negative_and_unverified_outcomes_even_after_a_release() {
    for outcome in [
        ProbeOutcome::PasswordRejected,
        ProbeOutcome::PartialAuthentication,
        ProbeOutcome::TransportLost,
        ProbeOutcome::Unverified,
    ] {
        let mut gate = gate();
        assert!(release(&mut gate, RELEASE));
        assert!(!gate.complete(TARGET, BINDING, outcome, COMPLETE));
        assert!(!authenticated(&mut gate, COMPLETE));
    }
}

#[test]
fn rejects_foreign_events_without_consuming_the_bound_probe() {
    for foreign in [
        ProbeBinding {
            child: VerifiedChild::from_verified_identity(43),
            ..BINDING
        },
        ProbeBinding {
            target: TargetGeneration {
                target: "other",
                ..TARGET
            },
            ..BINDING
        },
        ProbeBinding {
            target: TargetGeneration {
                generation: 6,
                ..TARGET
            },
            ..BINDING
        },
    ] {
        let mut gate = gate();
        assert!(!gate.record_release(TARGET, foreign, ReleaseRole::DestinationPassword, RELEASE));
        assert!(release(&mut gate, RELEASE));
        assert!(!gate.complete(
            TARGET,
            foreign,
            ProbeOutcome::AuthenticatedProbeCompleted,
            COMPLETE
        ));
        assert!(authenticated(&mut gate, COMPLETE));
    }
}

#[test]
fn stale_generation_never_qualifies_before_or_after_release() {
    let mut stale_release = gate();
    assert!(!stale_release.record_release(
        NEXT_GENERATION,
        BINDING,
        ReleaseRole::DestinationPassword,
        RELEASE,
    ));
    assert!(!release(&mut stale_release, COMPLETE));

    let mut stale_completion = gate();
    assert!(release(&mut stale_completion, RELEASE));
    assert!(!stale_completion.complete(
        NEXT_GENERATION,
        BINDING,
        ProbeOutcome::AuthenticatedProbeCompleted,
        COMPLETE,
    ));
    assert!(!authenticated(&mut stale_completion, COMPLETE));
}

#[test]
fn deadline_is_exclusive_and_a_release_never_extends_it() {
    let mut unused = gate();
    assert!(!release(&mut unused, DEADLINE));
    assert!(!authenticated(&mut unused, DEADLINE));

    let just_before_deadline = DEADLINE.checked_sub(Duration::from_millis(1)).unwrap();
    let mut released = gate();
    assert!(release(&mut released, just_before_deadline));
    assert!(!authenticated(&mut released, DEADLINE));

    let mut in_time = gate();
    assert!(release(&mut in_time, RELEASE));
    assert!(authenticated(&mut in_time, just_before_deadline));
}

#[test]
fn time_regression_closes_the_gate() {
    let mut before_start = gate();
    let just_before_start = START.checked_sub(Duration::from_millis(1)).unwrap();
    assert!(!release(&mut before_start, just_before_start));
    assert!(!release(&mut before_start, RELEASE));

    let mut before_release = gate();
    assert!(release(&mut before_release, RELEASE));
    assert!(!authenticated(&mut before_release, START));
    assert!(!authenticated(&mut before_release, COMPLETE));
}

#[test]
fn abort_is_final_before_and_after_release() {
    let mut unused = gate();
    unused.abort();
    assert!(!release(&mut unused, RELEASE));

    let mut released = gate();
    assert!(release(&mut released, RELEASE));
    released.abort();
    assert!(!authenticated(&mut released, COMPLETE));
}
