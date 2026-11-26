//! `SpoolStore`: owns `<state_root>/terminals/`, starts per-PTY writers and serves cold reads.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::checkpoint::{self, SpoolCheckpoint};
use super::errors::{SpoolError, SpoolLimits};
use super::layout::{self, CHECKPOINT_FILE, META_FILE, SEGMENT_FILES, TERMINALS_DIR};
use super::meta::{SpoolMeta, SpoolState};
use super::segment::{self, MAX_RECORD_BYTES, RECORD_HEADER_BYTES, SpoolChunk};
use super::writer::{Message, SpoolWriter, WriterShared};
use super::writer_thread::WriterThread;

/// How much of a cold spool can be trusted to rebuild the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpoolContinuity {
    /// Checkpoint (if any) plus chunks reproduce everything the PTY printed.
    Full,
    /// Something is missing: a rotation the checkpoint does not cover, a sequence gap, or a
    /// degraded spool. The rebuilt screen is `partial`.
    Partial,
}

/// Everything recovered for a cold restore (plan §8.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColdSpool {
    pub pty_id: String,
    pub state: SpoolState,
    pub lost_at_ms: Option<u64>,
    /// The screen checkpoint to restore first, when it connects to the retained chunks.
    pub checkpoint: Option<SpoolCheckpoint>,
    /// Chunks after the checkpoint (or every retained chunk without one), in sequence order.
    pub chunks: Vec<SpoolChunk>,
    pub continuity: SpoolContinuity,
}

pub(super) struct WriterLink {
    pub(super) sender: SyncSender<Message>,
}

pub(super) struct StoreInner {
    pub(super) terminals: PathBuf,
    pub(super) limits: SpoolLimits,
    pub(super) writers: Mutex<HashMap<String, WriterLink>>,
}

impl StoreInner {
    pub(super) fn unregister(&self, dir_name: &str) {
        if let Ok(mut writers) = self.writers.lock() {
            writers.remove(dir_name);
        }
    }

    pub(super) fn has_writer(&self, dir_name: &str) -> Result<bool, SpoolError> {
        self.writers
            .lock()
            .map(|writers| writers.contains_key(dir_name))
            .map_err(|_| SpoolError::Io(std::io::Error::other("spool registry poisoned")))
    }
}

/// Owner-private scrollback spools for one host. Cheap to clone; clones share the registry.
#[derive(Clone)]
pub struct SpoolStore {
    pub(super) inner: Arc<StoreInner>,
    backup_exclusion: Option<Result<super::BackupExclusion, String>>,
}

impl SpoolStore {
    /// Opens (creating owner-only) `<state_root>/terminals/`. On macOS the state root is also
    /// excluded from Time Machine; that result is kept for the host to log and never fails open.
    pub fn open(state_root: impl AsRef<Path>, limits: SpoolLimits) -> Result<Self, SpoolError> {
        let state_root = state_root.as_ref();
        layout::ensure_private_directory(state_root)?;
        let terminals = state_root.join(TERMINALS_DIR);
        layout::ensure_private_directory(&terminals)?;
        #[cfg(target_os = "macos")]
        let backup_exclusion =
            Some(super::exclude_from_backup(state_root).map_err(|error| error.to_string()));
        #[cfg(not(target_os = "macos"))]
        let backup_exclusion = None;
        Ok(Self {
            inner: Arc::new(StoreInner {
                terminals,
                limits,
                writers: Mutex::new(HashMap::new()),
            }),
            backup_exclusion,
        })
    }

    pub fn limits(&self) -> SpoolLimits {
        self.inner.limits
    }

    /// The Time Machine exclusion outcome (macOS only).
    pub fn backup_exclusion(&self) -> Option<&Result<super::BackupExclusion, String>> {
        self.backup_exclusion.as_ref()
    }

    pub(super) fn dir_for(&self, pty_id: &str) -> (String, PathBuf) {
        let name = layout::dir_name(pty_id);
        let path = self.inner.terminals.join(&name);
        (name, path)
    }

    /// Starts a fresh spool and its writer thread. A stale spool under the same id is replaced.
    pub fn writer(&self, pty_id: &str, now_ms: u64) -> Result<SpoolWriter, SpoolError> {
        layout::validate_pty_id(pty_id)?;
        let (dir_name, dir) = self.dir_for(pty_id);
        let mut writers = self
            .inner
            .writers
            .lock()
            .map_err(|_| SpoolError::Io(std::io::Error::other("spool registry poisoned")))?;
        if writers.contains_key(&dir_name) {
            return Err(SpoolError::Busy);
        }
        layout::remove_spool_dir(&dir)?;
        layout::ensure_private_directory(&dir)?;
        let meta = SpoolMeta::new(pty_id, now_ms);
        meta.store(&dir.join(META_FILE))?;
        let [first, second] = SEGMENT_FILES;
        let segments = [
            layout::open_segment(&dir.join(first))?,
            layout::open_segment(&dir.join(second))?,
        ];
        let limits = self.inner.limits;
        let shared = Arc::new(WriterShared::new());
        let (sender, receiver) = mpsc::sync_channel(limits.queue_messages.max(1));
        let thread = WriterThread {
            dir,
            limits,
            shared: Arc::clone(&shared),
            meta,
            segments,
            active: 0,
            active_len: 0,
            last_sequence: [None, None],
            pending: Vec::with_capacity(limits.buffer_bytes),
            half_requested: false,
            last_flush: Instant::now(),
        };
        let handle = std::thread::Builder::new()
            .name("bigbud-spool-writer".to_owned())
            .spawn(move || thread.run(receiver))?;
        writers.insert(
            dir_name.clone(),
            WriterLink {
                sender: sender.clone(),
            },
        );
        Ok(SpoolWriter {
            pty_id: pty_id.to_owned(),
            dir_name,
            sender,
            shared,
            thread: Some(handle),
            store: Arc::downgrade(&self.inner),
            limits,
            next_floor: AtomicU64::new(0),
        })
    }

    /// Reads a spool for a cold restore. Torn tails and corrupt checkpoints are tolerated.
    pub fn read_cold(&self, pty_id: &str) -> Result<ColdSpool, SpoolError> {
        layout::validate_pty_id(pty_id)?;
        let (_, dir) = self.dir_for(pty_id);
        let meta = SpoolMeta::load(&dir.join(META_FILE))?;
        if meta.pty_id != pty_id {
            return Err(SpoolError::Unknown);
        }
        let limits = self.inner.limits;
        let segment_limit = limits
            .segment_bytes
            .saturating_add((MAX_RECORD_BYTES + RECORD_HEADER_BYTES) as u64);
        let mut chunks = Vec::new();
        for name in SEGMENT_FILES {
            chunks.extend(segment::read(&dir.join(name), segment_limit)?);
        }
        chunks.sort_by_key(|chunk| chunk.sequence);
        chunks.dedup_by_key(|chunk| chunk.sequence);
        let checkpoint = checkpoint::load(&dir.join(CHECKPOINT_FILE), limits.checkpoint_max_bytes)?
            .filter(|checkpoint| {
                meta.discarded_through
                    .is_none_or(|discarded| checkpoint.through_sequence >= discarded)
            });
        let covered = checkpoint.is_some() || meta.discarded_through.is_none();
        if let Some(checkpoint) = &checkpoint {
            chunks.retain(|chunk| chunk.sequence > checkpoint.through_sequence);
        }
        let connects = match (&checkpoint, chunks.first()) {
            (Some(checkpoint), Some(first)) => {
                first.sequence == checkpoint.through_sequence.saturating_add(1)
            }
            _ => true,
        };
        let contiguous = chunks
            .windows(2)
            .all(|pair| matches!(pair, [a, b] if b.sequence == a.sequence.saturating_add(1)));
        let continuity = if covered && connects && contiguous && !meta.degraded {
            SpoolContinuity::Full
        } else {
            SpoolContinuity::Partial
        };
        Ok(ColdSpool {
            pty_id: meta.pty_id,
            state: meta.state,
            lost_at_ms: meta.lost_at_ms,
            checkpoint,
            chunks,
            continuity,
        })
    }

    /// Changes a spool's retention state. Spools with an active writer are refused.
    pub fn mark(&self, pty_id: &str, state: SpoolState, now_ms: u64) -> Result<(), SpoolError> {
        layout::validate_pty_id(pty_id)?;
        let (dir_name, dir) = self.dir_for(pty_id);
        if self.inner.has_writer(&dir_name)? {
            return Err(SpoolError::Busy);
        }
        let path = dir.join(META_FILE);
        let mut meta = SpoolMeta::load(&path)?;
        if meta.pty_id != pty_id {
            return Err(SpoolError::Unknown);
        }
        if meta.state != SpoolState::Lost && state == SpoolState::Lost {
            meta.lost_at_ms = Some(now_ms);
        }
        meta.state = state;
        meta.updated_ms = now_ms;
        meta.store(&path)?;
        Ok(())
    }

    /// Deletes a spool without a writer (a dismissed `lost` spool). Missing spools are fine.
    pub fn remove(&self, pty_id: &str) -> Result<(), SpoolError> {
        layout::validate_pty_id(pty_id)?;
        let (dir_name, dir) = self.dir_for(pty_id);
        if self.inner.has_writer(&dir_name)? {
            return Err(SpoolError::Busy);
        }
        layout::remove_spool_dir(&dir)?;
        Ok(())
    }

    pub(super) fn spool_dirs(&self) -> Result<Vec<(String, PathBuf)>, SpoolError> {
        let mut dirs = Vec::new();
        for entry in fs::read_dir(&self.inner.terminals)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            dirs.push((name, entry.path()));
        }
        Ok(dirs)
    }
}
