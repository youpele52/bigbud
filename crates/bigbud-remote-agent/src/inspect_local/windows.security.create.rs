use super::security;
use std::{io, ptr};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        PSECURITY_DESCRIPTOR,
    },
};

pub(super) struct PrivateDescriptor(pub PSECURITY_DESCRIPTOR);
impl Drop for PrivateDescriptor {
    fn drop(&mut self) {
        // SAFETY: the conversion API allocated this descriptor with LocalAlloc.
        unsafe {
            LocalFree(self.0);
        }
    }
}

/// Apply a protected current-user/SYSTEM/Administrators DACL at creation, never repair an existing ACL.
pub(super) fn descriptor(directory: bool) -> io::Result<PrivateDescriptor> {
    let user = security::current_user()?;
    let mut raw = ptr::null_mut();
    // SAFETY: owned valid user SID and a valid output pointer.
    if unsafe { ConvertSidToStringSidW(user.pointer(), &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut sid = Vec::new();
    // SAFETY: a successful conversion returns a NUL-terminated SID string. SID strings are bounded by 184 chars.
    unsafe {
        for index in 0..184 {
            let value = *raw.add(index);
            if value == 0 {
                break;
            }
            sid.push(value);
        }
        LocalFree(raw.cast());
    }
    if sid.len() >= 184 {
        return Err(io::Error::other("sid string bound"));
    }
    let sid = String::from_utf16(&sid).map_err(io::Error::other)?;
    let inherit = if directory { "OICI" } else { "" };
    let text =
        format!("O:{sid}D:P(A;{inherit};FA;;;{sid})(A;{inherit};FA;;;SY)(A;{inherit};FA;;;BA)\0");
    let text: Vec<u16> = text.encode_utf16().collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: fixed grammar plus OS-generated SID, NUL-terminated UTF16, valid output pointer.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(PrivateDescriptor(descriptor))
}
