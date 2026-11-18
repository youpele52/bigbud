#![allow(clippy::panic_in_result_fn)]
use super::*;
struct Fixture {
    root: std::path::PathBuf,
    source: std::path::PathBuf,
    destination: std::path::PathBuf,
    entry: std::path::PathBuf,
}
impl Fixture {
    fn new() -> io::Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "bigbud-launch-install-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root)?;
        let source = root.join("source.exe");
        let entry = root.join("entry.mjs");
        fs::write(&source, b"native-v1")?;
        fs::write(&entry, b"entry")?;
        Ok(Self {
            destination: root.join("bigbud.exe"),
            root,
            source,
            entry,
        })
    }
    fn install(&self) -> io::Result<()> {
        install(
            &self.source,
            &self.destination,
            &std::env::current_exe()?,
            &self.entry,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _cleanup = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn installation_updates_owned_files_and_preserves_changed_descriptor() -> io::Result<()> {
    let f = Fixture::new()?;
    f.install()?;
    assert_eq!(fs::read(&f.destination)?, b"native-v1");
    fs::write(&f.source, b"native-v2")?;
    f.install()?;
    assert_eq!(fs::read(&f.destination)?, b"native-v2");
    fs::write(f.destination.with_extension("launch"), b"foreign")?;
    assert!(f.install().is_err());
    assert_eq!(
        fs::read(f.destination.with_extension("launch"))?,
        b"foreign"
    );
    Ok(())
}
#[test]
fn retries_complete_each_interrupted_publication_boundary() -> io::Result<()> {
    for initially_installed in [false, true] {
        for published_files in 0..=2 {
            let f = Fixture::new()?;
            // Build a legitimate first generation, then simulate an interruption of the next.
            f.install()?;
            let state = f.destination.with_extension("launcher-state");
            if !initially_installed {
                fs::remove_file(state.join("current"))?;
                fs::remove_file(&f.destination)?;
                fs::remove_file(f.destination.with_extension("launch"))?;
            }
            let id = "g-999-123";
            let dir = state.join(id);
            fs::create_dir(&dir)?;
            let descriptor = format!(
                "{DESCRIPTOR_MAGIC}\n{}\n{}\n",
                std::env::current_exe()?.display(),
                f.entry.display()
            );
            fs::write(dir.join("launcher"), b"interrupted-version")?;
            fs::write(dir.join("descriptor"), descriptor.as_bytes())?;
            fs::write(state.join("pending"), id)?;
            if published_files >= 1 {
                fs::write(
                    f.destination.with_extension("launch"),
                    descriptor.as_bytes(),
                )?;
            }
            if published_files >= 2 {
                fs::write(&f.destination, b"interrupted-version")?;
            }
            f.install()?;
            assert_eq!(fs::read(&f.destination)?, b"native-v1");
            assert!(!state.join("pending").exists());
        }
    }
    Ok(())
}
#[test]
fn file_lock_blocks_concurrent_writer_and_releases_for_retry() -> io::Result<()> {
    let f = Fixture::new()?;
    let lock = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(f.destination.with_extension("install-lock"))?;
    lock.try_lock().map_err(io::Error::other)?;
    assert!(f.install().is_err());
    drop(lock);
    // A concurrently forked test child can briefly hold an inherited fd until exec closes it.
    for attempt in 0..100 {
        match f.install() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock && attempt < 99 => {
                std::thread::sleep(std::time::Duration::from_millis(2))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
#[test]
fn unrecognized_executable_and_partial_foreign_state_are_preserved() -> io::Result<()> {
    let f = Fixture::new()?;
    fs::write(&f.destination, b"foreign")?;
    assert!(f.install().is_err());
    assert_eq!(fs::read(&f.destination)?, b"foreign");
    let other = Fixture::new()?;
    fs::create_dir(other.destination.with_extension("launcher-state"))?;
    assert!(other.install().is_err());
    Ok(())
}

#[test]
fn repeated_prepublication_interruptions_are_bounded() -> io::Result<()> {
    let f = Fixture::new()?;
    f.install()?;
    let state = f.destination.with_extension("launcher-state");
    for n in 0..3 {
        let generation = state.join(format!("g-999-{n}"));
        fs::create_dir(&generation)?;
        fs::write(generation.join("launcher"), b"interrupted partial bytes")?;
    }
    let count = fs::read_dir(&state)?.count();
    for _ in 0..3 {
        assert!(f.install().is_err());
        assert_eq!(fs::read_dir(&state)?.count(), count);
    }
    assert_eq!(fs::read(&f.destination)?, b"native-v1");
    Ok(())
}
