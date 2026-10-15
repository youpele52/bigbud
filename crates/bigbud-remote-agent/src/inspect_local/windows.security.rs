use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::{io, mem::size_of, ptr};
use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub(super) struct Sid(Vec<u32>);
impl Sid {
    pub(super) fn pointer(&self) -> PSID {
        self.0.as_ptr().cast_mut().cast()
    }
    fn matches(&self, other: PSID) -> bool {
        // SAFETY: other is a validated security descriptor SID for this call.
        unsafe { !other.is_null() && EqualSid(self.pointer(), other) != 0 }
    }
}

pub(super) fn process_user(process: HANDLE) -> io::Result<Sid> {
    let mut raw = ptr::null_mut();
    // SAFETY: process is live; output is valid and token requests query rights only.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken transferred an owned handle.
    let token = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut length = 0;
    // SAFETY: null buffer is the documented size query.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut length,
        );
    }
    if length == 0 || length > 65_536 {
        return Err(io::Error::other("token bound"));
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    // SAFETY: aligned allocation is at least length bytes and remains live.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful TokenUser response contains a valid TOKEN_USER and SID in buffer.
    unsafe {
        let sid = (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid;
        let length = GetLengthSid(sid) as usize;
        if length == 0 || length > 68 {
            return Err(io::Error::other("sid bound"));
        }
        let mut owned = vec![0u32; length.div_ceil(4)];
        ptr::copy_nonoverlapping(sid.cast::<u8>(), owned.as_mut_ptr().cast(), length);
        Ok(Sid(owned))
    }
}

pub(super) fn current_user() -> io::Result<Sid> {
    // SAFETY: pseudo handle is used only during process_user and is not closed.
    process_user(unsafe { GetCurrentProcess() })
}

fn well_known(kind: WELL_KNOWN_SID_TYPE) -> io::Result<Sid> {
    let mut buffer = vec![0u32; 17];
    let mut size = 68;
    // SAFETY: buffer holds SECURITY_MAX_SID_SIZE bytes; no domain SID is needed.
    if unsafe { CreateWellKnownSid(kind, ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Sid(buffer))
}

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: GetSecurityInfo allocated this descriptor with LocalAlloc.
        unsafe {
            LocalFree(self.0);
        }
    }
}

/// Check the opened object, not a pathname sampled separately from the eventual read.
pub(super) fn private_file(handle: HANDLE, ancestor: bool, owner_only: bool) -> io::Result<()> {
    check(handle, ancestor, owner_only, false)
}

/// Public configuration may be readable, but data/append writes remain owner-only.
pub(super) fn readable_file(handle: HANDLE) -> io::Result<()> {
    check(handle, false, false, true)
}

fn check(handle: HANDLE, ancestor: bool, owner_only: bool, public_read: bool) -> io::Result<()> {
    let user = current_user()?;
    let system = well_known(WinLocalSystemSid)?;
    let admins = well_known(WinBuiltinAdministratorsSid)?;
    // Exact NT SERVICE\TrustedInstaller SID; Windows owns the system-drive ancestor this way.
    // Only ancestor ownership/grants trust this service, never registration/database ownership.
    let installer = Sid(vec![
        0x00000601, 0x05000000, 80, 956008885, 3418522649, 1831038044, 1853292631, 2271478464,
    ]);
    let mut owner = ptr::null_mut();
    let mut acl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: live file handle has READ_CONTROL; output pointers are valid.
    let result = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let _guard = Descriptor(descriptor);
    if !user.matches(owner)
        && !(ancestor
            && (system.matches(owner) || admins.matches(owner) || installer.matches(owner)))
    {
        return Err(io::Error::other("owner rejected"));
    }
    if owner_only {
        return Ok(());
    }
    if acl.is_null() {
        return Err(io::Error::other("null dacl"));
    }
    // SAFETY: ACL comes from a valid descriptor retained by guard throughout iteration.
    unsafe {
        if (*acl).AceCount > 4096 {
            return Err(io::Error::other("acl bound"));
        }
        for index in 0..(*acl).AceCount {
            let mut raw = ptr::null_mut();
            if GetAce(acl, u32::from(index), &mut raw) == 0 {
                return Err(io::Error::last_os_error());
            }
            let header = &*raw.cast::<ACE_HEADER>();
            if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
                continue;
            }
            if header.AceType == 1 {
                continue;
            } // Deny ACE cannot grant access.
            if header.AceType != 0 || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
            {
                return Err(io::Error::other("unsupported acl"));
            }
            let ace = &*raw.cast::<ACCESS_ALLOWED_ACE>();
            let sid = ptr::from_ref(&ace.SidStart).cast_mut().cast();
            let trusted = user.matches(sid)
                || system.matches(sid)
                || admins.matches(sid)
                || (ancestor && installer.matches(sid));
            // Ancestors may be readable, but untrusted principals cannot replace children or mutate ACLs.
            let mutation = 0x10000000 | 0x40000000 | 0x000d0150 | if ancestor { 0 } else { 0x6 };
            if !trusted && (!(ancestor || public_read) || ace.Mask & mutation != 0) {
                return Err(io::Error::other("untrusted access"));
            }
        }
    }
    Ok(())
}
