use std::fs;
use std::io::{self, Cursor};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};

use super::*;
use crate::operations::OperationJournal;
use crate::operations::journal::MAX_OPERATION_JOURNAL_BYTES;

const HELPER_TEST: &str = "supervisor::prepare::tests::fake_supervisor_helper";
const REAL_SUPERVISOR_TEST: &str = "supervisor::prepare::tests::real_supervisor_helper";

fn temp_root(label: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("bigbud-{label}-{}-{suffix}", std::process::id()))
}

fn spawn_helper(root: &Path, version: &str, digest: &str, active_child: bool) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", HELPER_TEST, "--nocapture"])
        .env("BIGBUD_TEST_SUPERVISOR_ROOT", root)
        .env("BIGBUD_TEST_SUPERVISOR_VERSION", version)
        .env("BIGBUD_TEST_SUPERVISOR_DIGEST", digest)
        .env(
            "BIGBUD_TEST_SUPERVISOR_ACTIVE_CHILD",
            if active_child { "1" } else { "0" },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn spawn_real_supervisor(root: &Path) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", REAL_SUPERVISOR_TEST, "--nocapture"])
        .env("BIGBUD_TEST_REAL_SUPERVISOR_ROOT", root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn wait_for_socket(socket: &Path) {
    for _ in 0..100 {
        if socket.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("helper supervisor socket was not ready");
}

fn handshake_through_proxy(socket: &Path) -> v1::AgentHello {
    let mut input = Vec::new();
    write_frame(
        &mut input,
        &v1::Frame {
            payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                client_instance_id: "proxy-client".to_owned(),
                connection_id: "proxy-connection".to_owned(),
                server_nonce: "proxy-nonce".to_owned(),
                max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
            })),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .unwrap();
    let mut output = Vec::new();
    super::super::run_proxy(Cursor::new(input), &mut output, socket).unwrap();
    match read_frame(&mut Cursor::new(output), DEFAULT_MAX_FRAME_BYTES)
        .unwrap()
        .unwrap()
        .payload
    {
        Some(v1::frame::Payload::AgentHello(hello)) => hello,
        _ => panic!("proxy returned an invalid handshake"),
    }
}

fn wait_for_exit(child: &mut Child) {
    for _ in 0..100 {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    panic!("helper supervisor did not exit");
}

fn write_request(stream: &mut UnixStream, payload: v1::frame::Payload) {
    write_frame(
        stream,
        &v1::Frame {
            payload: Some(payload),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .unwrap();
}

fn read_until(
    stream: &mut UnixStream,
    matches: impl Fn(&v1::frame::Payload) -> bool,
) -> v1::frame::Payload {
    loop {
        let payload = read_frame(stream, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .unwrap()
            .payload
            .unwrap();
        if matches(&payload) {
            return payload;
        }
    }
}

#[test]
fn replaces_an_idle_protocol_incompatible_supervisor_and_accepts_the_new_identity() {
    let root = temp_root("supervisor-idle-takeover");
    fs::create_dir_all(&root).unwrap();
    let socket = root.join("supervisor.sock");
    let mut old = spawn_helper(&root, "unsupported-protocol", "old-digest", false);
    wait_for_socket(&socket);

    assert_eq!(
        prepare_supervisor_for_identity(&socket, "new", "new-digest").unwrap(),
        SupervisorPreparation::StartRequired
    );
    wait_for_exit(&mut old);
    fs::remove_file(&socket).unwrap();

    let mut new = spawn_helper(&root, "new", "new-digest", false);
    wait_for_socket(&socket);
    assert_eq!(
        prepare_supervisor_for_identity(&socket, "new", "new-digest").unwrap(),
        SupervisorPreparation::Ready
    );
    assert_eq!(handshake_through_proxy(&socket).build_digest, "new-digest");

    let _ = new.kill();
    let _ = new.wait();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn blocks_takeover_and_resumes_a_supervisor_with_a_worker_child() {
    let root = temp_root("supervisor-busy-takeover");
    fs::create_dir_all(&root).unwrap();
    let socket = root.join("supervisor.sock");
    let child_pid_path = root.join("child.pid");
    let mut old = spawn_helper(&root, "unsupported-protocol", "old-digest", true);
    wait_for_socket(&socket);
    for _ in 0..100 {
        if child_pid_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let child_pid: libc::pid_t = fs::read_to_string(&child_pid_path)
        .unwrap()
        .parse()
        .unwrap();

    assert_eq!(
        prepare_supervisor_for_identity(&socket, "new", "new-digest").unwrap(),
        SupervisorPreparation::BlockedActiveWork
    );
    assert_eq!(
        prepare_supervisor_for_identity(&socket, "new", "new-digest").unwrap(),
        SupervisorPreparation::BlockedActiveWork
    );

    assert_eq!(unsafe { libc::kill(child_pid, 0) }, 0);

    unsafe {
        libc::kill(child_pid, libc::SIGKILL);
    }
    let _ = old.kill();
    let _ = old.wait();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn blocks_takeover_while_a_real_supervisor_owns_an_active_pty() {
    let root = temp_root("supervisor-active-pty");
    fs::create_dir_all(&root).unwrap();
    let socket = root.join("supervisor.sock");
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let mut supervisor = spawn_real_supervisor(&root);
    wait_for_socket(&socket);

    let mut stream = UnixStream::connect(&socket).unwrap();
    write_request(
        &mut stream,
        v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "pty-client".to_owned(),
            connection_id: "pty-connection".to_owned(),
            server_nonce: "pty-nonce".to_owned(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }),
    );
    let _ = read_until(&mut stream, |payload| {
        matches!(payload, v1::frame::Payload::AgentHello(_))
    });
    write_request(
        &mut stream,
        v1::frame::Payload::WorkspaceOpenRequest(v1::WorkspaceOpenRequest {
            request_id: "open-workspace".to_owned(),
            workspace_handle: "workspace".to_owned(),
            root: workspace.to_string_lossy().into_owned(),
        }),
    );
    let _ = read_until(
        &mut stream,
        |payload| matches!(payload, v1::frame::Payload::WorkspaceOpenResponse(response) if response.accepted),
    );
    write_request(
        &mut stream,
        v1::frame::Payload::PtyCreateRequest(v1::PtyCreateRequest {
            request_id: "create-pty".to_owned(),
            pty_id: "active-pty".to_owned(),
            request_digest: vec![1],
            workspace_handle: "workspace".to_owned(),
            cwd: String::new(),
            shell: "sh".to_owned(),
            args: vec!["-c".to_owned(), "sleep 30".to_owned()],
            cols: 80,
            rows: 24,
            environment: Vec::new(),
        }),
    );
    let _ = read_until(
        &mut stream,
        |payload| matches!(payload, v1::frame::Payload::PtyCreateResponse(response) if response.accepted),
    );

    assert_eq!(
        prepare_supervisor_for_identity(&socket, "future", "future-digest").unwrap(),
        SupervisorPreparation::BlockedActiveWork
    );
    write_request(
        &mut stream,
        v1::frame::Payload::PtyResizeRequest(v1::PtyResizeRequest {
            request_id: "resize-after-blocked-upgrade".to_owned(),
            pty_id: "active-pty".to_owned(),
            cols: 100,
            rows: 40,
        }),
    );
    let _ = read_until(
        &mut stream,
        |payload| matches!(payload, v1::frame::Payload::PtyResizeResponse(response) if response.accepted),
    );
    write_request(
        &mut stream,
        v1::frame::Payload::PtyCloseRequest(v1::PtyCloseRequest {
            request_id: "close-pty".to_owned(),
            pty_id: "active-pty".to_owned(),
            terminate: true,
        }),
    );
    let _ = read_until(
        &mut stream,
        |payload| matches!(payload, v1::frame::Payload::PtyCloseResponse(response) if response.accepted),
    );

    let _ = supervisor.kill();
    let _ = supervisor.wait();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_supervisor_helper() {
    let Ok(root) = std::env::var("BIGBUD_TEST_REAL_SUPERVISOR_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let session = crate::AgentSession::with_epoch_and_journal(
        "real-supervisor-test",
        root.join("operations.journal"),
    )
    .unwrap();
    super::super::run_supervisor(session, &root.join("supervisor.sock")).unwrap();
}

#[test]
fn fake_supervisor_helper() {
    let Ok(root) = std::env::var("BIGBUD_TEST_SUPERVISOR_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let socket = root.join("supervisor.sock");
    let version = std::env::var("BIGBUD_TEST_SUPERVISOR_VERSION").unwrap();
    let digest = std::env::var("BIGBUD_TEST_SUPERVISOR_DIGEST").unwrap();
    OperationJournal::open(root.join("operations.journal"), MAX_OPERATION_JOURNAL_BYTES).unwrap();
    if std::env::var("BIGBUD_TEST_SUPERVISOR_ACTIVE_CHILD").as_deref() == Ok("1") {
        let child_pid_path = root.join("child.pid");
        std::thread::spawn(move || {
            let mut child = Command::new("sleep").arg("30").spawn().unwrap();
            fs::write(child_pid_path, child.id().to_string()).unwrap();
            let _ = child.wait();
        });
    }
    let listener = UnixListener::bind(socket).unwrap();
    fs::set_permissions(
        root.join("supervisor.sock"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    for stream in listener.incoming() {
        let _ = serve_helper_connection(stream.unwrap(), &version, &digest);
    }
}

#[path = "supervisor.prepare.process_race.tests.rs"]
mod process_race_tests;

fn serve_helper_connection(mut stream: UnixStream, version: &str, digest: &str) -> io::Result<()> {
    let request = read_frame(&mut stream, DEFAULT_MAX_FRAME_BYTES).map_err(io::Error::other)?;
    if !matches!(
        request.and_then(|frame| frame.payload),
        Some(v1::frame::Payload::ClientHello(_))
    ) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected client hello",
        ));
    }
    let payload = if version == "unsupported-protocol" {
        v1::frame::Payload::ProtocolError(v1::ProtocolError {
            request_id: String::new(),
            code: "UNSUPPORTED_PROTOCOL_MAJOR".to_owned(),
            message: "unsupported protocol major".to_owned(),
        })
    } else {
        v1::frame::Payload::AgentHello(v1::AgentHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            agent_version: version.to_owned(),
            build_digest: digest.to_owned(),
            os: "linux".to_owned(),
            architecture: std::env::consts::ARCH.to_owned(),
            agent_instance_id: "helper".to_owned(),
            agent_epoch: "helper-epoch".to_owned(),
            capabilities: Vec::new(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
            max_operation_output_bytes: 1024,
            max_journal_bytes: 1024,
        })
    };
    write_frame(
        &mut stream,
        &v1::Frame {
            payload: Some(payload),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .map_err(io::Error::other)
}
