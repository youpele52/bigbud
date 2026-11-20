//! Exhaustive decision table; kernel observation is covered by Linux integration tests.
use super::decide::*;

const CONNECTS: [Connect; 3] = [Connect::Accepted, Connect::Refused, Connect::Unknown];
const CHILDREN: [Child; 3] = [Child::Original, Child::Gone, Child::Unknown];
const HOLDS: [Option<bool>; 3] = [Some(true), Some(false), None];

#[test]
fn gateway_is_live_only_for_the_original_holder_and_gone_only_after_refusal() {
    let mut live = 0;
    let mut gone = 0;
    for child in CHILDREN {
        for holds in HOLDS {
            for connect in CONNECTS {
                let observed = GatewayObservation {
                    child,
                    holds,
                    connect,
                };
                match gateway(observed) {
                    Gateway::Live => {
                        live += 1;
                        assert_eq!(
                            (child, holds, connect),
                            (Child::Original, Some(true), Connect::Accepted)
                        );
                    }
                    Gateway::Gone => {
                        gone += 1;
                        assert_eq!((child, connect), (Child::Gone, Connect::Refused));
                    }
                    Gateway::Uncertain => (),
                }
            }
        }
    }
    assert_eq!((live, gone), (1, 3));
    // A replacement process accepting on the recorded port is never "gone" or "live".
    assert_eq!(
        gateway(GatewayObservation {
            child: Child::Gone,
            holds: None,
            connect: Connect::Accepted,
        }),
        Gateway::Uncertain
    );
    // The original child alive but no longer listening is inconsistent, not a failure.
    assert_eq!(
        gateway(GatewayObservation {
            child: Child::Original,
            holds: Some(false),
            connect: Connect::Refused,
        }),
        Gateway::Uncertain
    );
}

#[test]
fn stale_upstream_is_unlinked_only_for_the_recorded_refusing_inode() {
    assert_eq!(stale(StalePath::Absent), Stale::Clear);
    assert_eq!(stale(StalePath::Recorded(Connect::Refused)), Stale::Unlink);
    for observed in [
        StalePath::Recorded(Connect::Accepted),
        StalePath::Recorded(Connect::Unknown),
        StalePath::Unrecorded,
        StalePath::Unknown,
    ] {
        assert_eq!(stale(observed), Stale::Preserve, "{observed:?}");
    }
}

#[test]
fn attach_requires_an_accepting_socket_listened_on_by_the_controller() {
    assert_eq!(attach(FreshPath::Absent), Attach::Pending);
    let mut attached = 0;
    for connect in CONNECTS {
        for held in HOLDS {
            let result = attach(FreshPath::Sealed { connect, held });
            if result == Attach::Attached {
                attached += 1;
                assert_eq!((connect, held), (Connect::Accepted, Some(true)));
            } else {
                assert_eq!(result, Attach::Uncertain);
            }
        }
    }
    assert_eq!(attached, 1);
    assert_eq!(attach(FreshPath::Unsealed), Attach::Uncertain);
    assert_eq!(attach(FreshPath::Unknown), Attach::Uncertain);
}
