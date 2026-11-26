//! W2 T-backend production lease vectors (Request 100–105, Reply 61–62).

use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{reply::Outcome, request::Operation};

const REQUEST: &str = "0123abcd-0123-4abc-8def-0123456789ab";
const INSTALL: &str = "1.2.3-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa";
const AUTHORITY: &str = "0123456789abcdef0123456789abcdef";

fn digest(c: char) -> String {
    c.to_string().repeat(64)
}

fn pin(path: &str, c: char) -> v1::DeploymentPin {
    v1::DeploymentPin {
        path: path.into(),
        sha256: digest(c),
    }
}

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let lease = vec![61; 32];
    let relay = vec![62; 32];
    let step = |lease: &[u8]| v1::DeploymentStepLease {
        lease: lease.to_vec(),
    };
    let channel = |lease: &[u8]| v1::ClientRelayLease {
        lease: lease.to_vec(),
    };
    assert_frame(
        values,
        "deployment_step_open",
        request(Operation::DeploymentStepOpen(v1::DeploymentStepOpen {
            lease: lease.clone(),
            kind: v1::DeploymentStepKind::Publish.into(),
            request_id: REQUEST.into(),
            home: "/home/bbdev".into(),
            install_name: INSTALL.into(),
            archive_sha256: digest('a'),
            manifest_sha256: digest('b'),
            pins: vec![
                pin("node/bin/node", 'c'),
                pin("server/dist/bin.mjs", 'd'),
                pin("server/dist/remote-client-relay/r.mjs", 'e'),
            ],
            ..v1::DeploymentStepOpen::default()
        })),
    );
    assert_frame(
        values,
        "deployment_step_start",
        request(Operation::DeploymentStepOpen(v1::DeploymentStepOpen {
            lease: lease.clone(),
            kind: v1::DeploymentStepKind::Start.into(),
            home: "/home/bbdev".into(),
            install_name: INSTALL.into(),
            node_path: "node/bin/node".into(),
            entry_path: "server/dist/bin.mjs".into(),
            authority_id: AUTHORITY.into(),
            enable_boot: true,
            ..v1::DeploymentStepOpen::default()
        })),
    );
    assert_frame(
        values,
        "deployment_step_status",
        request(Operation::DeploymentStepStatus(step(&lease))),
    );
    assert_frame(
        values,
        "deployment_step_cancel",
        request(Operation::DeploymentStepCancel(step(&lease))),
    );
    assert_frame(
        values,
        "client_relay_lease_open",
        request(Operation::ClientRelayLeaseOpen(v1::ClientRelayLeaseOpen {
            lease: relay.clone(),
            node_binary: "/home/bbdev/.bigbud/backend-graphs/x/graph/node/bin/node".into(),
            node_sha256: digest('c'),
            helper_entry: "/home/bbdev/.bigbud/backend-graphs/x/graph/server/dist/r.mjs".into(),
            helper_sha256: digest('e'),
            authority_id: AUTHORITY.into(),
        })),
    );
    assert_frame(
        values,
        "client_relay_lease_status",
        request(Operation::ClientRelayLeaseStatus(channel(&relay))),
    );
    assert_frame(
        values,
        "client_relay_lease_close",
        request(Operation::ClientRelayLeaseClose(channel(&relay))),
    );
    let state =
        |phase: v1::DeploymentStepPhase, kind: v1::DeploymentStepKind| v1::DeploymentStepState {
            lease: lease.clone(),
            phase: phase.into(),
            kind: kind.into(),
            request_id: REQUEST.into(),
            ..v1::DeploymentStepState::default()
        };
    assert_frame(
        values,
        "deployment_step_listening",
        reply(Outcome::DeploymentStep(v1::DeploymentStepState {
            socket_path: Some("/tmp/bigbud-oc1-0123456789abcdef/s".into()),
            ..state(
                v1::DeploymentStepPhase::Listening,
                v1::DeploymentStepKind::ManifestPut,
            )
        })),
    );
    assert_frame(
        values,
        "deployment_step_exited",
        reply(Outcome::DeploymentStep(v1::DeploymentStepState {
            exit_code: Some(0),
            stdout: "home=/home/bbdev\narch=aarch64\n".into(),
            ..state(
                v1::DeploymentStepPhase::Exited,
                v1::DeploymentStepKind::ProbeHost,
            )
        })),
    );
    assert_frame(
        values,
        "deployment_step_unknown",
        reply(Outcome::DeploymentStep(state(
            v1::DeploymentStepPhase::OutcomeUnknown,
            v1::DeploymentStepKind::Setup,
        ))),
    );
    assert_frame(
        values,
        "client_relay_lease_listening",
        reply(Outcome::ClientRelayLease(v1::ClientRelayLeaseState {
            lease: relay.clone(),
            phase: v1::ClientRelayPhase::Listening.into(),
            socket_path: Some("/tmp/bigbud-oc1-fedcba9876543210/s".into()),
            exit_code: None,
        })),
    );
    assert_frame(
        values,
        "client_relay_lease_exited",
        reply(Outcome::ClientRelayLease(v1::ClientRelayLeaseState {
            lease: relay,
            phase: v1::ClientRelayPhase::Exited.into(),
            socket_path: None,
            exit_code: Some(0),
        })),
    );
}
