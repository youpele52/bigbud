//! On-disk scrollback spool for host terminals (terminal lifecycle plan, R2).
//!
//! Each managed PTY gets a private folder with two rotating raw segments of framed output
//! chunks and an atomic opaque checkpoint, so a crashed host's screens can be rebuilt cold.

mod backup;
mod checkpoint;
mod errors;
mod layout;
mod meta;
mod segment;
mod store;
#[path = "store.sweep.rs"]
mod store_sweep;
mod writer;
#[path = "writer.thread.rs"]
mod writer_thread;

pub use backup::{BACKUP_EXCLUDE_PLIST, BACKUP_EXCLUDE_XATTR, BackupExclusion};
#[cfg(target_os = "macos")]
pub use backup::{exclude_from_backup, is_excluded_from_backup, read_backup_xattr};
pub use checkpoint::SpoolCheckpoint;
pub use errors::{SpoolError, SpoolLimits};
pub use meta::SpoolState;
pub use segment::SpoolChunk;
pub use store::{ColdSpool, SpoolContinuity, SpoolStore};
pub use store_sweep::{BudgetReport, LostSpool, SweepReport};
pub use writer::{AppendOutcome, SpoolWriter};

#[cfg(all(test, target_os = "macos"))]
#[path = "backup.tests.rs"]
mod backup_tests;
#[cfg(test)]
#[path = "store.tests.rs"]
mod store_tests;
#[cfg(test)]
#[path = "sweep.tests.rs"]
mod sweep_tests;
#[cfg(test)]
#[path = "writer.tests.rs"]
mod writer_tests;
