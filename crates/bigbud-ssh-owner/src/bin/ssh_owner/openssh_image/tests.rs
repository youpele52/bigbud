#![allow(clippy::panic_in_result_fn)] // Test assertions report failures while I/O errors propagate.

use super::*;
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> io::Result<Self> {
        let root = std::env::temp_dir().join(format!(
            "ssh-image-test-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root)?;
        let this = Self(root);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(this.0.join("bin"))?;
        Ok(this)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn writable_executable(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[test]
fn accepts_only_the_exact_pair_of_system_paths() {
    assert!(accepts_paths(Path::new(SSH), Path::new(KEYSCAN)));
    for invalid in [
        "ssh",
        "/bin/ssh",
        "/usr//bin/ssh",
        "/usr/bin/./ssh",
        KEYSCAN,
    ] {
        assert!(!accepts_paths(Path::new(invalid), Path::new(KEYSCAN)));
    }
    assert!(!accepts_paths(Path::new(SSH), Path::new("ssh-keyscan")));
}

#[test]
fn revalidation_rejects_inode_drift_and_in_place_modification() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let ssh = fixture.0.join("bin/ssh");
    let replacement = fixture.0.join("replacement");
    writable_executable(&ssh, b"synthetic")?;
    let uid = fs::metadata(&fixture.0)?.uid();
    let bind = || inspect(&fixture.0, &ssh, |_| uid).map_err(|_| io::Error::other("bind rejected"));
    let binding = bind()?;
    assert_eq!(binding.revalidate(&fixture.0, &ssh, |_| uid), Ok(()));
    writable_executable(&replacement, b"synthetic")?;
    fs::rename(replacement, &ssh)?;
    assert_eq!(
        binding.revalidate(&fixture.0, &ssh, |_| uid),
        Err(UNAVAILABLE)
    );
    let binding = bind()?;
    fs::write(&ssh, b"different synthetic image")?;
    assert_eq!(
        binding.revalidate(&fixture.0, &ssh, |_| uid),
        Err(UNAVAILABLE)
    );
    Ok(())
}

#[test]
fn refuses_symlinks_and_unprotected_executable_paths() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let bin = fixture.0.join("bin");
    let ssh = bin.join("ssh");
    let outside = fixture.0.join("outside");
    writable_executable(&outside, b"synthetic")?;
    let uid = fs::metadata(&fixture.0)?.uid();
    symlink(&outside, &ssh)?;
    assert!(matches!(
        inspect(&fixture.0, &ssh, |_| uid),
        Err(UNAVAILABLE)
    ));
    fs::remove_file(&ssh)?;
    fs::rename(outside, &ssh)?;
    assert!(inspect(&fixture.0, &ssh, |_| uid).is_ok());
    fs::set_permissions(&ssh, fs::Permissions::from_mode(0o600))?;
    assert!(matches!(
        inspect(&fixture.0, &ssh, |_| uid),
        Err(UNAVAILABLE)
    ));
    fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700))?;
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o720))?;
    assert!(matches!(
        inspect(&fixture.0, &ssh, |_| uid),
        Err(UNAVAILABLE)
    ));
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700))?;
    let renamed = fixture.0.join("old-bin");
    fs::rename(&bin, &renamed)?;
    symlink(renamed, &bin)?;
    assert!(matches!(
        inspect(&fixture.0, &ssh, |_| uid),
        Err(UNAVAILABLE)
    ));
    Ok(())
}
