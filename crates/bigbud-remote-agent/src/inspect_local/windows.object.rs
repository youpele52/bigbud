use std::{io, mem::size_of, ptr};
use windows_sys::{
    Wdk::Foundation::{NtQueryObject, ObjectTypeInformation},
    Win32::Foundation::{HANDLE, RtlNtStatusToDosError, UNICODE_STRING},
};

/// Classify a retained handle when PSS supplies only its number, never its object contents/name.
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
