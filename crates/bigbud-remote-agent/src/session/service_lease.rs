//! Prepared private work; executing it must happen outside AgentSession's mutex.
use super::*;
use crate::service_lease::{Bridge, Peer};
pub struct PreparedServiceLease {
    bridge: Arc<Bridge>,
    payload: v1::frame::Payload,
    peer: Peer,
}
impl PreparedServiceLease {
    pub fn execute(self) -> v1::Frame {
        self.bridge.execute(self.payload, self.peer)
    }
}
impl AgentSession {
    pub fn set_managed_service_account(
        &mut self,
        context: crate::backend_service::ManagedAccountContext,
    ) -> Result<(), SessionError> {
        if self.ready || self.managed_service_lease.is_some() {
            return Err(SessionError::ServiceLeaseUnavailable);
        }
        self.managed_service_lease = Some(Arc::new(
            Bridge::new(context, self.agent_epoch.clone())
                .map_err(|_| SessionError::ServiceLeaseUnavailable)?,
        ));
        Ok(())
    }
    pub fn prepare_service_lease(
        &self,
        payload: v1::frame::Payload,
        peer: Peer,
    ) -> Result<PreparedServiceLease, SessionError> {
        if !self.ready {
            return Err(SessionError::HelloRequired);
        }
        if !self.accepting_work
            && matches!(&payload, v1::frame::Payload::ServiceLeaseStartRequest(_))
        {
            return Err(SessionError::Restarting);
        }
        Ok(PreparedServiceLease {
            bridge: Arc::clone(
                self.managed_service_lease
                    .as_ref()
                    .ok_or(SessionError::ServiceLeaseUnavailable)?,
            ),
            payload,
            peer,
        })
    }
}
