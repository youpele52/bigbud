use super::*;

fn connect_and_handshake(socket: &Path, label: &str) -> UnixStream {
    let mut stream = UnixStream::connect(socket).unwrap();
    write_request(
        &mut stream,
        v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: format!("{label}-client"),
            connection_id: format!("{label}-connection"),
            server_nonce: format!("{label}-nonce"),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }),
    );
    let _ = read_until(&mut stream, |payload| {
        matches!(payload, v1::frame::Payload::AgentHello(_))
    });
    stream
}

#[test]
fn blocks_takeover_after_process_acceptance_and_before_child_spawn() {
    let root = temp_root("supervisor-process-accept-race");
    let workspace = root.join("workspace");
    let barrier = root.join("spawn-barrier");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&barrier).unwrap();
    let socket = root.join("supervisor.sock");
    let mut supervisor = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", REAL_SUPERVISOR_TEST, "--nocapture"])
        .env("BIGBUD_TEST_REAL_SUPERVISOR_ROOT", &root)
        .env("BIGBUD_TEST_PROCESS_SPAWN_BARRIER", &barrier)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket);

    let mut stream = connect_and_handshake(&socket, "process");
    write_request(
        &mut stream,
        v1::frame::Payload::WorkspaceOpenRequest(v1::WorkspaceOpenRequest {
            request_id: "open-process-workspace".to_owned(),
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
        v1::frame::Payload::ProcessRequest(v1::ProcessRequest {
            request_id: "run-process".to_owned(),
            operation_id: "accepted-before-spawn".to_owned(),
            request_digest: vec![1],
            workspace_handle: "workspace".to_owned(),
            command: "sh".to_owned(),
            args: vec!["-c".to_owned(), "printf usable".to_owned()],
            timeout_ms: 5_000,
            max_output_bytes: 1_024,
            environment: Vec::new(),
            stdin: Vec::new(),
        }),
    );
    let _ = read_until(
        &mut stream,
        |payload| matches!(payload, v1::frame::Payload::ProcessAccepted(response) if response.accepted),
    );
    for _ in 0..100 {
        if barrier.join("accepted").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        fs::read_to_string(barrier.join("accepted")).unwrap(),
        "accepted-before-spawn"
    );

    assert_eq!(
        prepare_supervisor_for_identity(&socket, "future", "future-digest").unwrap(),
        SupervisorPreparation::BlockedActiveWork
    );
    let mut attached = connect_and_handshake(&socket, "attach");
    write_request(
        &mut attached,
        v1::frame::Payload::ProcessAttachRequest(v1::ProcessAttachRequest {
            request_id: "attach-after-refusal".to_owned(),
            operation_id: "accepted-before-spawn".to_owned(),
            after_sequence: 0,
        }),
    );
    let attach = read_until(&mut attached, |payload| {
        matches!(payload, v1::frame::Payload::ProcessAttachResponse(_))
    });
    assert!(matches!(
        attach,
        v1::frame::Payload::ProcessAttachResponse(response) if response.state == "running"
    ));

    fs::write(barrier.join("release"), b"release").unwrap();
    let output = read_until(&mut stream, |payload| {
        matches!(payload, v1::frame::Payload::ProcessOutput(_))
    });
    assert!(matches!(
        output,
        v1::frame::Payload::ProcessOutput(response) if response.bytes == b"usable"
    ));
    let _ = read_until(&mut stream, |payload| {
        matches!(payload, v1::frame::Payload::ProcessCompleted(_))
    });

    let _ = supervisor.kill();
    let _ = supervisor.wait();
    let _ = fs::remove_dir_all(root);
}
