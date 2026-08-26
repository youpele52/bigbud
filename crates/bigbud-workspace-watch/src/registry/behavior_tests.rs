use std::fs;
use std::time::{Duration, Instant};

use super::WorkspaceWatchRegistry;
use super::tests::{receive_event, temporary_workspace, workspace};
use crate::WorkspaceWatchBackend;

#[test]
fn atomic_replacement_and_delete_recreate_keep_exact_path_updates() {
    let root = temporary_workspace("replacement");
    let watched = root.join("watched.txt");
    fs::write(&watched, "first").unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |event| {
        let _ = sender.send(event);
    });
    registry.subscribe("preview", workspace(&root), "").unwrap();

    let replacement = root.join("watched.next");
    fs::write(&replacement, "other").unwrap();
    #[cfg(target_os = "windows")]
    fs::remove_file(&watched).unwrap();
    fs::rename(&replacement, &watched).unwrap();
    receive_event(&receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "watched.txt")
    });

    fs::remove_file(&watched).unwrap();
    receive_event(&receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "watched.txt")
    });
    fs::write(&watched, "again").unwrap();
    receive_event(&receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "watched.txt")
    });

    registry.unsubscribe("preview");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rapid_subscribe_unsubscribe_churn_releases_every_manager() {
    let root = temporary_workspace("churn");
    let workspace = workspace(&root);
    let registry = WorkspaceWatchRegistry::new(|_| {});

    for index in 0..100 {
        let subscription_id = format!("subscription-{index}");
        registry
            .subscribe(&subscription_id, workspace.clone(), "")
            .unwrap();
        assert!(registry.unsubscribe(&subscription_id));
    }

    assert_eq!(registry.counts(), (0, 0));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn native_event_delivery_p95_stays_below_the_preview_budget() {
    let root = temporary_workspace("latency");
    let watched = root.join("watched.txt");
    fs::write(&watched, "000000").unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |event| {
        let _ = sender.send(event);
    });
    let started = registry.subscribe("preview", workspace(&root), "").unwrap();
    if started.backend != WorkspaceWatchBackend::Native {
        registry.unsubscribe("preview");
        let _ = fs::remove_dir_all(root);
        return;
    }

    let mut samples = Vec::new();
    for index in 1..=12 {
        let before = Instant::now();
        fs::write(&watched, format!("{index:06}")).unwrap();
        receive_event(&receiver, |event| {
            event
                .changes
                .iter()
                .any(|change| change.path == "watched.txt")
        });
        samples.push(before.elapsed());
    }
    samples.sort_unstable();
    let p95 = samples[(samples.len() * 95).div_ceil(100) - 1];
    assert!(
        p95 < Duration::from_millis(500),
        "native event delivery p95 exceeded the 500 ms preview budget: {p95:?}"
    );

    registry.unsubscribe("preview");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn exact_delivery_continues_after_a_long_idle_pause() {
    let root = temporary_workspace("idle-pause");
    let (sender, receiver) = std::sync::mpsc::channel();
    let registry = WorkspaceWatchRegistry::new(move |event| {
        let _ = sender.send(event);
    });
    registry.subscribe("root", workspace(&root), "").unwrap();

    std::thread::sleep(Duration::from_secs(2));
    fs::write(root.join("after-pause.txt"), "awake").unwrap();
    receive_event(&receiver, |event| {
        event
            .changes
            .iter()
            .any(|change| change.path == "after-pause.txt")
    });

    registry.unsubscribe("root");
    let _ = fs::remove_dir_all(root);
}
