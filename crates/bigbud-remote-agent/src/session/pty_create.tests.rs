use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

struct Fixture {
    session: AgentSession,
    root: PathBuf,
}

impl Fixture {
    #[expect(clippy::expect_used, reason = "test fixture setup must succeed")]
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "bigbud-session-pty-admission-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("create isolated PTY fixture directory");
        let mut session = AgentSession::new().expect("create session");
        session
            .handle(test_helpers::hello())
            .expect("complete hello");
        session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
                    v1::WorkspaceOpenRequest {
                        request_id: "open".to_owned(),
                        workspace_handle: "workspace".to_owned(),
                        root: root.to_string_lossy().into_owned(),
                    },
                )),
            })
            .expect("open fixture workspace");
        Self { session, root }
    }

    fn request(&self, id: &str) -> v1::PtyCreateRequest {
        v1::PtyCreateRequest {
            request_id: format!("create-{id}"),
            pty_id: id.to_owned(),
            request_digest: vec![1],
            workspace_handle: "workspace".to_owned(),
            shell: self.root.join("shell").to_string_lossy().into_owned(),
            args: vec!["-c".to_owned(), "exit 0".to_owned()],
            cols: 80,
            rows: 24,
            ..Default::default()
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        assert!(fs::remove_dir_all(&self.root).is_ok());
    }
}

#[expect(
    clippy::expect_used,
    reason = "test assertion requires an explicit PTY error"
)]
fn failure(result: Result<(v1::Frame, Option<pty::PtyJob>), SessionError>) -> String {
    match result {
        Err(SessionError::Pty(error)) => Some(error),
        _ => None,
    }
    .expect("expected explicit PTY create error")
}

#[test]
fn failed_real_launch_is_not_dispatched_again_after_executable_appears() {
    let mut fixture = Fixture::new();
    let mut request = fixture.request("failed");
    let original = failure(fixture.session.prepare_pty_create(request.clone()));
    assert!(original.contains("Exec"), "{original}");
    std::os::unix::fs::symlink("/bin/sh", &request.shell).unwrap();
    request.request_id = "retry".to_owned();
    assert_eq!(
        failure(fixture.session.prepare_pty_create(request.clone())),
        original
    );
    request.request_digest = vec![2];
    assert!(matches!(
        fixture.session.prepare_pty_create(request),
        Err(SessionError::OperationIdConflict)
    ));
    assert!(fixture.session.pty_sessions.is_empty());
    assert_eq!(fixture.session.pty_create_failures.len(), 1);

    // A genuinely new terminal remains possible, without reusing the failed ID.
    let request = fixture.request("new-terminal");
    let (_, job) = fixture.session.prepare_pty_create(request).unwrap();
    let job = job.unwrap();
    assert!(matches!(
        pty::read_events(job.reader, &job.handle).last(),
        Some(pty::PtyEvent::Exited {
            exit_code: Some(0),
            ..
        })
    ));
    fixture
        .session
        .complete_pty("new-terminal", Some(0), None)
        .unwrap();
    let attached = fixture
        .session
        .handle_pty_attach(v1::PtyAttachRequest {
            request_id: "attach".to_owned(),
            pty_id: "new-terminal".to_owned(),
            after_sequence: 0,
        })
        .unwrap();
    assert!(matches!(
        attached.last().unwrap().payload,
        Some(v1::frame::Payload::PtyExited(_))
    ));
}

#[test]
fn unknown_and_post_dispatch_io_errors_are_retained_without_retry() {
    for error in [
        pty::PtyError::LaunchUnknown(pty::LaunchUnknown::Timeout),
        pty::PtyError::Io(std::io::Error::other("post-dispatch failure")),
    ] {
        let mut fixture = Fixture::new();
        let request = fixture.request("uncertain");
        let original = failure(
            fixture
                .session
                .prepare_pty_create_with(request.clone(), |_, _, _| Err(error)),
        );
        fixture.session.prune_pty_sessions();
        assert_eq!(
            failure(
                fixture
                    .session
                    .prepare_pty_create_with(request.clone(), |_, _, _| panic!(
                        "must not redispatch an admitted create"
                    ),)
            ),
            original
        );
        let mut conflicting = request.clone();
        conflicting.request_digest = vec![2];
        assert!(matches!(
            fixture.session.prepare_pty_create(conflicting),
            Err(SessionError::OperationIdConflict)
        ));
        assert!(
            fixture
                .session
                .pty_operation_handle(&request.pty_id)
                .is_err()
        );
    }
}

#[test]
fn live_and_failed_creates_share_capacity_and_failures_never_expire() {
    let mut fixture = Fixture::new();
    let mut live = fixture.request("live");
    live.shell = "/bin/sh".to_owned();
    let (_, job) = fixture.session.prepare_pty_create(live.clone()).unwrap();
    let job = job.unwrap();
    assert!(matches!(
        pty::read_events(job.reader, &job.handle).last(),
        Some(pty::PtyEvent::Exited {
            exit_code: Some(0),
            ..
        })
    ));
    fixture.session.complete_pty("live", Some(0), None).unwrap();

    for index in 0..MAX_PTY_SESSIONS - 1 {
        let request = fixture.request(&format!("failed-{index}"));
        failure(fixture.session.prepare_pty_create(request));
    }
    fixture.session.prune_pty_sessions();
    assert_eq!(
        fixture.session.pty_create_failures.len(),
        MAX_PTY_SESSIONS - 1
    );
    assert_eq!(fixture.session.pty_sessions.len(), 1);
    let overflow = fixture.request("overflow");
    assert!(matches!(
        fixture.session.prepare_pty_create(overflow.clone()),
        Err(SessionError::ResourceLimit(_))
    ));
    assert!(!fixture.session.pty_create_failures.contains_key("overflow"));
    assert!(
        fixture
            .session
            .prepare_pty_create(live)
            .unwrap()
            .1
            .is_none()
    );
    let failed = fixture.request("failed-0");
    failure(fixture.session.prepare_pty_create(failed.clone()));
    let mut conflicting = failed;
    conflicting.request_digest = vec![2];
    assert!(matches!(
        fixture.session.prepare_pty_create(conflicting),
        Err(SessionError::OperationIdConflict)
    ));

    // Only a reaped successful result may expire and release its capacity.
    fixture
        .session
        .pty_sessions
        .get_mut("live")
        .unwrap()
        .expires_at = Some(Instant::now());
    failure(fixture.session.prepare_pty_create(overflow));
    assert_eq!(fixture.session.pty_create_failures.len(), MAX_PTY_SESSIONS);
    assert!(fixture.session.pty_sessions.is_empty());
    let next = fixture.request("still-full");
    assert!(matches!(
        fixture.session.prepare_pty_create(next),
        Err(SessionError::ResourceLimit(_))
    ));
}

#[test]
fn profile_preflight_rejects_before_admission_and_generic_commands_remain_unrestricted() {
    let mut fixture = Fixture::new();
    for shell in ["", "sh", "/tmp/sh", "/bin/zsh", "/bin/sh"] {
        let mut request = fixture.request("profile");
        request.profile_launch = true;
        request.shell = shell.to_owned();
        assert!(matches!(
            fixture
                .session
                .prepare_pty_create_with(request, |_, _, _| panic!("no spawn")),
            Err(SessionError::Pty(_))
        ));
        assert!(fixture.session.pty_sessions.is_empty());
        assert!(fixture.session.pty_create_failures.is_empty());
    }
    let mut request = fixture.request("profile");
    request.request_digest = vec![2];
    request.profile_launch = true;
    request.shell = "/bin/sh".to_owned();
    request.args.clear();
    request.environment = vec![v1::ProcessEnvironment {
        name: "TERM".to_owned(),
        value: "xterm-256color".to_owned(),
    }];
    failure(
        fixture
            .session
            .prepare_pty_create_with(request, |request, cwd, environment| {
                assert!(request.args.is_empty());
                assert_eq!(request.shell, "/bin/sh");
                assert_eq!(cwd, fs::canonicalize(&fixture.root).unwrap());
                assert_eq!(
                    environment,
                    &[("TERM".to_owned(), "xterm-256color".to_owned())]
                );
                Err(pty::PtyError::Io(std::io::Error::other(
                    "admitted exact plan",
                )))
            }),
    );
    assert_eq!(fixture.session.pty_create_failures.len(), 1);

    let request = fixture.request("legacy");
    failure(
        fixture
            .session
            .prepare_pty_create_with(request, |request, _, _| {
                assert!(!request.profile_launch);
                assert_eq!(request.args, ["-c", "exit 0"]);
                Err(pty::PtyError::Io(std::io::Error::other(
                    "legacy dispatched",
                )))
            }),
    );
    assert_eq!(fixture.session.pty_create_failures.len(), 2);
}

#[test]
fn marked_native_create_and_attach_remain_unconfirmed() {
    let mut fixture = Fixture::new();
    let mut request = fixture.request("exact");
    request.profile_launch = true;
    request.shell = "/bin/sh".to_owned();
    request.args.clear();
    let (frame, job) = fixture.session.prepare_pty_create(request.clone()).unwrap();
    assert!(matches!(frame.payload,
        Some(v1::frame::Payload::PtyCreateResponse(response))
            if response.accepted && response.launch_status == "unconfirmed"
    ));
    assert!(
        fixture
            .session
            .prepare_pty_create_with(request, |_, _, _| panic!("no duplicate spawn"))
            .unwrap()
            .1
            .is_none()
    );
    let job = job.unwrap();
    job.handle.write_input(1, b"exit 0\n").unwrap();
    assert!(matches!(
        pty::read_events(job.reader, &job.handle).last(),
        Some(pty::PtyEvent::Exited {
            exit_code: Some(0),
            ..
        })
    ));
    fixture
        .session
        .complete_pty("exact", Some(0), None)
        .unwrap();
    let frames = fixture
        .session
        .handle_pty_attach(v1::PtyAttachRequest {
            request_id: "attach".to_owned(),
            pty_id: "exact".to_owned(),
            after_sequence: 0,
        })
        .unwrap();
    assert!(matches!(&frames[0].payload,
        Some(v1::frame::Payload::PtyAttachResponse(response))
            if response.state == "exited" && response.launch_status == "unconfirmed"
    ));
}

#[test]
fn shell_profile_capability_is_independent_and_versioned() {
    let mut fixture = Fixture::new();
    let frame = fixture.session.handle(test_helpers::hello()).unwrap();
    let Some(v1::frame::Payload::AgentHello(hello)) = frame.payload else {
        panic!("expected agent hello");
    };
    assert_eq!(hello.protocol_minor, 5);
    for name in ["terminal.pty", "terminal.shell-profiles"] {
        let capabilities: Vec<_> = hello
            .capabilities
            .iter()
            .filter(|capability| capability.name == name)
            .collect();
        assert_eq!(capabilities.len(), 1);
        assert_eq!((capabilities[0].major, capabilities[0].minor), (1, 0));
    }
}

#[test]
fn preflight_failure_does_not_admit_identity_or_consume_capacity() {
    let mut fixture = Fixture::new();
    let mut request = fixture.request("preflight");
    request.workspace_handle = "missing".to_owned();
    assert!(matches!(
        fixture.session.prepare_pty_create(request.clone()),
        Err(SessionError::UnknownWorkspace(_))
    ));
    assert!(fixture.session.pty_create_failures.is_empty());
    request.workspace_handle = "workspace".to_owned();
    request.request_digest = vec![2];
    failure(fixture.session.prepare_pty_create(request));
    assert_eq!(fixture.session.pty_create_failures.len(), 1);
}
