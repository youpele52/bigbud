//! U2: keyboard-interactive is unqualified.
//!
//! The decision comes only from OpenSSH method configuration, never from prompt
//! or diagnostic text. A destination whose only eligible method is
//! keyboard-interactive is refused with `KeyboardInteractiveUnsupported`
//! before any askpass listener, master or secret release is created.

use super::ErrorCode;

const UNSUPPORTED: ErrorCode = ErrorCode::KeyboardInteractiveUnsupported;

/// Refuses a configuration in which keyboard-interactive is the only eligible
/// destination method. Every method option must be explicit, so an ambiguous
/// configuration fails closed as `ConfigUnsupported`.
pub(super) fn admit(options: &[&str]) -> Result<(), ErrorCode> {
    let mut preferred: Option<&str> = None;
    let mut keyboard: Option<bool> = None;
    let mut password: Option<bool> = None;
    let mut public_key: Option<bool> = None;
    for option in options {
        let (name, value) = option.split_once('=').ok_or(ErrorCode::ConfigUnsupported)?;
        match name.to_ascii_lowercase().as_str() {
            "preferredauthentications" => preferred = Some(value),
            "kbdinteractiveauthentication" => keyboard = Some(boolean(value)?),
            "passwordauthentication" => password = Some(boolean(value)?),
            "pubkeyauthentication" => public_key = Some(boolean(value)?),
            _ => {}
        }
    }
    let eligible: Vec<&str> = if let Some(value) = preferred {
        value
            .split(',')
            .map(str::trim)
            .filter(|method| !method.is_empty())
            .collect()
    } else {
        let keyboard = keyboard.ok_or(ErrorCode::ConfigUnsupported)?;
        let password = password.ok_or(ErrorCode::ConfigUnsupported)?;
        let public_key = public_key.ok_or(ErrorCode::ConfigUnsupported)?;
        let mut methods = Vec::new();
        if public_key {
            methods.push("publickey");
        }
        if password {
            methods.push("password");
        }
        if keyboard {
            methods.push("keyboard-interactive");
        }
        methods
    };
    if eligible.is_empty() {
        return Err(ErrorCode::ConfigUnsupported);
    }
    if eligible
        .iter()
        .all(|method| method.eq_ignore_ascii_case("keyboard-interactive"))
    {
        return Err(UNSUPPORTED);
    }
    Ok(())
}

fn boolean(value: &str) -> Result<bool, ErrorCode> {
    match value.to_ascii_lowercase().as_str() {
        "yes" | "true" => Ok(true),
        "no" | "false" => Ok(false),
        _ => Err(ErrorCode::ConfigUnsupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[&str] = &[
        "PreferredAuthentications=publickey",
        "PasswordAuthentication=no",
        "PubkeyAuthentication=yes",
        "KbdInteractiveAuthentication=no",
    ];
    const PASSWORD: &[&str] = &[
        "PreferredAuthentications=password",
        "PasswordAuthentication=yes",
        "PubkeyAuthentication=no",
        "KbdInteractiveAuthentication=no",
    ];
    const KEYBOARD_ONLY: &[&str] = &[
        "PreferredAuthentications=keyboard-interactive",
        "PasswordAuthentication=no",
        "PubkeyAuthentication=no",
        "KbdInteractiveAuthentication=yes",
    ];

    #[test]
    fn keyboard_interactive_is_refused_from_method_configuration() {
        assert_eq!(admit(KEY), Ok(()));
        assert_eq!(admit(PASSWORD), Ok(()));
        assert_eq!(
            admit(KEYBOARD_ONLY),
            Err(ErrorCode::KeyboardInteractiveUnsupported)
        );
    }

    #[test]
    fn keyboard_interactive_with_a_native_method_is_not_the_only_eligible_one() {
        let mixed = [
            "PreferredAuthentications=keyboard-interactive,password",
            "PasswordAuthentication=yes",
            "PubkeyAuthentication=no",
            "KbdInteractiveAuthentication=yes",
        ];
        assert_eq!(admit(&mixed), Ok(()));
    }

    #[test]
    fn keyboard_interactive_guard_fails_closed_on_ambiguous_configuration() {
        // A key-only or password-only method list needs no boolean restatement.
        assert_eq!(
            admit(&["PreferredAuthentications=keyboard-interactive"]),
            Err(ErrorCode::KeyboardInteractiveUnsupported)
        );
        for options in [
            &[
                "PreferredAuthentications=keyboard-interactive",
                "KbdInteractiveAuthentication=maybe",
                "PasswordAuthentication=no",
                "PubkeyAuthentication=no",
            ][..],
            &[
                "PreferredAuthentications=",
                "KbdInteractiveAuthentication=yes",
                "PasswordAuthentication=no",
                "PubkeyAuthentication=no",
            ][..],
            &["not-an-option"][..],
        ] {
            assert_eq!(admit(options), Err(ErrorCode::ConfigUnsupported));
        }
    }
}
