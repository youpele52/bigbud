use notify::{
    EventKind,
    event::{AccessKind, CreateKind},
};

use super::tracks_event;

#[test]
fn ignores_access_only_notifications() {
    assert!(!tracks_event(&EventKind::Access(AccessKind::Read)));
}

#[test]
fn retains_content_change_notifications() {
    assert!(tracks_event(&EventKind::Create(CreateKind::File)));
    assert!(tracks_event(&EventKind::Any));
}
