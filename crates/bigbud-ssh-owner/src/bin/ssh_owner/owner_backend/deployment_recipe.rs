//! Owner-compiled remote recipe for one production deployment step.
//!
//! The request names a step kind and validated data operands only. This module
//! rejects any operand outside its kind, picks the fixed deadline and output
//! caps, and builds one remote command around the bundled step script. The
//! remote layout and exit codes are the legacy runner's, so a published
//! install from either path is the same install.

use super::deployment_operands::{
    valid_authority, valid_digest, valid_graph_path, valid_home, valid_install_name,
    valid_request_id, valid_url,
};
use crate::v1::{DeploymentSetupInput, DeploymentStepKind as Kind, DeploymentStepOpen, ErrorCode};
use std::time::Duration;

const SCRIPT: &str = include_str!("deployment_step.sh");
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SETUP_INPUT_BYTES: u64 = 1024 * 1024;
const PINS: usize = 3;

/// One validated step: the remote command, whether input arrives on the lease
/// socket, the hard deadline and the stdout cap (stderr is capped separately).
#[derive(Debug)]
pub(crate) struct Recipe {
    pub(crate) command: String,
    pub(crate) streamed_input: bool,
    pub(crate) deadline: Duration,
    pub(crate) stdout_limit: usize,
}

/// Every operand a request may carry. A kind admits exactly its own set; any
/// other non-default operand is `InvalidOperands`, so nothing unused can ride
/// along on a step.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Home,
    Install,
    Archive,
    Manifest,
    Url,
    MaxBytes,
    SetupInput,
    InputSha,
    Node,
    Entry,
    Pins,
    Authority,
    EnableBoot,
}

fn present(open: &DeploymentStepOpen, field: Field) -> bool {
    match field {
        Field::Home => !open.home.is_empty(),
        Field::Install => !open.install_name.is_empty(),
        Field::Archive => !open.archive_sha256.is_empty(),
        Field::Manifest => !open.manifest_sha256.is_empty(),
        Field::Url => !open.url.is_empty(),
        Field::MaxBytes => open.max_bytes != 0,
        Field::SetupInput => open.setup_input != 0,
        Field::InputSha => !open.input_sha256.is_empty(),
        Field::Node => !open.node_path.is_empty(),
        Field::Entry => !open.entry_path.is_empty(),
        Field::Pins => !open.pins.is_empty(),
        Field::Authority => !open.authority_id.is_empty(),
        Field::EnableBoot => open.enable_boot,
    }
}

const ALL: [Field; 13] = [
    Field::Home,
    Field::Install,
    Field::Archive,
    Field::Manifest,
    Field::Url,
    Field::MaxBytes,
    Field::SetupInput,
    Field::InputSha,
    Field::Node,
    Field::Entry,
    Field::Pins,
    Field::Authority,
    Field::EnableBoot,
];

fn only(open: &DeploymentStepOpen, allowed: &[Field]) -> Result<(), ErrorCode> {
    if ALL
        .iter()
        .any(|field| !allowed.contains(field) && present(open, *field))
    {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(())
}

fn check(valid: bool) -> Result<(), ErrorCode> {
    if valid {
        Ok(())
    } else {
        Err(ErrorCode::InvalidOperands)
    }
}

/// Validate one step and compile its remote command.
pub(crate) fn recipe(open: &DeploymentStepOpen) -> Result<Recipe, ErrorCode> {
    let kind = Kind::try_from(open.kind).map_err(|_| ErrorCode::InvalidOperands)?;
    let request = open.request_id.as_str();
    let needs_request = !matches!(kind, Kind::Start | Kind::ReadCompletion);
    check(if needs_request {
        valid_request_id(request)
    } else {
        request.is_empty()
    })?;
    let home = || check(valid_home(&open.home)).map(|()| open.home.clone());
    // Staging steps resolve the account home remotely, as the legacy runner
    // did; when the caller names one, the recipe refuses a different home.
    let staged_home = || {
        if open.home.is_empty() {
            Ok("-".to_owned())
        } else {
            home()
        }
    };
    let install = || check(valid_install_name(&open.install_name));
    let digest = |value: &str| check(valid_digest(value));
    let graph = |value: &str| check(valid_graph_path(value));
    let size = |max: u64| check(open.max_bytes > 0 && open.max_bytes <= max);
    use Field as F;
    let (home, operands, streamed, deadline, stdout): (String, Vec<String>, bool, u64, usize) =
        match kind {
            Kind::Unspecified => return Err(ErrorCode::InvalidOperands),
            Kind::ProbeHost => {
                only(open, &[])?;
                (
                    "-".into(),
                    vec!["probe".into(), request.into()],
                    false,
                    30,
                    256 * 1024,
                )
            }
            Kind::StageBegin => {
                only(open, &[F::Home, F::Install, F::Archive, F::Manifest])?;
                install()?;
                digest(&open.archive_sha256)?;
                digest(&open.manifest_sha256)?;
                let args = vec![
                    "begin".into(),
                    request.into(),
                    open.install_name.clone(),
                    open.archive_sha256.clone(),
                    open.manifest_sha256.clone(),
                ];
                (staged_home()?, args, false, 60, 1024)
            }
            Kind::ManifestPut => {
                only(open, &[F::Home, F::InputSha, F::MaxBytes])?;
                digest(&open.input_sha256)?;
                size(MAX_MANIFEST_BYTES)?;
                let args = vec![
                    "put-manifest".into(),
                    request.into(),
                    open.input_sha256.clone(),
                    open.max_bytes.to_string(),
                ];
                (staged_home()?, args, true, 60, 1024)
            }
            Kind::SetupInputPut => {
                only(open, &[F::Home, F::SetupInput, F::InputSha, F::MaxBytes])?;
                digest(&open.input_sha256)?;
                size(MAX_SETUP_INPUT_BYTES)?;
                let name = match DeploymentSetupInput::try_from(open.setup_input) {
                    Ok(DeploymentSetupInput::RustManifest) => "rust-manifest.json",
                    Ok(DeploymentSetupInput::TrustedKeys) => "trusted-keys.json",
                    _ => return Err(ErrorCode::InvalidOperands),
                };
                let args = vec![
                    "put-input".into(),
                    request.into(),
                    name.into(),
                    open.input_sha256.clone(),
                    open.max_bytes.to_string(),
                ];
                (staged_home()?, args, true, 60, 8 * 1024)
            }
            Kind::ArchiveFetch => {
                only(open, &[F::Home, F::Archive, F::Url, F::MaxBytes])?;
                digest(&open.archive_sha256)?;
                check(valid_url(&open.url))?;
                size(MAX_ARCHIVE_BYTES)?;
                let args = vec![
                    "fetch-url".into(),
                    request.into(),
                    open.archive_sha256.clone(),
                    open.url.clone(),
                    open.max_bytes.to_string(),
                ];
                (staged_home()?, args, false, 30 * 60, 1024)
            }
            Kind::ArchiveUpload => {
                only(open, &[F::Home, F::InputSha, F::MaxBytes])?;
                digest(&open.input_sha256)?;
                size(MAX_ARCHIVE_BYTES)?;
                let args = vec![
                    "fetch-stdin".into(),
                    request.into(),
                    open.input_sha256.clone(),
                    open.max_bytes.to_string(),
                ];
                (staged_home()?, args, true, 30 * 60, 1024)
            }
            Kind::Publish => {
                only(
                    open,
                    &[F::Home, F::Install, F::Archive, F::Manifest, F::Pins],
                )?;
                install()?;
                digest(&open.archive_sha256)?;
                digest(&open.manifest_sha256)?;
                check(open.pins.len() == PINS)?;
                let mut args = vec![
                    "commit".into(),
                    request.into(),
                    open.install_name.clone(),
                    open.archive_sha256.clone(),
                    open.manifest_sha256.clone(),
                ];
                for pin in &open.pins {
                    graph(&pin.path)?;
                    digest(&pin.sha256)?;
                    args.push(pin.path.clone());
                    args.push(pin.sha256.clone());
                }
                (staged_home()?, args, false, 10 * 60, 1024)
            }
            Kind::Setup => {
                only(open, &[F::Home, F::Install, F::Node, F::Entry])?;
                install()?;
                graph(&open.node_path)?;
                graph(&open.entry_path)?;
                let args = vec![
                    "setup".into(),
                    request.into(),
                    open.install_name.clone(),
                    open.node_path.clone(),
                    open.entry_path.clone(),
                ];
                (home()?, args, false, 20 * 60, 256 * 1024)
            }
            Kind::Start => {
                only(
                    open,
                    &[
                        F::Home,
                        F::Install,
                        F::Node,
                        F::Entry,
                        F::Authority,
                        F::EnableBoot,
                    ],
                )?;
                install()?;
                graph(&open.node_path)?;
                graph(&open.entry_path)?;
                check(valid_authority(&open.authority_id))?;
                let args = vec![
                    "start".into(),
                    open.install_name.clone(),
                    open.node_path.clone(),
                    open.entry_path.clone(),
                    open.authority_id.clone(),
                    if open.enable_boot { "1" } else { "0" }.into(),
                ];
                (home()?, args, false, 5 * 60, 256 * 1024)
            }
            Kind::ReadCompletion => {
                only(open, &[F::Authority])?;
                check(valid_authority(&open.authority_id))?;
                let args = vec!["read-completion".into(), open.authority_id.clone()];
                ("-".into(), args, false, 30, 16 * 1024)
            }
            Kind::Reset => {
                only(open, &[F::Home])?;
                (
                    staged_home()?,
                    vec!["reset".into(), request.into()],
                    false,
                    60,
                    1024,
                )
            }
        };
    // Each operand above is restricted to a quote-free ASCII set, so single
    // quoting is exact; the script rechecks every one of them remotely.
    let (op, rest) = operands.split_first().ok_or(ErrorCode::InvalidOperands)?;
    let mut command = format!(
        "exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /bin/sh -c {} bigbud-deploy {} {}",
        quote(SCRIPT),
        quote(op),
        quote(&home),
    );
    for operand in rest {
        command.push(' ');
        command.push_str(&quote(operand));
    }
    Ok(Recipe {
        command,
        streamed_input: streamed,
        deadline: Duration::from_secs(deadline),
        stdout_limit: stdout,
    })
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
#[path = "deployment_recipe/tests.rs"]
mod tests;
