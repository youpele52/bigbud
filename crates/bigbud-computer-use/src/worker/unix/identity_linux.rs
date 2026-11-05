use super::identity::{ProcessIdentity, boot_uuid, invalid};
#[cfg(target_os = "linux")]
use std::{fs::File, io::Read};
use std::{io, num::NonZeroU32};

#[cfg(target_os = "linux")]
pub(super) fn inspect(pid: NonZeroU32) -> io::Result<ProcessIdentity> {
    // Bound both kernel reads. No process environment, argv or executable paths
    // are retained; the command-name field is skipped, not logged.
    fn bounded(path: &str, max: u64) -> io::Result<String> {
        let mut text = String::new();
        File::open(path)?.take(max + 1).read_to_string(&mut text)?;
        if text.len() as u64 > max {
            return Err(invalid());
        }
        Ok(text)
    }
    let boot = bounded("/proc/sys/kernel/random/boot_id", 37)?;
    let stat = bounded(&format!("/proc/{pid}/stat"), 4096)?;
    parse(pid, boot.trim_end_matches('\n'), &stat)
}

pub(super) fn parse(pid: NonZeroU32, boot: &str, stat: &str) -> io::Result<ProcessIdentity> {
    let uuid = boot_uuid(boot.as_bytes())?;
    if stat.len() > 4096 {
        return Err(invalid());
    }
    let (prefix, rest) = stat.split_once(" (").ok_or_else(invalid)?;
    if prefix.parse::<u32>().map_err(|_| invalid())? != pid.get() {
        return Err(invalid());
    }
    // comm may contain spaces, newlines and ')'; only the final delimiter ends it.
    let (_, fields) = rest.rsplit_once(") ").ok_or_else(invalid)?;
    let mut fields = fields.split_ascii_whitespace();
    let state = fields.next().ok_or_else(invalid)?;
    if state.len() != 1 {
        return Err(invalid());
    }
    let parent = fields
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    let group = fields
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    // We consumed fields 3, 4, 5. starttime is field 22 (skip 6 through 21).
    let start = fields
        .nth(16)
        .ok_or_else(invalid)?
        .parse::<u64>()
        .map_err(|_| invalid())?;
    if start == 0 {
        return Err(invalid());
    }
    Ok(ProcessIdentity {
        pid,
        parent,
        group,
        creation: format!("linux:{uuid}:{start}"),
    })
}
