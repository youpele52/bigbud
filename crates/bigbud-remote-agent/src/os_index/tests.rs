use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::predicate::{escape_query_literal, name_predicate};
use super::request::OsIndexRequest;
use super::results::{RawOsIndexHit, finish_hits};
use crate::search::StopReason;

/// A canonical temporary folder, removed on drop.
pub(super) struct Fixture(PathBuf);

impl Fixture {
    pub(super) fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self::new_in(&std::env::temp_dir(), &NEXT)
    }

    pub(super) fn new_in(parent: &Path, next: &AtomicU64) -> Self {
        loop {
            let path = parent.join(format!(
                "bigbud-os-index-{}-{}",
                std::process::id(),
                next.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(super::scope::plain_canonical(&path).unwrap()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create os index fixture: {error}"),
            }
        }
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn escaping_backslashes_every_predicate_metacharacter() {
    assert_eq!(escape_query_literal("report").unwrap(), "report");
    assert_eq!(escape_query_literal(r"a\b").unwrap(), r"a\\b");
    assert_eq!(escape_query_literal(r#"a"b"#).unwrap(), r#"a\"b"#);
    assert_eq!(escape_query_literal("a*b").unwrap(), r"a\*b");
    assert_eq!(escape_query_literal("a?b").unwrap(), r"a\?b");
    assert_eq!(
        escape_query_literal("résumé 2026's").unwrap(),
        "résumé 2026's"
    );
    for control in ["a\0b", "a\nb", "a\rb", "a\tb", "a\u{7f}b", "a\u{85}b"] {
        assert_eq!(
            escape_query_literal(control),
            Err(OsIndexError::ControlCharacter)
        );
    }
}

#[test]
fn predicate_keeps_injection_attempts_inside_one_string() {
    assert_eq!(
        name_predicate("report").unwrap(),
        r#"kMDItemFSName == "*report*"cd"#
    );
    let attack = r#"x"cd || kMDItemFSName == "*"#;
    assert_eq!(
        name_predicate(attack).unwrap(),
        r#"kMDItemFSName == "*x\"cd || kMDItemFSName == \"\**"cd"#
    );
    // Scanning the literal like MDQuery does, the string ends exactly before the `cd` flags.
    for query in [attack, r#"a"b\"c"#, r"trailing\", r#"""""#] {
        let predicate = name_predicate(query).unwrap();
        assert_eq!(
            literal_end(&predicate),
            predicate.len() - r#""cd"#.len(),
            "{predicate}"
        );
    }
}

/// Byte index of the quote that closes the predicate's string literal.
fn literal_end(predicate: &str) -> usize {
    let start = r#"kMDItemFSName == ""#.len();
    let mut escaped = false;
    for (index, character) in predicate
        .char_indices()
        .skip_while(|(index, _)| *index < start)
    {
        match character {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => return index,
            _ => {}
        }
    }
    panic!("unterminated literal in {predicate}");
}

fn row(path: PathBuf, last_used_unix_ms: u64) -> RawOsIndexHit {
    RawOsIndexHit {
        path: path.to_str().unwrap().to_owned(),
        last_used_unix_ms,
        ..RawOsIndexHit::default()
    }
}

fn request(fixture: &Fixture, query: &str, max_results: usize) -> OsIndexRequest {
    fs::create_dir_all(fixture.path().join("Documents")).unwrap();
    OsIndexRequest::new(
        query,
        vec![fixture.path().join("Documents")],
        max_results,
        Duration::from_secs(1),
    )
    .unwrap()
}

#[test]
fn excluded_and_out_of_scope_rows_never_leave_the_module() {
    let fixture = Fixture::new();
    let request = request(&fixture, "report", 50);
    let docs = fixture.path().join("Documents");
    let raw = vec![
        row(docs.join("report.pdf"), 0),
        row(docs.join(".env.report"), 0),
        row(docs.join("keys/report.pem"), 0),
        row(docs.join("secrets/report.txt"), 0),
        row(docs.join(".ssh/report"), 0),
        row(fixture.path().join("Library/report.pdf"), 0),
        row(docs.join("../Library/report.pdf"), 0),
        row(PathBuf::from("report.pdf"), 0),
        row(PathBuf::from("/etc/report"), 0),
        row(docs.join("report.pdf"), 0),
    ];
    let outcome = finish_hits(
        &request,
        Exclusions::embedded().unwrap(),
        raw,
        StopReason::Complete,
    );
    let returned: Vec<&str> = outcome.hits.iter().map(|hit| hit.path.as_str()).collect();
    assert_eq!(returned, [docs.join("report.pdf").to_str().unwrap()]);
    assert_eq!(outcome.excluded, 4);
    assert_eq!(outcome.out_of_scope, 4);
    assert_eq!(outcome.stop, StopReason::Complete);
    assert!(!outcome.truncated);
}

#[test]
fn rows_are_ranked_by_name_then_recency_and_capped() {
    let fixture = Fixture::new();
    let request = request(&fixture, "plan", 4);
    let docs = fixture.path().join("Documents");
    let mut recently_modified = row(docs.join("planz.txt"), 10);
    recently_modified.modified_unix_ms = 9;
    let raw = vec![
        row(docs.join("old/my-plan-notes.txt"), 0),
        row(docs.join("planets.txt"), 10),
        row(docs.join("work/plan"), 0),
        row(docs.join("plans.txt"), 99),
        recently_modified,
        row(docs.join("pläne.txt"), 99),
    ];
    let outcome = finish_hits(
        &request,
        Exclusions::embedded().unwrap(),
        raw,
        StopReason::Complete,
    );
    let names: Vec<&str> = outcome
        .hits
        .iter()
        .map(|hit| Path::new(&hit.path).file_name().unwrap().to_str().unwrap())
        .collect();
    // Exact name first, then prefix matches by last use, then by modification (never by path
    // alone); substring and unranked rows are cut.
    assert_eq!(names, ["plan", "plans.txt", "planz.txt", "planets.txt"]);
    assert_eq!(outcome.hits[0].score, 0);
    assert!(outcome.truncated);
    assert_eq!(outcome.stop, StopReason::Limit);
}

#[test]
fn stop_reasons_other_than_complete_are_kept() {
    let fixture = Fixture::new();
    let request = request(&fixture, "plan", 1);
    let docs = fixture.path().join("Documents");
    for stop in [
        StopReason::Deadline,
        StopReason::Cancelled,
        StopReason::Limit,
    ] {
        let raw = vec![row(docs.join("plan"), 0), row(docs.join("plan2"), 0)];
        let outcome = finish_hits(&request, Exclusions::embedded().unwrap(), raw, stop);
        assert_eq!(outcome.stop, stop);
        assert!(outcome.truncated);
        assert_eq!(outcome.hits.len(), 1);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
#[test]
fn other_platforms_report_unsupported() {
    let fixture = Fixture::new();
    let request = request(&fixture, "plan", 1);
    let cancel = std::sync::atomic::AtomicBool::new(false);
    assert_eq!(
        super::search_names(&request, &cancel),
        Err(OsIndexError::Unsupported)
    );
    assert_eq!(super::OS_INDEX_SOURCE, None);
}
