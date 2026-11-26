#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
#[cfg(target_os = "macos")]
use sha2::Digest;
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;

const OP: &str = "0123456789abcdef0123456789abcdef";
const BASE: Sha256Bytes = [0xab; 32];
const ATTEMPTED: Sha256Bytes = [0xcd; 32];

fn request() -> StagedWrite<'static> {
    StagedWrite {
        root: "/private/tmp/disposable",
        path: "nested/report.txt",
        operation_id: OP,
        base: &BASE,
        attempted: &ATTEMPTED,
        bytes: b"new text\n",
    }
}

fn decode(status: i32, bytes: impl Into<Vec<u8>>, truncated: bool) -> Outcome {
    request().decode(process::Output {
        status: ExitStatus::from_raw(status),
        stdout: bytes.into(),
        stderr: b"not an acknowledgement".to_vec(),
        truncated,
    })
}

#[test]
fn command_uses_exact_scope_operands_and_only_the_fixed_interpreter() {
    let write = request();
    let command = write.command(Some(Path::new(write.root))).unwrap();
    assert!(command.starts_with("exec /usr/bin/python3 -I -B -c '"));
    assert!(command.ends_with(&format!(
        "' '{}' '{}' '{OP}' {} {} 9",
        write.root,
        write.path,
        "ab".repeat(32),
        "cd".repeat(32),
    )));
    assert!(!command.contains("new text"));

    for root in [None, Some(Path::new("/private/tmp/other"))] {
        assert_eq!(write.command(root), Err(ErrorCode::WorkspacePathDenied));
    }
    let root = "/private/tmp/disposable/home/picker's folders; literal";
    let literal = StagedWrite { root, ..request() };
    assert!(
        literal
            .command(Some(Path::new(root)))
            .unwrap()
            .contains(&quote(root))
    );
    let wrong = StagedWrite {
        root: "/private/tmp/disposable/home/another's folder; literal",
        ..request()
    };
    assert_eq!(
        wrong.command(Some(Path::new(wrong.root))),
        Err(ErrorCode::WorkspacePathDenied)
    );

    let long_component = "a".repeat(256);
    for path in [
        "",
        "/outside",
        "nested//report",
        "nested/../report",
        "x; echo bad",
        "a/é",
        "a/.",
        "C:drive",
        ".BIGBUD-edit-x",
        &long_component,
    ] {
        let write = StagedWrite { path, ..request() };
        assert_eq!(
            write.command(Some(Path::new(write.root))),
            Err(ErrorCode::WorkspacePathDenied)
        );
    }
}

#[test]
fn size_and_operation_id_are_checked_before_ssh() {
    for operation_id in [
        "",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0123456789ABCDEF0123456789abcdef",
        "0123456789abcdef0123456789abcde;",
    ] {
        let write = StagedWrite {
            operation_id,
            ..request()
        };
        assert_eq!(
            write.command(Some(Path::new(write.root))),
            Err(ErrorCode::InvalidOperands)
        );
    }
    let data = vec![b'x'; WRITE_LIMIT + 1];
    let (at_limit, _) = data.split_at(WRITE_LIMIT);
    for bytes in [&[], at_limit, data.as_slice()] {
        let write = StagedWrite { bytes, ..request() };
        let command = write.command(Some(Path::new(write.root)));
        assert_eq!(command.is_ok(), bytes.len() <= WRITE_LIMIT);
    }
}

#[test]
fn accepts_each_exact_recipe_outcome_with_exit_zero() {
    let attempted = "cd".repeat(32);
    let current = "ef".repeat(32);
    for (line, expected) in [
        (
            format!("saved atomic {attempted}"),
            Outcome::Saved {
                publication: Publication::Atomic,
                sha256: ATTEMPTED,
            },
        ),
        (
            format!("saved inPlace {attempted}"),
            Outcome::Saved {
                publication: Publication::InPlace,
                sha256: ATTEMPTED,
            },
        ),
        (
            format!("conflict {current}"),
            Outcome::Conflict(Conflict::Hash([0xef; 32])),
        ),
        (
            "conflict missing".into(),
            Outcome::Conflict(Conflict::Missing),
        ),
        (
            "conflict changed".into(),
            Outcome::Conflict(Conflict::Changed),
        ),
        (
            "terminal request".into(),
            Outcome::Terminal(Terminal::Request),
        ),
        ("terminal scope".into(), Outcome::Terminal(Terminal::Scope)),
        (
            "terminal target".into(),
            Outcome::Terminal(Terminal::Target),
        ),
        ("terminal busy".into(), Outcome::Terminal(Terminal::Busy)),
        ("terminal io".into(), Outcome::Terminal(Terminal::Io)),
        (
            "terminal hostToolUnavailable".into(),
            Outcome::Terminal(Terminal::HostToolUnavailable),
        ),
        ("unknown".into(), Outcome::Unknown),
    ] {
        let marker = format!("BIGBUD_GUARDED_WRITE_V1 {line}\n");
        assert_eq!(decode(0, marker.clone(), false), expected);
        assert_eq!(decode(255 << 8, marker.clone(), false), Outcome::Unknown);
        assert_eq!(decode(9, marker.clone(), false), Outcome::Unknown);
        assert_eq!(decode(0, marker, true), Outcome::Unknown);
    }
}

#[test]
fn rejects_missing_ambiguous_and_unbound_acknowledgements() {
    let attempted = "cd".repeat(32);
    let base = "ab".repeat(32);
    for output in [
        String::new(),
        "BIGBUD_GUARDED_WRITE_V1 conflict missing".into(),
        "BIGBUD_GUARDED_WRITE_V1 conflict missing\r\n".into(),
        "BIGBUD_GUARDED_WRITE_V1 conflict missing\n\n".into(),
        "noise\nBIGBUD_GUARDED_WRITE_V1 terminal busy\n".into(),
        "BIGBUD_GUARDED_WRITE_V1 terminal unsupported\n".into(),
        "BIGBUD_GUARDED_WRITE_V1 terminal  busy\n".into(),
        format!("BIGBUD_GUARDED_WRITE_V1 saved atomic {base}\n"),
        format!("BIGBUD_GUARDED_WRITE_V1 saved inPlace {attempted}a\n"),
        format!(
            "BIGBUD_GUARDED_WRITE_V1 saved atomic {}\n",
            attempted.to_ascii_uppercase()
        ),
        format!("BIGBUD_GUARDED_WRITE_V1 conflict {base}\n"),
        format!("BIGBUD_GUARDED_WRITE_V1 conflict a{base}\n"),
    ] {
        assert_eq!(decode(0, output, false), Outcome::Unknown);
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires the explicitly selected disposable loopback picker sshd with fixture keys"]
fn live_private_openssh_guarded_recipe() {
    use crate::transport::TransportConfig;
    use std::{
        env, fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::PathBuf,
    };

    assert_eq!(
        env::var("BIGBUD_GUARDED_RECIPE_FIXTURE").as_deref(),
        Ok("approved-disposable")
    );
    let fixture = PathBuf::from(env::var_os("BIGBUD_GUARDED_RECIPE_ROOT").expect("fixture root"));
    assert_eq!(fixture.parent(), Some(Path::new("/private/tmp")));
    assert!(
        fixture
            .file_name()
            .and_then(|p| p.to_str())
            .and_then(|p| p.strip_prefix("bigbud-picker-sshd-"))
            .is_some_and(
                |suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
            )
    );
    let port = env::var("BIGBUD_GUARDED_RECIPE_PORT")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    assert!(port >= 1024);
    let pin = fixture.join("known_hosts");
    let host_public = fs::read_to_string(fixture.join("host-key.pub")).unwrap();
    let mut fields = host_public.split_ascii_whitespace();
    let key_type = fields.next().unwrap();
    let key = fields.next().unwrap();
    assert_eq!(key_type, "ssh-ed25519");
    assert_eq!(
        fs::read_to_string(&pin).unwrap(),
        format!("[127.0.0.1]:{port} {key_type} {key}\n")
    );

    // Exercise the actual fixed fixture display name, including its apostrophe.
    let root = fixture.join("home/picker's folders; literal");
    assert!(root.is_dir());
    let entries = || {
        fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let mut expected_entries = entries();
    expected_entries
        .extend(["report.txt", "linked.txt", "symlink.txt"].map(std::ffi::OsString::from));
    let transport = Transport::new(TransportConfig {
        ssh: "/usr/bin/ssh".into(),
        keyscan: "/usr/bin/ssh-keyscan".into(),
        host: Ipv4Addr::LOCALHOST.into(),
        port,
        user: env::var("BIGBUD_GUARDED_RECIPE_USER").unwrap(),
        identity: fixture.join("identity"),
        known_hosts: pin,
        alias_config: None,
        system_config: None,
        workspace_root: Some(root.clone()),
        dev_interactive_terminal: false,
        host_identity: Default::default(),
    })
    .expect("private transport");

    // Qualify the exact absolute executable on the remote fixture, not the
    // host PATH. Successful recipe cases below exercise the required syscalls.
    let mut pinned = transport.pinned_ssh("-T").unwrap();
    pinned
        .command
        .args(["--", &transport.host, "exec /usr/bin/python3 -I -B -V"]);
    let version = process::run(pinned.command, Instant::now() + TIMEOUT, 80)
        .ok()
        .expect("Python probe transport");
    assert!(version.status.success() && !version.truncated);
    let version = std::str::from_utf8(&version.stdout).unwrap().trim_end();
    let mut components = version.strip_prefix("Python ").unwrap().split('.');
    let major = components.next().unwrap().parse::<u32>().unwrap();
    let minor = components.next().unwrap().parse::<u32>().unwrap();
    assert!((major, minor) >= (3, 8));
    eprintln!("Private sshd fixed tool: {version}");

    let leaf = root.join("report.txt");
    let old = b"old text\n";
    fs::write(&leaf, old).unwrap();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o640)).unwrap();
    let base = Sha256::digest(old).into();
    let mut body = vec![b'x'; WRITE_LIMIT];
    body.first_chunk_mut::<8>()
        .unwrap()
        .copy_from_slice(b"\xef\xbb\xbfcaf\xc3\xa9");
    body.last_chunk_mut::<2>().unwrap().copy_from_slice(b"\r\n");
    let attempted = Sha256::digest(&body).into();
    let mut write = StagedWrite {
        root: root.to_str().unwrap(),
        path: "report.txt",
        operation_id: OP,
        base: &BASE,
        attempted: &attempted,
        bytes: &body,
    };
    assert_eq!(
        execute(&transport, &write),
        Ok(Outcome::Conflict(Conflict::Hash(base)))
    );
    assert_eq!(fs::read(&leaf).unwrap(), old);

    write.operation_id = "0123456789abcdef0123456789abcde0";
    write.base = &base;
    let old_inode = fs::metadata(&leaf).unwrap().ino();
    let saved = match execute(&transport, &write).unwrap() {
        Outcome::Saved {
            publication,
            sha256,
        } => Some((publication, sha256)),
        _ => None,
    };
    let (publication, sha256) = saved.expect("guarded save did not report publication");
    assert_eq!(sha256, attempted);
    assert_eq!(fs::read(&leaf).unwrap(), body);
    let info = fs::metadata(&leaf).unwrap();
    assert_eq!(info.mode() & 0o777, 0o640);
    let inode = info.ino();
    // Filesystems can attach metadata by default; compare the actual inode
    // behavior to the reported method rather than assuming replacement.
    assert_eq!(old_inode == inode, publication == Publication::InPlace);
    eprintln!("512 KiB publication: {publication:?}");

    let linked = root.join("linked.txt");
    fs::hard_link(&leaf, &linked).unwrap();
    let empty_hash = Sha256::digest([]).into();
    write.operation_id = "0123456789abcdef0123456789abcde1";
    write.base = &attempted;
    write.attempted = &empty_hash;
    write.bytes = &[];
    assert_eq!(
        execute(&transport, &write),
        Ok(Outcome::Saved {
            publication: Publication::InPlace,
            sha256: empty_hash
        })
    );
    assert!(fs::read(&linked).unwrap().is_empty());
    assert_eq!(fs::metadata(&leaf).unwrap().ino(), inode);

    std::os::unix::fs::symlink(&leaf, root.join("symlink.txt")).unwrap();
    write.operation_id = "0123456789abcdef0123456789abcde2";
    write.path = "symlink.txt";
    assert_eq!(
        execute(&transport, &write),
        Ok(Outcome::Terminal(Terminal::Target))
    );
    assert!(fs::read(&leaf).unwrap().is_empty());
    assert_eq!(entries(), expected_entries);
}
