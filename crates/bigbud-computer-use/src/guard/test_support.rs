use super::record::{EpisodeNotice, NoticeState, PolicyBinding, SafetyRecord};
use crate::worker::ExecutionRoot;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub(crate) struct TestDirectory(pub PathBuf);
impl TestDirectory {
    pub(crate) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bigbud-cua-deterministic-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

pub(crate) fn armed() -> SafetyRecord {
    SafetyRecord {
        armed: true,
        binding: Some(PolicyBinding {
            authority: "authority-1".into(),
            controller_installation: "installation-1".into(),
            profile_generation: "profile-1".into(),
            revision: "42".into(),
            digest: "a".repeat(64),
            migration_binding: "migration-1".into(),
        }),
        notice: Some(EpisodeNotice {
            episode: "episode-1".into(),
            notice: "notice-1".into(),
            state: NoticeState::PresentedUnconfirmed,
        }),
        roots: vec![ExecutionRoot {
            pid: std::num::NonZeroU32::new(42).unwrap(),
            creation_identity: "birth-1".into(),
            generation: "worker-1".into(),
        }],
        ..SafetyRecord::initial()
    }
}
