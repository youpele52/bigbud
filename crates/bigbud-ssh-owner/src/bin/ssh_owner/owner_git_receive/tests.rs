//! The conductor against a real local `git receive-pack` (same forced config as
//! the target guard) and a scripted client playing local Git's side.

use super::{Approval, Conducted, Receipt, conduct, remote_command};
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
};

const FAKE: &str = "1234567890123456789012345678901234567890";

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _removed = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(["-c", "init.defaultBranch=main"])
        .args(args)
        .output()
        .expect("git runs");
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout)
        .expect("utf8")
        .trim()
        .to_owned()
}

struct Fixture {
    _root: Scratch,
    bare: PathBuf,
    work: PathBuf,
    /// The bare repository's `main`.
    old: String,
    /// A fast-forward of `old` in the work tree.
    new: String,
}

fn fixture(name: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!("bb-recv-{name}-{}", std::process::id()));
    let _stale = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("scratch");
    let (work, bare) = (root.join("work"), root.join("repo.git"));
    git(&root, &["init", "-q", "work"]);
    git(&work, &["commit", "-q", "--allow-empty", "-m", "a"]);
    let old = git(&work, &["rev-parse", "HEAD"]);
    git(&root, &["clone", "-q", "--bare", "work", "repo.git"]);
    git(&bare, &["branch", "dev", "main"]);
    git(&work, &["commit", "-q", "--allow-empty", "-m", "b"]);
    let new = git(&work, &["rev-parse", "HEAD"]);
    Fixture {
        _root: Scratch(root),
        bare,
        work,
        old,
        new,
    }
}

fn receive_pack(bare: &Path) -> Child {
    Command::new("git")
        .args(["receive-pack"])
        .arg(bare)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "receive.denyNonFastForwards")
        .env("GIT_CONFIG_VALUE_0", "true")
        .env("GIT_CONFIG_KEY_1", "receive.denyDeletes")
        .env("GIT_CONFIG_VALUE_1", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("receive-pack")
}

fn pack(work: &Path, include: &str, exclude: &str) -> Vec<u8> {
    let mut child = Command::new("git")
        .current_dir(work)
        .args(["pack-objects", "--stdout", "--revs", "-q"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("pack-objects");
    let mut stdin = child.stdin.take().expect("stdin");
    stdin
        .write_all(format!("{include}\n^{exclude}\n").as_bytes())
        .expect("revs");
    drop(stdin);
    let output = child.wait_with_output().expect("pack");
    assert!(output.status.success());
    output.stdout
}

fn packet(payload: &str) -> Vec<u8> {
    format!("{:04x}{payload}", payload.len() + 4).into_bytes()
}

fn read_section(stream: &mut UnixStream) -> String {
    let mut text = String::new();
    loop {
        let mut header = [0; 4];
        stream.read_exact(&mut header).expect("pkt header");
        let len = usize::from_str_radix(std::str::from_utf8(&header).expect("hex"), 16).unwrap();
        if len == 0 {
            return text;
        }
        let mut body = vec![0; len - 4];
        stream.read_exact(&mut body).expect("pkt body");
        text.push_str(&String::from_utf8_lossy(&body));
    }
}

/// Run one conduct; the client closure plays local Git and returns what it read.
fn exchange(
    bare: &Path,
    approval: &Approval,
    client: impl FnOnce(UnixStream) -> Vec<u8> + Send + 'static,
) -> (Conducted, Vec<u8>) {
    let mut child = receive_pack(bare);
    let (ours, theirs) = UnixStream::pair().expect("pair");
    let peer = thread::spawn(move || client(theirs));
    let conducted = conduct(
        child.stdout.take().expect("stdout"),
        child.stdin.take().expect("stdin"),
        &ours,
        approval,
        || true,
    );
    drop(ours);
    let seen = peer.join().expect("client");
    let _exited = child.wait();
    (conducted, seen)
}

fn approval(old: &str, new: &str) -> Approval {
    Approval {
        destination_ref: "refs/heads/main".into(),
        expected_old_oid: old.into(),
        source_oid: new.into(),
    }
}

fn push_client(
    old: String,
    new: String,
    reference: &'static str,
    pack: Vec<u8>,
) -> impl FnOnce(UnixStream) -> Vec<u8> + Send {
    move |mut stream| {
        let advertisement = read_section(&mut stream);
        assert!(advertisement.starts_with(&format!("{old} refs/heads/main\0")));
        assert!(!advertisement.contains("refs/heads/dev"));
        assert!(!advertisement.contains("agent="));
        // A refused command closes the socket before the pack is read, so the
        // write may race to EPIPE; accepted cases are proven by their report.
        let _pushed = stream
            .write_all(&packet(&format!("{old} {new} {reference}\0 report-status")))
            .and_then(|()| stream.write_all(b"0000"))
            .and_then(|()| stream.write_all(&pack));
        let _half_close = stream.shutdown(Shutdown::Write);
        let mut report = Vec::new();
        let _read = stream.read_to_end(&mut report);
        report
    }
}

#[test]
fn an_exact_fast_forward_is_accepted_and_reported() {
    let f = fixture("ff");
    let bytes = pack(&f.work, &f.new, &f.old);
    let client = push_client(f.old.clone(), f.new.clone(), "refs/heads/main", bytes);
    let (conducted, report) = exchange(&f.bare, &approval(&f.old, &f.new), client);
    assert!(matches!(conducted, Conducted::Settled(Receipt::Accepted)));
    assert!(String::from_utf8_lossy(&report).contains("ok refs/heads/main"));
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), f.new);
    assert_eq!(git(&f.bare, &["rev-parse", "dev"]), f.old);
}

#[test]
fn a_moved_remote_ref_is_stale_and_nothing_is_offered() {
    let f = fixture("stale");
    let (conducted, seen) = exchange(&f.bare, &approval(FAKE, &f.new), |mut stream| {
        let mut seen = Vec::new();
        let _read = stream.read_to_end(&mut seen);
        seen
    });
    assert!(matches!(conducted, Conducted::Settled(Receipt::Stale)));
    assert!(seen.is_empty());
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), f.old);
}

#[test]
fn a_command_for_another_ref_is_refused_before_forwarding() {
    let f = fixture("refused");
    let bytes = pack(&f.work, &f.new, &f.old);
    let client = push_client(f.old.clone(), f.new.clone(), "refs/heads/dev", bytes);
    let (conducted, _) = exchange(&f.bare, &approval(&f.old, &f.new), client);
    assert!(matches!(conducted, Conducted::Settled(Receipt::Refused)));
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), f.old);
    assert_eq!(git(&f.bare, &["rev-parse", "dev"]), f.old);
}

#[test]
fn the_forced_remote_config_rejects_a_non_fast_forward() {
    let f = fixture("nonff");
    let tree = git(&f.work, &["rev-parse", "HEAD^{tree}"]);
    let unrelated = git(&f.work, &["commit-tree", &tree, "-m", "c"]);
    let bytes = pack(&f.work, &unrelated, &f.old);
    let client = push_client(f.old.clone(), unrelated.clone(), "refs/heads/main", bytes);
    let (conducted, report) = exchange(&f.bare, &approval(&f.old, &unrelated), client);
    assert!(matches!(conducted, Conducted::Settled(Receipt::Rejected)));
    assert!(String::from_utf8_lossy(&report).contains("ng refs/heads/main"));
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), f.old);
}

#[test]
fn an_equal_approval_observes_and_writes_nothing() {
    let f = fixture("unchanged");
    let old = f.old.clone();
    let (conducted, _) = exchange(&f.bare, &approval(&f.old, &f.old), move |mut stream| {
        let advertisement = read_section(&mut stream);
        assert!(advertisement.starts_with(&format!("{old} refs/heads/main\0")));
        stream.write_all(b"0000").expect("flush");
        Vec::new()
    });
    assert!(matches!(conducted, Conducted::Settled(Receipt::Unchanged)));
    assert_eq!(git(&f.bare, &["rev-parse", "main"]), f.old);
}

#[test]
fn a_first_publish_creates_only_an_absent_branch() {
    let f = fixture("create");
    let zero = "0".repeat(40);
    let mut create = approval(&zero, &f.new);
    create.destination_ref = "refs/heads/feature".into();
    let bytes = pack(&f.work, &f.new, &f.old);
    let (old, new, expected_zero) = (f.old.clone(), f.new.clone(), zero.clone());
    let (conducted, report) = exchange(&f.bare, &create, move |mut stream| {
        let advertisement = read_section(&mut stream);
        // The live tip is offered as `.have` (carrying the capabilities), so the pack can be thin.
        assert!(advertisement.starts_with(&format!("{old} .have\0")));
        assert!(!advertisement.contains("capabilities^{}"));
        stream
            .write_all(&packet(&format!(
                "{expected_zero} {new} refs/heads/feature\0 report-status"
            )))
            .and_then(|()| stream.write_all(b"0000"))
            .and_then(|()| stream.write_all(&bytes))
            .expect("push");
        let _half_close = stream.shutdown(Shutdown::Write);
        let mut report = Vec::new();
        let _read = stream.read_to_end(&mut report);
        report
    });
    assert!(matches!(conducted, Conducted::Settled(Receipt::Accepted)));
    assert!(String::from_utf8_lossy(&report).contains("ok refs/heads/feature"));
    assert_eq!(git(&f.bare, &["rev-parse", "feature"]), f.new);
    // The same first publish of an existing branch is stale and writes nothing.
    let mut existing = approval(&zero, &f.new);
    existing.destination_ref = "refs/heads/dev".into();
    let (conducted, _) = exchange(&f.bare, &existing, |mut stream| {
        let mut seen = Vec::new();
        let _read = stream.read_to_end(&mut seen);
        seen
    });
    assert!(matches!(conducted, Conducted::Settled(Receipt::Stale)));
    assert_eq!(git(&f.bare, &["rev-parse", "dev"]), f.old);
}

#[test]
fn approvals_and_the_remote_command_are_fixed() {
    assert!(approval(FAKE, &"a".repeat(40)).is_valid());
    // A first publish: zero old OID, nonzero source of the same width.
    assert!(approval(&"0".repeat(40), FAKE).is_valid());
    assert!(!approval(&"0".repeat(64), FAKE).is_valid());
    assert!(!approval(FAKE, &"0".repeat(40)).is_valid());
    assert!(!approval(FAKE, &"a".repeat(64)).is_valid());
    let mut branch = approval(FAKE, &"a".repeat(40));
    branch.destination_ref = "refs/tags/v1".into();
    assert!(!branch.is_valid());
    let command = remote_command("/srv/it's", "/srv/it's/r.git");
    assert!(command.starts_with("exec /usr/bin/env -i LC_ALL=C"));
    assert!(command.contains("GIT_CONFIG_GLOBAL=/dev/null"));
    assert!(command.contains("'/srv/it'\\''s/r.git'"));
    assert!(command.contains("receive.denyNonFastForwards GIT_CONFIG_VALUE_0=true"));
    assert!(command.contains("exec git-receive-pack \"$p\""));
    assert!(!command.contains("upload-pack"));
}
