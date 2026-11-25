use bigbud_ssh_owner::git_receive_gate::{
    ApprovedTrackedUpdate, BoundTrackedReceive, DestinationReceipt,
};
use std::{
    env, fs,
    io::{self, Write},
    os::unix::fs::MetadataExt,
    path::Path,
    process::{Child, Command, Stdio},
};

#[path = "pump.rs"]
mod pump;

const ROOT_PREFIX: &str = "/tmp/bigbud-picker-linux-";
const USER_HOST: &str = "picker@127.0.0.1";
const PORT: &str = "22222";
const RECEIVER: &str = "git-receive-pack '/receive.git'";
const REF: &str = "refs/heads/main";
const OLD: &str = "BIGBUD_GIT_FIXTURE_OLD";
const NEW: &str = "BIGBUD_GIT_FIXTURE_NEW";

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::current_dir()?;
    let executable = env::current_exe()?;
    let valid_name = root
        .to_str()
        .and_then(|s| s.strip_prefix(ROOT_PREFIX))
        .is_some_and(|s| {
            (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
        });
    if env::var("BIGBUD_SSH_OWNER_PICKER_PROOF").as_deref() != Ok("1")
        || !valid_name
        || root.canonicalize()? != root
        || root.metadata()?.mode() & 0o077 != 0
        || executable != root.join("picker-owner")
    {
        return Err("not in a private Linux picker fixture".into());
    }
    let args: Vec<String> = env::args().skip(1).collect();
    match args.as_slice() {
        [mode, old, new, source] if mode == "push" => push(&executable, old, new, source),
        [host, command] if host == USER_HOST && command == RECEIVER => {
            let old = env::var(OLD)?;
            let new = env::var(NEW)?;
            let mut ssh = pinned_ssh(&root)?;
            let result = conduct(&mut ssh, &old, &new);
            if result.is_err() {
                // The pipes have been dropped; the enclosing timeout bounds
                // reaping. A clean exit cannot override the rejected gate.
                let _exit = ssh.wait()?;
            }
            result
        }
        _ => Err("unexpected fixture invocation".into()),
    }
}

fn push(
    executable: &Path,
    old: &str,
    new: &str,
    source: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if ![old, new, source].into_iter().all(|s| {
        s.len() == 40
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }) {
        return Err("expected synthetic SHA-1 fixture operands".into());
    }
    let status = Command::new("/usr/bin/timeout")
        .args([
            "--kill-after=1s",
            "18s",
            "/usr/bin/git",
            "--git-dir=client.git",
            "-c",
            "protocol.version=0",
            "push",
            "--no-signed",
            "--no-verify",
            "--no-follow-tags",
            "ssh://picker@127.0.0.1/receive.git",
        ])
        .arg(format!("{source}:{REF}"))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("BIGBUD_SSH_OWNER_PICKER_PROOF", "1")
        .env("GIT_SSH_VARIANT", "ssh")
        .env("GIT_SSH_COMMAND", executable)
        .env(OLD, old)
        .env(NEW, new)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err("ordinary Git fixture push did not succeed".into())
    }
}

fn pinned_ssh(root: &Path) -> io::Result<Child> {
    Command::new("/usr/bin/timeout")
        .args([
            "--kill-after=1s",
            "12s",
            "/usr/bin/ssh",
            "-T",
            "-F",
            "/dev/null",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "HostKeyAlgorithms=ssh-ed25519",
            "-o",
            "UpdateHostKeys=no",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "EscapeChar=none",
            "-o",
            "ConnectTimeout=3",
            "-o",
        ])
        .arg(format!(
            "UserKnownHostsFile={}",
            root.join("known_hosts").display()
        ))
        .arg("-i")
        .arg(root.join("identity"))
        .args(["-p", PORT, "--", USER_HOST, RECEIVER])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
}

fn conduct(ssh: &mut Child, old: &str, new: &str) -> Result<(), Box<dyn std::error::Error>> {
    let output = ssh.stdout.take().ok_or("missing fixture SSH output")?;
    let input = ssh.stdin.take().ok_or("missing fixture SSH input")?;
    let bound = BoundTrackedReceive::bind(
        output,
        input,
        ApprovedTrackedUpdate {
            destination_ref: REF,
            advertised_old_oid: old,
            approved_source_oid: new,
        },
    )
    .map_err(|error| format!("advertisement refused ({error:?})"))?;
    let mut client_out = io::stdout().lock();
    client_out.write_all(bound.advertisement())?;
    client_out.flush()?;
    // Open the pipe without a user-space read-ahead buffer so poll also sees
    // pack bytes already sent alongside the command prefix.
    let mut client_in = fs::File::open("/proc/self/fd/0")?;
    let forwarded = bound
        .forward_prefix(&mut client_in, || matches!(ssh.try_wait(), Ok(None)))
        .map_err(|error| format!("no update admitted ({error:?})"))?;
    let (receipt, wire) =
        forwarded.exchange_pack(|output, input, cap| pump::exchange(client_in, output, input, cap));
    let exit = ssh.wait()?;
    if !exit.success() || receipt == DestinationReceipt::Unconfirmed {
        return Err("receive-pack result unconfirmed".into());
    }
    client_out.write_all(&wire)?;
    client_out.flush()?;
    eprintln!("Git receive fixture receipt: {receipt:?}");
    Ok(())
}
