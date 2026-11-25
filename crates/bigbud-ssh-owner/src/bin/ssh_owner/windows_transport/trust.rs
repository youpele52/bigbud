use super::{ErrorCode, HostKey};
use bigbud_ssh_owner::windows_password_gate::native::probe::{GuardedLocalFile, GuardedLocalPath};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    path::Path,
    time::Instant,
};

const MAX_PIN: u64 = 128;

pub(super) struct FixturePath(GuardedLocalPath);

impl FixturePath {
    pub(super) fn new(path: &Path) -> Result<Self, ErrorCode> {
        GuardedLocalPath::new(path)
            .map(Self)
            .map_err(|_| ErrorCode::ConfigUnsupported)
    }

    pub(super) fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub(super) fn open(&self, write: bool) -> Result<GuardedLocalFile, ErrorCode> {
        self.0.open(write).map_err(|_| {
            if write {
                ErrorCode::TrustStoreReadOnly
            } else {
                ErrorCode::ConfigUnsupported
            }
        })
    }
}

pub(super) struct TrustFile {
    _held: GuardedLocalFile,
    key: Option<HostKey>,
}

impl TrustFile {
    pub(super) fn read(path: &FixturePath, label: &str) -> Result<Self, ErrorCode> {
        let mut held = path.open(false)?;
        let key = read_key(held.file_mut(), label)?;
        Ok(Self { _held: held, key })
    }

    pub(super) fn key(&self) -> Option<&HostKey> {
        self.key.as_ref()
    }

    pub(super) fn approve(
        path: &FixturePath,
        label: &str,
        key: &HostKey,
        deadline: Instant,
    ) -> Result<(), ErrorCode> {
        let mut held = path.open(true)?;
        match read_key(held.file_mut(), label)? {
            Some(existing) if &existing == key => return Ok(()),
            Some(_) => return Err(ErrorCode::HostKeyChanged),
            None => {}
        }
        if Instant::now() >= deadline {
            return Err(ErrorCode::TransportLost);
        }
        held.file_mut()
            .rewind()
            .and_then(|()| held.file_mut().write_all(key.record(label).as_bytes()))
            .and_then(|()| held.file_mut().sync_all())
            .map_err(|_| ErrorCode::TrustStoreReadOnly)
    }
}

fn read_key(file: &mut File, label: &str) -> Result<Option<HostKey>, ErrorCode> {
    let mut bytes = Vec::new();
    file.take(MAX_PIN + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ErrorCode::TrustStoreReadOnly)?;
    parse_key(&bytes, label)
}

pub(super) fn parse_key(bytes: &[u8], label: &str) -> Result<Option<HostKey>, ErrorCode> {
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() as u64 > MAX_PIN {
        return Err(ErrorCode::HostKeyChanged);
    }
    let record = bytes
        .strip_suffix(b"\r\n")
        .or_else(|| bytes.strip_suffix(b"\n"))
        .filter(|record| !record.ends_with(b"\n"))
        .ok_or(ErrorCode::HostKeyChanged)?;
    HostKey::from_record(record, label)
        .map(Some)
        .ok_or(ErrorCode::HostKeyChanged)
}
