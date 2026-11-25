use super::Recipe;

const REFERENCE: &str = "refs/heads/topic/approved";
const SHA1: &str = "1234567890123456789012345678901234567890";

#[test]
fn binds_the_exact_initiating_tuple() {
    let root = "/fixture/root";
    let path = "/fixture/root/repo.git";
    let recipe = Recipe::new(root, path, REFERENCE, SHA1).unwrap();
    assert!(recipe.matches_binding(path, REFERENCE, SHA1));
    assert!(!recipe.matches_binding("/fixture/root/other.git", REFERENCE, SHA1));
    assert!(!recipe.matches_binding(path, "refs/heads/other", SHA1));
    assert!(!recipe.matches_binding(path, REFERENCE, &"f".repeat(40)));
    assert!(!recipe.command().contains(REFERENCE));
    assert!(!recipe.command().contains(SHA1));
}

#[test]
fn rejects_ambiguous_paths_and_invalid_refs_and_oids() {
    let root = "/fixture/root";
    let path = "/fixture/root/repo.git";
    for invalid in [
        root,
        "/fixture/rooted/repo.git",
        "/fixture/root/../repo.git",
        "/fixture/root/./repo.git",
        "/fixture/root/sub//repo.git",
        "/fixture/root/repo.git/",
        "/fixture/root/repo\0.git",
        "fixture/root/repo.git",
        "//fixture/root/repo.git",
    ] {
        assert!(
            Recipe::new(root, invalid, REFERENCE, SHA1).is_err(),
            "{invalid:?}"
        );
    }
    assert!(Recipe::new("/", path, REFERENCE, SHA1).is_err());
    assert!(Recipe::new("/fixture/./root", path, REFERENCE, SHA1).is_err());
    for invalid in [
        "refs/tags/topic",
        "HEAD",
        "refs/heads/",
        "refs/heads//topic",
        "refs/heads/.topic",
        "refs/heads/topic.lock/branch",
        "refs/heads/topic.",
        "refs/heads/a..b",
        "refs/heads/a@{b}",
        "refs/heads/a b",
        "refs/heads/a:b",
        "refs/heads/a\nb",
    ] {
        assert!(
            Recipe::new(root, path, invalid, SHA1).is_err(),
            "{invalid:?}"
        );
    }
    for invalid in ["abcd", &"0".repeat(40), &"A".repeat(40), &"g".repeat(64)] {
        assert!(
            Recipe::new(root, path, REFERENCE, invalid).is_err(),
            "{invalid:?}"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod command {
    use super::*;
    use std::fs::{self, DirBuilder, File, Permissions};
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const SHA256: &str = concat!(
        "0123456789abcdef0123456789abcdef",
        "fedcba9876543210fedcba9876543210"
    );

    #[test]
    fn advertises_an_empty_fixture_without_using_client_input_or_ambient_git_config() {
        for (object_format, oid) in [("sha1", SHA1), ("sha256", SHA256)] {
            let fixture = Fixture::new();
            let repo = fixture.root.join("$(exit 99) repo's.git");
            init(&repo, object_format);
            let before = snapshot(&repo);
            let recipe = fixture.bind(&repo, oid);
            let input = fixture.base.join("input");
            fs::write(&input, b"this is not Git protocol input\x00\xff\n").unwrap();
            let actual = run(&recipe)
                .env("GIT_DIR", "/no-such-git-directory")
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "receive.advertiseAtomic")
                .env("GIT_CONFIG_VALUE_0", "false")
                .stdin(File::open(input).unwrap())
                .output()
                .unwrap();
            assert!(actual.status.success(), "{actual:?}");
            assert!(actual.stderr.is_empty(), "{actual:?}");
            let capabilities = format!("object-format={object_format}");
            assert!(
                actual
                    .stdout
                    .windows(capabilities.len())
                    .any(|bytes| bytes == capabilities.as_bytes())
            );
            assert!(actual.stdout.ends_with(b"0000"));
            assert_eq!(snapshot(&repo), before);
        }
    }

    #[test]
    fn rejects_symlinks_at_root_intermediate_and_target_levels() {
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside.git");
        init(&outside, "sha1");
        let escaped = fixture.root.join("escaped.git");
        symlink(&outside, &escaped).unwrap();
        denied(&fixture.bind(&escaped, SHA1));

        let root_alias = fixture.base.join("alias");
        symlink(&fixture.root, &root_alias).unwrap();
        init(&fixture.root.join("repo.git"), "sha1");
        let alias = root_alias.join("repo.git");
        denied(&Recipe::new(as_str(&root_alias), as_str(&alias), REFERENCE, SHA1).unwrap());

        let nested = fixture.root.join("nested");
        fs::create_dir(&nested).unwrap();
        init(&nested.join("repo.git"), "sha1");
        let middle_alias = fixture.root.join("middle-alias");
        symlink(&nested, &middle_alias).unwrap();
        denied(&fixture.bind(&middle_alias.join("repo.git"), SHA1));
    }

    #[test]
    fn rejects_unprotected_paths_and_missing_or_indirect_repositories() {
        let fixture = Fixture::new();
        let repo = fixture.root.join("repo.git");
        let recipe = fixture.bind(&repo, SHA1);
        denied(&recipe);
        init(&repo, "sha1");
        fs::set_permissions(&fixture.root, Permissions::from_mode(0o755)).unwrap();
        denied(&recipe);
        fs::set_permissions(&fixture.root, Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&repo, Permissions::from_mode(0o777)).unwrap();
        denied(&recipe);
        fs::set_permissions(&repo, Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(repo.join("objects/pack"), Permissions::from_mode(0o777)).unwrap();
        denied(&recipe);
        let worktree = fixture.root.join("worktree");
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", repo.display()),
        )
        .unwrap();
        denied(&fixture.bind(&worktree, SHA1));
    }

    #[test]
    fn rejects_non_fixture_git_metadata_before_advertising() {
        let fixture = Fixture::new();
        let repo = fixture.root.join("repo.git");
        init(&repo, "sha1");
        let recipe = fixture.bind(&repo, SHA1);
        let config = repo.join("config");
        let mut with_include = fs::read(&config).unwrap();
        with_include.extend_from_slice(b"[include]\n\tpath = /dev/null\n");
        fs::write(&config, with_include).unwrap();
        denied(&recipe);

        fs::remove_dir_all(&repo).unwrap();
        init(&repo, "sha1");
        let duplicate = fixture.base.join("linked-config");
        fs::hard_link(&config, &duplicate).unwrap();
        denied(&recipe);
        fs::remove_file(&duplicate).unwrap();

        let info = repo.join("objects/info");
        fs::write(info.join("alternates"), b"/outside/objects\n").unwrap();
        denied(&recipe);
        fs::remove_dir_all(&info).unwrap();
        symlink(&fixture.root, &info).unwrap();
        denied(&recipe);
    }

    fn run(recipe: &Recipe) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .env_clear()
            .args(["-c", recipe.command()])
            .stdin(Stdio::null());
        command
    }

    fn denied(recipe: &Recipe) {
        let output = run(recipe).output().unwrap();
        assert_eq!(output.status.code(), Some(126), "{output:?}");
        assert!(output.stdout.is_empty(), "{output:?}");
    }

    fn init(repo: &Path, object_format: &str) {
        let Output { status, stderr, .. } = Command::new("/usr/bin/git")
            .env_clear()
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "init",
                "--bare",
                "--template=",
                "--initial-branch=main",
                &format!("--object-format={object_format}"),
            ])
            .arg(repo)
            .output()
            .unwrap();
        assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    }

    fn snapshot(path: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
        let mut entries: Vec<_> = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        entries
            .into_iter()
            .flat_map(|entry| {
                if entry.is_dir() {
                    let nested = snapshot(&entry);
                    let mut contents = vec![(entry, None)];
                    contents.extend(nested);
                    contents
                } else {
                    let bytes = fs::read(&entry).unwrap();
                    vec![(entry, Some(bytes))]
                }
            })
            .collect()
    }

    fn as_str(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let base = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "bigbud-git-receive-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            DirBuilder::new().mode(0o700).create(&base).unwrap();
            let root = base.join("private fixture");
            DirBuilder::new().mode(0o700).create(&root).unwrap();
            Self { base, root }
        }

        fn bind(&self, repo: &Path, oid: &str) -> Recipe {
            Recipe::new(as_str(&self.root), as_str(repo), REFERENCE, oid).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }
}
