use super::{common, control, execution, outcome, v1, *};
use v1::frame::Payload;

fn golden(name: &str) -> Vec<u8> {
    let (_, hex) = include_str!("../../../../protocol/computer-use/v1.golden.frames")
        .lines()
        .find_map(|line| line.split_once('=').filter(|(key, _)| *key == name))
        .expect("golden");
    decode_hex(hex)
}
fn decode_hex(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn computer_use_rejects_shared_uint32_overflow_before_prost_narrowing() {
    for line in include_str!("../../../../protocol/computer-use/v1.invalid.frames").lines() {
        let (name, hex) = line.split_once('=').unwrap();
        let channel = if name.starts_with("primitive") {
            Channel::Data
        } else {
            Channel::Control
        };
        assert!(decode_frame(&decode_hex(hex), channel).is_err(), "{name}");
    }
}
fn hello() -> common::Hello {
    common::Hello {
        protocol_major: 1,
        protocol_minor: 0,
        tuple_digest: "a".repeat(64),
        role: "server".into(),
        owner_generation: "owner-1".into(),
        worker_generation: "worker-1".into(),
        qualification_profile: QUALIFICATION_PROFILE.into(),
        control_frame_bytes: CONTROL_FRAME_BYTES as u32,
        data_frame_bytes: DATA_FRAME_BYTES as u32,
        instance_id: "server-1".into(),
    }
}
#[test]
fn computer_use_shared_goldens() {
    let samples = [
        ("hello", Channel::Control, Payload::Hello(hello())),
        (
            "stop",
            Channel::Control,
            Payload::Stop(control::Stop {
                operation_id: "stop-1".into(),
                desktop_scope: "desktop-1".into(),
            }),
        ),
        (
            "stop_bom",
            Channel::Control,
            Payload::Stop(control::Stop {
                operation_id: "\u{feff}x".into(),
                desktop_scope: "d".into(),
            }),
        ),
        (
            "apply_policy",
            Channel::Control,
            Payload::ApplyPolicy(policy::ApplyPolicy {
                request_id: "request-1".into(),
                authority_id: "authority-1".into(),
                revision: "7".into(),
                digest: vec![0xab; 32],
                canonical_policy: vec![1, 2, 3, 4],
                fence_id: "fence-1".into(),
            }),
        ),
        (
            "revoked",
            Channel::Control,
            Payload::Revoked(control::Revoked {
                operation_id: "stop-1".into(),
                pause_epoch: u64::MAX,
                settlement_id: "settlement-1".into(),
            }),
        ),
        (
            "mediated_call",
            Channel::Data,
            Payload::MediatedCall(execution::MediatedCall {
                ticket: "ticket-1".into(),
                primitive_index: 2,
                mcp_frame: b"{}".to_vec(),
            }),
        ),
        (
            "operation_result",
            Channel::Data,
            Payload::OperationResult(outcome::OperationResult {
                operation_id: "operation-1".into(),
                completion: "unknown".into(),
                code: "retirement_unknown".into(),
                projected_result: vec![],
                capture_error: String::new(),
            }),
        ),
    ];
    for (name, channel, payload) in samples {
        let frame = v1::Frame {
            payload: Some(payload),
        };
        let bytes = golden(name);
        assert_eq!(encode_frame(&frame, channel).unwrap(), bytes);
        assert_eq!(decode_frame(&bytes, channel).unwrap(), frame);
    }
}
#[test]
fn computer_use_incompatible_hello_and_channels() {
    validate_hello(&hello(), &"a".repeat(64)).unwrap();
    for changed in [
        common::Hello {
            protocol_major: 2,
            ..hello()
        },
        common::Hello {
            protocol_minor: 1,
            ..hello()
        },
        common::Hello {
            role: "provider".into(),
            ..hello()
        },
        common::Hello {
            control_frame_bytes: 1,
            ..hello()
        },
        common::Hello {
            qualification_profile: "unknown".into(),
            ..hello()
        },
    ] {
        assert!(validate_hello(&changed, &"a".repeat(64)).is_err());
    }
    assert!(decode_frame(&golden("mediated_call"), Channel::Control).is_err());
    assert!(decode_frame(&golden("stop"), Channel::Data).is_err());
}
#[test]
fn computer_use_rejects_malformed_before_payload_allocation() {
    for bytes in [
        vec![],
        vec![0, 0, 0, 0],
        vec![1, 255, 255, 255],
        vec![0, 0, 0, 2, 0x42],
        vec![0, 0, 0, 4, 0x42, 0, 0x42, 0],
    ] {
        assert!(decode_frame(&bytes, Channel::Control).is_err());
    }
    for payload in [
        vec![0x42, 4, 0x0a, 0, 0x0a, 0],
        vec![0x42, 2, 0x1a, 0],
        vec![0x42, 3, 0x0a, 1, 255],
        vec![
            0x4a, 11, 0x10, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2,
        ],
    ] {
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend(payload);
        assert!(decode_frame(&bytes, Channel::Control).is_err());
    }
}
#[test]
fn computer_use_bounds_and_empty_payload() {
    assert!(encode_frame(&v1::Frame { payload: None }, Channel::Control).is_err());
    let mut frame = v1::Frame {
        payload: Some(Payload::Stop(control::Stop {
            operation_id: "a".repeat(129),
            desktop_scope: "desktop".into(),
        })),
    };
    assert!(encode_frame(&frame, Channel::Control).is_err());
    frame.payload = Some(Payload::ApplyPolicy(policy::ApplyPolicy {
        digest: vec![0; 31],
        ..Default::default()
    }));
    assert!(encode_frame(&frame, Channel::Control).is_err());
}
