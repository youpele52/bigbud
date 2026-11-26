use super::{AgentProxyFixture, AgentProxyLease, ErrorCode, Transport, adopt_pipes, relay, v1};
use std::{
    io,
    path::{Path, PathBuf},
};

impl AgentProxyFixture {
    /// # Safety
    /// Same descriptor-transfer contract as `new` (one exact channel).
    pub(in super::super) unsafe fn new_relay(
        binding: v1::ProofClientRelayOpen,
    ) -> io::Result<Self> {
        let binary = PathBuf::from(binding.node_binary);
        let sha256 = binding.node_sha256;
        let recipe = relay::Recipe::new(
            &binary,
            &sha256,
            Path::new(&binding.helper_entry),
            &binding.helper_sha256,
            &binding.authority_id,
        )?;
        // SAFETY: the restricted startup caller transfers all three descriptors.
        let pipes = unsafe { adopt_pipes([3, 4, 5]) }?;
        Ok(Self {
            binary,
            sha256,
            pipes: Some(pipes),
            installed: None,
            scoped: None,
            relay: Some(recipe),
            provider: None,
        })
    }

    pub(in super::super) fn open_relay(
        &mut self,
        transport: &Transport,
        input: &v1::ProofClientRelayOpen,
    ) -> Result<AgentProxyLease, ErrorCode> {
        let recipe = self.relay.as_ref().ok_or(ErrorCode::OperationDenied)?;
        if self.pipes.is_none()
            || !recipe.matches_binding(
                &input.node_binary,
                &input.node_sha256,
                &input.helper_entry,
                &input.helper_sha256,
                &input.authority_id,
            )
        {
            return Err(ErrorCode::OperationDenied);
        }
        let remote = recipe.command().to_owned();
        self.launch(transport, &remote)
    }
}
