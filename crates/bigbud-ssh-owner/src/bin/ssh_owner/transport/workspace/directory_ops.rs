use super::{ErrorCode, PATH_WALK, Transport, process, quote, v1, validate_path};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const CREATED: &[u8] = b"BIGBUD_WORKSPACE_ENTRY_V1 created\n";
const ALREADY_EXISTS: &[u8] = b"BIGBUD_WORKSPACE_ENTRY_V1 alreadyExists\n";
const DELETED: &[u8] = b"BIGBUD_WORKSPACE_ENTRY_V1 deleted\n";
const NOT_FOUND: &[u8] = b"BIGBUD_WORKSPACE_ENTRY_V1 notFound\n";
const PATH_DENIED: &[u8] = b"BIGBUD_WORKSPACE_ENTRY_V1 pathDenied\n";
const ACK_LIMIT: usize = 64;

// The shared walk resolves the parent of the requested entry and refuses a
// symlink component. The leaf check repeats that for the entry itself. An error
// after a mutation may have changed the tree, so a missing marker is unknown.
const CREATE_SCRIPT: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
entry=./$3
[ ! -L "$entry" ] || exit 3
if [ -e "$entry" ]; then
  printf 'BIGBUD_WORKSPACE_ENTRY_V1 alreadyExists\n'
  exit 0
fi
mkdir -- "$entry" || exit 1
printf 'BIGBUD_WORKSPACE_ENTRY_V1 created\n'
"#;

const DELETE_SCRIPT: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
entry=./$3
[ ! -L "$entry" ] || exit 3
if [ ! -e "$entry" ]; then
  printf 'BIGBUD_WORKSPACE_ENTRY_V1 notFound\n'
  exit 0
fi
if [ -d "$entry" ]; then
  [ "$4" = directory ] || exit 3
  rm -r -- "$entry" || exit 1
else
  [ "$4" = file ] || exit 3
  rm -- "$entry" || exit 1
fi
printf 'BIGBUD_WORKSPACE_ENTRY_V1 deleted\n'
"#;

pub(in super::super) fn create_directory(
    transport: &Transport,
    operand: &v1::ProofWorkspaceCreateDirectory,
) -> Result<v1::ProofWorkspaceEntryMutation, ErrorCode> {
    let root = validate_path(
        super::root_authority(transport, &operand.workspace_root),
        &operand.workspace_root,
        &operand.relative_path,
        false,
    )?;
    run(
        transport,
        CREATE_SCRIPT,
        root,
        &operand.relative_path,
        "file",
    )
}

pub(in super::super) fn delete_entry(
    transport: &Transport,
    operand: &v1::ProofWorkspaceDeleteEntry,
) -> Result<v1::ProofWorkspaceEntryMutation, ErrorCode> {
    let root = validate_path(
        super::root_authority(transport, &operand.workspace_root),
        &operand.workspace_root,
        &operand.relative_path,
        false,
    )?;
    let kind = if operand.expected_directory {
        "directory"
    } else {
        "file"
    };
    run(transport, DELETE_SCRIPT, root, &operand.relative_path, kind)
}

fn run(
    transport: &Transport,
    script: &str,
    root: &str,
    relative: &str,
    kind: &str,
) -> Result<v1::ProofWorkspaceEntryMutation, ErrorCode> {
    let (parent, leaf) = relative
        .rsplit_once('/')
        .map_or(("", relative), |(parent, leaf)| (parent, leaf));
    let remote = format!(
        "/bin/sh -c {} sh {} {} {} {}",
        quote(&format!("{PATH_WALK}{script}")),
        quote(root),
        quote(parent),
        quote(leaf),
        quote(kind),
    );
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(["--", transport.host(), &remote]);
    let output =
        process::run(pinned.command, Instant::now() + TIMEOUT, ACK_LIMIT).map_err(|error| {
            match error {
                process::Failure::Spawn => ErrorCode::OwnerUnavailable,
                process::Failure::Io | process::Failure::TimedOut => ErrorCode::OutcomeUnknown,
            }
        })?;
    decode(output)
}

fn decode(output: process::Output) -> Result<v1::ProofWorkspaceEntryMutation, ErrorCode> {
    use v1::proof_workspace_entry_mutation::Outcome;
    if output.truncated {
        return Err(ErrorCode::OutcomeUnknown);
    }
    let outcome = match (output.status.code(), output.stdout.as_slice()) {
        (Some(0), CREATED) => Outcome::Created(v1::Empty {}),
        (Some(0), ALREADY_EXISTS) => Outcome::AlreadyExists(v1::Empty {}),
        (Some(0), DELETED) => Outcome::Deleted(v1::Empty {}),
        (Some(0), NOT_FOUND) => Outcome::NotFound(v1::Empty {}),
        (Some(0), PATH_DENIED) | (Some(3), b"") => return Err(ErrorCode::WorkspacePathDenied),
        // SSH's transport error (255), a failed or partial mutation and any
        // missing marker cannot prove the tree is unchanged. Never replay.
        _ => return Err(ErrorCode::OutcomeUnknown),
    };
    Ok(v1::ProofWorkspaceEntryMutation {
        outcome: Some(outcome),
    })
}

#[cfg(test)]
#[test]
fn entry_ack_requires_exact_marker_and_successful_exit() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    let reply = |status, stdout: &[u8], truncated| {
        decode(process::Output {
            status: ExitStatus::from_raw(status << 8),
            stdout: stdout.into(),
            stderr: vec![],
            truncated,
        })
    };
    assert!(matches!(
        reply(0, CREATED, false).expect("confirmed").outcome,
        Some(v1::proof_workspace_entry_mutation::Outcome::Created(_))
    ));
    assert!(matches!(
        reply(0, ALREADY_EXISTS, false).expect("confirmed").outcome,
        Some(v1::proof_workspace_entry_mutation::Outcome::AlreadyExists(
            _
        ))
    ));
    assert!(matches!(
        reply(0, DELETED, false).expect("confirmed").outcome,
        Some(v1::proof_workspace_entry_mutation::Outcome::Deleted(_))
    ));
    for result in [
        reply(0, b"", false),
        reply(255, CREATED, false),
        reply(0, CREATED, true),
        reply(0, &CREATED[..CREATED.len() - 1], false),
        reply(0, b"BIGBUD_WORKSPACE_ENTRY_V1 other\n", false),
    ] {
        assert_eq!(result.unwrap_err(), ErrorCode::OutcomeUnknown);
    }
}

#[cfg(test)]
mod local_tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::process::Command;

    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bigbud-ssh-entry-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        path.canonicalize().unwrap()
    }

    fn run(
        root: &str,
        parent: &str,
        leaf: &str,
        script: &str,
        kind: &str,
    ) -> Result<v1::ProofWorkspaceEntryMutation, ErrorCode> {
        let remote = format!(
            "/bin/sh -c {} sh {} {} {} {}",
            quote(&format!("{PATH_WALK}{script}")),
            quote(root),
            quote(parent),
            quote(leaf),
            quote(kind),
        );
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &remote]);
        let output = process::run(command, Instant::now() + TIMEOUT, ACK_LIMIT)
            .map_err(|_| ErrorCode::OutcomeUnknown)?;
        decode(output)
    }

    #[test]
    fn creates_and_deletes_one_entry_but_refuses_symlinks() {
        let root = fixture();
        let root = root.to_str().unwrap();
        let created = run(root, "", "folder", CREATE_SCRIPT, "file").unwrap();
        assert!(matches!(
            created.outcome,
            Some(v1::proof_workspace_entry_mutation::Outcome::Created(_))
        ));
        assert!(matches!(
            run(root, "", "folder", CREATE_SCRIPT, "file")
                .unwrap()
                .outcome,
            Some(v1::proof_workspace_entry_mutation::Outcome::AlreadyExists(
                _
            ))
        ));
        fs::write(format!("{root}/folder/file.txt"), b"x").unwrap();
        assert!(matches!(
            run(root, "folder", "file.txt", DELETE_SCRIPT, "file")
                .unwrap()
                .outcome,
            Some(v1::proof_workspace_entry_mutation::Outcome::Deleted(_))
        ));
        assert!(!std::path::Path::new(&format!("{root}/folder/file.txt")).exists());
        let outside = format!("{root}/outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, format!("{root}/link")).unwrap();
        assert_eq!(
            run(root, "", "link", DELETE_SCRIPT, "file").unwrap_err(),
            ErrorCode::WorkspacePathDenied
        );
        assert!(std::path::Path::new(&outside).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
