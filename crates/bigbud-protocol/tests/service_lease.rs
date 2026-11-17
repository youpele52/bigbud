//! Cross-language compatibility; synthetic data is never native admission proof.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, decode_frame, encode_frame, service_lease::v1 as lease, v1,
};
fn binding() -> lease::Binding {
    lease::Binding {
        authority: "a".repeat(32),
        installation: format!("sha256:{}", "b".repeat(64)),
        native_epoch: "epoch-1".into(),
        nonce: "lease-1".into(),
        publication_sha256: vec![1; 32],
        executable_sha256: vec![2; 32],
        assets_sha256: vec![3; 32],
        configuration_sha256: vec![4; 32],
        guard_sha256: vec![5; 32],
    }
}
fn controller() -> lease::Controller {
    lease::Controller {
        pid: 42,
        boot: "fixture-boot".into(),
        started: "123".into(),
    }
}
fn query() -> lease::QueryRequest {
    lease::QueryRequest {
        request_id: "lease-request-1".into(),
        binding: Some(binding()),
        capability: vec![7; 32],
    }
}
fn response() -> lease::Response {
    lease::Response {
        request_id: "lease-request-1".into(),
        accepted: true,
        state: "spawned".into(),
        binding: Some(binding()),
        generation: 1,
        original_child_pid: 43,
        original_controller: Some(controller()),
        current_controller: Some(controller()),
        ..Default::default()
    }
}
fn environment() -> v1::ProcessEnvironment {
    v1::ProcessEnvironment {
        name: "UPSTREAM_CREDENTIAL".into(),
        value: "synthetic-fixture-only".into(),
    }
}
fn fixtures() -> Vec<(&'static str, v1::frame::Payload)> {
    use v1::frame::Payload::*;
    let started = response();
    let mut resumed = started.clone();
    resumed.generation = 2;
    resumed.bootstrap = vec![environment()];
    resumed.previous_controller = Some(controller());
    resumed.current_controller = Some(lease::Controller {
        pid: 44,
        started: "125".into(),
        ..controller()
    });
    // Successor Resume #1: same grant shape, but not "spawned" until the socket is attached.
    let mut attaching = resumed.clone();
    attaching.state = "attaching".into();
    let mut stopped = started.clone();
    stopped.state = "exited".into();
    stopped.generation = 2;
    let mut cancelled = started.clone();
    cancelled.state = "cancelled".into();
    cancelled.generation = 0;
    cancelled.original_child_pid = 0;
    cancelled.original_controller = None;
    cancelled.current_controller = None;
    vec![
        (
            "lease_empty_argument",
            ServiceLeaseStartRequest(Box::new(lease::StartRequest {
                request_id: "lease-request-1".into(),
                binding: Some(binding()),
                executable: "/private/gateway".into(),
                args: vec![String::new(), "--stdin-lifeline".into()],
                environment: vec![environment()],
                capability: vec![7; 32],
                guard: b"{}".to_vec(),
                assets_generation: format!("assets-{}", "0".repeat(32)),
                assets_receipt_size: 1234,
                assets_receipt_sha256: vec![6; 32],
                assets_argument: "--assets-dir".into(),
            })),
        ),
        (
            "lease_start",
            ServiceLeaseStartRequest(Box::new(lease::StartRequest {
                request_id: "lease-request-1".into(),
                binding: Some(binding()),
                executable: "/private/gateway".into(),
                args: vec!["--stdin-lifeline".into()],
                environment: vec![environment()],
                capability: vec![7; 32],
                guard: b"{}".to_vec(),
                assets_generation: format!("assets-{}", "0".repeat(32)),
                assets_receipt_size: 1234,
                assets_receipt_sha256: vec![6; 32],
                assets_argument: "--assets-dir".into(),
            })),
        ),
        (
            "lease_started",
            ServiceLeaseStartResponse(Box::new(started.clone())),
        ),
        ("lease_status", ServiceLeaseStatusRequest(Box::new(query()))),
        (
            "lease_status_response",
            ServiceLeaseStatusResponse(Box::new(started)),
        ),
        ("lease_resume", ServiceLeaseResumeRequest(Box::new(query()))),
        (
            "lease_resumed",
            ServiceLeaseResumeResponse(Box::new(resumed)),
        ),
        (
            "lease_resumed_attaching",
            ServiceLeaseResumeResponse(Box::new(attaching)),
        ),
        (
            "lease_stop",
            ServiceLeaseControlRequest(Box::new(lease::ControlRequest {
                request_id: "lease-request-1".into(),
                binding: Some(binding()),
                capability: vec![7; 32],
                generation: 2,
                action: "stop".into(),
            })),
        ),
        (
            "lease_stopped",
            ServiceLeaseControlResponse(Box::new(stopped)),
        ),
        (
            "lease_cancel",
            ServiceLeaseControlRequest(Box::new(lease::ControlRequest {
                request_id: "lease-request-1".into(),
                binding: Some(binding()),
                capability: vec![7; 32],
                generation: 0,
                action: "cancel-pending".into(),
            })),
        ),
        (
            "lease_cancelled",
            ServiceLeaseControlResponse(Box::new(cancelled)),
        ),
    ]
}
#[test]
fn native_service_lease_matches_all_typescript_goldens() {
    let file = include_str!("../../../protocol/remote-agent/service_lease.golden.frames");
    for (name, payload) in fixtures() {
        let (_, hex) = file
            .lines()
            .filter_map(|line| line.split_once('='))
            .find(|(key, _)| *key == name)
            .expect("shared lease golden");
        let expected = hex
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        let frame = v1::Frame {
            payload: Some(payload),
        };
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            expected,
            "{name}"
        );
        assert_eq!(
            decode_frame(&expected, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame,
            "{name}"
        );
    }
}
