use super::super::{
    admission::{Admission, AdmissionError, CompactState},
    protocol::v1::{Frame, Hello, frame::Payload},
};
use super::*;

fn limits() -> Limits {
    Limits {
        frame_bytes: MAX_FRAME_BYTES as u32,
        page_rows: 256,
        live_rows: 100_000,
        state_bytes: 64 * 1024 * 1024,
        pending_facts: 2_000,
        pending_bytes: 8 * 1024 * 1024,
    }
}
fn frame(hello: Hello) -> Vec<u8> {
    Frame {
        backend_nonce: "backend".into(),
        generation: 7,
        payload: Some(Payload::Hello(hello)),
    }
    .encode_to_vec()
}
fn hello() -> Hello {
    Hello {
        major: 1,
        minor: 0,
        capability: "compact-facts-v1".into(),
        limits: Some(limits()),
    }
}
#[test]
fn hello_requires_compatible_capability_and_bounded_nonzero_limits() {
    for invalid in [
        Hello {
            major: 2,
            ..hello()
        },
        Hello {
            capability: "scheduling".into(),
            ..hello()
        },
        Hello {
            limits: None,
            ..hello()
        },
        Hello {
            limits: Some(Limits {
                page_rows: 257,
                ..limits()
            }),
            ..hello()
        },
        Hello {
            limits: Some(Limits {
                pending_facts: 0,
                ..limits()
            }),
            ..hello()
        },
    ] {
        assert_eq!(
            CompactState::new("backend".into(), 7).admit(&frame(invalid)),
            Err(AdmissionError::Resync)
        );
    }
    let mut state = CompactState::new("backend".into(), 7);
    assert_eq!(state.admit(&frame(hello())), Ok(Admission::Negotiated));
    assert_eq!(state.admit(&frame(hello())), Err(AdmissionError::Resync));
}
#[test]
fn ambiguous_envelope_never_uses_last_oneof_wins() {
    let mut bytes = frame(hello());
    bytes.extend(frame(hello()));
    assert!(!valid_envelope(&bytes));
    // A second payload without duplicate epoch fields must also be rejected.
    let mut bytes = frame(hello());
    bytes.extend([0x22, 0x00]);
    assert!(!valid_envelope(&bytes));
    assert_eq!(
        CompactState::new("backend".into(), 7).admit(&bytes),
        Err(AdmissionError::Resync)
    );
}
#[test]
fn unknown_fields_are_forward_compatible_but_wrong_wire_types_are_not() {
    let mut bytes = frame(hello());
    // Field 100 remains unassigned; field 8 now belongs to the scheduling protocol.
    bytes.extend([0xa0, 0x06, 0x01]);
    assert!(valid_envelope(&bytes));
    assert_eq!(
        CompactState::new("backend".into(), 7).admit(&bytes),
        Ok(Admission::Negotiated)
    );
    assert!(!valid_envelope(&[0x08, 0x01]));
    assert!(!valid_envelope(&[0x0a, 0xff]));
}

#[test]
fn recursive_wire_guard_rejects_shared_nested_duplicates() {
    for line in
        include_str!("../../../../protocol/thread-organization/malformed-duplicates.hex").lines()
    {
        let bytes: Vec<u8> = line
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("byte")
            })
            .collect();
        assert!(!valid_envelope(&bytes));
    }
    let mut bytes = frame(hello());
    // Repeated unknown field 99 remains forward compatible.
    bytes.extend([0x98, 0x06, 1, 0x98, 0x06, 2]);
    assert!(valid_envelope(&bytes));
}
