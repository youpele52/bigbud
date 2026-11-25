use super::{reply, v1};
use v1::{Connection, ConnectionState, Hello, frame::Payload, reply::Outcome};

pub(super) fn hello(major: u32) -> Payload {
    Payload::Hello(Hello {
        major,
        minor: 0,
        profile_binding: vec![0, 0x61, 0xff],
        proof_attachment_capability: Vec::new(),
    })
}

pub(super) fn connection(state: ConnectionState) -> Payload {
    reply(Outcome::Connection(Connection {
        state: state.into(),
    }))
}
