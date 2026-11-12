use super::super::{LaunchUnknown, PtyError, launch};
use super::*;
use crate::pty::{PtyHandle, PtyJob, read_events};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::Instant;

fn spawn(id: &str) -> Result<PtyJob, PtyError> {
    PtyHandle::spawn(
        id.into(),
        Path::new("/"),
        "/bin/sh",
        &["-c".into(), "printf admitted".into()],
        80,
        24,
        &[],
    )
}

#[test]
fn retained_preexec_child_fences_same_id_until_verified_reap() {
    // Isolate the global cleanup registry so another test's CleanupOwner cannot
    // legitimately reap the fixture between the rejection and ownership checks.
    const CHILD: &str = "BIGBUD_TEST_PTY_ADMISSION_FENCE";
    if std::env::var_os(CHILD).is_none() {
        let module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("{module}::retained_preexec_child_fences_same_id_until_verified_reap"),
                "--nocapture",
            ])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }

    assert!(matches!(spawn(""), Err(PtyError::MissingId)));
    let id = "retained-preexec-native-id";
    let mut reservation = Reservation::reserve(id).unwrap();
    let gate = crate::spawn_gate::lock().unwrap();
    let receipt = launch::Receipt::new().unwrap();
    let reader = receipt.reader.as_raw_fd();
    // SAFETY: fork child uses only close/pause, never Rust allocation/destructors.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        // SAFETY: inherited read descriptor; this owned pre-exec child remains
        // alive until Reservation's failed-setup cleanup sends SIGKILL.
        unsafe {
            libc::close(reader);
            loop {
                libc::pause();
            }
        }
    }
    let child = Arc::new(Child::new(pid));
    reservation.retain(Arc::clone(&child)).unwrap();
    drop(receipt.writer);
    drop(gate);
    let result = launch::receive(receipt.reader, Duration::from_millis(20));
    assert!(matches!(
        result,
        Err(PtyError::LaunchUnknown(LaunchUnknown::Timeout))
    ));
    drop(reservation);
    assert!(!child.reaped());

    // reserve() may send cleanup SIGKILL, but its first WNOHANG poll cannot reap
    // this still-live child. Same-ID admission must fail BEFORE any second fork.
    assert!(
        matches!(spawn(id), Err(PtyError::Io(error)) if error.kind() == io::ErrorKind::AlreadyExists)
    );
    assert!(!child.reaped());
    assert!(
        retained_children()
            .iter()
            .any(|entry| Arc::ptr_eq(entry, &child))
    );

    let sibling = spawn("unrelated-native-id").unwrap();
    // Successful transfer must release setup admission even while a job exists;
    // native cleanup fencing is not a replacement for session ownership.
    drop(Reservation::reserve("unrelated-native-id").unwrap());
    read_events(sibling.reader, &sibling.handle);
    sibling.handle.close(false).unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    while !child.reaped() && Instant::now() < deadline {
        poll();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(child.reaped());
    assert_eq!(child.poll().unwrap().unwrap().signal, Some(libc::SIGKILL));
    let replacement = spawn(id).unwrap();
    read_events(replacement.reader, &replacement.handle);
    replacement.handle.close(false).unwrap();
}
