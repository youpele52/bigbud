use std::collections::BTreeMap;

use prost::Message;
use sha2::{Digest, Sha256};

#[path = "support/agent_action_vectors.rs"]
mod agent_action_vectors;
#[path = "support/attachment_vectors.rs"]
mod attachment_vectors;
#[path = "support/consumer_vectors.rs"]
mod consumer_vectors;
#[path = "support/control_vectors.rs"]
mod control_vectors;
#[path = "support/grant_vectors.rs"]
mod grant_vectors;
#[path = "support/native_lease_vectors.rs"]
mod native_lease_vectors;
#[path = "support/opencode_vectors.rs"]
mod opencode_vectors;
#[path = "support/operands.rs"]
mod operands;
#[path = "support/peer_enrollment_vectors.rs"]
mod peer_enrollment_vectors;
#[path = "support/shell_vectors.rs"]
mod shell_vectors;
#[path = "support/target_vectors.rs"]
mod target_vectors;
#[path = "support/terminal_vectors.rs"]
mod terminal_vectors;
#[path = "support/transfer_vectors.rs"]
mod transfer_vectors;
#[path = "support/wire_helpers.rs"]
mod wire_helpers;
#[path = "support/workspace_vectors.rs"]
mod workspace_vectors;
use operands::operand_preimage;

mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.ssh_owner.v1.rs"));
}

use v1::{
    ApproveTrust, ConnectionState, Empty, Error, ErrorCode, Folder, Folders, Frame,
    ListFolders, Reply, Request, Trust, TrustState, frame::Payload, reply::Outcome,
    request::Operation,
};
use wire_helpers::{connection, hello};

const PICKER_PATH: &str = "~/café/資料";
const CLIENT_FRAME_MAX: usize = 64 * 1024;
const OWNER_FRAME_MAX: usize = 8 * 1024 * 1024;

fn goldens(source: &'static str) -> BTreeMap<&'static str, Vec<u8>> {
    let mut values = BTreeMap::new();
    for line in source
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let (name, hex) = line.split_once('=').expect("name=hex");
        assert!(
            !name.is_empty() && !hex.is_empty() && hex.len() % 2 == 0,
            "{line}"
        );
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
            .collect();
        assert!(values.insert(name, bytes).is_none(), "duplicate {name}");
    }
    values
}

fn take(values: &mut BTreeMap<&str, Vec<u8>>, name: &str) -> Vec<u8> {
    values
        .remove(name)
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn frame_length(prefix: &[u8], maximum: usize) -> Result<usize, &'static str> {
    let length = u32::from_be_bytes(prefix.try_into().map_err(|_| "prefix")?) as usize;
    if length == 0 {
        return Err("empty");
    }
    if length > maximum {
        return Err("oversized");
    }
    Ok(length)
}

fn frame_payload(encoded: &[u8], maximum: usize) -> Result<&[u8], &'static str> {
    let (prefix, payload) = encoded.split_first_chunk::<4>().ok_or("prefix")?;
    if frame_length(prefix, maximum)? != payload.len() {
        return Err("length");
    }
    Ok(payload)
}

fn request(operation: Operation) -> Payload {
    Payload::Request(Request {
        request_id: vec![1, 0x80, 0xff],
        owner_epoch: vec![0, 0x2a],
        target_generation: vec![4],
        target_id: "fixture-target".into(),
        grant: vec![0x80, 0],
        target_descriptor: None,
        operation: Some(operation),
    })
}

fn reply(outcome: Outcome) -> Payload {
    Payload::Reply(Reply {
        request_id: vec![1, 0x80, 0xff],
        owner_epoch: vec![0, 0x2a],
        target_generation: vec![4],
        outcome: Some(outcome),
    })
}

fn approve(challenge: [u8; 3]) -> Operation {
    Operation::ApproveTrust(ApproveTrust {
        challenge: challenge.into(),
    })
}

fn list(path: Option<&str>) -> Operation {
    Operation::ListFolders(ListFolders {
        path: path.map(str::to_owned),
    })
}

fn assert_frame(values: &mut BTreeMap<&str, Vec<u8>>, name: &str, payload: Payload) {
    let expected = take(values, name);
    let maximum = if matches!(
        payload,
        Payload::HelloAccepted(_)
            | Payload::Reply(_)
            | Payload::ProofAttachChallenge(_)
            | Payload::ProofGrantReply(_)
            | Payload::ProofStorageHydrate(_)
            | Payload::ProofStorageTransition(_)
            | Payload::ProofReconcileHydrate(_)
    ) {
        OWNER_FRAME_MAX
    } else {
        CLIENT_FRAME_MAX
    };
    let message = Frame {
        payload: Some(payload),
    };
    let payload = message.encode_to_vec();
    let mut framed = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
    framed.extend(payload);
    assert_eq!(framed, expected, "{name}");
    assert_eq!(
        Frame::decode(frame_payload(&expected, maximum).unwrap()).unwrap(),
        message,
        "{name}"
    );
}

#[test]
fn s1_wire_goldens() {
    let mut values = goldens(include_str!("../../v1.golden.frames"));
    agent_action_vectors::verify(&mut values);
    attachment_vectors::verify(&mut values);
    consumer_vectors::verify(&mut values);
    control_vectors::verify(&mut values);
    native_lease_vectors::verify(&mut values);
    peer_enrollment_vectors::verify(&mut values);
    shell_vectors::verify(&mut values);
    target_vectors::verify(&mut values);
    terminal_vectors::verify(&mut values);
    transfer_vectors::verify(&mut values);
    workspace_vectors::verify(&mut values);
    for (name, payload) in [
        ("hello", hello(1)),
        ("incompatible_major", hello(2)),
        ("inspect_trust", request(Operation::InspectTrust(Empty {}))),
        ("approve_trust", request(approve([0, 0xfe, 0xff]))),
        ("connect", request(Operation::Connect(Empty {}))),
        ("disconnect", request(Operation::Disconnect(Empty {}))),
        ("list_home_omitted", request(list(None))),
        ("list_home_empty", request(list(Some("")))),
        ("list_path", request(list(Some(PICKER_PATH)))),
        (
            "list_changed_same_id",
            request(list(Some("~/café/資料/other"))),
        ),
        (
            "trust_required",
            reply(Outcome::Trust(Trust {
                state: TrustState::ApprovalRequired.into(),
                challenge: vec![0, 0xfe, 0xff],
                key_type: "ssh-ed25519".into(),
                fingerprint: "SHA256:fixture".into(),
                jump_leg: 0,
            })),
        ),
        (
            "trust_verified",
            reply(Outcome::Trust(Trust {
                state: TrustState::Verified.into(),
                ..Trust::default()
            })),
        ),
        ("connected", connection(ConnectionState::Connected)),
        ("disconnected", connection(ConnectionState::Disconnected)),
        (
            "folders",
            reply(Outcome::Folders(Folders {
                path: "/home/fixture/café".into(),
                home_path: Some("/home/fixture".into()),
                truncated: Some(true),
                entries: vec![
                    Folder {
                        name: "src".into(),
                        has_git: true,
                    },
                    Folder {
                        name: "資".repeat(44),
                        has_git: false,
                    },
                ],
            })),
        ),
        (
            "folders_empty",
            reply(Outcome::Folders(Folders {
                path: "/home/fixture".into(),
                entries: vec![],
                home_path: Some("/home/fixture".into()),
                truncated: Some(false),
            })),
        ),
        (
            "folders_missing_metadata",
            reply(Outcome::Folders(Folders {
                path: "/home/fixture".into(),
                ..Folders::default()
            })),
        ),
    ] {
        assert_frame(&mut values, name, payload);
    }
    for (name, code) in [
        ("owner_unavailable", ErrorCode::OwnerUnavailable),
        ("operation_denied", ErrorCode::OperationDenied),
        ("invalid_operands", ErrorCode::InvalidOperands),
        ("target_disconnected", ErrorCode::TargetDisconnected),
        ("config_unsupported", ErrorCode::ConfigUnsupported),
        ("trust_required", ErrorCode::TrustRequired),
        ("host_key_changed", ErrorCode::HostKeyChanged),
        ("trust_store_read_only", ErrorCode::TrustStoreReadOnly),
        ("auth_required", ErrorCode::AuthRequired),
        ("transport_lost", ErrorCode::TransportLost),
        ("list_failed", ErrorCode::ListFailed),
        ("stale_generation", ErrorCode::StaleGeneration),
        ("storage_unavailable", ErrorCode::StorageUnavailable),
        ("outcome_unknown", ErrorCode::OutcomeUnknown),
        ("list_timed_out", ErrorCode::ListTimedOut),
        ("list_cancelled", ErrorCode::ListCancelled),
        ("health_cancelled", ErrorCode::HealthCancelled),
        ("list_path_unavailable", ErrorCode::ListPathUnavailable),
        ("list_invalid_output", ErrorCode::ListInvalidOutput),
        ("session_quota", ErrorCode::SessionQuota),
        (
            "windows_password_unsupported",
            ErrorCode::WindowsPasswordUnsupported,
        ),
        (
            "keyboard_interactive_unsupported",
            ErrorCode::KeyboardInteractiveUnsupported,
        ),
        (
            "owner_retirement_unverified",
            ErrorCode::OwnerRetirementUnverified,
        ),
        ("pane_unrecoverable", ErrorCode::PaneUnrecoverable),
    ] {
        assert_frame(
            &mut values,
            &format!("error_{name}"),
            reply(Outcome::Error(Error {
                code: code.into(),
                jump_failure: None,
            })),
        );
    }
    for (name, reason) in [
        ("truncated_prefix", "prefix"),
        ("empty_payload", "empty"),
        ("oversized_length", "oversized"),
        ("truncated_payload", "length"),
        ("trailing_bytes", "length"),
    ] {
        assert_eq!(
            frame_payload(&take(&mut values, name), CLIENT_FRAME_MAX),
            Err(reason),
            "{name}"
        );
    }
    let largest_client = take(&mut values, "client_maximum_prefix");
    let too_large_for_client = take(&mut values, "client_oversized_prefix");
    let largest_owner = take(&mut values, "owner_maximum_prefix");
    let too_large_for_owner = take(&mut values, "owner_oversized_prefix");
    assert_eq!(
        frame_length(&largest_client, CLIENT_FRAME_MAX),
        Ok(CLIENT_FRAME_MAX)
    );
    assert_eq!(
        frame_length(&too_large_for_client, CLIENT_FRAME_MAX),
        Err("oversized")
    );
    assert_eq!(
        frame_length(&too_large_for_client, OWNER_FRAME_MAX),
        Ok(CLIENT_FRAME_MAX + 1)
    );
    assert_eq!(
        frame_length(&largest_owner, OWNER_FRAME_MAX),
        Ok(OWNER_FRAME_MAX)
    );
    assert_eq!(
        frame_length(&too_large_for_owner, OWNER_FRAME_MAX),
        Err("oversized")
    );

    let malformed = take(&mut values, "malformed_protobuf");
    assert!(Frame::decode(frame_payload(&malformed, CLIENT_FRAME_MAX).unwrap()).is_err());
    let unknown = take(&mut values, "unknown_operation");
    let decoded = Frame::decode(frame_payload(&unknown, CLIENT_FRAME_MAX).unwrap()).unwrap();
    let Payload::Request(mut expected) = request(list(None)) else {
        unreachable!()
    };
    expected.operation = None;
    assert_eq!(decoded.payload, Some(Payload::Request(expected)));
    let unknown_payload = take(&mut values, "unknown_payload");
    assert_eq!(
        Frame::decode(frame_payload(&unknown_payload, CLIENT_FRAME_MAX).unwrap())
            .unwrap()
            .payload,
        None
    );
    let unknown_outcome = take(&mut values, "unknown_outcome");
    let Payload::Reply(mut expected) = connection(ConnectionState::Connected) else {
        unreachable!()
    };
    expected.outcome = None;
    assert_eq!(
        Frame::decode(frame_payload(&unknown_outcome, OWNER_FRAME_MAX).unwrap())
            .unwrap()
            .payload,
        Some(Payload::Reply(expected))
    );
    let unknown_error = take(&mut values, "unknown_error_code");
    assert_eq!(
        Frame::decode(frame_payload(&unknown_error, OWNER_FRAME_MAX).unwrap())
            .unwrap()
            .payload,
        Some(reply(Outcome::Error(Error {
            code: 127,
            jump_failure: None
        })))
    );
    assert!(ErrorCode::try_from(127).is_err());
    assert!(values.is_empty(), "unused goldens: {values:?}");
}

#[test]
fn normalized_operand_goldens() {
    let mut values = goldens(include_str!("../../v1.golden.operands"));
    for (name, operation) in [
        ("inspect", Operation::InspectTrust(Empty {})),
        ("connect", Operation::Connect(Empty {})),
        ("disconnect", Operation::Disconnect(Empty {})),
        ("approve", approve([0, 0xfe, 0xff])),
        ("approve_changed", approve([0, 0xfe, 0])),
        ("list_home_omitted", list(None)),
        ("list_home_empty", list(Some(""))),
        ("list_path", list(Some(PICKER_PATH))),
        ("list_changed", list(Some("~/café/資料/other"))),
        ("list_utf8_decomposed", list(Some("~/cafe\u{301}/資料"))),
        ("list_whitespace", list(Some("~/café/資料 "))),
    ] {
        let preimage = operand_preimage(operation);
        assert_eq!(
            preimage,
            take(&mut values, &format!("{name}.canonical")),
            "{name}"
        );
        assert_eq!(
            Sha256::digest(preimage).as_slice(),
            take(&mut values, &format!("{name}.sha256")),
            "{name}"
        );
    }
    assert!(values.is_empty(), "unused goldens: {values:?}");
}
