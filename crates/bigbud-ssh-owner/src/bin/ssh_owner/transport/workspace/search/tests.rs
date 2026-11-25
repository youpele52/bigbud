use super::super::tests::Fixture;
use super::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, ExitStatus};
use std::time::Instant;

fn record(path: &str, text: &str) -> String {
    format!(
        "{}\n",
        json!({"type": "match", "data": {
            "path": {"text": path}, "lines": {"text": text}, "line_number": 7,
            "submatches": [{"start": 2, "end": 4}],
        }})
    )
}

#[test]
fn retains_only_complete_records_and_applies_the_result_limit() {
    let records = record("./.hidden/one", "éAB\r\n") + &record("./two", "  AB\n");
    let root = "/fixture";
    let full = parse(records.as_bytes(), false, root, 2).expect("complete records");
    assert!(!full.truncated);
    assert_eq!(
        full.matches[0],
        ProofWorkspaceMatch {
            path: ".hidden/one".into(),
            line: 7,
            column: Some(3),
            line_text: "éAB".into(),
        }
    );
    let limited = parse(records.as_bytes(), false, root, 1).expect("limited records");
    assert!(limited.truncated);
    assert_eq!(limited.matches, full.matches[..1]);

    let partial = &records.as_bytes()[..records.len() - 1]; // Valid JSON without its terminating LF.
    assert_eq!(parse(partial, true, root, 3), Ok(limited));
    assert_eq!(
        parse(partial, false, root, 3),
        Err(ErrorCode::WorkspaceReadFailed)
    );
    assert_eq!(
        parse(b"not JSON\n", true, root, 3),
        Err(ErrorCode::WorkspaceReadFailed)
    );
}

#[test]
fn rejects_non_workspace_result_paths() {
    for path in [
        "",
        "/etc/passwd",
        "../outside",
        "./src/../outside",
        "./src//double",
        "./C:/host",
        "./src\\outside",
        "./nested/.git/config",
        "./node_modules/x",
    ] {
        assert_eq!(
            parse(record(path, "  AB\n").as_bytes(), false, "/fixture", 1),
            Err(ErrorCode::WorkspaceReadFailed),
            "{path:?}"
        );
    }
}

#[test]
fn rejects_invalid_queries_and_maps_missing_ripgrep() {
    for query in [
        "",
        " ",
        "foo\0bar",
        "foo\nbar",
        "foo\rbar",
        &"x".repeat(257),
    ] {
        assert_eq!(command("/fixture", query), Err(ErrorCode::InvalidOperands));
    }
    let missing = process::Output {
        status: ExitStatus::from_raw(127 << 8),
        stdout: vec![],
        stderr: vec![],
        truncated: false,
    };
    assert_eq!(
        decode(missing, "/fixture", 1),
        Err(ErrorCode::ProofRipgrepUnavailable)
    );
    assert_eq!(ErrorCode::ProofRipgrepUnavailable as i32, 22);
}

fn run_local(root: &str, query: &str) -> Result<ProofWorkspaceContentMatches, ErrorCode> {
    let mut local = Command::new("/bin/sh");
    local.args(["-c", &command(root, query)?]);
    let output = process::run(local, Instant::now() + TIMEOUT, CAPTURE_LIMIT)
        .map_err(|_| ErrorCode::WorkspaceReadFailed)?;
    decode(output, root, 10)
}

#[test]
fn physical_root_is_required_before_ripgrep_lookup() {
    let fixture = Fixture::new();
    let alias = fixture.0.join("alias");
    symlink(fixture.root(), &alias).expect("create linked root");
    assert_eq!(
        run_local(alias.to_str().expect("UTF-8 fixture path"), "needle"),
        Err(ErrorCode::WorkspacePathDenied)
    );
}

#[test]
fn real_ripgrep_uses_literal_arguments_hidden_files_and_legacy_exclusions() {
    let fixture = Fixture::new();
    let query = "--a.b('$(touch SHOULD_NOT_EXIST)";
    let literal = query.to_uppercase();
    fs::write(fixture.0.join(".visible"), format!("é {literal}\r\n"))
        .expect("write hidden fixture");
    fs::write(fixture.0.join("distractor"), literal.replace('.', "X"))
        .expect("write regex distractor");
    fs::write(fixture.0.join(".ignore"), "ignored-by-workspace\n").expect("write ignore rules");
    fs::write(fixture.0.join("ignored-by-workspace"), &literal).expect("write ignored fixture");
    for name in EXCLUDED_DIRECTORIES {
        let directory = fixture.0.join("nested").join(name);
        fs::create_dir_all(&directory).expect("create excluded directory");
        fs::write(directory.join("file"), &literal).expect("write excluded fixture");
    }
    let outside = Fixture::new();
    fs::write(outside.0.join("file"), &literal).expect("write outside fixture");
    symlink(outside.root(), fixture.0.join("linked-directory")).expect("link outside directory");
    symlink(outside.0.join("file"), fixture.0.join("linked-file")).expect("link outside file");
    match run_local(fixture.root(), query) {
        Ok(result) => {
            assert!(!result.truncated);
            assert_eq!(
                result.matches,
                [ProofWorkspaceMatch {
                    path: ".visible".into(),
                    line: 1,
                    column: Some(4),
                    line_text: format!("é {literal}"),
                }]
            );
            fs::remove_file(fixture.0.join(".ignore")).expect("remove regular ignore rules");
            symlink(outside.0.join("file"), fixture.0.join(".ignore"))
                .expect("link an ignore file outside the workspace");
            assert_eq!(
                run_local(fixture.root(), query),
                Err(ErrorCode::WorkspacePathDenied)
            );
        }
        Err(ErrorCode::ProofRipgrepUnavailable) => {
            assert!(
                ![
                    "/usr/bin/rg",
                    "/bin/rg",
                    "/opt/homebrew/bin/rg",
                    "/usr/local/bin/rg"
                ]
                .iter()
                .any(|path| Path::new(path).is_file()),
                "a fixture PATH binary should be searchable"
            );
        }
        Err(error) => panic!("unexpected fixture failure: {error:?}"),
    }
    assert!(!fixture.0.join("SHOULD_NOT_EXIST").exists());
}
