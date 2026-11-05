use bigbud_protocol::v1;
use prost::Message;

#[test]
fn retired_terminal_payloads_are_unknown_not_dispatched() {
    for tag in [0xd2, 0xda] {
        let bytes = [tag, 0x03, 0x00];
        assert!(matches!(
            v1::Frame::decode(bytes.as_slice()),
            Ok(frame) if frame.payload.is_none()
        ));
    }
}
