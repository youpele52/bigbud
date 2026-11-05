//! Fixed private-courier routing prelude. Never argv, environment or logs.
//! BEP1 | 16-byte leaf nonce | u32 parent PID | u8 birth length | 128 birth bytes.
//! The existing one-use 38-byte credential frame follows, then mandatory EOF.
use super::{
    directory::{effective_uid, endpoint_path},
    io::{invalid, remaining, retry, wait},
};
use crate::{
    owner::unix_peer::{ensure_private_fd, peer_credentials},
    worker::unix::inspect,
};
use std::{
    io::{self, Read},
    num::NonZeroU32,
    os::unix::net::UnixStream,
    time::Instant,
};

const SIZE: usize = 153;
pub(super) struct Route {
    pub(super) nonce: [u8; 16],
    pub(super) pid: NonZeroU32,
    pub(super) creation: String,
}
impl Route {
    pub(super) fn current(nonce: [u8; 16]) -> io::Result<Self> {
        let pid = NonZeroU32::new(std::process::id()).ok_or_else(invalid)?;
        Ok(Self {
            nonce,
            pid,
            creation: inspect(pid)?.creation,
        })
    }
    pub(super) fn encode(&self) -> io::Result<[u8; SIZE]> {
        if self.pid.get() <= 1
            || self.pid.get() > i32::MAX as u32
            || self.creation.len() > 128
            || !crate::guard::record::valid_id(&self.creation)
        {
            return Err(invalid());
        }
        let mut bytes = [0; SIZE];
        bytes[..4].copy_from_slice(b"BEP1");
        bytes[4..20].copy_from_slice(&self.nonce);
        bytes[20..24].copy_from_slice(&self.pid.get().to_be_bytes());
        bytes[24] = self.creation.len() as u8;
        bytes
            .get_mut(25..25 + self.creation.len())
            .ok_or_else(invalid)?
            .copy_from_slice(self.creation.as_bytes());
        Ok(bytes)
    }
    pub(super) fn read(mut courier: &UnixStream, deadline: Instant) -> io::Result<Self> {
        courier.set_nonblocking(true)?;
        let mut bytes = [0; SIZE];
        let mut rest = bytes.as_mut_slice();
        while !rest.is_empty() {
            remaining(deadline)?;
            match courier.read(rest) {
                Ok(0) => return Err(invalid()),
                Ok(count) => rest = rest.get_mut(count..).ok_or_else(invalid)?,
                Err(error) if retry(&error) => wait(courier, libc::POLLIN, deadline)?,
                Err(error) => return Err(error),
            }
        }
        remaining(deadline)?;
        Self::decode(&bytes)
    }
    fn decode(bytes: &[u8; SIZE]) -> io::Result<Self> {
        if bytes[..4] != *b"BEP1" {
            return Err(invalid());
        }
        let mut nonce = [0; 16];
        nonce.copy_from_slice(&bytes[4..20]);
        let pid = NonZeroU32::new(u32::from_be_bytes(
            bytes[20..24].try_into().map_err(|_| invalid())?,
        ))
        .ok_or_else(invalid)?;
        let size = bytes[24] as usize;
        let birth = bytes.get(25..25 + size).ok_or_else(invalid)?;
        if bytes
            .get(25 + size..)
            .ok_or_else(invalid)?
            .iter()
            .any(|byte| *byte != 0)
        {
            return Err(invalid());
        }
        let route = Self {
            nonce,
            pid,
            creation: std::str::from_utf8(birth).map_err(|_| invalid())?.into(),
        };
        route.encode()?;
        Ok(route)
    }
    pub(super) fn connect(&self, deadline: Instant) -> io::Result<UnixStream> {
        let stream = super::connect::connect(&endpoint_path(&self.nonce)?, deadline)?;
        self.verify_server(&stream, deadline)?;
        Ok(stream)
    }
    pub(super) fn verify_server(&self, stream: &UnixStream, deadline: Instant) -> io::Result<()> {
        remaining(deadline)?;
        ensure_private_fd(stream)?;
        let peer = peer_credentials(stream)?;
        if peer.uid != effective_uid()
            || peer.pid != self.pid
            || inspect(peer.pid)?.creation != self.creation
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unexpected bootstrap server",
            ));
        }
        remaining(deadline)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_route_has_no_path_or_identity_escape() {
        let route = Route::current([1; 16]).unwrap();
        let encoded = route.encode().unwrap();
        let decoded = Route::decode(&encoded).unwrap();
        assert_eq!(decoded.pid, route.pid);
        assert_eq!(decoded.creation, route.creation);
        for (offset, value) in [(0, 0), (24, 255), (152, 1)] {
            let mut bad = encoded;
            bad[offset] = value;
            assert!(Route::decode(&bad).is_err());
        }
    }
}
