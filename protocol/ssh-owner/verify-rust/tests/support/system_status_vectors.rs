//! W7 remote system stats vectors (Request 180 / Reply 101): the request has
//! no operands and the reply carries only the owner recipe's sectioned text.

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    for (name, payload) in [
        (
            "sample_system_status",
            request(Operation::SampleSystemStatus(v1::SampleSystemStatus {})),
        ),
        (
            "system_status_sample",
            reply(Outcome::SystemStatusSample(v1::SystemStatusSample {
                sections: "###OS###\nLinux\n###CPU###\ncpu  1 0 1 8 0 0 0 0 0 0\n###END###\n"
                    .into(),
            })),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
