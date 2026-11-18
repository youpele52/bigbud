#![cfg_attr(not(windows), allow(dead_code))]
use std::io::{self, BufRead, Read};

pub const MAX_BYTES: usize = 65536;
pub const MAX_CLIENTS: usize = 16;
pub const MAX_FRAME: u64 = (MAX_BYTES * 2 + 65536 + 512) as u64;
pub const PIPE_PREFIX: &str = "\\\\.\\pipe\\bigbud-remote-agent-";

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub fn unhex(text: &str, maximum: usize) -> io::Result<Vec<u8>> {
    if text.len() > maximum * 2
        || !text.len().is_multiple_of(2)
        || !text.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(io::Error::other("invalid bounded encoding"));
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(io::Error::other)?;
            u8::from_str_radix(text, 16).map_err(io::Error::other)
        })
        .collect()
}
pub fn read_frame(input: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let count = input
        .by_ref()
        .take(MAX_FRAME + 1)
        .read_until(b'\n', &mut bytes)?;
    if count == 0 {
        return Ok(None);
    }
    if count as u64 > MAX_FRAME || bytes.pop() != Some(b'\n') {
        return Err(io::Error::other("frame bound exceeded"));
    }
    String::from_utf8(bytes).map(Some).map_err(io::Error::other)
}
pub fn pipe_name(value: &str) -> io::Result<&str> {
    let suffix = value
        .strip_prefix(PIPE_PREFIX)
        .ok_or_else(|| io::Error::other("pipe namespace rejected"))?;
    if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::other("pipe identity rejected"));
    }
    Ok(value)
}
#[derive(Clone)]
pub struct Endpoint {
    pub pipe: String,
    pub pid: u32,
    pub started: u64,
    pub backend: String,
}
impl Endpoint {
    pub fn encode(&self) -> String {
        format!(
            "bigbud-local-pipe-v1\t{}\t{}\t{}\t{}",
            hex(self.pipe.as_bytes()),
            self.pid,
            self.started,
            self.backend
        )
    }
    pub fn parse(value: &str) -> io::Result<Self> {
        if value.len() > 1024 {
            return Err(io::Error::other("endpoint bound"));
        }
        let fields: Vec<_> = value.split('\t').collect();
        let ["bigbud-local-pipe-v1", pipe, pid, started, backend] = fields.as_slice() else {
            return Err(io::Error::other("endpoint format"));
        };
        let pipe = String::from_utf8(unhex(pipe, 256)?).map_err(io::Error::other)?;
        pipe_name(&pipe)?;
        let pid = pid.parse::<u32>().map_err(io::Error::other)?;
        let started = started.parse::<u64>().map_err(io::Error::other)?;
        if pid == 0
            || started == 0
            || backend.len() != 64
            || !backend.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(io::Error::other("endpoint identity"));
        }
        Ok(Self {
            pipe,
            pid,
            started,
            backend: backend.to_string(),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_requires_bounded_instance_identity() {
        let endpoint = Endpoint {
            pipe: format!("{PIPE_PREFIX}{}", "a".repeat(32)),
            pid: 42,
            started: 123,
            backend: "b".repeat(64),
        };
        assert!(Endpoint::parse(&endpoint.encode()).is_ok());
        assert!(Endpoint::parse(&endpoint.encode().replace("\t42\t", "\t0\t")).is_err());
        let mut other = endpoint.clone();
        other.pipe = "other".into();
        assert!(Endpoint::parse(&other.encode()).is_err());
        assert!(Endpoint::parse(&"x".repeat(1025)).is_err());
    }
    #[test]
    fn frame_and_hex_bounds_are_enforced_before_decode() {
        assert!(unhex("ff", 1).is_ok());
        assert!(unhex("fff", 2).is_err());
        assert!(unhex("zz", 1).is_err());
        assert!(unhex("ffff", 1).is_err());
        assert!(
            read_frame(&mut std::io::Cursor::new(vec![
                b'x';
                MAX_FRAME as usize + 2
            ]))
            .is_err()
        );
        assert!(read_frame(&mut std::io::Cursor::new(b"incomplete")).is_err());
    }
}
