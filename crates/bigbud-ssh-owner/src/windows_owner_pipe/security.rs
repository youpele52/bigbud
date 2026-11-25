use super::process::owned;
use std::{ffi::c_void, io, mem::size_of, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, SECURITY_MAX_SID_SIZE, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

pub(super) struct LocalAllocation(ptr::NonNull<c_void>);

impl LocalAllocation {
    pub(super) fn from_conversion(raw: *mut c_void) -> io::Result<Self> {
        ptr::NonNull::new(raw)
            .map(Self)
            .ok_or_else(|| io::Error::other("missing owner pipe security allocation"))
    }
}

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: the conversion API supplied this LocalAlloc allocation.
        unsafe { LocalFree(self.0.as_ptr()) };
    }
}

pub(super) struct OwnerDescriptor(LocalAllocation);

impl OwnerDescriptor {
    pub(super) fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (self.0).0.as_ptr(),
            bInheritHandle: 0,
        }
    }
}

pub(super) fn owner_descriptor() -> io::Result<OwnerDescriptor> {
    let sid = current_user_sid()?;
    // Protected DACL; the process token's user is the owner and sole allowed SID.
    // No creator defaults, inherited ACEs, or separate administrator/SYSTEM grants.
    let sddl: Vec<_> = format!("O:{sid}D:P(A;;GA;;;{sid})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: SDDL is fixed grammar with the OS-generated SID, NUL terminated, with valid output storage.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(OwnerDescriptor(LocalAllocation::from_conversion(
        descriptor,
    )?))
}

fn current_user_sid() -> io::Result<String> {
    let mut raw = ptr::null_mut();
    // SAFETY: the pseudo handle is borrowed, output is valid, token requests only query rights.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken transferred a fresh token handle on success.
    let token = unsafe { owned(raw) }?;
    const WORDS: usize =
        (size_of::<TOKEN_USER>() + SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>());
    let mut buffer = [0usize; WORDS];
    let mut length = 0;
    // SAFETY: aligned initialized buffer holds TOKEN_USER and a maximum-sized SID.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size_of::<[usize; WORDS]>() as u32,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut text = ptr::null_mut();
    // SAFETY: successful TokenUser query places the header and valid SID in the live buffer.
    if unsafe {
        ConvertSidToStringSidW((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let text = LocalAllocation::from_conversion(text.cast())?;
    let mut wide = Vec::new();
    for index in 0..184 {
        // SAFETY: successful conversion produced a NUL-terminated UTF-16 SID;
        // we stop before reading past its first terminator.
        let unit = unsafe { *text.0.cast::<u16>().as_ptr().add(index) };
        if unit == 0 {
            return String::from_utf16(&wide).map_err(io::Error::other);
        }
        wide.push(unit);
    }
    Err(io::Error::other("owner pipe SID exceeds bound"))
}
