use super::*;
use crate::owner_agent_proxy::git_receive::tracked_push::{RepositoryIdentity, TrackedDestination};
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

const SOURCE: &str = "0123456789abcdef0123456789abcdef01234567";

#[test]
fn launcher_scope_refuses_changed_identity_operands_and_recipes() {
    let fixture = Fixture::new();
    let scope = scope::Scope::new(&fixture.root).unwrap();
    let binding = fixture.binding();
    assert!(scope.matches(&binding));
    let mut wrong = binding.clone();
    wrong.repository.common_dir = binding.repository.worktree.clone();
    assert!(!scope.matches(&wrong));
    let mut wrong = binding.clone();
    wrong.destination.effective_url = "ssh://picker@127.0.0.1/receive.git".into();
    assert!(!scope.matches(&wrong));
    let mut wrong = binding.clone();
    wrong.source_oid = "a".repeat(40);
    assert!(!scope.matches(&wrong));
    let mut wrong = binding;
    wrong.destination.repository_path = "/other.git".into();
    assert!(!scope.matches(&wrong));

    let displaced = fixture.root.join("displaced");
    fs::rename(&fixture.worktree, &displaced).unwrap();
    symlink(displaced, &fixture.worktree).unwrap();
    assert!(scope.revalidate().is_err());
}

#[test]
fn launcher_scope_refuses_ambient_execution_and_external_object_paths() {
    let fixture = Fixture::new();
    let scope = scope::Scope::new(&fixture.root).unwrap();
    for name in [
        "shallow",
        "commondir",
        "config.worktree",
        "objects/info/alternates",
        "objects/pack/pack-test.promisor",
        "refs/heads/another",
    ] {
        let invalid = fixture.git.join(name);
        fs::write(&invalid, b"x\n").unwrap();
        assert!(scope.revalidate().is_err(), "admitted {name}");
        fs::remove_file(invalid).unwrap();
    }
    let hooks = fixture.git.join("hooks");
    fs::create_dir(&hooks).unwrap();
    assert!(scope.revalidate().is_err());
    fs::remove_dir(hooks).unwrap();

    let config = fixture.git.join("config");
    for extra in [
        b"[include]\n\tpath=/dev/null\n".as_slice(),
        b"[remote \"origin\"]\n\tpushurl=ssh://localhost/other.git\n",
        b"[url \"ext::sentinel\"]\n\tinsteadOf=fd::\n",
    ] {
        fs::write(&config, [scope::FIXTURE_CONFIG, extra].concat()).unwrap();
        assert!(scope.revalidate().is_err());
    }
    fs::write(config, scope::FIXTURE_CONFIG).unwrap();
    assert!(scope.revalidate().is_ok());
}

#[test]
fn launcher_scope_binds_preprovisioned_host_pin() {
    let fixture = Fixture::new();
    let scope = scope::Scope::new(&fixture.root).unwrap();
    fs::write(fixture.root.join("known_hosts"), b"replacement pin\n").unwrap();
    assert!(scope.revalidate().is_err());
}

#[test]
fn git_command_has_only_the_private_fd_transport_and_explicit_refspec() {
    let command = git_command(Path::new("/tmp/example"), SOURCE, 11, 13);
    assert_eq!(command.get_program(), "/usr/bin/git");
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(
        args.last().unwrap().to_string_lossy(),
        format!("{SOURCE}:{BRANCH}")
    );
    assert!(args.iter().any(|arg| *arg == "fd::11,13"));
    assert!(args.iter().any(|arg| *arg == "--no-verify"));
    assert!(command.get_envs().any(
        |(key, value)| key == "GIT_ALLOW_PROTOCOL" && value.is_some_and(|value| value == "fd")
    ));
}

#[test]
fn launch_inherits_only_the_selected_transport_pipe_ends() {
    let (extra_read, extra_write) = io::pipe().unwrap();
    let (allowed_read, allowed_write) = io::pipe().unwrap();
    let mut child = Command::new("/bin/sh");
    child.args([
        "-c",
        "[ -p /proc/self/fd/$1 ] && [ -p /proc/self/fd/$2 ] && \
         [ ! -e /proc/self/fd/$3 ] && [ ! -e /proc/self/fd/$4 ]",
        "fixture",
    ]);
    for fd in [
        allowed_read.as_raw_fd(),
        allowed_write.as_raw_fd(),
        extra_read.as_raw_fd(),
        extra_write.as_raw_fd(),
    ] {
        child.arg(fd.to_string());
    }
    isolate(
        &mut child,
        Some((allowed_read.as_raw_fd(), allowed_write.as_raw_fd())),
    );
    assert!(child.status().unwrap().success());
}

#[test]
fn graph_retirement_reserves_the_group_until_reaped() {
    let busy = Arc::new(AtomicBool::new(false));
    let mut graph = graph::Graph::new(Arc::clone(&busy)).unwrap();
    assert!(graph::Graph::new(Arc::clone(&busy)).is_err());
    let mut child = Command::new("/usr/bin/sleep");
    child.arg("60");
    isolate(&mut child, None);
    graph.set_git(child.spawn().unwrap());
    graph.retire(Instant::now(), DestinationReceipt::Unconfirmed);
    let until = Instant::now() + Duration::from_secs(2);
    while busy.load(Ordering::Acquire) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!busy.load(Ordering::Acquire));
}

struct Fixture {
    root: PathBuf,
    worktree: PathBuf,
    git: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = PathBuf::from(format!(
            "/tmp/bigbud-picker-linux-Push{}x{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        let worktree = root.join("client");
        let git = worktree.join(".git");
        let fixture = Self {
            root,
            worktree,
            git,
        };
        for dir in [
            "objects/01",
            "objects/info",
            "objects/pack",
            "refs/heads",
            "refs/tags",
        ] {
            fs::create_dir_all(fixture.git.join(dir)).unwrap();
        }
        fs::write(fixture.git.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
        fs::write(fixture.git.join("refs/heads/main"), format!("{SOURCE}\n")).unwrap();
        fs::write(
            fixture
                .git
                .join("objects/01")
                .join(SOURCE.strip_prefix("01").unwrap()),
            b"object placeholder",
        )
        .unwrap();
        fs::write(fixture.git.join("config"), scope::FIXTURE_CONFIG).unwrap();
        let pin = fixture.root.join("known_hosts");
        fs::write(&pin, b"pin placeholder\n").unwrap();
        fs::set_permissions(pin, fs::Permissions::from_mode(0o600)).unwrap();
        fixture
    }

    fn binding(&self) -> TrackedPushBinding {
        TrackedPushBinding {
            repository: RepositoryIdentity {
                worktree: self.worktree.to_str().unwrap().to_owned(),
                git_dir: self.git.to_str().unwrap().to_owned(),
                common_dir: self.git.to_str().unwrap().to_owned(),
            },
            remote_name: "origin".into(),
            source_ref: BRANCH.into(),
            destination_ref: BRANCH.into(),
            source_oid: SOURCE.into(),
            destination: TrackedDestination {
                effective_url: URL.into(),
                execution_target_id: "ssh:fixture".into(),
                target_generation: "a".repeat(64),
                host: HOST.into(),
                user: USER.into(),
                port: PORT,
                repository_path: REMOTE_PATH.into(),
                expected_old_oid: "b".repeat(40),
            },
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
