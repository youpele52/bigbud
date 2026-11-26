//! The last two live snapshots, reused while their screen is unchanged (terminal lifecycle R7).
//!
//! A snapshot clones the whole grid (about 7 MB) before serializing; restoring a quiet terminal
//! again and again (switching views back and forth) would repeat that clone for an identical
//! result, and the clone churn fragments the host's heap. An entry is valid only for the exact
//! screen epoch it was taken at: every fed chunk, resize and rebuild advances the epoch.

use std::collections::VecDeque;
use std::sync::Arc;

use bigbud_protocol::v1;

use crate::terminal_screen::SnapshotLimits;

const CACHED: usize = 2;

struct Entry {
    pty_id: String,
    epoch: u64,
    limits: SnapshotLimits,
    header: v1::PtyScreenSnapshotHeader,
    ansi: Arc<Vec<u8>>,
}

#[derive(Default)]
pub(crate) struct SnapshotCache {
    entries: VecDeque<Entry>,
}

impl SnapshotCache {
    pub(crate) fn get(
        &self,
        pty_id: &str,
        epoch: u64,
        limits: &SnapshotLimits,
    ) -> Option<(v1::PtyScreenSnapshotHeader, Arc<Vec<u8>>)> {
        self.entries
            .iter()
            .find(|entry| entry.pty_id == pty_id && entry.epoch == epoch && entry.limits == *limits)
            .map(|entry| (entry.header.clone(), Arc::clone(&entry.ansi)))
    }

    pub(crate) fn put(
        &mut self,
        epoch: u64,
        limits: SnapshotLimits,
        header: &v1::PtyScreenSnapshotHeader,
        ansi: &Arc<Vec<u8>>,
    ) {
        self.entries.retain(|entry| entry.pty_id != header.pty_id);
        if self.entries.len() == CACHED {
            self.entries.pop_front();
        }
        self.entries.push_back(Entry {
            pty_id: header.pty_id.clone(),
            epoch,
            limits,
            header: header.clone(),
            ansi: Arc::clone(ansi),
        });
    }
}
