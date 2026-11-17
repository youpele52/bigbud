//! Verify the mobile gateway's post-bind readiness against the original child.
use super::{Error, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, SocketAddr};
use std::os::fd::AsRawFd;
use std::process::ChildStdout;
use std::time::{Duration, Instant};

const READY_LINE_LIMIT: usize = 1024;
const READY_OUTPUT_LIMIT: usize = 4096;
const MAX_TCP_ROWS: usize = 65536;
const MAX_CHILD_FDS: usize = 4096;
const READY_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn expected(args: &[String]) -> Result<Option<SocketAddr>> {
    let mut listen = args
        .iter()
        .enumerate()
        .filter(|(_, flag)| flag.as_str() == "--listen")
        .map(|(index, _)| {
            args.get(index + 1)
                .ok_or(Error::Invalid)
                .and_then(|value| value.parse::<SocketAddr>().map_err(|_| Error::Invalid))
        });
    let Some(address) = listen.next() else {
        return Ok(None);
    };
    let address = address?;
    if listen.next().is_some() || address.ip() != Ipv4Addr::LOCALHOST {
        return Err(Error::Invalid);
    }
    Ok(Some(address))
}

pub(super) fn await_child(pid: u32, stdout: &mut ChildStdout, expected: SocketAddr) -> Result<()> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut line = Vec::with_capacity(128);
    let mut total = 0usize;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Error::Uncertain);
        }
        let timeout = i32::try_from(remaining.as_millis().clamp(1, i32::MAX as u128))
            .map_err(|_| Error::Uncertain)?;
        let mut descriptor = libc::pollfd {
            fd: stdout.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        // SAFETY: descriptor points to one initialized pollfd for this synchronous call.
        let ready = unsafe { libc::poll(&mut descriptor, 1, timeout) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if ready == 0 {
            return Err(Error::Uncertain);
        }
        let mut byte = [0];
        if stdout.read(&mut byte)? == 0 {
            return Err(Error::Uncertain);
        }
        if total == READY_OUTPUT_LIMIT {
            return Err(Error::Invalid);
        }
        total += 1;
        if byte[0] == b'\n' {
            if let Ok(address) = parse_line(&line) {
                if address.ip() != expected.ip()
                    || (expected.port() != 0 && address.port() != expected.port())
                    || address.port() == 0
                    || address.ip() != Ipv4Addr::LOCALHOST
                    || !owns_listener(pid, address)?
                {
                    return Err(Error::Uncertain);
                }
                return Ok(());
            }
            line.clear();
            continue;
        }
        if line.len() == READY_LINE_LIMIT || byte[0] == b'\r' {
            return Err(Error::Invalid);
        }
        line.push(byte[0]);
    }
}

fn parse_line(line: &[u8]) -> Result<SocketAddr> {
    let value: Value = serde_json::from_slice(line).map_err(|_| Error::Invalid)?;
    let object = value.as_object().ok_or(Error::Invalid)?;
    if object.len() != 2 || object.get("event").and_then(Value::as_str) != Some("ready") {
        return Err(Error::Invalid);
    }
    object
        .get("listen")
        .and_then(Value::as_str)
        .ok_or(Error::Invalid)?
        .parse()
        .map_err(|_| Error::Invalid)
}

fn owns_listener(pid: u32, address: SocketAddr) -> Result<bool> {
    let local = format!(
        "{:08X}:{:04X}",
        u32::from_ne_bytes(Ipv4Addr::LOCALHOST.octets()),
        address.port()
    );
    let table = BufReader::new(std::fs::File::open("/proc/net/tcp")?).take(8 * 1024 * 1024);
    let mut inode = None;
    let mut rows = table.lines();
    let _header = rows.next().ok_or(Error::Uncertain)??;
    for row_result in rows.take(MAX_TCP_ROWS) {
        let row = row_result?;
        let fields: Vec<_> = row.split_whitespace().collect();
        if fields.get(1) == Some(&local.as_str()) && fields.get(3) == Some(&"0A") {
            inode = fields.get(9).map(|value| (*value).to_owned());
            break;
        }
    }
    let Some(inode) = inode else {
        return Ok(false);
    };
    let descriptors = std::fs::read_dir(format!("/proc/{pid}/fd"))?;
    for descriptor in descriptors.take(MAX_CHILD_FDS) {
        let descriptor = descriptor?;
        let target = match std::fs::read_link(descriptor.path()) {
            Ok(target) => target,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if target.to_string_lossy() == format!("socket:[{inode}]") {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
#[path = "process.readiness.tests.rs"]
mod tests;
