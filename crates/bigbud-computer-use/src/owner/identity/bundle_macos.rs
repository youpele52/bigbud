//! CFBundle identifier lookup (installed public CFBundle.h/CFURL.h/CFString.h
//! declarations; CoreFoundation is already linked by this crate). Reads the
//! bundle's Info.plist metadata only: no code is loaded, nothing is launched.
use super::verified::valid_bundle_identifier;
use std::{
    ffi::{c_char, c_void},
    os::unix::ffi::OsStrExt,
    path::Path,
};

type Ref = *const c_void;
const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: Ref,
        buffer: *const u8,
        length: isize,
        is_directory: u8,
    ) -> Ref;
    fn CFBundleCreate(allocator: Ref, url: Ref) -> Ref;
    fn CFBundleGetIdentifier(bundle: Ref) -> Ref;
    fn CFStringGetCString(value: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
}

/// Owned CF reference released on drop.
struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: only non-null references returned by a CF Create function.
        unsafe { CFRelease(self.0) };
    }
}
fn owned(value: Ref) -> Option<Owned> {
    // Lazy on purpose: an eagerly built `Owned(null)` would be dropped and
    // `CFRelease(NULL)` traps.
    (!value.is_null()).then(|| Owned(value))
}

/// `None` when the bundle cannot be opened or declares no valid identifier.
pub(super) fn bundle_identifier(bundle: &Path) -> Option<String> {
    let bytes = bundle.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.len() > 4096 {
        return None;
    }
    // SAFETY: valid byte buffer and length; null allocator selects the default.
    let url = owned(unsafe {
        CFURLCreateFromFileSystemRepresentation(
            std::ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
            1,
        )
    })?;
    // SAFETY: live URL reference; the returned bundle is owned (Create rule).
    let handle = owned(unsafe { CFBundleCreate(std::ptr::null(), url.0) })?;
    // SAFETY: live bundle; Get rule, so the string is NOT released here and is
    // only read while `handle` keeps the bundle alive.
    let identifier = unsafe { CFBundleGetIdentifier(handle.0) };
    if identifier.is_null() {
        return None;
    }
    let mut buffer = [0 as c_char; 256];
    // SAFETY: live CFString; writable buffer of the stated size; CF writes a
    // NUL-terminated UTF-8 string or fails (identifiers > 255 bytes fail).
    let ok =
        unsafe { CFStringGetCString(identifier, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
    if ok == 0 {
        return None;
    }
    // SAFETY: CFStringGetCString succeeded, so buffer holds a NUL-terminated string.
    let value = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .ok()?
        .to_owned();
    valid_bundle_identifier(&value).then_some(value)
}
