//! Platforms without a PTY foreground probe. Every query fails, so the conservative rule
//! treats each PTY as running a program (never idle).

use std::io;
use std::path::PathBuf;

fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "foreground probe unsupported")
}

pub(super) fn foreground_group(_master_fd: i32) -> io::Result<i32> {
    Err(unsupported())
}

pub(super) fn process_group(_pid: i32) -> io::Result<i32> {
    Err(unsupported())
}

pub(super) fn executable(_pid: i32) -> io::Result<PathBuf> {
    Err(unsupported())
}

pub(super) fn tree_rss(roots: &[i32]) -> Vec<Option<u64>> {
    roots.iter().map(|_| None).collect()
}
