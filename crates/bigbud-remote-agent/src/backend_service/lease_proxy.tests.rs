#![allow(clippy::unwrap_used)]
use super::*;
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct SocketFixture {
    root: std::path::PathBuf,
    listener: UnixListener,
}
impl SocketFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bb-managed-proxy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = UnixListener::bind(root.join("peer.sock")).unwrap();
        Self { root, listener }
    }
}
impl Drop for SocketFixture {
    fn drop(&mut self) {
        let _removed = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn bounded_connection_retains_exact_kernel_peer_without_forwarding_stdin() {
    use std::io::Read;
    let fixture = SocketFixture::new();
    let stream = bounded_connect(&fixture.root.join("peer.sock")).unwrap();
    let (mut server, _) = fixture.listener.accept().unwrap();
    server.set_nonblocking(true).unwrap();
    let peer = crate::service_lease::Peer::read(&stream).unwrap();
    assert_eq!(peer.pid(), std::process::id());
    assert!(peer.current().unwrap());
    let mut bytes = [0; 1];
    assert_eq!(
        server.read(&mut bytes).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
#[test]
fn missing_socket_and_oversized_or_nul_paths_refuse_without_input() {
    let fixture = SocketFixture::new();
    assert!(bounded_connect(&fixture.root.join("absent.sock")).is_err());
    assert!(bounded_connect(Path::new(&format!("/{}", "x".repeat(200)))).is_err());
    assert!(bounded_connect(Path::new("/bad\0path")).is_err());
}
#[test]
fn connected_same_uid_process_is_not_sufficient_unit_authority() {
    use crate::backend_service::tests::fixture::Fixture;
    struct WrongUnit;
    impl Manager for WrongUnit {
        fn run(&self, _: &str, _: &[String]) -> Result<String> {
            Ok("MainPID=2\nControlGroup=/user.slice/user-1.slice/user@1.service/fake.service\nFragmentPath=/fake.service\n".into())
        }
    }
    let fixture = SocketFixture::new();
    let stream = bounded_connect(&fixture.root.join("peer.sock")).unwrap();
    let (_server, _) = fixture.listener.accept().unwrap();
    let account = Fixture::new();
    let units = super::super::unit::render_definition(&account.config).unwrap();
    let directory = super::super::unit::unit_directory(&account.config);
    std::fs::create_dir_all(&directory).unwrap();
    for (name, content) in [
        (&units.names.rust, &units.rust),
        (&units.names.backend, &units.backend),
    ] {
        std::fs::write(directory.join(name), content).unwrap();
        std::fs::set_permissions(directory.join(name), std::fs::Permissions::from_mode(0o600))
            .unwrap();
    }
    assert!(
        authenticate(&account.config, &stream, &WrongUnit)
            .unwrap_err()
            .to_string()
            .contains("exact independent user-service")
    );
}
