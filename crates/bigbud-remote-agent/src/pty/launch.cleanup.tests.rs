use super::super::{child::Child, cleanup};
use super::*;
use std::sync::Arc;

#[test]
fn unknown_receipts_retain_and_reap_real_preexec_children_without_a_process_group() {
    for (bytes, expected) in [
        (&b""[..], LaunchUnknown::Timeout),
        (&b"BL"[..], LaunchUnknown::Timeout),
        (&b"badframe"[..], LaunchUnknown::MalformedReceipt),
    ] {
        let mut reservation = cleanup::Reservation::reserve("launch-unknown-cleanup").unwrap();
        let gate = crate::spawn_gate::lock().unwrap();
        let receipt = Receipt::new().unwrap();
        let reader = receipt.reader.as_raw_fd();
        let writer = receipt.writer.as_raw_fd();
        // SAFETY: child only uses close/write/pause/_exit with preallocated data.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // SAFETY: valid inherited descriptors and static byte slice. No Rust
            // destructor/allocator/lock may run before this child is killed.
            unsafe {
                libc::close(reader);
                if !bytes.is_empty()
                    && libc::write(writer, bytes.as_ptr().cast(), bytes.len())
                        != bytes.len() as isize
                {
                    libc::_exit(98);
                }
                loop {
                    libc::pause();
                }
            }
        }
        let child = Arc::new(Child::new(pid));
        reservation.retain(Arc::clone(&child)).unwrap();
        drop(receipt.writer);
        drop(gate);
        let result = receive(receipt.reader, Duration::from_millis(50));
        // Same failed-setup ownership handoff as PtyHandle::spawn: receipt error
        // must not abandon or synchronously wait without a bound on this child.
        drop(reservation);
        let retained = cleanup::retained_children();
        assert!(child.reaped() || retained.iter().any(|entry| Arc::ptr_eq(entry, &child)));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !child.reaped() && Instant::now() < deadline {
            cleanup::poll();
            std::thread::sleep(Duration::from_millis(5));
        }
        // fork(), unlike forkpty(), never formed PGID=pid. This also exercises
        // direct-leader cancellation when the pre-exec group does not exist.
        assert!(child.reaped());
        assert_eq!(child.poll().unwrap().unwrap().signal, Some(libc::SIGKILL));
        assert!(matches!(result, Err(PtyError::LaunchUnknown(reason)) if reason == expected));
    }
}
