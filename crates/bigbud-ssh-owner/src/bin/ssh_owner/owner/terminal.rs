use std::time::{Duration, Instant};

use super::targets::LeaseScope;
use super::{ErrorCode, Owner, Token, random_token};
use crate::{
    owner_terminal::TerminalLease,
    v1::{ProofPrepareTerminal, ProofTerminal, ProofTerminalReservation},
};

const RESERVATION_TTL: Duration = Duration::from_secs(20);

pub(super) struct TerminalPreparation {
    lease: Token,
    /// The exact target and generation this reservation belongs to.
    scope: LeaseScope,
    cwd: String,
    cols: u16,
    rows: u16,
    /// U16 shell path, re-checked against the target's `/etc/shells` at launch.
    shell: Option<String>,
    expires: Instant,
}

pub(super) struct LiveTerminal {
    id: Token,
    /// The exact target and generation that opened this lease. A stale or
    /// foreign target cannot attach to, replay or close it.
    scope: LeaseScope,
    birth_generation: Option<Token>,
    // Mirrored only from positively settled writes. None fences input after ambiguity.
    next_input_sequence: Option<u64>,
    /// The production login shell's remote PID from the launch witness.
    shell_pid: Option<u32>,
    lease: TerminalLease,
}

impl LiveTerminal {
    fn owns(&self, target: &str, generation: Token) -> bool {
        self.scope.admits(target, generation)
    }

    /// Confirmed local teardown. The caller reports uncertainty; this only
    /// closes the native lease.
    pub(crate) fn revoke(&self) -> Result<(), ErrorCode> {
        self.lease.revoke()
    }
}

impl Owner {
    /// The terminal cwd is the request's own directory. Fixture mode stays
    /// exactly at the configured workspace root; a production target without a
    /// workspace root accepts any bounded absolute remote path.
    fn terminal_cwd_allowed(&self, cwd: &str) -> Result<bool, ErrorCode> {
        let transport = super::present(&self.transport)?;
        if transport.has_workspace_root() {
            return Ok(transport.matches_workspace_root(cwd));
        }
        Ok(self.production && valid_remote_cwd(cwd))
    }

    pub(super) fn prepare_terminal(
        &mut self,
        request: ProofPrepareTerminal,
    ) -> Result<ProofTerminalReservation, ErrorCode> {
        if self.lanes.terminal.is_some()
            || self
                .lanes
                .preparation
                .as_ref()
                .is_some_and(|prep| prep.expires > Instant::now())
        {
            return Err(ErrorCode::OperationDenied);
        }
        if !self.terminal_cwd_allowed(&request.cwd)?
            || !valid_id(&request.thread_id)
            || !valid_id(&request.terminal_id)
            || !(1..=400).contains(&request.cols)
            || !(1..=200).contains(&request.rows)
            || request
                .shell
                .as_deref()
                .is_some_and(|shell| !self.production || !inspect::valid_shell_path(shell))
        {
            return Err(ErrorCode::InvalidOperands);
        }
        let lease = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        self.lanes.preparation = Some(TerminalPreparation {
            lease,
            scope: LeaseScope::new(&self.target, self.generation),
            cwd: request.cwd,
            cols: u16::try_from(request.cols).map_err(|_| ErrorCode::InvalidOperands)?,
            rows: u16::try_from(request.rows).map_err(|_| ErrorCode::InvalidOperands)?,
            shell: request.shell,
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
            .lanes
            .preparation
            .as_ref()
            .filter(|prep| prep.lease == lease && prep.scope.admits(&self.target, self.generation))
            .ok_or(ErrorCode::OperationDenied)?;
        let receipt = ProofTerminalReservation {
            lease: prep.lease.to_vec(),
            cancelled: true,
        };
        self.lanes.preparation = None;
        Ok(receipt)
    }

    pub(super) fn open_terminal(&mut self, requested: &[u8]) -> Result<ProofTerminal, ErrorCode> {
        if self.lanes.terminal.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        // The empty-lease fixture path runs a fixed proof command. Production
        // never uses it: a real target always opens a reserved login shell.
        let fixture_open = !self.production
            && requested.is_empty()
            && self.lanes.preparation.is_none()
            && !super::present(&self.transport)?.has_workspace_root();
        let (id, launched) = if fixture_open {
            (
                random_token().map_err(|_| ErrorCode::OwnerUnavailable)?,
                super::present(&self.transport)?.open_proof_terminal(),
            )
        } else {
            let prepared = self
                .lanes
                .preparation
                .as_ref()
                .filter(|prep| {
                    prep.lease == requested
                        && prep.expires > Instant::now()
                        && prep.scope.admits(&self.target, self.generation)
                })
                .ok_or(ErrorCode::OperationDenied)?;
            let id = prepared.lease;
            let prep = self
                .lanes
                .preparation
                .take()
                .ok_or(ErrorCode::OperationDenied)?;
            let launched = if self.production {
                super::present(&self.transport)?.open_login_terminal(
                    &prep.cwd,
                    prep.cols,
                    prep.rows,
                    prep.shell.as_deref(),
                )
            } else {
                super::present(&self.transport)?
                    .open_prepared_terminal(&prep.cwd, prep.cols, prep.rows)
            };
            (id, launched)
        };
        let terminal = match launched {
            Ok(terminal) => terminal,
            Err(error) => {
                self.lanes.terminal_uncertain = error == ErrorCode::OutcomeUnknown;
                return Err(error);
            }
        };
        // A failed witness read leaves the PID unknown; `terminal_inspect` then
        // reports `outcome_unknown` instead of guessing a shell.
        let shell_pid = if self.production {
            terminal.login_shell_pid().ok().flatten()
        } else {
            None
        };
        self.lanes.terminal = Some(LiveTerminal {
            id,
            shell_pid,
            scope: LeaseScope::new(&self.target, self.generation),
            birth_generation: self.supervised_terminal.then_some(self.generation),
            next_input_sequence: self.supervised_terminal.then_some(1),
            lease: terminal,
        });
        self.terminal_status(&id)
    }

    fn live_terminal(&self, requested: &[u8]) -> Result<&LiveTerminal, ErrorCode> {
        self.lanes
            .terminal
            .as_ref()
            .filter(|terminal| {
                requested == terminal.id && terminal.owns(&self.target, self.generation)
            })
            .ok_or(ErrorCode::OperationDenied)
    }

    pub(super) fn leased_terminal(&self, requested: &[u8]) -> Result<&TerminalLease, ErrorCode> {
        self.live_terminal(requested)
            .map(|terminal| &terminal.lease)
    }

    pub(super) fn write_terminal_input(
        &mut self,
        requested: &[u8],
        sequence: u64,
        data: &[u8],
    ) -> Result<(), ErrorCode> {
        if self.live_terminal(requested).is_err() {
            return Err(ErrorCode::OperationDenied);
        }
        let terminal = self
            .lanes
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
        let terminal = self.live_terminal(requested)?;
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
        let terminal = self.live_terminal(requested)?;
        let pid = terminal.lease.pid();
        let birth_generation = terminal.birth_generation.map(Vec::from);
        self.lanes.revoke_terminal()?;
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
        self.lanes.revoke_terminal()
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_graphic())
}

/// A remote working directory is a single absolute operand. It is never
/// interpreted by the owner; the PTY wrapper quotes it for the target shell.
fn valid_remote_cwd(cwd: &str) -> bool {
    cwd.starts_with('/')
        && cwd.len() <= 4096
        && !cwd.contains('\0')
        && !cwd.chars().any(char::is_control)
}

#[path = "terminal_dispatch.rs"]
mod dispatch;
#[path = "terminal_inspect.rs"]
mod inspect;

#[cfg(test)]
#[path = "production_terminal_tests.rs"]
pub(super) mod production_tests;
#[cfg(test)]
#[path = "terminal.tests.rs"]
mod tests;
