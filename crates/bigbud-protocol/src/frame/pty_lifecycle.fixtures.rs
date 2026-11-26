//! Shared-golden fixtures for protocol 1.9 lifecycle frames.

use crate::pty_lifecycle::{PTY_LIMIT_REACHED, SNAPSHOT_BUSY};
use crate::{PROTOCOL_MINOR, v1};
use v1::frame::Payload;

pub(super) fn frame(payload: Payload) -> v1::Frame {
    v1::Frame {
        payload: Some(payload),
    }
}

fn policy(revision: u64) -> v1::HostPolicy {
    v1::HostPolicy {
        lifecycle_enabled: true,
        idle_close_ms: 600_000,
        idle_warning_ms: 60_000,
        max_live_ptys: 24,
        orphan_close_ms: 0,
        memory_pressure_enabled: true,
        memory_available_low_percent: 8,
        memory_available_critical_percent: 4,
        host_rss_low_bytes: 512 * 1024 * 1024,
        host_rss_critical_bytes: 768 * 1024 * 1024,
        terminal_rss_low_percent: 50,
        terminal_rss_critical_percent: 70,
        revision,
    }
}

fn notice(notice_id: u64, kind: &str) -> v1::PtyLifecycleNotice {
    v1::PtyLifecycleNotice {
        notice_id,
        pty_id: "pty-1".to_owned(),
        kind: kind.to_owned(),
        closes_at_ms: if kind == "idle_warning" {
            1_700_000_600_000
        } else {
            0
        },
        occurred_at_ms: 1_700_000_540_000,
    }
}

pub(super) fn small_frames() -> Vec<(&'static str, v1::Frame)> {
    vec![
        (
            "pty_screen_snapshot_request",
            frame(Payload::PtyScreenSnapshotRequest(
                v1::PtyScreenSnapshotRequest {
                    request_id: "snap-1".to_owned(),
                    pty_id: "pty-1".to_owned(),
                    max_ansi_units: 1_048_576,
                    max_utf8_bytes: 3 * 1024 * 1024,
                    max_scrollback_rows: 1_000,
                    attach_renderer: true,
                },
            )),
        ),
        (
            "pty_screen_snapshot_header_busy",
            frame(Payload::PtyScreenSnapshotHeader(Box::new(
                v1::PtyScreenSnapshotHeader {
                    request_id: "snap-1".to_owned(),
                    pty_id: "pty-1".to_owned(),
                    error_code: SNAPSHOT_BUSY.to_owned(),
                    ..Default::default()
                },
            ))),
        ),
        (
            "pty_screen_snapshot_chunk",
            frame(Payload::PtyScreenSnapshotChunk(
                v1::PtyScreenSnapshotChunk {
                    request_id: "snap-1".to_owned(),
                    index: 1,
                    last: true,
                    bytes: b"\x1b[0m$ ".to_vec(),
                },
            )),
        ),
        (
            "pty_activity",
            frame(Payload::PtyActivity(v1::PtyActivity {
                pty_id: "pty-1".to_owned(),
                idle_busy: true,
                pressure_busy: true,
                sidebar_busy: false,
                reasons: vec!["foreground_program".to_owned(), String::new()],
                last_input_ms: 1_700_000_000_000,
                last_output_ms: 1_700_000_001_000,
                quiet_since_ms: 1_700_000_001_000,
            })),
        ),
        (
            "pty_lifecycle_notice",
            frame(Payload::PtyLifecycleNotice(notice(7, "idle_warning"))),
        ),
        (
            "host_policy_update_request",
            frame(Payload::HostPolicyUpdateRequest(Box::new(
                v1::HostPolicyUpdateRequest {
                    request_id: "policy-1".to_owned(),
                    policy: Some(policy(3)),
                },
            ))),
        ),
        (
            "host_policy_update_response",
            frame(Payload::HostPolicyUpdateResponse(Box::new(
                v1::HostPolicyUpdateResponse {
                    request_id: "policy-1".to_owned(),
                    accepted: true,
                    effective: Some(policy(3)),
                    ..Default::default()
                },
            ))),
        ),
        (
            "pty_view_state_request",
            frame(Payload::PtyViewStateRequest(Box::new(
                v1::PtyViewStateRequest {
                    request_id: "view-1".to_owned(),
                    pty_id: "pty-1".to_owned(),
                    view_state: "hidden".to_owned(),
                    renderer_attached: false,
                    owner_busy_hint: "unknown".to_owned(),
                    theme_fg: "#d4d4d4".to_owned(),
                    theme_bg: "#1e1e1e".to_owned(),
                    acked_sequence: 42,
                },
            ))),
        ),
        (
            "pty_view_state_response",
            frame(Payload::PtyViewStateResponse(Box::new(
                v1::PtyViewStateResponse {
                    request_id: "view-1".to_owned(),
                    pty_id: "pty-1".to_owned(),
                    accepted: true,
                    ..Default::default()
                },
            ))),
        ),
        (
            "pty_keep_open_request",
            frame(Payload::PtyKeepOpenRequest(v1::PtyKeepOpenRequest {
                request_id: "keep-1".to_owned(),
                pty_id: "pty-1".to_owned(),
            })),
        ),
        (
            "pty_keep_open_response",
            frame(Payload::PtyKeepOpenResponse(Box::new(
                v1::PtyKeepOpenResponse {
                    request_id: "keep-1".to_owned(),
                    pty_id: "pty-1".to_owned(),
                    error_code: "PTY_NOT_FOUND".to_owned(),
                    error_message: "unknown PTY".to_owned(),
                    ..Default::default()
                },
            ))),
        ),
        (
            "pty_close_all_request",
            frame(Payload::PtyCloseAllRequest(v1::PtyCloseAllRequest {
                request_id: "close-all-1".to_owned(),
                reason: "update".to_owned(),
                managed_only: true,
            })),
        ),
        (
            "pty_close_all_response",
            frame(Payload::PtyCloseAllResponse(Box::new(
                v1::PtyCloseAllResponse {
                    request_id: "close-all-1".to_owned(),
                    accepted: true,
                    closed_count: 5,
                    ..Default::default()
                },
            ))),
        ),
        (
            "host_resource_report",
            frame(Payload::HostResourceReport(Box::new(
                v1::HostResourceReport {
                    sampled_at_ms: 1_700_000_000_000,
                    memory_level: "low".to_owned(),
                    memory_available_bytes: 1 << 30,
                    memory_total_bytes: 16 << 30,
                    host_rss_bytes: 96 << 20,
                    terminal_rss_bytes: 3 << 30,
                    screen_model_bytes: 40 << 20,
                    spool_bytes: 200 << 20,
                    live_ptys: 12,
                    managed_live_ptys: 10,
                    max_live_ptys: 24,
                },
            ))),
        ),
        (
            "host_notice_replay_request",
            frame(Payload::HostNoticeReplayRequest(
                v1::HostNoticeReplayRequest {
                    request_id: "replay-1".to_owned(),
                    expected_epoch: "epoch-1".to_owned(),
                    after_notice_id: 6,
                },
            )),
        ),
        (
            "host_notice_replay_response",
            frame(Payload::HostNoticeReplayResponse(Box::new(
                v1::HostNoticeReplayResponse {
                    request_id: "replay-1".to_owned(),
                    agent_epoch: "epoch-1".to_owned(),
                    accepted: true,
                    error_code: String::new(),
                    notices: vec![notice(7, "idle_warning"), notice(8, "idle_closed")],
                    gap: true,
                },
            ))),
        ),
        (
            "pty_create_lifecycle",
            frame(Payload::PtyCreateRequest(v1::PtyCreateRequest {
                request_id: "create-1".to_owned(),
                pty_id: "pty-2".to_owned(),
                request_digest: vec![1, 2, 3],
                workspace_handle: "workspace-1".to_owned(),
                shell: "/bin/zsh".to_owned(),
                cols: 80,
                rows: 24,
                evict_pty_id: "pty-1".to_owned(),
                activity_source: "host".to_owned(),
                screen_scrollback_rows: 1_000,
                spool: true,
                local_launch: true,
                lifecycle_managed: true,
                ..Default::default()
            })),
        ),
        (
            "pty_create_limit_reached",
            frame(Payload::PtyCreateResponse(v1::PtyCreateResponse {
                request_id: "create-1".to_owned(),
                pty_id: "pty-2".to_owned(),
                error_code: PTY_LIMIT_REACHED.to_owned(),
                limit: 24,
                live_count: 24,
                eviction_candidate_pty_id: "pty-1".to_owned(),
                evicted_pty_id: "pty-0".to_owned(),
                ..Default::default()
            })),
        ),
        (
            "pty_list_response_lifecycle",
            frame(Payload::PtyListResponse(v1::PtyListResponse {
                request_id: "list-1".to_owned(),
                agent_epoch: "epoch-1".to_owned(),
                accepted: true,
                entries: vec![v1::PtyInventoryEntry {
                    pty_id: "pty-1".to_owned(),
                    state: "running".to_owned(),
                    pid: 42,
                    next_sequence: 2,
                    activity_state: "idle".to_owned(),
                    last_used_ms: 1_700_000_000_000,
                    screen_available: true,
                    lost: true,
                    lifecycle_managed: true,
                    ..Default::default()
                }],
                ..Default::default()
            })),
        ),
        (
            "agent_hello_process_identity",
            frame(Payload::AgentHello(v1::AgentHello {
                protocol_major: 1,
                protocol_minor: PROTOCOL_MINOR,
                agent_version: "0.1.0".to_owned(),
                agent_epoch: "epoch-1".to_owned(),
                process_id: 4_242,
                process_start_time_ms: 1_700_000_000_123,
                ..Default::default()
            })),
        ),
    ]
}
