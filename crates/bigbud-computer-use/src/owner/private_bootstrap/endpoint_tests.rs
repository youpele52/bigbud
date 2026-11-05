#![allow(clippy::unwrap_used)]
use super::{
    acl,
    child::ChildBootstrap,
    directory::{self, Directory},
    endpoint::Endpoint,
    exchange::ParentExchange,
    io::write_all,
    route::Route,
};
use crate::{
    Role,
    worker::{ExecutionRoot, unix::inspect},
};
use std::{
    fs,
    io::{self, Read},
    num::NonZeroU32,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{PermissionsExt, symlink},
            net::UnixStream,
        },
    },
    time::{Duration, Instant},
};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
fn root() -> ExecutionRoot {
    let pid = NonZeroU32::new(std::process::id()).unwrap();
    ExecutionRoot {
        pid,
        creation_identity: inspect(pid).unwrap().creation,
        generation: "endpoint-1".into(),
    }
}
fn routed(
    endpoint: &Endpoint,
    route: &Route,
    expected: ExecutionRoot,
) -> (crate::owner::BootstrapCapability, ChildBootstrap) {
    let end = deadline();
    let (parent, child) = ParentExchange::pair(end).unwrap();
    assert_eq!(endpoint.directory.nonce, route.nonce);
    let cap = parent
        .deliver_routed(expected, Role::Worker, route)
        .unwrap();
    (cap, ChildBootstrap::read(child, end).unwrap())
}

#[test]
fn private_endpoint_courier_and_exact_peer_authentication_compose() {
    let endpoint = Endpoint::create(deadline()).unwrap();
    let path = endpoint.directory.path().unwrap();
    let leaf = path.parent().unwrap().to_owned();
    let route = Route::current(endpoint.directory.nonce).unwrap();
    let (mut cap, child) = routed(&endpoint, &route, root());
    let child = child.connect().unwrap();
    let peer = cap
        .authenticate_stream(endpoint.accept(deadline()).unwrap())
        .unwrap();
    assert_eq!(peer.execution_root(), &root());
    crate::owner::unix_peer::ensure_private_fd(&child).unwrap();
    assert!(!path.exists());
    assert!(!leaf.exists());
}

#[test]
fn wrong_parent_pid_or_birth_never_receives_secret() {
    for wrong_pid in [true, false] {
        let endpoint = Endpoint::create(deadline()).unwrap();
        let mut route = Route::current(endpoint.directory.nonce).unwrap();
        if wrong_pid {
            route.pid = NonZeroU32::new(route.pid.get() + 1).unwrap();
        } else {
            route.creation.push_str("-wrong");
        }
        let (_cap, child) = routed(&endpoint, &route, root());
        assert!(child.connect().is_err());
        let mut peer = endpoint.accept(deadline()).unwrap();
        peer.set_nonblocking(true).unwrap();
        assert_eq!(
            peer.read(&mut [0; 64]).unwrap(),
            0,
            "credential leaked before server identity check"
        );
    }
}

#[test]
fn valid_route_cannot_override_exact_child_lifetime() {
    for wrong_pid in [true, false] {
        let endpoint = Endpoint::create(deadline()).unwrap();
        let route = Route::current(endpoint.directory.nonce).unwrap();
        let mut expected = root();
        if wrong_pid {
            expected.pid = NonZeroU32::new(expected.pid.get() + 1).unwrap();
        } else {
            expected.creation_identity.push_str("-wrong");
        }
        let (mut cap, child) = routed(&endpoint, &route, expected);
        let _child = child.connect().unwrap();
        assert!(
            cap.authenticate_stream(endpoint.accept(deadline()).unwrap())
                .is_err()
        );
    }
}

#[test]
fn deadline_closes_listener_and_removes_only_owned_leaf() {
    let endpoint = Endpoint::create(deadline()).unwrap();
    let path = endpoint.directory.path().unwrap();
    assert_eq!(
        endpoint.accept(Instant::now()).err().unwrap().kind(),
        io::ErrorKind::TimedOut
    );
    assert!(!path.parent().unwrap().exists());
    assert!(Endpoint::create(Instant::now()).is_err());
}

#[test]
fn silent_accept_is_bounded_by_original_deadline() {
    let endpoint = Endpoint::create(deadline()).unwrap();
    let path = endpoint.directory.path().unwrap();
    let end = Instant::now() + Duration::from_millis(25);
    assert_eq!(
        endpoint.accept(end).err().unwrap().kind(),
        io::ErrorKind::TimedOut
    );
    assert!(!path.parent().unwrap().exists());
}

#[test]
fn failed_bind_never_unlinks_preexisting_name() {
    let directory = Directory::create().unwrap();
    let path = directory.path().unwrap();
    fs::write(&path, b"preexisting").unwrap();
    assert!(Endpoint::bind(directory, deadline()).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"preexisting");
    fs::remove_file(&path).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
}

#[test]
fn completed_cleanup_never_revisits_a_reused_name() {
    let mut endpoint = Endpoint::create(deadline()).unwrap();
    let path = endpoint.directory.path().unwrap();
    let leaf = path.parent().unwrap();
    endpoint.cleanup().unwrap();
    fs::create_dir(leaf).unwrap();
    fs::write(&path, b"new-instance").unwrap();
    endpoint.cleanup().unwrap();
    drop(endpoint);
    assert_eq!(fs::read(&path).unwrap(), b"new-instance");
    fs::remove_file(&path).unwrap();
    fs::remove_dir(leaf).unwrap();
}

#[test]
fn cleanup_never_recursively_removes_unrelated_entries() {
    let mut endpoint = Endpoint::create(deadline()).unwrap();
    let path = endpoint.directory.path().unwrap();
    let unrelated = path.with_file_name("unrelated");
    fs::write(&unrelated, b"keep").unwrap();
    assert!(endpoint.cleanup().is_err());
    assert!(!path.exists());
    assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
    fs::remove_file(&unrelated).unwrap();
    endpoint.cleanup().unwrap();
}

#[test]
fn cleanup_preserves_replacement_socket_and_unrelated_file() {
    let mut endpoint = Endpoint::create(deadline()).unwrap();
    let path = endpoint.directory.path().unwrap();
    let moved = path.with_file_name("saved-peer");
    fs::rename(&path, &moved).unwrap();
    fs::write(&path, b"replacement").unwrap();
    assert!(endpoint.cleanup().is_err());
    assert_eq!(fs::read(&path).unwrap(), b"replacement");
    assert!(moved.exists());
    fs::remove_file(&path).unwrap();
    fs::rename(&moved, &path).unwrap();
    endpoint.cleanup().unwrap();
}

#[test]
fn cleanup_preserves_replacement_directory_and_symlink() {
    let mut endpoint = Endpoint::create(deadline()).unwrap();
    let path = endpoint.directory.path().unwrap();
    let leaf = path.parent().unwrap();
    let moved = leaf.with_extension("test-moved");
    fs::rename(leaf, &moved).unwrap();
    symlink(&moved, leaf).unwrap();
    assert!(endpoint.cleanup().is_err());
    assert!(fs::symlink_metadata(leaf).unwrap().file_type().is_symlink());
    assert!(moved.join("peer").exists());
    fs::remove_file(leaf).unwrap();
    fs::rename(&moved, leaf).unwrap();
    endpoint.cleanup().unwrap();
}

#[test]
fn private_directory_rejects_permissions_owner_and_symlink() {
    let mut directory = Directory::create().unwrap();
    let leaf = directory.path().unwrap().parent().unwrap().to_owned();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(directory.validate().is_err());
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        directory::check_directory(&directory.file, directory::effective_uid() + 1, 0o700).is_err()
    );
    symlink(&leaf, leaf.join("link")).unwrap();
    assert!(directory::open_at(directory.file.as_raw_fd(), c"link").is_err());
    fs::remove_file(leaf.join("link")).unwrap();
    directory.validate().unwrap();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(
        directory::check_directory(&directory.file, directory::effective_uid(), 0o1777).is_err()
    );
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o700)).unwrap();
    directory.cleanup().unwrap();
}

#[test]
fn acl_policy_is_real_and_independent_of_mode_bits() {
    let mut directory = Directory::create().unwrap();
    let leaf = directory.path().unwrap().parent().unwrap().to_owned();
    acl::install_test_acl(&directory.file);
    assert_eq!(
        fs::metadata(&leaf).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(directory.validate().is_err());
    acl::clear_test_acl(&directory.file);
    directory.validate().unwrap();
    directory.cleanup().unwrap();
    struct InvalidFd;
    impl AsRawFd for InvalidFd {
        fn as_raw_fd(&self) -> i32 {
            -1
        }
    }
    assert!(acl::require_empty(&InvalidFd).is_err());
}

#[test]
fn route_read_rejects_truncation_and_retained_writer_without_renewing_deadline() {
    for count in [0, 1, 152] {
        let (sender, receiver) = UnixStream::pair().unwrap();
        write_all(
            &sender,
            &Route::current([0; 16]).unwrap().encode().unwrap()[..count],
            deadline(),
        )
        .unwrap();
        drop(sender);
        assert!(ChildBootstrap::read(receiver, deadline()).is_err());
    }
    let (sender, receiver) = UnixStream::pair().unwrap();
    write_all(&sender, b"BEP1", deadline()).unwrap();
    assert_eq!(
        ChildBootstrap::read(receiver, Instant::now() + Duration::from_millis(25))
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::TimedOut
    );
}
