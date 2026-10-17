fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../../protocol/desktop-supervisor/v1.proto");
    println!("cargo:rerun-if-changed=../../protocol/system-monitor/v1.proto");
    println!("cargo:rerun-if-changed=../../protocol/system-monitor/app.proto");
    println!("cargo:rerun-if-changed=../../protocol/system-monitor/metrics.proto");
    println!("cargo:rerun-if-changed=../../protocol/system-monitor/process.proto");

    let protoc = protoc_bin_vendored::protoc_bin_path()
        .map_err(|error| format!("failed to resolve the vendored protobuf compiler: {error}"))?;
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.boxed(".bigbud.system_monitor.v1.Frame.payload.snapshot");
    config
        .compile_protos(
            &[
                "../../protocol/desktop-supervisor/v1.proto",
                "../../protocol/system-monitor/v1.proto",
            ],
            &["../../protocol"],
        )
        .map_err(|error| format!("failed to compile desktop supervisor protocol: {error}"))?;

    Ok(())
}
