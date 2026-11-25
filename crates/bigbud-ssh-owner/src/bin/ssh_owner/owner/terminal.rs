use std::time::{Duration, Instant};

use super::{ErrorCode, Owner, Token, random_token};
use crate::{
    owner_terminal::TerminalLease,
    v1::{ProofPrepareTerminal, ProofTerminal, ProofTerminalReservation},
};

const RESERVATION_TTL: Duration = Duration::from_secs(20);

pub(super) struct TerminalPreparation {
    lease: Token,
    cwd: String,
    cols: u16,
    rows: u16,
    expires: Instant,
}

pub(super) struct LiveTerminal {
    id: Token,
    birth_generation: Option<Token>,
    // Mirrored only from positively settled writes. None fences input after ambiguity.
    next_input_sequence: Option<u64>,
    lease: TerminalLease,
}

impl Owner {
    pub(super) fn prepare_terminal(
        &mut self,
        request: ProofPrepareTerminal,
    ) -> Result<ProofTerminalReservation, ErrorCode> {
        if self.terminal.is_some()
            || self
                .preparation
                .as_ref()
                .is_some_and(|prep| prep.expires > Instant::now())
        {
            return Err(ErrorCode::OperationDenied);
        }
        if !super::present(&self.transport)?.matches_workspace_root(&request.cwd)
            || !valid_id(&request.thread_id)
            || !valid_id(&request.terminal_id)
            || !(1..=400).contains(&request.cols)
            || !(1..=200).contains(&request.rows)
        {
            return Err(ErrorCode::InvalidOperands);
        }
        let lease = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        self.preparation = Some(TerminalPreparation {
            lease,
            cwd: request.cwd,
            cols: u16::try_from(request.cols).map_err(|_| ErrorCode::InvalidOperands)?,
            rows: u16::try_from(request.rows).map_err(|_| ErrorCode::InvalidOperands)?,
            expires: Instant::now() + RESERVATION_TTL,
        });
        Ok(ProofTerminalReservation {
            lease: lease.to_vec(),
            cancelled: false,
        })
    }

    pub(super) fn cancel_terminal_reservation(
        &mut self,
        lease: &[u8],
    ) -> Result<ProofTerminalReservation, ErrorCode> {
        let prep = self
            .preparation
            .as_ref()
            .filter(|prep| prep.lease == lease)
            .ok_or(ErrorCode::OperationDenied)?;
        let receipt = ProofTerminalReservation {
            lease: prep.lease.to_vec(),
            cancelled: true,
        };
        self.preparation = None;
        Ok(receipt)
    }

    pub(super) fn open_terminal(&mut self, requested: &[u8]) -> Result<ProofTerminal, ErrorCode> {
        if self.terminal.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        let (id, launched) = if requested.is_empty()
            && self.preparation.is_none()
            && !super::present(&self.transport)?.has_workspace_root()
        {
            (
                random_token().map_err(|_| ErrorCode::OwnerUnavailable)?,
                super::present(&self.transport)?.open_proof_terminal(),
            )
        } else {
            let prepared = self
                .preparation
                .as_ref()
                .filter(|prep| prep.lease == requested && prep.expires > Instant::now())
                .ok_or(ErrorCode::OperationDenied)?;
            let id = prepared.lease;
            let prep = self.preparation.take().ok_or(ErrorCode::OperationDenied)?;
            (
                id,
                super::present(&self.transport)?
                    .open_prepared_terminal(&prep.cwd, prep.cols, prep.rows),
            )
        };
        let terminal = match launched {
            Ok(terminal) => terminal,
            Err(error) => {
                self.terminal_uncertain = error == ErrorCode::OutcomeUnknown;
                return Err(error);
            }
        };
        self.terminal = Some(LiveTerminal {
            id,
            birth_generation: self.supervised_terminal.then_some(self.generation),
            next_input_sequence: self.supervised_terminal.then_some(1),
            lease: terminal,
        });
        self.terminal_status(&id)
    }

    pub(super) fn leased_terminal(&self, requested: &[u8]) -> Result<&TerminalLease, ErrorCode> {
        self.terminal
            .as_ref()
            .filter(|terminal| requested == terminal.id)
            .map(|terminal| &terminal.lease)
            .ok_or(ErrorCode::OperationDenied)
    }

    pub(super) fn write_terminal_input(
        &mut self,
        requested: &[u8],
        sequence: u64,
        data: &[u8],
    ) -> Result<(), ErrorCode> {
        let terminal = self
            .terminal
            .as_mut()
            .filter(|terminal| requested == terminal.id)
            .ok_or(ErrorCode::OperationDenied)?;
        if terminal.birth_generation.is_none() {
            return terminal.lease.write_proof_input(sequence, data);
        }
        if terminal.next_input_sequence != Some(sequence) {
            return Err(ErrorCode::OperationDenied);
        }
        // Exclusive authenticated sessions and serial native dispatch fence the old writer.
        // A settled write advances this cursor even if its reply to the old writer was lost.
        terminal.next_input_sequence = None;
        terminal.lease.write_proof_input(sequence, data)?;
        terminal.next_input_sequence = sequence.checked_add(1);
        Ok(())
    }

    pub(super) fn terminal_status(&self, requested: &[u8]) -> Result<ProofTerminal, ErrorCode> {
        let terminal = self
            .terminal
            .as_ref()
            .filter(|terminal| requested == terminal.id)
            .ok_or(ErrorCode::OperationDenied)?;
        let status = terminal.lease.snapshot()?;
        Ok(ProofTerminal {
            lease: requested.to_vec(),
            pid: status.pid,
            live: status.live,
            sample: status.sample,
            birth_generation: terminal.birth_generation.map(Vec::from),
            next_input_sequence: status
                .live
                .then_some(terminal.next_input_sequence)
                .flatten(),
        })
    }

    pub(super) fn replay_terminal(
        &self,
        requested: &[u8],
        after: u64,
    ) -> Result<crate::v1::ProofTerminalReplay, ErrorCode> {
        let replay = self
            .leased_terminal(requested)?
            .replay_proof_terminal(after)?;
        Ok(crate::v1::ProofTerminalReplay {
            lease: requested.to_vec(),
            first_retained_sequence: replay.first_retained_sequence,
            next_sequence: replay.next_sequence,
            chunks: replay
                .chunks
                .into_iter()
                .map(|(sequence, data)| crate::v1::ProofTerminalReplayChunk { sequence, data })
                .collect(),
            gap: replay.gap,
        })
    }

    pub(super) fn close_terminal(&mut self, requested: &[u8]) -> Result<ProofTerminal, ErrorCode> {
        let terminal = self
            .terminal
            .as_ref()
            .filter(|terminal| requested == terminal.id)
            .ok_or(ErrorCode::OperationDenied)?;
        let pid = terminal.lease.pid();
        let birth_generation = terminal.birth_generation.map(Vec::from);
        self.revoke_terminal()?;
        Ok(ProofTerminal {
            lease: requested.to_vec(),
            pid,
            live: false,
            sample: Vec::new(),
            birth_generation,
            next_input_sequence: None,
        })
    }

    pub(super) fn revoke_terminal(&mut self) -> Result<(), ErrorCode> {
        if let Some(terminal) = self.terminal.as_ref() {
            self.terminal_uncertain = true;
            terminal.lease.revoke()?;
            self.terminal = None;
            self.terminal_uncertain = false;
        }
        if self.terminal_uncertain {
            return Err(ErrorCode::OutcomeUnknown);
        }
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_graphic())
}
