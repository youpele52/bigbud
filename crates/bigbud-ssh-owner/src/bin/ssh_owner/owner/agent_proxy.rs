use super::{ErrorCode, Owner};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::{owner_agent_proxy::ProductionProxy, random_token};
use crate::{
    owner_agent_proxy::{AgentProxy, AgentProxyFixture, ProviderKind, ScopedDuplex},
    v1::{
        ProofAgentProxyOpen, ProofAgentProxyStatus, ProofClientRelayOpen, ProofProviderScope,
        ProofProviderVersion,
    },
};

impl Owner {
    pub(super) fn open_agent_proxy(
        &mut self,
        request: &ProofAgentProxyOpen,
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        if self.production {
            return self.open_production_agent_proxy(request);
        }
        self.open_duplex(|fixture, transport| fixture.open(transport, request))
    }

    /// Production opens one private mux session over the target's verified
    /// master. The request selects no executable, digest, command or environment;
    /// the owner's startup binding supplies them, so a non-empty request is a
    /// refusal rather than an unverified launch.
    fn open_production_agent_proxy(
        &mut self,
        request: &ProofAgentProxyOpen,
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        if !request.binary_path.is_empty() || !request.sha256.is_empty() {
            return Err(ErrorCode::OperationDenied);
        }
        if self.lanes.agent_proxy.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let recipe = self
                .agent_service
                .as_ref()
                .ok_or(ErrorCode::ConfigUnsupported)?;
            let transport = super::present(&self.transport)?;
            let generation = self.generation;
            let picker = self
                .lanes
                .master
                .as_mut()
                .ok_or(ErrorCode::OwnerUnavailable)?;
            let (pid, io) =
                picker.open_production_agent_session(transport, generation, recipe.command())?;
            let token = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
            let proxy = ProductionProxy::new(token, pid, io)?;
            self.lanes.agent_proxy = Some(AgentProxy::Production(proxy));
            self.lanes
                .agent_proxy
                .as_mut()
                .ok_or(ErrorCode::OwnerUnavailable)?
                .status()
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            Err(ErrorCode::ConfigUnsupported)
        }
    }

    pub(super) fn open_client_relay(
        &mut self,
        request: &ProofClientRelayOpen,
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        self.open_duplex(|fixture, transport| fixture.open_relay(transport, request))
    }

    pub(super) fn probe_provider(
        &mut self,
        kind: ProviderKind,
        request: &ProofProviderScope,
    ) -> Result<ProofProviderVersion, ErrorCode> {
        self.agent_fixture
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?
            .probe_provider(
                super::present(&self.transport)?,
                kind,
                request,
                self.generation,
            )
    }

    pub(super) fn open_provider(
        &mut self,
        kind: ProviderKind,
        request: &ProofProviderScope,
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        let generation = self.generation;
        self.open_duplex(|fixture, transport| {
            fixture.open_provider(transport, kind, request, generation)
        })
    }

    pub(super) fn open_scoped_duplex(
        &mut self,
        request: ScopedDuplex,
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        self.open_duplex(|fixture, transport| fixture.open_scoped(transport, &request))
    }

    fn open_duplex(
        &mut self,
        open: impl FnOnce(
            &mut AgentProxyFixture,
            &crate::transport::Transport,
        ) -> Result<crate::owner_agent_proxy::AgentProxyLease, ErrorCode>,
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        if self.lanes.agent_proxy.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        let fixture = self
            .agent_fixture
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?;
        match open(fixture, super::present(&self.transport)?) {
            Ok(lease) => {
                let proxy = self.lanes.agent_proxy.insert(AgentProxy::Fixture(lease));
                proxy.status()
            }
            Err(error) => {
                self.lanes.agent_close_uncertain = error == ErrorCode::OutcomeUnknown;
                Err(error)
            }
        }
    }

    pub(super) fn agent_status(
        &mut self,
        lease: &[u8],
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        let proxy = self
            .lanes
            .agent_proxy
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?;
        let state = proxy.status()?;
        if state.lease != lease {
            return Err(ErrorCode::OperationDenied);
        }
        Ok(state)
    }

    pub(super) fn close_agent_proxy(
        &mut self,
        lease: &[u8],
        terminate: bool,
        timeout_ms: u32,
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        let _ = self.agent_status(lease)?;
        let proxy = self
            .lanes
            .agent_proxy
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?;
        let result = proxy.close(terminate, timeout_ms);
        match &result {
            Ok(_) => self.lanes.agent_close_uncertain = false,
            Err(ErrorCode::OutcomeUnknown) => self.lanes.agent_close_uncertain = true,
            Err(_) => {}
        }
        result
    }

    pub(super) fn revoke_agent_proxy(&mut self) -> Result<(), ErrorCode> {
        self.lanes.revoke_agent_proxy()
    }
}
