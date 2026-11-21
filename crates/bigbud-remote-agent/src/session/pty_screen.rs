//! Screen snapshot production (plan §8.4, §8.9, §9.1 snapshot worker, §8.3 cold restore).
//!
//! Runs on the supervisor's snapshot worker, never under the session lock or on a connection
//! read loop. A live snapshot fences the PTY's actor, which hands back an immutable copy (F1)
//! and resumes feeding at once; serialization and chunking run on that copy. A cold snapshot
//! rebuilds the screen of a `lost` PTY from its spool.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use bigbud_protocol::pty_lifecycle::{SNAPSHOT_CHUNK_MAX_BYTES, SNAPSHOT_MAX_CHUNKS};
use bigbud_protocol::v1;
use sha2::{Digest, Sha256};

use crate::terminal_screen::{ScreenModel, ScreenSnapshot, SnapshotLimits};
use crate::terminal_spool::SpoolContinuity;

use super::pty_lifecycle::PtyLifecycle;
use super::pty_lifecycle_host::HostLifecycle;

/// The fence waits until everything already applied is in the copy, or reports `invalid`.
pub(crate) const FENCE_DEADLINE: Duration = Duration::from_secs(2);

/// What a snapshot request resolved to under the session lock.
pub(crate) enum SnapshotSource {
    Live(Arc<PtyLifecycle>),
    Cold(Arc<HostLifecycle>),
    Refused(&'static str, String),
}

/// A produced snapshot: the header and the ANSI it describes, chunked lazily on send.
pub(crate) struct SnapshotTransfer {
    pub(crate) header: v1::PtyScreenSnapshotHeader,
    request_id: String,
    /// Shared with the snapshot cache (R7).
    ansi: Arc<Vec<u8>>,
}

impl SnapshotTransfer {
    pub(crate) fn refused(
        request: &v1::PtyScreenSnapshotRequest,
        code: &str,
        message: String,
    ) -> Self {
        Self {
            header: v1::PtyScreenSnapshotHeader {
                request_id: request.request_id.clone(),
                pty_id: request.pty_id.clone(),
                accepted: false,
                error_code: code.to_owned(),
                error_message: message,
                ..Default::default()
            },
            request_id: request.request_id.clone(),
            ansi: Arc::new(Vec::new()),
        }
    }

    pub(crate) fn header_frame(&self) -> v1::Frame {
        v1::Frame {
            payload: Some(v1::frame::Payload::PtyScreenSnapshotHeader(Box::new(
                self.header.clone(),
            ))),
        }
    }

    pub(crate) fn chunk_count(&self) -> u32 {
        self.header.chunk_count
    }

    /// Builds chunk `index` only when the writer has room for it (N3: one encoded chunk per
    /// transfer at a time).
    pub(crate) fn chunk_frame(&self, index: u32) -> Option<v1::Frame> {
        let start = usize::try_from(index)
            .ok()?
            .checked_mul(SNAPSHOT_CHUNK_MAX_BYTES)?;
        let end = start
            .saturating_add(SNAPSHOT_CHUNK_MAX_BYTES)
            .min(self.ansi.len());
        let bytes = self.ansi.get(start..end)?.to_vec();
        Some(v1::Frame {
            payload: Some(v1::frame::Payload::PtyScreenSnapshotChunk(
                v1::PtyScreenSnapshotChunk {
                    request_id: self.request_id.clone(),
                    index,
                    last: index.saturating_add(1) == self.header.chunk_count,
                    bytes,
                },
            )),
        })
    }

    fn from_snapshot(
        request: &v1::PtyScreenSnapshotRequest,
        snapshot: ScreenSnapshot,
        model_state: &str,
    ) -> Self {
        let sha256 = snapshot.sha256().to_vec();
        let ansi = Arc::new(snapshot.ansi.into_bytes());
        let chunks = ansi.len().div_ceil(SNAPSHOT_CHUNK_MAX_BYTES);
        let chunk_count = u32::try_from(chunks).unwrap_or(u32::MAX);
        if chunk_count > SNAPSHOT_MAX_CHUNKS {
            // The serializer caps UTF-8 at 3 MiB = 16 chunks; this cannot happen, but a
            // header that violates the protocol must never be sent.
            return Self::refused(
                request,
                "SNAPSHOT_TOO_LARGE",
                "snapshot exceeds 16 chunks".to_owned(),
            );
        }
        Self {
            header: v1::PtyScreenSnapshotHeader {
                request_id: request.request_id.clone(),
                pty_id: request.pty_id.clone(),
                accepted: true,
                through_sequence: snapshot.through_sequence,
                cols: u32::from(snapshot.cols),
                rows: u32::from(snapshot.rows),
                scrollback_rows: snapshot.scrollback_rows,
                alternate_screen: snapshot.alternate_screen,
                fidelity: snapshot.fidelity.fidelity.as_str().to_owned(),
                model_state: model_state.to_owned(),
                chunk_count,
                total_ansi_bytes: ansi.len() as u64,
                pending_escape_tail: snapshot.pending_escape_tail,
                sha256,
                trimmed_rows: snapshot.fidelity.affected_rows(),
                ..Default::default()
            },
            request_id: request.request_id.clone(),
            ansi,
        }
    }

    /// The fence failed: an accepted header with `model_state = "invalid"` and no chunks.
    fn invalid(request: &v1::PtyScreenSnapshotRequest, cols: u16, rows: u16) -> Self {
        Self {
            header: v1::PtyScreenSnapshotHeader {
                request_id: request.request_id.clone(),
                pty_id: request.pty_id.clone(),
                accepted: true,
                cols: u32::from(cols.max(1)),
                rows: u32::from(rows.max(1)),
                fidelity: "partial".to_owned(),
                model_state: "invalid".to_owned(),
                sha256: Sha256::digest([]).to_vec(),
                ..Default::default()
            },
            request_id: request.request_id.clone(),
            ansi: Arc::new(Vec::new()),
        }
    }
}

impl SnapshotTransfer {
    /// A cached snapshot answering another request for the same unchanged screen.
    fn from_cached(
        request: &v1::PtyScreenSnapshotRequest,
        mut header: v1::PtyScreenSnapshotHeader,
        ansi: Arc<Vec<u8>>,
    ) -> Self {
        header.request_id.clone_from(&request.request_id);
        Self {
            header,
            request_id: request.request_id.clone(),
            ansi,
        }
    }
}

fn limits(request: &v1::PtyScreenSnapshotRequest) -> SnapshotLimits {
    SnapshotLimits::from_request(
        request.max_ansi_units,
        request.max_utf8_bytes,
        request.max_scrollback_rows,
    )
}

pub(crate) fn produce(
    source: SnapshotSource,
    request: &v1::PtyScreenSnapshotRequest,
) -> SnapshotTransfer {
    match source {
        SnapshotSource::Refused(code, message) => SnapshotTransfer::refused(request, code, message),
        SnapshotSource::Live(lifecycle) => produce_live(&lifecycle, request),
        SnapshotSource::Cold(host) => produce_cold(&host, request),
    }
}

fn produce_live(
    lifecycle: &PtyLifecycle,
    request: &v1::PtyScreenSnapshotRequest,
) -> SnapshotTransfer {
    let Some(screen) = lifecycle.screen() else {
        return SnapshotTransfer::refused(
            request,
            "SCREEN_UNAVAILABLE",
            "PTY has no screen model".to_owned(),
        );
    };
    let attach = request.attach_renderer;
    let host = lifecycle.host();
    let epoch = lifecycle.screen_epoch();
    let wanted = limits(request);
    let cached = host
        .snapshot_cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&request.pty_id, epoch, &wanted);
    if let Some((header, ansi)) = cached {
        // Nothing was fed since: the cached snapshot is exact through its sequence, so it
        // is also the attach cut.
        if attach {
            let handle = Arc::clone(lifecycle.handle());
            let mut state = lifecycle.lock();
            state.responder.begin_attach();
            state
                .responder
                .finish_attach(handle.as_ref(), Some(header.through_sequence));
        }
        return SnapshotTransfer::from_cached(request, header, ansi);
    }
    if attach {
        lifecycle.lock().responder.begin_attach();
    }
    let fenced = screen.snapshot_fenced(Instant::now() + FENCE_DEADLINE);
    let cut = fenced.as_ref().ok().map(|copy| copy.through_sequence());
    if attach {
        let handle = Arc::clone(lifecycle.handle());
        lifecycle
            .lock()
            .responder
            .finish_attach(handle.as_ref(), cut);
    }
    let copy = match fenced {
        Ok(copy) => copy,
        Err(_) => {
            let (cols, rows) = {
                let state = lifecycle.lock();
                (state.cols, state.rows)
            };
            return SnapshotTransfer::invalid(request, cols, rows);
        }
    };
    let held = copy.estimated_bytes();
    host.copy_bytes.fetch_add(held, Ordering::AcqRel);
    let serialized = copy.serialize(&wanted);
    host.copy_bytes.fetch_sub(held, Ordering::AcqRel);
    match serialized {
        Ok(snapshot) => {
            let transfer = SnapshotTransfer::from_snapshot(request, snapshot, "live");
            // Cached only if no chunk, resize or rebuild raced the fence.
            if transfer.header.accepted && lifecycle.screen_epoch() == epoch {
                host.snapshot_cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .put(epoch, wanted, &transfer.header, &transfer.ansi);
            }
            transfer
        }
        Err(error) => SnapshotTransfer::refused(request, "SNAPSHOT_TOO_LARGE", error.to_string()),
    }
}

fn produce_cold(host: &HostLifecycle, request: &v1::PtyScreenSnapshotRequest) -> SnapshotTransfer {
    let Some(store) = host.spool() else {
        return SnapshotTransfer::refused(
            request,
            "PTY_UNKNOWN",
            "PTY is unknown or expired".to_owned(),
        );
    };
    let cold = match store.read_cold(&request.pty_id) {
        Ok(cold) => cold,
        Err(error) => {
            return SnapshotTransfer::refused(
                request,
                "SPOOL_UNAVAILABLE",
                error.code().to_owned(),
            );
        }
    };
    let restored = cold
        .checkpoint
        .as_ref()
        .and_then(|checkpoint| ScreenModel::restore(&checkpoint.blob).ok());
    // A checkpoint that was present but unusable also loses the screen's start.
    let checkpoint_lost = cold.checkpoint.is_some() && restored.is_none();
    let mut model = match restored {
        Some(model) => model,
        None => match ScreenModel::new(80, 24, crate::terminal_screen::DEFAULT_SCROLLBACK_ROWS) {
            Ok(model) => model,
            Err(error) => {
                return SnapshotTransfer::refused(request, "SNAPSHOT_FAILED", error.to_string());
            }
        },
    };
    let mut through = cold
        .checkpoint
        .as_ref()
        .map_or(0, |checkpoint| checkpoint.through_sequence);
    for chunk in &cold.chunks {
        // Queries in output a dead PTY printed are never answered.
        let _past_queries = model.feed(&chunk.bytes);
        through = chunk.sequence;
    }
    if cold.continuity == SpoolContinuity::Partial || checkpoint_lost {
        model.mark_partial();
    }
    match model.snapshot(&limits(request)) {
        Ok(mut snapshot) => {
            snapshot.through_sequence = through;
            SnapshotTransfer::from_snapshot(request, snapshot, "cold")
        }
        Err(error) => SnapshotTransfer::refused(request, "SNAPSHOT_TOO_LARGE", error.to_string()),
    }
}
