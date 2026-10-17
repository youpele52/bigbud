#![allow(clippy::unwrap_used, clippy::panic)]
#[path = "reliability.fixture.rs"]
mod fixture;
#[path = "shutdown.tests.rs"]
mod shutdown_tests;
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1};
use fixture::*;
use std::fs;
use std::io;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use std::time::Instant;

struct Rig {
    root: PathBuf,
    socket: PathBuf,
    child: Child,
}
impl Rig {
    fn new(label: &str, barrier_env: Option<&str>) -> Self {
        let root = temp_root(label);
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::create_dir_all(root.join("barrier")).unwrap();
        let socket = root.join("supervisor.sock");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                &lib_test_filter("real_supervisor_helper"),
                "--nocapture",
            ])
            .env("BIGBUD_TEST_REAL_SUPERVISOR_ROOT", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(variable) = barrier_env {
            command.env(variable, root.join("barrier"));
        }
        let child = command.spawn().unwrap();
        wait_for_socket(&socket);
        Self {
            root,
            socket,
            child,
        }
    }
    fn connect(&self) -> (UnixStream, v1::AgentHello) {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(12)))
            .unwrap();
        write_request(
            &mut stream,
            v1::frame::Payload::ClientHello(v1::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                client_instance_id: "reliability".into(),
                connection_id: "connection".into(),
                server_nonce: "nonce".into(),
                max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
            }),
        );
        let v1::frame::Payload::AgentHello(hello) = read_until(&mut stream, |p| {
            matches!(p, v1::frame::Payload::AgentHello(_))
        }) else {
            panic!("hello")
        };
        (stream, hello)
    }
    fn open(&self, stream: &mut UnixStream) {
        write_request(
            stream,
            v1::frame::Payload::WorkspaceOpenRequest(v1::WorkspaceOpenRequest {
                request_id: "open".into(),
                workspace_handle: "workspace".into(),
                root: self.root.join("workspace").to_string_lossy().into_owned(),
            }),
        );
        read_until(
            stream,
            |p| matches!(p, v1::frame::Payload::WorkspaceOpenResponse(v) if v.accepted),
        );
    }
    fn pty(&self, stream: &mut UnixStream, id: &str, script: &str) -> u32 {
        write_request(
            stream,
            v1::frame::Payload::PtyCreateRequest(v1::PtyCreateRequest {
                request_id: "create".into(),
                pty_id: id.into(),
                request_digest: vec![1],
                workspace_handle: "workspace".into(),
                cwd: String::new(),
                shell: "sh".into(),
                args: vec!["-c".into(), script.into()],
                cols: 80,
                rows: 24,
                environment: vec![],
            }),
        );
        let v1::frame::Payload::PtyCreateResponse(value) = read_until(stream, |p| {
            matches!(p, v1::frame::Payload::PtyCreateResponse(_))
        }) else {
            panic!("create")
        };
        assert!(value.accepted);
        value.pid.try_into().unwrap()
    }
    fn process(&self, stream: &mut UnixStream, id: &str) {
        write_request(
            stream,
            v1::frame::Payload::ProcessRequest(v1::ProcessRequest {
                request_id: "process".into(),
                operation_id: id.into(),
                request_digest: vec![1],
                workspace_handle: "workspace".into(),
                command: "sh".into(),
                args: vec!["-c".into(), "printf completed".into()],
                timeout_ms: 5000,
                max_output_bytes: 1024,
                environment: vec![],
                stdin: vec![],
            }),
        );
        read_until(
            stream,
            |p| matches!(p, v1::frame::Payload::ProcessAccepted(v) if v.accepted),
        );
    }
    fn wait_barrier(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.root.join("barrier/accepted").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(self.root.join("barrier/accepted").exists());
    }
    fn release(&self) {
        fs::write(self.root.join("barrier/release"), b"go").unwrap();
    }
    fn shutdown(stream: &mut UnixStream, hello: &v1::AgentHello) {
        write_request(
            stream,
            v1::frame::Payload::SupervisorShutdownRequest(v1::SupervisorShutdownRequest {
                request_id: "shutdown".into(),
                expected_agent_epoch: hello.agent_epoch.clone(),
                expected_build_digest: hello.build_digest.clone(),
                interrupt_owned_work: true,
            }),
        );
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn real_supervisor_paced_replay_precedes_concurrent_live_output_and_exit() {
    let rig = Rig::new("replay-race", Some("BIGBUD_TEST_REPLAY_BARRIER"));
    let (mut primary, _) = rig.connect();
    rig.open(&mut primary);
    rig.pty(&mut primary, "replay-race", "head -c 1048576 /dev/zero; printf CUT; while [ ! -e go ]; do sleep .01; done; printf SUFFIX");
    let mut produced = Vec::new();
    loop {
        let v1::frame::Payload::PtyOutput(value) = read_until(&mut primary, |p| {
            matches!(p, v1::frame::Payload::PtyOutput(_))
        }) else {
            panic!("output")
        };
        produced.extend_from_slice(&value.bytes);
        if produced.ends_with(b"CUT") {
            break;
        }
    }
    let (mut attached, _) = rig.connect();
    write_request(
        &mut attached,
        v1::frame::Payload::PtyAttachRequest(v1::PtyAttachRequest {
            request_id: "attach".into(),
            pty_id: "replay-race".into(),
            after_sequence: 0,
        }),
    );
    rig.wait_barrier(); // Remaining paced replay is still withheld.
    fs::write(rig.root.join("workspace/go"), b"go").unwrap();
    read_until(&mut primary, |p| {
        matches!(p, v1::frame::Payload::PtyExited(_))
    });
    rig.release();
    let mut bytes = Vec::new();
    let mut next = 1;
    loop {
        let frame = read_frame(&mut attached, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .unwrap();
        match frame.payload.unwrap() {
            v1::frame::Payload::PtyOutput(value) => {
                assert_eq!(value.sequence, next);
                next += 1;
                bytes.extend(value.bytes);
            }
            v1::frame::Payload::PtyExited(_) => break,
            v1::frame::Payload::PtyAttachResponse(_) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
    produced.extend_from_slice(b"SUFFIX");
    assert_eq!(bytes, produced);
}

#[test]
fn accepted_process_starts_and_settles_even_when_all_eight_subscribers_are_taken() {
    let rig = Rig::new(
        "subscriber-saturation",
        Some("BIGBUD_TEST_PROCESS_SPAWN_BARRIER"),
    );
    let (mut requester, _) = rig.connect();
    rig.open(&mut requester);
    rig.process(&mut requester, "saturated");
    rig.wait_barrier();
    let mut observers = Vec::new();
    for _ in 0..8 {
        let (mut stream, _) = rig.connect();
        write_request(
            &mut stream,
            v1::frame::Payload::ProcessAttachRequest(v1::ProcessAttachRequest {
                request_id: "attach".into(),
                operation_id: "saturated".into(),
                after_sequence: 0,
            }),
        );
        read_until(&mut stream, |p| {
            matches!(p, v1::frame::Payload::ProcessAttachResponse(_))
        });
        observers.push(stream);
    }
    rig.release();
    for mut observer in observers {
        let output = read_until(&mut observer, |p| {
            matches!(p, v1::frame::Payload::ProcessOutput(_))
        });
        assert!(matches!(output, v1::frame::Payload::ProcessOutput(v) if v.bytes == b"completed"));
        read_until(&mut observer, |p| {
            matches!(p, v1::frame::Payload::ProcessCompleted(_))
        });
    }
}

#[test]
fn restart_waits_through_completion_transition_and_drains_other_connection() {
    let mut rig = Rig::new("completion-race", Some("BIGBUD_TEST_COMPLETION_BARRIER"));
    let (mut requester, _) = rig.connect();
    rig.open(&mut requester);
    rig.process(&mut requester, "completion-race");
    rig.wait_barrier();
    let (mut control, hello) = rig.connect();
    Rig::shutdown(&mut control, &hello);
    std::thread::sleep(Duration::from_millis(150));
    assert!(rig.child.try_wait().unwrap().is_none());
    rig.release();
    read_until(&mut requester, |p| {
        matches!(p, v1::frame::Payload::ProcessCompleted(_))
    });
    read_until(
        &mut control,
        |p| matches!(p, v1::frame::Payload::SupervisorShutdownResponse(v) if v.accepted),
    );
    wait_for_exit(&mut rig.child);
}

#[test]
fn closed_but_term_and_hup_ignoring_direct_child_is_escalated_and_reaped_before_restart() {
    let mut rig = Rig::new("closed-live-child", None);
    let (mut terminal, _) = rig.connect();
    rig.open(&mut terminal);
    let pid = rig.pty(
        &mut terminal,
        "ignores-term",
        "trap '' TERM HUP; printf READY; while :; do sleep .01; done",
    );
    read_until(
        &mut terminal,
        |p| matches!(p, v1::frame::Payload::PtyOutput(v) if v.bytes.ends_with(b"READY")),
    );
    write_request(
        &mut terminal,
        v1::frame::Payload::PtyCloseRequest(v1::PtyCloseRequest {
            request_id: "close".into(),
            pty_id: "ignores-term".into(),
            terminate: true,
        }),
    );
    read_until(
        &mut terminal,
        |p| matches!(p, v1::frame::Payload::PtyCloseResponse(v) if v.accepted),
    );
    let (mut control, hello) = rig.connect();
    Rig::shutdown(&mut control, &hello);
    read_until(
        &mut control,
        |p| matches!(p, v1::frame::Payload::SupervisorShutdownResponse(v) if v.accepted),
    );
    wait_for_exit(&mut rig.child);
    // SAFETY: signal zero probes only; no action is taken on the numeric ID.
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
}

#[test]
fn real_supervisor_expires_half_frames_and_no_hello_without_expiring_established_idle() {
    let rig = Rig::new("half-frame-admission", None);
    let (mut idle, _) = rig.connect();
    let mut half = Vec::new();
    for index in 0..16 {
        let mut peer = UnixStream::connect(&rig.socket).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        if index % 3 == 1 {
            peer.write_all(&[0, 0]).unwrap();
        }
        if index % 3 == 2 {
            peer.write_all(&[0, 0, 0, 30, 1]).unwrap();
        }
        half.push(peer);
    }
    std::thread::sleep(Duration::from_millis(100));
    let began = Instant::now();
    let (mut control, mut hello) = rig.connect();
    hello.agent_epoch = "not-this-owner".into();
    Rig::shutdown(&mut control, &hello);
    read_until(
        &mut control,
        |p| matches!(p, v1::frame::Payload::SupervisorShutdownResponse(v) if !v.accepted),
    );
    assert!(
        began.elapsed() < Duration::from_secs(1),
        "half frames starved reserved control admission"
    );
    std::thread::sleep(Duration::from_secs(6));
    for mut peer in half {
        let mut byte = [0];
        match peer.read(&mut byte) {
            Ok(0) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
                ) => {}
            other => panic!("incomplete connection did not expire: {other:?}"),
        }
    }
    rig.open(&mut idle); // An intentionally idle established peer remains usable.
    for _ in 0..16 {
        let (_peer, _) = rig.connect();
    }
}
