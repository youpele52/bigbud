#![allow(clippy::panic_in_result_fn)] // Test assertions report failures while I/O errors propagate.
use super::*;

fn target() -> LaunchTarget {
    let root = std::env::temp_dir();
    LaunchTarget {
        runtime: root.join("runtime %!&.exe"),
        entry: root.join("entry %.mjs"),
    }
}

#[test]
fn arguments_remain_literal_and_in_order() {
    let target = target();
    let args: Vec<OsString> = [
        "",
        "a b",
        "%PATH%",
        "!name!",
        "& echo injected",
        "a\"b",
        "trail\\",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    let command = command(&target, args.clone());
    let mut expected = vec![target.entry.into_os_string()];
    expected.extend(args);
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        expected.iter().map(|x| x.as_os_str()).collect::<Vec<_>>()
    );
    assert_eq!(command.get_program(), target.runtime.as_os_str());
    assert!(
        command
            .get_envs()
            .any(|(key, value)| key == "ELECTRON_RUN_AS_NODE"
                && value == Some(std::ffi::OsStr::new("1")))
    );
}

#[test]
fn descriptor_roundtrip_and_invalid_inputs() -> io::Result<()> {
    let target = target();
    let text = format!(
        "{DESCRIPTOR_MAGIC}\n{}\n{}\n",
        target.runtime.display(),
        target.entry.display()
    );
    assert_eq!(parse_target(&text)?.runtime, target.runtime);
    for text in [
        "",
        "other\na\nb\n",
        "bigbud-cli-launcher-v1\nrelative\nrelative\n",
    ] {
        assert!(parse_target(text).is_err());
    }
    assert!(parse_target(&(text.clone() + "extra\n")).is_err());
    assert!(parse_target(&text.replace("runtime", "run\0time")).is_err());
    Ok(())
}

#[cfg(unix)]
#[test]
fn real_child_preserves_arguments_and_exit_status() -> io::Result<()> {
    let dir = std::env::temp_dir().join(format!("bigbud-cli-launcher-{}", std::process::id()));
    std::fs::create_dir(&dir)?;
    let outcome = (|| -> io::Result<()> {
        let entry = dir.join("entry.sh");
        std::fs::write(
            &entry,
            "test \"$1\" = '%PATH% & !literal!' || exit 8\ntest \"$2\" = '' || exit 9\ntest \"$ELECTRON_RUN_AS_NODE\" = 1 || exit 10\nexit 37\n",
        )?;
        let launcher = dir.join("bigbud.exe");
        std::fs::write(
            launcher.with_extension("launch"),
            format!("{DESCRIPTOR_MAGIC}\n/bin/sh\n{}\n", entry.display()),
        )?;
        assert_eq!(
            run(
                &launcher,
                [OsString::from("%PATH% & !literal!"), OsString::new()]
            )?,
            37
        );
        Ok(())
    })();
    let cleanup = std::fs::remove_dir_all(&dir);
    outcome?;
    cleanup
}
