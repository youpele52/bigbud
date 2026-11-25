// Build the stand-alone fixture without including it in the owner binary.
include!("../src/bin/ssh_owner/owner/guarded_write_stage.rs");

const ROOT: &str = "/disposable/workspace";
const GENERATION: Token = [1; 32];
const NONCE: Token = [2; 32];

fn stage() -> Result<Stage, StageError> {
    Stage::new(GENERATION, ROOT)
}

fn binding(bytes: &[u8]) -> Binding {
    Binding {
        generation: GENERATION,
        operation_id: "0123456789abcdef0123456789abcdef".into(),
        root: ROOT.into(),
        path: "notes/edit.txt".into(),
        expected_sha256: Sha256::digest(b"old\n").into(),
        attempted_sha256: Sha256::digest(bytes).into(),
        body_bytes: bytes.len(),
    }
}

#[test]
fn releases_exact_max_size_body_once_even_with_utf8_split_across_chunks() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let mut bytes = vec![b'a'; MAX_BODY_BYTES];
    bytes[..3].copy_from_slice(b"\xef\xbb\xbf");
    bytes[MAX_CHUNK_BYTES - 1..MAX_CHUNK_BYTES + 2].copy_from_slice("€".as_bytes());
    bytes[MAX_BODY_BYTES - 2..].copy_from_slice(b"\r\n");
    let binding = binding(&bytes);
    let lease = stage.begin(&binding, NONCE, now).unwrap();
    let wire = lease.to_wire();
    assert_eq!(wire.len(), 40);
    assert!(Lease::from_wire(&wire) == Some(lease));
    assert!(Lease::from_wire(&wire[..39]).is_none());
    for (index, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
        stage
            .chunk(&binding, lease, index * MAX_CHUNK_BYTES, chunk, now)
            .unwrap();
    }
    let committed = stage.commit(&binding, lease, now).unwrap();
    assert!(committed.binding == binding);
    assert_eq!(committed.bytes, bytes);
    assert_eq!(
        stage.commit(&binding, lease, now).err(),
        Some(StageError::NoDraft)
    );

    // Reusing fixture entropy or operation identity does not revive the old
    // lease. Operation replay policy is the future ledger's responsibility.
    let next = stage.begin(&binding, NONCE, now).unwrap();
    assert_eq!(
        stage.commit(&binding, lease, now).err(),
        Some(StageError::LeaseMismatch)
    );
    stage.abort(&binding, next, now).unwrap();
}

#[test]
fn accepts_an_empty_body_without_an_empty_chunk() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let binding = binding(b"");
    let lease = stage.begin(&binding, NONCE, now).unwrap();
    assert_eq!(
        stage.chunk(&binding, lease, 0, b"", now),
        Err(StageError::InvalidChunkSize)
    );
    assert!(stage.commit(&binding, lease, now).unwrap().bytes.is_empty());
}

#[test]
fn rejects_ineligible_begin_and_does_not_replace_active_draft() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let valid = binding(b"file");
    let mut candidate = valid.clone();
    candidate.body_bytes = MAX_BODY_BYTES + 1;
    assert_eq!(
        stage.begin(&candidate, NONCE, now).err(),
        Some(StageError::InvalidOperands)
    );
    candidate = valid.clone();
    candidate.generation = [3; 32];
    assert_eq!(
        stage.begin(&candidate, NONCE, now).err(),
        Some(StageError::BindingMismatch)
    );
    candidate = valid.clone();
    candidate.root = format!("{ROOT}/");
    assert_eq!(
        stage.begin(&candidate, NONCE, now).err(),
        Some(StageError::BindingMismatch)
    );
    for path in [
        "",
        "/edit.txt",
        "../edit.txt",
        "notes//edit.txt",
        "C:edit.txt",
        "edit\0.txt",
    ] {
        candidate = valid.clone();
        candidate.path = path.into();
        assert_eq!(
            stage.begin(&candidate, NONCE, now).err(),
            Some(StageError::InvalidOperands)
        );
    }
    assert!(Stage::new(GENERATION, "/").is_err());
    let lease = stage.begin(&valid, NONCE, now).unwrap();
    candidate = valid.clone();
    candidate.operation_id.push('a');
    assert_eq!(
        stage.begin(&candidate, NONCE, now).err(),
        Some(StageError::Busy)
    );
    stage.chunk(&valid, lease, 0, b"file", now).unwrap();
    assert_eq!(stage.commit(&valid, lease, now).unwrap().bytes, b"file");
}

#[test]
fn every_lease_action_requires_the_exact_original_binding() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let binding = binding(b"abc");
    let lease = stage.begin(&binding, NONCE, now).unwrap();
    let variants: [fn(&mut Binding); 7] = [
        |b| b.generation[0] ^= 1,
        |b| b.operation_id.push('a'),
        |b| b.root.push('/'),
        |b| b.path.push('x'),
        |b| b.expected_sha256[0] ^= 1,
        |b| b.attempted_sha256[0] ^= 1,
        |b| b.body_bytes += 1,
    ];
    for vary in variants {
        let mut wrong = binding.clone();
        vary(&mut wrong);
        assert_eq!(
            stage.chunk(&wrong, lease, 0, b"abc", now),
            Err(StageError::BindingMismatch)
        );
        assert_eq!(
            stage.commit(&wrong, lease, now).err(),
            Some(StageError::BindingMismatch)
        );
        assert_eq!(
            stage.abort(&wrong, lease, now),
            Err(StageError::BindingMismatch)
        );
    }
    // Even with otherwise matching metadata, another owner's lease fails.
    let mut another_owner = Stage::new(GENERATION, ROOT).unwrap();
    let wrong_lease = another_owner.begin(&binding, [9; 32], now).unwrap();
    assert_eq!(
        stage.chunk(&binding, wrong_lease, 0, b"abc", now),
        Err(StageError::LeaseMismatch)
    );
    assert_eq!(
        stage.commit(&binding, wrong_lease, now).err(),
        Some(StageError::LeaseMismatch)
    );
    assert_eq!(
        stage.abort(&binding, wrong_lease, now),
        Err(StageError::LeaseMismatch)
    );
    stage.chunk(&binding, lease, 0, b"abc", now).unwrap();
    assert_eq!(stage.commit(&binding, lease, now).unwrap().bytes, b"abc");
}

#[test]
fn rejects_bad_chunk_sizes_and_offsets_without_advancing() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let binding = binding(b"abcd");
    let lease = stage.begin(&binding, NONCE, now).unwrap();
    let oversized = vec![b'a'; MAX_CHUNK_BYTES + 1];
    assert_eq!(
        stage.chunk(&binding, lease, 0, &oversized, now),
        Err(StageError::InvalidChunkSize)
    );
    for offset in [1, usize::MAX] {
        assert_eq!(
            stage.chunk(&binding, lease, offset, b"a", now),
            Err(StageError::InvalidOffset)
        );
    }
    stage.chunk(&binding, lease, 0, b"ab", now).unwrap();
    assert_eq!(
        stage.chunk(&binding, lease, 0, b"ab", now),
        Err(StageError::InvalidOffset)
    );
    assert_eq!(
        stage.chunk(&binding, lease, 3, b"d", now),
        Err(StageError::InvalidOffset)
    );
    assert_eq!(
        stage.chunk(&binding, lease, 2, b"cde", now),
        Err(StageError::SizeMismatch)
    );
    stage.chunk(&binding, lease, 2, b"cd", now).unwrap();
    assert_eq!(stage.commit(&binding, lease, now).unwrap().bytes, b"abcd");
}

#[test]
fn failed_matching_commits_are_consumed_without_releasing_bytes() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let cases: &[(&[u8], &[u8], StageError)] = &[
        (b"abcd", b"abc", StageError::SizeMismatch),
        (b"abcd", b"abce", StageError::DigestMismatch),
        (b"\xf0\x9f", b"\xf0\x9f", StageError::InvalidText),
        (b"a\0b", b"a\0b", StageError::InvalidText),
    ];
    for (declared, sent, expected) in cases {
        let binding = binding(declared);
        let lease = stage.begin(&binding, NONCE, now).unwrap();
        stage.chunk(&binding, lease, 0, sent, now).unwrap();
        assert_eq!(
            stage.commit(&binding, lease, now).err().as_ref(),
            Some(expected)
        );
        assert_eq!(
            stage.commit(&binding, lease, now).err(),
            Some(StageError::NoDraft)
        );
    }
}

#[test]
fn expiry_is_absolute_and_begin_reclaims_the_slot() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let binding = binding(b"abc");
    let lease = stage.begin(&binding, NONCE, now).unwrap();
    let deadline = now + DRAFT_TTL;
    stage
        .chunk(
            &binding,
            lease,
            0,
            b"abc",
            deadline.checked_sub(Duration::from_millis(1)).unwrap(),
        )
        .unwrap();
    assert_eq!(
        stage.commit(&binding, lease, deadline).err(),
        Some(StageError::NoDraft)
    );

    let second = stage.begin(&binding, NONCE, deadline).unwrap();
    let third = stage.begin(&binding, NONCE, deadline + DRAFT_TTL).unwrap();
    assert_eq!(
        stage.abort(&binding, second, deadline + DRAFT_TTL),
        Err(StageError::LeaseMismatch)
    );
    stage.abort(&binding, third, deadline + DRAFT_TTL).unwrap();
    assert_eq!(
        stage.commit(&binding, third, deadline + DRAFT_TTL).err(),
        Some(StageError::NoDraft)
    );
}

#[test]
fn generation_change_and_same_generation_reattach_clear_staged_bytes() {
    let now = Instant::now();
    let mut stage = stage().unwrap();
    let mut binding = binding(b"abc");
    let old = stage.begin(&binding, NONCE, now).unwrap();
    stage.chunk(&binding, old, 0, b"abc", now).unwrap();
    stage.reset_attachment([3; 32]);
    assert_eq!(
        stage.commit(&binding, old, now).err(),
        Some(StageError::NoDraft)
    );
    assert_eq!(
        stage.begin(&binding, NONCE, now).err(),
        Some(StageError::BindingMismatch)
    );

    binding.generation = [3; 32];
    let before_reattach = stage.begin(&binding, NONCE, now).unwrap();
    stage
        .chunk(&binding, before_reattach, 0, b"abc", now)
        .unwrap();
    stage.reset_attachment(binding.generation);
    let after_reattach = stage.begin(&binding, NONCE, now).unwrap();
    assert_eq!(
        stage.commit(&binding, before_reattach, now).err(),
        Some(StageError::LeaseMismatch)
    );
    assert_eq!(
        stage.commit(&binding, after_reattach, now).err(),
        Some(StageError::SizeMismatch)
    );
}
