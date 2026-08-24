use std::io::BufReader;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};

fn temporary_state_path() -> std::path::PathBuf {
    static NEXT_STATE_PATH: AtomicU64 = AtomicU64::new(0);
    let suffix = NEXT_STATE_PATH.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "bigbud-ephemeral-agent-{}-{suffix}",
        std::process::id()
    ))
}

#[test]
fn ephemeral_mode_handshakes_exits_on_eof_and_writes_no_state() {
    let state_path = temporary_state_path();
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
        .arg("--ephemeral")
        .env("BIGBUD_AGENT_STATE_DIR", &state_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let hello = v1::Frame {
        payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "ephemeral-test".to_owned(),
            connection_id: "connection-1".to_owned(),
            server_nonce: "nonce-1".to_owned(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        })),
    };
    write_frame(
        child.stdin.as_mut().unwrap(),
        &hello,
        DEFAULT_MAX_FRAME_BYTES,
    )
    .unwrap();
    let response = read_frame(
        &mut BufReader::new(child.stdout.take().unwrap()),
        DEFAULT_MAX_FRAME_BYTES,
    )
    .unwrap()
    .unwrap();
    let Some(v1::frame::Payload::AgentHello(agent)) = response.payload else {
        panic!("expected agent hello");
    };
    assert!(
        agent
            .capabilities
            .iter()
            .any(|capability| capability.name == "workspace.watch")
    );

    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "agent did not exit after stdin EOF"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!state_path.exists());
}

#[test]
fn check_mode_reports_protocol_identity() {
    let output = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
        .arg("--check")
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with("bigbud-remote-agent\t"));
    assert!(stdout.contains(&format!("\t{PROTOCOL_MAJOR}\t{PROTOCOL_MINOR}\t")));
}
