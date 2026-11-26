use super::*;
use crate::windows_owner_pipe::security::LocalAllocation;
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER,
    Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
    DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
    GetSecurityDescriptorOwner, OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED,
};

#[test]
fn bound_pipe_has_only_the_owner_ace_and_no_inheritance() {
    let pipe = OwnerPipe::create().expect("create owner pipe");
    let mut owner = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: live pipe and writable output slots; SID/DACL point into the returned descriptor.
    let result = unsafe {
        GetSecurityInfo(
            pipe.handle.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    assert_eq!(result, 0, "query bound pipe security descriptor");
    let _allocation = LocalAllocation::from_conversion(descriptor).expect("read ACL allocation");
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: the descriptor remains owned by _allocation; outputs are valid.
    assert_ne!(
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
        0
    );
    assert_ne!(control & SE_DACL_PROTECTED, 0);
    assert!(!owner.is_null() && !dacl.is_null());
    let expected = owner_descriptor().expect("get owner security descriptor");
    let mut expected_sid = ptr::null_mut();
    let mut defaulted = 0;
    // SAFETY: expected descriptor remains live and the API can fill both outputs.
    assert_ne!(
        unsafe {
            GetSecurityDescriptorOwner(
                expected.attributes().lpSecurityDescriptor,
                &mut expected_sid,
                &mut defaulted,
            )
        },
        0
    );
    assert!(!expected_sid.is_null());
    // SAFETY: both SIDs come from successful descriptor queries and remain live.
    assert_ne!(unsafe { EqualSid(owner, expected_sid) }, 0);
    // SAFETY: non-null DACL from the live pipe descriptor.
    assert_eq!(unsafe { (*dacl).AceCount }, 1);
    let mut ace = ptr::null_mut();
    // SAFETY: index zero is present; the returned ACE stays live with the descriptor.
    assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
    assert!(!ace.is_null());
    // SAFETY: the kernel ACL contains a valid ACE header at this address.
    let header = unsafe { &*ace.cast::<ACE_HEADER>() };
    assert_eq!(header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
    assert_eq!(header.AceFlags, 0);
    // SAFETY: the validated allow ACE includes a SID at SidStart.
    let ace_sid = unsafe { ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart) };
    // SAFETY: both valid SIDs are backed by the live pipe descriptor.
    assert_ne!(unsafe { EqualSid(owner, ace_sid.cast()) }, 0);
}
