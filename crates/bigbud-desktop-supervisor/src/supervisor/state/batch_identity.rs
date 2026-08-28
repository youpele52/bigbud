use prost::Message;
use sha2::{Digest, Sha256};

use crate::v1;

#[derive(Debug)]
pub(super) struct BatchIdentity {
    pub(super) id: String,
    pub(super) digest: [u8; 32],
    pub(super) acknowledged_sequence: u64,
}

pub(super) fn digest(batch: &v1::EventBatch) -> [u8; 32] {
    Sha256::digest(batch.encode_to_vec()).into()
}

pub(crate) fn expected_id(batch: &v1::EventBatch) -> String {
    let mut identity = batch.clone();
    identity.batch_id.clear();
    format!("{:x}", Sha256::digest(identity.encode_to_vec()))
}
