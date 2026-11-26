fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/v1.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/common.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/process.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/service_lease.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/pty.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/pty_lifecycle.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/paste_staging.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/resource_cleanup.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/search.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/workspace.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/terminal_host.proto");

    let protoc = protoc_bin_vendored::protoc_bin_path()
        .map_err(|error| format!("failed to resolve the vendored protobuf compiler: {error}"))?;
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    // Keep the existing frame/queue stack footprint bounded as this optional
    // concern grows; only its new payloads require their own allocation.
    for field in [
        "start_request",
        "start_response",
        "status_request",
        "status_response",
        "resume_request",
        "resume_response",
        "control_request",
        "control_response",
    ] {
        config.boxed(format!(
            ".bigbud.remote_agent.v1.Frame.payload.service_lease_{field}"
        ));
    }
    // Protocol 1.9 terminal lifecycle payloads stay off the frame footprint: the
    // larger ones (snapshot header, policy, view state, reports and replays)
    // are boxed so `Frame` stays bounded by the pre-1.9 PTY create request.
    for field in [
        "pty_screen_snapshot_header",
        "host_policy_update_request",
        "host_policy_update_response",
        "pty_view_state_request",
        "pty_view_state_response",
        "pty_keep_open_response",
        "pty_close_all_response",
        "host_resource_report",
        "host_notice_replay_response",
        "terminal_host_inventory_request",
        "terminal_host_inventory_response",
        "terminal_host_retire_ssh_spawn_request",
        "terminal_host_retire_ssh_spawn_response",
    ] {
        config.boxed(format!(".bigbud.remote_agent.v1.Frame.payload.{field}"));
    }
    config
        .compile_protos(
            &["../../protocol/remote-agent/v1.proto"],
            &["../../protocol"],
        )
        .map_err(|error| format!("failed to compile remote-agent protocol: {error}"))?;

    for name in [
        "v1",
        "common",
        "policy",
        "episode",
        "control",
        "execution",
        "outcome",
    ] {
        println!("cargo:rerun-if-changed=../../protocol/computer-use/{name}.proto");
    }
    config
        .compile_protos(
            &["../../protocol/computer-use/v1.proto"],
            &["../../protocol"],
        )
        .map_err(|error| format!("failed to compile computer-use protocol: {error}"))?;

    Ok(())
}
