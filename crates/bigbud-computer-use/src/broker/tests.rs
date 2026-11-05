#![allow(clippy::unwrap_used)]
use super::*;
use crate::owner::admission::ledger::{Completion, Lookup, Refusal};
use std::io;

struct Counting {
    calls: usize,
    result: fn() -> Result<Launched, LaunchFailure>,
}
impl LaunchBackend for Counting {
    fn launch(&mut self, _: &BrokerRequest) -> Result<Launched, LaunchFailure> {
        self.calls += 1;
        (self.result)()
    }
}
fn launch() -> BrokerRequest {
    BrokerRequest::LaunchApp {
        app: AppIdentity::from_trusted_inventory("com.example.notes").unwrap(),
        background: false,
    }
}
fn ok() -> Result<Launched, LaunchFailure> {
    Ok(Launched {
        pid: 77,
        creation_identity: "darwin:x:1:2".into(),
    })
}
fn unknown() -> Result<Launched, LaunchFailure> {
    Err(LaunchFailure::Unknown(io::Error::other(
        "timeout after submit",
    )))
}

#[test]
fn duplicate_and_resent_operations_never_launch_twice() {
    let mut broker = Broker::new(
        Counting {
            calls: 0,
            result: ok,
        },
        "broker-1",
    )
    .unwrap();
    let caller = broker.open_caller("thread-1").unwrap();
    let id = ("broker-1", caller.as_str(), "launch.1");
    assert!(matches!(
        broker.submit(id, [1; 32], &launch(), false, 0),
        Ok(BrokerOutcome::Launched(_))
    ));
    assert!(matches!(
        broker.submit(id, [1; 32], &launch(), false, 1),
        Ok(BrokerOutcome::Duplicate(Lookup::ContentFree {
            completion: Completion::Completed,
            ..
        }))
    ));
    assert_eq!(
        broker.submit(id, [2; 32], &launch(), false, 1),
        Err(Refusal::ConflictingDigest)
    );
    assert_eq!(broker.tracked().len(), 1);
    assert_eq!(broker.backend.calls, 1);
}

#[test]
fn cancel_before_submission_is_not_started_and_unknown_is_never_replayed() {
    let mut broker = Broker::new(
        Counting {
            calls: 0,
            result: unknown,
        },
        "broker-1",
    )
    .unwrap();
    let caller = broker.open_caller("thread-1").unwrap();
    let cancelled = broker.submit(("broker-1", &caller, "a.1"), [1; 32], &launch(), true, 0);
    assert_eq!(cancelled, Ok(BrokerOutcome::NotStarted));
    assert_eq!(broker.backend.calls, 0);
    let first = broker.submit(("broker-1", &caller, "b.2"), [1; 32], &launch(), false, 0);
    assert_eq!(first, Ok(BrokerOutcome::Unknown));
    let again = broker.submit(("broker-1", &caller, "b.2"), [1; 32], &launch(), false, 0);
    assert!(matches!(again, Ok(BrokerOutcome::Duplicate(_))));
    assert_eq!(broker.backend.calls, 1);
    // A retired session can never submit again (and its mark is gone).
    broker.retire_caller(&caller).unwrap();
    assert_eq!(
        broker.submit(("broker-1", &caller, "c.3"), [1; 32], &launch(), false, 0),
        Err(Refusal::UnknownCaller)
    );
    assert_eq!(broker.backend.calls, 1);
}

#[test]
fn production_backend_refuses_and_identities_urls_are_strict() {
    let mut broker = Broker::new(UnavailableBackend, "broker-1").unwrap();
    let caller = broker.open_caller("thread-1").unwrap();
    assert_eq!(
        broker.submit(("broker-1", &caller, "a.1"), [1; 32], &launch(), false, 0),
        Ok(BrokerOutcome::NotStarted)
    );
    assert!(AppIdentity::from_trusted_inventory("../Applications/X").is_none());
    assert!(HttpUrl::parse("https://example.com/a?b#c").is_ok());
    assert!(HttpUrl::parse("HTTP://example.com:8080").is_ok());
    for (bad, error) in [
        ("file:///etc/passwd", UrlError::Scheme),
        ("javascript:alert(1)", UrlError::Scheme),
        ("https://user:pw@example.com", UrlError::Credentials),
        ("https:///path", UrlError::Host),
        ("https://exa mple.com", UrlError::Characters),
        ("https://example.com/\n", UrlError::Characters),
    ] {
        assert_eq!(HttpUrl::parse(bad), Err(error), "{bad}");
    }
    assert_eq!(
        HttpUrl::parse(&format!("https://a/{}", "x".repeat(2048))),
        Err(UrlError::Length)
    );
}
