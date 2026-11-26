use super::{recipe, valid_request_id};
use crate::v1::{
    DeploymentPin, DeploymentSetupInput, DeploymentStepKind as Kind, DeploymentStepOpen, ErrorCode,
};
use std::time::Duration;

const REQUEST: &str = "0123abcd-0123-4abc-8def-0123456789ab";
const HOME: &str = "/home/bbdev";
const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const M: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const INSTALL: &str = "1.2.3-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa";
const AUTHORITY: &str = "0123456789abcdef0123456789abcdef";

fn step(kind: Kind) -> DeploymentStepOpen {
    DeploymentStepOpen {
        lease: vec![7; 32],
        kind: kind.into(),
        request_id: REQUEST.into(),
        home: HOME.into(),
        ..DeploymentStepOpen::default()
    }
}

fn pins() -> Vec<DeploymentPin> {
    [
        "node/bin/node",
        "server/dist/bin.mjs",
        "server/dist/remote-client-relay/r.mjs",
    ]
    .into_iter()
    .map(|path| DeploymentPin {
        path: path.into(),
        sha256: A.into(),
    })
    .collect()
}

fn valid(kind: Kind) -> DeploymentStepOpen {
    let mut open = step(kind);
    match kind {
        Kind::ProbeHost => open.home.clear(),
        Kind::StageBegin => {
            open.install_name = INSTALL.into();
            open.archive_sha256 = A.into();
            open.manifest_sha256 = M.into();
        }
        Kind::ManifestPut | Kind::ArchiveUpload => {
            open.input_sha256 = M.into();
            open.max_bytes = 1024;
        }
        Kind::SetupInputPut => {
            open.setup_input = DeploymentSetupInput::TrustedKeys.into();
            open.input_sha256 = M.into();
            open.max_bytes = 64;
        }
        Kind::ArchiveFetch => {
            open.archive_sha256 = A.into();
            open.url = "https://example.invalid/graph.tar.gz".into();
            open.max_bytes = 1 << 30;
        }
        Kind::Publish => {
            open.install_name = INSTALL.into();
            open.archive_sha256 = A.into();
            open.manifest_sha256 = M.into();
            open.pins = pins();
        }
        Kind::Setup => {
            open.install_name = INSTALL.into();
            open.node_path = "node/bin/node".into();
            open.entry_path = "server/dist/bin.mjs".into();
        }
        Kind::Start => {
            open.request_id.clear();
            open.install_name = INSTALL.into();
            open.node_path = "node/bin/node".into();
            open.entry_path = "server/dist/bin.mjs".into();
            open.authority_id = AUTHORITY.into();
            open.enable_boot = true;
        }
        Kind::ReadCompletion => {
            open.request_id.clear();
            open.home.clear();
            open.authority_id = AUTHORITY.into();
        }
        Kind::Reset | Kind::Unspecified => {}
    }
    open
}

const KINDS: [Kind; 11] = [
    Kind::ProbeHost,
    Kind::StageBegin,
    Kind::ManifestPut,
    Kind::SetupInputPut,
    Kind::ArchiveFetch,
    Kind::ArchiveUpload,
    Kind::Publish,
    Kind::Setup,
    Kind::Start,
    Kind::ReadCompletion,
    Kind::Reset,
];

#[test]
fn every_kind_compiles_one_fixed_command_with_its_own_deadline() {
    for kind in KINDS {
        let compiled = recipe(&valid(kind)).unwrap_or_else(|error| panic!("{kind:?}: {error:?}"));
        assert!(
            compiled
                .command
                .starts_with("exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /bin/sh -c '"),
            "{kind:?}"
        );
        assert_eq!(
            compiled.streamed_input,
            matches!(
                kind,
                Kind::ManifestPut | Kind::SetupInputPut | Kind::ArchiveUpload
            ),
            "{kind:?}"
        );
        assert!(compiled.deadline >= Duration::from_secs(30), "{kind:?}");
        assert!(
            compiled.deadline <= Duration::from_secs(30 * 60),
            "{kind:?}"
        );
    }
    let setup = recipe(&valid(Kind::Setup)).map(|r| r.command);
    assert!(setup.is_ok_and(|command| command.ends_with(&format!(
        "bigbud-deploy 'setup' '{HOME}' '{REQUEST}' '{INSTALL}' 'node/bin/node' 'server/dist/bin.mjs'"
    ))));
    let probe = recipe(&valid(Kind::ProbeHost)).map(|r| r.command);
    assert!(probe.is_ok_and(|command| command.ends_with(&format!("'probe' '-' '{REQUEST}'"))));
}

#[test]
fn legacy_deadlines_are_kept() {
    let deadline = |kind| recipe(&valid(kind)).map(|r| r.deadline.as_secs());
    assert_eq!(deadline(Kind::ProbeHost), Ok(30));
    assert_eq!(deadline(Kind::StageBegin), Ok(60));
    assert_eq!(deadline(Kind::ArchiveFetch), Ok(1800));
    assert_eq!(deadline(Kind::ArchiveUpload), Ok(1800));
    assert_eq!(deadline(Kind::Publish), Ok(600));
    assert_eq!(deadline(Kind::Setup), Ok(1200));
    assert_eq!(deadline(Kind::Start), Ok(300));
    assert_eq!(deadline(Kind::ReadCompletion), Ok(30));
}

#[test]
fn an_operand_outside_the_kind_is_refused() {
    for kind in KINDS {
        let mut open = valid(kind);
        if open.url.is_empty() {
            open.url = "https://example.invalid/x".into();
        } else {
            open.authority_id = AUTHORITY.into();
        }
        assert_eq!(
            recipe(&open).map(|_| ()),
            Err(ErrorCode::InvalidOperands),
            "{kind:?}"
        );
    }
}

#[test]
fn malformed_operands_never_compile() {
    let invalid = |mutate: fn(&mut DeploymentStepOpen), kind| {
        let mut open = valid(kind);
        mutate(&mut open);
        recipe(&open).map(|_| ())
    };
    let refused = Err(ErrorCode::InvalidOperands);
    assert_eq!(invalid(|o| o.kind = 99, Kind::Reset), refused);
    assert_eq!(invalid(|o| o.request_id = "x".into(), Kind::Reset), refused);
    assert_eq!(
        invalid(|o| o.home = "relative".into(), Kind::Reset),
        refused
    );
    assert_eq!(
        invalid(|o| o.home = "/home/../etc".into(), Kind::Reset),
        refused
    );
    assert_eq!(
        invalid(|o| o.home = "/home/a b".into(), Kind::Reset),
        refused
    );
    assert_eq!(
        invalid(|o| o.home = "/home/it's".into(), Kind::Reset),
        refused
    );
    assert_eq!(
        invalid(|o| o.install_name = "../x".into(), Kind::StageBegin),
        refused
    );
    assert_eq!(
        invalid(|o| o.archive_sha256 = "A".repeat(64), Kind::StageBegin),
        refused
    );
    assert_eq!(
        invalid(|o| o.url = "http://x/a".into(), Kind::ArchiveFetch),
        refused
    );
    assert_eq!(
        invalid(|o| o.url = "https://x/a;rm".into(), Kind::ArchiveFetch),
        refused
    );
    assert_eq!(invalid(|o| o.max_bytes = 0, Kind::ArchiveFetch), refused);
    assert_eq!(
        invalid(|o| o.max_bytes = (2 << 30) + 1, Kind::ArchiveUpload),
        refused
    );
    assert_eq!(
        invalid(|o| o.max_bytes = 9 << 20, Kind::ManifestPut),
        refused
    );
    assert_eq!(invalid(|o| o.setup_input = 0, Kind::SetupInputPut), refused);
    assert_eq!(invalid(|o| o.pins.truncate(2), Kind::Publish), refused);
    assert_eq!(
        invalid(|o| o.pins[0].path = "/abs".into(), Kind::Publish),
        refused
    );
    assert_eq!(
        invalid(|o| o.pins[1].path = "a/../b".into(), Kind::Publish),
        refused
    );
    assert_eq!(
        invalid(|o| o.node_path = "a//b".into(), Kind::Setup),
        refused
    );
    assert_eq!(
        invalid(|o| o.authority_id = "x".into(), Kind::Start),
        refused
    );
    assert_eq!(
        invalid(|o| o.request_id = REQUEST.into(), Kind::Start),
        refused
    );
    assert_eq!(
        invalid(|o| o.home = HOME.into(), Kind::ReadCompletion),
        refused
    );
}

#[test]
fn request_ids_are_lowercase_v4_uuids() {
    assert!(valid_request_id(REQUEST));
    assert!(!valid_request_id(&REQUEST.to_uppercase()));
    assert!(!valid_request_id("0123abcd-0123-3abc-8def-0123456789ab"));
    assert!(!valid_request_id("0123abcd-0123-4abc-cdef-0123456789ab"));
}

#[test]
fn the_bundled_script_parses_as_posix_sh() {
    let status = std::process::Command::new("/bin/sh")
        .args(["-n", "-c", include_str!("../deployment_step.sh")])
        .status();
    assert!(status.is_ok_and(|status| status.success()));
}

#[test]
fn staging_steps_may_omit_the_home_but_setup_and_start_may_not() {
    let mut begin = valid(Kind::StageBegin);
    begin.home.clear();
    assert!(recipe(&begin).is_ok_and(|r| r.command.contains("bigbud-deploy 'begin' '-' ")));
    for kind in [Kind::Setup, Kind::Start] {
        let mut open = valid(kind);
        open.home.clear();
        assert_eq!(
            recipe(&open).map(|_| ()),
            Err(ErrorCode::InvalidOperands),
            "{kind:?}"
        );
    }
}
