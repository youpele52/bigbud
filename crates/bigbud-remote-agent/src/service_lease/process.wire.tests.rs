#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
use super::*;
#[test]
fn private_launch_fingerprint_matches_typescript_original_resource_binding() {
    let value: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/remote-agent/service_lease.launch.golden.json"
    )))
    .unwrap();
    let args = value["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect();
    let environment = value["environment"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            (
                v["name"].as_str().unwrap().into(),
                v["value"].as_str().unwrap().into(),
            )
        })
        .collect();
    let launch = Launch {
        executable: value["executable"].as_str().unwrap().into(),
        args,
        environment: SecretEnvironment(environment),
        guard: Some(
            crate::service_lease::Guard::parse(value["guardUtf8"].as_str().unwrap().as_bytes())
                .unwrap(),
        ),
        assets: Some(
            crate::service_lease::AssetsResource::new(
                value["stateDir"].as_str().unwrap().into(),
                value["assetsGeneration"].as_str().unwrap().into(),
                value["assetsReceiptSize"].as_u64().unwrap(),
                [6; 32],
                value["assetsArgument"].as_str().unwrap().into(),
            )
            .unwrap(),
        ),
    };
    let fingerprint = launch.fingerprint(&[2; 32]).unwrap();
    assert_eq!(
        fingerprint
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>(),
        value["sha256"].as_str().unwrap()
    );
    let mut changed = launch;
    changed.args.push("changed".into());
    assert_ne!(changed.fingerprint(&[2; 32]).unwrap(), fingerprint);
}

#[test]
fn ready_frame_round_trips_only_complete_original_evidence() {
    let proof = crate::service_lease::process::readiness::Proof {
        address: "127.0.0.1:4774".parse().unwrap(),
        inode: 991,
    };
    let frame = ready(42, Some((proof, 777)));
    assert_eq!(parse_ready(&frame, true).unwrap(), (42, Some((proof, 777))));
    assert!(parse_ready(&frame, false).is_err());
    let plain = ready(42, None);
    assert_eq!(parse_ready(&plain, false).unwrap(), (42, None));
    assert!(parse_ready(&plain, true).is_err());
    let mut refused = frame;
    refused[0] = b'U';
    assert!(parse_ready(&refused, true).is_err());
    assert!(parse_ready(&ready(1, Some((proof, 777))), true).is_err());
    let mut zero_inode = frame;
    zero_inode[13..21].copy_from_slice(&0u64.to_be_bytes());
    assert!(parse_ready(&zero_inode, true).is_err());
}
