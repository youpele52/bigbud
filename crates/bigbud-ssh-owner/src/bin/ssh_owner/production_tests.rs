use crate::{
    config::RouteFacts,
    owner::{OwnerStartup, bootstrap},
    owner_pipe::{Pipe, encode_payload},
    startup_profile::{ProfileRefusal, report_refusal},
    transport::TransportConfig,
    v1::{Hello, frame::Payload},
};
use bigbud_ssh_owner::framing::Endpoint;
use std::path::Path;

fn hello_frame(profile_binding: &[u8]) -> Vec<u8> {
    let payload = encode_payload(Payload::Hello(Hello {
        major: 1,
        minor: 0,
        profile_binding: profile_binding.to_vec(),
        proof_attachment_capability: Vec::new(),
    }));
    let mut framed = Vec::new();
    assert!(Endpoint::Owner.write_frame(&mut framed, &payload).is_ok());
    framed
}

#[test]
fn production_bootstrap_refuses_a_hello_for_another_profile() {
    let config = TransportConfig {
        ssh: "/usr/bin/ssh".into(),
        keyscan: "/usr/bin/ssh-keyscan".into(),
        host: "127.0.0.1".parse().unwrap(),
        port: 22,
        user: "tester".into(),
        identity: "/tmp/identity".into(),
        known_hosts: "/tmp/known_hosts".into(),
        alias_config: None,
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
        host_identity: Default::default(),
    };
    let input = hello_frame(b"another-profile");
    let mut pipe = Pipe::new(input.as_slice(), Vec::new());
    let result = bootstrap(
        &mut pipe,
        OwnerStartup {
            profile: b"expected-profile",
            route_facts: RouteFacts::default().with_production(),
            startup: crate::owner::TargetStartup::Pinned {
                target: "ssh:fixture".into(),
                config,
            },
            profile_lock_path: Path::new("/tmp/not-reached/owner.lock"),
            posix_picker: None,
            workspace_snapshot_cancel: None,
            attach_path: None,
            agent_fixture: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            agent_service: None,
            identity_agent_path: None,
            stage: None,
            #[cfg(target_os = "linux")]
            tracked_push: None,
            #[cfg(target_os = "linux")]
            opencode_recipe: None,
            #[cfg(target_os = "linux")]
            opencode_service: None,
            #[cfg(target_os = "linux")]
            opencode_v2: None,
        },
    );
    assert!(result.is_err());
}

#[test]
fn hello_mismatch_records_a_typed_refusal() {
    let mut out = Vec::new();
    report_refusal(ProfileRefusal::HelloMismatch, &mut out);
    let record = String::from_utf8(out).unwrap();
    assert!(record.contains("production_hello_profile_mismatch"));
    assert!(record.len() <= 512);
}
