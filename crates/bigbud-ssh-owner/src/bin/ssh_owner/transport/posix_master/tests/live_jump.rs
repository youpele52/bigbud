use super::*;
use crate::owner::retirement::Retirement;
use crate::transport::posix_master::jump::{Failure, Route, Stage};
use std::{env, fs};

const BASTION: u16 = 22222;
const DESTINATION: u16 = 22223;
const ROOT_PREFIX: &str = "/tmp/bigbud-picker-linux-";

#[test]
#[ignore = "requires the approved two-daemon private Linux namespace"]
fn stock_openssh_forwards_only_after_authenticating_the_pinned_bastion() {
    assert_eq!(
        env::var("BIGBUD_SSH_OWNER_LIVE_JUMP").as_deref(),
        Ok("approved-disposable")
    );
    let root = env::current_dir().unwrap();
    assert!(
        root.to_str()
            .unwrap()
            .strip_prefix(ROOT_PREFIX)
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
    );
    let leg_root = |directory: &str| {
        let key = if directory == "b" {
            "BIGBUD_JUMP_B"
        } else {
            "BIGBUD_JUMP_D"
        };
        let leg: std::path::PathBuf = env::var_os(key).unwrap().into();
        assert!(
            leg.to_str()
                .unwrap()
                .strip_prefix(ROOT_PREFIX)
                .is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
                })
        );
        leg
    };
    let certificate = |path: &str| fs::read_to_string(root.join(path)).unwrap();
    let write_pin = |directory: &str, port: u16, key_directory: &str, key_name: &str| {
        let key = fs::read_to_string(leg_root(key_directory).join(key_name)).unwrap();
        let pin = key
            .split_ascii_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        fs::write(
            leg_root(directory).join("known_hosts"),
            format!("[127.0.0.1]:{port} {pin}\n"),
        )
        .unwrap();
    };
    let transport = |directory: &str, port| {
        let directory = leg_root(directory);
        Transport::new(TransportConfig {
            ssh: SSH.into(),
            keyscan: "/usr/bin/ssh-keyscan".into(),
            host: std::net::Ipv4Addr::LOCALHOST.into(),
            port,
            user: "picker".into(),
            identity: directory.join("identity"),
            known_hosts: directory.join("known_hosts"),
            alias_config: None,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
            host_identity: Default::default(),
        })
        .unwrap()
    };

    let bastion = transport("b", BASTION);
    let destination = transport("d", DESTINATION);
    let retirement_root = root.join("retirement");
    fs::create_dir(&retirement_root).unwrap();
    fs::set_permissions(
        &retirement_root,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    let retirement = Retirement::open(&retirement_root.join("owner.lock"), [1; 32], true).unwrap();
    let mut route = Route::new(GEN, None, Some(retirement.clone()));
    let count_auth = |log: &str| certificate(log).matches("Accepted publickey").count();
    let before = (count_auth("b.log"), count_auth("d.log"));
    let browse = |route: &mut Route| {
        route.browse(
            &[&bastion, &destination],
            None,
            Instant::now() + READY_LIMIT,
        )
    };
    assert!(matches!(
        route.browse(&[&bastion, &bastion], None, Instant::now() + READY_LIMIT),
        Err(Failure {
            leg: 1,
            stage: Stage::Admission,
            code: ErrorCode::TrustRequired
        })
    ));
    write_pin("b", BASTION, "b", "host.pub");
    assert!(matches!(
        route.browse(&[&bastion, &bastion], None, Instant::now() + READY_LIMIT),
        Err(Failure {
            leg: 2,
            stage: Stage::Admission,
            code: ErrorCode::ConfigUnsupported
        })
    ));
    assert!(matches!(
        browse(&mut route),
        Err(Failure {
            leg: 2,
            stage: Stage::Admission,
            code: ErrorCode::TrustRequired
        })
    ));
    assert_eq!((count_auth("b.log"), count_auth("d.log")), before);

    // The server presents its replacement key while the private trust
    // file still contains the original bastion pin.
    write_pin("b", BASTION, "b", "prior-host.pub");
    write_pin("d", DESTINATION, "d", "host.pub");
    assert!(matches!(
        browse(&mut route),
        Err(Failure {
            leg: 1,
            stage: Stage::Handshake,
            code: ErrorCode::HostKeyChanged,
        })
    ));
    assert_eq!((count_auth("b.log"), count_auth("d.log")), before);

    write_pin("b", BASTION, "b", "host.pub");
    write_pin("d", DESTINATION, "b", "host.pub");
    assert!(matches!(
        browse(&mut route),
        Err(Failure {
            leg: 2,
            stage: Stage::Handshake,
            code: ErrorCode::HostKeyChanged,
        })
    ));
    assert_eq!(
        (count_auth("b.log"), count_auth("d.log")),
        (before.0 + 1, before.1)
    );

    write_pin("d", DESTINATION, "d", "host.pub");
    for _ in 0..2 {
        let listing = browse(&mut route).expect("fixed picker through owned route");
        assert!(
            listing
                .entries
                .iter()
                .any(|folder| folder.name == "jump-fixture-folder")
        );
    }
    assert_eq!(
        (count_auth("b.log"), count_auth("d.log")),
        (before.0 + 2, before.1 + 1)
    );
    route.retire().unwrap();
    for subdirectory in ["b", "d"] {
        PosixMasterSlot::require_no_residual_lease(&leg_root(subdirectory)).unwrap();
    }
    // The two leg masters were reconciled and cleared by their own records.
    let leftover = fs::read_dir(&retirement_root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("owner.retirement."))
        .collect::<Vec<_>>();
    assert!(leftover.is_empty(), "{leftover:?}");
    retirement.clear_owner();
    fs::remove_dir_all(&retirement_root).unwrap();
}
