fn main() {
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/v1.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/common.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/process.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/pty.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/workspace.proto");

    let protoc = protoc_bin_vendored::protoc_bin_path()
        .expect("failed to resolve the vendored protobuf compiler");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config
        .compile_protos(
            &["../../protocol/remote-agent/v1.proto"],
            &["../../protocol"],
        )
        .expect("failed to compile remote-agent protocol");
}
