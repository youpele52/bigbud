use std::io::{self, BufRead, Read, Write};

const MAX_REQUEST: u64 = 131_072;

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
        "PROCESS" => {
            let pid = value.parse::<u32>().map_err(io::Error::other)?;
            if pid == 0 {
                return Err(io::Error::other("invalid pid"));
            }
            #[cfg(windows)]
            return super::windows::inspect(pid);
            #[cfg(not(windows))]
            Err(io::Error::other("unsupported platform"))
        }
        _ => Err(io::Error::other("unknown operation")),
    }
}

/// Serve bounded requests serially; EOF closes the helper without touching inspected processes.
pub fn run_stdio() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut ready = false;
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
            .and_then(|line| dispatch(line, &mut ready));
        match reply {
            Ok(value) if value.len() <= 1_048_576 => writeln!(output, "{value}")?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                writeln!(output, "ERR\tmissing")?
            }
            Err(error) => {
                // A finite diagnostic vocabulary only; never serialize arbitrary error text/paths.
                let reason = match error.to_string().as_str() {
                    "owner rejected" => "owner",
                    "untrusted access" => "acl-access",
                    "unsupported acl" => "acl-type",
                    "null dacl" => "acl-null",
                    "reparse rejected" => "reparse",
                    "unclassified snapshot handle" => "snapshot-type",
                    "unnamed file handle" => "snapshot-name",
                    "snapshot file classification changed" => "snapshot-reused",
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
    fn protocol_is_versioned_and_read_only() {
        let mut ready = false;
        assert!(dispatch("PROCESS\t1", &mut ready).is_err());
        assert!(dispatch("HELLO\t2", &mut ready).is_err());
        assert_eq!(
            dispatch("HELLO\t1", &mut ready).ok().as_deref(),
            Some("OK\t1")
        );
        for request in [
            "STOP\t1",
            "WRITE\t1",
            "PROCESS\t0",
            "PROCESS\t-1",
            "READ\txx",
            "HELLO\t1",
        ] {
            assert!(dispatch(request, &mut ready).is_err());
        }
        assert_eq!(
            unhex(&hex(b"private\0bytes")).ok(),
            Some(b"private\0bytes".to_vec())
        );
    }
}
