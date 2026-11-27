use std::collections::BTreeMap;

use super::{assert_frame, goldens, take, v1};
use v1::{Hello, ProofAttachChallenge, ProofAttachHello, ProofAttachProbe, frame::Payload};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let mut proofs = goldens(concat!(
        "server=0ccd3aa87d437c4c874767ca418fce1de0fd71da0a5ae5c4211db699061e584d\n",
        "client=4d37008410d3ce6598d07a89f42a18172795ab30d2ab8ae7d46cd86a2e2563f4\n",
    ));
    let hello = Hello {
        major: 1,
        profile_binding: b"fixture-profile".to_vec(),
        ..Hello::default()
    };
    for (name, payload) in [
        (
            "hello_attach_bootstrap",
            Payload::Hello(Hello {
                proof_attachment_capability: (0..32).collect(),
                ..hello.clone()
            }),
        ),
        (
            "attach_probe",
            Payload::ProofAttachProbe(ProofAttachProbe {
                client_nonce: (32..64).collect(),
                ..ProofAttachProbe::default()
            }),
        ),
        (
            "attach_challenge",
            Payload::ProofAttachChallenge(ProofAttachChallenge {
                server_nonce: (64..96).collect(),
                proof: take(&mut proofs, "server"),
                ..ProofAttachChallenge::default()
            }),
        ),
        (
            "attach_hello",
            Payload::ProofAttachHello(ProofAttachHello {
                hello: Some(hello),
                proof: take(&mut proofs, "client"),
            }),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
