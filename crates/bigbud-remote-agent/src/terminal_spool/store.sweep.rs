//! Startup sweep and the 512 MiB host budget (plan §8.3 retention and budgets).

use std::fs;
use std::path::Path;

use super::errors::SpoolError;
use super::layout::{self, META_FILE, SEGMENT_FILES};
use super::meta::{SpoolMeta, SpoolState};
use super::store::SpoolStore;
use super::writer::SpoolWriter;

/// A spool whose PTY died with a previous host; kept for cold restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LostSpool {
    pub pty_id: String,
    pub lost_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// `lost` spools still retained, including those this sweep just marked.
    pub lost: Vec<LostSpool>,
    /// Spool directories (or stray entries) deleted.
    pub removed: usize,
    /// Entries left alone after a transient I/O error.
    pub skipped: usize,
    pub budget: BudgetReport,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BudgetReport {
    pub used_bytes: u64,
    pub evicted: usize,
    pub shrink_requests: usize,
}

enum Sweep {
    Keep(LostSpool),
    Remove,
}

struct Candidate {
    name: String,
    dir: std::path::PathBuf,
    usage: u64,
    rank: (u8, u64),
}

impl SpoolStore {
    /// Removes leftovers and marks spools whose writer died with a previous host as `lost`.
    /// Spools with a live writer in this process are untouched.
    pub fn sweep(&self, now_ms: u64) -> Result<SweepReport, SpoolError> {
        let mut report = SweepReport::default();
        for (name, dir) in self.spool_dirs()? {
            if self.inner.has_writer(&name)? {
                continue;
            }
            // Corrupt or foreign entries are garbage in a folder bigbud owns exclusively; any
            // other I/O failure leaves the entry for the next sweep instead of deleting it.
            match self.sweep_one(&name, &dir, now_ms) {
                Ok(Sweep::Keep(lost)) => report.lost.push(lost),
                Ok(Sweep::Remove) | Err(SpoolError::Corrupt | SpoolError::Unknown) => {
                    remove_entry(&dir)?;
                    report.removed += 1;
                }
                Err(_) => report.skipped += 1,
            }
        }
        report.lost.sort_by(|a, b| a.pty_id.cmp(&b.pty_id));
        report.budget = self.enforce_budget()?;
        Ok(report)
    }

    fn sweep_one(&self, name: &str, dir: &Path, now_ms: u64) -> Result<Sweep, SpoolError> {
        let metadata = fs::symlink_metadata(dir)?;
        if !metadata.is_dir() || !layout::is_spool_dir_name(name) {
            return Ok(Sweep::Remove);
        }
        let meta_path = dir.join(META_FILE);
        let mut meta = SpoolMeta::load(&meta_path)?;
        if layout::dir_name(&meta.pty_id) != name {
            return Ok(Sweep::Remove);
        }
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if layout::is_temp_file(&path) {
                layout::remove_if_present(&path)?;
            }
        }
        match meta.state {
            SpoolState::Closed => Ok(Sweep::Remove),
            SpoolState::Live => {
                meta.state = SpoolState::Lost;
                meta.lost_at_ms = Some(now_ms);
                meta.updated_ms = now_ms;
                meta.store(&meta_path)?;
                Ok(Sweep::Keep(LostSpool {
                    pty_id: meta.pty_id,
                    lost_at_ms: now_ms,
                }))
            }
            SpoolState::Lost => {
                let lost_at_ms = meta.lost_at_ms.unwrap_or(meta.updated_ms);
                if now_ms.saturating_sub(lost_at_ms) >= self.inner.limits.lost_retention_ms {
                    return Ok(Sweep::Remove);
                }
                Ok(Sweep::Keep(LostSpool {
                    pty_id: meta.pty_id,
                    lost_at_ms,
                }))
            }
        }
    }

    /// Keeps the host total under budget: closed and lost spools go first (oldest first), then
    /// live spools are asked to drop their older segment (largest first).
    pub fn enforce_budget(&self) -> Result<BudgetReport, SpoolError> {
        let budget = self.inner.limits.host_budget_bytes;
        let mut report = BudgetReport::default();
        let mut idle = Vec::new();
        let mut live = Vec::new();
        for (name, dir) in self.spool_dirs()? {
            let usage = layout::dir_usage(&dir);
            report.used_bytes = report.used_bytes.saturating_add(usage);
            let rank = match SpoolMeta::load(&dir.join(META_FILE)) {
                Ok(meta) if meta.state == SpoolState::Closed => (0, meta.updated_ms),
                Ok(meta) => (1, meta.updated_ms),
                Err(_) => (0, 0),
            };
            let candidate = Candidate {
                name,
                dir,
                usage,
                rank,
            };
            if self.inner.has_writer(&candidate.name)? {
                live.push(candidate);
            } else {
                idle.push(candidate);
            }
        }
        idle.sort_by_key(|candidate| candidate.rank);
        for candidate in idle {
            if report.used_bytes <= budget {
                return Ok(report);
            }
            remove_entry(&candidate.dir)?;
            report.used_bytes = report.used_bytes.saturating_sub(candidate.usage);
            report.evicted += 1;
        }
        live.sort_by_key(|candidate| std::cmp::Reverse(candidate.usage));
        for candidate in live {
            if report.used_bytes <= budget {
                break;
            }
            let reclaimable = older_segment_estimate(&candidate.dir);
            if reclaimable == 0 {
                continue;
            }
            if self.request_shrink(&candidate.name)? {
                report.used_bytes = report.used_bytes.saturating_sub(reclaimable);
                report.shrink_requests += 1;
            }
        }
        Ok(report)
    }

    fn request_shrink(&self, dir_name: &str) -> Result<bool, SpoolError> {
        let writers = self
            .inner
            .writers
            .lock()
            .map_err(|_| SpoolError::Io(std::io::Error::other("spool registry poisoned")))?;
        Ok(writers
            .get(dir_name)
            .is_some_and(|link| SpoolWriter::request_shrink(&link.sender)))
    }
}

/// Both segments hold data only after a rotation; the older one is then the full one.
fn older_segment_estimate(dir: &Path) -> u64 {
    let [first, second] =
        SEGMENT_FILES.map(|name| fs::metadata(dir.join(name)).map_or(0, |metadata| metadata.len()));
    if first == 0 || second == 0 {
        0
    } else {
        first.max(second)
    }
}

fn remove_entry(path: &Path) -> Result<(), SpoolError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => layout::remove_spool_dir(path)?,
        Ok(_) => layout::remove_if_present(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
