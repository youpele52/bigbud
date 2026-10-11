use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

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
