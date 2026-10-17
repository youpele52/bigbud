use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    ptr,
};
use windows_sys::Win32::{Storage::FileSystem::*, System::Memory::*};

pub struct Fixture {
    pub root: PathBuf,
    pub child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Fixture {
    pub fn start(count: usize) -> io::Result<Self> {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("bigbud-metadata-{}-{suffix}", std::process::id()));
        fs::create_dir(&root)?;
        for name in ["native state", "second state"].iter().take(count) {
            fs::write(root.join(name), b"synthetic disk fixture")?;
            fs::write(root.join(format!("{name}-shm")), vec![0u8; 65536])?;
        }
        super::file_fixture::own_fixture(&root)?;
        Self::spawn(root)
    }
    fn spawn(root: PathBuf) -> io::Result<Self> {
        let mut child = Command::new(std::env::current_exe()?)
            .args(["--exact", "metadata_fixture_child", "--nocapture"])
            .env("BIGBUD_METADATA_CHILD", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("fixture stdin"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("fixture stdout"))?,
        );
        let mut value = Self {
            root,
            child,
            input,
            output,
        };
        value.wait_for("READY")?;
        Ok(value)
    }
    fn wait_for(&mut self, expected: &str) -> io::Result<()> {
        for _ in 0..16 {
            let mut line = String::new();
            if self.output.read_line(&mut line)? == 0 {
                break;
            }
            if line.trim() == expected {
                return Ok(());
            }
        }
        Err(io::Error::other("fixture acknowledgement absent"))
    }
    pub fn command(&mut self, command: &str) -> io::Result<()> {
        writeln!(self.input, "{command}")?;
        self.input.flush()?;
        self.wait_for("DONE")
    }
    pub fn stop(&mut self) -> io::Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
        }
        self.child.wait()?;
        Ok(())
    }
    pub fn restart(&mut self) -> io::Result<()> {
        self.stop()?;
        let next = Self::spawn(self.root.clone())?;
        // Transfer the root cleanup responsibility to the replacement fixture.
        self.root = PathBuf::new();
        *self = next;
        Ok(())
    }
    pub fn path(&self, suffix: &str) -> String {
        self.root
            .join(format!("native state{suffix}"))
            .to_string_lossy()
            .into_owned()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("fixture stop failed: {error}");
        }
        if !self.root.as_os_str().is_empty() {
            if let Err(error) = fs::remove_dir_all(&self.root) {
                eprintln!("fixture cleanup failed: {error}");
            }
        }
    }
}

struct Mapping {
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    _section: OwnedHandle,
}
impl Mapping {
    fn open(file: &File) -> io::Result<Self> {
        // SAFETY: mapping only this disposable, sized fixture file, unnamed and not inherited.
        let raw = unsafe {
            CreateFileMappingW(
                file.as_raw_handle(),
                ptr::null(),
                PAGE_READWRITE,
                0,
                0,
                ptr::null(),
            )
        };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful create returns a new owned mapping object.
        let section = unsafe { OwnedHandle::from_raw_handle(raw) };
        // SAFETY: live fixture mapping; view is never dereferenced and is unmapped on Drop.
        let view = unsafe {
            MapViewOfFile(
                section.as_raw_handle(),
                FILE_MAP_READ | FILE_MAP_WRITE,
                0,
                0,
                0,
            )
        };
        if view.Value.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            view,
            _section: section,
        })
    }
}
impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: uniquely owned fixture view, unmap exactly once before closing its section.
        if unsafe { UnmapViewOfFile(self.view) } == 0 {
            eprintln!("fixture unmap failed");
        }
    }
}

pub fn child(root: &Path) -> io::Result<()> {
    let mut files = Vec::new();
    let mut mappings = Vec::new();
    for name in ["native state", "second state"] {
        if !root.join(name).exists() {
            continue;
        }
        for suffix in ["", "-shm"] {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .open(root.join(format!("{name}{suffix}")))?;
            if suffix == "-shm" {
                mappings.push(Mapping::open(&file)?);
            }
            files.push(file);
        }
    }
    let _tcp = std::net::TcpListener::bind("127.0.0.1:0")?;
    let _udp = std::net::UdpSocket::bind("127.0.0.1:0")?;
    println!("READY");
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        match line?.as_str() {
            "unmap" => mappings.clear(),
            "close" => {
                mappings.clear();
                files.clear();
            }
            _ => return Err(io::Error::other("fixture command rejected")),
        }
        println!("DONE");
        io::stdout().flush()?;
    }
    Ok(())
}
