//! Synthetic path namespaces and the only tokens the proof expands.

use super::source::Scope;
use super::syntax::safe_host;
use super::{ErrorCode, UNSUPPORTED};
use std::path::{Path, PathBuf};

pub(super) const MAX_PATH: usize = 4096;
const MAX_COMPONENTS: usize = 32;
const SYNTHETIC_HOME: &str = "home";

pub(super) struct Route<'a> {
    pub host: &'a str,
    pub alias: &'a str,
    pub port: u16,
    pub user: Option<&'a str>,
}

pub(super) fn hostname(operand: &str, alias: &str) -> Result<String, ErrorCode> {
    const MAX_HOST: usize = 255;
    // HostName's %h is the original destination, not the route so far.
    let expanded = expand(operand, MAX_HOST, |token| match token {
        b'h' => Some(alias),
        b'%' => Some("%"),
        _ => None,
    })?;
    if !safe_host(&expanded) {
        return Err(UNSUPPORTED);
    }
    Ok(expanded)
}

pub(super) fn validate_auth_operand(operand: &str) -> Result<(), ErrorCode> {
    validate_auth_path(operand, false)
}

pub(super) fn validate_user_trust_operand(operand: &str) -> Result<(), ErrorCode> {
    validate_auth_path(operand, true)
}

fn validate_auth_path(operand: &str, trust: bool) -> Result<(), ErrorCode> {
    if !operand.starts_with('/') && !operand.starts_with("~/") {
        return Err(UNSUPPORTED);
    }
    let (_, body) = checked_body(operand, true)?;
    // The trust store reads basenames directly, but the generated OpenSSH
    // snapshot still lives under the unchanged, space-free parent scope.
    let (parent, name) = body.rsplit_once('/').unwrap_or(("", body));
    if parent.contains(' ') {
        return Err(UNSUPPORTED);
    }
    let allow_space = trust && name.contains(' ');
    visit(body, |piece| match piece {
        Piece::Literal(text)
            if text
                .bytes()
                .all(|b| b == b'/' || auth_byte(b) || (allow_space && b == b' ')) =>
        {
            Ok(())
        }
        Piece::Token(b'h' | b'n' | b'p' | b'r') => Ok(()),
        // OpenSSH would interpret '%' again when passed a resolved -i path
        // or a pin snapshot under a resolved trust directory.
        _ => Err(UNSUPPORTED),
    })
}

pub(super) fn auth_file(
    scope: &Scope,
    operand: &str,
    route: &Route<'_>,
) -> Result<PathBuf, ErrorCode> {
    scoped_user_file(scope, operand, route, false)
}

pub(super) fn user_trust_file(
    scope: &Scope,
    operand: &str,
    route: &Route<'_>,
) -> Result<PathBuf, ErrorCode> {
    scoped_user_file(scope, operand, route, true)
}

fn scoped_user_file(
    scope: &Scope,
    operand: &str,
    route: &Route<'_>,
    trust_basename: bool,
) -> Result<PathBuf, ErrorCode> {
    let expanded = substitute(operand, route)?;
    let relative = scoped_path(scope, &expanded, true)?;
    // Retain the original sibling boundary outside the synthetic home.
    if !relative.starts_with(SYNTHETIC_HOME) && relative.components().nth(1).is_some() {
        return Err(UNSUPPORTED);
    }
    scope.absolute(&relative, trust_basename)
}

pub(super) fn validate_global_trust_operand(operand: &str) -> Result<(), ErrorCode> {
    let (parent, name) = operand.rsplit_once('/').ok_or(UNSUPPORTED)?;
    if !operand.starts_with('/')
        || !parent.bytes().all(|b| b == b'/' || auth_byte(b))
        || !name.bytes().all(|b| auth_byte(b) || b == b' ')
    {
        return Err(UNSUPPORTED);
    }
    checked_body(operand, false)?;
    Ok(())
}

pub(super) fn global_trust_file(scope: &Scope, operand: &str) -> Result<PathBuf, ErrorCode> {
    scope.absolute(&scoped_path(scope, operand, false)?, true)
}

pub(super) fn include_path(
    scope: &Scope,
    operand: &str,
    route: &Route<'_>,
    user_source: bool,
) -> Result<PathBuf, ErrorCode> {
    let expanded = substitute(operand, route)?;
    scoped_path(scope, &expanded, user_source)
}

fn scoped_path(scope: &Scope, expanded: &str, allow_home: bool) -> Result<PathBuf, ErrorCode> {
    let (home, body) = checked_body(expanded, allow_home)?;
    let relative = if home {
        Path::new(SYNTHETIC_HOME).join(body)
    } else {
        scope.relative_operand(Path::new(expanded))?.to_owned()
    };
    if relative.as_os_str().is_empty()
        || relative.components().count() > MAX_COMPONENTS
        || relative
            .as_os_str()
            .as_encoded_bytes()
            .split(|&b| b == b'/')
            .any(|part| part.len() > 255)
    {
        return Err(UNSUPPORTED);
    }
    scope.check_length(&relative)?;
    Ok(relative)
}

fn checked_body(path: &str, allow_home: bool) -> Result<(bool, &str), ErrorCode> {
    let (home, body) = match path.strip_prefix("~/") {
        Some(body) if allow_home => (true, body),
        _ if path.starts_with('~') => return Err(UNSUPPORTED),
        _ => (false, path.strip_prefix('/').unwrap_or(path)),
    };
    if path.len() > MAX_PATH
        || body
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(UNSUPPORTED);
    }
    Ok((home, body))
}

pub(super) fn literal_parent(path: &Path, trust_basename: bool) -> Result<&Path, ErrorCode> {
    let bytes = path.as_os_str().as_encoded_bytes();
    let components = bytes.strip_prefix(b"/").ok_or(UNSUPPORTED)?;
    let basename = bytes.iter().rposition(|&b| b == b'/').ok_or(UNSUPPORTED)?;
    if bytes.len() > MAX_PATH
        || !bytes.iter().enumerate().all(|(i, &b)| {
            b == b'/' || auth_byte(b) || (trust_basename && i > basename && b == b' ')
        })
        || components
            .split(|&b| b == b'/')
            .any(|part| part.is_empty() || matches!(part, b"." | b".."))
        || path.file_name().is_none()
    {
        return Err(UNSUPPORTED);
    }
    path.parent().ok_or(UNSUPPORTED)
}

pub(super) fn auth_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')
}

enum Piece<'a> {
    Literal(&'a str),
    Token(u8),
}

fn visit(
    mut text: &str,
    mut piece: impl FnMut(Piece<'_>) -> Result<(), ErrorCode>,
) -> Result<(), ErrorCode> {
    while let Some((literal, rest)) = text.split_once('%') {
        piece(Piece::Literal(literal))?;
        let token = rest.bytes().next().ok_or(UNSUPPORTED)?;
        text = rest.get(1..).ok_or(UNSUPPORTED)?;
        piece(Piece::Token(token))?;
    }
    piece(Piece::Literal(text))
}

fn substitute(operand: &str, route: &Route<'_>) -> Result<String, ErrorCode> {
    let port = route.port.to_string();
    expand(operand, MAX_PATH, |token| match token {
        b'h' => Some(route.host),
        b'n' => Some(route.alias),
        b'p' => Some(port.as_str()),
        b'r' => route.user,
        b'%' => Some("%"),
        _ => None,
    })
}

fn expand<'a>(
    operand: &str,
    limit: usize,
    mut token_value: impl FnMut(u8) -> Option<&'a str>,
) -> Result<String, ErrorCode> {
    let mut expanded = String::with_capacity(operand.len().min(limit));
    visit(operand, |piece| {
        let text = match piece {
            Piece::Literal(literal) => literal,
            Piece::Token(token) => token_value(token).ok_or(UNSUPPORTED)?,
        };
        if expanded.len() + text.len() > limit {
            return Err(UNSUPPORTED);
        }
        expanded.push_str(text);
        Ok(())
    })?;
    Ok(expanded)
}
