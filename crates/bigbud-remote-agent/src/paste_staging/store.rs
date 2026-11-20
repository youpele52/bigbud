use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::errors::{PasteError, PasteLimits};
use super::names::{
    is_valid_extension, is_valid_image_mime_type, is_valid_scope, is_valid_upload_id,
};

#[path = "store.fs.rs"]
mod store_fs;
use store_fs::{
    FileEntry, create_private_file, discard_upload, ensure_private_directory, is_partial,
    remove_if_present, remove_scope_directory,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedPaste {
    /// Canonical absolute path on this host.
    pub path: PathBuf,
    pub image_mime_type: Option<String>,
}

struct Upload {
    scope: String,
    total: u64,
    received: u64,
    hasher: Sha256,
    file: Option<File>,
    partial: PathBuf,
    final_path: PathBuf,
    image_mime_type: Option<String>,
    touched: Instant,
}

/// Owner-private staging folder (0700 directories, 0600 files, random space-free names).
pub struct PasteStore {
    root: PathBuf,
    limits: PasteLimits,
    uploads: HashMap<String, Upload>,
    counter: u64,
}

impl PasteStore {
    /// Opens (creating owner-only) the folder and removes files older than the TTL.
    pub fn open(root: impl AsRef<Path>, limits: PasteLimits) -> Result<Self, PasteError> {
        let root = root.as_ref();
        ensure_private_directory(root)?;
        let mut store = Self {
            root: fs::canonicalize(root)?,
            limits,
            uploads: HashMap::new(),
            counter: 0,
        };
        store.sweep(SystemTime::now())?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn begin(
        &mut self,
        scope: &str,
        upload_id: &str,
        total: u64,
        extension: &str,
        image_mime_type: &str,
    ) -> Result<(), PasteError> {
        if !is_valid_scope(scope) || !is_valid_upload_id(upload_id) {
            return Err(PasteError::InvalidArgument("scope or upload ID"));
        }
        if !is_valid_extension(extension) || !is_valid_image_mime_type(image_mime_type) {
            return Err(PasteError::InvalidArgument("extension or image type"));
        }
        if total == 0 {
            return Err(PasteError::InvalidArgument("empty file"));
        }
        if total > self.limits.max_file_bytes {
            return Err(PasteError::TooLarge);
        }
        self.expire_idle(Instant::now());
        if self.uploads.contains_key(upload_id) {
            return Err(PasteError::InvalidArgument("duplicate upload ID"));
        }
        if self.uploads.len() >= self.limits.max_uploads {
            return Err(PasteError::ResourceLimit("too many concurrent uploads"));
        }
        self.make_room(total)?;
        let directory = self.root.join(scope);
        ensure_private_directory(&directory)?;
        let name = self.random_name(upload_id);
        let final_path = directory.join(format!("{name}.{extension}"));
        let partial = directory.join(format!(".{name}.{extension}.partial"));
        let file = create_private_file(&partial)?;
        self.uploads.insert(
            upload_id.to_owned(),
            Upload {
                scope: scope.to_owned(),
                total,
                received: 0,
                hasher: Sha256::new(),
                file: Some(file),
                partial,
                final_path,
                image_mime_type: (!image_mime_type.is_empty()).then(|| image_mime_type.to_owned()),
                touched: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn chunk(&mut self, upload_id: &str, offset: u64, data: &[u8]) -> Result<u64, PasteError> {
        let max_chunk = self.limits.max_chunk_bytes;
        let upload = self
            .uploads
            .get_mut(upload_id)
            .ok_or(PasteError::UnknownUpload)?;
        let length = data.len() as u64;
        if offset != upload.received
            || data.is_empty()
            || length > max_chunk
            || upload.received.saturating_add(length) > upload.total
        {
            let failed = self.uploads.remove(upload_id);
            discard_upload(failed);
            return Err(PasteError::OutOfOrder);
        }
        let file = upload.file.as_mut().ok_or(PasteError::UnknownUpload)?;
        if let Err(error) = file.write_all(data) {
            let failed = self.uploads.remove(upload_id);
            discard_upload(failed);
            return Err(error.into());
        }
        upload.hasher.update(data);
        upload.received += length;
        upload.touched = Instant::now();
        Ok(upload.received)
    }

    pub fn commit(&mut self, upload_id: &str, sha256: &[u8]) -> Result<CommittedPaste, PasteError> {
        let mut upload = self
            .uploads
            .remove(upload_id)
            .ok_or(PasteError::UnknownUpload)?;
        if upload.received != upload.total {
            discard_upload(Some(upload));
            return Err(PasteError::Incomplete);
        }
        if upload.hasher.clone().finalize().as_slice() != sha256 {
            discard_upload(Some(upload));
            return Err(PasteError::DigestMismatch);
        }
        let result = (|| {
            if let Some(file) = upload.file.take() {
                file.sync_all()?;
            }
            // `hard_link` refuses an existing name, so a staged file is never replaced.
            fs::hard_link(&upload.partial, &upload.final_path)?;
            fs::remove_file(&upload.partial)?;
            fs::canonicalize(&upload.final_path)
        })();
        match result {
            Ok(path) => Ok(CommittedPaste {
                path,
                image_mime_type: upload.image_mime_type.take(),
            }),
            Err(error) => {
                discard_upload(Some(upload));
                Err(error.into())
            }
        }
    }

    /// Discards one upload or committed file group: a whole scope when `upload_id` is empty.
    pub fn discard(&mut self, scope: &str, upload_id: &str) -> Result<u32, PasteError> {
        if !upload_id.is_empty() {
            if !is_valid_upload_id(upload_id) {
                return Err(PasteError::InvalidArgument("upload ID"));
            }
            let upload = self.uploads.remove(upload_id);
            let removed = u32::from(upload.is_some());
            discard_upload(upload);
            return Ok(removed);
        }
        if !is_valid_scope(scope) {
            return Err(PasteError::InvalidArgument("scope"));
        }
        let pending: Vec<String> = self
            .uploads
            .iter()
            .filter(|(_, upload)| upload.scope == scope)
            .map(|(id, _)| id.clone())
            .collect();
        let mut removed = 0u32;
        for id in pending {
            discard_upload(self.uploads.remove(&id));
            removed += 1;
        }
        removed += remove_scope_directory(&self.root.join(scope))?;
        Ok(removed)
    }

    /// Removes files (and abandoned partials) older than the TTL, then empty scope folders.
    pub fn sweep(&mut self, now: SystemTime) -> Result<u32, PasteError> {
        let mut removed = 0u32;
        for entry in self.files()? {
            let active = self
                .uploads
                .values()
                .any(|upload| upload.partial == entry.path);
            let age = now.duration_since(entry.modified).unwrap_or(Duration::ZERO);
            if !active && age > self.limits.ttl {
                remove_if_present(&entry.path)?;
                removed += 1;
            }
        }
        for directory in self.scope_directories()? {
            if fs::read_dir(&directory)?.next().is_none() {
                fs::remove_dir(&directory)?;
            }
        }
        Ok(removed)
    }

    fn expire_idle(&mut self, now: Instant) {
        let idle = self.limits.upload_idle;
        let expired: Vec<String> = self
            .uploads
            .iter()
            .filter(|(_, upload)| now.duration_since(upload.touched) > idle)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            discard_upload(self.uploads.remove(&id));
        }
    }

    /// Evicts the oldest committed files until `incoming` fits under the total cap.
    fn make_room(&mut self, incoming: u64) -> Result<(), PasteError> {
        let mut files = self.files()?;
        let mut total: u64 = files.iter().map(|entry| entry.size).sum::<u64>() + incoming;
        files.retain(|entry| !is_partial(&entry.path));
        files.sort_by_key(|entry| entry.modified);
        for entry in files {
            if total <= self.limits.max_total_bytes {
                break;
            }
            remove_if_present(&entry.path)?;
            total = total.saturating_sub(entry.size);
        }
        if total > self.limits.max_total_bytes {
            return Err(PasteError::ResourceLimit("paste folder is full"));
        }
        Ok(())
    }

    fn random_name(&mut self, upload_id: &str) -> String {
        self.counter = self.counter.wrapping_add(1);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let digest = Sha256::new()
            .chain_update(upload_id.as_bytes())
            .chain_update(nanos.to_le_bytes())
            .chain_update(std::process::id().to_le_bytes())
            .chain_update(self.counter.to_le_bytes())
            .finalize();
        let hex: String = digest
            .iter()
            .take(12)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("paste-{hex}")
    }

    fn scope_directories(&self) -> Result<Vec<PathBuf>, PasteError> {
        let mut directories = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            if entry.file_type()?.is_dir() && name.to_str().is_some_and(is_valid_scope) {
                directories.push(entry.path());
            }
        }
        Ok(directories)
    }

    fn files(&self) -> Result<Vec<FileEntry>, PasteError> {
        let mut files = Vec::new();
        for directory in self.scope_directories()? {
            for entry in fs::read_dir(&directory)? {
                let entry = entry?;
                let metadata = entry.metadata()?;
                if entry.file_type()?.is_file() {
                    files.push(FileEntry {
                        path: entry.path(),
                        size: metadata.len(),
                        modified: metadata.modified()?,
                    });
                }
            }
        }
        Ok(files)
    }
}
