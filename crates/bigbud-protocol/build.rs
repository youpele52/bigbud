fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/v1.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/common.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/process.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/service_lease.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/pty.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/resource_cleanup.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/workspace.proto");

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
