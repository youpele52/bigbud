//! Validation for every client-supplied path component. Validated components only contain
//! `[a-z0-9]`, so joined paths cannot escape the paste folder or need shell quoting.

const IMAGE_MIME_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

fn lower_alnum(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// One terminal generation: 32 lowercase hex characters.
pub fn is_valid_scope(scope: &str) -> bool {
    scope.len() == 32 && scope.bytes().all(|byte| byte.is_ascii_hexdigit()) && lower_alnum(scope)
}

pub fn is_valid_upload_id(upload_id: &str) -> bool {
    (16..=64).contains(&upload_id.len()) && lower_alnum(upload_id)
}

pub fn is_valid_extension(extension: &str) -> bool {
    (1..=10).contains(&extension.len()) && lower_alnum(extension)
}

/// Empty means "not an image"; anything else must be a supported image type.
pub fn is_valid_image_mime_type(mime_type: &str) -> bool {
    mime_type.is_empty() || IMAGE_MIME_TYPES.contains(&mime_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_separators_and_spaces() {
        for bad in ["../etc", "a/b", "a b", "A", "", "a\0b", "a.b"] {
            assert!(!is_valid_extension(bad), "{bad:?}");
            assert!(!is_valid_upload_id(bad), "{bad:?}");
            assert!(!is_valid_scope(bad), "{bad:?}");
        }
        assert!(!is_valid_scope("0123456789abcdef0123456789ABCDEF"));
        assert!(is_valid_scope("0123456789abcdef0123456789abcdef"));
        assert!(is_valid_upload_id("0123456789abcdef"));
        assert!(is_valid_extension("png"));
        assert!(is_valid_image_mime_type(""));
        assert!(is_valid_image_mime_type("image/png"));
        assert!(!is_valid_image_mime_type("image/svg+xml"));
    }
}
