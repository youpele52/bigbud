//! Narrow storage-shape check, not a loader, signature or native-closure verifier.
//! Public mach-o/{loader,fat,machine}.h: little-endian mach_header_64/MH_EXECUTE;
//! optional big-endian fat_header + fat_arch. FAT64/32-bit/swapped thin refuse.
//! Fixed positional reads: <=8 slices, <=4096 load commands, <=1 MiB commands.
use crate::native_fs::invalid;
use std::{fs::File, io, os::unix::fs::FileExt};

#[cfg(target_arch = "aarch64")]
const HOST_CPU: u32 = 0x0100_000c;
#[cfg(target_arch = "x86_64")]
const HOST_CPU: u32 = 0x0100_0007;

pub(super) fn validate(file: &File, length: u64) -> io::Result<()> {
    let magic = read::<4>(file, 0, length)?;
    if magic == [0xcf, 0xfa, 0xed, 0xfe] {
        return thin(file, 0, length, HOST_CPU);
    }
    if magic != [0xca, 0xfe, 0xba, 0xbe] {
        return Err(invalid());
    }
    let count = u32::from_be_bytes(read(file, 4, length)?);
    if count == 0 || count > 8 {
        return Err(invalid());
    }
    let table_end = 8 + u64::from(count) * 20;
    if table_end > length {
        return Err(invalid());
    }
    let mut ranges = Vec::new();
    let mut host = None;
    for index in 0..count {
        let offset = 8 + u64::from(index) * 20;
        let cpu = u32::from_be_bytes(read(file, offset, length)?);
        let subtype = u32::from_be_bytes(read(file, offset + 4, length)?);
        let start = u64::from(u32::from_be_bytes(read(file, offset + 8, length)?));
        let size = u64::from(u32::from_be_bytes(read(file, offset + 12, length)?));
        let align = u32::from_be_bytes(read(file, offset + 16, length)?);
        let end = start.checked_add(size).ok_or_else(invalid)?;
        if align > 30
            || start % (1_u64 << align) != 0
            || start < table_end
            || size < 32
            || end > length
            || ranges.iter().any(|&(a, b)| start < b && a < end)
        {
            return Err(invalid());
        }
        ranges.push((start, end));
        if cpu == HOST_CPU {
            if host.is_some() {
                return Err(invalid());
            }
            host = Some((start, end, subtype));
        }
    }
    let (start, end, subtype) = host.ok_or_else(invalid)?;
    if u32::from_le_bytes(read(file, start + 8, end)?) != subtype {
        return Err(invalid());
    }
    thin(file, start, end, HOST_CPU)
}

fn thin(file: &File, start: u64, end: u64, cpu: u32) -> io::Result<()> {
    if read::<4>(file, start, end)? != [0xcf, 0xfa, 0xed, 0xfe]
        || u32::from_le_bytes(read(file, start + 4, end)?) != cpu
        || u32::from_le_bytes(read(file, start + 12, end)?) != 2
        || u32::from_le_bytes(read(file, start + 28, end)?) != 0
    {
        return Err(invalid());
    }
    // Only baseline native CPU subtypes; e.g. arm64e is not silently qualified.
    let subtype = u32::from_le_bytes(read(file, start + 8, end)?);
    if subtype != if cpu == 0x0100_000c { 0 } else { 3 } {
        return Err(invalid());
    }
    let count = u32::from_le_bytes(read(file, start + 16, end)?);
    let size = u64::from(u32::from_le_bytes(read(file, start + 20, end)?));
    let mut cursor = start.checked_add(32).ok_or_else(invalid)?;
    let commands_end = cursor.checked_add(size).ok_or_else(invalid)?;
    if count == 0 || count > 4096 || size > 1024 * 1024 || commands_end > end {
        return Err(invalid());
    }
    for _ in 0..count {
        let _command = read::<4>(file, cursor, commands_end)?;
        let bytes = u64::from(u32::from_le_bytes(read(file, cursor + 4, commands_end)?));
        if bytes < 8 || bytes % 8 != 0 {
            return Err(invalid());
        }
        cursor = cursor.checked_add(bytes).ok_or_else(invalid)?;
        if cursor > commands_end {
            return Err(invalid());
        }
    }
    if cursor != commands_end {
        return Err(invalid());
    }
    Ok(())
}

fn read<const N: usize>(file: &File, offset: u64, end: u64) -> io::Result<[u8; N]> {
    if offset.checked_add(N as u64).ok_or_else(invalid)? > end {
        return Err(invalid());
    }
    let mut bytes = [0; N];
    file.read_exact_at(&mut bytes, offset)?;
    Ok(bytes)
}
