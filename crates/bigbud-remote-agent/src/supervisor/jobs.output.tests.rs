#![allow(clippy::unwrap_used, clippy::panic)]

use super::*;
use crate::process::{ProcessOptions, run_bounded_process_with_output};
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn join_bounded<T>(worker: JoinHandle<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(4);
    while !worker.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(worker.is_finished(), "output worker did not settle");
    worker.join().unwrap()
}

fn filled(bytes: usize) -> (OutputSender, Receiver<Chunk>) {
    let (sender, receiver) = channel();
    for _ in 0..QUEUE_ITEMS {
        sender
            .send(OutputStream::Stdout, &vec![b'a'; bytes])
            .unwrap();
    }
    (sender, receiver)
}

#[test]
fn tiny_and_full_size_chunks_backpressure_at_the_item_and_byte_caps() {
    for size in [1, MAX_CHUNK_BYTES] {
        let (sender, receiver) = filled(size);
        let (started, start) = mpsc::sync_channel(1);
        let (finished, finish) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            started.send(()).unwrap();
            sender.send(OutputStream::Stderr, b"next").unwrap();
            finished.send(()).unwrap();
        });
        start.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(finish.recv_timeout(Duration::from_millis(50)).is_err());
        let first = receiver.recv().unwrap();
        assert_eq!(first.1.len(), size);
        finish.recv_timeout(Duration::from_secs(1)).unwrap();
        let rest: Vec<_> = receiver.into_iter().collect();
        assert_eq!(rest.len(), QUEUE_ITEMS);
        assert_eq!(
            rest.last().unwrap(),
            &(OutputStream::Stderr, b"next".to_vec())
        );
        assert_eq!(
            first.1.len()
                + rest
                    .iter()
                    .take(QUEUE_ITEMS - 1)
                    .map(|item| item.1.len())
                    .sum::<usize>(),
            QUEUE_ITEMS * size
        );
        join_bounded(worker);
    }
}

#[test]
fn oversized_callbacks_split_without_loss_or_reordering() {
    let (sender, receiver) = channel();
    let original: Vec<u8> = (0..MAX_CHUNK_BYTES * (QUEUE_ITEMS + 2) + 17)
        .map(|index| (index % 251) as u8)
        .collect();
    let bytes = original.clone();
    let worker = thread::spawn(move || sender.send(OutputStream::Stdout, &bytes));
    let mut actual = Vec::new();
    let mut count = 0;
    for (stream, bytes) in receiver {
        assert_eq!(stream, OutputStream::Stdout);
        assert!(!bytes.is_empty() && bytes.len() <= MAX_CHUNK_BYTES);
        actual.extend(bytes);
        count += 1;
    }
    join_bounded(worker).unwrap();
    assert_eq!(count, QUEUE_ITEMS + 3);
    assert_eq!(actual, original);
}

#[test]
fn concurrent_streams_preserve_each_stream_and_eof_waits_for_both() {
    let (sender, receiver) = channel();
    let sender = Arc::new(sender);
    let workers: Vec<_> = [OutputStream::Stdout, OutputStream::Stderr]
        .into_iter()
        .map(|stream| {
            let sender = Arc::clone(&sender);
            thread::spawn(move || {
                for index in 0..80u8 {
                    sender.send(stream, &[index; 1024]).unwrap();
                }
            })
        })
        .collect();
    drop(sender);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    for (stream, bytes) in receiver {
        match stream {
            OutputStream::Stdout => stdout.extend(bytes),
            OutputStream::Stderr => stderr.extend(bytes),
        }
    }
    for worker in workers {
        join_bounded(worker);
    }
    let expected: Vec<u8> = (0..80u8).flat_map(|index| [index; 1024]).collect();
    assert_eq!(stdout, expected);
    assert_eq!(stderr, expected);
}

#[test]
fn receiver_loss_wakes_a_blocked_sender() {
    let (sender, receiver) = filled(1);
    let (started, start) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        started.send(()).unwrap();
        sender.send(OutputStream::Stdout, b"blocked")
    });
    start.recv_timeout(Duration::from_secs(1)).unwrap();
    drop(receiver);
    assert!(join_bounded(worker).is_err());
}

#[test]
fn empty_callbacks_do_not_admit_empty_frames() {
    let (sender, receiver) = channel();
    sender.send(OutputStream::Stdout, b"").unwrap();
    assert!(matches!(
        receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn cancellation_and_timeout_reap_child_while_full_then_drain_before_completion() {
    for cancelled in [true, false] {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("bigbud-output-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let (sender, receiver) = channel();
        let cancellation = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&cancellation);
        let calls = Arc::new(AtomicUsize::new(0));
        let produced = Arc::clone(&calls);
        let cwd = root.clone();
        let worker = thread::spawn(move || {
            run_bounded_process_with_output(
                &cwd,
                "sh",
                &[
                    "-c".into(),
                    "printf '%s' \"$$\" > child.pid; while :; do printf '%16384s' x; done".into(),
                ],
                ProcessOptions {
                    environment: &[],
                    stdin_bytes: &[],
                    timeout: Duration::from_secs(2),
                    max_output_bytes: 1024 * 1024,
                    cancellation: Some(&signal),
                },
                Arc::new(move |stream, bytes| {
                    produced.fetch_add(1, Ordering::Release);
                    // Receiver loss is allowed only in failed-test teardown.
                    let _consumer_gone = sender.send(stream, bytes);
                }),
            )
        });
        let saturated_until = Instant::now() + Duration::from_secs(3);
        while calls.load(Ordering::Acquire) <= QUEUE_ITEMS && Instant::now() < saturated_until {
            thread::sleep(Duration::from_millis(5));
        }
        let saturated = calls.load(Ordering::Acquire) > QUEUE_ITEMS;
        if cancelled {
            cancellation.store(true, Ordering::Release);
        }
        let pid = fs::read_to_string(root.join("child.pid"))
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let reaped_until = Instant::now() + Duration::from_secs(3);
        let mut reaped = false;
        while Instant::now() < reaped_until {
            // SAFETY: signal 0 only observes the PID of our disposable child;
            // it does not send a signal to this or any reused process.
            let result = unsafe { libc::kill(pid, 0) };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                reaped = true;
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let completion_waited_for_drain = !worker.is_finished();
        // Restore consumption even on a failed observation so test-owned work
        // can settle; assertions follow teardown, never leave a blocked sender.
        cancellation.store(true, Ordering::Release);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        for (stream, bytes) in receiver {
            match stream {
                OutputStream::Stdout => stdout.extend(bytes),
                OutputStream::Stderr => stderr.extend(bytes),
            }
        }
        let result = join_bounded(worker).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(saturated);
        assert!(reaped, "child control must not depend on consuming output");
        assert!(completion_waited_for_drain);
        assert_eq!(result.cancelled, cancelled);
        assert_eq!(result.timed_out, !cancelled);
        assert_eq!(stdout, result.stdout);
        assert_eq!(stderr, result.stderr);
    }
}
