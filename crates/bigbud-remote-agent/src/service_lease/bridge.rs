//! Per-account lease worker. Slow IO never holds the global AgentSession lock.
use super::protocol;
use super::{Error, Launch, LeaseOwner, Peer, Result, SecretEnvironment};
use crate::backend_service::ManagedAccountContext;
use bigbud_protocol::{
    service_lease::v1 as lease,
    v1::{Frame, frame::Payload},
};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
pub struct Bridge {
    context: ManagedAccountContext,
    owner: Mutex<LeaseOwner>,
    retiring: AtomicBool,
}
impl Bridge {
    pub(crate) fn new(context: ManagedAccountContext, epoch: String) -> Result<Self> {
        Ok(Self {
            context,
            owner: Mutex::new(LeaseOwner::new(epoch)?),
            retiring: AtomicBool::new(false),
        })
    }
    pub(crate) fn active(&self) -> bool {
        self.owner
            .try_lock()
            .map(|owner| owner.active())
            .unwrap_or(true)
    }
    /// Native shutdown owner only; uncertainty keeps retirement fenced.
    pub(crate) fn fence(&self) {
        self.retiring.store(true, Ordering::Release);
    }
    pub(crate) fn stop_for_retirement(&self) -> Result<()> {
        self.fence();
        self.owner
            .try_lock()
            .map_err(|_| Error::Occupied)?
            .shutdown()
    }
    pub(crate) fn execute(&self, payload: Payload, peer: Peer) -> Frame {
        let (kind, id) = match &payload {
            Payload::ServiceLeaseStartRequest(value) => (0, value.request_id.clone()),
            Payload::ServiceLeaseStatusRequest(value) => (1, value.request_id.clone()),
            Payload::ServiceLeaseResumeRequest(value) => (2, value.request_id.clone()),
            Payload::ServiceLeaseControlRequest(value) => (3, value.request_id.clone()),
            _ => return protocol::wrap(0, protocol::refused(String::new(), &Error::Invalid)),
        };
        let result = (|| {
            let guard = super::protocol_validate::request(&payload)?;
            // try_lock bounds admission rather than building an unbounded worker queue.
            let mut owner = self.owner.try_lock().map_err(|_| Error::Occupied)?;
            let attempt = (|| {
                let controller = self
                    .context
                    .authorize(&peer, kind == 0 || kind == 2)
                    .map_err(|_| Error::Refused)?;
                if kind == 0 && self.retiring.load(Ordering::Acquire) {
                    return Err(Error::Refused);
                }
                match payload {
                    Payload::ServiceLeaseStartRequest(value) => {
                        let binding = protocol::binding(value.binding)?;
                        self.account_binding(&binding)?;
                        let guard = guard.ok_or(Error::Invalid)?;
                        self.context
                            .validate_guard(&guard)
                            .map_err(|_| Error::Refused)?;
                        let launch = Launch {
                            executable: value.executable.into(),
                            args: value.args,
                            guard: Some(guard),
                            assets: Some(
                                self.context
                                    .assets(
                                        value.assets_generation,
                                        value.assets_receipt_size,
                                        value.assets_receipt_sha256,
                                        value.assets_argument,
                                    )
                                    .map_err(|_| Error::Refused)?,
                            ),
                            environment: SecretEnvironment(
                                value
                                    .environment
                                    .into_iter()
                                    .map(|v| (v.name, v.value))
                                    .collect(),
                            ),
                        };
                        if binding.configuration_sha256
                            != launch.fingerprint(&binding.executable_sha256)?
                        {
                            return Err(Error::Refused);
                        }
                        let grant = owner.start(binding, controller, &value.capability, launch)?;
                        let generation = grant.generation();
                        Ok(protocol::response(
                            id.clone(),
                            grant.snapshot,
                            generation.value(),
                        ))
                    }
                    Payload::ServiceLeaseStatusRequest(value) => {
                        if value.binding.is_none() && value.capability.is_empty() {
                            // Empty current inventory never attests settlement of an older epoch.
                            return if owner.present() {
                                Ok(protocol::response(id.clone(), owner.status()?, 0))
                            } else {
                                Ok(lease::Response {
                                    request_id: id.clone(),
                                    accepted: true,
                                    state: "empty".into(),
                                    ..Default::default()
                                })
                            };
                        }
                        let binding = protocol::binding(value.binding)?;
                        self.account_binding(&binding)?;
                        if let Some(snapshot) =
                            owner.terminal_status(&binding, &value.capability, &controller)?
                        {
                            return Ok(protocol::response(id.clone(), snapshot, 0));
                        }
                        if !owner.present() {
                            if let Some(snapshot) =
                                owner.retained_status(&binding, &value.capability)?
                            {
                                return Ok(protocol::response(id.clone(), snapshot, 0));
                            }
                            return Ok(lease::Response {
                                request_id: id.clone(),
                                state: "not-found".into(),
                                error_code: "LEASE_NOT_FOUND".into(),
                                ..Default::default()
                            });
                        }
                        let generation =
                            owner.authenticate(&binding, &value.capability, &controller, false)?;
                        Ok(protocol::response(
                            id.clone(),
                            owner.status()?,
                            generation.value(),
                        ))
                    }
                    Payload::ServiceLeaseResumeRequest(value) => {
                        let binding = protocol::binding(value.binding)?;
                        self.account_binding(&binding)?;
                        let grant = owner.resume(&binding, &value.capability, controller)?;
                        let generation = grant.generation();
                        let bootstrap = owner.with_bootstrap(generation, |env| {
                            env.0
                                .iter()
                                .map(|(name, value)| bigbud_protocol::v1::ProcessEnvironment {
                                    name: name.clone(),
                                    value: value.clone(),
                                })
                                .collect()
                        })?;
                        let mut response =
                            protocol::response(id.clone(), grant.snapshot, generation.value());
                        response.bootstrap = bootstrap;
                        Ok(response)
                    }
                    Payload::ServiceLeaseControlRequest(value) => {
                        let binding = protocol::binding(value.binding)?;
                        self.account_binding(&binding)?;
                        if value.action == "stop-original" {
                            if value.generation != 0 {
                                return Err(Error::Refused);
                            }
                            return Ok(protocol::response(
                                id.clone(),
                                owner.stop_original(&binding, &value.capability, &controller)?,
                                0,
                            ));
                        }
                        if value.action == "cancel-pending" {
                            if value.generation != 0 {
                                return Err(Error::Refused);
                            }
                            return Ok(protocol::response(
                                id.clone(),
                                owner.cancel_start(binding, &value.capability)?,
                                0,
                            ));
                        }
                        let generation = owner.authenticate(
                            &binding,
                            &value.capability,
                            &controller,
                            value.action == "stop",
                        )?;
                        if generation.value() != value.generation {
                            return Err(Error::Refused);
                        }
                        match value.action.as_str() {
                            "stop" => Ok(protocol::response(
                                id.clone(),
                                owner.stop(generation)?,
                                generation.value(),
                            )),
                            "detach" => {
                                let snapshot = owner.status()?;
                                owner.detach(generation)?;
                                let mut response =
                                    protocol::response(id.clone(), snapshot, generation.value());
                                response.state = "detached".into();
                                Ok(response)
                            }
                            _ => Err(Error::Invalid),
                        }
                    }
                    _ => Err(Error::Invalid),
                }
            })();
            let retiring = self.retiring.load(Ordering::Acquire);
            if retiring {
                owner.shutdown()?;
            }
            let mut response = attempt?;
            if retiring {
                response.bootstrap.clear();
                response.state = "exited".into();
            }
            Ok(response)
        })();
        protocol::wrap(
            kind,
            result.unwrap_or_else(|error| protocol::refused(id, &error)),
        )
    }
    fn account_binding(&self, binding: &super::Binding) -> Result<()> {
        if binding.authority != self.context.authority()
            || binding.installation != self.context.installation()
        {
            return Err(Error::Refused);
        }
        Ok(())
    }
}
