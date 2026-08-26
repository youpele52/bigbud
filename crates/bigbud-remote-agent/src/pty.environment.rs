use super::PtyError;

const PROTECTED_NAMES: [&str; 5] = ["HOME", "PATH", "SHELL", "USER", "LOGNAME"];
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const INITIAL_PASSWD_BUFFER_BYTES: usize = 1024;
const MAX_PASSWD_BUFFER_BYTES: usize = 1024 * 1024;

struct AccountEnvironment {
    home: Option<String>,
    name: Option<String>,
    shell: Option<String>,
}

pub(super) fn remote_environment(
    requested: &[(String, String)],
) -> Result<Vec<(String, String)>, PtyError> {
    let account = account_environment()?;
    let inherited = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let shell = inherited("SHELL")
        .filter(|value| is_executable_absolute(value))
        .or_else(|| account.shell.filter(|value| is_executable_absolute(value)))
        .unwrap_or_else(|| "/bin/sh".to_owned());
    let home = inherited("HOME").or(account.home);
    let user = inherited("USER").or_else(|| account.name.clone());
    let logname = inherited("LOGNAME").or(account.name);

    let mut result = Vec::with_capacity(requested.len() + PROTECTED_NAMES.len());
    result.extend(home.map(|value| ("HOME".to_owned(), value)));
    result.push((
        "PATH".to_owned(),
        inherited("PATH").unwrap_or_else(|| DEFAULT_PATH.to_owned()),
    ));
    result.push(("SHELL".to_owned(), shell));
    result.extend(user.map(|value| ("USER".to_owned(), value)));
    result.extend(logname.map(|value| ("LOGNAME".to_owned(), value)));
    result.extend(
        requested
            .iter()
            .filter(|(name, _)| !PROTECTED_NAMES.contains(&name.as_str()))
            .cloned(),
    );
    Ok(result)
}

pub(super) fn is_executable_absolute(value: &str) -> bool {
    if !value.starts_with('/') || value.contains('\0') {
        return false;
    }
    if !std::fs::metadata(value)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return false;
    }
    let Ok(path) = std::ffi::CString::new(value) else {
        return false;
    };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let status =
        unsafe { libc::faccessat(libc::AT_FDCWD, path.as_ptr(), libc::X_OK, libc::AT_EACCESS) };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let status = unsafe { libc::access(path.as_ptr(), libc::X_OK) };
    status == 0
}

fn account_environment() -> Result<AccountEnvironment, PtyError> {
    Ok(lookup_account_environment()?.unwrap_or(AccountEnvironment {
        home: None,
        name: None,
        shell: None,
    }))
}

fn lookup_account_environment() -> Result<Option<AccountEnvironment>, PtyError> {
    let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let mut buffer_size = usize::try_from(suggested)
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(INITIAL_PASSWD_BUFFER_BYTES)
        .min(MAX_PASSWD_BUFFER_BYTES);
    let uid = unsafe { libc::geteuid() };

    loop {
        let mut passwd = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0u8; buffer_size];
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                passwd.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE && buffer_size < MAX_PASSWD_BUFFER_BYTES {
            buffer_size = buffer_size.saturating_mul(2).min(MAX_PASSWD_BUFFER_BYTES);
            continue;
        }
        if status != 0 {
            return Err(PtyError::Io(std::io::Error::from_raw_os_error(status)));
        }
        if result.is_null() {
            return Ok(None);
        }

        let passwd = unsafe { passwd.assume_init() };
        return Ok(Some(AccountEnvironment {
            home: owned_passwd_field(passwd.pw_dir),
            name: owned_passwd_field(passwd.pw_name),
            shell: owned_passwd_field(passwd.pw_shell),
        }));
    }
}

fn owned_passwd_field(field: *const libc::c_char) -> Option<String> {
    if field.is_null() {
        return None;
    }
    unsafe { std::ffi::CStr::from_ptr(field) }
        .to_str()
        .ok()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
