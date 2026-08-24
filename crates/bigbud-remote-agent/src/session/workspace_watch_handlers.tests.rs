use bigbud_protocol::v1;
use bigbud_workspace_watch::{
    WorkspaceChange, WorkspaceChangeKind, WorkspaceRescanReason, WorkspaceWatchBackend,
    WorkspaceWatchEvent,
};

use super::workspace_watch_event_frame;

#[test]
fn maps_domain_changes_to_the_existing_protocol_frame() {
    let frame = workspace_watch_event_frame(WorkspaceWatchEvent {
        subscription_id: "watch-1".to_owned(),
        generation: 4,
        sequence: 2,
        changes: vec![WorkspaceChange {
            path: "docs/README.md".to_owned(),
            kind: WorkspaceChangeKind::Modify,
        }],
        rescan_reason: None,
        backend: WorkspaceWatchBackend::Native,
    });

    let Some(v1::frame::Payload::WorkspaceWatchEvent(event)) = frame.payload else {
        panic!("expected a workspace watch event");
    };
    assert_eq!(event.subscription_id, "watch-1");
    assert_eq!(event.generation, 4);
    assert_eq!(event.sequence, 2);
    assert_eq!(event.changes[0].path, "docs/README.md");
    assert_eq!(event.changes[0].kind, "modify");
    assert!(!event.rescan_required);
    assert_eq!(event.backend, "native");
}

#[test]
fn maps_domain_rescans_to_the_existing_protocol_frame() {
    let frame = workspace_watch_event_frame(WorkspaceWatchEvent {
        subscription_id: "watch-1".to_owned(),
        generation: 5,
        sequence: 1,
        changes: Vec::new(),
        rescan_reason: Some(WorkspaceRescanReason::Overflow),
        backend: WorkspaceWatchBackend::Poll,
    });

    let Some(v1::frame::Payload::WorkspaceWatchEvent(event)) = frame.payload else {
        panic!("expected a workspace watch event");
    };
    assert!(event.rescan_required);
    assert_eq!(event.rescan_reason, "overflow");
    assert_eq!(event.backend, "poll");
}
