fn main() {
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/v1.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/common.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/process.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/pty.proto");
    println!("cargo:rerun-if-changed=../../protocol/remote-agent/workspace.proto");

    prost_build::Config::new()
        .compile_protos(
            &["../../protocol/remote-agent/v1.proto"],
            &["../../protocol"],
        )
        .expect("failed to compile remote-agent protocol");
}
