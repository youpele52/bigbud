//! Separate image boundary for the disposable Linux picker Bubblewrap launcher.
//! Its inherited namespace maps the fixture user, not host root. The launcher
//! makes both the synthetic root and the system tools mount read-only.

use super::{ErrorCode, KEYSCAN, SSH, UNAVAILABLE};
use std::ffi::{CString, OsStr};
use std::fs::{self, File};
use std::io::Read;
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const OPT_IN: &str = "BIGBUD_SSH_OWNER_PICKER_RO_SYSTEM_TOOLS";
const TOOLS: &str = "/usr/bin";
const MAX_MOUNTINFO: u64 = 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) struct MountedTools {
    namespace_uid: u32,
    overflow_uid: u32,
}

impl MountedTools {
    pub(super) fn requested() -> bool {
        std::env::var_os(OPT_IN).as_deref() == Some(OsStr::new("1"))
    }

    pub(super) fn bind() -> Result<Self, ErrorCode> {
        // SAFETY: these calls only read current process credentials.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        if uid == 0
            || gid == 0
            || !sole_mapping(&read_proc("/proc/self/uid_map")?, uid)
            || !sole_mapping(&read_proc("/proc/self/gid_map")?, gid)
            || !dropped_privileges(&read_proc("/proc/self/status")?)
        {
            return Err(UNAVAILABLE);
        }
        let overflow_uid = read_proc("/proc/sys/kernel/overflowuid")?
            .trim()
            .parse()
            .map_err(|_| UNAVAILABLE)?;
        if overflow_uid == uid || overflow_uid == 0 {
            return Err(UNAVAILABLE);
        }
        let mut mounts = String::new();
        let size = File::open("/proc/self/mountinfo")
            .map_err(|_| UNAVAILABLE)?
            .take(MAX_MOUNTINFO + 1)
            .read_to_string(&mut mounts)
            .map_err(|_| UNAVAILABLE)?;
        if size as u64 > MAX_MOUNTINFO || !explicit_tools_mount(&mounts) {
            return Err(UNAVAILABLE);
        }
        Ok(Self {
            namespace_uid: uid,
            overflow_uid,
        })
    }

    pub(super) fn owner(self, path: &Path) -> u32 {
        if path.starts_with(TOOLS) {
            self.overflow_uid
        } else {
            self.namespace_uid
        }
    }

    pub(super) fn revalidate(path: &Path) -> Result<(), ErrorCode> {
        // A writable synthetic ancestor would let the namespace user rename
        // it between validation and exec, despite the tools mount being RO.
        for item in [Path::new("/"), Path::new("/usr"), Path::new(TOOLS), path] {
            if !read_only(item)? {
                return Err(UNAVAILABLE);
            }
        }
        Ok(())
    }
}

fn sole_mapping(text: &str, expected: u32) -> bool {
    let mut parts = text.split_whitespace();
    parts.next().and_then(|s| s.parse().ok()) == Some(expected)
        && parts.next().and_then(|s| s.parse::<u32>().ok()).is_some()
        && parts.next() == Some("1")
        && parts.next().is_none()
}

fn dropped_privileges(status: &str) -> bool {
    [
        "CapInh",
        "CapPrm",
        "CapEff",
        "CapBnd",
        "CapAmb",
        "NoNewPrivs",
    ]
    .into_iter()
    .all(|name| {
        status
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                (key == name).then_some(value.trim())
            })
            .is_some_and(|value| {
                if name == "NoNewPrivs" {
                    value == "1"
                } else {
                    value == "0000000000000000"
                }
            })
    })
}

fn explicit_tools_mount(info: &str) -> bool {
    let mut found = false;
    for line in info.lines() {
        let mut fields = line.split_whitespace().skip(4);
        match fields.next() {
            Some(TOOLS)
                if !found
                    && fields
                        .next()
                        .is_some_and(|opts| opts.split(',').any(|flag| flag == "ro")) =>
            {
                found = true;
            }
            Some(TOOLS | SSH | KEYSCAN) => return false,
            _ => {}
        }
    }
    found
}

fn read_proc(path: &str) -> Result<String, ErrorCode> {
    fs::read_to_string(path).map_err(|_| UNAVAILABLE)
}

fn read_only(path: &Path) -> Result<bool, ErrorCode> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| UNAVAILABLE)?;
    let mut flags = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: the path is NUL-terminated and the output has writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), flags.as_mut_ptr()) } != 0 {
        return Err(UNAVAILABLE);
    }
    // SAFETY: statvfs initialized the output structure on success.
    Ok(unsafe { flags.assume_init() }.f_flag & libc::ST_RDONLY != 0)
}

#[cfg(test)]
mod tests;
