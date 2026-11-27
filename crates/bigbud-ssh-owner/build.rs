fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../protocol/ssh-owner/v1.proto";
    println!("cargo:rerun-if-changed={proto}");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.jump_failure.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.terminal.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.agent_proxy.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.workspace_git.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.deployment.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.provider.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.workspace_directory.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.workspace_write.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.shell.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.peer.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.transfer.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.provider_lease.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.remote_backend.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.agent_control.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.system_status.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.credential.proto");
    println!("cargo:rerun-if-changed=../../protocol/ssh-owner/v1.owner_shutdown.proto");
    prost_build::Config::new()
        .boxed(".bigbud.ssh_owner.v1.Request.operation.git_tracked_push")
        .boxed(".bigbud.ssh_owner.v1.Request.operation.agent_control_open")
        .message_attribute(
            ".bigbud.ssh_owner.v1.ProofTransferStreamControl",
            "#[allow(dead_code)]",
        )
        .message_attribute(
            ".bigbud.ssh_owner.v1.ProofTransferChildProgress",
            "#[allow(dead_code)]",
        )
        .protoc_executable(protoc_bin_vendored::protoc_bin_path()?)
        .compile_protos(&[proto], &["../../protocol/ssh-owner"])?;
    Ok(())
}
