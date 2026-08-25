use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
#[test]
fn spawns_a_shell_and_replays_bounded_output() {
    let root = std::env::temp_dir().join(format!(
        "bigbud-pty-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let job = PtyHandle::spawn(
        "pty-1".to_owned(),
        &root,
        "sh",
        &["-c".to_owned(), "printf hello".to_owned()],
        80,
        24,
        &[("TERM".to_owned(), "xterm-256color".to_owned())],
    )
    .unwrap();
    let events = read_events(job.reader, job.handle.pid);
    let output = events
        .iter()
        .filter_map(|event| match event {
            PtyEvent::Output(bytes) => Some(bytes.as_slice()),
            PtyEvent::Exited { .. } => None,
        })
        .flatten()
        .copied()
        .collect::<Vec<_>>();
    let chunk = job.handle.append_output(output).unwrap();
    assert_eq!(chunk.bytes, b"hello");
    assert_eq!(job.handle.replay(0).unwrap().len(), 1);
    job.handle.close(false).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn rejects_duplicate_and_gapped_input_sequences() {
    #[cfg(unix)]
    {
        let root = std::env::temp_dir();
        let job = PtyHandle::spawn(
            "pty-2".to_owned(),
            &root,
            "sh",
            &["-c".to_owned(), "sleep 1".to_owned()],
            80,
            24,
            &[],
        )
        .unwrap();
        assert!(job.handle.write_input(1, b"x").unwrap());
        assert!(!job.handle.write_input(1, b"x").unwrap());
        assert!(matches!(
            job.handle.write_input(3, b"x"),
            Err(PtyError::InputSequence { .. })
        ));
        job.handle.signal("SIGKILL").unwrap();
    }
}
