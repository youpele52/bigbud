use super::diagnostic::Directive;
use super::{ErrorCode, UNSUPPORTED};

const MAX_LINE: usize = 4096;
const MAX_PATTERNS: usize = 64;

#[derive(Clone, Copy)]
pub(super) struct Tokens<'a>(&'a str);

impl<'a> Tokens<'a> {
    /// Re-read a previously captured raw argument string (for deferred,
    /// bounded re-tokenization by discovery code).
    pub(super) const fn new(raw: &'a str) -> Self {
        Self(raw)
    }

    pub(super) fn directive(line: &'a str) -> Result<Option<(Directive, Self)>, ErrorCode> {
        if line.len() > MAX_LINE || line.bytes().any(|b| b.is_ascii_control() && b != b'\t') {
            return Err(UNSUPPORTED);
        }
        let line = trim_space(line);
        if line.is_empty() || line.starts_with('#') {
            return Ok(None);
        }
        let keyword_end = line.find([' ', '\t', '=']).unwrap_or(line.len());
        let (keyword, args) = line.split_at(keyword_end);
        if keyword.is_empty() || !keyword.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(UNSUPPORTED);
        }
        let args = trim_space(args);
        Ok(Some((
            Directive::parse(keyword),
            Self(args.strip_prefix('=').unwrap_or(args)),
        )))
    }

    pub(super) fn next(&mut self) -> Result<Option<&'a str>, ErrorCode> {
        let rest = trim_space(self.0);
        if rest.is_empty() || rest.starts_with('#') {
            return Ok(None);
        }
        let mut chars = rest.chars();
        let (token, tail) = if let Some(quote @ ('"' | '\'')) = chars.next() {
            // Only whole quoted operands are admitted; concatenation and
            // escapes are outside the literal fixture grammar.
            let (token, tail) = chars.as_str().split_once(quote).ok_or(UNSUPPORTED)?;
            if !tail.is_empty() && !tail.starts_with([' ', '\t']) {
                return Err(UNSUPPORTED);
            }
            (token, tail)
        } else {
            rest.split_at(rest.find([' ', '\t']).unwrap_or(rest.len()))
        };
        if token.is_empty() || token.contains(['"', '\'', '\\']) {
            return Err(UNSUPPORTED);
        }
        self.0 = tail;
        Ok(Some(token))
    }

    /// The rest of the line, unparsed, for a directive whose value OpenSSH
    /// treats as one command string. Its caller admits only an exact grammar.
    pub(super) fn raw(&self) -> &'a str {
        trim_space(self.0).trim_end_matches([' ', '\t'])
    }

    pub(super) fn one(&mut self) -> Result<&'a str, ErrorCode> {
        let value = self.next()?.ok_or(UNSUPPORTED)?;
        if self.next()?.is_some() {
            return Err(UNSUPPORTED);
        }
        Ok(value)
    }
}

fn trim_space(value: &str) -> &str {
    value.trim_start_matches([' ', '\t'])
}

// The same restricted alphabet is safe for the structured user and OpenSSH
// HostKeyAlias option and cannot be confused with patterned known-hosts names.
pub(crate) fn safe_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(token_byte)
        && !value.starts_with('-')
}

fn token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')
}

pub(super) fn safe_host(value: &str) -> bool {
    safe_token(value, 255) || value.parse::<std::net::Ipv6Addr>().is_ok()
}

pub(super) fn host_matches(args: &mut Tokens<'_>, alias: &str) -> Result<bool, ErrorCode> {
    let mut patterns = PatternList::default();
    while let Some(pattern) = args.next()? {
        patterns.add(pattern, alias, PatternSubject::Host { fold_case: false })?;
    }
    patterns.matched()
}

pub(super) fn match_stanza(
    args: &mut Tokens<'_>,
    host: &str,
    alias: &str,
    user: Option<&str>,
    local_user: Option<&str>,
) -> Result<bool, ErrorCode> {
    let mut condition = args.next()?.ok_or(UNSUPPORTED)?;
    if condition.eq_ignore_ascii_case("all") {
        return if args.next()?.is_none() {
            Ok(true)
        } else {
            Err(UNSUPPORTED)
        };
    }
    let mut active = true;
    loop {
        let (negated, criterion) = negation(condition);
        let argument = args.next()?.ok_or(UNSUPPORTED)?;
        let predicate = match criterion.to_ascii_lowercase().as_str() {
            "host" => Some((Some(host), PatternSubject::Host { fold_case: true })),
            "originalhost" => Some((Some(alias), PatternSubject::Host { fold_case: true })),
            "user" => Some((user, PatternSubject::User)),
            "localuser" => Some((local_user, PatternSubject::User)),
            // OpenSSH evaluates conditions in order. An earlier false predicate
            // prevents exec; a later false predicate does not make it safe.
            "exec" if active => return Err(UNSUPPORTED),
            "exec" => None,
            _ => return Err(UNSUPPORTED),
        };
        if let Some((value, subject)) = predicate {
            // Missing identity data is not a non-match. Only an already
            // nonmatching predicate proves this stanza cannot apply.
            let value = match value {
                Some(value) => value,
                None if !active => "",
                None => return Err(UNSUPPORTED),
            };
            let mut patterns = PatternList::default();
            for pattern in argument.split(',') {
                patterns.add(pattern, value, subject)?;
            }
            active &= patterns.matched()? != negated;
        }
        match args.next()? {
            Some(next) => condition = next,
            None => return Ok(active),
        }
    }
}

fn negation(value: &str) -> (bool, &str) {
    match value.strip_prefix('!') {
        Some(rest) => (true, rest),
        None => (false, value),
    }
}

#[derive(Default)]
struct PatternList {
    count: usize,
    positive: bool,
    veto: bool,
}

#[derive(Clone, Copy)]
enum PatternSubject {
    Host { fold_case: bool },
    User,
}

impl PatternList {
    fn add(
        &mut self,
        expression: &str,
        value: &str,
        subject: PatternSubject,
    ) -> Result<(), ErrorCode> {
        let host = matches!(subject, PatternSubject::Host { .. });
        let fold_case = matches!(subject, PatternSubject::Host { fold_case: true });
        self.count += 1;
        let (negated, pattern) = negation(expression);
        if self.count > MAX_PATTERNS
            || pattern.is_empty()
            || pattern.len() > 255
            || !pattern.bytes().all(|b| {
                token_byte(b) || matches!(b, b'*' | b'?') || (host && matches!(b, b':' | b'/'))
            })
        {
            return Err(UNSUPPORTED);
        }
        if wildcard(
            pattern.as_bytes(),
            value.as_bytes(),
            |&p| p == b'*',
            |&p, byte| p == b'?' || p == byte || (fold_case && p.eq_ignore_ascii_case(&byte)),
        ) {
            self.veto |= negated;
            self.positive |= !negated;
        }
        Ok(())
    }

    fn matched(&self) -> Result<bool, ErrorCode> {
        if self.count == 0 {
            return Err(UNSUPPORTED);
        }
        Ok(self.positive && !self.veto)
    }
}

// Backtrack to the last star without recursion or allocation. Each non-star
// atom (including an Include bracket class) consumes exactly one byte.
pub(super) fn wildcard<T>(
    mut pattern: &[T],
    mut value: &[u8],
    is_star: impl Fn(&T) -> bool,
    matches_byte: impl Fn(&T, u8) -> bool,
) -> bool {
    let mut retry = None;
    while let Some((&byte, rest)) = value.split_first() {
        match pattern.split_first() {
            Some((atom, suffix)) if is_star(atom) => {
                retry = Some((suffix, value));
                pattern = suffix;
            }
            Some((atom, suffix)) if matches_byte(atom, byte) => {
                pattern = suffix;
                value = rest;
            }
            _ => match retry {
                Some((suffix, [_, remaining @ ..])) => {
                    retry = Some((suffix, remaining));
                    pattern = suffix;
                    value = remaining;
                }
                _ => return false,
            },
        }
    }
    pattern.iter().all(is_star)
}
