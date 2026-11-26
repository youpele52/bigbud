//! W2 T-prov production provider lease vectors (Request 80–83, Reply 51–52).

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let lease = vec![81; 32];
    let handle = || v1::ProviderLeaseHandle {
        lease: lease.clone(),
    };
    assert_frame(
        values,
        "probe_provider",
        request(Operation::ProbeProvider(v1::ProviderProbe {
            scope: Some(v1::ProviderLeaseScope {
                kind: v1::ProviderLeaseKind::Pi.into(),
                thread_id: "thread-pi".into(),
                session_epoch: 9,
                cwd: "/srv/work".into(),
                default_mode_user_input: false,
                session_file: None,
                codex_home: None,
            }),
        })),
    );
    for (name, kind, thread, epoch, session_file, codex_home) in [
        (
            "probe_provider_resume",
            v1::ProviderLeaseKind::Pi,
            "thread-pi",
            9,
            Some("/home/u/.pi/agent/sessions/w/s.jsonl"),
            None,
        ),
        (
            "probe_provider_codex_home",
            v1::ProviderLeaseKind::Codex,
            "thread-codex",
            7,
            None,
            Some("/home/u/.codex"),
        ),
    ] {
        assert_frame(
            values,
            name,
            request(Operation::ProbeProvider(v1::ProviderProbe {
                scope: Some(v1::ProviderLeaseScope {
                    kind: kind.into(),
                    thread_id: thread.into(),
                    session_epoch: epoch,
                    cwd: "/srv/work".into(),
                    default_mode_user_input: false,
                    session_file: session_file.map(Into::into),
                    codex_home: codex_home.map(Into::into),
                }),
            })),
        );
    }
    assert_frame(
        values,
        "provider_lease_open",
        request(Operation::ProviderLeaseOpen(v1::ProviderLeaseOpen {
            lease: lease.clone(),
            scope: Some(v1::ProviderLeaseScope {
                kind: v1::ProviderLeaseKind::Codex.into(),
                thread_id: "thread-codex".into(),
                session_epoch: 7,
                cwd: "/srv/work".into(),
                default_mode_user_input: true,
                session_file: None,
                codex_home: None,
            }),
        })),
    );
    assert_frame(
        values,
        "provider_lease_status",
        request(Operation::ProviderLeaseStatus(handle())),
    );
    assert_frame(
        values,
        "provider_lease_close",
        request(Operation::ProviderLeaseClose(handle())),
    );
    assert_frame(
        values,
        "provider_version",
        reply(Outcome::ProviderVersion(v1::ProviderVersion {
            code: 0,
            stdout: "0.70.2\n".into(),
            stderr: String::new(),
        })),
    );
    assert_frame(
        values,
        "provider_lease_listening",
        reply(Outcome::ProviderLease(v1::ProviderLeaseState {
            lease: lease.clone(),
            phase: v1::ProviderLeasePhase::Listening.into(),
            stdio_socket_path: Some("/tmp/bigbud-oc1-0123456789abcdef/s".into()),
            stderr_socket_path: Some("/tmp/bigbud-oc1-fedcba9876543210/s".into()),
            exit_code: None,
        })),
    );
    assert_frame(
        values,
        "provider_lease_exited",
        reply(Outcome::ProviderLease(v1::ProviderLeaseState {
            lease,
            phase: v1::ProviderLeasePhase::Exited.into(),
            stdio_socket_path: None,
            stderr_socket_path: None,
            exit_code: Some(0),
        })),
    );
}
