//! `locate` adapter tests with fake programs; they run on any Unix. The live `plocate` checks are
//! in `locate.live.tests.rs`.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::locate::{LocatePrograms, gather_with};
use super::locate_args::locate_args;
use super::request::{OS_INDEX_FETCH_LIMIT, OsIndexRequest};
use super::results::{OsIndexOutcome, finish_hits};
use super::tests::Fixture;
use crate::search::StopReason;

/// `ETXTBSY`: another test thread forked while the script was still open for writing.
const TEXT_FILE_BUSY: i32 = 26;

/// Writes an executable `/bin/sh` fake. The shell is only the fake's implementation; the adapter
/// starts it directly, like the real program.
fn fake(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(
        &path,
        format!("#!/bin/sh\n[ \"$1\" = --bigbud-probe ] && exit 0\n{body}\n"),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    for _ in 0..100 {
        match Command::new(&path).arg("--bigbud-probe").status() {
            Ok(status) if status.success() => return path,
            Err(error) if error.raw_os_error() == Some(TEXT_FILE_BUSY) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            other => panic!("fake {name} cannot run: {other:?}"),
        }
    }
    panic!("fake {name} stayed busy");
}

struct Setup {
    home: Fixture,
    scope: PathBuf,
}

fn setup() -> Setup {
    let home = Fixture::new();
    let scope = home.path().join("Documents");
    fs::create_dir_all(scope.join("taxes")).unwrap();
    fs::create_dir_all(home.path().join("bin")).unwrap();
    Setup { home, scope }
}

fn request(setup: &Setup, query: &str, deadline: Duration) -> OsIndexRequest {
    OsIndexRequest::new(query, vec![setup.scope.clone()], 0, deadline).unwrap()
}

fn search(
    plocate: &Path,
    locate: &Path,
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<OsIndexOutcome, OsIndexError> {
    let programs = LocatePrograms {
        plocate: plocate.as_os_str(),
        locate: locate.as_os_str(),
    };
    let (raw, stop) = gather_with(programs, request, cancel)?;
    Ok(finish_hits(
        request,
        Exclusions::embedded().unwrap(),
        raw,
        stop,
    ))
}

/// A script body printing each path NUL-terminated.
fn print_rows(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| format!("printf '%s\\0' '{}'\n", path.display()))
        .collect()
}

#[test]
fn rows_are_scoped_excluded_checked_on_disk_and_the_query_is_one_argument() {
    let setup = setup();
    let docs = &setup.scope;
    fs::write(docs.join("taxes/report 2026.pdf"), b"12345").unwrap();
    fs::create_dir_all(docs.join("report-folder")).unwrap();
    fs::write(docs.join(".env.report"), b"x").unwrap();
    let rows = [
        docs.join("taxes/report 2026.pdf"),
        docs.join("report-folder"),
        docs.join(".env.report"),
        docs.join("deleted-report.txt"),
        setup.home.path().join("Library/report.pdf"),
        PathBuf::from("/etc/report"),
    ];
    let bin = setup.home.path().join("bin");
    let args_file = bin.join("args");
    let body = format!(
        "printf '%s\\n' \"$@\" > '{}'\n{}",
        args_file.display(),
        print_rows(&rows)
    );
    let plocate = fake(&bin, "plocate", &body);
    let query = "report $(touch x) *";
    let request = request(&setup, query, Duration::from_secs(5));
    let outcome = search(
        &plocate,
        &bin.join("missing"),
        &request,
        &AtomicBool::new(false),
    )
    .unwrap();

    let expected_args: String = locate_args("report $(touch x) *")
        .unwrap()
        .iter()
        .map(|arg| format!("{arg}\n"))
        .collect();
    assert_eq!(fs::read_to_string(&args_file).unwrap(), expected_args);
    assert!(!bin.join("x").exists() && !Path::new("x").exists());
    let returned: Vec<(&str, bool, u64)> = outcome
        .hits
        .iter()
        .map(|hit| (hit.path.as_str(), hit.is_directory, hit.size_bytes))
        .collect();
    let folder = docs.join("report-folder");
    let pdf = docs.join("taxes/report 2026.pdf");
    assert_eq!(
        returned,
        [
            (folder.to_str().unwrap(), true, 0),
            (pdf.to_str().unwrap(), false, 5)
        ]
    );
    assert!(outcome.hits.iter().all(|hit| hit.modified_unix_ms > 0));
    assert_eq!(outcome.excluded, 1);
    assert_eq!(outcome.stop, StopReason::Complete);
}

#[test]
fn enough_rows_stop_and_kill_the_process() {
    let setup = setup();
    for index in 0..OS_INDEX_FETCH_LIMIT + 20 {
        fs::write(setup.scope.join(format!("note-{index}.txt")), b"x").unwrap();
    }
    let bin = setup.home.path().join("bin");
    let body = format!(
        "for f in '{}'/note-*; do printf '%s\\0' \"$f\"; done\nexec sleep 30",
        setup.scope.display()
    );
    let plocate = fake(&bin, "plocate", &body);
    let started = Instant::now();
    let outcome = search(
        &plocate,
        &bin.join("missing"),
        &request(&setup, "note", Duration::from_secs(10)),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "child was not killed"
    );
    assert_eq!(outcome.stop, StopReason::Limit);
    assert!(outcome.truncated);
}

#[test]
fn deadline_and_cancel_kill_a_slow_process() {
    let setup = setup();
    fs::write(setup.scope.join("slow.txt"), b"x").unwrap();
    let bin = setup.home.path().join("bin");
    let body = format!(
        "{}exec sleep 30",
        print_rows(&[setup.scope.join("slow.txt")])
    );
    let plocate = fake(&bin, "plocate", &body);
    let missing = bin.join("missing");

    let started = Instant::now();
    let outcome = search(
        &plocate,
        &missing,
        &request(&setup, "slow", Duration::from_millis(300)),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(outcome.stop, StopReason::Deadline);
    assert_eq!(
        outcome.hits.len(),
        1,
        "rows gathered before the deadline are kept"
    );

    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let outcome = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(100));
            cancel.store(true, Ordering::Relaxed);
        });
        search(
            &plocate,
            &missing,
            &request(&setup, "slow", Duration::from_secs(10)),
            &cancel,
        )
    })
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(outcome.stop, StopReason::Cancelled);
}

#[test]
fn errors_and_missing_programs_are_unavailable_but_no_match_is_not() {
    let setup = setup();
    let bin = setup.home.path().join("bin");
    let missing = bin.join("missing");
    let request = request(&setup, "anything", Duration::from_secs(5));
    let cancel = AtomicBool::new(false);
    let denied = fake(
        &bin,
        "denied",
        "echo '/var/lib/plocate/plocate.db: Permission denied' >&2\nexit 1",
    );
    let no_match = fake(&bin, "no-match", "exit 1");
    let crashed = fake(&bin, "crashed", "kill -9 $$");
    assert_eq!(
        search(&denied, &missing, &request, &cancel),
        Err(OsIndexError::Unavailable)
    );
    assert_eq!(
        search(&crashed, &missing, &request, &cancel),
        Err(OsIndexError::Unavailable)
    );
    let outcome = search(&no_match, &missing, &request, &cancel).unwrap();
    assert!(outcome.hits.is_empty());
    assert_eq!(outcome.stop, StopReason::Complete);
    assert_eq!(
        search(&missing, &missing, &request, &cancel),
        Err(OsIndexError::Unavailable)
    );
}

#[test]
fn a_compatible_locate_is_used_only_when_plocate_is_missing() {
    let setup = setup();
    fs::write(setup.scope.join("fallback.txt"), b"x").unwrap();
    let bin = setup.home.path().join("bin");
    let missing = bin.join("missing");
    let rows = print_rows(&[setup.scope.join("fallback.txt")]);
    let mlocate = fake(
        &bin,
        "mlocate",
        &format!("[ \"$1\" = --version ] && {{ echo 'mlocate 0.26'; exit 0; }}\n{rows}"),
    );
    let unknown = fake(
        &bin,
        "slocate",
        &format!("[ \"$1\" = --version ] && {{ echo 'Secure Locate 3.1'; exit 0; }}\n{rows}"),
    );
    let request = request(&setup, "fallback", Duration::from_secs(5));
    let cancel = AtomicBool::new(false);
    let outcome = search(&missing, &mlocate, &request, &cancel).unwrap();
    assert_eq!(outcome.hits.len(), 1);
    assert_eq!(
        search(&missing, &unknown, &request, &cancel),
        Err(OsIndexError::Unavailable)
    );
}
