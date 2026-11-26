use super::*;
use std::sync::Barrier;

#[test]
fn replay_uses_exclusive_cursors_without_acknowledging_or_decoding_output() {
    let directory = Directory::new();
    let lease = directory
        .transport(RESIZE_SSH, true)
        .open_proof_terminal()
        .expect("native PTY launch");
    let first = lease.replay_proof_terminal(0).expect("replay readiness");
    assert_eq!(first.first_retained_sequence, 1);
    assert!(!first.gap);
    assert!(!first.chunks.is_empty());

    let bytes = vec![0, 255, b'\n'];
    let appended = lease
        .handle
        .append_output(bytes.clone())
        .expect("native ring append");
    assert_eq!(appended.sequence, first.next_sequence);
    let after = first.next_sequence - 1;
    let expected = TerminalReplay {
        first_retained_sequence: 1,
        next_sequence: appended.sequence + 1,
        chunks: vec![(appended.sequence, bytes)],
        gap: false,
    };
    assert_eq!(lease.replay_proof_terminal(after), Ok(expected));
    let from_start = lease.replay_proof_terminal(0).expect("replay again");
    assert!(from_start.chunks.starts_with(&first.chunks));

    let tip = lease
        .replay_proof_terminal(appended.sequence)
        .expect("cursor at tip");
    assert!(!tip.gap);
    assert!(tip.chunks.is_empty());
    for future in [tip.next_sequence, u64::MAX] {
        assert_eq!(
            lease.replay_proof_terminal(future),
            Err(ErrorCode::InvalidOperands)
        );
    }

    lease
        .handle
        .acknowledge(appended.sequence)
        .expect("evict all chunks from the native ring");
    assert_eq!(
        lease.replay_proof_terminal(after),
        Ok(TerminalReplay {
            first_retained_sequence: tip.next_sequence,
            next_sequence: tip.next_sequence,
            chunks: Vec::new(),
            gap: true,
        })
    );
    let empty = lease
        .replay_proof_terminal(appended.sequence)
        .expect("cursor at tip of empty retained ring");
    assert!(!empty.gap);
    assert!(empty.chunks.is_empty());
    assert_eq!(empty.first_retained_sequence, empty.next_sequence);
}

#[test]
fn replay_keeps_bounds_and_chunks_on_one_cut_during_native_ring_eviction() {
    const CHUNK_BYTES: usize = 1024;
    const WRITES: u8 = 128;
    let directory = Directory::new();
    let lease = directory
        .transport(RESIZE_SSH, true)
        .open_proof_terminal()
        .expect("native PTY launch");
    let start = lease
        .replay_proof_terminal(0)
        .expect("initial cut")
        .next_sequence;
    let after = start - 1;
    let start_writes = Barrier::new(2);
    thread::scope(|scope| {
        let writer = scope.spawn(|| {
            start_writes.wait();
            for tag in 0..WRITES {
                let chunk = lease
                    .handle
                    .append_output(vec![tag; CHUNK_BYTES])
                    .expect("native ring append");
                assert_eq!(chunk.sequence, start + u64::from(tag));
            }
        });
        start_writes.wait();
        for _ in 0..WRITES {
            let cut = lease.replay_proof_terminal(after).expect("concurrent cut");
            assert!((start..=start + u64::from(WRITES)).contains(&cut.next_sequence));
            assert!(cut.first_retained_sequence <= cut.next_sequence);
            assert_eq!(cut.gap, cut.first_retained_sequence > start);
            if cut.gap {
                assert!(cut.chunks.is_empty());
            } else {
                assert_suffix(cut, start, start);
            }
        }
        writer.join().expect("output writer completed");
    });

    let stale = lease.replay_proof_terminal(after).expect("evicted cut");
    assert!(stale.gap);
    assert!(stale.chunks.is_empty());
    assert_eq!(stale.next_sequence, start + u64::from(WRITES));
    let first = stale.first_retained_sequence;
    let retained = lease
        .replay_proof_terminal(first - 1)
        .expect("replay from retention boundary");
    assert!(!retained.gap);
    assert_eq!(retained.first_retained_sequence, first);
    assert_eq!(retained.next_sequence, stale.next_sequence);
    assert_suffix(retained, first, start);

    fn assert_suffix(cut: TerminalReplay, first: u64, start: u64) {
        assert_eq!(cut.chunks.len() as u64, cut.next_sequence - first);
        for ((sequence, bytes), expected) in cut.chunks.into_iter().zip(first..cut.next_sequence) {
            assert_eq!(sequence, expected);
            let tag = u8::try_from(sequence - start).expect("fixture sequence fits in a tag");
            assert_eq!(bytes.len(), CHUNK_BYTES);
            assert!(bytes.into_iter().all(|byte| byte == tag));
        }
    }
}
