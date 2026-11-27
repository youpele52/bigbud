//! Drain-time owner shutdown (Request 194) at the owner boundary, without SSH.

use super::*;
use crate::{
    owner::{Pipe, terminal::production_tests::support::Fixture},
    owner_pipe::encode_payload,
    v1::{OwnerShutdown, Request, frame::Payload, request::Operation},
};
use bigbud_ssh_owner::framing::Endpoint;
use std::{fs, os::unix::fs::DirBuilderExt};

fn shutdown_request(owner: &Owner, id: u8) -> Request {
    Request {
        request_id: vec![id],
        owner_epoch: owner.epoch.to_vec(),
        operation: Some(Operation::OwnerShutdown(OwnerShutdown {})),
        ..Request::default()
    }
}

#[test]
fn shutdown_clears_the_attach_record_reports_counts_and_closes_admission() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    let record = fixture.root.join("ssh-owner").join(ATTACH_RECORD);
    fs::write(&record, b"{}").unwrap();
    // One resolved target with no live master or lease: the counts are real zeros.
    fixture.bind(&mut owner, "ssh:host=a", 22222);
    owner.leave_target();
    let Ok(Outcome::OwnerShutdown(report)) = owner.shutdown_for_drain() else {
        panic!("expected an owner shutdown report");
    };
    assert_eq!(report.masters_closed, 0);
    assert_eq!(report.leases_closed, 0);
    assert!(report.attach_cleared);
    assert!(!record.exists());
    assert!(owner.shutdown_requested);
    assert_eq!(owner.admission_error, ErrorCode::OwnerUnavailable);
}

#[test]
fn a_fixture_owner_has_no_drain_shutdown() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    owner.production = false;
    assert_eq!(
        owner.shutdown_for_drain().err(),
        Some(ErrorCode::OperationDenied)
    );
    assert!(!owner.shutdown_requested);
}

#[test]
fn the_owner_wide_verb_is_granted_answered_and_ends_the_session() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner(None);
    let mut request = shutdown_request(&owner, 7);
    let issued = owner.issue(request.clone());
    assert_eq!(issued.error, ErrorCode::Unspecified as i32);
    request.grant = issued.grant;
    // The session must stop after the shutdown reply: a second frame that would
    // otherwise be read stays unread.
    let mut input = Vec::new();
    for frame in [request, shutdown_request(&owner, 8)] {
        Endpoint::Client
            .write_frame(&mut input, &encode_payload(Payload::Request(frame)))
            .unwrap();
    }
    let mut output = Vec::new();
    let mut reader = input.as_slice();
    owner
        .serve_session(&mut Pipe::new(&mut reader, &mut output), |_| Ok(()))
        .unwrap();
    assert!(owner.shutdown_requested);
    assert!(
        !reader.is_empty(),
        "the session read past the shutdown reply"
    );
    assert!(!output.is_empty());
}

#[test]
fn the_attach_record_is_removed_only_when_it_is_a_regular_file() {
    let fixture = Fixture::new();
    let directory = fixture.root.join("records");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    assert!(
        remove_attach_record(&directory).is_ok(),
        "missing is cleared"
    );
    fs::DirBuilder::new()
        .mode(0o700)
        .create(directory.join(ATTACH_RECORD))
        .unwrap();
    assert!(remove_attach_record(&directory).is_err());
    assert!(directory.join(ATTACH_RECORD).is_dir());
}
