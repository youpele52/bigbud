//! Live Spotlight check against a folder this test creates. Spotlight may be off, may not index
//! the build folder, or may lag behind; then the test says so and skips the "found" assertion.
//! The safety assertions (scope, exclusions, cancel, deadline) always run.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::request::OsIndexRequest;
use super::search_names;
use super::tests::Fixture;
use crate::search::StopReason;

/// How long to wait for Spotlight to index the new files.
const INDEX_WAIT: Duration = Duration::from_secs(5);

/// Spotlight skips the system temp folder, so the fixture lives next to the test binary
/// (`target/<profile>/`), which a developer machine normally indexes.
fn indexed_fixture() -> Fixture {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let exe = std::env::current_exe().unwrap();
    let profile_dir = exe.parent().and_then(Path::parent).unwrap();
    Fixture::new_in(profile_dir, &NEXT)
}

fn search(scope: &Path, query: &str, deadline: Duration, cancel: &AtomicBool) -> Vec<String> {
    let request = OsIndexRequest::new(query, vec![scope.to_path_buf()], 0, deadline).unwrap();
    let outcome = search_names(&request, cancel).expect("Spotlight query starts");
    // Spotlight itself honours the scope; the module's own containment check is the backstop.
    assert_eq!(
        outcome.out_of_scope, 0,
        "Spotlight returned rows outside the scope"
    );
    for hit in &outcome.hits {
        assert!(
            Path::new(&hit.path).starts_with(scope),
            "row outside the scope"
        );
    }
    outcome.hits.into_iter().map(|hit| hit.path).collect()
}

#[test]
fn live_spotlight_name_query_respects_scope_and_exclusions() {
    let fixture = indexed_fixture();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let marker = format!("bigbudprobe{unique}");
    let visible = fixture.path().join(format!("{marker}.txt"));
    let hidden = [
        fixture.path().join(format!(".env.{marker}")),
        fixture.path().join(format!("id_{marker}")),
        fixture.path().join(format!("{marker}.pem")),
    ];
    for path in hidden.iter().chain([&visible]) {
        fs::write(path, b"bigbud os index probe").unwrap();
    }
    // Ask Spotlight to import now instead of waiting for the next scan; failure only slows it.
    let imported = Command::new("/usr/bin/mdimport")
        .arg(fixture.path())
        .output()
        .is_ok_and(|output| output.status.success());

    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let mut found = Vec::new();
    while started.elapsed() < INDEX_WAIT {
        found = search(fixture.path(), &marker, Duration::from_secs(2), &cancel);
        if !found.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    for path in &hidden {
        assert!(
            !found.contains(&path.to_str().unwrap().to_owned()),
            "excluded file returned"
        );
    }
    if found.is_empty() {
        eprintln!(
            "skipped found-assertion: Spotlight returned nothing for the probe folder within \
             {INDEX_WAIT:?} (indexing off, folder not indexed, or sandboxed; mdimport ok: {imported})"
        );
    } else {
        assert_eq!(found, [visible.to_str().unwrap().to_owned()]);
    }

    // Files indexed long ago (this crate's manifest) prove the query path end to end even when
    // freshly written files are not indexed yet.
    let crate_dir = fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
    let manifest = crate_dir.join("Cargo.toml").to_str().unwrap().to_owned();
    let crate_hits = search(&crate_dir, "cargo.TOML", Duration::from_secs(5), &cancel);
    if crate_hits.is_empty() {
        eprintln!(
            "skipped indexed-file assertion: Spotlight returned nothing for this crate folder"
        );
    } else {
        assert_eq!(
            crate_hits.first(),
            Some(&manifest),
            "exact name ranks first"
        );
    }

    // Injection attempts stay literal: unescaped, this query would match every indexed file in
    // the crate folder; escaped, it matches nothing.
    let injected = format!(r#"{marker}"cd || kMDItemFSName == "*"#);
    assert!(search(&crate_dir, &injected, Duration::from_secs(2), &cancel).is_empty());

    // A pre-set cancel flag and a zero deadline both stop without waiting for Spotlight.
    let request = OsIndexRequest::new(
        &marker,
        vec![fixture.path().to_path_buf()],
        0,
        Duration::from_secs(5),
    )
    .unwrap();
    let cancelled = AtomicBool::new(true);
    let started = Instant::now();
    let outcome = search_names(&request, &cancelled).unwrap();
    assert_eq!(outcome.stop, StopReason::Cancelled);
    assert!(started.elapsed() < Duration::from_millis(500));
    let request = OsIndexRequest::new(
        &marker,
        vec![fixture.path().to_path_buf()],
        0,
        Duration::ZERO,
    )
    .unwrap();
    let outcome = search_names(&request, &cancel).unwrap();
    assert!(matches!(
        outcome.stop,
        StopReason::Deadline | StopReason::Complete
    ));
}
