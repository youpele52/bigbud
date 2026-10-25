use std::io;

fn u32_at(bytes: &[u8], offset: usize) -> io::Result<u32> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| io::Error::other("boot evidence truncated"))?
        .try_into()
        .map_err(io::Error::other)?;
    Ok(u32::from_le_bytes(raw))
}

fn u64_at(bytes: &[u8], offset: usize) -> io::Result<u64> {
    let raw: [u8; 8] = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| io::Error::other("boot evidence truncated"))?
        .try_into()
        .map_err(io::Error::other)?;
    Ok(u64::from_le_bytes(raw))
}

/// Decode the documented Windows 10+ PROCESS_TELEMETRY_ID_INFORMATION prefix.
pub(super) fn telemetry(bytes: &[u8], pid: u32) -> io::Result<(u32, u64)> {
    let header = u32_at(bytes, 0)? as usize;
    if !(92..=65_536).contains(&header) || header > bytes.len() || u32_at(bytes, 4)? != pid {
        return Err(io::Error::other("boot telemetry header rejected"));
    }
    let created = u64_at(bytes, 16)?;
    let interrupt = u64_at(bytes, 24)?;
    let boot = created
        .checked_sub(interrupt)
        .and_then(|value| value.checked_sub(116_444_736_000_000_000))
        .ok_or_else(|| io::Error::other("boot telemetry time rejected"))?;
    if interrupt == 0 || boot == 0 {
        return Err(io::Error::other("boot telemetry time rejected"));
    }
    Ok((u32_at(bytes, 60)?, boot))
}

/// Accept one non-placeholder system UUID from the bounded OS-provided raw SMBIOS table.
pub(super) fn firmware_uuid(bytes: &[u8]) -> io::Result<[u8; 16]> {
    if bytes.len() < 8 || bytes.len() > 1_048_576 || u32_at(bytes, 4)? as usize != bytes.len() - 8 {
        return Err(io::Error::other("firmware table header rejected"));
    }
    let mut at = 8;
    let mut uuid = None;
    for _ in 0..4096 {
        let header: [u8; 4] = bytes
            .get(at..at + 4)
            .ok_or_else(|| io::Error::other("firmware record truncated"))?
            .try_into()
            .map_err(io::Error::other)?;
        let [kind, length, _, _] = header;
        let length = usize::from(length);
        if length < 4 || at + length > bytes.len() {
            return Err(io::Error::other("firmware record length rejected"));
        }
        if kind == 1 {
            if uuid.is_some() || length < 24 {
                return Err(io::Error::other("firmware identity ambiguous"));
            }
            let raw: [u8; 16] = bytes
                .get(at + 8..at + 24)
                .ok_or_else(|| io::Error::other("firmware identity truncated"))?
                .try_into()
                .map_err(io::Error::other)?;
            if raw.iter().all(|value| *value == 0) || raw.iter().all(|value| *value == 255) {
                return Err(io::Error::other("firmware identity unavailable"));
            }
            uuid = Some(raw);
        }
        at += length;
        let terminator = bytes
            .get(at..)
            .ok_or_else(|| io::Error::other("firmware strings truncated"))?
            .windows(2)
            .position(|pair| pair == [0, 0])
            .ok_or_else(|| io::Error::other("firmware strings truncated"))?;
        at += terminator + 2;
        if kind == 127 || at == bytes.len() {
            return uuid.ok_or_else(|| io::Error::other("firmware identity unavailable"));
        }
    }
    Err(io::Error::other("firmware inventory bound exceeded"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_uses_kernel_boot_counter_not_process_sequence_or_wall_time() {
        let mut bytes = vec![0u8; 96];
        bytes[..4].copy_from_slice(&96u32.to_le_bytes());
        bytes[4..8].copy_from_slice(&42u32.to_le_bytes());
        bytes[16..24].copy_from_slice(&116_444_736_200_000_000u64.to_le_bytes());
        bytes[24..32].copy_from_slice(&100_000_000u64.to_le_bytes());
        bytes[60..64].copy_from_slice(&7u32.to_le_bytes());
        assert_eq!(telemetry(&bytes, 42).ok(), Some((7, 100_000_000)));
        assert!(telemetry(&bytes, 43).is_err());
        assert!(telemetry(&bytes[..60], 42).is_err());
        bytes[..4].copy_from_slice(&128u32.to_le_bytes());
        assert!(telemetry(&bytes, 42).is_err());
    }

    #[test]
    fn firmware_requires_bounded_nonplaceholder_system_identity() {
        let mut bytes = vec![0u8; 34];
        bytes[4..8].copy_from_slice(&26u32.to_le_bytes());
        bytes[8] = 1;
        bytes[9] = 24;
        bytes[16..32].fill(7);
        assert_eq!(firmware_uuid(&bytes).ok(), Some([7; 16]));
        for value in [0, 255] {
            bytes[16..32].fill(value);
            assert!(firmware_uuid(&bytes).is_err());
        }
        bytes[16..32].fill(7);
        assert!(firmware_uuid(&bytes[..33]).is_err());
        bytes[9] = 0;
        assert!(firmware_uuid(&bytes).is_err());
    }
}
