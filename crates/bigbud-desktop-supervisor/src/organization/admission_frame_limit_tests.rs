use prost::Message;

use super::admission::{Admission, AdmissionError, CompactState};
use super::protocol::{
    policy::v1::Limits,
    v1::{Frame, Hello, frame::Payload},
};

fn hello() -> Hello {
    Hello {
        major: 1,
        minor: 0,
        capability: "compact-facts-v1".into(),
        limits: Some(Limits {
            frame_bytes: 128,
            page_rows: 1,
            live_rows: 2,
            state_bytes: 256,
            pending_facts: 2,
            pending_bytes: 256,
        }),
    }
}

fn bytes(nested: bool, padding: usize) -> Vec<u8> {
    let mut frame = Frame {
        backend_nonce: "backend".into(),
        generation: 7,
        payload: (!nested).then(|| Payload::Hello(hello())),
    }
    .encode_to_vec();
    let mut unknown = Vec::new();
    for _ in 0..padding {
        unknown.extend([0x98, 0x06, 1]);
    }
    if nested {
        let mut payload = hello().encode_to_vec();
        payload.extend(unknown);
        frame.push(0x1a);
        prost::encode_length_delimiter(payload.len(), &mut frame).expect("length");
        frame.extend(payload);
    } else {
        frame.extend(unknown);
    }
    frame
}

#[test]
fn hello_selected_limit_counts_received_unknown_fields_and_fences_rejection() {
    for nested in [false, true] {
        let within = bytes(nested, 2);
        assert!(within.len() < 128);
        assert_eq!(
            CompactState::new("backend".into(), 7).admit(&within),
            Ok(Admission::Negotiated)
        );
        let oversized = bytes(nested, 64);
        assert!(oversized.len() > 128 && oversized.len() < 1024 * 1024);
        let mut state = CompactState::new("backend".into(), 7);
        assert_eq!(state.admit(&oversized), Err(AdmissionError::Resync));
        assert!(state.rows().is_none());
        assert_eq!(state.admit(&within), Err(AdmissionError::Resync));
    }
}
