//! Endpoint policy remains empty ACL; durable-root policy is separate.
pub(super) use crate::native_fs::acl::require_empty;
#[cfg(test)]
pub(super) use crate::native_fs::acl::{clear_test_acl, install_test_acl};
