//! U25 remote-agent control parity: one owner-compiled recipe per
//! `AgentControlKind`.
//!
//! The request names a kind and validated data operands only. This module
//! refuses any operand outside the kind, picks the generated template (the
//! legacy builder's own text with each operand bound to one positional
//! argument), the legacy deadline and the legacy output cap, and builds one
//! remote command. The template recomputes the control root on the host and
//! refuses a runtime outside its canonical layout (exit 86).

mod operands;
mod templates;

pub(crate) use operands::runtime as runtime_operands;

use crate::owner_backend::deployment_recipe::Recipe;
use crate::v1::{AgentControlKind as Kind, AgentControlOpen, AgentObserveMode as Mode, ErrorCode};
use operands::check;
use std::time::Duration;
use templates as t;

/// Registry bytes are bounded on the host at 1 MiB (`MAX_REMOTE_AGENT_REGISTRY_BYTES`).
const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
/// A remote agent artifact; far above any release build, far below the archive bound.
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const CONTROL_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Runtime,
    Mode,
    Attempt,
    Epoch,
    OldAttempt,
    OldEpoch,
    Reservation,
    Fence,
    Version,
    Sha,
    Size,
    BinaryPath,
    Expected,
    Next,
}

const ALL: [Field; 14] = [
    Field::Runtime,
    Field::Mode,
    Field::Attempt,
    Field::Epoch,
    Field::OldAttempt,
    Field::OldEpoch,
    Field::Reservation,
    Field::Fence,
    Field::Version,
    Field::Sha,
    Field::Size,
    Field::BinaryPath,
    Field::Expected,
    Field::Next,
];

fn present(open: &AgentControlOpen, field: Field) -> bool {
    match field {
        Field::Runtime => open.runtime.is_some(),
        Field::Mode => open.observe_mode != 0,
        Field::Attempt => !open.attempt_id.is_empty(),
        Field::Epoch => !open.epoch.is_empty(),
        Field::OldAttempt => !open.old_attempt_id.is_empty(),
        Field::OldEpoch => !open.old_epoch.is_empty(),
        Field::Reservation => !open.reservation_id.is_empty(),
        Field::Fence => !open.fence_id.is_empty(),
        Field::Version => !open.version.is_empty(),
        Field::Sha => !open.sha256.is_empty(),
        Field::Size => open.size != 0,
        Field::BinaryPath => !open.binary_path.is_empty(),
        Field::Expected => {
            open.expected_present || open.expected_size != 0 || !open.expected_sha256.is_empty()
        }
        Field::Next => open.next_size != 0 || !open.next_sha256.is_empty(),
    }
}

fn only(open: &AgentControlOpen, allowed: &[Field]) -> Result<(), ErrorCode> {
    check(
        !ALL.iter()
            .any(|field| !allowed.contains(field) && present(open, *field)),
    )
}

/// One compiled kind before it is framed into a command.
struct Plan {
    template: &'static str,
    args: Vec<String>,
    streamed: bool,
    deadline: u64,
    output: usize,
}

impl Plan {
    fn new(template: &'static str, args: Vec<String>) -> Self {
        Self {
            template,
            args,
            streamed: false,
            deadline: 30,
            output: CONTROL_OUTPUT,
        }
    }

    fn bounded(mut self, deadline: u64, output: usize) -> Self {
        self.deadline = deadline;
        self.output = output;
        self
    }

    fn streamed(mut self) -> Self {
        self.streamed = true;
        self
    }
}

fn observe_template(mode: i32) -> Result<&'static str, ErrorCode> {
    Ok(
        match Mode::try_from(mode).map_err(|_| ErrorCode::InvalidOperands)? {
            Mode::RetirementState => t::SUPERVISOR_OBSERVE_RETIREMENT_STATE,
            Mode::RetirementExit => t::SUPERVISOR_OBSERVE_RETIREMENT_EXIT,
            Mode::LaunchExit => t::SUPERVISOR_OBSERVE_LAUNCH_EXIT,
            Mode::Raw => t::SUPERVISOR_OBSERVE_RAW,
            Mode::CandidateStartup => t::SUPERVISOR_OBSERVE_CANDIDATE_STARTUP,
            Mode::CandidateExit => t::SUPERVISOR_OBSERVE_CANDIDATE_EXIT,
            Mode::ReplacementReadiness => t::SUPERVISOR_OBSERVE_REPLACEMENT_READINESS,
            Mode::ReplacementDeath => t::SUPERVISOR_OBSERVE_REPLACEMENT_DEATH,
            Mode::Unspecified => return Err(ErrorCode::InvalidOperands),
        },
    )
}

/// Validate one request and compile its remote command.
pub(crate) fn recipe(open: &AgentControlOpen) -> Result<Recipe, ErrorCode> {
    let kind = Kind::try_from(open.kind).map_err(|_| ErrorCode::InvalidOperands)?;
    let plan = plan(kind, open)?;
    // Every operand is a validated quote-safe word; single quoting is exact.
    let mut command = format!("exec sh -lc {} bigbud-agent-control", quote(plan.template));
    for arg in &plan.args {
        command.push(' ');
        command.push_str(&quote(arg));
    }
    Ok(Recipe {
        command,
        streamed_input: plan.streamed,
        deadline: Duration::from_secs(plan.deadline),
        stdout_limit: plan.output,
    })
}

fn plan(kind: Kind, open: &AgentControlOpen) -> Result<Plan, ErrorCode> {
    use Field as F;
    let runtime = || {
        let runtime = open.runtime.as_ref().ok_or(ErrorCode::InvalidOperands)?;
        operands::runtime(runtime)
    };
    let managed_runtime = || {
        let runtime = open.runtime.as_ref().ok_or(ErrorCode::InvalidOperands)?;
        check(operands::managed(runtime))?;
        operands::runtime(runtime)
    };
    let attempt = |value: &str| check(operands::id(value, 1, 64)).map(|()| value.to_owned());
    let epoch = |value: &str| check(operands::printable(value, 256)).map(|()| value.to_owned());
    let reservation = || {
        check(operands::id(&open.reservation_id, 1, 128))?;
        Ok::<_, ErrorCode>(open.reservation_id.clone())
    };
    let artifact = || {
        check(operands::version(&open.version) && operands::sha256(&open.sha256))?;
        check((1..=MAX_ARTIFACT_BYTES).contains(&open.size))?;
        Ok::<_, ErrorCode>(vec![
            open.version.clone(),
            open.sha256.clone(),
            open.size.to_string(),
        ])
    };
    let plain = |template| only(open, &[]).map(|()| Plan::new(template, Vec::new()));
    Ok(match kind {
        Kind::Unspecified => return Err(ErrorCode::InvalidOperands),
        Kind::ControlRoot => plain(t::CONTROL_ROOT)?,
        Kind::RegistryRead => plain(t::REGISTRY_READ)?,
        Kind::RegistryCas => {
            only(open, &[F::Expected, F::Next])?;
            check(operands::sha256(&open.next_sha256))?;
            check((1..=MAX_REGISTRY_BYTES).contains(&open.next_size))?;
            let next = [open.next_size.to_string(), open.next_sha256.clone()];
            if open.expected_present {
                check(operands::sha256(&open.expected_sha256))?;
                check(open.expected_size <= MAX_REGISTRY_BYTES)?;
                let mut args = vec![open.expected_size.to_string(), open.expected_sha256.clone()];
                args.extend(next);
                Plan::new(t::REGISTRY_CAS_PRESENT, args).streamed()
            } else {
                check(open.expected_size == 0 && open.expected_sha256.is_empty())?;
                Plan::new(t::REGISTRY_CAS_ABSENT, next.to_vec()).streamed()
            }
        }
        Kind::StageFenceRevoke => {
            only(open, &[F::Reservation])?;
            Plan::new(t::STAGE_FENCE_REVOKE, vec![reservation()?])
        }
        Kind::Inventory => plain(t::INVENTORY)?,
        Kind::SupervisorObserve => {
            only(open, &[F::Runtime, F::Mode, F::Attempt])?;
            let mut args = runtime()?;
            args.push(attempt(&open.attempt_id)?);
            Plan::new(observe_template(open.observe_mode)?, args)
        }
        Kind::AdmissionDeathObserve => {
            only(open, &[F::Runtime, F::Attempt, F::Epoch])?;
            let mut args = runtime()?;
            args.push(attempt(&open.attempt_id)?);
            args.push(epoch(&open.epoch)?);
            Plan::new(t::ADMISSION_DEATH_OBSERVE, args)
        }
        Kind::StateAbsent => {
            only(open, &[F::Runtime]).and_then(|()| Ok(Plan::new(t::STATE_ABSENT, runtime()?)))?
        }
        Kind::SupervisorShutdown => only(open, &[F::Runtime])
            .and_then(|()| Ok(Plan::new(t::SUPERVISOR_SHUTDOWN, runtime()?)))?,
        Kind::SupervisorRestart => only(open, &[F::Runtime])
            .and_then(|()| Ok(Plan::new(t::SUPERVISOR_RESTART, runtime()?)))?,
        Kind::IsolatedLaunch => {
            only(open, &[F::Runtime, F::Attempt])?;
            let mut args = managed_runtime()?;
            args.push(attempt(&open.attempt_id)?);
            Plan::new(t::ISOLATED_LAUNCH, args)
        }
        Kind::ReplacementLaunch => {
            only(open, &[F::Runtime, F::Attempt, F::OldEpoch, F::OldAttempt])?;
            let mut args = managed_runtime()?;
            args.push(attempt(&open.attempt_id)?);
            args.push(epoch(&open.old_epoch)?);
            args.push(attempt(&open.old_attempt_id)?);
            Plan::new(t::REPLACEMENT_LAUNCH, args)
        }
        Kind::RetirementDelete => only(open, &[F::Runtime])
            .and_then(|()| Ok(Plan::new(t::RETIREMENT_DELETE, managed_runtime()?)))?,
        Kind::Removal => {
            only(open, &[F::Fence])?;
            check(operands::id(&open.fence_id, 8, 64))?;
            Plan::new(t::REMOVAL, vec![open.fence_id.clone()]).bounded(600, CONTROL_OUTPUT)
        }
        Kind::RemovalResume => plain(t::REMOVAL_RESUME)?.bounded(600, CONTROL_OUTPUT),
        Kind::RemovalOutcome => plain(t::REMOVAL_OUTCOME)?,
        Kind::HostClock => plain(t::HOST_CLOCK)?,
        Kind::OrphanDelete => {
            only(open, &[F::Version, F::Sha])?;
            check(operands::version(&open.version) && operands::sha256(&open.sha256))?;
            Plan::new(
                t::ORPHAN_DELETE,
                vec![open.version.clone(), open.sha256.clone()],
            )
        }
        Kind::BackendRuntimeProbe => plain(t::BACKEND_RUNTIME_PROBE)?,
        Kind::SocketLive | Kind::SocketGone => {
            only(open, &[F::Runtime])?;
            let args = runtime()?;
            // The liveness test matches `/proc/net/unix` textually.
            check(
                open.runtime
                    .as_ref()
                    .is_some_and(|r| operands::no_whitespace(&r.socket_path)),
            )?;
            let template = if kind == Kind::SocketLive {
                t::SOCKET_LIVE
            } else {
                t::SOCKET_GONE
            };
            Plan::new(template, args)
        }
        Kind::RuntimeProbe => {
            only(open, &[F::BinaryPath])?;
            if open.binary_path.is_empty() {
                Plan::new(t::RUNTIME_PROBE_DEFAULT, Vec::new())
            } else {
                check(operands::exact_path(&open.binary_path))?;
                Plan::new(t::RUNTIME_PROBE_EXTERNAL, vec![open.binary_path.clone()])
            }
        }
        Kind::PlatformProbe => plain(t::PLATFORM_PROBE)?.bounded(8, 4096),
        Kind::ReadOnlyStatus => plain(t::READ_ONLY_STATUS)?.bounded(15, 1024 * 1024 + 16),
        Kind::InstallUpload | Kind::InboxAdopt => {
            only(open, &[F::Version, F::Sha, F::Size, F::Reservation])?;
            let mut args = artifact()?;
            let reserved = !open.reservation_id.is_empty();
            if reserved {
                args.push(reservation()?);
            }
            let template = match (kind == Kind::InstallUpload, reserved) {
                (true, true) => t::INSTALL_UPLOAD_RESERVED,
                (true, false) => t::INSTALL_UPLOAD_UNRESERVED,
                (false, true) => t::INBOX_ADOPT_RESERVED,
                (false, false) => t::INBOX_ADOPT_UNRESERVED,
            };
            let plan = Plan::new(template, args).bounded(60, 64 * 1024);
            if kind == Kind::InstallUpload {
                plan.streamed()
            } else {
                plan
            }
        }
        Kind::PlacedProbe => {
            only(open, &[F::Version, F::Sha, F::Size])?;
            Plan::new(t::PLACED_PROBE, artifact()?).bounded(30, 1024)
        }
        Kind::IdentityCheck => {
            only(open, &[F::Version, F::Sha, F::BinaryPath])?;
            let plan = if !open.binary_path.is_empty() {
                check(open.version.is_empty() && open.sha256.is_empty())?;
                check(operands::exact_path(&open.binary_path))?;
                Plan::new(t::IDENTITY_CHECK_PATH, vec![open.binary_path.clone()])
            } else if open.version.is_empty() && open.sha256.is_empty() {
                Plan::new(t::IDENTITY_CHECK_DEFAULT, Vec::new())
            } else {
                check(operands::version(&open.version) && operands::sha256(&open.sha256))?;
                Plan::new(
                    t::IDENTITY_CHECK,
                    vec![open.version.clone(), open.sha256.clone()],
                )
            };
            plan.bounded(30, 64 * 1024)
        }
    })
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
#[path = "owner_agent_control/tests.rs"]
mod tests;
