use super::macho;
use crate::guard::test_support::TestDirectory;
use std::{
    fs::{self, File},
    io::Write,
};

pub(crate) fn thin_bytes() -> Vec<u8> {
    #[cfg(target_arch = "aarch64")]
    let (cpu, subtype): (u32, u32) = (0x0100_000c, 0);
    #[cfg(target_arch = "x86_64")]
    let (cpu, subtype): (u32, u32) = (0x0100_0007, 3);
    let mut bytes = Vec::new();
    // Synthetically well-shaped UUID command, NOT executable/signature evidence.
    for word in [
        0xfeed_facf,
        cpu,
        subtype,
        2,
        1,
        24,
        0,
        0,
        0x1b,
        24,
        0,
        0,
        0,
        0,
    ] {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    bytes
}
fn accepts(bytes: &[u8]) -> bool {
    let base = TestDirectory::new();
    fs::write(base.0.join("shape"), bytes).unwrap();
    macho::validate(
        &File::open(base.0.join("shape")).unwrap(),
        bytes.len() as u64,
    )
    .is_ok()
}
fn replace(bytes: &mut [u8], offset: usize, value: u32, big: bool) {
    bytes
        .get_mut(offset..offset + 4)
        .unwrap()
        .copy_from_slice(&if big {
            value.to_be_bytes()
        } else {
            value.to_le_bytes()
        });
}
fn fat() -> Vec<u8> {
    let thin = thin_bytes();
    let cpu = u32::from_le_bytes(thin.get(4..8).unwrap().try_into().unwrap());
    let subtype = u32::from_le_bytes(thin.get(8..12).unwrap().try_into().unwrap());
    let mut bytes = Vec::new();
    for word in [0xcafe_babe, 1, cpu, subtype, 32, thin.len() as u32, 3] {
        bytes.extend_from_slice(&word.to_be_bytes());
    }
    bytes.resize(32, 0);
    bytes.extend_from_slice(&thin);
    bytes
}

#[test]
fn thin_and_universal_host_shape_positive_controls_and_every_truncation() {
    for bytes in [thin_bytes(), fat()] {
        assert!(accepts(&bytes));
        for length in 0..bytes.len() {
            assert!(!accepts(bytes.get(..length).unwrap()), "{length}");
        }
    }
}

#[test]
fn thin_header_and_command_bounds_refuse_without_large_allocations() {
    for (offset, value) in [
        (0, 0xfeed_face),
        (4, 7),
        (8, 2),
        (12, 6),
        (16, 0),
        (16, 4097),
        (16, u32::MAX),
        (20, u32::MAX),
        (20, 8),
        (20, 32),
        (28, 1),
        (36, 0),
        (36, 4),
        (36, 9),
        (36, u32::MAX),
        (36, 16),
    ] {
        let mut bytes = thin_bytes();
        replace(&mut bytes, offset, value, false);
        assert!(!accepts(&bytes), "{offset}: {value}");
    }
}

#[test]
fn universal_table_range_alignment_cpu_and_subtype_refusals() {
    for (offset, value) in [
        (0, 0xcafe_babf),
        (4, 0),
        (4, 9),
        (4, u32::MAX),
        (8, 7),
        (12, 99),
        (16, 0),
        (16, 33),
        (16, u32::MAX),
        (20, 0),
        (20, u32::MAX),
        (24, 31),
    ] {
        let mut bytes = fat();
        replace(&mut bytes, offset, value, true);
        assert!(!accepts(&bytes), "{offset}: {value}");
    }
    let mut bytes = fat();
    replace(&mut bytes, 36, 7, false); // host table must agree with thin CPU
    assert!(!accepts(&bytes));
}

#[test]
fn duplicate_or_overlapping_host_slices_refuse() {
    let original = fat();
    for overlap in [true, false] {
        let mut bytes = original.get(..28).unwrap().to_vec();
        replace(&mut bytes, 4, 2, true);
        replace(&mut bytes, 16, 48, true);
        bytes.extend_from_slice(original.get(8..28).unwrap());
        replace(&mut bytes, 36, if overlap { 48 } else { 104 }, true);
        bytes.extend_from_slice(&thin_bytes());
        if !overlap {
            bytes.extend_from_slice(&thin_bytes());
        }
        assert!(!accepts(&bytes));
    }
}

#[test]
fn retained_length_cannot_hide_truncation_and_u32_range_addition_never_wraps() {
    let base = TestDirectory::new();
    let path = base.0.join("shape");
    fs::write(&path, thin_bytes()).unwrap();
    let file = File::open(&path).unwrap();
    macho::validate(&file, 56).unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(36)
        .unwrap();
    assert!(macho::validate(&file, 56).is_err()); // actual read must fail too
    let mut bytes = fat();
    replace(&mut bytes, 16, 0xffff_fff8, true);
    replace(&mut bytes, 20, 56, true);
    let mut writer = File::options()
        .write(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    writer.write_all(&bytes).unwrap();
    assert!(macho::validate(&file, 0x1_0000_0030).is_err()); // no narrowing wrap/read at 48
}
