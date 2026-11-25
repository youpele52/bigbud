use super::super::DEADLINE;
use super::{
    ErrorCode, Transport, process, run, ssh_failure, v1, validate_path, workspace_command,
};

const CAPTURE_LIMIT: usize = 4 * 1024 * 1024;
const MARKER: &[u8] = b"BIGBUD_WORKSPACE_DIRECTORY_V1\0";

// The three disjoint POSIX glob patterns cover immediate children, including
// hidden entries, but never `.` or `..`. Changing into the verified directory
// keeps enumeration relative to that directory rather than reopening its path.
const SCRIPT: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
[ -r . ] && [ -x . ] || exit 3
printf 'BIGBUD_WORKSPACE_DIRECTORY_V1\000' || exit 1
for entry in ./* ./.[!.]* ./..?*; do
  [ ! -L "$entry" ] || continue
  if [ -d "$entry" ]; then kind=d
  elif [ -f "$entry" ]; then kind=f
  else continue
  fi
  printf '%s\t%s\000' "$kind" "${entry#./}" || exit 1
done
"#;

pub(in super::super) fn list(
    transport: &Transport,
    operand: &v1::ProofWorkspaceList,
) -> Result<v1::ProofWorkspaceDirectory, ErrorCode> {
    let root = validate_path(
        transport.config.workspace_root.as_deref(),
        &operand.workspace_root,
        &operand.relative_dir,
        true,
    )?;
    let remote = workspace_command(SCRIPT, root, &operand.relative_dir);
    decode(run(transport, &remote, DEADLINE, CAPTURE_LIMIT)?)
}

fn decode(output: process::Output) -> Result<v1::ProofWorkspaceDirectory, ErrorCode> {
    match output.status.code() {
        Some(0) => parse(&output.stdout, output.truncated),
        Some(3) => Err(ErrorCode::WorkspacePathDenied),
        Some(255) => Err(ssh_failure(&output.stderr)),
        None => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}

fn parse(bytes: &[u8], truncated: bool) -> Result<v1::ProofWorkspaceDirectory, ErrorCode> {
    let failed = ErrorCode::WorkspaceReadFailed;
    let payload = bytes.strip_prefix(MARKER).ok_or(failed)?;
    let mut entries = Vec::new();
    for raw in payload.split_inclusive(|&byte| byte == 0) {
        let Some(record) = raw.strip_suffix(b"\0") else {
            if truncated {
                break;
            }
            return Err(failed);
        };
        let (directory, name) = match record {
            [b'd', b'\t', name @ ..] => (true, name),
            [b'f', b'\t', name @ ..] => (false, name),
            _ => return Err(failed),
        };
        let name = std::str::from_utf8(name).map_err(|_| failed)?;
        if matches!(name, "" | "." | "..") || name.contains('/') {
            return Err(failed);
        }
        entries.push(v1::ProofWorkspaceEntry {
            name: name.to_owned(),
            directory,
        });
    }
    Ok(v1::ProofWorkspaceDirectory { entries, truncated })
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::Path;
    use std::process::Command;
    use std::time::Instant;

    fn list_local(root: &str, relative: &str) -> Result<v1::ProofWorkspaceDirectory, ErrorCode> {
        list_local_with_limit(root, relative, CAPTURE_LIMIT)
    }

    fn list_local_with_limit(
        root: &str,
        relative: &str,
        limit: usize,
    ) -> Result<v1::ProofWorkspaceDirectory, ErrorCode> {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &workspace_command(SCRIPT, root, relative)]);
        let output = process::run(command, Instant::now() + DEADLINE, limit)
            .map_err(|_| ErrorCode::WorkspaceReadFailed)?;
        decode(output)
    }

    #[test]
    fn workspace_directory_binding_allows_only_exact_root_or_normal_relative_paths() {
        let root = "/fixtures/workspace";
        let configured = Some(Path::new(root));
        for relative in ["", "nested/.hidden"] {
            assert_eq!(validate_path(configured, root, relative, true), Ok(root));
        }
        for (requested, relative) in [
            ("/fixtures/other", ""),
            ("/fixtures/workspace/", "nested"),
            (root, "/etc"),
            (root, ".."),
            (root, "."),
            (root, "a/../../other"),
            (root, "a//b"),
            (root, "a/"),
            (root, "C:/other"),
            (root, "\\other"),
            (root, "a\0b"),
        ] {
            assert_eq!(
                validate_path(configured, requested, relative, true),
                Err(ErrorCode::WorkspacePathDenied),
                "{requested:?} {relative:?}"
            );
        }
    }

    #[test]
    fn workspace_directory_recipe_lists_only_direct_files_and_dirs_with_literal_names() {
        let fixture = Fixture::new();
        let root = fixture.0.join("workspace '$(exit 9)'");
        let nested = "-dir '$(exit 9)'\n";
        let odd_file = "-file '$(exit 9)' *\t\n\\unicode-雪";
        fs::create_dir_all(root.join(nested)).expect("create quoted directory hierarchy");
        fs::create_dir(root.join(".hidden-dir")).expect("create hidden directory");
        for name in [odd_file, ".hidden-file", "..two-dots", "visible"] {
            fs::write(root.join(name), []).expect("create file");
        }
        fs::write(root.join(nested).join("child"), []).expect("create nested file");
        symlink(nested, root.join("dir-link")).expect("create directory link");
        symlink(odd_file, root.join("file-link")).expect("create file link");
        symlink("absent", root.join("dangling")).expect("create dangling link");
        assert!(
            Command::new("/usr/bin/mkfifo")
                .arg(root.join("fifo"))
                .status()
                .expect("make named pipe")
                .success()
        );
        let root = root.to_str().expect("UTF-8 workspace path");
        let listing = list_local(root, "").expect("list workspace root");
        assert!(!listing.truncated);
        let mut entries = listing
            .entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.directory))
            .collect::<Vec<_>>();
        entries.sort_unstable();
        assert_eq!(
            entries,
            [
                (nested, true),
                (odd_file, false),
                ("..two-dots", false),
                (".hidden-dir", true),
                (".hidden-file", false),
                ("visible", false),
            ]
        );
        let listing = list_local(root, nested).expect("list quoted nested directory");
        assert_eq!(
            listing.entries,
            [v1::ProofWorkspaceEntry {
                name: "child".into(),
                directory: false
            }]
        );
        let listing = list_local(root, ".hidden-dir").expect("list empty directory");
        assert!(listing.entries.is_empty());
        assert!(!listing.truncated);
    }

    #[test]
    fn workspace_directory_recipe_rejects_symlinks_and_nondirectories() {
        let fixture = Fixture::new();
        let root = fixture.0.join("workspace");
        let outside = fixture.0.join("outside");
        fs::create_dir_all(outside.join("child")).expect("create outside directory hierarchy");
        fs::create_dir(&root).expect("create workspace");
        fs::write(root.join("file"), []).expect("create file");
        symlink(&root, fixture.0.join("linked-root")).expect("create root symlink");
        symlink(&fixture.0, fixture.0.join("linked-parent")).expect("create ancestor symlink");
        symlink(&outside, root.join("escape")).expect("create outside symlink");
        let root = root.to_str().expect("UTF-8 workspace path");
        let linked_root = format!("{}/linked-root", fixture.root());
        let linked_parent = format!("{}/linked-parent/workspace", fixture.root());
        for (root, relative) in [
            (root, "file"),
            (root, "absent"),
            (root, "escape"),
            (root, "escape/child"),
            (&linked_root, ""),
            (&linked_parent, ""),
        ] {
            assert_eq!(
                list_local(root, relative),
                Err(ErrorCode::WorkspacePathDenied)
            );
        }
    }

    #[test]
    fn workspace_directory_capture_preserves_only_complete_shell_records() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("first"), []).expect("create first file");
        fs::write(fixture.0.join("second"), []).expect("create second file");
        let first_record_end = MARKER.len() + b"f\tfirst\0".len();
        for limit in [first_record_end, first_record_end + b"f\tsecond".len()] {
            let listing = list_local_with_limit(fixture.root(), "", limit)
                .expect("decode shell output with limited capture");
            assert!(listing.truncated);
            assert_eq!(
                listing.entries,
                [v1::ProofWorkspaceEntry {
                    name: "first".into(),
                    directory: false,
                }]
            );
        }
    }

    #[test]
    fn workspace_directory_decoder_keeps_only_complete_records_at_capture_limit() {
        let mut bytes = MARKER.to_vec();
        bytes.extend_from_slice(b"d\t.hidden\0f\tname\twith\nwhitespace\0f\tpartial\xc3");
        assert_eq!(parse(&bytes, false), Err(ErrorCode::WorkspaceReadFailed));
        let listing = parse(&bytes, true).expect("truncated directory listing");
        assert!(listing.truncated);
        assert_eq!(
            listing.entries,
            [
                v1::ProofWorkspaceEntry {
                    name: ".hidden".into(),
                    directory: true
                },
                v1::ProofWorkspaceEntry {
                    name: "name\twith\nwhitespace".into(),
                    directory: false
                },
            ]
        );
        let mut bytes = MARKER.to_vec();
        bytes.extend_from_slice(b"f\tcomplete\0");
        let listing = parse(&bytes, true).expect("truncate on a record boundary");
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), 1);
    }

    #[test]
    fn workspace_directory_decoder_rejects_nonchildren_and_malformed_output() {
        assert_eq!(
            parse(b"no marker", true),
            Err(ErrorCode::WorkspaceReadFailed)
        );
        for record in [
            &b"d\t../outside\0"[..],
            b"f\t/sub\0",
            b"f\tnested/file\0",
            b"d\t.\0",
            b"d\t..\0",
            b"f\t\0",
            b"l\tlink\0",
            b"f\t\xff\0",
            b"\0",
        ] {
            let mut bytes = MARKER.to_vec();
            bytes.extend_from_slice(record);
            assert_eq!(
                parse(&bytes, true),
                Err(ErrorCode::WorkspaceReadFailed),
                "{record:?}"
            );
        }
    }
}
