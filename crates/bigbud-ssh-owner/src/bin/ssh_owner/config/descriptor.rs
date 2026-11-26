//! Effective alias descriptor digest for the saved-alias retargeting rule.
//!
//! The digest covers only the route and trust facts that decide *where* the
//! owner connects and *which* host key it accepts: destination, port, login,
//! host-key name and algorithm, ordered trust sources, the connector program
//! and the jump route.
//! Identity and timer settings are excluded. Changing the encoding requires a
//! new version tag so a stored binding fails closed instead of matching.

use super::ResolvedConfig;
use sha2::{Digest, Sha256};
use std::path::Path;

const VERSION: &[u8] = b"bigbud-ssh-alias-descriptor-v1";

fn field(out: &mut Sha256, tag: u8, value: &[u8]) {
    out.update([tag]);
    out.update((value.len() as u64).to_be_bytes());
    out.update(value);
}

fn path(out: &mut Sha256, tag: u8, value: &Path) {
    field(out, tag, value.as_os_str().as_encoded_bytes());
}

impl ResolvedConfig {
    pub(in super::super) fn descriptor_digest(&self) -> [u8; 32] {
        let mut out = Sha256::new();
        field(&mut out, 0, VERSION);
        field(&mut out, 1, self.host.to_string().as_bytes());
        field(&mut out, 2, &self.port.to_be_bytes());
        field(&mut out, 3, self.user.as_bytes());
        field(
            &mut out,
            4,
            self.host_key_alias.as_deref().unwrap_or("").as_bytes(),
        );
        field(&mut out, 5, self.host_verification.option().as_bytes());
        field(&mut out, 6, &[u8::from(self.hash_known_hosts)]);
        for known_hosts in self.known_hosts.iter() {
            path(&mut out, 7, known_hosts);
        }
        for known_hosts in &self.additional_user_known_hosts {
            path(&mut out, 8, known_hosts);
        }
        for known_hosts in &self.global_known_hosts {
            path(&mut out, 9, known_hosts);
        }
        if let Some(connector) = &self.connector {
            field(&mut out, 11, connector.descriptor_operand());
        }
        #[cfg(any(test, target_os = "linux"))]
        for hop in self.jump.iter().flat_map(|route| route.value.iter()) {
            hop.write_descriptor(&mut |bytes| field(&mut out, 10, bytes));
        }
        out.finalize().into()
    }
}
