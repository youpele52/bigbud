//! macOS process facts from libproc.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

pub(super) use super::unix::{foreground_group, process_group};

pub(super) fn executable(pid: i32) -> io::Result<PathBuf> {
    if pid <= 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"));
    }
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is live, writable and exactly `buffer.len()` bytes long.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(usize::try_from(length).unwrap_or(0));
    Ok(PathBuf::from(OsString::from_vec(buffer)))
}

/// Children per parent from `proc_listchildpids`, resident size from `proc_pid_rusage`.
pub(super) fn tree_rss(roots: &[i32]) -> Vec<Option<u64>> {
    roots
        .iter()
        .map(|root| {
            let mut table = HashMap::new();
            let mut frontier = vec![(*root, 0)];
            while let Some((pid, parent)) = frontier.pop() {
                if table.len() >= super::MAX_TREE_PROCESSES {
                    break;
                }
                let Some(rss) = resident_size(pid) else {
                    continue;
                };
                table.insert(pid, (parent, rss));
                frontier.extend(children(pid).into_iter().map(|child| (child, pid)));
            }
            super::sum_tree(*root, &table)
        })
        .collect()
}

fn children(pid: i32) -> Vec<i32> {
    let mut buffer = vec![0i32; 256];
    loop {
        let bytes = i32::try_from(buffer.len() * size_of::<i32>()).unwrap_or(i32::MAX);
        // SAFETY: the buffer is live and `bytes` long; the call writes at most that much.
        let count = unsafe { libc::proc_listchildpids(pid, buffer.as_mut_ptr().cast(), bytes) };
        let Ok(count) = usize::try_from(count) else {
            return Vec::new();
        };
        if count < buffer.len() || buffer.len() >= super::MAX_TREE_PROCESSES {
            buffer.truncate(count.min(buffer.len()));
            return buffer.into_iter().filter(|child| *child > 0).collect();
        }
        buffer.resize(buffer.len() * 2, 0);
    }
}

fn resident_size(pid: i32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: `info` is a live, correctly sized rusage_info_v2 for flavor RUSAGE_INFO_V2.
    let result =
        unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr().cast()) };
    if result != 0 {
        return None;
    }
    // SAFETY: a zero return means the kernel filled the structure.
    Some(unsafe { info.assume_init() }.ri_resident_size)
}
