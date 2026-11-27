#[path = "../../../attachment_proof.rs"]
mod attachment_proof;

use std::io::{Read, Write};

use crate::{
    RunResult, Token,
    owner::valid_hello,
    owner_pipe::{Pipe, protocol_error},
    random_token,
    v1::{ProofAttachChallenge, frame::Payload},
};

use attachment_proof::{Role, proof_matches, transcript_proof};

pub(super) fn authenticate<R: Read, W: Write>(
    pipe: &mut Pipe<R, W>,
    capability: &Token,
    profile: &[u8],
    identity: &Token,
) -> RunResult<bool> {
    let Some(Payload::ProofAttachProbe(probe)) = pipe.recv()? else {
        return Err(protocol_error().into());
    };
    let client_nonce = fixed_token(&probe.client_nonce)?;
    // An empty expectation (fixtures) skips the check; any other value must be
    // exactly this owner's identity. A mismatch is reported only after the peer
    // proved the capability.
    let mismatch = match probe.expected_artifact_identity.as_slice() {
        [] => false,
        expected => expected != identity.as_slice(),
    };
    let server_nonce = random_token()?;
    let proof = transcript_proof(
        capability,
        Role::Server,
        profile,
        client_nonce,
        &server_nonce,
    );
    pipe.send(Payload::ProofAttachChallenge(ProofAttachChallenge {
        server_nonce: server_nonce.to_vec(),
        proof: proof.to_vec(),
        owner_artifact_identity: identity.to_vec(),
    }))?;
    let Some(Payload::ProofAttachHello(response)) = pipe.recv()? else {
        return Err(protocol_error().into());
    };
    let presented = fixed_token(&response.proof)?;
    let expected = transcript_proof(
        capability,
        Role::Client,
        profile,
        client_nonce,
        &server_nonce,
    );
    if !proof_matches(&expected, presented) {
        return Err(protocol_error().into());
    }
    let hello = response.hello.ok_or_else(protocol_error)?;
    if !hello.proof_attachment_capability.is_empty() || !valid_hello(&hello, profile) {
        return Err(protocol_error().into());
    }
    Ok(mismatch)
}

fn fixed_token(bytes: &[u8]) -> std::io::Result<&Token> {
    bytes.try_into().map_err(|_| protocol_error())
}
