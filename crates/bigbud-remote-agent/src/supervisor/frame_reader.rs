use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, decode_frame, v1};
use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static HANDSHAKES: AtomicUsize = AtomicUsize::new(0);
static CONTROL_HANDSHAKES: AtomicUsize = AtomicUsize::new(0);
pub(super) struct HandshakePermit {
    pub control_only: bool,
}
impl HandshakePermit {
    pub fn reserve() -> io::Result<Self> {
        // Pre-hello peers cannot consume all 64 established/control connections.
        HANDSHAKES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 16).then_some(n + 1)
            })
            .map_err(|_| io::Error::other("handshake admission exhausted"))?;
        Ok(Self {
            control_only: false,
        })
    }
    pub fn control() -> io::Result<Self> {
        CONTROL_HANDSHAKES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 4).then_some(n + 1)
            })
            .map_err(|_| io::Error::other("control handshake admission exhausted"))?;
        Ok(Self { control_only: true })
    }
}
impl Drop for HandshakePermit {
    fn drop(&mut self) {
        let counter = if self.control_only {
            &CONTROL_HANDSHAKES
        } else {
            &HANDSHAKES
        };
        counter.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(super) struct FrameReader {
    stream: UnixStream,
    hello_deadline: Instant,
    timeout: Duration,
}
impl FrameReader {
    pub fn new(stream: UnixStream) -> Self {
        Self::with_timeout(stream, Duration::from_secs(5))
    }
    pub(super) fn with_timeout(stream: UnixStream, timeout: Duration) -> Self {
        Self {
            stream,
            hello_deadline: Instant::now() + timeout,
            timeout,
        }
    }
    pub fn next(&mut self, established: bool) -> io::Result<Option<v1::Frame>> {
        let mut prefix = [0; 4];
        // An established idle subscriber has no first-byte timeout. Once ANY
        // frame byte arrives, one absolute deadline covers prefix and payload.
        let hello = if established {
            None
        } else {
            Some(self.hello_deadline)
        };
        self.read_timeout(hello)?;
        loop {
            match self.stream.read(&mut prefix[..1]) {
                Ok(0) => return Ok(None),
                Ok(_) => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                    self.read_timeout(hello)?;
                }
                Err(error) => return Err(error),
            }
        }
        let deadline = match hello {
            Some(deadline) => deadline,
            None => Instant::now() + self.timeout,
        };
        self.exact(&mut prefix[1..], deadline)?;
        let length = u32::from_be_bytes(prefix) as usize;
        if length == 0 || length > DEFAULT_MAX_FRAME_BYTES {
            return Err(io::Error::other("invalid frame length"));
        }
        let mut bytes = vec![0; length + 4];
        bytes
            .get_mut(..4)
            .ok_or_else(|| io::Error::other("frame prefix absent"))?
            .copy_from_slice(&prefix);
        self.exact(
            bytes
                .get_mut(4..)
                .ok_or_else(|| io::Error::other("frame payload absent"))?,
            deadline,
        )?;
        let frame = decode_frame(&bytes, DEFAULT_MAX_FRAME_BYTES).map_err(io::Error::other)?;
        if frame.payload.is_none() {
            return Err(io::Error::other("missing frame payload"));
        }
        Ok(Some(frame))
    }
    fn read_timeout(&self, deadline: Option<Instant>) -> io::Result<()> {
        let timeout = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
        if timeout.is_some_and(|remaining| remaining.is_zero()) {
            return Err(io::ErrorKind::TimedOut.into());
        }
        self.stream.set_read_timeout(timeout)
    }
    fn exact(&mut self, mut bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
        while !bytes.is_empty() {
            self.read_timeout(Some(deadline))?;
            match self.stream.read(bytes) {
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(size) => {
                    bytes = bytes
                        .get_mut(size..)
                        .ok_or_else(|| io::Error::other("invalid read count"))?;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "frame_reader.tests.rs"]
mod tests;
