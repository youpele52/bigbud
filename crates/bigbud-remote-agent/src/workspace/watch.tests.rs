use std::collections::HashMap;
use std::fs;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bigbud_protocol::v1;

use notify::{Event, EventKind};

use super::backend::WatchBackend;
use super::events::{reconcile_events, snapshot};
use super::{
    Interest, MAX_WORKSPACE_SUBSCRIPTIONS, ManagerCommand, WorkspaceRoot, WorkspaceWatchError,
    WorkspaceWatchRegistry,
};

fn temporary_workspace(name: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-watch-{name}-{suffix}"));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn shares_one_manager_for_subscriptions_in_the_same_workspace() {
    let root = temporary_workspace("shared");
    fs::create_dir(root.join("docs")).unwrap();
    let workspace = WorkspaceRoot::open(&root).unwrap();
    let registry = WorkspaceWatchRegistry::new(|_, _| {});

    registry.subscribe("root", workspace.clone(), "").unwrap();
    registry
        .subscribe("docs", workspace.clone(), "docs")
        .unwrap();
    assert_eq!(registry.counts(), (1, 2));

    assert!(registry.unsubscribe("root"));
    assert_eq!(registry.counts(), (1, 1));
    assert!(registry.unsubscribe("docs"));
    assert_eq!(registry.counts(), (0, 0));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_subscriptions_beyond_the_workspace_limit_without_spawning_another_manager() {
    let root = temporary_workspace("limit");
    let workspace = WorkspaceRoot::open(&root).unwrap();
    let registry = WorkspaceWatchRegistry::new(|_, _| {});
    let subscription_ids = (0..MAX_WORKSPACE_SUBSCRIPTIONS)
        .map(|index| format!("watch-{index}"))
        .collect::<Vec<_>>();
    for subscription_id in &subscription_ids {
        registry
            .subscribe(subscription_id, workspace.clone(), "")
            .unwrap();
    }

    let error = registry
        .subscribe("over-limit", workspace, "")
        .expect_err("the workspace limit must be enforced");
    assert!(matches!(error, WorkspaceWatchError::ResourceLimit));
    assert_eq!(error.code(), "RESOURCE_LIMIT");
    assert_eq!(registry.counts(), (1, MAX_WORKSPACE_SUBSCRIPTIONS));

    for subscription_id in subscription_ids {
        registry.unsubscribe(&subscription_id);
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn emits_the_exact_changed_path_after_the_baseline_is_ready() {
    let root = temporary_workspace("event");
    fs::write(root.join("watched.txt"), "first").unwrap();
    let workspace = WorkspaceRoot::open(&root).unwrap();
    let (sender, receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |subscription_id, frame| {
        let _ = sender.send((subscription_id.to_owned(), frame));
    });

    let started = registry.subscribe("preview", workspace, "").unwrap();
    assert!(started.generation > 0);
    fs::write(root.join("watched.txt"), "other").unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut matched = false;
    while std::time::Instant::now() < deadline {
        let Ok((subscription_id, frame)) = receiver.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        let Some(v1::frame::Payload::WorkspaceWatchEvent(event)) = frame.payload else {
            continue;
        };
        if subscription_id == "preview"
            && event
                .changes
                .iter()
                .any(|change| change.path == "watched.txt")
        {
            matched = true;
            assert!(event.sequence > 0);
            break;
        }
    }
    assert!(matched, "expected a precise watched.txt change event");

    registry.unsubscribe("preview");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn restores_a_watch_after_the_directory_is_recreated() {
    let root = temporary_workspace("restore");
    fs::create_dir(root.join("docs")).unwrap();
    let workspace = WorkspaceRoot::open(&root).unwrap();
    let (sender, receiver) = mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |subscription_id, frame| {
        let _ = sender.send((subscription_id.to_owned(), frame));
    });

    registry.subscribe("root", workspace.clone(), "").unwrap();
    registry.subscribe("docs", workspace, "docs").unwrap();
    fs::remove_dir(root.join("docs")).unwrap();

    let invalidated_generation = receive_event(&receiver, |subscription_id, event| {
        subscription_id == "docs" && event.rescan_required
    })
    .generation;
    fs::create_dir(root.join("docs")).unwrap();
    let restored = receive_event(&receiver, |subscription_id, event| {
        subscription_id == "docs"
            && event.rescan_required
            && event.generation > invalidated_generation
    });
    assert!(restored.generation > invalidated_generation);

    fs::write(root.join("docs/recreated.txt"), "ready").unwrap();
    receive_event(&receiver, |subscription_id, event| {
        subscription_id == "docs"
            && event
                .changes
                .iter()
                .any(|change| change.path == "docs/recreated.txt")
    });

    registry.unsubscribe("docs");
    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn requests_a_rescan_for_an_ambiguous_directory_level_event() {
    let root = temporary_workspace("ambiguous");
    fs::create_dir(root.join("docs")).unwrap();
    fs::write(root.join("docs/watched.txt"), "first").unwrap();
    let workspace = WorkspaceRoot::open(&root).unwrap();
    let (sender, receiver) = mpsc::channel();
    let sink: super::EventSink =
        std::sync::Arc::new(move |subscription_id: &str, frame: v1::Frame| {
            let _ = sender.send((subscription_id.to_owned(), frame));
        });
    let mut interests = HashMap::from([(
        "docs".to_owned(),
        Interest {
            relative_path: "docs".to_owned(),
            absolute_path: workspace.root().join("docs"),
            snapshot: snapshot(&workspace, "docs").unwrap(),
            sequence: 0,
            invalidated: false,
        },
    )]);

    let invalidated = reconcile_events(
        &workspace,
        &sink,
        &mut interests,
        1,
        vec![Event::new(EventKind::Any).add_path(workspace.root().join("docs"))],
    );
    assert!(invalidated.is_empty());
    let event = receive_event(&receiver, |subscription_id, event| {
        subscription_id == "docs" && event.rescan_required
    });
    assert_eq!(event.rescan_reason, "watchInvalidated");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn polling_backend_detects_file_content_changes() {
    let root = temporary_workspace("poll");
    let workspace = WorkspaceRoot::open(&root).unwrap();
    let (sender, receiver) = mpsc::sync_channel(16);
    let mut backend = WatchBackend::poll(sender).unwrap();
    backend.watch(workspace.root(), &[]).unwrap();
    fs::write(root.join("polled.txt"), "ready").unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut detected = false;
    while std::time::Instant::now() < deadline {
        let Ok(command) = receiver.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        if let ManagerCommand::FileSystem(Ok(event)) = command
            && event.paths.iter().any(|path| path.ends_with("polled.txt"))
        {
            detected = true;
            break;
        }
    }
    assert!(detected, "expected polling to detect polled.txt");

    let _ = fs::remove_dir_all(root);
}

fn receive_event(
    receiver: &mpsc::Receiver<(String, v1::Frame)>,
    matches: impl Fn(&str, &v1::WorkspaceWatchEvent) -> bool,
) -> v1::WorkspaceWatchEvent {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let Ok((subscription_id, frame)) = receiver.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        let Some(v1::frame::Payload::WorkspaceWatchEvent(event)) = frame.payload else {
            continue;
        };
        if matches(&subscription_id, &event) {
            return event;
        }
    }
    panic!("expected matching workspace watch event");
}
