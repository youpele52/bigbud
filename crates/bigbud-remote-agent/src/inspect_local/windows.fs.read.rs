use super::{
    file,
    fs_handles::{self, Directory},
    security,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read, Seek},
    mem::{offset_of, size_of},
    os::windows::{fs::MetadataExt, io::AsRawHandle},
    ptr,
};
use windows_sys::Win32::{Foundation::ERROR_NO_MORE_FILES, Storage::FileSystem::*};

pub(super) struct Contents {
    pub file: File,
    pub id: String,
    pub hash: String,
    pub bytes: Vec<u8>,
}

pub(super) fn validate(file: &File, private: bool) -> io::Result<()> {
    let info = file.metadata()?;
    let mut standard = FILE_STANDARD_INFO::default();
    // SAFETY: live handle and correctly sized initialized output.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            ptr::from_mut(&mut standard).cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if !info.is_file()
        || info.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || standard.NumberOfLinks != 1
    {
        return Err(io::Error::other("regular single-link file required"));
    }
    if private {
        security::private_file(file.as_raw_handle(), false, false)
    } else {
        security::readable_file(file.as_raw_handle())
    }
}

pub(super) fn contents(mut file: File, private: bool, max: usize) -> io::Result<Contents> {
    if max > 1_048_576 {
        return Err(io::Error::other("read bound"));
    }
    validate(&file, private)?;
    let id = file::identity(&file)?;
    let before = file.metadata()?;
    if before.len() > max as u64 {
        return Err(io::Error::other("read bound"));
    }
    file.rewind()?;
    let mut bytes = Vec::new();
    file.by_ref().take(max as u64 + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    validate(&file, private)?;
    if bytes.len() > max
        || before.len() != bytes.len() as u64
        || after.len() != before.len()
        || after.last_write_time() != before.last_write_time()
        || file::identity(&file)? != id
    {
        return Err(io::Error::other("read changed"));
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(Contents {
        file,
        id,
        hash,
        bytes,
    })
}

pub(super) fn read(
    parent: &Directory,
    name: &str,
    private: bool,
    max: usize,
) -> io::Result<Contents> {
    contents(
        fs_handles::child(
            parent,
            name,
            false,
            false,
            FILE_READ_DATA,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
        )?,
        private,
        max,
    )
}

/// Enumerate through the retained handle, not a re-resolved directory pathname.
pub(super) fn list(parent: &Directory) -> io::Result<Vec<String>> {
    let mut words = vec![0u64; 8192];
    let mut result = Vec::new();
    for _ in 0..4097 {
        // SAFETY: aligned initialized 64-KiB buffer and live directory handle with list access.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                parent.handle()?.as_raw_handle(),
                FileIdBothDirectoryInfo,
                words.as_mut_ptr().cast(),
                65_536,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                parent.revalidate()?;
                return Ok(result);
            }
            return Err(error);
        }
        // SAFETY: allocation initialized above; byte borrow stays within its lifetime.
        let bytes = unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), 65_536) };
        let mut at = 0usize;
        loop {
            if at
                .checked_add(size_of::<FILE_ID_BOTH_DIR_INFO>())
                .is_none_or(|end| end > bytes.len())
            {
                return Err(io::Error::other("directory frame bound"));
            }
            // SAFETY: bounded structure prefix checked above; OS fields may be unaligned within the byte buffer.
            let info = unsafe {
                ptr::read_unaligned(bytes.as_ptr().add(at).cast::<FILE_ID_BOTH_DIR_INFO>())
            };
            let start = at + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            let end = start
                .checked_add(info.FileNameLength as usize)
                .ok_or_else(|| io::Error::other("name bound"))?;
            let raw = bytes
                .get(start..end)
                .ok_or_else(|| io::Error::other("name bound"))?;
            if !raw.len().is_multiple_of(2) {
                return Err(io::Error::other("name encoding"));
            }
            let name: Vec<u16> = raw
                .chunks_exact(2)
                .map(|pair| <[u8; 2]>::try_from(pair).map(u16::from_le_bytes))
                .collect::<Result<_, _>>()
                .map_err(io::Error::other)?;
            let name = String::from_utf16(&name).map_err(io::Error::other)?;
            if name != "." && name != ".." {
                if result.len() >= 4096 {
                    return Err(io::Error::other("directory count bound"));
                }
                fs_handles::component(&name)?;
                result.push(name);
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            if (info.NextEntryOffset as usize) < size_of::<FILE_ID_BOTH_DIR_INFO>() {
                return Err(io::Error::other("directory offset rejected"));
            }
            at = at
                .checked_add(info.NextEntryOffset as usize)
                .ok_or_else(|| io::Error::other("directory offset bound"))?;
        }
    }
    Err(io::Error::other("directory iteration bound"))
}
