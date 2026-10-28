//! Public Darwin libSystem ACL APIs from the installed sys/acl.h. libc 0.2.189
//! does not declare these functions. Opaque pointers only; no private ABI layout.
//! Entry tags/masks: SDK acl_get_tag_type(3), acl_get_permset_mask_np(3),
//! sys/acl.h. Iteration: Apple Libc posix1e/acl_entry.c (FIRST=0, NEXT=-1,
//! end=-1/EINVAL). chmod(1) distinguishes deny entries from access grants.
//! Rejecting all mutating grants (even owner-only or inherit-only grants) avoids
//! principal/group/order inference. Such customized ACLs require explicit future
//! support; never strip/repair them or silently switch authority roots.
use std::{ffi::c_void, io, os::fd::AsRawFd};

unsafe extern "C" {
    fn filesec_init() -> *mut c_void;
    fn filesec_free(security: *mut c_void);
    fn filesec_query_property(
        security: *mut c_void,
        property: libc::c_int,
        present: *mut libc::c_int,
    ) -> libc::c_int;
    fn filesec_get_property(
        security: *mut c_void,
        property: libc::c_int,
        output: *mut c_void,
    ) -> libc::c_int;
    // Same inode64 symbol selection as libc::fstat and public sys/cdefs.h.
    #[cfg_attr(target_arch = "x86_64", link_name = "fstatx_np$INODE64")]
    fn fstatx_np(fd: libc::c_int, stat: *mut libc::stat, security: *mut c_void) -> libc::c_int;
    fn acl_valid(acl: *mut c_void) -> libc::c_int;
    fn acl_get_entry(acl: *mut c_void, id: libc::c_int, entry: *mut *mut c_void) -> libc::c_int;
    // Public sys/acl.h: acl_tag_t is a C enum; acl_permset_mask_t is u_int64_t.
    fn acl_get_tag_type(entry: *mut c_void, tag: *mut libc::c_int) -> libc::c_int;
    fn acl_get_permset_mask_np(entry: *mut c_void, mask: *mut u64) -> libc::c_int;
    fn acl_free(object: *mut c_void) -> libc::c_int;
}

pub(crate) fn require_empty(file: &impl AsRawFd) -> io::Result<()> {
    validate(file, Policy::Empty)
}

#[derive(Clone, Copy)]
pub(crate) enum Policy {
    Empty,
    // Deny entries cannot grant access. Permit only non-mutating ancestor grants;
    // don't attempt group membership/order evaluation or ignore inherit-only ACEs.
    Ancestor,
    Private,
}

pub(crate) fn validate(file: &impl AsRawFd, policy: Policy) -> io::Result<()> {
    // SAFETY: read-only capability query on the live fd. Unsupported filesystems
    // are not silently treated as an empty ACL; -1/zero/unknown all refuse.
    if unsafe { libc::fpathconf(file.as_raw_fd(), libc::_PC_EXTENDED_SECURITY_NP) } != 1 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ACL support unavailable",
        ));
    }
    let security = Security::read(file)?;
    let mut present = 0;
    // SAFETY: live filesec object, FILESEC_ACL = 5, writable integer output.
    if unsafe { filesec_query_property(security.0, 5, &mut present) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if present == 0 {
        return Ok(());
    }
    let mut acl: *mut c_void = std::ptr::null_mut();
    // SAFETY: successful filesec snapshot; output holds a new ACL allocation.
    if unsafe { filesec_get_property(security.0, 5, (&mut acl as *mut *mut c_void).cast()) } != 0
        || acl.is_null()
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: acl is the live libSystem-owned opaque allocation just returned.
    let valid = unsafe { acl_valid(acl) };
    let result = if valid != 0 {
        Err(io::Error::last_os_error())
    } else {
        entries(acl, policy)
    };
    // SAFETY: sole owner of the nonnull allocation, freed exactly once.
    if unsafe { acl_free(acl) } != 0 {
        return Err(io::Error::last_os_error());
    }
    result
}

fn entries(acl: *mut c_void, policy: Policy) -> io::Result<()> {
    // SDK sys/acl.h read/list, search, read attributes/xattrs/security, synchronize.
    // Explicit allowlist rejects all mutation and unknown/future rights.
    const READ_ONLY: u64 = (1 << 1) | (1 << 3) | (1 << 7) | (1 << 9) | (1 << 11) | (1 << 20);
    for index in 0..=128 {
        let mut entry = std::ptr::null_mut();
        // SAFETY: validated live ACL, FIRST=0/NEXT=-1; writable pointer slot.
        let status = unsafe { acl_get_entry(acl, if index == 0 { 0 } else { -1 }, &mut entry) };
        if status == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL)
            && entry.is_null()
        {
            return Ok(()); // Darwin end-of-entries (Libc posix1e/acl_entry.c).
        }
        if status != 0 || entry.is_null() || index == 128 || matches!(policy, Policy::Empty) {
            return Err(super::invalid());
        }
        let mut tag = 0;
        let mut mask = 0_u64;
        // SAFETY: entry belongs to the retained ACL; outputs match public SDK ABI.
        if unsafe { acl_get_tag_type(entry, &mut tag) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if tag == 2 {
            continue;
        } // ACL_EXTENDED_DENY never grants rights.
        // SAFETY: live entry; exactly u_int64_t-sized writable mask storage.
        if unsafe { acl_get_permset_mask_np(entry, &mut mask) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let allowed = if matches!(policy, Policy::Ancestor) {
            READ_ONLY
        } else {
            0
        };
        if tag != 1 || mask & !allowed != 0 {
            return Err(super::invalid());
        }
    }
    Err(super::invalid())
}

struct Security(*mut c_void);
impl Security {
    fn read(file: &impl AsRawFd) -> io::Result<Self> {
        // SAFETY: allocator takes no arguments and returns an owned opaque object.
        let raw = unsafe { filesec_init() };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let security = Self(raw);
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: live fd, correctly sized libc stat storage, owned filesec object.
        // Separate syscall success from absent ACL; acl_get_fd_np alone conflates
        // absent-property ENOENT with read errors (Libc acl_file.c/filesec.c).
        if unsafe { fstatx_np(file.as_raw_fd(), stat.as_mut_ptr(), security.0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(security)
    }
}
impl Drop for Security {
    fn drop(&mut self) {
        // SAFETY: this wrapper is sole owner of the nonnull filesec allocation.
        unsafe { filesec_free(self.0) };
    }
}

#[cfg(test)]
pub(crate) fn clear_test_acl(file: &impl AsRawFd) {
    unsafe extern "C" {
        fn acl_init(count: libc::c_int) -> *mut c_void;
        fn acl_set_fd_np(fd: libc::c_int, acl: *mut c_void, kind: libc::c_int) -> libc::c_int;
    }
    // SAFETY: zero-entry ACL allocation, owned solely by this fixture.
    let acl = unsafe { acl_init(0) };
    assert!(!acl.is_null());
    // SAFETY: live fixture fd and ACL allocation; no production path.
    let status = unsafe { acl_set_fd_np(file.as_raw_fd(), acl, 0x100) };
    // SAFETY: sole-owned allocation is freed once.
    assert_eq!(unsafe { acl_free(acl) }, 0);
    assert_eq!(status, 0);
}

#[cfg(test)]
pub(crate) fn install_test_acl(file: &impl AsRawFd) {
    install_test_acl_text(
        file,
        c"!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:deny:delete\n",
    );
}

#[cfg(test)]
pub(crate) fn install_test_acl_text(file: &impl AsRawFd, text: &std::ffi::CStr) {
    unsafe extern "C" {
        fn acl_from_text(text: *const libc::c_char) -> *mut c_void;
        fn acl_set_fd_np(fd: libc::c_int, acl: *mut c_void, kind: libc::c_int) -> libc::c_int;
    }
    // SAFETY: borrowed NUL-terminated public ACL text; parser retains no pointer.
    let acl = unsafe { acl_from_text(text.as_ptr()) };
    assert!(!acl.is_null(), "fixture ACL parse failed: {text:?}");
    // SAFETY: live exclusively owned fixture fd and ACL; no production path.
    let status = unsafe { acl_set_fd_np(file.as_raw_fd(), acl, 0x100) };
    // SAFETY: the test owns this allocation and frees it once.
    assert_eq!(unsafe { acl_free(acl) }, 0);
    assert_eq!(status, 0);
}
