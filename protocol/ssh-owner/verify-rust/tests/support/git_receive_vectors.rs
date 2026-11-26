//! U15 production Git receive lease vectors (Request 110–112, Reply 66).

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let lease = vec![94; 32];
    assert_frame(
        values,
        "git_receive_open",
        request(Operation::GitReceiveOpen(v1::GitReceiveOpen {
            lease: lease.clone(),
            workspace_root: "/srv/work".into(),
            repository_path: "/srv/work/repo.git".into(),
            destination_ref: "refs/heads/main".into(),
            expected_old_oid: "a".repeat(40),
            source_oid: "b".repeat(40),
        })),
    );
    for (name, operation) in [
        (
            "git_receive_status",
            Operation::GitReceiveStatus(v1::GitReceiveLease {
                lease: lease.clone(),
            }),
        ),
        (
            "git_receive_close",
            Operation::GitReceiveClose(v1::GitReceiveLease {
                lease: lease.clone(),
            }),
        ),
    ] {
        assert_frame(values, name, request(operation));
    }
    assert_frame(
        values,
        "git_receive_listening",
        reply(Outcome::GitReceive(v1::GitReceiveState {
            lease: lease.clone(),
            phase: v1::GitReceivePhase::Listening.into(),
            socket_path: Some("/tmp/bigbud-oc1-0123456789abcdef/s".into()),
            receipt: v1::GitReceiveReceipt::Unspecified.into(),
        })),
    );
    for (name, receipt) in [
        ("git_receive_accepted", v1::GitReceiveReceipt::Accepted),
        ("git_receive_stale", v1::GitReceiveReceipt::Stale),
    ] {
        assert_frame(
            values,
            name,
            reply(Outcome::GitReceive(v1::GitReceiveState {
                lease: lease.clone(),
                phase: v1::GitReceivePhase::Finished.into(),
                socket_path: None,
                receipt: receipt.into(),
            })),
        );
    }
}
