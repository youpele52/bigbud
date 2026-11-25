use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) struct Fixture(pub(super) PathBuf);

impl Fixture {
    pub(super) fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "bigbud-ssh-workspace-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create isolated workspace fixture");
        // The remote recipe denies symlinks even in OS temp-directory ancestors.
        Self(path.canonicalize().expect("physical fixture path"))
    }

    pub(super) fn root(&self) -> &str {
        self.0.to_str().expect("UTF-8 fixture path")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run(root: &str, relative: &str, read: Read) -> Result<v1::ProofWorkspaceFile, ErrorCode> {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", &read.command(root, relative)]);
    let output = process::run(command, Instant::now() + READ_TIMEOUT, read.capture_limit())
        .map_err(|_| ErrorCode::WorkspaceReadFailed)?;
    read.decode(output)
}

fn range(offset: u64, max_bytes: u32) -> Read {
    Read::Range { offset, max_bytes }
}

#[test]
fn workspace_binding_is_exact_and_rejects_non_normal_paths() {
    let root = Path::new("/fixtures/project");
    let requested = "/fixtures/project";
    assert_eq!(
        validate_path(Some(root), requested, "nested/file.txt", false),
        Ok(requested)
    );
    assert_eq!(
        validate_path(None, requested, "nested/file.txt", false),
        Err(ErrorCode::WorkspacePathDenied)
    );
    for path in [
        "",
        "/etc/passwd",
        ".",
        "a/../b",
        "a/./b",
        "a//b",
        "a/",
        "a\0b",
        "C:foo",
        "C:/foo",
        "\\server\\share",
    ] {
        assert_eq!(
            validate_path(Some(root), requested, path, false),
            Err(ErrorCode::WorkspacePathDenied),
            "{path:?}"
        );
    }
    for unbound in [
        "/fixtures/other",
        "/fixtures/project/",
        "/fixtures/project/nested",
        "/fixtures/./project",
    ] {
        assert_eq!(
            validate_path(Some(root), unbound, "file", false),
            Err(ErrorCode::WorkspacePathDenied)
        );
    }
    for invalid in [
        "relative",
        "/",
        "//fixtures",
        "/a/../b",
        "/a/.hidden/",
        "/a\0b",
    ] {
        assert!(configured_root(Path::new(invalid)).is_none());
    }
}

#[test]
fn workspace_range_limits_fail_before_launch() {
    let select = |offset, max_bytes| Selection::Range(v1::ProofFileRange { offset, max_bytes });
    assert!(Read::from_selection(Some(&select(MAX_SAFE_OFFSET, RANGE_LIMIT))).is_ok());
    for operand in [
        None,
        Some(select(MAX_SAFE_OFFSET + 1, 0)),
        Some(select(0, RANGE_LIMIT + 1)),
    ] {
        assert!(matches!(
            Read::from_selection(operand.as_ref()),
            Err(ErrorCode::InvalidOperands)
        ));
    }
}

#[test]
fn workspace_recipe_round_trips_binary_and_shell_metacharacters() {
    let fixture = Fixture::new();
    let name = "-odd 'quoted' $(exit 7); *\nname\\end";
    let root_name = "root with 'quote'";
    let root = fixture.0.join(root_name);
    fs::create_dir(&root).expect("create quoted workspace root");
    let data = b"\0\xff\nabc\r\0\xc0";
    fs::write(root.join(name), data).expect("write binary fixture");
    let root = root.to_str().expect("UTF-8 fixture path");
    let result = run(root, name, range(1, 4)).expect("read binary range");
    assert_eq!(result.data, b"\xff\nab");
    assert_eq!(result.size_bytes, data.len() as u64);
    assert!(result.truncated);
    let result = run(root, name, range(5, 30)).expect("read short final range");
    assert_eq!(result.data, b"c\r\0\xc0");
    assert!(!result.truncated);
    let result = run(root, name, range(MAX_SAFE_OFFSET, 1)).expect("offset at safe integer bound");
    assert!(result.data.is_empty());
    assert_eq!(result.size_bytes, data.len() as u64);
    assert!(!result.truncated);
    let result = run(root, name, range(0, 0)).expect("metadata-only range");
    assert!(result.data.is_empty());
    assert!(result.truncated);
    assert_eq!(
        run(root, name, Read::Preview),
        Err(ErrorCode::WorkspaceReadFailed)
    );
}

#[test]
fn workspace_range_returns_the_full_maximum_binary_window() {
    let fixture = Fixture::new();
    let data = (0..(RANGE_LIMIT + 3)).map(|i| i as u8).collect::<Vec<_>>();
    fs::write(fixture.0.join("binary"), &data).expect("write binary fixture");
    let result = run(fixture.root(), "binary", range(1, RANGE_LIMIT)).expect("read maximum window");
    assert_eq!(
        result.data,
        data.get(1..1 + RANGE_LIMIT as usize)
            .expect("expected window")
    );
    assert_eq!(result.size_bytes, u64::from(RANGE_LIMIT + 3));
    assert!(result.truncated);
}

#[test]
fn workspace_recipe_denies_symlinks_and_nonregular_targets() {
    let fixture = Fixture::new();
    let root = fixture.0.join("root");
    fs::create_dir(&root).expect("make workspace");
    fs::write(fixture.0.join("outside"), b"outside the workspace").expect("write outside file");
    fs::write(root.join("inside"), b"inside").expect("write inside file");
    symlink(fixture.0.join("outside"), root.join("leaf")).expect("make file symlink");
    symlink("inside", root.join("inside-link")).expect("make in-root symlink");
    symlink(&fixture.0, root.join("ancestor")).expect("make directory symlink");
    symlink(&root, fixture.0.join("linked-root")).expect("make root symlink");
    fs::create_dir(root.join("dir")).expect("make directory target");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(root.join("fifo"))
            .status()
            .expect("make named pipe")
            .success()
    );
    let root = root.to_str().expect("UTF-8 workspace root");
    for path in [
        "leaf",
        "inside-link",
        "ancestor/outside",
        "dir",
        "fifo",
        "absent",
        "inside/child",
    ] {
        assert_eq!(
            run(root, path, range(0, 1)),
            Err(ErrorCode::WorkspacePathDenied),
            "{path}"
        );
    }
    let linked_root = format!("{}/linked-root", fixture.root());
    assert_eq!(
        run(&linked_root, "inside", Read::Preview),
        Err(ErrorCode::WorkspacePathDenied)
    );
}

#[test]
fn workspace_preview_digest_preserves_bom_and_crlf_and_is_absent_for_ranges() {
    let fixture = Fixture::new();
    let bytes = b"\xef\xbb\xbftext\r\n";
    fs::write(fixture.0.join("text"), bytes).expect("write raw text bytes");
    let preview = run(fixture.root(), "text", Read::Preview).expect("complete text preview");
    assert_eq!(preview.data, bytes);
    assert_eq!(preview.sha256, Some(Sha256::digest(bytes).to_vec()));
    let whole_range = run(fixture.root(), "text", range(0, 32)).expect("whole-file range");
    assert_eq!(whole_range.data, bytes);
    assert_eq!(whole_range.sha256, None);
}

#[test]
fn workspace_preview_enforces_exact_size_boundary() {
    let fixture = Fixture::new();
    let file = fixture.0.join("text");
    fs::write(&file, []).expect("write empty text");
    let empty = run(fixture.root(), "text", Read::Preview).expect("preview empty file");
    assert!(empty.data.is_empty());
    assert_eq!(empty.size_bytes, 0);
    assert!(!empty.truncated);
    let bytes = vec![b'x'; PREVIEW_LIMIT];
    fs::write(&file, &bytes).expect("write cap-sized text");
    let exact = run(fixture.root(), "text", Read::Preview).expect("preview exactly 5 MiB");
    assert_eq!(exact.data, bytes);
    assert_eq!(exact.size_bytes, PREVIEW_LIMIT as u64);
    assert!(!exact.truncated);
    fs::OpenOptions::new()
        .write(true)
        .open(file)
        .expect("open text file")
        .set_len((PREVIEW_LIMIT + 1) as u64)
        .expect("extend above cap");
    assert_eq!(
        run(fixture.root(), "text", Read::Preview),
        Err(ErrorCode::WorkspaceFileTooLarge)
    );
}

#[test]
fn workspace_decoder_rejects_inconsistent_or_malformed_output() {
    let read = range(1, 3);
    for bytes in [
        &b"banner\nBIGBUD_WORKSPACE_FILE_V1 4\nabc"[..],
        b"BIGBUD_WORKSPACE_FILE_V1 +4\nabc",
        b"BIGBUD_WORKSPACE_FILE_V1 18446744073709551616\nabc",
        b"BIGBUD_WORKSPACE_FILE_V1 4\nab",
        b"BIGBUD_WORKSPACE_FILE_V1 4\nabcd",
    ] {
        assert_eq!(
            read.parse(bytes.to_vec(), false),
            Err(ErrorCode::WorkspaceReadFailed)
        );
    }
    assert_eq!(
        read.parse(b"BIGBUD_WORKSPACE_FILE_V1 4\nabc".to_vec(), true),
        Err(ErrorCode::WorkspaceReadFailed)
    );
}
