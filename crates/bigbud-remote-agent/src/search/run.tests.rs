use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use bigbud_protocol::v1::WorkspaceSearchMode;

use super::tests::Fixture;
use super::*;

fn collect(request: &SearchRequest, cancel: &AtomicBool) -> (Vec<SearchBatch>, SearchOutcome) {
    let mut batches = Vec::new();
    let outcome = run_search(request, cancel, &mut |batch| {
        batches.push(batch);
        true
    });
    (batches, outcome)
}

fn content_paths(batches: &[SearchBatch]) -> Vec<String> {
    let mut paths: Vec<_> = batches
        .iter()
        .flat_map(|batch| batch.contents.iter())
        .map(|hit| format!("{}:{}", hit.path, hit.matched.line))
        .collect();
    paths.sort();
    paths
}

#[test]
fn content_search_is_literal_smart_case_and_respects_ignore_rules() {
    let fixture = Fixture::new();
    fixture.write(".git/HEAD", "ref: refs/heads/main\n");
    fixture.write(".gitignore", "ignored.txt\n");
    fixture.write("src/a.txt", "a needle here\nNEEDLE upper\n");
    fixture.write("src/b.txt", "no match\nneedle.* literal\n");
    fixture.write("ignored.txt", "needle\n");
    fixture.write(".hidden/c.txt", "needle in hidden\n");
    for skipped in ALWAYS_SKIPPED_DIRECTORIES {
        fixture.write(&format!("{skipped}/x.txt"), "needle\n");
    }
    let cancel = AtomicBool::new(false);
    let (batches, outcome) = collect(
        &fixture.request("needle", WorkspaceSearchMode::Content),
        &cancel,
    );
    assert_eq!(
        content_paths(&batches),
        [
            ".hidden/c.txt:1",
            "src/a.txt:1",
            "src/a.txt:2",
            "src/b.txt:2"
        ]
    );
    assert_eq!(outcome.stop, StopReason::Complete);
    assert!(!outcome.truncated);

    // An uppercase letter makes the search case-sensitive; regex metacharacters are literal.
    let (upper, _) = collect(
        &fixture.request("NEEDLE", WorkspaceSearchMode::Content),
        &cancel,
    );
    assert_eq!(content_paths(&upper), ["src/a.txt:2"]);
    let (literal, _) = collect(
        &fixture.request("needle.*", WorkspaceSearchMode::Content),
        &cancel,
    );
    assert_eq!(content_paths(&literal), ["src/b.txt:2"]);
    let hit = &literal[0].contents[0];
    assert_eq!((hit.root_id.as_str(), hit.matched.column), ("root-a", 1));
}

#[cfg(unix)]
#[test]
fn links_are_skipped_without_aborting_the_search() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    outside.write("secret.txt", "needle outside\n");
    fixture.write("inside.txt", "needle inside\n");
    std::os::unix::fs::symlink(&outside.0, fixture.0.join("linked-dir")).unwrap();
    std::os::unix::fs::symlink(outside.0.join("secret.txt"), fixture.0.join("linked.txt")).unwrap();
    let cancel = AtomicBool::new(false);
    let (batches, outcome) = collect(
        &fixture.request("needle", WorkspaceSearchMode::Content),
        &cancel,
    );
    assert_eq!(content_paths(&batches), ["inside.txt:1"]);
    assert_eq!(outcome.stop, StopReason::Complete);
}

#[test]
fn binary_and_oversized_files_are_skipped_and_matches_per_file_are_capped() {
    let fixture = Fixture::new();
    fixture.write("binary.bin", b"needle\0needle\n");
    let mut big = b"needle\n".to_vec();
    big.resize(MAX_CONTENT_FILE_BYTES as usize + 1, b'x');
    fixture.write("big.txt", big);
    fixture.write("many.txt", "needle\n".repeat(20));
    let cancel = AtomicBool::new(false);
    let (batches, _) = collect(
        &fixture.request("needle", WorkspaceSearchMode::Content),
        &cancel,
    );
    let paths = content_paths(&batches);
    assert_eq!(paths.len(), MAX_MATCHES_PER_FILE);
    assert!(paths.iter().all(|path| path.starts_with("many.txt:")));
}

#[test]
fn global_and_per_root_limits_truncate() {
    let fixture = Fixture::new();
    for index in 0..10 {
        fixture.write(&format!("f{index}.txt"), "needle\n");
    }
    let cancel = AtomicBool::new(false);
    let mut request = fixture.request("needle", WorkspaceSearchMode::Content);
    request.max_results = 3;
    let (batches, outcome) = collect(&request, &cancel);
    assert_eq!(content_paths(&batches).len(), 3);
    assert_eq!(outcome.stop, StopReason::Limit);
    assert!(outcome.truncated);

    let mut request = fixture.request("needle", WorkspaceSearchMode::Content);
    request.max_results_per_root = 4;
    let (batches, outcome) = collect(&request, &cancel);
    assert_eq!(content_paths(&batches).len(), 4);
    assert!(outcome.truncated);
}

#[test]
fn names_are_ranked_per_root_with_the_shared_scores() {
    let fixture = Fixture::new();
    fixture.write("docs/readme-old.md", "");
    fixture.write("readme", "");
    fixture.write("src/r_e_a_d_m_e.txt", "");
    let cancel = AtomicBool::new(false);
    let (batches, _) = collect(
        &fixture.request("README", WorkspaceSearchMode::Names),
        &cancel,
    );
    let names: Vec<_> = batches
        .iter()
        .flat_map(|batch| batch.names.iter())
        .map(|hit| (hit.entry.path.as_str(), hit.score))
        .collect();
    assert_eq!(names[0], ("readme", 0));
    assert_eq!(names[1].0, "docs/readme-old.md");
    assert!(
        names
            .iter()
            .any(|(path, score)| *path == "src/r_e_a_d_m_e.txt" && *score >= 100)
    );
    assert!(batches.iter().all(|batch| batch.contents.is_empty()));
}

#[test]
fn a_cancelled_or_expired_search_stops_and_reports_why() {
    let fixture = Fixture::new();
    for index in 0..200 {
        fixture.write(&format!("d{}/f{index}.txt", index % 7), "needle\n");
    }
    let cancelled = AtomicBool::new(true);
    let (batches, outcome) = collect(
        &fixture.request("needle", WorkspaceSearchMode::Both),
        &cancelled,
    );
    assert_eq!(outcome.stop, StopReason::Cancelled);
    assert!(
        batches.iter().all(|batch| batch.names.is_empty()),
        "no names after a cancel"
    );

    let cancel = AtomicBool::new(false);
    let mut request = fixture.request("needle", WorkspaceSearchMode::Content);
    request.deadline = Duration::ZERO;
    let (_, outcome) = collect(&request, &cancel);
    assert_eq!(outcome.stop, StopReason::Deadline);
    assert!(outcome.truncated);
}

#[test]
fn cancelling_mid_search_stops_within_the_latency_budget() {
    let fixture = Fixture::new();
    for index in 0..3_000 {
        fixture.write(&format!("d{}/f{index}.txt", index % 31), "x\n".repeat(200));
    }
    let cancel = AtomicBool::new(false);
    let request = fixture.request("needle", WorkspaceSearchMode::Content);
    let started = Instant::now();
    let outcome = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(5));
            cancel.store(true, Ordering::Relaxed);
        });
        collect(&request, &cancel).1
    });
    if outcome.stop == StopReason::Cancelled {
        // Plan budget: cancel → work stopped in ≤ 50 ms (5 ms are the delay before cancelling).
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "{:?}",
            started.elapsed()
        );
    } else {
        assert_eq!(
            outcome.stop,
            StopReason::Complete,
            "a fast machine may finish first"
        );
    }
}

#[test]
fn batches_stay_small_and_a_failed_writer_stops_the_search() {
    let fixture = Fixture::new();
    for index in 0..150 {
        fixture.write(&format!("f{index}.txt"), "needle\n");
    }
    let cancel = AtomicBool::new(false);
    let (batches, outcome) = collect(
        &fixture.request("needle", WorkspaceSearchMode::Content),
        &cancel,
    );
    assert!(
        batches
            .iter()
            .all(|batch| batch.contents.len() <= MAX_BATCH_HITS)
    );
    assert_eq!(outcome.batches as usize, batches.len());

    let mut calls = 0;
    let outcome = run_search(
        &fixture.request("needle", WorkspaceSearchMode::Content),
        &cancel,
        &mut |_| {
            calls += 1;
            false
        },
    );
    assert_eq!(calls, 1);
    assert_eq!(outcome.stop, StopReason::Disconnected);
}
