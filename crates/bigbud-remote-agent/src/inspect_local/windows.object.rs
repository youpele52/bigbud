use std::{io, mem::size_of, ptr};
use windows_sys::{
    Wdk::Foundation::{NtQueryObject, ObjectTypeInformation},
    Win32::Foundation::{HANDLE, RtlNtStatusToDosError, UNICODE_STRING},
};

/// Recheck a retained handle's kernel type without querying its contents or name.
pub(super) fn is_file(handle: HANDLE) -> io::Result<bool> {
    let mut buffer = [0usize; 512];
    let mut written = 0;
    // SAFETY: live duplicate, aligned fixed-size output; ObjectTypeInformation only returns type metadata.
    let status = unsafe {
        NtQueryObject(
            handle,
            ObjectTypeInformation,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut written,
        )
    };
    if status < 0 {
        // SAFETY: status is the NTSTATUS returned above.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    if written < size_of::<UNICODE_STRING>() as u32 || written as usize > size_of_val(&buffer) {
        return Err(io::Error::other("object type bound"));
    }
    // SAFETY: successful response starts with a UNICODE_STRING in an aligned buffer.
    let name = unsafe { ptr::read(buffer.as_ptr().cast::<UNICODE_STRING>()) };
    let start = buffer.as_ptr() as usize;
    let pointer = name.Buffer as usize;
    if name.Length == 0
        || !name.Length.is_multiple_of(2)
        || pointer < start
        || pointer
            .checked_add(usize::from(name.Length))
            .is_none_or(|end| end > start + written as usize)
        || !pointer.is_multiple_of(2)
    {
        return Err(io::Error::other("object type bound"));
    }
    // SAFETY: the counted UTF-16 span was checked to lie within the live output buffer.
    let text = unsafe { std::slice::from_raw_parts(name.Buffer, usize::from(name.Length) / 2) };
    Ok(text == [70, 105, 108, 101])
}

/// Recognize non-filesystem network/null devices when GetFileType cannot classify a File object.
pub(super) fn irrelevant_device(handle: HANDLE) -> io::Result<bool> {
    use windows_sys::{
        Wdk::Storage::FileSystem::{FileFsDeviceInformation, NtQueryVolumeInformationFile},
        Win32::System::IO::IO_STATUS_BLOCK,
    };
    // ntifs.h FILE_FS_DEVICE_INFORMATION: DEVICE_TYPE and ULONG Characteristics, both u32.
    let mut device = [0u32; 2];
    let mut status_block = IO_STATUS_BLOCK::default();
    // SAFETY: live retained handle and fixed correctly sized output; only device metadata is queried.
    let status = unsafe {
        NtQueryVolumeInformationFile(
            handle,
            &mut status_block,
            device.as_mut_ptr().cast(),
            size_of_val(&device) as u32,
            FileFsDeviceInformation,
        )
    };
    if status != 0 || status_block.Information != size_of_val(&device) {
        eprintln!(
            "local device classification status={status:#x} bytes={}",
            status_block.Information
        );
        return Err(io::Error::other("device classification unavailable"));
    }
    // FILE_DEVICE_NETWORK (not FILE_DEVICE_NETWORK_FILE_SYSTEM) and FILE_DEVICE_NULL.
    let irrelevant = matches!(device[0], 0x12 | 0x15);
    if !irrelevant {
        eprintln!("local device classification unsupported={:#x}", device[0]);
    }
    Ok(irrelevant)
}
