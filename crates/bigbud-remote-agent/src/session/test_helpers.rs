use super::*;

pub(super) fn hello() -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "client-1".to_owned(),
            connection_id: "connection-1".to_owned(),
            server_nonce: "nonce".to_owned(),
            max_frame_bytes: 1024,
        })),
    }
}
