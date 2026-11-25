use std::io;
#[cfg(unix)]
use std::io::{Read, Write};

#[cfg(unix)]
use bigbud_ssh_owner::framing::Endpoint;
use prost::Message;

use crate::{
    RunResult,
    v1::{Frame, frame::Payload},
};

pub(super) fn protocol_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid S1 owner protocol message",
    )
}

// A payload channel has already established its transport identity and framing.
// Storage exchanges must use bounded reads on transports with deadlines.
pub(super) trait PayloadPipe {
    fn recv(&mut self) -> RunResult<Option<Payload>>;
    fn send(&mut self, payload: Payload) -> RunResult<()>;
}

pub(super) fn decode_payload(bytes: &[u8]) -> RunResult<Payload> {
    Ok(Frame::decode(bytes)?.payload.ok_or_else(protocol_error)?)
}

pub(super) fn encode_payload(payload: Payload) -> Vec<u8> {
    Frame {
        payload: Some(payload),
    }
    .encode_to_vec()
}

#[cfg(unix)]
pub(super) struct Pipe<R, W> {
    input: R,
    output: W,
}

#[cfg(unix)]
impl<R: Read, W: Write> Pipe<R, W> {
    pub(super) fn new(input: R, output: W) -> Self {
        Self { input, output }
    }

    pub(super) fn recv(&mut self) -> RunResult<Option<Payload>> {
        PayloadPipe::recv(self)
    }

    pub(super) fn send(&mut self, payload: Payload) -> RunResult<()> {
        PayloadPipe::send(self, payload)
    }
}

#[cfg(unix)]
impl<R: Read, W: Write> PayloadPipe for Pipe<R, W> {
    fn recv(&mut self) -> RunResult<Option<Payload>> {
        Endpoint::Owner
            .read_frame(&mut self.input)?
            .as_deref()
            .map(decode_payload)
            .transpose()
    }

    fn send(&mut self, payload: Payload) -> RunResult<()> {
        Endpoint::Owner.write_frame(&mut self.output, &encode_payload(payload))?;
        self.output.flush()?;
        Ok(())
    }
}
