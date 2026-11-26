#![allow(clippy::expect_used)]

use super::*;
use std::{
    io::Read as _,
    os::windows::io::AsHandle as _,
    process::{Child, Command, Stdio},
};
use windows_sys::Win32::{
    Foundation::ERROR_ACCESS_DENIED,
    Storage::FileSystem::SYNCHRONIZE,
    System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

mod acl;
mod attachment;
#[path = "../../attachment_proof.rs"]
mod attachment_proof;
mod challenge;
mod framed_io;

const WAIT: Duration = Duration::from_secs(2);
const FIXTURE: &str = "BIGBUD_TEST_OWNER_PIPE_PEER";

fn open_this_process() -> OwnedHandle {
    // SAFETY: opening self for query only, producing a new owned process handle.
    unsafe {
        owned(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            std::process::id(),
        ))
    }
    .expect("open current process")
}

fn this_process() -> ExpectedPipePeer {
    ExpectedPipePeer::from_handle(open_this_process().as_handle()).expect("pin current process")
}

#[test]
fn round_trip_checks_both_peer_ends_and_holds_exclusivity_until_drop() {
    let me = this_process();
    let owner = OwnerPipe::create().expect("bind owner");
    let address = owner.name().clone();
    let collision = OwnerPipe::bind(address.clone())
        .err()
        .expect("cannot take ownership");
    assert_eq!(collision.raw_os_error(), Some(ERROR_ACCESS_DENIED as i32));
    // Exercise the client-first arrival race, which yields ERROR_PIPE_CONNECTED on accept.
    let client = connect(&address, &me, WAIT).expect("kernel server PID verified");
    let server = owner.accept(&me, WAIT).expect("kernel client PID verified");
    let busy = connect(&address, &me, Duration::from_millis(30))
        .err()
        .expect("occupied instance");
    assert_eq!(busy.kind(), io::ErrorKind::TimedOut);
    assert!(OwnerPipe::bind(address.clone()).is_err());
    drop(client);
    drop(server);
    drop(OwnerPipe::bind(address).expect("last endpoint drop releases name"));
}

#[test]
fn absent_client_times_out_and_consumes_listener() {
    let owner = OwnerPipe::create().expect("bind owner");
    let address = owner.name().clone();
    let error = owner
        .accept(&this_process(), Duration::from_millis(30))
        .err()
        .expect("no client");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    drop(OwnerPipe::bind(address).expect("timed-out listener closed"));
}

fn spawn_peer_fixture() -> ChildGuard {
    ChildGuard(
        Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", "windows_owner_pipe::pipe::tests::peer_fixture"])
            .env(FIXTURE, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start a different live process"),
    )
}

#[test]
fn spawned_binding_rejects_wrong_image_same_image_peer_and_exited_child() {
    let image = std::env::current_exe().expect("test executable");
    let mut child = spawn_peer_fixture();
    let other = spawn_peer_fixture();
    let wrong_path = image.with_extension("not-the-test-image");
    let error = ExpectedPipePeer::from_spawned_image(child.0.as_handle(), &wrong_path)
        .err()
        .expect("wrong image is not bound");
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    let pipe_only = ExpectedPipePeer::from_handle(child.0.as_handle()).expect("pin pipe peer");
    assert!(
        pipe_only
            .verify_spawned_process(child.0.as_handle())
            .is_err()
    );

    let peer = ExpectedPipePeer::from_spawned_image(child.0.as_handle(), &image)
        .expect("pin launched child and image");
    let duplicate = child.0.as_handle().try_clone_to_owned().expect("duplicate");
    peer.verify_spawned_process(duplicate.as_handle())
        .expect("same live process object");
    assert_eq!(
        peer.verify_spawned_process(other.0.as_handle())
            .expect_err("same executable is not the same process")
            .kind(),
        io::ErrorKind::PermissionDenied
    );

    exit_peer_fixture(&mut child);
    assert!(peer.verify_spawned_process(duplicate.as_handle()).is_err());
    assert!(ExpectedPipePeer::from_spawned_image(duplicate.as_handle(), &image).is_err());
}

#[test]
fn immediate_child_requires_two_verified_live_bindings_and_the_recorded_parent() {
    let image = std::env::current_exe().expect("test executable");
    let parent = ExpectedPipePeer::from_spawned_image(open_this_process().as_handle(), &image)
        .expect("bind actual parent");
    let sibling = spawn_peer_fixture();
    let wrong_parent = ExpectedPipePeer::from_spawned_image(sibling.0.as_handle(), &image)
        .expect("bind same-image sibling");
    // Give the sibling an earlier creation time even on a coarse system clock;
    // its rejection must be based on parentage, not on birth order alone.
    std::thread::sleep(Duration::from_millis(50));
    let mut child = spawn_peer_fixture();
    let helper = ExpectedPipePeer::from_spawned_image(child.0.as_handle(), &image)
        .expect("bind helper fixture");
    parent
        .verify_immediate_child(&helper)
        .expect("actual parent");
    assert_eq!(
        wrong_parent
            .verify_immediate_child(&helper)
            .expect_err("same-image foreign parent")
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(helper.verify_immediate_child(&parent).is_err());
    assert!(parent.verify_immediate_child(&parent).is_err());
    let pipe_only = ExpectedPipePeer::from_handle(child.0.as_handle()).expect("pipe-only helper");
    assert!(parent.verify_immediate_child(&pipe_only).is_err());
    assert!(this_process().verify_immediate_child(&helper).is_err());

    exit_peer_fixture(&mut child);
    assert!(parent.verify_immediate_child(&helper).is_err());
}

fn exit_peer_fixture(child: &mut ChildGuard) {
    use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject};

    drop(child.0.stdin.take());
    // SAFETY: child retains the process handle for this bounded exit wait.
    assert_eq!(
        unsafe { WaitForSingleObject(child.0.as_raw_handle(), 2_000) },
        WAIT_OBJECT_0
    );
}

#[test]
fn different_live_process_is_rejected_in_both_directions() {
    let child = spawn_peer_fixture();
    let different =
        ExpectedPipePeer::from_handle(child.0.as_handle()).expect("pin fixture process");
    let owner = OwnerPipe::create().expect("bind owner");
    let error = connect(owner.name(), &different, WAIT)
        .err()
        .expect("wrong server PID");
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    drop(owner);

    let me = this_process();
    let owner = OwnerPipe::create().expect("bind fresh owner");
    let address = owner.name().clone();
    let mut client = connect(&address, &me, WAIT).expect("verify matching server");
    client
        .write_frame(b"queued before peer verification", WAIT)
        .expect("queue synthetic frame before accept");
    let error = owner
        .accept(&different, WAIT)
        .err()
        .expect("wrong client PID must not yield a pipe even with a frame queued");
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(client.read_frame(WAIT).expect("owner closed").is_none());

    let replacement = OwnerPipe::bind(address.clone()).expect("rejection released the name");
    let mut client = connect(&address, &me, WAIT).expect("verify replacement server");
    let mut server = replacement.accept(&me, WAIT).expect("verify new client");
    client.write_frame(b"fresh", WAIT).expect("send new frame");
    assert_eq!(
        server.read_frame(WAIT).expect("read new frame").as_deref(),
        Some(&b"fresh"[..])
    );
}

#[test]
fn peer_fixture() -> io::Result<()> {
    if std::env::var_os(FIXTURE).is_some() {
        // Exit when the parent closes stdin, including if the harness exits unexpectedly.
        let mut byte = [0];
        let _ = io::stdin().read(&mut byte)?;
    }
    Ok(())
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        // Best effort on drop; stdin EOF is the fixture's primary exit path.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
