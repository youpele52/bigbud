//! Declarations from installed public AuthSession.h, CGSession.h and CF headers.
//! No vendor implementation copied. Security header: APSL-2.0; CG: Apple SDK
//! terms; CF: Apache-2.0 with Runtime Library Exception portions. SDK usage is
//! subject to installed Apple terms. All types below are the public scalar /
//! opaque-reference ABI, not guessed framework structure layouts.
use super::SnapshotError;
use std::{
    ffi::{CStr, c_char, c_void},
    ptr::NonNull,
};
type Ref = *const c_void;

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SessionGetInfo(session: u32, actual: *mut u32, attributes: *mut u32) -> i32;
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGSessionCopyCurrentDictionary() -> Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberIsFloatType(number: Ref) -> u8;
    fn CFNumberGetValue(number: Ref, kind: isize, output: *mut c_void) -> u8;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(boolean: Ref) -> u8;
    fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
}

// Owns exactly one Create/Copy reference, never a borrowed dictionary value.
// Production construction sites accept only actual SDK Create/Copy returns;
// private cfg(test) fixtures also wrap their own CF Create results.
struct Owned(NonNull<c_void>);
impl Owned {
    fn created(value: Ref) -> Result<Self, SnapshotError> {
        NonNull::new(value.cast_mut())
            .map(Self)
            .ok_or(SnapshotError::Malformed)
    }
    fn raw(&self) -> Ref {
        self.0.as_ptr()
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: one live +1 Create/Copy reference, exclusively owned; borrowed
        // children never enter Owned. All borrows end before this release.
        unsafe { CFRelease(self.raw()) };
        #[cfg(test)]
        RELEASES.with(|count| count.set(count.get() + 1));
    }
}
#[cfg(test)]
thread_local! { static RELEASES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

// Exact CFSTR literals from installed public CGSession.h. Note the header's
// LoginDone literal has a single "S" prefix unlike the other three keys.
const USER_ID_KEY: &CStr = c"kCGSSessionUserIDKey";
const CONSOLE_SET_KEY: &CStr = c"kCGSSessionConsoleSetKey";
const ON_CONSOLE_KEY: &CStr = c"kCGSSessionOnConsoleKey";
const LOGIN_DONE_KEY: &CStr = c"kCGSessionLoginDoneKey";
#[cfg(test)]
const KEYS: [&CStr; 4] = [USER_ID_KEY, CONSOLE_SET_KEY, ON_CONSOLE_KEY, LOGIN_DONE_KEY];

pub(super) struct Console {
    pub(super) uid: u32,
    pub(super) set: u32,
    pub(super) on_console: bool,
    pub(super) login_done: bool,
}
pub(super) fn security() -> Result<(u32, u32), SnapshotError> {
    let (mut actual, mut bits) = (0, 0);
    // SAFETY: callerSecuritySession asks only about this process, with correctly
    // sized live UInt32 outputs. No session is created or mutated.
    let status = unsafe { SessionGetInfo(u32::MAX, &mut actual, &mut bits) };
    security_result(status, actual, bits)
}
fn security_result(status: i32, actual: u32, bits: u32) -> Result<(u32, u32), SnapshotError> {
    if status != 0 {
        return Err(SnapshotError::Security);
    }
    Ok((actual, bits))
}
pub(super) fn console() -> Result<Console, SnapshotError> {
    // SAFETY: public no-input Copy API returns either NULL or a retained CF
    // object. Ownership is immediately captured; this function is dormant.
    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    decode_copy(raw)
}
fn decode_copy(raw: Ref) -> Result<Console, SnapshotError> {
    if raw.is_null() {
        return Err(SnapshotError::NoGui);
    }
    let dictionary = Owned::created(raw)?;
    // SAFETY: live owned CF object. Type ID APIs take no pointer arguments.
    if unsafe { CFGetTypeID(dictionary.raw()) != CFDictionaryGetTypeID() } {
        return Err(SnapshotError::Malformed);
    }
    Ok(Console {
        uid: uint(&dictionary, USER_ID_KEY)?,
        set: uint(&dictionary, CONSOLE_SET_KEY)?,
        on_console: boolean(&dictionary, ON_CONSOLE_KEY)?,
        login_done: boolean(&dictionary, LOGIN_DONE_KEY)?,
    })
}
fn key(text: &CStr) -> Result<Owned, SnapshotError> {
    // SAFETY: NUL-terminated static ASCII/public key string; NULL selects default
    // allocator, UTF-8 encoding constant from CFString.h. Create yields +1.
    Owned::created(unsafe {
        CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), 0x08000100)
    })
}
// Use the borrowed value only inside the owner's lifetime, never release it.
fn value(dictionary: &Owned, text: &CStr) -> Result<Ref, SnapshotError> {
    let key = key(text)?;
    // SAFETY: decoder established CFDictionary type; live CFString key. A value
    // remains borrowed from the retained immutable dictionary after key release.
    let value = unsafe { CFDictionaryGetValue(dictionary.raw(), key.raw()) };
    if value.is_null() {
        return Err(SnapshotError::Malformed);
    }
    Ok(value)
}
fn uint(dictionary: &Owned, text: &CStr) -> Result<u32, SnapshotError> {
    let value = value(dictionary, text)?;
    // SAFETY: nonnull borrowed CF object held alive by dictionary, then checked
    // as CFNumber before any number-specific API. Booleans are not numbers here.
    if unsafe { CFGetTypeID(value) != CFNumberGetTypeID() || CFNumberIsFloatType(value) != 0 } {
        return Err(SnapshotError::Malformed);
    }
    let mut output = 0_i64;
    // SAFETY: live checked integer CFNumber; SInt64=4 and writable i64 storage.
    // Ignore converted output on a false/lossy result.
    if unsafe { CFNumberGetValue(value, 4, (&mut output as *mut i64).cast()) } == 0 {
        return Err(SnapshotError::Malformed);
    }
    u32::try_from(output).map_err(|_| SnapshotError::Malformed)
}
fn boolean(dictionary: &Owned, text: &CStr) -> Result<bool, SnapshotError> {
    let value = value(dictionary, text)?;
    // SAFETY: nonnull live borrowed CF object; check type before boolean API.
    if unsafe { CFGetTypeID(value) != CFBooleanGetTypeID() } {
        return Err(SnapshotError::Malformed);
    }
    // SAFETY: checked live CFBoolean borrowed for owner's lifetime.
    Ok(unsafe { CFBooleanGetValue(value) } != 0)
}
#[cfg(test)]
#[path = "framework.tests.rs"]
mod tests;
