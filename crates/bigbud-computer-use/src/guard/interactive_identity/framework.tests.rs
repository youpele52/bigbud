use super::*;
unsafe extern "C" {
    fn CFNumberCreate(allocator: Ref, kind: isize, value: Ref) -> Ref;
    fn CFDictionaryCreate(
        allocator: Ref,
        keys: *const Ref,
        values: *const Ref,
        count: isize,
        key_callbacks: Ref,
        value_callbacks: Ref,
    ) -> Ref;
    // Opaque symbols: addresses only, no vendor callback struct layout copied.
    static kCFTypeDictionaryKeyCallBacks: u8;
    static kCFBooleanTrue: Ref;
    static kCFBooleanFalse: Ref;
}
fn integer(value: i64) -> Owned {
    // SAFETY: SInt64 type=4 matches live i64 input; default allocator, +1 return.
    Owned::created(unsafe { CFNumberCreate(std::ptr::null(), 4, (&value as *const i64).cast()) })
        .unwrap()
}
fn float(value: f64) -> Owned {
    // SAFETY: Float64 type=6 matches live f64 input, +1 result.
    Owned::created(unsafe { CFNumberCreate(std::ptr::null(), 6, (&value as *const f64).cast()) })
        .unwrap()
}
fn dictionary(values: &[Ref]) -> Owned {
    let keys: Vec<_> = KEYS
        .into_iter()
        .take(values.len())
        .map(|text| key(text).unwrap())
        .collect();
    let keys: Vec<_> = keys.iter().map(Owned::raw).collect();
    // SAFETY: bounded equally-sized arrays of live CFString keys/CF values. SDK
    // key callbacks retain/equal keys; NULL value callbacks borrow fixture values
    // kept alive across decode by callers. +1 dictionary transfers to decoder.
    Owned::created(unsafe {
        CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            values.len() as isize,
            std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
            std::ptr::null(),
        )
    })
    .unwrap()
}
fn transfer(value: Owned) -> Ref {
    let raw = value.raw();
    std::mem::forget(value);
    raw
}
fn booleans() -> (Ref, Ref) {
    // SAFETY: public immutable CFBoolean singleton symbols, no ownership transfer.
    unsafe { (kCFBooleanTrue, kCFBooleanFalse) }
}
#[test]
fn retained_dictionary_success_and_failure_release_exact_owned_references() {
    let uid = integer(501);
    let console = integer(u32::MAX as i64);
    let (yes, _) = booleans();
    let dict = dictionary(&[uid.raw(), console.raw(), yes, yes]);
    let before = RELEASES.with(|n| n.get());
    let result = decode_copy(transfer(dict)).unwrap();
    assert_eq!(
        (result.uid, result.set, result.on_console, result.login_done),
        (501, u32::MAX, true, true)
    );
    assert_eq!(RELEASES.with(|n| n.get()) - before, 5); // dictionary + four temporary keys, not values
    let wrong = key(c"not a dictionary").unwrap();
    let before = RELEASES.with(|n| n.get());
    assert!(matches!(
        decode_copy(transfer(wrong)),
        Err(SnapshotError::Malformed)
    ));
    assert_eq!(RELEASES.with(|n| n.get()) - before, 1);
    assert!(matches!(
        decode_copy(std::ptr::null()),
        Err(SnapshotError::NoGui)
    ));
    assert!(Owned::created(std::ptr::null()).is_err());
}
#[test]
fn public_keys_missing_wrong_types_floats_negative_and_overflow_refuse() {
    let uid = integer(501);
    let console = integer(0);
    let text = key(c"501").unwrap();
    let (yes, no) = booleans();
    for count in 0..4 {
        let values = [uid.raw(), console.raw(), yes, yes];
        assert!(decode_copy(transfer(dictionary(&values[..count]))).is_err());
    }
    for slot in 0..4 {
        let mut values = [uid.raw(), console.raw(), yes, yes];
        values[slot] = text.raw();
        assert!(decode_copy(transfer(dictionary(&values))).is_err());
    }
    for bad in [
        integer(-1),
        integer(u32::MAX as i64 + 1),
        integer(i64::MAX),
        float(501.0),
        float(501.5),
        float(f64::NAN),
        float(f64::INFINITY),
    ] {
        for slot in 0..2 {
            let mut values = [uid.raw(), console.raw(), yes, yes];
            values[slot] = bad.raw();
            assert!(decode_copy(transfer(dictionary(&values))).is_err());
        }
    }
    assert!(decode_copy(transfer(dictionary(&[yes, console.raw(), yes, yes]))).is_err());
    assert!(
        decode_copy(transfer(dictionary(&[
            uid.raw(),
            console.raw(),
            uid.raw(),
            yes
        ])))
        .is_err()
    );
    let result = decode_copy(transfer(dictionary(&[uid.raw(), console.raw(), no, no]))).unwrap();
    assert!(!result.on_console && !result.login_done); // parsed, then refused by sampler
}
#[test]
fn security_error_outputs_are_never_used() {
    assert_eq!(security_result(0, 42, 0x10), Ok((42, 0x10)));
    for status in [-60500, -60502, -60008, 1] {
        assert_eq!(
            security_result(status, 42, 0x10),
            Err(SnapshotError::Security)
        );
    }
}
#[test]
fn keys_match_installed_public_cgsession_header_literals() {
    // Transcribed independently from MacOSX.sdk CGSession.h CFSTR(...) values,
    // not from KEYS. Shared fixture/production misspellings cannot pass here.
    let header = [
        "kCGSSessionUserIDKey",
        "kCGSSessionConsoleSetKey",
        "kCGSSessionOnConsoleKey",
        "kCGSessionLoginDoneKey",
    ];
    for (actual, expected) in KEYS.into_iter().zip(header) {
        assert_eq!(actual.to_str(), Ok(expected));
    }
}
