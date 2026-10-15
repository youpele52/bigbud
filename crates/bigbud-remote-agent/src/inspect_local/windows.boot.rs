use super::{boot_decode, protocol::hex};
use std::{ffi::c_void, io, mem, ptr};
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::{
        LibraryLoader::{GetModuleHandleW, GetProcAddress},
        SystemInformation::GetSystemFirmwareTable,
        Threading::{GetCurrentProcess, GetCurrentProcessId},
    },
};

type QueryProcess = unsafe extern "system" fn(HANDLE, i32, *mut c_void, u32, *mut u32) -> i32;

/// Read kernel boot generation and firmware identity; no environment, registry or service fallback.
pub(super) fn observe() -> io::Result<String> {
    let name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    // SAFETY: a fixed NUL-terminated KnownDLL name; this borrows the loaded module, never loads a path.
    let module = unsafe { GetModuleHandleW(name.as_ptr()) };
    if module.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fixed exported symbol in the live borrowed ntdll module.
    let symbol = unsafe { GetProcAddress(module, c"NtQueryInformationProcess".as_ptr().cast()) }
        .ok_or_else(|| io::Error::other("kernel boot query unavailable"))?;
    // SAFETY: NtQueryInformationProcess has this documented ABI. Unsupported information classes fail below.
    let query: QueryProcess = unsafe { mem::transmute(symbol) };
    let mut words = vec![0u64; 8192];
    let mut returned = 0;
    // SAFETY: aligned initialized 64-KiB output and valid length pointer; current-process pseudo handle is borrowed.
    let status = unsafe {
        query(
            GetCurrentProcess(),
            64,
            words.as_mut_ptr().cast(),
            65_536,
            &mut returned,
        )
    };
    if status < 0 || !(92..=65_536).contains(&returned) {
        return Err(io::Error::other("kernel boot telemetry unavailable"));
    }
    // SAFETY: returned is bounded by the initialized allocation above; borrowing bytes does not outlive words.
    let bytes =
        unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), returned as usize) };
    // SAFETY: this process's numeric ID; no inspected external process or process-control authority.
    let (counter, ticks) = boot_decode::telemetry(bytes, unsafe { GetCurrentProcessId() })?;
    let provider = u32::from_be_bytes(*b"RSMB");
    // SAFETY: documented size query for the fixed raw SMBIOS firmware provider.
    let size = unsafe { GetSystemFirmwareTable(provider, 0, ptr::null_mut(), 0) };
    if !(8..=1_048_576).contains(&size) {
        return Err(io::Error::other("firmware identity unavailable"));
    }
    let mut firmware = vec![0u8; size as usize];
    // SAFETY: allocated output matches the bounded size; fixed provider/table, no caller address.
    if unsafe { GetSystemFirmwareTable(provider, 0, firmware.as_mut_ptr().cast(), size) } != size {
        return Err(io::Error::other("firmware identity changed"));
    }
    let uuid = boot_decode::firmware_uuid(&firmware)?;
    Ok(format!(
        "OK\t{}\t{counter}\t{}\t{}",
        hex(&uuid),
        ticks / 10_000_000,
        ticks % 10_000_000 / 10
    ))
}
