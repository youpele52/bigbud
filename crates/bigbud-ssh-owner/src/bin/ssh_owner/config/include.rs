use super::diagnostic::{ConfigDiagnostic, ConfigFailure, Directive, SourceClass};
use super::fixture_fs::{Directory, DirectoryChild};
use super::paths::{auth_byte, include_path};
use super::source::{FileId, FileVersion, Scope};
use super::syntax::{Tokens, host_matches, match_stanza, wildcard};
use super::{ErrorCode, RouteFacts, Settings, UNSUPPORTED};
use std::ffi::{CStr, CString, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

// Root is level zero and counts as a file. Repeated (non-cyclic) evaluations
// also consume the file budget. Bound directory work even for empty matches.
const MAX_DEPTH: usize = 16;
const MAX_FILES: usize = 64;
pub(super) const MAX_INCLUDE_DEPTH: usize = MAX_DEPTH;
pub(super) const MAX_INCLUDE_FILES: usize = MAX_FILES;
const MAX_GLOB_WORK: usize = 65_536;

#[derive(Default, PartialEq, Eq)]
pub(super) struct ConfigSources {
    files: Vec<(PathBuf, FileVersion)>,
    // The ordered visits above identify the matched paths and file versions;
    // these counts delimit each operand's match set, including empty sets.
    matched_counts: Vec<usize>,
    route_fingerprint: [u8; 32],
}

impl ConfigSources {
    pub(super) fn contains(&self, id: FileId) -> bool {
        self.files.iter().any(|(_, version)| version.id() == id)
    }
}

pub(super) fn evaluate(
    user: &Scope,
    system: Option<&Scope>,
    alias: &str,
    facts: &RouteFacts,
) -> Result<(Settings, ConfigSources), ConfigFailure> {
    let mut evaluation = Evaluation {
        alias,
        facts,
        settings: Settings::default(),
        sources: ConfigSources {
            route_fingerprint: facts.fingerprint(),
            ..ConfigSources::default()
        },
        stack: Vec::new(),
        work: MAX_GLOB_WORK,
    };
    evaluation.read(user, &user.config_name()?, true)?;
    if let Some(system) = system {
        evaluation.read(system, &system.config_name()?, false)?;
    }
    #[cfg(any(test, target_os = "linux"))]
    super::jump::check_proxy_conflict(&evaluation.settings)?;
    Ok((evaluation.settings, evaluation.sources))
}

struct Evaluation<'a> {
    alias: &'a str,
    facts: &'a RouteFacts,
    settings: Settings,
    sources: ConfigSources,
    stack: Vec<FileId>,
    work: usize,
}

impl Evaluation<'_> {
    fn read(&mut self, scope: &Scope, path: &Path, user_source: bool) -> Result<(), ConfigFailure> {
        if self.stack.len() > MAX_DEPTH || self.sources.files.len() >= MAX_FILES {
            return Err(UNSUPPORTED.into());
        }
        let included = !self.stack.is_empty();
        let private = !user_source || included;
        let source = match (user_source, included) {
            (true, false) => SourceClass::UserConfig,
            (true, true) => SourceClass::UserInclude,
            (false, false) => SourceClass::SystemConfig,
            (false, true) => SourceClass::SystemInclude,
        };
        let (version, bytes) = scope.read_config(path, private)?;
        let id = version.id();
        if self.stack.contains(&id)
            || self
                .sources
                .files
                .iter()
                .any(|(_, prior)| prior.id() == id && prior != &version)
        {
            return Err(UNSUPPORTED.into());
        }
        self.stack.push(id);
        self.sources.files.push((path.to_owned(), version));
        self.parse(
            scope,
            std::str::from_utf8(&bytes).map_err(|_| UNSUPPORTED)?,
            source,
        )?;
        self.stack.pop();
        Ok(())
    }

    fn parse(
        &mut self,
        scope: &Scope,
        text: &str,
        source: SourceClass,
    ) -> Result<(), ConfigFailure> {
        // Only active Includes are entered. Each top-level source starts
        // active, and an included file's Host/Match never leaks to its caller.
        let mut active = true;
        for (index, line) in text.lines().enumerate() {
            // File size limits the line number; no untrusted field is copied.
            let mut diagnostic = ConfigDiagnostic {
                directive: Directive::Unknown,
                source,
                line: index + 1,
            };
            let Some((directive, mut args)) =
                Tokens::directive(line).map_err(|code| diagnostic.reject(code))?
            else {
                continue;
            };
            diagnostic.directive = directive;
            let reject = |code| diagnostic.reject(code);
            match directive {
                Directive::Host => active = host_matches(&mut args, self.alias).map_err(reject)?,
                Directive::Match => {
                    let route = self.settings.route(self.alias, self.facts);
                    active = match_stanza(
                        &mut args,
                        route.host,
                        self.alias,
                        route.user,
                        self.facts.local_user(),
                    )
                    .map_err(reject)?;
                }
                Directive::Include if active => {
                    let user_source =
                        matches!(source, SourceClass::UserConfig | SourceClass::UserInclude);
                    self.read_include(scope, args, user_source)
                        .map_err(|failure| failure.at(diagnostic))?;
                }
                // U17: a keyword OpenSSH would itself ignore under IgnoreUnknown.
                Directive::Unknown if active && self.settings.ignore_unknown.ignores(line) => {}
                _ if active => self
                    .settings
                    .apply_directive(diagnostic, &mut args, self.alias, self.facts)?,
                _ => {}
            }
        }
        Ok(())
    }

    fn read_include(
        &mut self,
        scope: &Scope,
        mut args: Tokens<'_>,
        user_source: bool,
    ) -> Result<(), ConfigFailure> {
        let mut operand = args.next()?.ok_or(UNSUPPORTED)?;
        loop {
            spend(&mut self.work)?;
            // Include expands at the point it is read, not after the complete
            // user/system policy has been evaluated.
            let route = self.settings.route(self.alias, self.facts);
            let relative = include_path(scope, operand, &route, user_source)?;
            let matches = expand(
                scope,
                &relative,
                MAX_FILES - self.sources.files.len(),
                &mut self.work,
            )?;
            self.sources.matched_counts.push(matches.len());
            for path in matches {
                self.read(scope, &path, user_source)?;
            }
            match args.next()? {
                Some(next) => operand = next,
                None => return Ok(()),
            }
        }
    }
}

pub(super) fn expand(
    scope: &Scope,
    relative: &Path,
    limit: usize,
    work: &mut usize,
) -> Result<Vec<PathBuf>, ErrorCode> {
    let parts = relative
        .as_os_str()
        .as_encoded_bytes()
        .split(|&byte| byte == b'/')
        .map(Pattern::new)
        .collect::<Result<Vec<_>, _>>()?;
    let mut expansion = Expansion {
        scope,
        limit,
        work,
        has_glob: parts.iter().any(|part| matches!(part, Pattern::Glob(_))),
        matches: Vec::new(),
    };
    expansion.walk(scope.directory(), &parts, &mut PathBuf::new())?;
    // Sort complete paths, not just entries at each level: '-' sorts before '/'.
    expansion.matches.sort_unstable_by(|left, right| {
        left.as_os_str()
            .as_encoded_bytes()
            .cmp(right.as_os_str().as_encoded_bytes())
    });
    Ok(expansion.matches)
}

struct Expansion<'a> {
    scope: &'a Scope,
    limit: usize,
    work: &'a mut usize,
    has_glob: bool,
    matches: Vec<PathBuf>,
}

impl Expansion<'_> {
    fn walk(
        &mut self,
        directory: &Directory,
        parts: &[Pattern],
        prefix: &mut PathBuf,
    ) -> Result<(), ErrorCode> {
        spend(self.work)?;
        let (part, tail) = parts.split_first().ok_or(UNSUPPORTED)?;
        match part {
            Pattern::Literal(name) => self.visit(directory, name, tail, prefix, false)?,
            Pattern::Glob(atoms) => {
                let mut entries = directory.entries()?;
                while let Some(name) = entries.next()? {
                    spend(self.work)?;
                    if glob_matches(atoms, name.to_bytes()) {
                        self.visit(directory, &name, tail, prefix, true)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn visit(
        &mut self,
        directory: &Directory,
        name: &CStr,
        tail: &[Pattern],
        prefix: &mut PathBuf,
        enumerated: bool,
    ) -> Result<(), ErrorCode> {
        // Never turn an unsafe matching name into an apparently empty glob.
        if !name.to_bytes().iter().copied().all(literal_byte) {
            return Err(UNSUPPORTED);
        }
        prefix.push(OsStr::from_bytes(name.to_bytes()));
        self.scope.check_length(prefix)?;
        if tail.is_empty() {
            if enumerated || directory.contains(name)? {
                if self.matches.len() >= self.limit {
                    return Err(UNSUPPORTED);
                }
                self.matches.push(prefix.clone());
            } else if !self.has_glob {
                return Err(UNSUPPORTED);
            }
        } else {
            match directory.child(name, self.scope.uid(), self.scope.openssh())? {
                DirectoryChild::Directory(child) => self.walk(&child, tail, prefix)?,
                // A regular file cannot contain a matching suffix. Never open it.
                DirectoryChild::RegularFile if self.has_glob => {}
                DirectoryChild::Missing if !enumerated && self.has_glob => {}
                DirectoryChild::RegularFile | DirectoryChild::Missing => return Err(UNSUPPORTED),
            }
        }
        prefix.pop();
        Ok(())
    }
}

pub(super) fn literal_byte(b: u8) -> bool {
    auth_byte(b) || b == b'%'
}

fn spend(work: &mut usize) -> Result<(), ErrorCode> {
    *work = work.checked_sub(1).ok_or(UNSUPPORTED)?;
    Ok(())
}

enum Pattern {
    Literal(CString),
    Glob(Vec<Atom>),
}

enum Atom {
    Star,
    Any,
    Byte(u8),
    Class { mask: u128, negated: bool },
}

impl Pattern {
    fn new(bytes: &[u8]) -> Result<Self, ErrorCode> {
        if bytes.is_empty() || bytes.len() > 255 {
            return Err(UNSUPPORTED);
        }
        if bytes.iter().copied().all(literal_byte) {
            return Ok(Self::Literal(CString::new(bytes).map_err(|_| UNSUPPORTED)?));
        }
        let mut bytes_left = bytes;
        let mut atoms = Vec::new();
        while let Some((&byte, rest)) = bytes_left.split_first() {
            bytes_left = rest;
            let atom = match byte {
                b'*' => Atom::Star,
                b'?' => Atom::Any,
                b'[' => {
                    let end = rest.iter().position(|&b| b == b']').ok_or(UNSUPPORTED)?;
                    let (class, tail) = rest.split_at(end);
                    bytes_left = tail.strip_prefix(b"]").ok_or(UNSUPPORTED)?;
                    bracket_class(class)?
                }
                b if literal_byte(b) => Atom::Byte(b),
                _ => return Err(UNSUPPORTED),
            };
            atoms.push(atom);
        }
        Ok(Self::Glob(atoms))
    }
}

fn bracket_class(class: &[u8]) -> Result<Atom, ErrorCode> {
    let (negated, mut members) = class
        .strip_prefix(b"!")
        .map_or((false, class), |rest| (true, rest));
    if members.is_empty() || !members.iter().copied().all(literal_byte) {
        return Err(UNSUPPORTED);
    }
    let mut mask = 0_u128;
    while let Some((&first, rest)) = members.split_first() {
        match rest {
            [b'-', last, tail @ ..] if first <= *last => {
                for byte in first..=*last {
                    mask |= 1_u128 << byte;
                }
                members = tail;
            }
            [b'-', _, ..] => return Err(UNSUPPORTED),
            _ => {
                mask |= 1_u128 << first;
                members = rest;
            }
        }
    }
    Ok(Atom::Class { mask, negated })
}

fn glob_matches(atoms: &[Atom], name: &[u8]) -> bool {
    // As with glob(3), a leading dot requires a literal opening dot.
    if name.starts_with(b".") && !matches!(atoms.first(), Some(Atom::Byte(b'.'))) {
        return false;
    }
    wildcard(
        atoms,
        name,
        |atom| matches!(atom, Atom::Star),
        |atom, byte| match atom {
            Atom::Byte(expected) => byte == *expected,
            Atom::Any => true,
            Atom::Class { mask, negated } => {
                (byte.is_ascii() && mask & (1_u128 << byte) != 0) != *negated
            }
            Atom::Star => false,
        },
    )
}
