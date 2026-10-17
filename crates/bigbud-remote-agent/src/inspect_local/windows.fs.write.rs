use super::{
    file,
    fs_handles::{self, Directory},
    fs_read, security,
};
use std::{
    io::{self, Write},
    mem::size_of,
    os::windows::io::AsRawHandle,
    ptr,
};
use windows_sys::Win32::Storage::FileSystem::*;

fn absent(parent: &Directory, name: &str) -> io::Result<()> {
    match fs_handles::child(
        parent,
        name,
        false,
        false,
        0,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
    ) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination exists",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn move_through(parent: &Directory, from: &str, to: &str, replace: bool) -> io::Result<()> {
    let source = parent.child_path(from)?;
    let target = parent.child_path(to)?;
    parent.revalidate()?;
    // SAFETY: NUL-terminated volume-GUID names derived from the retained directory. All ancestors remain non-delete-shared.
    // Never COPY_ALLOWED or DELAY_UNTIL_REBOOT: only same-directory, synchronous namespace publication.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_WRITE_THROUGH
                | if replace {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                },
        )
    } == 0
    {
        return Err(io::Error::other("publication uncertain"));
    }
    Ok(())
}

/// Fully flushed private creation; existing entries and partial staging are never repaired/reclaimed.
pub(super) fn create(
    parent: &Directory,
    name: &str,
    staging: &str,
    bytes: &[u8],
) -> io::Result<(String, String)> {
    if bytes.len() > 131_072 || name.eq_ignore_ascii_case(staging) {
        return Err(io::Error::other("create bound"));
    }
    absent(parent, name)?;
    let mut output = fs_handles::child(
        parent,
        staging,
        true,
        false,
        FILE_READ_DATA | FILE_GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
    )?;
    (|| {
        security::private_file(output.as_raw_handle(), false, false)?;
        output.write_all(bytes)?;
        output.sync_all()?;
        let written_id = file::identity(&output)?;
        drop(output);
        let source = fs_read::read(parent, staging, true, 131_072)?;
        if source.bytes != bytes || source.id != written_id {
            return Err(io::Error::other("staging mismatch"));
        }
        absent(parent, name)?;
        move_through(parent, staging, name, false)?;
        let published = fs_read::read(parent, name, true, 131_072)?;
        if source.id != published.id || source.hash != published.hash {
            return Err(io::Error::other("publication uncertain"));
        }
        Ok((published.id, published.hash))
    })()
    .map_err(|_: io::Error| io::Error::other("publication uncertain"))
}

/// Expected file identity AND bytes are mandatory; caller-signed evidence stays in TypeScript.
pub(super) fn publish(
    parent: &Directory,
    from: &str,
    source_id: &str,
    source_hash: &str,
    to: &str,
    expected_id: &str,
    expected_hash: &str,
) -> io::Result<(String, String)> {
    if from.eq_ignore_ascii_case(to) {
        return Err(io::Error::other("same entry rejected"));
    }
    let source = fs_read::read(parent, from, true, 131_072)?;
    if source.id != source_id || source.hash != source_hash {
        return Err(io::Error::other("identity conflict"));
    }
    let target = if expected_id == "-" && expected_hash == "-" {
        absent(parent, to)?;
        None
    } else {
        let value = fs_read::read(parent, to, true, 131_072)?;
        if value.id != expected_id || value.hash != expected_hash {
            return Err(io::Error::other("identity conflict"));
        }
        Some(value)
    };
    // Source and destination deny concurrent data writers. Same-user namespace races are fenced
    // by the signed app writer lock and post-publication identity check, as on the POSIX path.
    move_through(parent, from, to, target.is_some())?;
    let result = fs_read::read(parent, to, true, 131_072)
        .map_err(|_| io::Error::other("publication uncertain"))?;
    if result.id != source.id || result.hash != source.hash {
        return Err(io::Error::other("publication uncertain"));
    }
    Ok((result.id, result.hash))
}

pub(super) fn mkdir(parent: &Directory, name: &str, staging: &str) -> io::Result<String> {
    if name.eq_ignore_ascii_case(staging) {
        return Err(io::Error::other("same entry rejected"));
    }
    absent(parent, name)?;
    let directory = fs_handles::child(
        parent,
        staging,
        true,
        true,
        FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )?;
    (|| {
        security::private_file(directory.as_raw_handle(), false, false)?;
        let id = file::identity(&directory)?;
        move_through(parent, staging, name, false)?;
        let current = fs_handles::child(
            parent,
            name,
            false,
            true,
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )?;
        if file::identity(&current)? != id {
            return Err(io::Error::other("publication uncertain"));
        }
        Ok(id)
    })()
    .map_err(|_: io::Error| io::Error::other("publication uncertain"))
}

/// Exact owned-file removal only. A crash can retain a lock; it never authorizes reclaiming a foreign lock.
pub(super) fn remove(
    parent: &Directory,
    name: &str,
    expected_id: &str,
    expected_hash: &str,
) -> io::Result<()> {
    let value = fs_read::contents(
        fs_handles::child(parent, name, false, false, FILE_READ_DATA | DELETE, 0)?,
        true,
        131_072,
    )?;
    if value.id != expected_id || value.hash != expected_hash {
        return Err(io::Error::other("identity conflict"));
    }
    parent.revalidate()?;
    let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: exact live non-shared file handle with DELETE, initialized correctly sized input; no pathname unlink.
    if unsafe {
        SetFileInformationByHandle(
            value.file.as_raw_handle(),
            FileDispositionInfo,
            ptr::from_mut(&mut disposition).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::other("publication uncertain"));
    }
    drop(value);
    Ok(())
}
