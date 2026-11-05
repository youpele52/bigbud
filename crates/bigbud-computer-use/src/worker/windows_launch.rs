//! Portable (host-testable) Windows launch encoding for first-party roles only:
//! a quoted absolute executable plus one fixed role word, and a sorted UTF-16
//! environment block. No model/caller argv, shell, or inherited environment.
#![cfg_attr(not(windows), allow(dead_code))]
use std::io;

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, reason)
}

/// `"C:\path\exe" role\0`. Quotes/NUL/control characters in the path refuse;
/// the role is one fixed lowercase word, so no CommandLineToArgvW escaping.
pub(crate) fn command_line(executable: &str, role: &str) -> io::Result<Vec<u16>> {
    let absolute = executable.len() > 3
        && executable.as_bytes().get(1) == Some(&b':')
        && executable.as_bytes().get(2) == Some(&b'\\')
        && executable
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic);
    if !absolute || executable.chars().any(|c| c == '"' || c.is_control()) {
        return Err(invalid("first-party executable path refused"));
    }
    if !["guard", "owner", "worker", "broker"].contains(&role) {
        return Err(invalid("unknown role"));
    }
    let text = format!("\"{executable}\" {role}");
    Ok(text.encode_utf16().chain(std::iter::once(0)).collect())
}

/// `K=V\0...\0\0`, sorted case-insensitively as CreateProcessW requires. Keys
/// are ASCII (so ordering/duplicates match Windows' per-character upcase),
/// nonempty, without '='; values without NUL; no duplicates. The managed
/// environment must supply `SystemRoot` itself; nothing is inherited.
pub(crate) fn environment_block(pairs: &[(String, String)]) -> io::Result<Vec<u16>> {
    let mut sorted: Vec<&(String, String)> = pairs.iter().collect();
    sorted.sort_by_key(|(key, _)| key.to_uppercase());
    let mut block = Vec::new();
    let mut previous: Option<String> = None;
    for (key, value) in sorted {
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_graphic() && b != b'=')
            || value.contains('\0')
        {
            return Err(invalid("environment entry refused"));
        }
        let folded = key.to_uppercase();
        if previous.as_ref() == Some(&folded) {
            return Err(invalid("duplicate environment key"));
        }
        previous = Some(folded);
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    fn text(units: &[u16]) -> String {
        String::from_utf16(units).unwrap()
    }
    #[test]
    fn command_line_is_fixed_quoted_role_only() {
        let line = command_line(r"C:\Program Files\bigbud\cu.exe", "worker").unwrap();
        assert_eq!(
            text(&line),
            "\"C:\\Program Files\\bigbud\\cu.exe\" worker\0"
        );
        for bad in [
            r"cu.exe",
            r"\\server\share\cu.exe",
            "C:\\a\"b.exe",
            "C:\\a\nb.exe",
            "C:",
        ] {
            assert!(command_line(bad, "worker").is_err(), "{bad}");
        }
        assert!(command_line(r"C:\cu.exe", "worker --script x").is_err());
    }
    #[test]
    fn environment_block_is_sorted_terminated_and_strict() {
        let pairs = [("b".into(), "2".into()), ("A".into(), "1".into())];
        assert_eq!(text(&environment_block(&pairs).unwrap()), "A=1\0b=2\0\0");
        assert_eq!(text(&environment_block(&[]).unwrap()), "\0\0");
        for pair in [
            ("", "x"),
            ("A=B", "x"),
            ("A\0", "x"),
            ("A", "x\0"),
            ("Straße", "x"),
        ] {
            assert!(environment_block(&[(pair.0.into(), pair.1.into())]).is_err());
        }
        let dup = [("Path".into(), "a".into()), ("PATH".into(), "b".into())];
        assert!(environment_block(&dup).is_err());
    }
}
