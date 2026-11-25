use super::*;
use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject};

const FIXTURE_NAME: &str = "BIGBUD_TEST_ATTACH_PIPE";
const FIXTURE_PARENT: &str = "BIGBUD_TEST_ATTACH_PARENT";
const FRAMES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../protocol/ssh-owner/v1.golden.frames"
));

#[test]
fn exchanges_existing_v1_attachment_probes_with_an_independently_verified_child() {
    let owner = OwnerPipe::create().expect("bind owner");
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "windows_owner_pipe::pipe::tests::attachment::attachment_client_fixture",
            ])
            .env(FIXTURE_NAME, owner.name().as_str())
            .env(FIXTURE_PARENT, std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("start attachment client"),
    );
    let expected = ExpectedPipePeer::from_handle(child.0.as_handle()).expect("pin spawned child");
    let mut pipe = owner
        .accept(&expected, WAIT)
        .expect("verify spawned client");
    receive(&mut pipe, "attach_probe");
    send(&mut pipe, "attach_challenge");
    receive(&mut pipe, "attach_hello");
    drop(pipe);
    drop(child.0.stdin.take());
    // SAFETY: the child handle stays owned; this wait is bounded and read-only.
    assert_eq!(
        unsafe { WaitForSingleObject(child.0.as_handle().as_raw_handle(), 2000) },
        WAIT_OBJECT_0
    );
    assert!(child.0.wait().expect("reap completed fixture").success());
}

#[test]
fn attachment_client_fixture() {
    let Ok(name) = std::env::var(FIXTURE_NAME) else {
        return;
    };
    let parent = std::env::var(FIXTURE_PARENT)
        .expect("parent bootstrap identity")
        .parse::<u32>()
        .expect("parent PID");
    // SAFETY: trusted test bootstrap (not a PID learned from the pipe), query-only handle.
    let process = unsafe {
        owned(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            parent,
        ))
    }
    .expect("open launching test process");
    let expected = ExpectedPipePeer::from_handle(process.as_handle()).expect("pin parent");
    let name = PipeName::parse(&name).expect("test pipe name");
    let mut pipe = connect(&name, &expected, WAIT).expect("verify launching test process");
    send(&mut pipe, "attach_probe");
    receive(&mut pipe, "attach_challenge");
    send(&mut pipe, "attach_hello");
    // Keep the client alive until the parent has received the last frame.
    let mut byte = [0];
    assert_eq!(
        io::stdin()
            .read(&mut byte)
            .expect("parent closes fixture stdin"),
        0
    );
}

fn send(pipe: &mut VerifiedPipe, frame: &str) {
    pipe.write_frame(&payload(frame), WAIT)
        .expect("send golden payload");
}

fn receive(pipe: &mut VerifiedPipe, frame: &str) {
    assert_eq!(
        pipe.read_frame(WAIT).expect("read frame"),
        Some(payload(frame))
    );
}

// The frozen auth vectors are synthetic wire fixtures, not fresh proofs or
// credentials. Auth is not performed by VerifiedPipe.
fn payload(name: &str) -> Vec<u8> {
    let hex = FRAMES
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key == name).then_some(value)
        })
        .expect("golden attachment frame");
    let bytes = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| {
            u8::from_str_radix(std::str::from_utf8(chunk).expect("ASCII hex"), 16)
                .expect("hex byte")
        })
        .collect::<Vec<_>>();
    let (prefix, body) = bytes.split_at(4);
    assert_eq!(
        u32::from_be_bytes(prefix.try_into().expect("prefix")) as usize,
        body.len()
    );
    body.to_vec()
}
