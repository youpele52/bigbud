//! U15 production Git upload lease vectors (Request 77–79, Reply 50), then
//! the receive lease vectors.

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

#[path = "git_receive_vectors.rs"]
mod git_receive_vectors;

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    git_receive_vectors::verify(values);
    let lease = vec![93; 32];
    assert_frame(
        values,
        "git_upload_open",
        request(Operation::GitUploadOpen(v1::GitUploadOpen {
            lease: lease.clone(),
            workspace_root: "/srv/work".into(),
            repository_path: "/srv/work/repo.git".into(),
        })),
    );
    assert_frame(
        values,
        "git_upload_status",
        request(Operation::GitUploadStatus(v1::GitUploadLease {
            lease: lease.clone(),
        })),
    );
    assert_frame(
        values,
        "git_upload_close",
        request(Operation::GitUploadClose(v1::GitUploadLease {
            lease: lease.clone(),
        })),
    );
    assert_frame(
        values,
        "git_upload_listening",
        reply(Outcome::GitUpload(v1::GitUploadState {
            lease: lease.clone(),
            phase: v1::GitUploadPhase::Listening.into(),
            socket_path: Some("/tmp/bigbud-oc1-0123456789abcdef/s".into()),
            exit_code: None,
        })),
    );
    assert_frame(
        values,
        "git_upload_exited",
        reply(Outcome::GitUpload(v1::GitUploadState {
            lease,
            phase: v1::GitUploadPhase::Exited.into(),
            socket_path: None,
            exit_code: Some(0),
        })),
    );
}
