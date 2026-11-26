use super::*;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::{fs::DirBuilder, io::Write};

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn dir(name: &str) -> Dir {
    let root = std::env::temp_dir().join(format!("bb-connector-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    DirBuilder::new().mode(0o700).create(&root).unwrap();
    Dir(root)
}

fn helper(dir: &Path, body: &[u8]) -> PathBuf {
    let path = dir.join("nc");
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .unwrap()
        .write_all(body)
        .unwrap();
    path
}

#[test]
fn resolves_only_the_approved_image_and_never_searches_past_a_substitute() {
    let (good, marker) = (dir("good"), dir("marker"));
    let qualified = helper(&good.0, b"#!/bin/sh\nexit 0\n");
    let substitute = helper(&marker.0, b"#!/bin/sh\ntouch marker\n");
    let image: [u8; 32] = Sha256::digest(b"#!/bin/sh\nexit 0\n").into();
    let approve = |path: Vec<PathBuf>| ConnectorApproval::new(image, path).unwrap();

    let pinned = qualify(
        &ConnectorProgram::Bare,
        Some(&approve(vec![good.0.clone()])),
    )
    .unwrap();
    assert_eq!(pinned.path, qualified);
    assert_eq!(pinned.revalidate(), Ok(()));
    // A substituted helper earlier on PATH stops resolution; no fallback search.
    let shadowed = approve(vec![marker.0.clone(), good.0.clone()]);
    assert_eq!(
        qualify(&ConnectorProgram::Bare, Some(&shadowed)).err(),
        Some(UNAVAILABLE)
    );
    assert_eq!(
        qualify(&ConnectorProgram::Absolute(substitute), Some(&shadowed)).err(),
        Some(UNAVAILABLE)
    );
    assert_eq!(
        qualify(&ConnectorProgram::Bare, None).err(),
        Some(UNAVAILABLE)
    );
    assert_eq!(
        qualify(
            &ConnectorProgram::Bare,
            Some(&approve(vec![dir("empty").0.clone()]))
        )
        .err(),
        Some(UNAVAILABLE)
    );
    // Revalidation catches a writable or replaced image before launch.
    fs::set_permissions(&qualified, fs::Permissions::from_mode(0o722)).unwrap();
    assert_eq!(pinned.revalidate(), Err(UNAVAILABLE));
    assert!(pinned.spawn("127.0.0.1", 9).is_err());
    fs::set_permissions(&qualified, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(pinned.revalidate(), Ok(()));
    fs::remove_file(&qualified).unwrap();
    helper(&good.0, b"#!/bin/sh\nexit 0\n");
    assert_eq!(pinned.revalidate(), Err(UNAVAILABLE));
    assert!(!marker.0.join("marker").exists());
    assert!(ConnectorApproval::new(image, vec!["relative".into()]).is_err());
}
