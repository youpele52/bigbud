use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

#[cfg(windows)]
static INVENTORY_FIXTURE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(windows)]
fn own_fixture(root: &std::path::Path) -> io::Result<()> {
    let user = Command::new("whoami.exe")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()?;
    let text = String::from_utf8(user.stdout).map_err(io::Error::other)?;
    let sid = text
        .split('"')
        .find(|field| field.starts_with("S-1-5-"))
        .ok_or_else(|| io::Error::other("fixture user unavailable"))?;
    let status = Command::new("icacls.exe")
        .arg(root)
        .args(["/setowner", &format!("*{sid}"), "/T", "/Q"])
        .status()?;
    if !user.status.success() || !status.success() {
        return Err(io::Error::other("fixture ownership failed"));
    }
    Ok(())
}

struct Probe {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Probe {
    fn open() -> io::Result<Self> {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
            .arg("--inspect-local")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("stdin missing"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("stdout missing"))?,
        );
        Ok(Self {
            child,
            input,
            output,
        })
    }
    fn request(&mut self, line: &str) -> io::Result<String> {
        writeln!(self.input, "{line}")?;
        self.input.flush()?;
        let mut output = String::new();
        self.output.read_line(&mut output)?;
        Ok(output.trim_end().into())
    }
    fn expect_reply(&mut self, line: &str, expected: &str) -> io::Result<()> {
        if self.request(line)? != expected {
            return Err(io::Error::other("fixture reply mismatch"));
        }
        Ok(())
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        // The only controlled process is this fixture-owned read-only helper.
        if let Err(error) = self.child.kill() {
            eprintln!("fixture helper kill failed: {error}");
        }
        if let Err(error) = self.child.wait() {
            eprintln!("fixture helper wait failed: {error}");
        }
    }
}

#[test]
fn inspection_capability_probe_preserves_check_identity_without_creating_state() -> io::Result<()> {
    let root = std::env::temp_dir().join(format!("bigbud-capability-{}", std::process::id()));
    let plain = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
        .arg("--check")
        .env("BIGBUD_AGENT_STATE_DIR", &root)
        .output()?;
    let capabilities = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
        .args(["--check", "--capabilities"])
        .env("BIGBUD_AGENT_STATE_DIR", &root)
        .output()?;
    let plain_text = String::from_utf8(plain.stdout).map_err(io::Error::other)?;
    let capability_text = String::from_utf8(capabilities.stdout).map_err(io::Error::other)?;
    if !plain.status.success()
        || !capabilities.status.success()
        || plain_text.trim().split('\t').count() != 7
        || capability_text.trim() != format!("{}\tinspect-local=1", plain_text.trim())
        || root.exists()
    {
        return Err(io::Error::other(
            "inspection capability probe changed state or identity",
        ));
    }
    Ok(())
}

#[test]
fn inspect_local_protocol_is_read_only_and_versioned() -> io::Result<()> {
    let mut probe = Probe::open()?;
    probe.expect_reply("PROCESS\t1", "ERR")?;
    probe.expect_reply("HELLO\t2", "ERR")?;
    probe.expect_reply("HELLO\t1", "OK\t1")?;
    for command in ["STOP\t1", "WRITE\t1", "PROCESS\t0", "READ\txx", "HELLO\t1"] {
        probe.expect_reply(command, "ERR")?;
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn inspect_local_windows_registration_and_process_metadata() -> io::Result<()> {
    let _guard = INVENTORY_FIXTURE
        .lock()
        .map_err(|_| io::Error::other("fixture lock"))?;
    use std::{
        fs,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        time::{SystemTime, UNIX_EPOCH},
    };
    use windows_sys::Win32::{
        Security::{
            Authorization::{SE_FILE_OBJECT, SetSecurityInfo},
            DACL_SECURITY_INFORMATION,
        },
        Storage::FileSystem::WRITE_DAC,
    };
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("bigbud inspection-{}-{suffix}", std::process::id()));
    fs::create_dir(&root)?;
    let file = root.join("private registration.json");
    fs::write(&file, b"fixture")?;
    own_fixture(&root)?;
    let hex = |s: &str| {
        s.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let encoded = hex(file
        .to_str()
        .ok_or_else(|| io::Error::other("fixture path"))?);
    let result = (|| {
        let mut probe = Probe::open()?;
        probe.expect_reply("HELLO\t1", "OK\t1")?;
        probe.expect_reply(
            &format!("READ\t{encoded}"),
            &format!("OK\t{}", hex("fixture")),
        )?;
        let _held = fs::File::open(&file)?;
        let response = probe.request(&format!("PROCESS\t{}", std::process::id()))?;
        if !response.starts_with("OK\t") || !response.contains(&hex("private registration.json")) {
            return Err(io::Error::other("fixture process metadata missing"));
        }
        if fs::read(&file)? != b"fixture" {
            return Err(io::Error::other("fixture changed"));
        }
        fs::write(&file, vec![b'x'; 16_385])?;
        probe.expect_reply(&format!("READ\t{encoded}"), "ERR")?;
        fs::write(&file, b"fixture")?;
        let acl_handle = fs::OpenOptions::new().access_mode(WRITE_DAC).open(&file)?;
        // SAFETY: mutate only this disposable fixture file. Null DACL must be rejected, never repaired.
        let status = unsafe {
            SetSecurityInfo(
                acl_handle.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        probe.expect_reply(&format!("READ\t{encoded}"), "ERR")?;
        for unsupported in [
            r"\\server\share\service.json",
            r"\\.\C:\service.json",
            r"C:\service.json:alternate",
        ] {
            probe.expect_reply(&format!("READ\t{}", hex(unsupported)), "ERR")?;
        }
        Ok(())
    })();
    fs::remove_dir_all(root)?;
    result
}

#[cfg(windows)]
#[test]
fn inspect_local_windows_failed_snapshots_release_handles_and_detect_replacement() -> io::Result<()>
{
    let _guard = INVENTORY_FIXTURE
        .lock()
        .map_err(|_| io::Error::other("fixture lock"))?;
    use std::{
        fs,
        os::windows::io::AsRawHandle,
        time::{SystemTime, UNIX_EPOCH},
    };
    use windows_sys::Win32::System::Threading::GetProcessHandleCount;

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "bigbud-inspect-races-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir(&root)?;
    let result = (|| {
        let file = root.join("native-state");
        fs::write(&file, b"first")?;
        own_fixture(&root)?;
        let held = fs::File::open(&file)?;
        let hex = |value: &str| {
            value
                .as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        let encoded = hex(file
            .to_str()
            .ok_or_else(|| io::Error::other("fixture path"))?);
        let identity = |reply: &str| -> io::Result<String> {
            reply
                .split('\t')
                .nth(3)
                .and_then(|rows| {
                    rows.split(';').find_map(|row| {
                        let mut fields = row.split(',');
                        let name = fields.next()?;
                        // The native API returns extended local-drive names.
                        if name.ends_with(&encoded) {
                            fields.next().map(String::from)
                        } else {
                            None
                        }
                    })
                })
                .ok_or_else(|| io::Error::other("fixture file identity missing"))
        };
        let mut probe = Probe::open()?;
        probe.expect_reply("HELLO\t1", "OK\t1")?;
        let command = format!("PROCESS\t{}", std::process::id());
        let before = identity(&probe.request(&command)?)?;
        fs::rename(&file, root.join("retained-old"))?;
        fs::write(&file, b"replacement")?;
        own_fixture(&root)?;
        let replacement = fs::File::open(&file)?;
        let after = identity(&probe.request(&command)?)?;
        if before == after {
            return Err(io::Error::other("same-path replacement identity reused"));
        }

        let leaked = root.join("deleted-open-file");
        fs::write(&leaked, b"fixture")?;
        let deleted = fs::File::open(&leaked)?;
        fs::remove_file(&leaked)?;
        let handle_count = |probe: &Probe| -> io::Result<u32> {
            let mut count = 0;
            // SAFETY: the child process handle is live and output points to a DWORD.
            if unsafe { GetProcessHandleCount(probe.child.as_raw_handle(), &mut count) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(count)
        };
        let initial_handles = handle_count(&probe)?;
        for _ in 0..32 {
            // Force source handle-number reuse between repeated incomplete inventories.
            let churn_path = root.join("churn-file");
            fs::write(&churn_path, b"disposable")?;
            let churn = fs::File::open(&churn_path)?;
            fs::remove_file(&churn_path)?;
            if !probe.request(&command)?.starts_with("ERR") {
                return Err(io::Error::other("deleted open file was not rejected"));
            }
            drop(churn);
        }
        if handle_count(&probe)? > initial_handles + 1 {
            return Err(io::Error::other("failed snapshots leaked native handles"));
        }
        drop(deleted);
        if identity(&probe.request(&command)?)? != after {
            return Err(io::Error::other(
                "helper failed to recover after rejected snapshots",
            ));
        }
        drop((held, replacement));
        Ok(())
    })();
    fs::remove_dir_all(root)?;
    result
}
