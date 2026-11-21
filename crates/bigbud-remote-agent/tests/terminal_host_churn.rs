//! Real terminal host: opening and closing 100 PTYs over two shared per-cwd roots never hits
//! `RESOURCE_LIMIT`, and a shared root survives while one PTY still uses it (plan §8.10).
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

use std::time::{Duration, Instant};

use fixture::{Client, Host, Payload, create_request, scratch};

#[test]
fn one_hundred_ptys_over_two_cwds_churn_without_resource_limits() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut client = Client::connect(&host, "churn");
    let cwds = ["a", "b"].map(|name| {
        let path = root.join(name);
        std::fs::create_dir_all(&path).unwrap();
        (format!("terminal-root-{name}"), path)
    });
    let started = Instant::now();
    client.open_workspace(&cwds[0].0, &cwds[0].1);
    let mut keeper = create_request("keeper", "/bin/sleep", &["120"]);
    keeper.workspace_handle = cwds[0].0.clone();
    assert!(client.create(keeper).accepted);
    for index in 0..100 {
        let (handle, path) = &cwds[index % 2];
        // Every create reopens its shared root, as the server does; a reopen never fails.
        client.open_workspace(handle, path);
        let id = format!("churn-{index}");
        let mut request = create_request(&id, "/bin/sh", &["-c", "exit 0"]);
        request.workspace_handle = handle.clone();
        request.spool = false;
        let response = client.create(request);
        assert!(response.accepted, "create {index}: {response:?}");
        match client.wait_for(|p| matches!(p, Payload::PtyExited(exit) if exit.pty_id == id)) {
            Payload::PtyExited(exit) => assert!(exit.has_exit_code),
            _ => unreachable!(),
        }
    }
    // Root "a" is still open for the keeper: a create there needs no reopen.
    let mut late = create_request("late", "/bin/sh", &["-c", "exit 0"]);
    late.workspace_handle = cwds[0].0.clone();
    assert!(client.create(late).accepted);
    let elapsed = started.elapsed();
    eprintln!("100 PTY open/close cycles in {elapsed:?}");
    assert!(elapsed < Duration::from_secs(600));
    let _ = std::fs::remove_dir_all(root);
}
