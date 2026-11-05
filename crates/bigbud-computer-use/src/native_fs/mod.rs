//! Native filesystem validation shared by transient transport and durable election.
pub(crate) mod acl;
pub(crate) mod descriptor;
pub(crate) mod storage;

pub(crate) fn invalid() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "untrusted filesystem identity or permissions",
    )
}

pub(crate) fn current_uid() -> std::io::Result<u32> {
    // SAFETY: identity queries take no pointers and cannot fail.
    let (real, effective) = unsafe { (libc::getuid(), libc::geteuid()) };
    if real == 0 || real != effective {
        return Err(invalid());
    }
    Ok(effective)
}
