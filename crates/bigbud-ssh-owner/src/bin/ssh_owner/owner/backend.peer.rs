//! U24 production peer relay channels (owner-wide, bounded).
//!
//! A channel names only a pairing id. The owner reads its own pin record,
//! checks that the coordinator key is still the one bound at approval, builds a
//! plain pinned route from that record and runs the worker's fixed trigger. The
//! live scan must still match the pin before the identity is offered.

use super::{ErrorCode, Outcome, Owner, Signals, Worker, lease_token, listen};
use crate::{
    config::RouteFacts,
    owner::peer_store,
    owner_backend::relay_worker::{self, Outcome as RelayOutcome},
    transport::{
        Transport,
        peer_production::{self, PEER_TRIGGER},
    },
    v1::{PeerRelayOpen, PeerRelayPhase, PeerRelayState, request::Operation},
};

/// Concurrent peer relay channels per owner.
const MAX_PEER_CHANNELS: usize = 8;

pub(crate) struct PeerRelay {
    worker: Worker<RelayOutcome>,
    pairing_id: String,
}

#[derive(Default)]
pub(crate) struct PeerRelays(Vec<PeerRelay>);

impl PeerRelays {
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    /// Confirmed teardown of every peer channel.
    pub(crate) fn revoke(&mut self) -> Result<(), ErrorCode> {
        self.revoke_where(|_| true)
    }

    /// Confirmed teardown of one pairing's channels (pin revocation).
    pub(crate) fn revoke_pairing(&mut self, pairing_id: &str) -> Result<(), ErrorCode> {
        self.revoke_where(|relay| relay.pairing_id == pairing_id)
    }

    fn revoke_where(&mut self, select: impl Fn(&PeerRelay) -> bool) -> Result<(), ErrorCode> {
        let mut result = Ok(());
        for relay in self.0.iter_mut().filter(|relay| select(relay)) {
            match relay.worker.retire() {
                Some(RelayOutcome::Unconfirmed) | None => result = Err(ErrorCode::OutcomeUnknown),
                Some(_) => {}
            }
        }
        result
    }
}

fn reply(relay: &mut PeerRelay) -> Outcome {
    let worker = &mut relay.worker;
    let mut state = PeerRelayState {
        lease: worker.token.to_vec(),
        pairing_id: relay.pairing_id.clone(),
        ..PeerRelayState::default()
    };
    let phase = match worker.observe() {
        Some(RelayOutcome::Exited(code)) => {
            state.exit_code = Some(code);
            PeerRelayPhase::Exited
        }
        // The relay recipe's 126 is the worker's own exit status here.
        Some(RelayOutcome::Refused) => {
            state.exit_code = Some(126);
            PeerRelayPhase::Exited
        }
        Some(RelayOutcome::Closed) => PeerRelayPhase::Closed,
        Some(RelayOutcome::Lost) => PeerRelayPhase::Lost,
        Some(RelayOutcome::Unconfirmed) => PeerRelayPhase::Unconfirmed,
        None if worker.started() => PeerRelayPhase::Streaming,
        None => {
            state.socket_path = worker.socket_path.clone();
            PeerRelayPhase::Listening
        }
    };
    state.phase = phase.into();
    Outcome::PeerRelay(state)
}

impl Owner {
    pub(in crate::owner) fn dispatch_peer_relay(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        self.peer_authority()?;
        match operation {
            Operation::PeerRelayOpen(open) => self.open_peer_relay(open),
            Operation::PeerRelayStatus(lease) => self.observe_peer_relay(&lease.lease, false),
            Operation::PeerRelayClose(lease) => self.observe_peer_relay(&lease.lease, true),
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    fn open_peer_relay(&mut self, open: PeerRelayOpen) -> Result<Outcome, ErrorCode> {
        let token = lease_token(&open.lease)?;
        if !peer_store::valid_pairing_id(&open.pairing_id) {
            return Err(ErrorCode::InvalidOperands);
        }
        let relays = &mut self.peer.relays.0;
        // Settled, confirmed channels free their slot; an unconfirmed one keeps it.
        relays.retain_mut(|relay| {
            !matches!(
                relay.worker.observe(),
                Some(
                    RelayOutcome::Exited(_)
                        | RelayOutcome::Closed
                        | RelayOutcome::Lost
                        | RelayOutcome::Refused
                )
            )
        });
        if relays.iter().any(|relay| relay.worker.token == token) {
            return Err(ErrorCode::OperationDenied);
        }
        if relays.len() >= MAX_PEER_CHANNELS {
            return Err(ErrorCode::SessionQuota);
        }
        let (authority, state) = self.peer_authority()?;
        let record =
            peer_store::read_pin(state, &open.pairing_id)?.ok_or(ErrorCode::PeerPinUnknown)?;
        let coordinator = peer_production::coordinator_key(state)?;
        if coordinator.fingerprint != record.coordinator {
            return Err(ErrorCode::PeerAuthRefused);
        }
        let address = authority.resolve_peer_host(&record.host, record.port)?;
        let (ssh, keyscan) = authority.openssh();
        let known_hosts = peer_store::known_hosts_path(state, &open.pairing_id)?;
        let transport = Transport::new_with_facts(
            peer_production::peer_config(
                ssh.to_path_buf(),
                keyscan.to_path_buf(),
                address,
                record.port,
                record.user.clone(),
                coordinator.private,
                known_hosts.clone(),
            ),
            &RouteFacts::default().with_production(),
        )?;
        // The pin record is authoritative; the known-hosts file is derived
        // from it on every open, so a tampered file cannot widen trust.
        peer_store::write_private(&known_hosts, &transport.peer_pin_record(&record.key))?;
        let (pinned, host) =
            transport.production_peer_ssh(&record.key.fingerprint(), &record.coordinator)?;
        let (socket, listener, path) = listen()?;
        let worker = Worker::spawn(
            token,
            Some(path),
            RelayOutcome::Unconfirmed,
            "bigbud-peer-relay",
            move |signals: Signals| {
                relay_worker::run(
                    pinned,
                    &host,
                    PEER_TRIGGER,
                    socket,
                    listener,
                    || signals.cancelled(),
                    || signals.streaming(),
                )
            },
        )?;
        let mut relay = PeerRelay {
            worker,
            pairing_id: open.pairing_id,
        };
        let outcome = reply(&mut relay);
        self.peer.relays.0.push(relay);
        Ok(outcome)
    }

    fn observe_peer_relay(&mut self, token: &[u8], close: bool) -> Result<Outcome, ErrorCode> {
        let relay = self
            .peer
            .relays
            .0
            .iter_mut()
            .find(|relay| relay.worker.token.as_slice() == token)
            .ok_or(ErrorCode::OperationDenied)?;
        if close && relay.worker.retire().is_none() {
            return Err(ErrorCode::OutcomeUnknown);
        }
        Ok(reply(relay))
    }
}
