use std::{
    io::{BufRead, BufReader},
    os::unix::fs::MetadataExt,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use super::stream::TransferExit;
use super::{
    LaunchAttempt, REAP_TIMEOUT, TransferAuthority, TransferGrant, TransferOperands, TransferVerb,
    validate_launch,
};
use crate::{
    Token,
    v1::{self, ErrorCode},
};

const POLL: Duration = Duration::from_millis(5);
const PROGRESS_QUEUE: usize = 16;
const MAX_PROGRESS_BYTES: usize = 8 * 1024;

/// One bounded progress sample. `phase` is an owner-compiled label.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TransferProgress {
    pub(super) phase: String,
    pub(super) bytes: u64,
    pub(super) items: u32,
}

/// The owner-compiled child recipe. `program`, `argv`, `ssh_program`,
/// `ssh_options`, `env` and `cwd` never come from a worker value.
pub(super) struct NativeTransferRecipe {
    program: PathBuf,
    argv: Vec<String>,
    ssh_program: PathBuf,
    ssh_options: Vec<String>,
    env: Vec<(String, String)>,
    cwd: PathBuf,
    max_progress_bytes: usize,
}

impl NativeTransferRecipe {
    pub(super) fn fixed(
        program: PathBuf,
        argv: Vec<String>,
        ssh_program: PathBuf,
        ssh_options: Vec<String>,
        env: Vec<(String, String)>,
        cwd: PathBuf,
    ) -> Self {
        Self {
            program,
            argv,
            ssh_program,
            ssh_options,
            env,
            cwd,
            max_progress_bytes: MAX_PROGRESS_BYTES,
        }
    }

    /// The exact `-e` executable the owner chose. Never worker-selected.
    pub(super) fn ssh_program(&self) -> &Path {
        &self.ssh_program
    }

    pub(super) fn argv(&self) -> &[String] {
        &self.argv
    }

    fn command(&self, operands: &TransferOperands) -> Result<Command, ErrorCode> {
        private_executable(&self.program)?;
        private_executable(&self.ssh_program)?;
        if operands.source.is_empty() || operands.destination.is_empty() {
            return Err(ErrorCode::InvalidOperands);
        }
        let mut command = Command::new(&self.program);
        command
            .args(&self.argv)
            .arg("-e")
            .arg(&self.ssh_program)
            .args(&self.ssh_options)
            .arg("--")
            .arg(&operands.source)
            .arg(&operands.destination)
            .env_clear()
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            // Diagnostics are not part of the transfer contract, and an unread
            // pipe would let the child stall on a full buffer.
            .stderr(Stdio::null())
            .process_group(0);
        for (key, value) in &self.env {
            command.env(key, value);
        }
        Ok(command)
    }
}

/// A local child charged to exactly one transfer lease. Its whole process tree
/// is signalled and reaped as one unit; the worker only supplies operands.
pub(super) struct SupervisedChild {
    lease: Token,
    child: Option<Child>,
    pgid: i32,
    progress: Receiver<TransferProgress>,
    reader: Option<JoinHandle<()>>,
    charged_trees: u32,
    cancelled: bool,
    settled: bool,
    uncertain: bool,
    exit: Option<TransferExit>,
    exit_taken: bool,
}

impl SupervisedChild {
    pub(super) fn spawn(
        mut grant: TransferGrant,
        recipe: &NativeTransferRecipe,
        operands: &TransferOperands,
        attempt: &LaunchAttempt,
    ) -> Result<Self, ErrorCode> {
        // Any caller-supplied executable, argv, env or SSH option is refused
        // typed before the recipe is even inspected.
        validate_launch(attempt)?;
        if grant.authority() != TransferAuthority::PackagedKey {
            return Err(ErrorCode::OperationDenied);
        }
        grant.enter(TransferVerb::PackagedRsync)?;
        let lease = crate::random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let mut command = recipe.command(operands)?;
        let mut child = command.spawn().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let Ok(pgid) = i32::try_from(child.id()) else {
            let _killed = child.kill();
            let _reaped = child.wait();
            return Err(ErrorCode::OwnerUnavailable);
        };
        let (send, progress) = mpsc::sync_channel(PROGRESS_QUEUE);
        let reader = child.stdout.take().map(|stdout| {
            let max = recipe.max_progress_bytes;
            thread::Builder::new()
                .name("bigbud-transfer-progress".into())
                .spawn(move || {
                    let mut reader = BufReader::new(stdout);
                    let mut line = String::new();
                    let mut total = 0usize;
                    while let Ok(read) = reader.read_line(&mut line) {
                        total = total.saturating_add(read);
                        if read == 0 || total > max {
                            break;
                        }
                        if let Some(sample) = parse_progress(line.trim_end()) {
                            // Bounded queue: a slow consumer loses samples and the
                            // reader never blocks the shutdown path.
                            if matches!(
                                send.try_send(sample),
                                Err(mpsc::TrySendError::Disconnected(_))
                            ) {
                                break;
                            }
                        }
                        line.clear();
                    }
                })
        });
        let reader = match reader {
            Some(Ok(reader)) => Some(reader),
            Some(Err(_)) => {
                let _killed = child.kill();
                let _reaped = child.wait();
                return Err(ErrorCode::OwnerUnavailable);
            }
            None => {
                let _killed = child.kill();
                let _reaped = child.wait();
                return Err(ErrorCode::OwnerUnavailable);
            }
        };
        Ok(Self {
            lease,
            child: Some(child),
            pgid,
            progress,
            reader,
            charged_trees: 1,
            cancelled: false,
            settled: false,
            uncertain: false,
            exit: None,
            exit_taken: false,
        })
    }

    pub(super) fn lease(&self) -> &Token {
        &self.lease
    }

    /// The bounded progress samples the worker consumes, as the reserved wire
    /// shape. Counters only; the owner selects the phase label.
    pub(super) fn progress(&self) -> Vec<v1::ProofTransferChildProgress> {
        let mut samples = Vec::new();
        loop {
            match self.progress.try_recv() {
                Ok(sample) => samples.push(v1::ProofTransferChildProgress {
                    lease: self.lease.to_vec(),
                    phase: sample.phase,
                    bytes: sample.bytes,
                    items: sample.items,
                }),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return samples,
            }
        }
    }

    /// Wait for the direct child and record its exact status once.
    pub(super) fn finish(&mut self) -> Result<TransferExit, ErrorCode> {
        if self.settled {
            return Err(ErrorCode::OperationDenied);
        }
        if !self.wait_until(Instant::now() + REAP_TIMEOUT)? {
            self.uncertain = true;
            self.settled = true;
            return Err(ErrorCode::OutcomeUnknown);
        }
        self.settled = true;
        self.exit.clone().ok_or(ErrorCode::OperationDenied)
    }

    /// Cancel exactly this lease and reap the whole tree.
    pub(super) fn cancel(&mut self, lease: &[u8]) -> Result<(), ErrorCode> {
        if lease != self.lease.as_slice() {
            return Err(ErrorCode::OperationDenied);
        }
        if self.settled {
            return Err(ErrorCode::OperationDenied);
        }
        self.signal_tree(libc::SIGKILL);
        if self.wait_until(Instant::now() + REAP_TIMEOUT)? {
            self.cancelled = true;
            self.exit = Some(TransferExit {
                code: None,
                signal: Some(libc::SIGKILL),
                cancelled: true,
            });
            self.settled = true;
            Ok(())
        } else {
            self.uncertain = true;
            self.settled = true;
            Err(ErrorCode::OutcomeUnknown)
        }
    }

    /// Signal and reap everything this lease charged, including a descendant
    /// that outlived the direct child.
    pub(super) fn kill_tree(&mut self) -> Result<(), ErrorCode> {
        self.signal_tree(libc::SIGKILL);
        let reaped = self.wait_until(Instant::now() + REAP_TIMEOUT)?;
        self.settled = true;
        if reaped {
            Ok(())
        } else {
            self.uncertain = true;
            Err(ErrorCode::OutcomeUnknown)
        }
    }

    /// The explicit exit. Available exactly once after a settled outcome.
    pub(super) fn exit(&mut self) -> Result<TransferExit, ErrorCode> {
        if self.uncertain {
            return Err(ErrorCode::OutcomeUnknown);
        }
        if !self.settled || self.exit_taken {
            return Err(ErrorCode::OperationDenied);
        }
        self.exit_taken = true;
        self.exit.clone().ok_or(ErrorCode::OperationDenied)
    }

    pub(super) fn state(&self) -> v1::ProofTransferChildState {
        v1::ProofTransferChildState {
            lease: self.lease.to_vec(),
            exited: self.exit.is_some(),
            exit_code: self.exit.as_ref().and_then(|exit| exit.code),
            exit_signal: self.exit.as_ref().and_then(|exit| exit.signal),
            cancelled: self.cancelled,
            charged_trees: self.charged_trees,
        }
    }

    /// A lost control transport cannot confirm the tree's fate.
    pub(super) fn mark_transport_lost(&mut self) {
        self.signal_tree(libc::SIGKILL);
        self.uncertain = true;
        self.settled = true;
    }

    #[cfg(test)]
    pub(super) fn charged_trees(&self) -> u32 {
        self.charged_trees
    }

    fn signal_tree(&self, signal: i32) {
        // SAFETY: a negative pid targets only the process group created for this
        // lease; the owner never signals a worker-supplied pid.
        let _signalled = unsafe { libc::kill(-self.pgid, signal) };
    }

    fn wait_until(&mut self, deadline: Instant) -> Result<bool, ErrorCode> {
        loop {
            let Some(child) = &mut self.child else {
                return Ok(true);
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.exit = Some(status.into());
                    self.child = None;
                    return Ok(true);
                }
                Ok(None) => {}
                Err(_) => return Err(ErrorCode::OutcomeUnknown),
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            thread::sleep(remaining.min(POLL));
        }
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        self.signal_tree(libc::SIGKILL);
        let _reaped = self.wait_until(Instant::now() + REAP_TIMEOUT);
        if let Some(reader) = self.reader.take() {
            let _joined = reader.join();
        }
    }
}

fn parse_progress(line: &str) -> Option<TransferProgress> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "progress" {
        return None;
    }
    let bytes = parts.next()?.parse().ok()?;
    let items = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(TransferProgress {
        phase: "progress".into(),
        bytes,
        items,
    })
}

/// The owner-compiled fixtures must be absolute, private same-user executables.
fn private_executable(path: &Path) -> Result<(), ErrorCode> {
    let name = path.to_str().ok_or(ErrorCode::OperationDenied)?;
    if !path.is_absolute() || name.chars().any(char::is_control) {
        return Err(ErrorCode::OperationDenied);
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ErrorCode::OperationDenied)?;
    // SAFETY: geteuid observes only the current process.
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || metadata.mode() & 0o111 == 0
    {
        return Err(ErrorCode::OperationDenied);
    }
    Ok(())
}
