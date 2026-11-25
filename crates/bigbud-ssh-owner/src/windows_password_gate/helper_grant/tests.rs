use super::*;

const TARGET: TargetGeneration<'static> = TargetGeneration {
    target: "fixture",
    generation: 7,
};
const NEXT: TargetGeneration<'static> = TargetGeneration {
    generation: 8,
    ..TARGET
};
const TOKEN: [u8; 16] = [17; 16];
const CHILD: VerifiedChild = VerifiedChild::from_verified_identity(91);
const OTHER_CHILD: VerifiedChild = VerifiedChild::from_verified_identity(92);
const START: Duration = Duration::from_secs(10);

fn at(ms: u64) -> Duration {
    START + Duration::from_millis(ms)
}

fn grant() -> PasswordHelperGrant<'static> {
    PasswordHelperGrant::with_token(TARGET, START, TOKEN).expect("valid deadline")
}

fn request(ms: u64) -> HelperRequest<'static> {
    HelperRequest {
        token: TOKEN,
        target: TARGET,
        role: ReleaseRole::DestinationPassword,
        received_at: at(ms),
    }
}

fn claimed(until: Duration) -> HelperAdmission<'static> {
    HelperAdmission::Claimed {
        binding: ProbeBinding {
            target: TARGET,
            child: CHILD,
        },
        until,
    }
}

#[test]
fn early_helper_waits_for_binding_and_claims_only_once() {
    let mut grant = grant();
    let request = request(100);
    assert_eq!(
        grant.admit(TARGET, &request, None, at(100)),
        HelperAdmission::WaitForChild { until: at(2100) }
    );
    assert_eq!(
        grant.admit(TARGET, &request, None, at(400)),
        HelperAdmission::WaitForChild { until: at(2100) }
    );
    assert!(grant.bind_child(TARGET, CHILD, at(500)));
    assert!(!grant.bind_child(TARGET, OTHER_CHILD, at(500)));
    assert_eq!(
        grant.admit(TARGET, &request, Some(CHILD), at(2099)),
        claimed(at(2100))
    );
    assert_eq!(
        grant.admit(TARGET, &request, Some(CHILD), at(2099)),
        HelperAdmission::Rejected
    );
}

#[test]
fn foreign_or_unverified_requests_do_not_spend_the_grant() {
    let mut grant = grant();
    assert!(grant.bind_child(TARGET, CHILD, at(100)));
    for foreign in [
        HelperRequest {
            token: [42; 16],
            ..request(110)
        },
        HelperRequest {
            role: ReleaseRole::Other,
            ..request(110)
        },
        HelperRequest {
            target: NEXT,
            ..request(110)
        },
        HelperRequest {
            target: TargetGeneration {
                target: "other",
                ..TARGET
            },
            ..request(110)
        },
        HelperRequest {
            received_at: Duration::ZERO,
            ..request(110)
        },
        request(120), // Cannot arrive after the trusted clock reading.
    ] {
        assert_eq!(
            grant.admit(TARGET, &foreign, Some(CHILD), at(110)),
            HelperAdmission::Rejected
        );
    }
    for proof in [None, Some(OTHER_CHILD)] {
        assert_eq!(
            grant.admit(TARGET, &request(110), proof, at(110)),
            HelperAdmission::Rejected
        );
    }
    assert_eq!(
        grant.admit(TARGET, &request(110), Some(CHILD), at(110)),
        claimed(at(2110))
    );
}

#[test]
fn request_timeout_is_exclusive_and_does_not_spend_the_grant() {
    let mut grant = grant();
    let early = request(100);
    assert_eq!(
        grant.admit(TARGET, &early, None, at(2099)),
        HelperAdmission::WaitForChild { until: at(2100) }
    );
    assert!(grant.bind_child(TARGET, CHILD, at(2100)));
    assert_eq!(
        grant.admit(TARGET, &early, Some(CHILD), at(2100)),
        HelperAdmission::Rejected
    );
    assert_eq!(
        grant.admit(TARGET, &request(2101), Some(CHILD), at(2101)),
        claimed(at(4101))
    );
}

#[test]
fn registration_expiry_caps_wait_and_is_not_extended_by_binding() {
    let mut grant = grant();
    let late = request(19_999);
    assert_eq!(
        grant.admit(TARGET, &late, None, at(19_999)),
        HelperAdmission::WaitForChild { until: at(20_000) }
    );
    assert!(grant.bind_child(TARGET, CHILD, at(19_999)));
    assert_eq!(
        grant.admit(TARGET, &late, Some(CHILD), at(20_000)),
        HelperAdmission::Rejected
    );
    assert!(!grant.bind_child(TARGET, OTHER_CHILD, at(20_001)));
}

#[test]
fn revocation_generation_change_and_clock_regression_close_the_grant() {
    for (live_target, now, explicit_revoke) in [
        (TARGET, at(110), true),
        (NEXT, at(110), false),
        (TARGET, at(99), false),
    ] {
        let mut grant = grant();
        assert!(grant.bind_child(TARGET, CHILD, at(100)));
        if explicit_revoke {
            grant.revoke();
        }
        assert_eq!(
            grant.admit(live_target, &request(100), Some(CHILD), now),
            HelperAdmission::Rejected
        );
        assert_eq!(
            grant.admit(TARGET, &request(100), Some(CHILD), at(110)),
            HelperAdmission::Rejected
        );
    }
}

#[test]
fn registration_deadline_overflow_is_rejected() {
    assert!(PasswordHelperGrant::with_token(TARGET, Duration::MAX, TOKEN).is_none());
}

#[cfg(windows)]
#[test]
fn native_registration_returns_the_token_it_installed() {
    let (mut grant, token) = PasswordHelperGrant::register(TARGET, START).expect("system RNG");
    let (_, foreign_token) = PasswordHelperGrant::register(TARGET, START).expect("system RNG");
    assert_ne!(token, foreign_token);
    assert!(grant.bind_child(TARGET, CHILD, START));
    assert_eq!(
        grant.admit(
            TARGET,
            &HelperRequest {
                token,
                ..request(0)
            },
            Some(CHILD),
            START,
        ),
        claimed(at(2000))
    );
}
