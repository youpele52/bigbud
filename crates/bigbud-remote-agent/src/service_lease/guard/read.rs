use super::super::{Error, Result};
use super::model::{Guard, MAXIMUM, Model};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::{
    fs::{File, OpenOptions},
    io::Read,
};
type Stamp = (u64, u64, u32, u32, u64, u64, i64, i64, i64, i64);
fn stamp(info: &std::fs::Metadata) -> Stamp {
    (
        info.dev(),
        info.ino(),
        info.uid(),
        info.mode(),
        info.nlink(),
        info.len(),
        info.mtime(),
        info.mtime_nsec(),
        info.ctime(),
        info.ctime_nsec(),
    )
}
pub(super) fn anchors(model: &Model) -> Result<()> {
    // SAFETY: geteuid only reads the actual account identity.
    let uid = unsafe { libc::geteuid() };
    for expected in &model.anchors {
        let actual = std::fs::symlink_metadata(&expected.path)?;
        if !actual.is_dir()
            || actual.dev() != expected.dev
            || actual.ino() != expected.ino
            || actual.uid() != expected.uid
            || actual.uid() != uid
            || actual.mode() & 0o7777 != expected.mode
            || std::fs::canonicalize(&expected.path)? != expected.path
        {
            return Err(Error::Refused);
        }
    }
    Ok(())
}
pub(super) enum Observation {
    Valid,
    Invalid,
    Retry,
}
#[derive(Default)]
pub(super) struct Reader {
    cached: Option<(Stamp, File)>,
    roots: Vec<File>,
}
impl Reader {
    pub(super) fn check(&mut self, guard: &Guard) -> Observation {
        match self.snapshot(guard) {
            Ok(Some(valid)) => {
                if valid {
                    Observation::Valid
                } else {
                    Observation::Invalid
                }
            }
            Ok(None) => Observation::Retry,
            Err(_) => Observation::Invalid,
        }
    }
    fn snapshot(&mut self, guard: &Guard) -> Result<Option<bool>> {
        anchors(&guard.model)?;
        if self.roots.is_empty() {
            for anchor in &guard.model.anchors {
                let handle = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
                    .open(&anchor.path)?;
                let metadata = handle.metadata()?;
                if metadata.dev() != anchor.dev || metadata.ino() != anchor.ino {
                    return Err(Error::Refused);
                }
                self.roots.push(handle);
            }
        }
        for (handle, anchor) in self.roots.iter().zip(&guard.model.anchors) {
            let actual = handle.metadata()?;
            if actual.dev() != anchor.dev
                || actual.ino() != anchor.ino
                || actual.uid() != anchor.uid
                || actual.mode() & 0o7777 != anchor.mode
            {
                return Err(Error::Refused);
            }
        }
        let path = &guard.model.file;
        if std::fs::canonicalize(path)? != *path {
            return Err(Error::Refused);
        }
        let mut file: File = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        let before = file.metadata()?;
        // SAFETY: geteuid only reads the actual account identity.
        if !before.is_file()
            || before.uid() != unsafe { libc::geteuid() }
            || before.mode() & 0o7777 != 0o600
            || before.nlink() != 1
            || before.len() == 0
            || before.len() > MAXIMUM as u64
        {
            return Err(Error::Invalid);
        }
        let observed = stamp(&before);
        if self.cached.as_ref().is_some_and(|(stamp, handle)| {
            *stamp == observed
                && handle
                    .metadata()
                    .is_ok_and(|info| super::read::stamp(&info) == observed)
        }) {
            let named = std::fs::symlink_metadata(path)?;
            return Ok(if stamp(&named) == observed {
                Some(true)
            } else {
                None
            });
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        file.by_ref()
            .take(MAXIMUM as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAXIMUM {
            return Err(Error::Invalid);
        }
        let after = file.metadata()?;
        let named = std::fs::symlink_metadata(path)?;
        if stamp(&after) != observed
            || stamp(&named) != observed
            || bytes.len() as u64 != before.len()
        {
            return Ok(None);
        }
        anchors(&guard.model)?;
        let valid = guard.evaluate(&bytes)?;
        if valid {
            self.cached = Some((observed, file));
        }
        Ok(Some(valid))
    }
}
