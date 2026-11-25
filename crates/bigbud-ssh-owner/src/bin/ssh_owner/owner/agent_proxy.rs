use super::{ErrorCode, Owner};
use crate::{
    owner_agent_proxy::{AgentProxyFixture, ProviderKind, ScopedDuplex},
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
        self.open_duplex(|fixture, transport| fixture.open(transport, request))
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
        if self.agent_proxy.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        let fixture = self
            .agent_fixture
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?;
        match open(fixture, super::present(&self.transport)?) {
            Ok(lease) => {
                let proxy = self.agent_proxy.insert(lease);
                proxy.status()
            }
            Err(error) => {
                self.agent_close_uncertain = error == ErrorCode::OutcomeUnknown;
                Err(error)
            }
        }
    }

    pub(super) fn agent_status(
        &mut self,
        lease: &[u8],
    ) -> Result<ProofAgentProxyStatus, ErrorCode> {
        let proxy = self
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
            .agent_proxy
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?;
        let result = proxy.close(terminate, timeout_ms);
        match &result {
            Ok(_) => self.agent_close_uncertain = false,
            Err(ErrorCode::OutcomeUnknown) => self.agent_close_uncertain = true,
            Err(_) => {}
        }
        result
    }

    pub(super) fn revoke_agent_proxy(&mut self) -> Result<(), ErrorCode> {
        let Some(proxy) = self.agent_proxy.as_mut() else {
            return if self.agent_close_uncertain {
                Err(ErrorCode::OutcomeUnknown)
            } else {
                Ok(())
            };
        };
        self.agent_close_uncertain = true;
        proxy.close(true, 2_000)?;
        self.agent_close_uncertain = false;
        Ok(())
    }
}
