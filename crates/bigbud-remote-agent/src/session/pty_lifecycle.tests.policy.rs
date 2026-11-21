//! Idle close under the clock hook, unmanaged PTYs untouched, orphan modes and notice replay
//! (plan §8.5, §8.7, §14; R5 exit criteria).

use super::super::super::pty_lifecycle_host::kind;
use super::super::super::*;
use super::fixture::Host;

#[test]
fn idle_close_warns_then_closes_only_managed_hidden_quiet_ptys() {
    let mut host = Host::new(false);
    let effective = host.policy(true, 24, 0);
    assert_eq!(
        (effective.idle_close_ms, effective.idle_warning_ms),
        (60_000, 30_000)
    );
    host.create(host.request("managed", true, "/bin/sh", &[]));
    host.create(host.request("unmanaged", false, "/bin/sh", &[]));
    host.wait_output("managed");
    host.wait_output("unmanaged");
    // Output (the prompt) happened at the fake time `t0`.
    let t0 = host.clock.advance(0);
    assert!(host.tick().is_empty());
    host.clock.set(t0 + 29_000);
    host.tick();
    assert!(!host.has_notice("managed", kind::IDLE_WARNING));
    host.clock.set(t0 + 30_000);
    host.tick();
    assert!(host.has_notice("managed", kind::IDLE_WARNING));
    // Keep open starts a new quiet period and clears the warning.
    host.lifecycle("managed").keep_open();
    host.tick();
    assert!(host.has_notice("managed", kind::IDLE_WARNING_CLEARED));
    host.clock.set(t0 + 60_000);
    assert!(host.tick().is_empty());
    let warnings = host
        .notices()
        .iter()
        .filter(|(pty, k)| pty == "managed" && k == kind::IDLE_WARNING)
        .count();
    assert_eq!(warnings, 2, "a new quiet period warns again");
    host.clock.set(t0 + 90_000);
    let closed = host.tick();
    assert_eq!(closed, vec!["managed".to_owned()]);
    assert!(host.wait_notice("managed", kind::IDLE_CLOSED));
    assert!(!host.lifecycle("managed").handle().is_running());
    // The unmanaged PTY never got a warning or a close, however long it stayed quiet.
    host.clock.set(t0 + 10 * 60 * 60 * 1000);
    host.tick();
    host.tick();
    assert!(host.notices().iter().all(|(pty, _)| pty != "unmanaged"));
    assert!(host.lifecycle("unmanaged").handle().is_running());
}

#[test]
fn a_foreground_program_blocks_warning_and_close_and_reports_busy() {
    let mut host = Host::new(false);
    host.policy(true, 24, 0);
    // The PTY's direct child is not a shell: busy for as long as it lives.
    host.create(host.request("program", true, "/bin/sleep", &["30"]));
    let t0 = host.clock.advance(0);
    host.tick();
    for minutes in 1..=30 {
        host.clock.set(t0 + minutes * 60_000);
        host.tick();
    }
    assert!(host.notices().iter().all(|(pty, _)| pty != "program"));
    assert!(host.lifecycle("program").handle().is_running());
    let program = host.id("program");
    let activity = host.frames.lock().unwrap().iter().any(|frame| {
        matches!(&frame.payload, Some(v1::frame::Payload::PtyActivity(activity))
            if activity.pty_id == program && activity.idle_busy
                && activity.reasons.iter().any(|reason| reason == "foreground_program"))
    });
    assert!(activity, "PtyActivity reports the foreground program");
}

#[test]
fn lifecycle_off_closes_nothing() {
    let mut host = Host::new(false);
    host.create(host.request("quiet", true, "/bin/sh", &[]));
    host.wait_output("quiet");
    let t0 = host.clock.advance(0);
    host.clock.set(t0 + 60 * 60 * 1000);
    host.tick();
    host.tick();
    assert!(host.notices().is_empty());
    assert!(host.lifecycle("quiet").handle().is_running());
}

#[test]
fn orphan_closes_managed_ptys_in_default_mode_and_never_in_keep_mode() {
    for (orphan_ms, expect_closed) in [(60_000, true), (0, false)] {
        let mut host = Host::new(false);
        host.policy(true, 24, orphan_ms);
        host.create(host.request("managed", true, "/bin/sleep", &["30"]));
        host.create(host.request("unmanaged", false, "/bin/sleep", &["30"]));
        host.host.owner_connected();
        let t0 = host.clock.advance(0);
        host.clock.set(t0 + 10 * 60_000);
        host.tick();
        assert!(host.notices().is_empty(), "an owner is connected");
        host.host.owner_disconnected();
        let t1 = host.clock.advance(0);
        host.clock.set(t1 + 59_000);
        host.tick();
        assert!(!host.has_notice("managed", kind::ORPHAN_CLOSED));
        host.clock.set(t1 + 60_000);
        let closed = host.tick();
        assert_eq!(closed.contains(&"managed".to_owned()), expect_closed);
        if expect_closed {
            assert!(host.wait_notice("managed", kind::ORPHAN_CLOSED));
        } else {
            assert!(!host.has_notice("managed", kind::ORPHAN_CLOSED));
        }
        assert!(host.lifecycle("unmanaged").handle().is_running());
    }
}

#[test]
fn notices_replay_after_an_id_and_report_a_gap_past_the_ring() {
    let host = Host::new(false);
    for index in 0..70 {
        host.host
            .notice(&format!("pty-{index}"), kind::IDLE_WARNING, 1);
    }
    let epoch = host.session.lock().unwrap().agent_epoch.clone();
    let replay = host.host.replay_notices(v1::HostNoticeReplayRequest {
        request_id: "r".to_owned(),
        expected_epoch: epoch.clone(),
        after_notice_id: 60,
    });
    assert!(replay.accepted && !replay.gap);
    assert_eq!(
        replay
            .notices
            .iter()
            .map(|n| n.notice_id)
            .collect::<Vec<_>>(),
        (61..=70).collect::<Vec<_>>()
    );
    let replay = host.host.replay_notices(v1::HostNoticeReplayRequest {
        request_id: "r".to_owned(),
        expected_epoch: epoch,
        after_notice_id: 0,
    });
    assert!(
        replay.gap,
        "notices 1-6 were evicted from the 64-entry ring"
    );
    assert_eq!(replay.notices.len(), 64);
    let wrong = host.host.replay_notices(v1::HostNoticeReplayRequest {
        request_id: "r".to_owned(),
        expected_epoch: "another".to_owned(),
        after_notice_id: 0,
    });
    assert!(!wrong.accepted);
}

#[test]
fn policy_updates_clamp_and_the_latest_revision_wins() {
    let host = Host::new(false);
    let effective = host.host.apply_policy(Some(&v1::HostPolicy {
        lifecycle_enabled: true,
        idle_close_ms: 1_000,
        idle_warning_ms: 59_000,
        max_live_ptys: 99,
        orphan_close_ms: 5,
        revision: 7,
        ..Default::default()
    }));
    assert_eq!(effective.idle_close_ms, 60_000);
    assert_eq!(effective.idle_warning_ms, 30_000);
    assert_eq!(effective.max_live_ptys, 40);
    assert_eq!(effective.orphan_close_ms, 60_000);
    let stale = host.host.apply_policy(Some(&v1::HostPolicy {
        lifecycle_enabled: false,
        revision: 6,
        ..Default::default()
    }));
    assert!(stale.lifecycle_enabled && stale.revision == 7);
}
