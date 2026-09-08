use std::io::{BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use bigbud_desktop_supervisor::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, canonical_batch_id, read_frame, v1,
    write_frame,
};

fn send(stdin: &mut std::process::ChildStdin, payload: v1::frame::Payload) -> Result<(), String> {
    write_frame(
        stdin,
        &v1::Frame {
            payload: Some(payload),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn receive(reader: &mut BufReader<std::process::ChildStdout>) -> Result<v1::Frame, String> {
    read_frame(reader, DEFAULT_MAX_FRAME_BYTES)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "supervisor closed before returning a frame".to_owned())
}

fn run_missing_acknowledgement_scenario() -> Result<(), String> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-desktop-supervisor"))
        .env("BIGBUD_SUPERVISOR_ACK_TIMEOUT_MS", "50")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let Some(mut stdin) = child.stdin.take() else {
        let _kill_result = child.kill();
        let _wait_result = child.wait();
        return Err("desktop supervisor stdin was not piped".to_owned());
    };
    let Some(stdout) = child.stdout.take() else {
        let _kill_result = child.kill();
        let _wait_result = child.wait();
        return Err("desktop supervisor stdout was not piped".to_owned());
    };
    let mut reader = BufReader::new(stdout);

    send(
        &mut stdin,
        v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "desktop-test".to_owned(),
            requested_limits: None,
        }),
    )?;
    if !matches!(
        receive(&mut reader)?,
        v1::Frame {
            payload: Some(v1::frame::Payload::SupervisorHello(_))
        }
    ) {
        return Err("desktop supervisor did not complete the handshake".to_owned());
    }
    send(
        &mut stdin,
        v1::frame::Payload::AttachConsumer(v1::AttachConsumer {
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            server_epoch: "epoch-1".to_owned(),
            applied_sequence: 10,
        }),
    )?;
    if !matches!(
        receive(&mut reader)?,
        v1::Frame {
            payload: Some(v1::frame::Payload::ConsumerAttached(_))
        }
    ) {
        return Err("desktop supervisor did not attach the consumer".to_owned());
    }
    let mut batch = v1::EventBatch {
        batch_id: String::new(),
        server_epoch: "epoch-1".to_owned(),
        subscription_generation: 1,
        consumer_id: "main".to_owned(),
        consumer_generation: 1,
        events: vec![v1::Event {
            event_id: "event-11".to_owned(),
            sequence: 11,
            canonical_payload: vec![1],
        }],
    };
    batch.batch_id = canonical_batch_id(&batch);
    send(&mut stdin, v1::frame::Payload::EventBatch(batch))?;
    if !matches!(
        receive(&mut reader)?,
        v1::Frame {
            payload: Some(v1::frame::Payload::EventBatch(_))
        }
    ) {
        return Err("desktop supervisor did not deliver the event batch".to_owned());
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    let reader_thread = thread::spawn(move || {
        let result =
            read_frame(&mut reader, DEFAULT_MAX_FRAME_BYTES).map_err(|error| error.to_string());
        let _send_result = sender.send(result);
    });
    let recovery = receiver.recv_timeout(Duration::from_secs(2));
    if recovery.is_err() {
        let _kill_result = child.kill();
        let _wait_result = child.wait();
        return Err(
            "desktop supervisor did not emit timeout recovery while input was idle".to_owned(),
        );
    }
    let Ok(Ok(Some(frame))) = recovery else {
        let _kill_result = child.kill();
        let _wait_result = child.wait();
        return Err("desktop supervisor recovery frame was unavailable".to_owned());
    };
    let Some(v1::frame::Payload::RecoveryRequired(recovery)) = frame.payload else {
        let _kill_result = child.kill();
        let _wait_result = child.wait();
        return Err("desktop supervisor emitted a non-recovery frame".to_owned());
    };
    if recovery.from_sequence_exclusive != 10
        || recovery.reason_code != "application_acknowledgement_timeout"
    {
        return Err("desktop supervisor emitted incorrect recovery metadata".to_owned());
    }

    send(
        &mut stdin,
        v1::frame::Payload::Shutdown(v1::Shutdown {
            reason: "test-complete".to_owned(),
        }),
    )?;
    drop(stdin);
    child.wait().map_err(|error| error.to_string())?;
    reader_thread
        .join()
        .map_err(|_| "supervisor reader thread panicked".to_owned())?;
    Ok(())
}

#[test]
fn emits_recovery_while_input_is_idle_after_a_missing_acknowledgement() {
    let result = run_missing_acknowledgement_scenario();
    assert!(result.is_ok(), "watchdog scenario failed: {result:?}");
}
