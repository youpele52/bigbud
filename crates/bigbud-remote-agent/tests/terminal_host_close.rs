//! Real terminal host: closes end the PTY's processes (terminal lifecycle R8). Interactive
//! shells ignore SIGTERM, so close-all and `PtyCloseRequest` must hang them up and escalate;
//! the response comes only after the child is reaped, and nothing is left on the terminal.
#![cfg(unix)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::indexing_slicing
)]

#[path = "support/terminal_host.fixture.rs"]
mod fixture;

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use bigbud_protocol::v1;
use fixture::{Client, Host, Payload, create_request, scratch};

fn alive(pid: u64) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn tty_of(pid: u64) -> String {
    let output = Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn left_on(tty: &str) -> String {
    let output = Command::new("ps")
        .args(["-t", tty, "-o", "pid=,comm="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn interactive(id: &str, shell: &str, args: &[&str], managed: bool) -> v1::PtyCreateRequest {
    let mut request = create_request(id, shell, args);
    request.lifecycle_managed = managed;
    request.spool = false;
    request
}

#[test]
fn close_all_with_managed_only_ends_interactive_shells_and_their_jobs() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut client = Client::connect(&host, "close-all");
    client.open_workspace("workspace", &root);
    let mut shells = vec![("sh", "/bin/sh", vec!["-i"])];
    for (name, path, args) in [
        ("zsh", "/bin/zsh", vec!["-f", "-i"]),
        ("bash", "/bin/bash", vec!["--norc", "--noprofile", "-i"]),
    ] {
        if Path::new(path).exists() {
            shells.push((name, path, args));
        }
    }
    let mut managed = Vec::new();
    for (name, path, args) in &shells {
        let response = client.create(interactive(name, path, args, true));
        assert!(response.accepted, "{response:?}");
        managed.push((name.to_owned(), response.pid));
    }
    let survivor = client.create(interactive("unmanaged", "/bin/sh", &["-i"], false));
    std::thread::sleep(Duration::from_millis(500));
    // A foreground job in the first shell must go too.
    client.send(Payload::PtyInput(v1::PtyInput {
        request_id: "job".to_owned(),
        pty_id: "sh".to_owned(),
        sequence: 1,
        bytes: b"sleep 300\n".to_vec(),
    }));
    std::thread::sleep(Duration::from_millis(300));
    let ttys = managed
        .iter()
        .map(|(name, pid)| ((*name).to_owned(), tty_of(*pid)))
        .collect::<Vec<_>>();
    let started = Instant::now();
    client.send(Payload::PtyCloseAllRequest(v1::PtyCloseAllRequest {
        request_id: "quit".to_owned(),
        reason: "quit".to_owned(),
        managed_only: true,
    }));
    let response = match client
        .wait_for(|p| matches!(p, Payload::PtyCloseAllResponse(r) if r.request_id == "quit"))
    {
        Payload::PtyCloseAllResponse(response) => response,
        _ => unreachable!(),
    };
    eprintln!("close-all answered after {:?}", started.elapsed());
    assert_eq!(response.closed_count as usize, managed.len());
    // Reported closed means gone: no process of a closed PTY may survive the response.
    for (name, pid) in &managed {
        assert!(!alive(*pid), "{name} (pid {pid}) survived close-all");
    }
    for (name, tty) in &ttys {
        let left = left_on(tty);
        assert!(left.is_empty(), "{name} left processes on {tty}: {left}");
    }
    assert!(alive(survivor.pid), "the unmanaged shell is untouched");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn pty_close_escalates_to_sigkill_and_answers_after_the_reap() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut client = Client::connect(&host, "close");
    client.open_workspace("workspace", &root);
    let script = "trap '' HUP TERM; while :; do sleep 1; done";
    let created = client.create(interactive("stubborn", "/bin/sh", &["-c", script], false));
    assert!(created.accepted);
    std::thread::sleep(Duration::from_millis(300));
    let tty = tty_of(created.pid);
    let started = Instant::now();
    client.send(Payload::PtyCloseRequest(v1::PtyCloseRequest {
        request_id: "close".to_owned(),
        pty_id: "stubborn".to_owned(),
        terminate: true,
    }));
    // The connection stays responsive while the close escalates.
    let listed = client.request_id("list");
    client.send(Payload::PtyListRequest(v1::PtyListRequest {
        request_id: listed.clone(),
        expected_epoch: client.hello.agent_epoch.clone(),
        limit: 100,
        ..Default::default()
    }));
    let _ = client.wait_for(|p| matches!(p, Payload::PtyListResponse(r) if r.request_id == listed));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "close blocked the connection"
    );
    let response = match client
        .wait_for(|p| matches!(p, Payload::PtyCloseResponse(r) if r.request_id == "close"))
    {
        Payload::PtyCloseResponse(response) => response,
        _ => unreachable!(),
    };
    let took = started.elapsed();
    eprintln!("stubborn close answered after {took:?}");
    assert!(response.accepted);
    assert!(
        took >= Duration::from_secs(2),
        "answered before the SIGKILL escalation"
    );
    assert!(!alive(created.pid));
    assert!(left_on(&tty).is_empty());
    let _ = std::fs::remove_dir_all(root);
}
