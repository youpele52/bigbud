#![allow(clippy::unwrap_used)]
use super::*;
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::Instant;

#[test]
fn expected_requires_one_loopback_listen_argument() {
    assert_eq!(expected(&[]).unwrap(), None);
    assert_eq!(
        expected(&["--listen".into(), "127.0.0.1:4774".into()]).unwrap(),
        Some("127.0.0.1:4774".parse().unwrap())
    );
    assert!(expected(&["--listen".into(), "0.0.0.0:4774".into()]).is_err());
    assert!(expected(&["--listen".into(), "not-an-address".into()]).is_err());
    assert!(
        expected(&[
            "--listen".into(),
            "127.0.0.1:4774".into(),
            "--listen".into(),
            "127.0.0.1:4775".into(),
        ])
        .is_err()
    );
    assert!(expected(&["--listen".into()]).is_err());
    assert!(
        expected(&[
            "--listen".into(),
            "127.0.0.1:4774".into(),
            "--listen".into()
        ])
        .is_err()
    );
}

#[test]
fn managed_gateway_launch_requires_a_loopback_listener() {
    let launch = |args| crate::service_lease::process::Launch {
        executable: std::path::PathBuf::from("/gateway"),
        args,
        environment: crate::service_lease::SecretEnvironment(Vec::new()),
        guard: None,
        assets: None,
    };
    assert!(launch(Vec::new()).validate_gateway_readiness().is_err());
    assert!(
        launch(vec!["--listen".into(), "0.0.0.0:4774".into()])
            .validate_gateway_readiness()
            .is_err()
    );
    assert!(
        launch(vec!["--listen".into(), "127.0.0.1:4774".into()])
            .validate_gateway_readiness()
            .is_ok()
    );
}

#[test]
fn readiness_line_is_exact_and_names_the_expected_loopback_address() {
    let expected = "127.0.0.1:4774".parse().unwrap();
    assert_eq!(
        parse_line(br#"{"event":"ready","listen":"127.0.0.1:4774"}"#).unwrap(),
        expected
    );
    assert!(parse_line(br#"{"event":"ready","listen":"0.0.0.0:4774"}"#).is_ok());
    assert!(parse_line(br#"{"event":"ready","listen":"127.0.0.1:4774","pid":1}"#).is_err());
    assert!(parse_line(br#"{"event":"starting","listen":"127.0.0.1:4774"}"#).is_err());
}

#[test]
#[cfg(target_os = "linux")] // Reads /proc listener and descriptor tables.
fn listener_proof_requires_the_socket_inode_in_the_named_child() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let inode = owns_listener(std::process::id(), address).unwrap().unwrap();
    assert_eq!(listener_inode(address).unwrap(), Some(inode));
    assert!(holds_socket(std::process::id(), inode).unwrap());
    drop(listener);
    assert_eq!(owns_listener(std::process::id(), address).unwrap(), None);
}

#[test]
#[cfg(target_os = "linux")] // Reads /proc listener and descriptor tables.
fn original_child_ready_line_requires_its_socket_inode() {
    let (mut child, output_file) = spawn_readiness_child(None);
    let address = wait_for_address(&output_file);
    let mut stdout = child.stdout.take().unwrap();
    let proof = await_child(child.id(), &mut stdout, "127.0.0.1:0".parse().unwrap()).unwrap();
    assert_eq!(proof.address, address);
    assert!(proof.inode != 0);
    assert!(child.wait().unwrap().success());
    std::fs::remove_file(output_file).unwrap();
    assert!(address.port() != 0);
}

#[test]
fn child_cannot_claim_an_unrelated_process_listener() {
    let unrelated = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = unrelated.local_addr().unwrap();
    let (mut child, output_file) = spawn_readiness_child(Some(address));
    wait_for_address(&output_file);
    let mut stdout = child.stdout.take().unwrap();
    assert!(await_child(child.id(), &mut stdout, address).is_err());
    let _ = child.kill();
    let _ = child.wait();
    std::fs::remove_file(output_file).unwrap();
}

#[test]
fn readiness_child_helper() {
    let Ok(output_file) = std::env::var("BIGBUD_READINESS_TEST_FILE") else {
        return;
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::fs::write(&output_file, address.to_string()).unwrap();
    let reported =
        std::env::var("BIGBUD_READINESS_TEST_REPORT").unwrap_or_else(|_| address.to_string());
    use std::io::Write;
    writeln!(
        std::io::stdout(),
        "{{\"event\":\"ready\",\"listen\":\"{reported}\"}}"
    )
    .unwrap();
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(3));
}

fn spawn_readiness_child(report: Option<SocketAddr>) -> (std::process::Child, std::path::PathBuf) {
    let output_file = std::env::temp_dir().join(format!(
        "bigbud-readiness-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "service_lease::process::readiness::tests::readiness_child_helper",
            "--nocapture",
        ])
        .env("BIGBUD_READINESS_TEST_FILE", &output_file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(report) = report {
        command.env("BIGBUD_READINESS_TEST_REPORT", report.to_string());
    }
    (command.spawn().unwrap(), output_file)
}

fn wait_for_address(path: &std::path::Path) -> SocketAddr {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Ok(value) = std::fs::read_to_string(path) {
            return value.parse().unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("readiness child did not publish its bound address");
}
