use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

#[cfg(windows)]
static INVENTORY_FIXTURE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(windows)]
#[path = "support/windows.fixture.rs"]
mod file_fixture;
#[cfg(windows)]
use file_fixture::own_fixture;

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
fn inspect_local_protocol_is_versioned_and_rejects_unscoped_operations() -> io::Result<()> {
    let mut probe = Probe::open()?;
    probe.expect_reply("PROCESS\t1", "ERR")?;
    probe.expect_reply("HELLO\t2", "ERR")?;
    probe.expect_reply("HELLO\t1", "OK\t1")?;
    for command in [
        "STOP\t1",
        "WRITE\t1",
        "PROCESS\t0",
        "PROCESS\t1",
        "READ\txx",
        "HELLO\t1",
    ] {
        probe.expect_reply(command, "ERR")?;
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn inspect_local_windows_registration_is_private_and_process_inspection_is_rejected()
-> io::Result<()> {
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
        Storage::FileSystem::{READ_CONTROL, WRITE_DAC},
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
        let _directory = fs::OpenOptions::new()
            .access_mode(windows_sys::Win32::Storage::FileSystem::FILE_TRAVERSE)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&root)?;
        // Real socket handles coexist with the file inventory; inspection must preserve transport.
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let mut client = std::net::TcpStream::connect(listener.local_addr()?)?;
        let (mut peer, _) = listener.accept()?;
        peer.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        let response = probe.request(&format!("PROCESS\t{}", std::process::id()))?;
        if response != "ERR" {
            return Err(io::Error::other("retired process inspection was admitted"));
        }
        client.write_all(b"ok")?;
        let mut received = [0u8; 2];
        std::io::Read::read_exact(&mut peer, &mut received)?;
        if received != *b"ok" {
            return Err(io::Error::other("fixture socket changed"));
        }
        if fs::read(&file)? != b"fixture" {
            return Err(io::Error::other("fixture changed"));
        }
        fs::write(&file, vec![b'x'; 16_385])?;
        probe.expect_reply(&format!("READ\t{encoded}"), "ERR")?;
        fs::write(&file, b"fixture")?;
        // SetSecurityInfo also reads the existing descriptor while propagating inheritance.
        let acl_handle = fs::OpenOptions::new()
            .access_mode(WRITE_DAC | READ_CONTROL)
            .open(&file)
            .map_err(|error| io::Error::other(format!("fixture ACL open: {error}")))?;
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
            return Err(io::Error::other(format!("fixture null DACL: {status}")));
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
fn inspect_local_windows_reads_release_handles_and_detect_replacement() -> io::Result<()> {
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
        // GetFinalPathNameByHandle expands runner TEMP's short (8.3) ancestor names.
        let canonical = fs::canonicalize(&file)?;
        let encoded = hex(canonical
            .to_str()
            .ok_or_else(|| io::Error::other("fixture path"))?);
        let mut probe = Probe::open()?;
        probe.expect_reply("HELLO\t1", "OK\t1")?;
        let command = format!("READ\t{encoded}");
        probe.expect_reply(&command, &format!("OK\t{}", hex("first")))?;
        fs::rename(&file, root.join("retained-old"))?;
        fs::write(&file, b"replacement")?;
        own_fixture(&root)?;
        let replacement = fs::File::open(&file)?;
        probe.expect_reply(&command, &format!("OK\t{}", hex("replacement")))?;

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
            // Failed private reads and path churn must not leak this helper's own handles.
            let churn_path = root.join("churn-file");
            fs::write(&churn_path, b"disposable")?;
            let churn = fs::File::open(&churn_path)?;
            fs::remove_file(&churn_path)?;
            let deleted_command = format!(
                "READ\t{}",
                hex(churn_path
                    .to_str()
                    .ok_or_else(|| io::Error::other("fixture path"))?)
            );
            probe.expect_reply(&deleted_command, "ERR\tmissing")?;
            drop(churn);
        }
        if handle_count(&probe)? > initial_handles + 1 {
            return Err(io::Error::other("failed snapshots leaked native handles"));
        }
        drop(deleted);
        probe.expect_reply(&command, &format!("OK\t{}", hex("replacement")))?;
        drop((held, replacement));
        Ok(())
    })();
    fs::remove_dir_all(root)?;
    result
}
