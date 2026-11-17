#![allow(clippy::unwrap_used, clippy::panic)]
use super::{Rig, fixture::*};
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;
use std::time::{Duration, Instant};

const SEAL_BARRIER: &str = "BIGBUD_TEST_SHUTDOWN_SEAL_BARRIER";

fn send(rig: &Rig, signal: libc::c_int) {
    // SAFETY: the rig owns this unreaped supervisor child, so its PID is live.
    assert_eq!(unsafe { libc::kill(rig.child.id() as i32, signal) }, 0);
}

/// The signal drain may spend its bounded settle and force windows.
fn wait_exit(rig: &mut Rig) -> ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(status) = rig.child.try_wait().unwrap() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("supervisor did not exit after signal");
}

fn read_output_until(stream: &mut UnixStream, marker: &[u8]) -> Vec<u8> {
    let mut produced = Vec::new();
    while !produced
        .windows(marker.len())
        .any(|window| window == marker)
    {
        if let v1::frame::Payload::PtyOutput(value) =
            read_until(stream, |p| matches!(p, v1::frame::Payload::PtyOutput(_)))
        {
            produced.extend_from_slice(&value.bytes);
        }
    }
    produced
}

fn create_request(id: &str, workspace: &str, shell: &str, script: &str) -> v1::frame::Payload {
    v1::frame::Payload::PtyCreateRequest(v1::PtyCreateRequest {
        request_id: format!("create-{id}"),
        pty_id: id.into(),
        request_digest: vec![2],
        workspace_handle: workspace.into(),
        cwd: String::new(),
        shell: shell.into(),
        args: vec!["-c".into(), script.into()],
        cols: 80,
        rows: 24,
        environment: vec![],
        profile_launch: false,
    })
}

#[cfg(target_os = "linux")]
fn running(pid: i32) -> bool {
    // A zombie awaiting its reaper is no longer running work.
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            let state = stat.rsplit_once(") ")?.1.chars().next()?;
            Some(state != 'Z' && state != 'X')
        })
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
#[test]
fn sigterm_reaps_job_control_children() {
    let mut rig = Rig::new("signal-job-control", None);
    let (mut terminal, _) = rig.connect();
    rig.open(&mut terminal);
    write_request(
        &mut terminal,
        create_request(
            "job-control",
            "workspace",
            "bash",
            "set -m; sleep 77777 & printf 'BG:%s:READY' $!; wait",
        ),
    );
    let output = read_output_until(&mut terminal, b":READY");
    let text = String::from_utf8_lossy(&output);
    let background: i32 = text
        .split("BG:")
        .nth(1)
        .and_then(|rest| rest.split(':').next())
        .unwrap()
        .parse()
        .unwrap();
    assert!(running(background));
    send(&rig, libc::SIGTERM);
    let status = wait_exit(&mut rig);
    assert_eq!(status.code(), Some(143));
    let deadline = Instant::now() + Duration::from_secs(2);
    while running(background) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!running(background), "job-control child survived SIGTERM");
}

#[test]
fn sigterm_removes_socket_and_refuses_new_admission() {
    let mut rig = Rig::new("signal-socket", None);
    let (mut terminal, _) = rig.connect();
    rig.open(&mut terminal);
    // Ignoring TERM holds the drain in its bounded settle window until the
    // forced fallback, so admission can be observed while draining.
    rig.pty(
        &mut terminal,
        "stubborn",
        "trap '' TERM; printf READY; while :; do sleep 1; done",
    );
    read_output_until(&mut terminal, b"READY");
    send(&rig, libc::SIGTERM);
    std::thread::sleep(Duration::from_millis(300));
    send(&rig, libc::SIGINT); // Repeat signals are ignored while draining.
    assert!(rig.child.try_wait().unwrap().is_none());
    let late = late_pty_create(&rig);
    assert!(
        matches!(late.as_str(), "SUPERVISOR_RESTARTING" | "closed"),
        "late admission during drain: {late}"
    );
    let status = wait_exit(&mut rig);
    assert_eq!(status.code(), Some(143));
    assert!(
        !rig.socket.exists(),
        "socket left behind after signal drain"
    );
    assert!(UnixStream::connect(&rig.socket).is_err());
}

/// A newcomer during the drain may complete hello, but cannot create work.
/// Returns how the late PTY create ended: a refusal code, or "closed".
fn late_pty_create(rig: &Rig) -> String {
    let Ok(mut stream) = UnixStream::connect(&rig.socket) else {
        return "closed".into();
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write_request(
        &mut stream,
        v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "during-drain".into(),
            connection_id: "during-drain".into(),
            server_nonce: "during-drain".into(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }),
    );
    let mut hello_seen = false;
    loop {
        let Ok(Some(frame)) = read_frame(&mut stream, DEFAULT_MAX_FRAME_BYTES) else {
            return "closed".into();
        };
        match frame.payload {
            Some(v1::frame::Payload::AgentHello(_)) if !hello_seen => {
                hello_seen = true;
                write_request(
                    &mut stream,
                    create_request("late", "workspace", "sh", "sleep 100"),
                );
            }
            Some(v1::frame::Payload::PtyCreateResponse(value)) => {
                return if value.accepted {
                    "accepted".into()
                } else {
                    "refused".into()
                };
            }
            Some(v1::frame::Payload::ProtocolError(error)) => return error.code,
            _ => {}
        }
    }
}

#[test]
fn signal_during_restart_drain_is_idempotent() {
    let mut rig = Rig::new("signal-during-restart", Some(SEAL_BARRIER));
    let (mut terminal, _) = rig.connect();
    rig.open(&mut terminal);
    rig.pty(&mut terminal, "restart-child", "printf READY; sleep 100");
    read_output_until(&mut terminal, b"READY");
    let (mut control, hello) = rig.connect();
    Rig::shutdown(&mut control, &hello);
    rig.wait_barrier();
    for signal in [libc::SIGTERM, libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        send(&rig, signal);
    }
    std::thread::sleep(Duration::from_millis(300));
    // The accepted restart owns the drain; signals cannot start a second one.
    assert!(rig.child.try_wait().unwrap().is_none());
    rig.release();
    read_until(
        &mut control,
        |p| matches!(p, v1::frame::Payload::SupervisorShutdownResponse(v) if v.accepted && v.terminal),
    );
    let status = wait_exit(&mut rig);
    assert_eq!(status.code(), Some(0), "restart exit replaced: {status:?}");
    assert_eq!(status.signal(), None);
}

#[cfg(target_os = "linux")]
#[test]
fn pty_child_has_default_sigterm_disposition() {
    let rig = Rig::new("signal-disposition", None);
    let (mut terminal, _) = rig.connect();
    rig.open(&mut terminal);
    let pid = rig.pty(&mut terminal, "disposition", "exec sleep 100");
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        if cmdline.starts_with(b"sleep") {
            break std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        }
        assert!(Instant::now() < deadline, "PTY child never exec'd sleep");
        std::thread::sleep(Duration::from_millis(10));
    };
    let mask = |field: &str| {
        let line = status
            .lines()
            .find_map(|line| line.strip_prefix(field))
            .unwrap();
        u64::from_str_radix(line.trim(), 16).unwrap()
    };
    let bits = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP]
        .iter()
        .fold(0_u64, |bits, signal| bits | 1 << (signal - 1));
    assert_eq!(mask("SigCgt:") & bits, 0, "handler leaked into PTY child");
    assert_eq!(
        mask("SigBlk:") & bits,
        0,
        "blocked mask leaked into PTY child"
    );
    assert_eq!(mask("SigIgn:") & bits, 0, "ignored disposition leaked");
}
