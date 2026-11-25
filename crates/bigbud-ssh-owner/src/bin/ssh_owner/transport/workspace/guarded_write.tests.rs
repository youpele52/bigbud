//! Standalone fixture tests; intentionally not imported by the owner transport.
//! Compile this file with `rustc --edition 2024 --test` and run the resulting binary.
#![cfg(unix)]

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, chown, symlink};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

const RECIPE: &str =
    include_str!("../../../../../../../protocol/ssh-owner/workspace-write-guarded.py");
const PREFIX: &str = "BIGBUD_GUARDED_WRITE_V1";
const OP: &str = "0123456789abcdef0123456789abcdef";
const OTHER_OP: &str = "fedcba9876543210fedcba9876543210";
const LEAF: &str = "edit.txt";
const LOCK: &str = ".bigbud-lock-b992cde14dec78705ff5f38ccfa1fa78dc94fc68b0f63043810ed41493a4f577";
const STAGE: &str = ".bigbud-edit-0123456789abcdef0123456789abcdef";
const OLD: &[u8] = b"old\n";
const NEW: &[u8] = b"new\n";
const OLD_SHA: &str = "01d09d19c2139a46aebfb577780d123d7396e97201bc7ead210a2ebff8239dee";
const NEW_SHA: &str = "7aa7a5359173d05b63cfd682e3c38487f3cb4f7f1d60659fe59fab1505977d4c";
const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LIMIT: usize = 512 * 1024;
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().canonicalize().unwrap();
        loop {
            let index = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = base.join(format!("bigbud-e2-{}-{index}", std::process::id()));
            match DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => {
                    let fixture = Self(path);
                    fixture.put(LEAF, OLD);
                    return fixture;
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create disposable fixture: {error}"),
            }
        }
    }

    fn put(&self, path: &str, bytes: &[u8]) {
        fs::write(self.0.join(path), bytes).unwrap();
    }

    fn get(&self, path: &str) -> Vec<u8> {
        fs::read(self.0.join(path)).unwrap()
    }

    fn stat(&self, path: &str) -> fs::Metadata {
        fs::metadata(self.0.join(path)).unwrap()
    }

    fn clean(&self) {
        for entry in fs::read_dir(&self.0).unwrap() {
            let name = entry.unwrap().file_name();
            assert!(!name.as_encoded_bytes().starts_with(b".bigbud-"));
        }
    }

    fn save(&self, expected: &str, data: &[u8], digest: &str) -> String {
        self.invoke(LEAF, OP, expected, digest, &data.len().to_string(), data)
    }

    fn invoke(
        &self,
        path: &str,
        operation: &str,
        expected: &str,
        digest: &str,
        length: &str,
        data: &[u8],
    ) -> String {
        let mut child = Command::new("/usr/bin/python3")
            .current_dir("/")
            .args(["-I", "-B", "-c", RECIPE])
            .arg(&self.0)
            .args([path, operation, expected, digest, length])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Err(error) = child.stdin.take().unwrap().write_all(data) {
            assert_eq!(error.kind(), ErrorKind::BrokenPipe);
        }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{:?}", output.status);
        assert_eq!(output.stderr, b"");
        let marker = std::str::from_utf8(&output.stdout).unwrap();
        assert!(marker.len() <= 128);
        let (prefix, body) = marker.strip_suffix('\n').unwrap().split_once(' ').unwrap();
        assert_eq!(prefix, PREFIX);
        assert!(!body.contains('\n'));
        body.to_owned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn ordinary_save_preserves_mode_and_exact_text_bytes() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("nested")).unwrap();
    fs::rename(fixture.0.join(LEAF), fixture.0.join("nested/edit.txt")).unwrap();
    let path = "nested/edit.txt";
    fs::set_permissions(fixture.0.join(path), fs::Permissions::from_mode(0o640)).unwrap();
    let old = fixture.stat(path);
    let data = b"\xef\xbb\xbfnew\r\n";
    let digest = "cbdb18e0bb90fd8a2848a9a282c8982f89f80f4e129294d724164feaa6e788ac";
    // macOS may automatically attach provenance metadata to fixture files.
    let mut mode = "atomic";
    if cfg!(target_os = "macos") && !output("/usr/bin/xattr", &[], &fixture.0.join(path)).is_empty()
    {
        mode = "inPlace";
    }
    assert_eq!(
        fixture.invoke(path, OP, OLD_SHA, digest, "8", data),
        format!("saved {mode} {digest}")
    );
    let new = fixture.stat(path);
    assert_eq!(new.ino() == old.ino(), mode == "inPlace");
    assert_eq!(new.mode(), old.mode());
    assert_eq!((new.uid(), new.gid()), (old.uid(), old.gid()));
    assert_eq!(fixture.get(path), data);
    assert_eq!(fs::read_dir(fixture.0.join("nested")).unwrap().count(), 1);
    fixture.clean();
}

#[test]
fn accepts_exactly_512_kib_and_can_save_an_empty_file() {
    let fixture = Fixture::new();
    let data = vec![b'x'; LIMIT];
    let digest = "ec8bb338811bbf800a8b5e507d06e08a1d9d05bde74294f6f7388f3bbfba82e5";
    assert_saved(&fixture.save(OLD_SHA, &data, digest), digest);
    assert_eq!(fixture.get(LEAF), data);
    assert_saved(
        &fixture.invoke(LEAF, OTHER_OP, digest, EMPTY_SHA, "0", b""),
        EMPTY_SHA,
    );
    assert!(fixture.get(LEAF).is_empty());
    fixture.clean();
}

#[test]
fn conflict_reports_current_digest_or_missing_without_publishing() {
    let fixture = Fixture::new();
    let old = fixture.stat(LEAF);
    assert_eq!(
        fixture.save(NEW_SHA, NEW, NEW_SHA),
        format!("conflict {OLD_SHA}")
    );
    assert_eq!(fixture.get(LEAF), OLD);
    assert_eq!(fixture.stat(LEAF).ino(), old.ino());
    fs::remove_file(fixture.0.join(LEAF)).unwrap();
    assert_eq!(fixture.save(OLD_SHA, NEW, NEW_SHA), "conflict missing");
    assert_eq!(
        fixture.invoke("missing/edit.txt", OP, OLD_SHA, NEW_SHA, "4", NEW),
        "conflict missing"
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
}

#[test]
fn scope_and_request_grammar_fail_closed() {
    let fixture = Fixture::new();
    for path in [
        "/edit.txt",
        "../edit.txt",
        "./edit.txt",
        "x//edit.txt",
        "a;echo",
        ".BIGBUD-edit-x",
    ] {
        assert_eq!(
            fixture.invoke(path, OP, OLD_SHA, NEW_SHA, "4", NEW),
            "terminal request"
        );
    }
    assert_eq!(
        fixture.invoke(LEAF, "bad-operation", OLD_SHA, NEW_SHA, "4", NEW),
        "terminal request"
    );
    assert_eq!(fixture.get(LEAF), OLD);
    fixture.clean();
}

#[test]
fn refuses_symlinks_and_special_files() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    symlink(&outside.0, fixture.0.join("escape")).unwrap();
    symlink(outside.0.join(LEAF), fixture.0.join("link")).unwrap();
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(fixture.0.join("fifo"))
            .status()
            .unwrap()
            .success()
    );
    for (path, outcome) in [
        ("escape/edit.txt", "terminal scope"),
        ("link", "terminal target"),
        ("fifo", "terminal target"),
    ] {
        assert_eq!(
            fixture.invoke(path, OP, OLD_SHA, NEW_SHA, "4", NEW),
            outcome
        );
    }
    assert_eq!(outside.get(LEAF), OLD);
    fixture.clean();
}

#[test]
fn rejects_bad_size_digest_and_text_before_publication() {
    let fixture = Fixture::new();
    let bad_utf8 = "a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89";
    let nul = "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";
    let too_much = format!("{}", LIMIT + 1);
    for (digest, size, data) in [
        (NEW_SHA, "5", NEW),
        (NEW_SHA, "3", NEW),
        (OLD_SHA, "4", NEW),
        (NEW_SHA, too_much.as_str(), b""),
        (bad_utf8, "1", b"\xff"),
        (nul, "1", b"\0"),
    ] {
        assert_eq!(
            fixture.invoke(LEAF, OP, OLD_SHA, digest, size, data),
            "terminal request"
        );
        assert_eq!(fixture.get(LEAF), OLD);
        fixture.clean();
    }
    fixture.put(LEAF, b"\xff");
    assert_eq!(fixture.save(bad_utf8, NEW, NEW_SHA), "terminal target");
    assert_eq!(fixture.get(LEAF), b"\xff");
    fixture.clean();
}

#[test]
fn hard_links_share_live_inode_lock_and_keep_identity() {
    let fixture = Fixture::new();
    fs::hard_link(fixture.0.join(LEAF), fixture.0.join("alias")).unwrap();
    let old = fixture.stat(LEAF);
    assert_eq!(
        fixture.save(NEW_SHA, NEW, NEW_SHA),
        format!("conflict {OLD_SHA}")
    );
    assert_eq!(fixture.get("alias"), OLD);
    let held = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.0.join("alias"))
        .unwrap();
    held.lock().unwrap();
    assert_eq!(fixture.save(OLD_SHA, NEW, NEW_SHA), "terminal busy");
    assert_eq!(fixture.get("alias"), OLD);
    fixture.clean();
    drop(held);
    assert_eq!(
        fixture.save(OLD_SHA, NEW, NEW_SHA),
        format!("saved inPlace {NEW_SHA}")
    );
    assert_eq!(fixture.get("alias"), NEW);
    assert_eq!(fixture.get(LEAF), NEW);
    let new = fixture.stat(LEAF);
    assert_eq!((new.ino(), new.nlink()), (old.ino(), 2));
    assert_eq!(
        (new.uid(), new.gid(), new.mode()),
        (old.uid(), old.gid(), old.mode())
    );
    fixture.clean();
}

#[test]
fn never_reclaims_an_old_lock_even_when_the_operation_id_matches() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join(LOCK)).unwrap();
    let record = format!("{OP} {NEW_SHA}\n");
    fixture.put(&format!("{LOCK}/operation"), record.as_bytes());
    let dir = OpenOptions::new()
        .read(true)
        .open(fixture.0.join(LOCK))
        .unwrap();
    dir.set_modified(std::time::UNIX_EPOCH).unwrap();
    let inode = fixture.stat(LOCK).ino();
    for operation in [OP, OTHER_OP] {
        assert_eq!(
            fixture.invoke(LEAF, operation, OLD_SHA, NEW_SHA, "4", NEW),
            "terminal busy"
        );
        assert_eq!(fixture.get(LEAF), OLD);
        assert_eq!(fixture.stat(LOCK).ino(), inode);
        assert_eq!(fixture.get(&format!("{LOCK}/operation")), record.as_bytes());
        assert!(!fixture.0.join(STAGE).exists());
    }
}

#[test]
fn uncertain_stage_collision_preserves_evidence_and_does_not_publish() {
    let fixture = Fixture::new();
    fixture.put(STAGE, b"previous attempt evidence");
    let staged = fixture.stat(STAGE).ino();
    assert_eq!(fixture.save(OLD_SHA, NEW, NEW_SHA), "unknown");
    assert_eq!(fixture.get(LEAF), OLD);
    assert_eq!(fixture.get(STAGE), b"previous attempt evidence");
    assert_eq!(fixture.stat(STAGE).ino(), staged);
    assert_eq!(
        fixture.get(&format!("{LOCK}/operation")),
        format!("{OP} {NEW_SHA}\n").as_bytes()
    );
    assert_eq!(fixture.save(OLD_SHA, NEW, NEW_SHA), "terminal busy");
}

fn output(program: &str, args: &[&str], path: &std::path::Path) -> Vec<u8> {
    let output = Command::new(program).args(args).arg(path).output().unwrap();
    assert!(output.status.success());
    output.stdout
}

fn assert_saved(marker: &str, digest: &str) {
    assert!(
        marker == format!("saved atomic {digest}") || marker == format!("saved inPlace {digest}")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn extended_attributes_and_acl_keep_the_inode() {
    let fixture = Fixture::new();
    let path = fixture.0.join(LEAF);
    output("/usr/bin/xattr", &["-w", "com.bigbud.fixture", "e2"], &path);
    output("/bin/chmod", &["+a", "everyone allow readattr"], &path);
    let acl = || {
        String::from_utf8(output("/bin/ls", &["-led", "--"], &path))
            .unwrap()
            .lines()
            .nth(1)
            .unwrap()
            .to_owned()
    };
    let acl_before = acl();
    let old = fixture.stat(LEAF);
    assert_eq!(
        fixture.save(OLD_SHA, NEW, NEW_SHA),
        format!("saved inPlace {NEW_SHA}")
    );
    assert_eq!(fixture.stat(LEAF).ino(), old.ino());
    assert_eq!(
        output("/usr/bin/xattr", &["-p", "com.bigbud.fixture"], &path),
        b"e2\n"
    );
    assert_eq!(acl_before, acl());
    fixture.clean();
}

#[test]
fn foreign_group_is_not_replaced_when_a_disposable_group_is_available() {
    let fixture = Fixture::new();
    let old_group = fixture.stat(LEAF).gid();
    let output = Command::new("/usr/bin/id").arg("-G").output().unwrap();
    assert!(output.status.success());
    let Some(group) = std::str::from_utf8(&output.stdout)
        .unwrap()
        .split_ascii_whitespace()
        .map(|group| group.parse::<u32>().unwrap())
        .find(|group| *group != old_group)
    else {
        eprintln!("no supplementary group available for the foreign-group fixture");
        return;
    };
    chown(fixture.0.join(LEAF), None, Some(group)).unwrap();
    let old = fixture.stat(LEAF);
    assert_eq!(
        fixture.save(OLD_SHA, NEW, NEW_SHA),
        format!("saved inPlace {NEW_SHA}")
    );
    let new = fixture.stat(LEAF);
    assert_eq!(
        (new.ino(), new.gid(), new.mode()),
        (old.ino(), group, old.mode())
    );
    assert_eq!(fixture.get(LEAF), NEW);
    fixture.clean();
}
