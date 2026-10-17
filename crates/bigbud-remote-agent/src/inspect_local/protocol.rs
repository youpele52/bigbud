use std::io::{self, BufRead, Read, Write};

const MAX_REQUEST: u64 = 300_000;

#[cfg(any(windows, test))]
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn unhex(text: &str) -> io::Result<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(io::Error::other("invalid encoding"));
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(io::Error::other)?;
            u8::from_str_radix(text, 16).map_err(io::Error::other)
        })
        .collect()
}

fn dispatch(line: &str, ready: &mut bool) -> io::Result<String> {
    if line == "HELLO\t1" && !*ready {
        *ready = true;
        return Ok("OK\t1".into());
    }
    if !*ready {
        return Err(io::Error::other("handshake required"));
    }
    let (command, value) = line
        .split_once('\t')
        .ok_or_else(|| io::Error::other("invalid request"))?;
    match command {
        "FS" => {
            #[cfg(windows)]
            return super::fs::dispatch(value);
            #[cfg(not(windows))]
            Err(io::Error::other("unsupported platform"))
        }
        "CAPABILITIES" if value == "1" => {
            #[cfg(windows)]
            return Ok("OK\tboot=1\tdirectory-identity=1\tprivate-files=1\tread-lease=1".into());
            #[cfg(not(windows))]
            Ok("OK".into())
        }
        "DIRECTORY" => {
            let path = String::from_utf8(unhex(value)?).map_err(io::Error::other)?;
            #[cfg(windows)]
            return super::file::inspect_directory(&path).map(|id| format!("OK\t{id}"));
            #[cfg(not(windows))]
            {
                let _ = path;
                Err(io::Error::other("unsupported platform"))
            }
        }
        "BOOT" if value == "1" => {
            #[cfg(windows)]
            return super::boot::observe();
            #[cfg(not(windows))]
            Err(io::Error::other("unsupported platform"))
        }
        "READ" => {
            let bytes = unhex(value)?;
            let path = String::from_utf8(bytes).map_err(io::Error::other)?;
            #[cfg(windows)]
            return super::file::read_private(&path).map(|data| format!("OK\t{}", hex(&data)));
            #[cfg(not(windows))]
            {
                let _ = path;
                Err(io::Error::other("unsupported platform"))
            }
        }
        _ => Err(io::Error::other("unknown operation")),
    }
}

/// Serve bounded requests serially; EOF closes the helper without touching inspected processes.
pub fn run_stdio() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut ready = false;
    #[cfg(windows)]
    let mut lease = None;
    loop {
        let mut bytes = Vec::new();
        let count = input
            .by_ref()
            .take(MAX_REQUEST + 1)
            .read_until(b'\n', &mut bytes)?;
        if count == 0 {
            return Ok(());
        }
        if count as u64 > MAX_REQUEST || bytes.last() != Some(&b'\n') {
            return Err(io::Error::other("request bound exceeded"));
        }
        bytes.pop();
        let reply = std::str::from_utf8(&bytes)
            .map_err(io::Error::other)
            .and_then(|line| {
                #[cfg(windows)]
                if ready && line.starts_with("FS\t1\tLEASE_") {
                    return super::fs_lease::dispatch(line, &mut lease);
                }
                dispatch(line, &mut ready)
            });
        match reply {
            Ok(value) if value.len() <= 2_100_000 => writeln!(output, "{value}")?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                writeln!(output, "ERR\tmissing")?
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                writeln!(output, "ERR\texists")?
            }
            Err(error) if error.to_string() == "publication uncertain" => {
                writeln!(output, "ERR\tuncertain")?
            }
            Err(error) if error.to_string() == "identity conflict" => {
                writeln!(output, "ERR\tconflict")?
            }
            Err(error) => {
                // A finite diagnostic vocabulary only; never serialize arbitrary error text/paths.
                let reason = match error.to_string().as_str() {
                    "owner rejected" => "owner",
                    "untrusted access" => "acl-access",
                    "unsupported acl" => "acl-type",
                    "null dacl" => "acl-null",
                    "reparse rejected" => "reparse",
                    _ => "operation",
                };
                eprintln!(
                    "local inspection rejected: {reason} (os={:?})",
                    error.raw_os_error()
                );
                writeln!(output, "ERR")?;
            }
            // Never serialize oversized replies.
            _ => writeln!(output, "ERR")?,
        }
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_is_versioned_and_rejects_unscoped_operations() {
        let mut ready = false;
        assert!(dispatch("PROCESS\t1", &mut ready).is_err());
        assert!(dispatch("FS\t1\tDIR\t00\tprivate\t-", &mut ready).is_err());
        assert!(dispatch("HELLO\t2", &mut ready).is_err());
        assert_eq!(
            dispatch("HELLO\t1", &mut ready).ok().as_deref(),
            Some("OK\t1")
        );
        for request in [
            "STOP\t1",
            "WRITE\t1",
            "PROCESS\t0",
            "PROCESS\t1",
            "PROCESS\t-1",
            "READ\txx",
            "DIRECTORY\txx",
            "BOOT\t2",
            "CAPABILITIES\t2",
            "FS\t2\tCREATE",
            "FS\t1\tCREATE\t00\t-\t00\t00\t00",
            "HELLO\t1",
        ] {
            assert!(dispatch(request, &mut ready).is_err());
        }
        assert_eq!(
            unhex(&hex(b"private\0bytes")).ok(),
            Some(b"private\0bytes".to_vec())
        );
        assert!(dispatch("CAPABILITIES\t1", &mut ready).is_ok());
    }
}
