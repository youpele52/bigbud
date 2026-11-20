//! Live `plocate` checks; compiled only on Linux and skipped (with the reason printed) when
//! `plocate` is not installed. `updatedb` runs as root, so fixtures created by a test are not
//! indexed yet; the default check only covers what holds for any database.
//!
//! For an end-to-end escaping check, create these files in `~/Documents`, run `sudo updatedb`,
//! and set `BIGBUD_LIVE_LOCATE_MARKER=bbmarker`:
//! `bbmarker [x] 1.txt`, `bbmarker x 1.txt`, `bbmarker*star.txt`, `bbmarker.pem`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::request::OsIndexRequest;
use super::scope::{OsIndexScopeLevel, resolve_scopes, split_by_scope};
use super::search_names;
use crate::search::StopReason;

fn home_scopes() -> Option<Vec<PathBuf>> {
    if let Err(error) = Command::new("plocate").arg("--version").output() {
        eprintln!("skipping live plocate test: plocate is not runnable ({error})");
        return None;
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("skipping live plocate test: HOME is not set");
        return None;
    };
    let scopes = resolve_scopes(&home, OsIndexScopeLevel::Unrestricted).unwrap();
    if scopes.is_empty() {
        eprintln!("skipping live plocate test: no visible folders in home");
        return None;
    }
    Some(scopes)
}

fn names(query: &str, scopes: &[PathBuf]) -> (Vec<String>, u64) {
    let request = OsIndexRequest::new(query, scopes.to_vec(), 0, Duration::from_secs(5)).unwrap();
    let outcome = search_names(&request, &AtomicBool::new(false)).unwrap();
    let mut names: Vec<String> = outcome
        .hits
        .iter()
        .map(|hit| {
            let name = Path::new(&hit.path).file_name().unwrap();
            name.to_str().unwrap().to_owned()
        })
        .collect();
    names.sort();
    (names, outcome.excluded)
}

#[test]
fn live_plocate_respects_scopes_exclusions_and_cancel() {
    let Some(scopes) = home_scopes() else {
        return;
    };
    let request = OsIndexRequest::new("e", scopes.clone(), 0, Duration::from_secs(3)).unwrap();
    match search_names(&request, &AtomicBool::new(false)) {
        Ok(outcome) => {
            let exclusions = Exclusions::embedded().unwrap();
            for hit in &outcome.hits {
                let path = Path::new(&hit.path);
                let (_, below) = split_by_scope(path, &scopes).unwrap();
                assert!(!exclusions.excludes(path, below));
            }
        }
        Err(error) => {
            assert_eq!(error, OsIndexError::Unavailable);
            eprintln!("plocate database not readable here: {error}");
        }
    }
    let outcome = search_names(&request, &AtomicBool::new(true)).unwrap();
    assert_eq!(outcome.stop, StopReason::Cancelled);
}

#[test]
fn live_plocate_matches_metacharacters_literally() {
    let Some(marker) = std::env::var("BIGBUD_LIVE_LOCATE_MARKER").ok() else {
        eprintln!("skipping live plocate escaping test: BIGBUD_LIVE_LOCATE_MARKER is not set");
        return;
    };
    let Some(scopes) = home_scopes() else {
        return;
    };
    let (all, excluded) = names(&marker, &scopes);
    assert_eq!(
        all,
        [
            format!("{marker} [x] 1.txt"),
            format!("{marker} x 1.txt"),
            format!("{marker}*star.txt")
        ]
    );
    assert_eq!(excluded, 1, "the .pem file is excluded inside the agent");
    // `[x]` is a literal, not a character class matching `x`.
    assert_eq!(
        names(&format!("{marker} [x]"), &scopes).0,
        [format!("{marker} [x] 1.txt")]
    );
    // `*` is a literal, and matching ignores case.
    assert_eq!(
        names(&format!("{}*", marker.to_uppercase()), &scopes).0,
        [format!("{marker}*star.txt")]
    );
    // `?` matches only a literal question mark.
    assert!(names(&format!("{marker}?"), &scopes).0.is_empty());
}
