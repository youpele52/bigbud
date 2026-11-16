//! Digest proof cached only while the exact kernel metadata remains unchanged.
use super::super::{Result, ServiceError, files};
use std::os::unix::fs::MetadataExt;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
type Stamp = (u64, u64, u32, u32, u64, u64, i64, i64, i64, i64);
fn stamp(metadata: &std::fs::Metadata) -> Stamp {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.uid(),
        metadata.mode(),
        metadata.nlink(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}
struct Pin {
    path: PathBuf,
    sha256: String,
    stamp: Stamp,
}
#[derive(Default)]
pub(super) struct ExecutablePin(Mutex<Option<Pin>>);
impl ExecutablePin {
    pub(super) fn require(&self, pid: u32, path: &Path, sha256: &str) -> Result<()> {
        let process = PathBuf::from(format!("/proc/{pid}/exe"));
        let mapped = std::fs::metadata(&process)?;
        let named = std::fs::symlink_metadata(path)?;
        if !named.is_file()
            || std::fs::canonicalize(&process)? != path
            || mapped.dev() != named.dev()
            || mapped.ino() != named.ino()
        {
            return Err(ServiceError::Invalid(
                "backend controller executable changed",
            ));
        }
        let observed = stamp(&named);
        let mut cache = self.0.lock().map_err(|_| ServiceError::Manager)?;
        if !cache
            .as_ref()
            .is_some_and(|pin| pin.path == path && pin.sha256 == sha256 && pin.stamp == observed)
        {
            files::hash_file(path, sha256, files::FileKind::Executable)?;
            if stamp(&std::fs::symlink_metadata(path)?) != observed {
                return Err(ServiceError::Invalid(
                    "backend executable changed during pin verification",
                ));
            }
            *cache = Some(Pin {
                path: path.into(),
                sha256: sha256.into(),
                stamp: observed,
            });
        }
        if stamp(&std::fs::metadata(process)?) != observed {
            return Err(ServiceError::Invalid("mapped backend executable changed"));
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    struct OwnedProcess {
        child: std::process::Child,
        root: PathBuf,
    }
    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            let _kill = self.child.kill();
            let _reaped = self.child.wait();
            let _removed = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    #[allow(clippy::unwrap_used)]
    fn cached_digest_never_accepts_changed_mode_or_same_path_replacement() {
        let root = std::env::temp_dir().join(format!("lease-node-pin-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let path = root.join("node");
        std::fs::copy("/bin/sleep", &path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let digest = format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()));
        let child = std::process::Command::new(&path).arg("20").spawn().unwrap();
        let process = OwnedProcess { child, root };
        let pin = ExecutablePin::default();
        pin.require(process.child.id(), &path, &digest).unwrap();
        assert!(
            pin.require(process.child.id(), &path, &"0".repeat(64))
                .is_err()
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(pin.require(process.child.id(), &path, &digest).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        pin.require(process.child.id(), &path, &digest).unwrap();
        std::fs::rename(&path, process.root.join("original")).unwrap();
        std::fs::copy("/bin/sleep", &path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(pin.require(process.child.id(), &path, &digest).is_err());
    }
}
