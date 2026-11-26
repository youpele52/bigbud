//! W2 T-term: one dispatcher for every terminal verb, so the shared owner
//! dispatcher carries a single terminal arm. Fixture and production verbs keep
//! their own admission in `owner/admission.rs`.

use super::super::{ErrorCode, Operation, Outcome, Owner};

impl Owner {
    pub(in super::super) fn dispatch_terminal(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        match operation {
            Operation::ProofPrepareTerminal(request) => self
                .prepare_terminal(request)
                .map(Outcome::ProofTerminalReservation),
            Operation::ProofCancelTerminalReservation(request) => self
                .cancel_terminal_reservation(&request.lease)
                .map(Outcome::ProofTerminalReservation),
            Operation::ProofOpenTerminal(request) => self
                .open_terminal(&request.lease)
                .map(Outcome::ProofTerminal),
            Operation::ProofTerminalCwd(request) => super::super::present(&self.transport)?
                .probe_terminal_cwd(request)
                .map(Outcome::ProofTerminalCwd),
            Operation::ProofTerminalReplay(request) => self
                .replay_terminal(&request.lease, request.after_sequence)
                .map(Outcome::ProofTerminalReplay),
            Operation::ProofTerminalStatus(handle) => self
                .terminal_status(&handle.lease)
                .map(Outcome::ProofTerminal),
            Operation::ProofCloseTerminal(handle) => self
                .close_terminal(&handle.lease)
                .map(Outcome::ProofTerminal),
            Operation::ProofTerminalInput(input) => self
                .write_terminal_input(&input.lease, input.sequence, &input.data)
                .and_then(|()| self.terminal_status(&input.lease))
                .map(Outcome::ProofTerminal),
            Operation::ProofTerminalResize(input) => self
                .leased_terminal(&input.lease)
                .and_then(|terminal| {
                    let cols = u16::try_from(input.cols).map_err(|_| ErrorCode::InvalidOperands)?;
                    let rows = u16::try_from(input.rows).map_err(|_| ErrorCode::InvalidOperands)?;
                    terminal.resize_proof_terminal(cols, rows)
                })
                .and_then(|()| self.terminal_status(&input.lease))
                .map(Outcome::ProofTerminal),
            Operation::TerminalInspect(request) => self
                .inspect_terminal(&request)
                .map(Outcome::TerminalProcesses),
            Operation::ListTerminalShells(_) => {
                self.list_terminal_shells().map(Outcome::TerminalShells)
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }
}
