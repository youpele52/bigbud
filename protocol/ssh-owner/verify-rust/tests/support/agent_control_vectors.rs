//! U25 remote-agent control vectors (Request 140–142, Reply 81), encoded
//! independently with prost.

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

const ROOT: &str = "/home/bbdev/.bigbud/agent";

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let sha = "5e17".repeat(16);
    let lease = vec![0x25; 32];
    let proxy = vec![0x26; 32];
    let state = format!("{ROOT}/runtimes/g-5e17");
    let runtime = v1::AgentRuntime {
        generation: "g-5e17".into(),
        version: "0.9.0".into(),
        sha256: sha.clone(),
        build_digest: "build:5e17".into(),
        target_triple: "aarch64-unknown-linux-gnu".into(),
        binary_path: format!("{ROOT}/bin/0.9.0/{sha}/bigbud-remote-agent"),
        state_path: state.clone(),
        socket_path: format!("{state}/supervisor.sock"),
        log_path: format!("{state}/supervisor.log"),
        origin: v1::AgentRuntimeOrigin::Managed.into(),
    };
    let open = |fields: v1::AgentControlOpen| {
        request(Operation::AgentControlOpen(v1::AgentControlOpen {
            lease: lease.clone(),
            ..fields
        }))
    };
    let state_reply = |fields: v1::AgentControlState| {
        reply(Outcome::AgentControl(v1::AgentControlState {
            lease: lease.clone(),
            ..fields
        }))
    };
    for (name, payload) in [
        (
            "agent_control_open",
            open(v1::AgentControlOpen {
                kind: v1::AgentControlKind::SupervisorObserve.into(),
                runtime: Some(runtime.clone()),
                observe_mode: v1::AgentObserveMode::CandidateStartup.into(),
                attempt_id: "launch-g-5e17".into(),
                ..Default::default()
            }),
        ),
        (
            "agent_control_open_registry_cas",
            open(v1::AgentControlOpen {
                kind: v1::AgentControlKind::RegistryCas.into(),
                expected_present: true,
                expected_size: 512,
                expected_sha256: sha.clone(),
                next_size: 640,
                next_sha256: sha.clone(),
                ..Default::default()
            }),
        ),
        (
            "agent_control_open_install_upload",
            open(v1::AgentControlOpen {
                kind: v1::AgentControlKind::InstallUpload.into(),
                reservation_id: "stage-5e17".into(),
                version: "0.9.0".into(),
                sha256: sha.clone(),
                size: 4_194_304,
                ..Default::default()
            }),
        ),
        (
            "agent_control_status",
            request(Operation::AgentControlStatus(v1::AgentControlLease {
                lease: lease.clone(),
            })),
        ),
        (
            "agent_control_cancel",
            request(Operation::AgentControlCancel(v1::AgentControlLease {
                lease: lease.clone(),
            })),
        ),
        (
            "agent_control_listening",
            state_reply(v1::AgentControlState {
                phase: v1::AgentControlPhase::Listening.into(),
                kind: v1::AgentControlKind::InstallUpload.into(),
                socket_path: Some("/tmp/bigbud-agent-control/s".into()),
                ..Default::default()
            }),
        ),
        (
            "agent_control_exited",
            state_reply(v1::AgentControlState {
                phase: v1::AgentControlPhase::Exited.into(),
                kind: v1::AgentControlKind::SupervisorObserve.into(),
                exit_code: Some(0),
                stdout: "ready".into(),
                ..Default::default()
            }),
        ),
        (
            "agent_proxy_lease_open",
            request(Operation::AgentProxyLeaseOpen(v1::AgentProxyLeaseOpen {
                lease: proxy.clone(),
                runtime: Some(runtime.clone()),
            })),
        ),
        (
            "agent_proxy_lease_status",
            request(Operation::AgentProxyLeaseStatus(v1::ClientRelayLease {
                lease: proxy.clone(),
            })),
        ),
        (
            "agent_proxy_lease_close",
            request(Operation::AgentProxyLeaseClose(v1::ClientRelayLease {
                lease: proxy.clone(),
            })),
        ),
        (
            "agent_proxy_lease_listening",
            reply(Outcome::AgentProxyLease(v1::ClientRelayLeaseState {
                lease: proxy.clone(),
                phase: v1::ClientRelayPhase::Listening.into(),
                socket_path: Some("/tmp/bigbud-agent-proxy/s".into()),
                exit_code: None,
            })),
        ),
        (
            "agent_proxy_lease_exited",
            reply(Outcome::AgentProxyLease(v1::ClientRelayLeaseState {
                lease: proxy.clone(),
                phase: v1::ClientRelayPhase::Exited.into(),
                socket_path: None,
                exit_code: Some(0),
            })),
        ),
        (
            "agent_control_outcome_unknown",
            state_reply(v1::AgentControlState {
                phase: v1::AgentControlPhase::OutcomeUnknown.into(),
                kind: v1::AgentControlKind::RegistryCas.into(),
                ..Default::default()
            }),
        ),
    ] {
        assert_frame(values, name, payload);
    }
}
