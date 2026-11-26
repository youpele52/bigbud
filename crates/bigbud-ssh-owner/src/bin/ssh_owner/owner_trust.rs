use std::time::{Duration, Instant};

#[cfg(unix)]
use crate::transport::{ObservedHostKey, Transport};
#[cfg(windows)]
use crate::windows_transport::{ObservedHostKey, WindowsTransport as Transport};
use crate::{
    Token, random_token,
    v1::{ErrorCode, Trust, TrustState},
};

const CHALLENGE_TTL: Duration = Duration::from_secs(60);

pub(super) struct Observation<K> {
    pub(super) key: K,
    pub(super) verified: bool,
    pub(super) key_type: String,
    pub(super) fingerprint: String,
    pub(super) jump_leg: u32,
}

pub(super) trait TrustTransport {
    type Key;

    fn observe_key(&self) -> Result<Observation<Self::Key>, ErrorCode>;
    fn approve_key(&self, key: &Self::Key) -> Result<(), ErrorCode>;
}

impl TrustTransport for Transport {
    type Key = ObservedHostKey;

    fn observe_key(&self) -> Result<Observation<Self::Key>, ErrorCode> {
        let key = self.inspect()?;
        Ok(Observation {
            verified: key.verified,
            key_type: key.key_type.clone(),
            fingerprint: key.fingerprint.clone(),
            jump_leg: 0,
            key,
        })
    }

    fn approve_key(&self, key: &Self::Key) -> Result<(), ErrorCode> {
        self.approve(key)
    }
}

struct Challenge<K> {
    observation: Observation<K>,
    token: Token,
    expires: Instant,
}

// One immutable route/trust policy, one target, one owner epoch. Successful
// transitions clear this challenge synchronously before serving the new generation.
pub(super) struct TrustApproval<K = ObservedHostKey>(Option<Challenge<K>>);

impl<K> Default for TrustApproval<K> {
    fn default() -> Self {
        Self(None)
    }
}

impl<K> TrustApproval<K> {
    pub(super) fn revoke(&mut self) {
        self.0 = None;
    }

    pub(super) fn inspect(
        &mut self,
        transport: &impl TrustTransport<Key = K>,
    ) -> Result<Trust, ErrorCode> {
        self.revoke();
        let observation = transport.observe_key()?;
        if observation.verified {
            return Ok(observation.reply(TrustState::Verified, Vec::new()));
        }
        let token = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let reply = observation.reply(TrustState::ApprovalRequired, token.to_vec());
        self.0 = Some(Challenge {
            observation,
            token,
            expires: Instant::now() + CHALLENGE_TTL,
        });
        Ok(reply)
    }

    pub(super) fn approve(
        &mut self,
        transport: &impl TrustTransport<Key = K>,
        token: &[u8],
    ) -> Result<Trust, ErrorCode> {
        let challenge = self.take_for_approval(token, Instant::now())?;
        // Transport revalidates the live key against this exact observation.
        let observation = challenge.observation;
        transport.approve_key(&observation.key)?;
        Ok(observation.reply(TrustState::Verified, Vec::new()))
    }

    fn take_for_approval(&mut self, token: &[u8], now: Instant) -> Result<Challenge<K>, ErrorCode> {
        if self
            .0
            .as_ref()
            .is_some_and(|challenge| challenge.expires <= now)
        {
            self.revoke();
        }
        if self
            .0
            .as_ref()
            .is_none_or(|challenge| challenge.token != token)
        {
            return Err(ErrorCode::OperationDenied);
        }
        self.0.take().ok_or(ErrorCode::OperationDenied)
    }
}

impl<K> Observation<K> {
    fn reply(&self, state: TrustState, challenge: Vec<u8>) -> Trust {
        Trust {
            state: state.into(),
            challenge,
            key_type: self.key_type.clone(),
            fingerprint: self.fingerprint.clone(),
            jump_leg: self.jump_leg,
        }
    }
}
