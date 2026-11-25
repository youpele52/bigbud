use super::Recipe;
use std::fs::{self, DirBuilder, Permissions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn negotiates_two_v2_ls_refs_round_trips_over_live_stdin() {
    let fixture = Fixture::new();
    let repo = fixture.init();
    let before = snapshot(&repo);
    let recipe = fixture.bind(&repo);
    let mut child = run(&recipe)
        .env("GIT_PROTOCOL", "version=0")
        .env("GIT_DIR", "/no-such-git-directory")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();

    // Do not send anything until the capabilities arrive. Then send one
    // request at a time on the same live stream; advertising alone cannot
    // produce either response.
    let capabilities = read_section(&mut output);
    assert_eq!(capabilities[0], b"version 2\n");
    assert!(capabilities.iter().any(|line| line.starts_with(b"fetch=")));
    assert!(
        capabilities
            .iter()
            .any(|line| line.starts_with(b"ls-refs="))
    );
    for _ in 0..2 {
        send_line(&mut input, b"command=ls-refs\n");
        input.write_all(b"0001").unwrap();
        send_line(&mut input, b"symrefs\n");
        send_line(&mut input, b"unborn\n");
        input.write_all(b"0000").unwrap();
        assert_eq!(
            read_section(&mut output),
            [b"unborn HEAD symref-target:refs/heads/main\n".to_vec()]
        );
    }
    input.write_all(b"0000").unwrap();
    drop(input);
    assert_eq!(output.read(&mut [0]).unwrap(), 0);
    let exit = child.wait_with_output().unwrap();
    assert!(exit.status.success(), "{exit:?}");
    assert!(exit.stderr.is_empty(), "{exit:?}");
    assert_eq!(snapshot(&repo), before);
}

#[test]
fn denies_missing_symlinked_or_unprotected_repositories() {
    let fixture = Fixture::new();
    let link = fixture.0.join("symlink.git");
    let links_recipe = fixture.bind(&link);
    denied(&links_recipe);
    let repo = fixture.init();
    symlink(&repo, &link).unwrap();
    denied(&links_recipe);

    let recipe = fixture.bind(&repo);
    for path in [&fixture.0, &repo, &repo.join("objects/pack")] {
        let original = fs::metadata(path).unwrap().permissions();
        fs::set_permissions(path, Permissions::from_mode(0o777)).unwrap();
        denied(&recipe);
        fs::set_permissions(path, original).unwrap();
    }

    let alias = fixture.0.with_file_name(format!(
        "{}alias",
        fixture.0.file_name().unwrap().to_str().unwrap()
    ));
    symlink(&fixture.0, &alias).unwrap();
    let alias_repo = alias.join(repo.file_name().unwrap());
    let alias_recipe = Recipe::new(as_str(&alias), as_str(&alias_repo)).unwrap();
    denied(&alias_recipe);
    fs::remove_file(alias).unwrap();
}

#[test]
fn denies_unchecked_config_links_hooks_and_object_storage_before_protocol_output() {
    let fixture = Fixture::new();
    let repo = fixture.init();
    let recipe = fixture.bind(&repo);
    let config = repo.join("config");
    let original = fs::read(&config).unwrap();
    let mut unchecked = original.clone();
    unchecked.extend_from_slice(b"[include]\n\tpath = /dev/null\n");
    fs::write(&config, unchecked).unwrap();
    denied(&recipe);
    fs::write(&config, original).unwrap();

    let duplicate = fixture.0.join("linked-config");
    fs::hard_link(&config, &duplicate).unwrap();
    denied(&recipe);
    fs::remove_file(duplicate).unwrap();

    for relative in [
        ".git",
        "commondir",
        "objects/info/alternates",
        "objects/info/http-alternates",
        "refs/heads/unexpected",
    ] {
        let file = repo.join(relative);
        fs::write(&file, b"fixture rejection sentinel\n").unwrap();
        denied(&recipe);
        fs::remove_file(file).unwrap();
    }

    let hooks = repo.join("hooks");
    fs::create_dir(&hooks).unwrap();
    denied(&recipe);
    fs::remove_dir(&hooks).unwrap();

    let info = repo.join("objects/info");
    fs::remove_dir(&info).unwrap();
    symlink(&fixture.0, &info).unwrap();
    denied(&recipe);
}

fn send_line(out: &mut impl Write, bytes: &[u8]) {
    write!(out, "{:04x}", bytes.len() + 4).unwrap();
    out.write_all(bytes).unwrap();
}

fn read_section(input: &mut impl Read) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    loop {
        let mut header = [0; 4];
        input.read_exact(&mut header).unwrap();
        let size = usize::from_str_radix(std::str::from_utf8(&header).unwrap(), 16).unwrap();
        if size == 0 {
            return lines;
        }
        assert!((4..=65_520).contains(&size));
        let mut line = vec![0; size - 4];
        input.read_exact(&mut line).unwrap();
        lines.push(line);
    }
}

fn run(recipe: &Recipe) -> Command {
    let mut command = Command::new("/bin/sh");
    command.env_clear().args(["-c", recipe.command()]);
    command
}

fn denied(recipe: &Recipe) {
    let output = run(recipe).output().unwrap();
    assert_eq!(output.status.code(), Some(126), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
}

fn snapshot(path: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
    let mut entries: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    let mut snapshot_entries = Vec::new();
    for entry in entries {
        if entry.is_dir() {
            snapshot_entries.extend(snapshot(&entry));
            snapshot_entries.push((entry, None));
        } else {
            let bytes = fs::read(&entry).unwrap();
            snapshot_entries.push((entry, Some(bytes)));
        }
    }
    snapshot_entries
}

fn as_str(path: &Path) -> &str {
    path.to_str().unwrap()
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = PathBuf::from(format!(
            "/tmp/bigbud-picker-linux-Upload{}x{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }

    fn init(&self) -> PathBuf {
        let repo = self.0.join("fixture's $(literal); repository");
        let output = Command::new("/usr/bin/git")
            .env_clear()
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "init",
                "--bare",
                "--template=",
                "--initial-branch=main",
                "--object-format=sha1",
            ])
            .arg(&repo)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        repo
    }

    fn bind(&self, repo: &Path) -> Recipe {
        Recipe::new(as_str(&self.0), as_str(repo)).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
