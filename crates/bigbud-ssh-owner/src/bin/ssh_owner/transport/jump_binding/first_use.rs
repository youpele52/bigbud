use super::*;
use crate::{
    owner_trust::{Observation, TrustTransport},
    transport::{HostKey, ObservedHostKey},
    v1::Trust,
};

type TrustStamp = (Option<HostKey>, [u8; 32]);

pub(super) struct RouteKey {
    generation: Token,
    index: usize,
    pins: Vec<TrustStamp>,
    observation: ObservedHostKey,
}

struct PendingRoute<'a> {
    legs: Vec<&'a Transport>,
    generation: Token,
    root: &'a Path,
    retirement: Option<crate::owner::retirement::Retirement>,
}

impl JumpPicker {
    pub(crate) fn inspect_trust(
        &mut self,
        destination: &Transport,
        generation: Token,
    ) -> Result<Trust, ErrorCode> {
        if !self.first_use {
            return Err(ErrorCode::OperationDenied);
        }
        if let Some(error) = self.trust_fault {
            return Err(ErrorCode::try_from(error.code).unwrap_or(ErrorCode::OperationDenied));
        }
        // Native scopes do not share masters with inspection or approval.
        self.retire()?;
        let legs = self
            .hops
            .iter()
            .chain(std::iter::once(destination))
            .collect();
        self.trust.inspect(&PendingRoute {
            legs,
            generation,
            root: &self.root,
            retirement: self.retirement.clone(),
        })
    }

    pub(crate) fn approve_trust(
        &mut self,
        destination: &Transport,
        generation: Token,
        challenge: &[u8],
    ) -> Result<Trust, ErrorCode> {
        if !self.first_use || self.trust_fault.is_some() {
            self.trust.revoke();
            return Err(ErrorCode::OperationDenied);
        }
        self.retire()?;
        let legs = self
            .hops
            .iter()
            .chain(std::iter::once(destination))
            .collect();
        self.trust.approve(
            &PendingRoute {
                legs,
                generation,
                root: &self.root,
                retirement: self.retirement.clone(),
            },
            challenge,
        )
    }
}

impl PendingRoute<'_> {
    fn pins(&self, deadline: Instant) -> Result<Vec<TrustStamp>, ErrorCode> {
        self.legs
            .iter()
            .map(|leg| leg.routed_trust_stamp(deadline))
            .collect()
    }

    fn probe(&self, index: usize, deadline: Instant) -> Result<HostKey, ErrorCode> {
        let prefix = self.legs.get(..index).ok_or(ErrorCode::OperationDenied)?;
        let pending = self.legs.get(index).ok_or(ErrorCode::OperationDenied)?;
        Route::new(
            self.generation,
            Some(self.root.to_owned()),
            self.retirement.clone(),
        )
        .observe(prefix, pending, deadline)
    }
}

impl TrustTransport for PendingRoute<'_> {
    type Key = RouteKey;

    fn observe_key(&self) -> Result<Observation<RouteKey>, ErrorCode> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let pins = self.pins(deadline)?;
        // Observe only the first unknown hop. Once fully pinned, inspect the
        // destination through the exact already verified prefix.
        let index = pins
            .iter()
            .position(|(key, _)| key.is_none())
            .unwrap_or_else(|| pins.len().saturating_sub(1));
        let leg = self.legs.get(index).ok_or(ErrorCode::OperationDenied)?;
        let observation = leg.inspect_with(deadline, |deadline| {
            self.probe(index, deadline).map(|key| vec![key])
        })?;
        if self.pins(deadline)? != pins {
            return Err(ErrorCode::HostKeyChanged);
        }
        Ok(Observation {
            verified: observation.verified,
            key_type: observation.key_type.clone(),
            fingerprint: observation.fingerprint.clone(),
            jump_leg: u32::try_from(index + 1).map_err(|_| ErrorCode::OperationDenied)?,
            key: RouteKey {
                generation: self.generation,
                index,
                pins,
                observation,
            },
        })
    }

    fn approve_key(&self, key: &RouteKey) -> Result<(), ErrorCode> {
        if key.generation != self.generation {
            return Err(ErrorCode::StaleGeneration);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        if self.pins(deadline)? != key.pins {
            return Err(ErrorCode::HostKeyChanged);
        }
        let leg = self.legs.get(key.index).ok_or(ErrorCode::OperationDenied)?;
        leg.approve_with(&key.observation, deadline, |deadline| {
            let observed = self.probe(key.index, deadline)?;
            if self.pins(deadline)? != key.pins {
                return Err(ErrorCode::HostKeyChanged);
            }
            Ok(vec![observed])
        })
    }
}
