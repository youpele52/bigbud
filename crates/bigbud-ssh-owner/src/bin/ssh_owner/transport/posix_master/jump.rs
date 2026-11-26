//! Internal key-only route lifecycle, exercised in the mounted Linux fixture.
//! Every leg gets an exact independently resolved descriptor and owned master.

mod diagnostic;
mod observe;
pub(crate) use observe::maybe_observe_key;

use super::launch::validate_fixture_for_auth;
use super::*;
use diagnostic::Diagnostics;
use std::{collections::HashSet, net::SocketAddr, process::Stdio};

const MAX_LEGS: usize = 5;

#[derive(Debug, PartialEq, Eq)]
pub(in crate::transport) enum Stage {
    Admission,
    Forward,
    Handshake,
    Listing,
    Retirement,
}

#[derive(Debug, PartialEq, Eq)]
pub(in crate::transport) struct Failure {
    pub(in crate::transport) leg: usize,
    pub(in crate::transport) stage: Stage,
    pub(in crate::transport) code: ErrorCode,
}

pub(in crate::transport) struct Route {
    generation: Token,
    lease_root: Option<std::path::PathBuf>,
    retirement: Option<crate::owner::retirement::Retirement>,
    legs: Vec<(PosixMasterSlot, Option<UnixStream>)>,
}

impl Route {
    pub(in crate::transport) fn new(
        generation: Token,
        lease_root: Option<std::path::PathBuf>,
        retirement: Option<crate::owner::retirement::Retirement>,
    ) -> Self {
        Self {
            generation,
            lease_root,
            retirement,
            legs: Vec::new(),
        }
    }

    pub(in crate::transport) fn matches(&self, generation: Token) -> bool {
        self.generation == generation
    }

    pub(in crate::transport) fn browse(
        &mut self,
        route: &[&Transport],
        path: Option<&str>,
        deadline: Instant,
    ) -> Result<Folders, Failure> {
        let result = (|| {
            session::Picker::new(path).map_err(|code| Failure {
                leg: 0,
                stage: Stage::Admission,
                code,
            })?;
            self.preflight(route, deadline)?;
            if self.legs.is_empty() {
                self.start(route, deadline)?;
            }
            self.list(route, path, deadline)
        })();
        if let Err(failure) = &result
            && !matches!(
                failure.code,
                ErrorCode::InvalidOperands | ErrorCode::ListPathUnavailable | ErrorCode::ListFailed
            )
        {
            self.retire()?;
        }
        result
    }

    fn preflight(&self, route: &[&Transport], deadline: Instant) -> Result<(), Failure> {
        let fail = |leg, code| Failure {
            leg,
            stage: Stage::Admission,
            code,
        };
        if !(2..=MAX_LEGS).contains(&route.len()) || Instant::now() >= deadline {
            return Err(fail(0, ErrorCode::ConfigUnsupported));
        }
        if !self.legs.is_empty() && self.legs.len() != route.len() {
            return Err(fail(0, UNAVAILABLE));
        }
        if self.legs.is_empty()
            && let Some(root) = &self.lease_root
        {
            paths::require_no_residual_lease(root).map_err(|code| fail(0, code))?;
        }
        let mut endpoints = HashSet::new();
        let mut lease_roots = HashSet::new();
        for (index, transport) in route.iter().enumerate() {
            let leg = index + 1;
            transport
                .images
                .require_mounted_linux_fixture()
                .map_err(|code| fail(leg, code))?;
            validate_fixture_for_auth(transport, false).map_err(|code| fail(leg, code))?;
            let config = &transport.config;
            let root = config
                .identity
                .parent()
                .ok_or_else(|| fail(leg, UNAVAILABLE))?;
            if !endpoints.insert((config.host, config.port))
                || self.lease_root.is_none() && !lease_roots.insert(root)
            {
                return Err(fail(leg, ErrorCode::ConfigUnsupported));
            }
            transport
                .pin()
                .and_then(|pin| pin.ok_or(ErrorCode::TrustRequired))
                .map_err(|code| fail(leg, code))?;
            if let Some((slot, _)) = self.legs.get(index) {
                let master = slot.master.as_ref().ok_or_else(|| fail(leg, UNAVAILABLE))?;
                if !Arc::ptr_eq(&master.binding.scope, &transport.config) || master.closing {
                    return Err(fail(leg, UNAVAILABLE));
                }
            }
        }
        Ok(())
    }

    fn start(&mut self, route: &[&Transport], deadline: Instant) -> Result<(), Failure> {
        let preceding = std::iter::once(None).chain(route.iter().copied().map(Some));
        for (index, (transport, preceding)) in route.iter().zip(preceding).enumerate() {
            let error = |stage, code| Failure {
                leg: index + 1,
                stage,
                code,
            };
            let (io, forward) = if let Some((previous, _)) = self.legs.last_mut() {
                let preceding = preceding.ok_or_else(|| error(Stage::Admission, UNAVAILABLE))?;
                let control = previous
                    .admit(preceding, self.generation)
                    .and_then(|master| master.connect(preceding, deadline))
                    .map_err(|code| Failure {
                        leg: index,
                        stage: Stage::Handshake,
                        code,
                    })?;
                let endpoint = SocketAddr::new(transport.config.host, transport.config.port);
                let (stream, forward) = session::forward::open_forward(control, endpoint, deadline)
                    .map_err(|code| error(Stage::Forward, code))?;
                (Some(stream), Some(forward))
            } else {
                (None, None)
            };
            self.legs
                .push((PosixMasterSlot::new(self.retirement.clone()), forward));
            let Some((slot, _)) = self.legs.last_mut() else {
                return Err(error(Stage::Admission, UNAVAILABLE));
            };
            Self::launch(
                slot,
                transport,
                self.generation,
                self.lease_root.as_deref(),
                io,
                deadline,
            )
            .map_err(|code| error(Stage::Handshake, code))?;
        }
        Ok(())
    }

    fn launch(
        slot: &mut PosixMasterSlot,
        transport: &Transport,
        generation: Token,
        lease_root: Option<&Path>,
        io: Option<session::forward::ForwardIo>,
        deadline: Instant,
    ) -> Result<(), ErrorCode> {
        let root = transport.config.identity.parent().ok_or(UNAVAILABLE)?;
        let mut command = slot.prepare_link(
            transport,
            generation,
            || match lease_root {
                Some(root) => PrivatePaths::new_in_route(root),
                None => PrivatePaths::new_in(root),
            },
            &[],
            TrustRead::Default,
            super::LinkMode {
                forwarded: io.is_some(),
                production: false,
            },
        )?;
        if let Some(io) = io {
            command
                .stdin(Stdio::from(io.input))
                .stdout(Stdio::from(io.output));
        }
        let (diagnostics, stderr) = Diagnostics::new()?;
        command.stderr(stderr);
        let master = slot.admit(transport, generation)?;
        let started = master.spawn(&mut command, deadline);
        drop(command);
        started?;
        master
            .await_ready(deadline)
            .map_err(|error| diagnostics.classify(error))?;
        master.binding.revalidate(transport)
    }

    fn list(
        &mut self,
        route: &[&Transport],
        path: Option<&str>,
        deadline: Instant,
    ) -> Result<Folders, Failure> {
        for (index, (transport, (slot, _))) in route.iter().zip(self.legs.iter_mut()).enumerate() {
            slot.admit(transport, self.generation)
                .and_then(|master| master.connect(transport, deadline))
                .map_err(|code| Failure {
                    leg: index + 1,
                    stage: Stage::Handshake,
                    code,
                })?;
        }
        let result = (|| {
            let (slot, _) = self.legs.last_mut().ok_or(UNAVAILABLE)?;
            let destination = route.last().ok_or(UNAVAILABLE)?;
            slot.list(
                destination,
                self.generation,
                session::Picker::new(path)?,
                deadline,
                false,
            )
        })();
        result.map_err(|code| Failure {
            leg: route.len(),
            stage: Stage::Listing,
            code,
        })
    }

    pub(in crate::transport) fn retire(&mut self) -> Result<(), Failure> {
        loop {
            let leg = self.legs.len();
            let Some((slot, _)) = self.legs.last_mut() else {
                return Ok(());
            };
            slot.invalidate(self.generation).map_err(|code| Failure {
                leg,
                stage: Stage::Retirement,
                code,
            })?;
            self.legs.pop();
        }
    }
}

impl Drop for Route {
    fn drop(&mut self) {
        let _ = self.retire();
    }
}
