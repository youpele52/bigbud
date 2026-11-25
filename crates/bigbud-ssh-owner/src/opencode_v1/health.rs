use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddrV4, TcpStream};
use std::time::{Duration, Instant};

const ATTEMPT: Duration = Duration::from_millis(200);
const MAX_RESPONSE: usize = 4096;

pub(super) enum Result {
    Healthy,
    Pending,
    Invalid,
}

pub(super) fn probe(
    endpoint: SocketAddrV4,
    startup_deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> Result {
    let deadline = startup_deadline.min(Instant::now() + ATTEMPT);
    let remaining = || {
        if cancelled() {
            return None;
        }
        let time = deadline.saturating_duration_since(Instant::now());
        (!time.is_zero()).then_some(time)
    };
    let Some(time) = remaining() else {
        return Result::Pending;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&endpoint.into(), time) else {
        return Result::Pending;
    };
    let request =
        format!("GET /global/health HTTP/1.1\r\nHost: {endpoint}\r\nConnection: close\r\n\r\n");
    let mut unsent = request.as_bytes();
    while !unsent.is_empty() {
        let Some(time) = remaining() else {
            return Result::Pending;
        };
        if stream.set_write_timeout(Some(time)).is_err() {
            return Result::Pending;
        }
        match stream.write(unsent) {
            Ok(0) => return Result::Pending,
            Ok(n) => {
                let Some(rest) = unsent.get(n..) else {
                    return Result::Pending;
                };
                unsent = rest;
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Result::Pending,
        }
    }
    read_response(stream, remaining)
}

fn read_response(mut stream: TcpStream, remaining: impl Fn() -> Option<Duration>) -> Result {
    let mut buffer = [0_u8; MAX_RESPONSE];
    let mut used = 0_usize;
    let mut body = None;
    while used < buffer.len() {
        let Some(time) = remaining() else {
            return Result::Pending;
        };
        if stream.set_read_timeout(Some(time)).is_err() {
            return Result::Pending;
        }
        let Some(unfilled) = buffer.get_mut(used..) else {
            return Result::Invalid;
        };
        let n = match stream.read(unfilled) {
            Ok(0) if used == 0 => return Result::Pending,
            Ok(0) => return Result::Invalid,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Result::Pending,
        };
        let search_start = used.saturating_sub(3);
        used += n;
        if body.is_none() {
            let Some(unsearched) = buffer.get(search_start..used) else {
                return Result::Invalid;
            };
            if let Some(index) = unsearched
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
            {
                let delimiter = search_start + index;
                let start = delimiter + 4;
                let Some(len) = buffer.get(..delimiter).and_then(body_length) else {
                    return Result::Invalid;
                };
                if len > MAX_RESPONSE - start {
                    return Result::Invalid;
                }
                body = Some((start, start + len));
            }
        }
        if let Some((start, end)) = body
            && used >= end
        {
            return if used == end && buffer.get(start..end).is_some_and(healthy_json) {
                Result::Healthy
            } else {
                Result::Invalid
            };
        }
    }
    Result::Invalid
}

fn body_length(head: &[u8]) -> Option<usize> {
    let mut lines = std::str::from_utf8(head).ok()?.split("\r\n");
    let mut status = lines.next()?.splitn(3, ' ');
    if !matches!(status.next()?, "HTTP/1.1" | "HTTP/1.0") || status.next()? != "200" {
        return None;
    }
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return None;
        }
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim_matches([' ', '\t']);
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            length = Some(value.parse::<usize>().ok()?);
        }
    }
    length
}

fn healthy_json(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|body| body.get("healthy").and_then(serde_json::Value::as_bool))
        == Some(true)
}
