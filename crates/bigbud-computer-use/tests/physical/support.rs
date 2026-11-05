#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Private test fixtures only.
use crate::worker::unix::{AnchoredGroup, BootstrapError, inspect};
use std::{
    fs, io,
    path::PathBuf,
    process::{Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
pub(super) const LIMIT: Duration = Duration::from_secs(15);
pub(super) fn deadline() -> Instant {
    Instant::now() + LIMIT
}
pub(super) fn until(deadline: Instant, mut condition: impl FnMut() -> bool) {
    loop {
        if condition() {
            return;
        }
        assert!(Instant::now() < deadline, "dummy case deadline");
        thread::sleep(Duration::from_millis(5));
    }
}
pub(super) struct Root(pub(super) PathBuf);
impl Root {
    pub(super) fn new() -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let mut random = [0_u8; 16];
        // SAFETY: bounded writable random storage, no caller secret or state.
        unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()) };
        let suffix = random
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("bigbud-approved-dummy-{suffix}"));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        for leaf in ["home", "tmp"] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(path.join(leaf))
                .unwrap();
        }
        Self(path)
    }
    pub(super) fn command(&self, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "physical::dummy_entry",
                "--ignored",
                "--test-threads=1",
            ])
            .env_clear()
            .env("BIGBUD_APPROVED_DUMMY", "private-fixture-v1")
            .env("BIGBUD_DUMMY_MODE", mode)
            .env("BIGBUD_DUMMY_ROOT", &self.0)
            .env("HOME", self.0.join("home"))
            .env("TMPDIR", self.0.join("tmp"))
            .current_dir(&self.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        // Only a create-exclusive random private fixture root, no supplied path.
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("private dummy root cleanup failed: {}", error.kind());
            if !thread::panicking() {
                panic!("private dummy root cleanup failed");
            }
        }
    }
}
pub(super) struct Dummy {
    anchor: Option<AnchoredGroup>,
    pub(super) cleaned: Arc<Mutex<Option<bool>>>,
}
impl Dummy {
    pub(super) fn spawn(mut command: Command) -> Self {
        let result = AnchoredGroup::spawn_bootstrap(
            &mut command,
            "dummy-1",
            &crate::worker::unix::LaunchGuard::acquire().unwrap(),
        );
        drop(command); // close ALL parent's inherited courier duplicates promptly
        let anchor = match result {
            Ok(anchor) => anchor,
            Err(BootstrapError::BeforeSpawn(error)) => panic!("dummy spawn: {}", error.kind()),
            Err(BootstrapError::Unsettled(mut failure)) => {
                // Sole unreaped Child, no descendants in these fixtures. Validate
                // native direct-child/group identity before emergency cleanup.
                let pid = std::num::NonZeroU32::new(failure.child.id()).unwrap();
                let identity = inspect(pid).expect("retain failed dummy identity");
                assert_eq!(identity.parent, std::process::id());
                assert_eq!(identity.group, pid.get());
                failure.child.kill().expect("kill exact failed dummy");
                let end = Instant::now() + Duration::from_secs(5);
                until(end, || {
                    failure
                        .child
                        .try_wait()
                        .expect("reap failed dummy")
                        .is_some()
                });
                panic!("dummy retention failed: {}", failure.error.kind());
            }
        };
        let result = Self {
            anchor: Some(anchor),
            cleaned: Arc::new(Mutex::new(None)),
        };
        let current = inspect(result.anchor().root().pid).unwrap();
        assert_eq!(current.parent, std::process::id());
        assert_eq!(current.group, result.anchor().root().pid.get());
        assert_eq!(current.creation, result.anchor().root().creation_identity);
        result
    }
    /// Removes the exact owner from fixture cleanup (settle/drop cases).
    pub(super) fn take(mut self) -> AnchoredGroup {
        self.anchor.take().unwrap()
    }
    pub(super) fn anchor(&self) -> &AnchoredGroup {
        self.anchor.as_ref().unwrap()
    }
    pub(super) fn anchor_mut(&mut self) -> &mut AnchoredGroup {
        self.anchor.as_mut().unwrap()
    }
    pub(super) fn reap(mut self) -> io::Result<ExitStatus> {
        self.cleanup()
    }
    fn cleanup(&mut self) -> io::Result<ExitStatus> {
        let result = self
            .anchor
            .as_mut()
            .unwrap()
            .reap_dummy_for_test(Instant::now() + Duration::from_secs(5));
        *self.cleaned.lock().unwrap() = Some(result.is_ok());
        if result.is_ok() {
            self.anchor.take();
        }
        result
    }
}
impl Drop for Dummy {
    fn drop(&mut self) {
        if self.anchor.is_some() && self.cleanup().is_err() {
            // Keep this failure explicit. No wildcard wait/signal fallback or
            // production authority weakening is permitted. Dummy self-expires.
            eprintln!("exact-owned dummy cleanup failed");
            if !thread::panicking() {
                panic!("exact-owned dummy cleanup failed");
            }
        }
    }
}
