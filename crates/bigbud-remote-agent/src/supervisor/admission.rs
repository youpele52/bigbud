use super::{Writer, frame_reader::HandshakePermit, writer::OutboundWriter};
use std::io;
use std::os::unix::net::UnixStream;

/// Four reserved existing-protocol control candidates stay independent of the
/// sixteen normal handshakes and sixty data writers. Candidates must complete
/// hello AND an existing shutdown request within one short absolute deadline;
/// they cannot turn into idle subscribers or consume normal work admission.
pub(super) fn admit(stream: &UnixStream) -> io::Result<(Writer, HandshakePermit)> {
    if let Ok(handshake) = HandshakePermit::reserve() {
        match OutboundWriter::start(stream.try_clone()?) {
            Ok(writer) => return Ok((writer, handshake)),
            Err(_) => drop(handshake),
        }
    }
    let handshake = HandshakePermit::control()?;
    let writer = OutboundWriter::start_with_kind(stream.try_clone()?, true)?;
    Ok((writer, handshake))
}
