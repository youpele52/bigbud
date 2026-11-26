//! U23 multi-type pins: at most one pinned key per host-key type. A server
//! verifies when it presents any pinned key; a different key of a pinned type,
//! or only types that are not pinned, is `HostKeyChanged`.

use super::{ErrorCode, HostKey, Pin};

impl Pin {
    pub(super) fn single(record: String, key: HostKey) -> Self {
        Self {
            key,
            others: Vec::new(),
            record,
        }
    }

    /// An approval or re-read of `key` against this pin: already pinned, or
    /// the host's key has changed.
    pub(super) fn check_key(&self, key: &HostKey) -> Result<(), ErrorCode> {
        if self.contains(key) {
            Ok(())
        } else {
            Err(ErrorCode::HostKeyChanged)
        }
    }

    pub(in super::super) fn contains(&self, key: &HostKey) -> bool {
        self.keys().any(|pinned| pinned == key)
    }

    pub(in super::super) fn has_type(&self, key: &HostKey) -> bool {
        self.keys().any(|pinned| pinned.kind() == key.kind())
    }

    /// Another matching trust record: the same type must be the same key; a
    /// new type joins the pin, keeping the most preferred key first.
    pub(super) fn add(&mut self, key: HostKey, record: &str) -> Result<(), ErrorCode> {
        if self.has_type(&key) {
            return self.check_key(&key);
        }
        self.record.push_str(record);
        if key.kind() < self.key.kind() {
            let previous = std::mem::replace(&mut self.key, key);
            self.others.push(previous);
        } else {
            self.others.push(key);
        }
        Ok(())
    }

    /// `HostKeyAlgorithms` for exactly the pinned types, ed25519 first; RSA
    /// only with SHA-2 signatures.
    pub(in super::super) fn host_key_algorithms(&self) -> String {
        let mut kinds: Vec<_> = self.keys().map(HostKey::kind).collect();
        kinds.sort();
        let algorithms: Vec<_> = kinds.into_iter().map(|kind| kind.algorithms()).collect();
        format!("HostKeyAlgorithms={}", algorithms.join(","))
    }

    fn keys(&self) -> impl Iterator<Item = &HostKey> {
        std::iter::once(&self.key).chain(&self.others)
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::host_key::fixtures::{ECDSAB256, RSAB2048};
    use super::*;

    const LABEL: &str = "[10.0.0.5]:2222";
    const ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn key(record: &str) -> HostKey {
        HostKey::from_record(format!("{LABEL} {record}\n").as_bytes(), LABEL).unwrap()
    }

    #[test]
    fn a_pin_holds_one_key_per_type_and_prefers_ed25519() {
        let (rsa, ecdsa) = (key(RSAB2048.0), key(ECDSAB256.0));
        let mut pin = Pin::single(rsa.record(LABEL), rsa.clone());
        assert_eq!(
            pin.host_key_algorithms(),
            "HostKeyAlgorithms=rsa-sha2-512,rsa-sha2-256"
        );
        pin.add(ecdsa.clone(), &ecdsa.record(LABEL)).unwrap();
        pin.add(key(ED25519), &key(ED25519).record(LABEL)).unwrap();
        assert!(pin.key == key(ED25519));
        assert!(pin.contains(&rsa) && pin.contains(&ecdsa));
        assert_eq!(
            pin.host_key_algorithms(),
            "HostKeyAlgorithms=ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256"
        );
        // A different key of a pinned type has changed.
        let other = key(&format!(
            "{}B",
            ED25519.strip_suffix('A').expect("ends in A")
        ));
        assert_eq!(
            pin.add(other.clone(), "x\n"),
            Err(ErrorCode::HostKeyChanged)
        );
        assert_eq!(pin.check_key(&other), Err(ErrorCode::HostKeyChanged));
    }
}
