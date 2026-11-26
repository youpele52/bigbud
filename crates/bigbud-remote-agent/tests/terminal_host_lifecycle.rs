//! Real terminal host (`--supervisor`): capabilities and identity, snapshots across reconnects,
//! 24 concurrent snapshot requests, lost spools and cold snapshots after a host crash, and
//! self-exit (terminal lifecycle plan §15 R5 exit criteria).
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

use std::collections::HashMap;
use std::time::{Duration, Instant};

use bigbud_protocol::pty_lifecycle::{
    LIFECYCLE_CAPABILITY, LOCAL_LAUNCH_CAPABILITY, QUERY_RESPONDER_CAPABILITY, SCREEN_CAPABILITY,
    SPOOL_CAPABILITY,
};
use bigbud_protocol::v1;
use fixture::{Client, Host, Payload, colourful_file, create_request, scratch, sha256};

fn capabilities(client: &Client) -> Vec<String> {
    client
        .hello
        .capabilities
        .iter()
        .map(|capability| capability.name.clone())
        .collect()
}

#[test]
fn the_host_advertises_lifecycle_capabilities_and_its_process_identity() {
    let root = scratch();
    let host = Host::start(&root, &["--local-desktop-host"]);
    let client = Client::connect(&host, "caps");
    let names = capabilities(&client);
    for capability in [
        SCREEN_CAPABILITY,
        LIFECYCLE_CAPABILITY,
        SPOOL_CAPABILITY,
        QUERY_RESPONDER_CAPABILITY,
        LOCAL_LAUNCH_CAPABILITY,
    ] {
        assert!(names.iter().any(|name| name == capability), "{capability}");
    }
    assert_eq!(client.hello.process_id, u64::from(host.pid()));
    assert!(client.hello.process_start_time_ms > 0);
    drop(client);
    drop(host);
    // A remote supervisor (no --local-desktop-host) never offers local launch.
    let remote_root = scratch();
    let remote = Host::start(&remote_root, &[]);
    let names = capabilities(&Client::connect(&remote, "remote"));
    assert!(names.iter().any(|name| name == LIFECYCLE_CAPABILITY));
    assert!(!names.iter().any(|name| name == LOCAL_LAUNCH_CAPABILITY));
    drop(remote);
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(remote_root);
}

#[test]
fn a_snapshot_is_identical_after_a_reconnect() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut first = Client::connect(&host, "first");
    first.open_workspace("workspace", &root);
    let script = "printf '\\033[1;32mgreen\\033[0m plain \\342\\234\\223\\n'; seq 1 300; sleep 60";
    assert!(
        first
            .create(create_request("pty", "/bin/sh", &["-c", script]))
            .accepted
    );
    std::thread::sleep(Duration::from_millis(800));
    let (before, ansi_before) = first.snapshot("pty");
    assert!(before.accepted, "{before:?}");
    assert_eq!(
        (before.model_state.as_str(), before.fidelity.as_str()),
        ("live", "full")
    );
    assert_eq!(sha256(&ansi_before), before.sha256);
    drop(first);
    let mut second = Client::connect(&host, "second");
    let (after, ansi_after) = second.snapshot("pty");
    assert_eq!(after.through_sequence, before.through_sequence);
    assert_eq!(ansi_after, ansi_before);
    assert!(String::from_utf8_lossy(&ansi_after).contains("300"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn twenty_four_concurrent_snapshot_requests_complete_while_other_output_flows() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut client = Client::connect(&host, "burst");
    client.open_workspace("workspace", &root);
    let big = root.join("big.txt");
    colourful_file(&big, 1100, 200);
    let big_path = big.to_string_lossy().into_owned();
    let script = format!("cat '{big_path}'; sleep 120");
    assert!(
        client
            .create(create_request("big", "/bin/sh", &["-c", &script]))
            .accepted
    );
    let ticker = "while :; do echo tick; sleep 0.02; done";
    assert!(
        client
            .create(create_request("ticker", "/bin/sh", &["-c", ticker]))
            .accepted
    );
    std::thread::sleep(Duration::from_secs(2));
    let mut pending = HashMap::new();
    for _ in 0..24 {
        let request_id = client.request_id("burst");
        client.send(fixture::snapshot_request(&request_id, "big"));
        pending.insert(
            request_id,
            (None::<v1::PtyScreenSnapshotHeader>, Vec::new()),
        );
    }
    let started = Instant::now();
    let mut ticks = 0usize;
    let mut done = 0usize;
    let mut total_bytes = 0usize;
    while done < 24 {
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "{done} of 24 done"
        );
        let frame = client
            .recv(Duration::from_secs(10))
            .expect("frames keep flowing");
        match frame.payload {
            Some(Payload::PtyOutput(output)) if output.pty_id == "ticker" => ticks += 1,
            Some(Payload::PtyScreenSnapshotHeader(header)) => {
                assert!(
                    header.accepted,
                    "no busy refusal or budget error: {header:?}"
                );
                let entry = pending.get_mut(&header.request_id).unwrap();
                if header.chunk_count == 0 {
                    done += 1;
                }
                entry.0 = Some(*header);
            }
            Some(Payload::PtyScreenSnapshotChunk(chunk)) => {
                let entry = pending.get_mut(&chunk.request_id).unwrap();
                entry.1.extend_from_slice(&chunk.bytes);
                if chunk.last {
                    let header = entry.0.as_ref().unwrap();
                    assert_eq!(sha256(&entry.1), header.sha256);
                    total_bytes += entry.1.len();
                    done += 1;
                }
            }
            Some(Payload::ProtocolError(error)) => panic!("{error:?}"),
            _ => {}
        }
    }
    let elapsed = started.elapsed();
    eprintln!(
        "24 snapshots: {} bytes each, {elapsed:?} total, {ticks} ticker frames meanwhile",
        total_bytes / 24
    );
    assert!(total_bytes / 24 > 512 * 1024, "snapshots should be large");
    assert!(
        ticks > 0,
        "other PTY output kept flowing during the transfers"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_crashed_host_leaves_a_lost_pty_with_a_cold_snapshot() {
    let root = scratch();
    let mut host = Host::start(&root, &[]);
    let mut client = Client::connect(&host, "before");
    client.open_workspace("workspace", &root);
    let script = "printf 'survives the crash\\n'; sleep 120";
    assert!(
        client
            .create(create_request("doomed", "/bin/sh", &["-c", script]))
            .accepted
    );
    // The spool writer flushes buffered segments every 2 s.
    std::thread::sleep(Duration::from_millis(3_500));
    host.child.kill().unwrap();
    let _status = host.child.wait();
    drop(client);
    let restarted = Host::start(&root, &[]);
    let mut client = Client::connect(&restarted, "after");
    let request_id = client.request_id("list");
    client.send(Payload::PtyListRequest(v1::PtyListRequest {
        request_id: request_id.clone(),
        expected_epoch: client.hello.agent_epoch.clone(),
        limit: 100,
        ..Default::default()
    }));
    let list = match client
        .wait_for(|p| matches!(p, Payload::PtyListResponse(r) if r.request_id == request_id))
    {
        Payload::PtyListResponse(list) => list,
        _ => unreachable!(),
    };
    let entry = list
        .entries
        .iter()
        .find(|entry| entry.pty_id == "doomed")
        .expect("lost entry");
    assert!(entry.lost && entry.screen_available, "{entry:?}");
    assert_eq!(entry.state, "outcome-unknown");
    let (header, ansi) = client.snapshot("doomed");
    assert!(header.accepted, "{header:?}");
    assert_eq!(header.model_state, "cold");
    assert!(String::from_utf8_lossy(&ansi).contains("survives the crash"));
    drop(restarted);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_empty_orphaned_host_exits_by_itself_and_a_busy_one_does_not() {
    let root = scratch();
    let env = [("BIGBUD_DEBUG_TERMINAL_HOST_SELF_EXIT_MS", "1500")];
    let flags = ["--local-desktop-host", "--exit-when-orphaned-and-empty"];
    let mut host = Host::start_with_env(&root, &flags, &env);
    let mut client = Client::connect(&host, "owner");
    client.open_workspace("workspace", &root);
    assert!(
        client
            .create(create_request("live", "/bin/sleep", &["4"]))
            .accepted
    );
    drop(client);
    // A live PTY keeps the host up even with no owner.
    std::thread::sleep(Duration::from_secs(3));
    assert!(
        host.child.try_wait().unwrap().is_none(),
        "exited with a live PTY"
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if host.child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "host did not exit once empty and orphaned"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !host.socket.exists(),
        "the socket is removed on a graceful exit"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unsolicited_lifecycle_frames_reach_only_clients_that_speak_protocol_1_9() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut old = Client::connect_with_minor(&host, "old", 8);
    let mut new = Client::connect(&host, "new");
    new.open_workspace("workspace", &root);
    assert!(
        new.create(create_request("managed", "/bin/sleep", &["30"]))
            .accepted
    );
    let request_id = new.request_id("quit");
    new.send(Payload::PtyCloseAllRequest(v1::PtyCloseAllRequest {
        request_id: request_id.clone(),
        reason: "quit".to_owned(),
        managed_only: true,
    }));
    match new
        .wait_for(|p| matches!(p, Payload::PtyCloseAllResponse(r) if r.request_id == request_id))
    {
        Payload::PtyCloseAllResponse(response) => assert_eq!(response.closed_count, 1),
        _ => unreachable!(),
    }
    match new.wait_for(|p| matches!(p, Payload::PtyLifecycleNotice(_))) {
        Payload::PtyLifecycleNotice(notice) => assert_eq!(notice.kind, "quit_closed"),
        _ => unreachable!(),
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while let Some(frame) = old.recv(deadline.saturating_duration_since(Instant::now())) {
        assert!(
            !matches!(
                frame.payload,
                Some(
                    Payload::PtyLifecycleNotice(_)
                        | Payload::PtyActivity(_)
                        | Payload::HostResourceReport(_)
                )
            ),
            "a pre-1.9 client received {frame:?}"
        );
    }
    let _ = std::fs::remove_dir_all(root);
}
