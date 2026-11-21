//! The explicit workspace-root reference count and session retention (plan §8.10 churn test).

use std::time::{Duration, Instant};

use super::super::super::*;
use super::fixture::{Host, open_request};

fn wait_exit(host: &Host, id: &str) {
    let handle = host
        .session
        .lock()
        .unwrap()
        .pty_sessions
        .get(&host.id(id))
        .map(|session| Arc::clone(&session.handle))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let delivered = host
            .session
            .lock()
            .unwrap()
            .pty_sessions
            .get(&host.id(id))
            .is_none_or(|session| session.expires_at.is_some());
        if handle.child_reaped() && delivered {
            return;
        }
        assert!(Instant::now() < deadline, "{id} did not exit");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn churn_of_100_ptys_over_two_cwds_never_hits_a_resource_limit_and_roots_return() {
    let mut host = Host::new(false);
    let started = Instant::now();
    let roots = ["a", "b"].map(|name| {
        let path = host.root.join(name);
        std::fs::create_dir_all(&path).unwrap();
        (format!("terminal-root-{name}"), path)
    });
    let baseline = host.session.lock().unwrap().workspace_root_count();
    let open = |host: &Host, index: usize| {
        let (handle, path) = &roots[index % 2];
        let frame = host
            .session
            .lock()
            .unwrap()
            .handle(open_request(handle, path))
            .unwrap();
        assert!(matches!(frame.payload,
            Some(v1::frame::Payload::WorkspaceOpenResponse(response)) if response.accepted));
        handle.clone()
    };
    // One long-lived PTY keeps root "a" alive through the whole churn.
    let keeper_handle = open(&host, 0);
    let mut keeper = host.request("keeper", true, "/bin/sleep", &["60"]);
    keeper.workspace_handle = keeper_handle.clone();
    assert!(host.create(keeper).accepted);
    for index in 0..100 {
        let handle = open(&host, index);
        let mut request = host.request(
            &format!("churn-{index}"),
            true,
            "/bin/sh",
            &["-c", "exit 0"],
        );
        request.workspace_handle = handle;
        let response = host.create(request);
        assert!(response.accepted, "create {index}: {response:?}");
        wait_exit(&host, &format!("churn-{index}"));
        let session = host.session.lock().unwrap();
        assert!(session.workspace_roots.contains_key(&keeper_handle));
        assert!(session.pty_sessions.len() <= MAX_PTY_SESSIONS);
    }
    assert!(started.elapsed() < Duration::from_secs(600));
    {
        let session = host.session.lock().unwrap();
        // Retired exited sessions released their references; retained ones still hold theirs.
        let held =
            session.workspace_ref_count(&keeper_handle) + session.workspace_ref_count(&roots[1].0);
        assert_eq!(held, session.pty_sessions.len());
    }
    let keeper = host.lifecycle("keeper");
    assert!(keeper.close_if("test", |_, _| true));
    wait_exit(&host, "keeper");
    // Expire every retained result (the 600 s retention window passing).
    let mut session = host.session.lock().unwrap();
    for pty in session.pty_sessions.values_mut() {
        pty.expires_at = Some(Instant::now());
    }
    session.prune_pty_sessions();
    assert!(session.pty_sessions.is_empty());
    assert_eq!(session.workspace_root_count(), baseline);
    assert!(session.workspace_refs.is_empty());
}

#[test]
fn a_reopen_of_a_shared_root_neither_fails_nor_replaces_it_and_project_roots_stay() {
    let mut host = Host::new(false);
    let path = host.root.join("shared");
    std::fs::create_dir_all(&path).unwrap();
    for _ in 0..3 {
        let frame = host
            .session
            .lock()
            .unwrap()
            .handle(open_request("terminal-root-shared", &path))
            .unwrap();
        assert!(matches!(frame.payload,
            Some(v1::frame::Payload::WorkspaceOpenResponse(response)) if response.accepted));
    }
    for id in ["one", "two"] {
        let mut request = host.request(id, false, "/bin/sleep", &["30"]);
        request.workspace_handle = "terminal-root-shared".to_owned();
        assert!(host.create(request).accepted);
    }
    assert_eq!(
        host.session
            .lock()
            .unwrap()
            .workspace_ref_count("terminal-root-shared"),
        2
    );
    // The project root (no `terminal-` prefix) is never released implicitly.
    let mut request = host.request("project", false, "/bin/sh", &["-c", "exit 0"]);
    request.workspace_handle = "workspace".to_owned();
    assert!(host.create(request).accepted);
    wait_exit(&host, "project");
    let mut session = host.session.lock().unwrap();
    if let Some(pty) = session.pty_sessions.get_mut(&host.id("project")) {
        pty.expires_at = Some(Instant::now());
    }
    session.prune_pty_sessions();
    assert!(session.workspace_roots.contains_key("workspace"));
}
