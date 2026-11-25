use super::{
    attachment_proof::{Role, Token, proof_matches, transcript_proof},
    *,
};
use prost::Message;
use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject};

mod v1 {
    include!(concat!(env!("OUT_DIR"), "/bigbud.ssh_owner.v1.rs"));
}
use v1::{Frame, Hello, ProofAttachChallenge, ProofAttachHello, ProofAttachProbe, frame::Payload};

const FIRST_PIPE: &str = "BIGBUD_TEST_PROOF_FIRST_PIPE";
const SECOND_PIPE: &str = "BIGBUD_TEST_PROOF_SECOND_PIPE";
const PARENT: &str = "BIGBUD_TEST_PROOF_PARENT";
const KEY: Token = [0xa5; 32]; // Public synthetic test material; never sent in a frame.
const PROFILE: &[u8] = b"windows-challenge-fixture";

#[test]
fn verifies_mutual_proof_and_rejects_client_replay_on_a_fresh_pipe() {
    let first = OwnerPipe::create().expect("bind first private pipe");
    let second = OwnerPipe::create().expect("bind second private pipe");
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "windows_owner_pipe::pipe::tests::challenge::challenge_client_fixture",
            ])
            .env(FIRST_PIPE, first.name().as_str())
            .env(SECOND_PIPE, second.name().as_str())
            .env(PARENT, std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .expect("start test client"),
    );
    let expected = ExpectedPipePeer::from_handle(child.0.as_handle()).expect("pin spawned child");

    let mut pipe = first
        .accept(&expected, WAIT)
        .expect("verify spawned client");
    let fresh = challenge(&mut pipe);
    assert!(fresh.accepts_client_proof());
    drop(pipe);

    let mut pipe = second
        .accept(&expected, WAIT)
        .expect("verify same client again");
    let replay = challenge(&mut pipe);
    assert!(replay.client_nonce == fresh.client_nonce);
    assert!(replay.server_nonce != fresh.server_nonce);
    assert!(
        replay.presented == fresh.presented,
        "expected the actual prior proof"
    );
    assert!(!replay.accepts_client_proof());
    drop(pipe);

    // SAFETY: the child handle stays owned; this wait is bounded and read-only.
    assert_eq!(
        unsafe { WaitForSingleObject(child.0.as_handle().as_raw_handle(), 2000) },
        WAIT_OBJECT_0
    );
    assert!(child.0.wait().expect("reap challenge fixture").success());
}

#[test]
fn challenge_client_fixture() {
    let Ok(first) = std::env::var(FIRST_PIPE) else {
        return;
    };
    let second = std::env::var(SECOND_PIPE).expect("second pipe bootstrap");
    let parent = std::env::var(PARENT)
        .expect("parent bootstrap identity")
        .parse::<u32>()
        .expect("parent PID");
    // SAFETY: the test runner supplies the trusted PID out of band; the handle is query-only.
    let process = unsafe {
        owned(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            parent,
        ))
    }
    .expect("open launching test process");
    let expected = ExpectedPipePeer::from_handle(process.as_handle()).expect("pin parent");
    let client_nonce = nonce();
    let mut prior = None;
    for address in [first, second] {
        let address = PipeName::parse(&address).expect("fixture pipe name");
        let mut pipe = connect(&address, &expected, WAIT).expect("verify launching test process");
        send(
            &mut pipe,
            Payload::ProofAttachProbe(ProofAttachProbe {
                client_nonce: client_nonce.to_vec(),
            }),
        );
        let Payload::ProofAttachChallenge(challenge) = receive(&mut pipe) else {
            panic!("expected challenge");
        };
        let server_nonce = token(&challenge.server_nonce);
        assert!(proof_matches(
            &proof(Role::Server, &client_nonce, &server_nonce),
            &token(&challenge.proof),
        ));
        let presented =
            *prior.get_or_insert_with(|| proof(Role::Client, &client_nonce, &server_nonce));
        send(
            &mut pipe,
            Payload::ProofAttachHello(ProofAttachHello {
                hello: Some(hello()),
                proof: presented.to_vec(),
            }),
        );
        // Keep the client alive until the parent has checked the proof and closed its handle.
        assert!(pipe.read_frame(WAIT).expect("owner closes pipe").is_none());
    }
}

struct Exchange {
    client_nonce: Token,
    server_nonce: Token,
    presented: Token,
}

impl Exchange {
    fn accepts_client_proof(&self) -> bool {
        proof_matches(
            &proof(Role::Client, &self.client_nonce, &self.server_nonce),
            &self.presented,
        )
    }
}

fn challenge(pipe: &mut VerifiedPipe) -> Exchange {
    let Payload::ProofAttachProbe(probe) = receive(pipe) else {
        panic!("expected probe");
    };
    let client_nonce = token(&probe.client_nonce);
    let server_nonce = nonce();
    send(
        pipe,
        Payload::ProofAttachChallenge(ProofAttachChallenge {
            server_nonce: server_nonce.to_vec(),
            proof: proof(Role::Server, &client_nonce, &server_nonce).to_vec(),
        }),
    );
    let Payload::ProofAttachHello(response) = receive(pipe) else {
        panic!("expected attachment hello");
    };
    assert!(
        response.hello == Some(hello()),
        "expected fixture hello without key"
    );
    Exchange {
        client_nonce,
        server_nonce,
        presented: token(&response.proof),
    }
}

fn hello() -> Hello {
    Hello {
        major: 1,
        minor: 0,
        profile_binding: PROFILE.to_vec(),
        proof_attachment_capability: Vec::new(),
    }
}

fn proof(role: Role, client_nonce: &Token, server_nonce: &Token) -> Token {
    transcript_proof(&KEY, role, PROFILE, client_nonce, server_nonce)
}

fn token(bytes: &[u8]) -> Token {
    bytes.try_into().expect("32-byte nonce or proof")
}

fn nonce() -> Token {
    let mut bytes = [0; 32];
    // SAFETY: null algorithm selects the OS RNG and the output fits the buffer.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    assert!(status >= 0, "fixture RNG unavailable");
    bytes
}

fn send(pipe: &mut VerifiedPipe, payload: Payload) {
    let bytes = Frame {
        payload: Some(payload),
    }
    .encode_to_vec();
    pipe.write_frame(&bytes, WAIT)
        .expect("send attachment frame");
}

fn receive(pipe: &mut VerifiedPipe) -> Payload {
    let bytes = pipe
        .read_frame(WAIT)
        .expect("read frame")
        .expect("frame before EOF");
    Frame::decode(bytes.as_slice())
        .expect("decode frame")
        .payload
        .expect("attachment payload")
}
