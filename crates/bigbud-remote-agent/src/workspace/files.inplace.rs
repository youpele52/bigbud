//! Unix in-place overwrite for files a rename would change (hard-linked, owned by another user,
//! or whose group the writer cannot give a replacement). The inode is truncated and rewritten,
//! which keeps hard links, owner, group, mode and ACLs. As in Zed, a failure after truncation
//! can leave a partial file, so it is reported as [`WorkspaceError::UnknownOutcome`] and the
//! editor reads back before any retry (remote file editing plan, D3 and D6).

use std::ffi::CStr;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};

use super::files::reader_sha256;
use super::files_seams::{Fault, after_sync, before_commit, injected};
use super::files_target::{TargetStat, open_target_at, verify_read_back, write_conflict};
use super::{WorkspaceError, map_io};

/// Rewrites the target that `checked` describes. The caller holds the write locks.
///
/// The target is reopened `O_RDWR | O_NOFOLLOW` and must still be the same inode as `checked`.
/// When it is missing or was replaced in between, a guarded write reports a conflict (with the
/// replacement's hash) and an unguarded write fails without writing; nothing is created. Every
/// failure before the truncation is definitive; the truncation and everything after it is an
/// unknown outcome.
pub(super) fn write_in_place(
    parent: &File,
    target_name: &CStr,
    checked: &TargetStat,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Result<(), WorkspaceError> {
    before_commit();
    let Some((mut file, current)) = open_target_at(parent, target_name, libc::O_RDWR)? else {
        return Err(match expected_sha256 {
            Some(expected) => write_conflict(expected, None),
            None => replaced_during_write(),
        });
    };
    if !current.same_identity(checked) {
        return Err(match expected_sha256 {
            Some(expected) => write_conflict(expected, Some(reader_sha256(&mut file)?)),
            None => replaced_during_write(),
        });
    }
    if let Some(expected) = expected_sha256 {
        // Re-check through the descriptor that will be written.
        let actual = reader_sha256(&mut file)?;
        if actual != expected {
            return Err(write_conflict(expected, Some(actual)));
        }
    }
    rewrite_truncated(&mut file, bytes)
        .map_err(|error| WorkspaceError::UnknownOutcome(Box::new(error)))
}

/// Truncates and rewrites; a failed truncate is also treated as an unknown outcome.
fn rewrite_truncated(file: &mut File, bytes: &[u8]) -> Result<(), WorkspaceError> {
    file.set_len(0).map_err(map_io)?;
    if let Some(error) = injected(Fault::AfterTruncate) {
        return Err(map_io(error));
    }
    file.seek(SeekFrom::Start(0)).map_err(map_io)?;
    file.write_all(bytes).map_err(map_io)?;
    file.sync_all().map_err(map_io)?;
    after_sync(file);
    verify_read_back(file, bytes)
}

fn replaced_during_write() -> WorkspaceError {
    WorkspaceError::Io(std::io::Error::other(
        "workspace file was replaced during an in-place write",
    ))
}
