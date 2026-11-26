use prost::Message;
use sha2::{Digest, Sha256};

use super::{CLIENT_FRAME_MAX, frame_payload, goldens, operand_preimage, take, v1};
use v1::{Frame, frame::Payload};

#[test]
fn all_positive_requests_have_a_canonical_grant_digest() {
    let mut digests = goldens(include_str!("../../../v1.golden.grants"));
    for (name, bytes) in goldens(include_str!("../../../v1.golden.frames")) {
        let Some(request) = frame_payload(&bytes, CLIENT_FRAME_MAX)
            .ok()
            .and_then(|body| Frame::decode(body).ok())
            .and_then(|frame| match frame.payload {
                Some(Payload::Request(request)) => Some(request),
                _ => None,
            })
        else {
            continue;
        };
        let Some(operation) = request.operation else {
            assert_eq!(name, "unknown_operation");
            continue;
        };
        let digest = Sha256::digest(operand_preimage(operation));
        assert_eq!(digest.as_slice(), take(&mut digests, name), "{name}");
    }
    assert!(
        digests.is_empty(),
        "unused grant digest vectors: {digests:?}"
    );
}
