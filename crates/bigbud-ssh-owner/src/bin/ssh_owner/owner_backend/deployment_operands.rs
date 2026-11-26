//! Operand rules for production deployment steps. Every accepted value is a
//! quote-free ASCII string, so the recipe's single quoting is exact.

const MAX_HOME: usize = 4096;
const MAX_URL: usize = 2048;
const MAX_INSTALL_NAME: usize = 128;
const MAX_GRAPH_PATH: usize = 1024;

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(lower_hex)
}

pub(crate) fn valid_authority(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(lower_hex)
}

pub(crate) fn valid_request_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => lower_hex(byte),
        })
}

pub(super) fn valid_home(value: &str) -> bool {
    value.len() <= MAX_HOME
        && value.strip_prefix('/').is_some_and(|rest| {
            !rest.split('/').any(|part| matches!(part, "." | ".."))
                && rest.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'.' | b'_' | b'/' | b'@' | b'+' | b'-')
                })
        })
}

pub(super) fn valid_install_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.len() <= MAX_INSTALL_NAME
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

pub(super) fn valid_graph_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_GRAPH_PATH
        && !value.starts_with('/')
        && !value.contains("..")
        && !value.split('/').any(str::is_empty)
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-' | b'/')
        })
}

pub(super) fn valid_url(value: &str) -> bool {
    value.starts_with("https://")
        && value.len() <= MAX_URL
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'.' | b'_'
                        | b'~'
                        | b':'
                        | b'/'
                        | b'?'
                        | b'#'
                        | b'@'
                        | b'!'
                        | b'*'
                        | b'+'
                        | b','
                        | b'='
                        | b'%'
                        | b'('
                        | b')'
                        | b'['
                        | b']'
                        | b'-'
                )
        })
}
