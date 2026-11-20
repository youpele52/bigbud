//! Live Windows Search checks; compiled and run only on Windows. Windows Search may be disabled
//! (then the query must report `Unavailable`) and new files may not be indexed yet, so these
//! check the guarantees that hold either way: scope, exclusions, cancel and the deadline.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::request::OsIndexRequest;
use super::scope::{OsIndexScopeLevel, resolve_scopes, split_by_scope};
use super::search_names;
use crate::search::StopReason;

fn profile_request(deadline: Duration) -> Option<OsIndexRequest> {
    let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) else {
        eprintln!("skipping live Windows Search test: USERPROFILE is not set");
        return None;
    };
    let scopes = resolve_scopes(&profile, OsIndexScopeLevel::Unrestricted).unwrap();
    if scopes.is_empty() {
        eprintln!("skipping live Windows Search test: no visible profile folders");
        return None;
    }
    Some(OsIndexRequest::new("e", scopes, 0, deadline).unwrap())
}

#[test]
fn live_windows_search_rows_stay_inside_the_scopes() {
    let Some(request) = profile_request(Duration::from_secs(5)) else {
        return;
    };
    match search_names(&request, &AtomicBool::new(false)) {
        Ok(outcome) => {
            let exclusions = Exclusions::embedded().unwrap();
            for hit in &outcome.hits {
                let path = Path::new(&hit.path);
                let (_, below) = split_by_scope(path, request.scopes()).unwrap();
                assert!(!exclusions.excludes(path, below));
            }
        }
        Err(error) => {
            assert_eq!(error, OsIndexError::Unavailable);
            eprintln!("Windows Search is not available on this machine");
        }
    }
}

#[test]
fn live_windows_search_stops_on_cancel_and_deadline() {
    let Some(request) = profile_request(Duration::from_secs(5)) else {
        return;
    };
    let started = Instant::now();
    let outcome = search_names(&request, &AtomicBool::new(true)).unwrap();
    assert_eq!(outcome.stop, StopReason::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(1));

    let Some(request) = profile_request(Duration::ZERO) else {
        return;
    };
    let outcome = search_names(&request, &AtomicBool::new(false)).unwrap();
    assert_eq!(outcome.stop, StopReason::Deadline);
    assert!(outcome.hits.is_empty());
}
