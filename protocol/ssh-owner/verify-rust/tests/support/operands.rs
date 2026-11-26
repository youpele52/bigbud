use prost::Message;

use crate::v1::{Request, request::Operation};

pub fn operand_preimage(mut operation: Operation) -> Vec<u8> {
    if let Operation::ListFolders(operand) = &mut operation
        && operand.path.as_deref() == Some("")
    {
        operand.path = None;
    }
    let mut preimage = b"bigbud.ssh_owner.v1/operands\0".to_vec();
    // Only encode the oneof from a fresh message, never the envelope or raw input bytes.
    Request {
        target_descriptor: None,
        operation: Some(operation),
        ..Request::default()
    }
    .encode(&mut preimage)
    .expect("encoding into an owned Vec is infallible");
    preimage
}
