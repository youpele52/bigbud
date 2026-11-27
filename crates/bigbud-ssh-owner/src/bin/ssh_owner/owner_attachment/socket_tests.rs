use std::{
    fs,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::PathBuf,
};

use super::{OwnedSocket, effective_uid};

struct PrivateDir(PathBuf);

impl PrivateDir {
    fn new(label: &str) -> Self {
        let base = fs::canonicalize(std::env::temp_dir()).expect("temp dir");
        let path = base.join(format!("bbso-attach-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).expect("create private dir");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("0700");
        Self(path)
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// W6 regression: a SIGTERM'd surviving owner leaves `owner.sock`; every later owner
// refused to bind it and SSH stayed unavailable until the file was removed by hand.
#[test]
fn a_stale_socket_without_a_listener_is_replaced() {
    let dir = PrivateDir::new("stale");
    let path = dir.0.join("owner.sock");
    drop(UnixListener::bind(&path).expect("bind stale"));
    assert!(
        path.exists(),
        "dropping a std listener leaves the path behind"
    );
    let (_socket, _listener) = OwnedSocket::bind(&path, effective_uid()).expect("rebind");
}

#[test]
fn a_live_socket_is_never_replaced() {
    let dir = PrivateDir::new("live");
    let path = dir.0.join("owner.sock");
    let _live = UnixListener::bind(&path).expect("bind live");
    let error = OwnedSocket::bind(&path, effective_uid())
        .err()
        .expect("refused");
    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
}

#[test]
fn a_regular_file_at_the_path_is_never_removed() {
    let dir = PrivateDir::new("file");
    let path = dir.0.join("owner.sock");
    fs::write(&path, b"not a socket").expect("write file");
    let error = OwnedSocket::bind(&path, effective_uid())
        .err()
        .expect("refused");
    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&path).expect("kept"), b"not a socket");
}
