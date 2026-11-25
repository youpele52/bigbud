use super::{ErrorCode, UNSUPPORTED, syntax::Tokens};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::process::Command;

const MAX_NAMES: usize = 32;
const MAX_NAME_BYTES: usize = 64;
const MAX_VALUE_BYTES: usize = 1024;
const LOCALE_WILDCARD: &str = "LC_*";

#[derive(Default)]
pub(crate) struct SendEnv {
    patterns: BTreeSet<String>,
}

impl SendEnv {
    pub(super) fn add(&mut self, mut args: Tokens<'_>) -> Result<(), ErrorCode> {
        let mut pattern = args.next()?.ok_or(UNSUPPORTED)?;
        loop {
            let removal = pattern.strip_prefix('-');
            let name = removal.unwrap_or(pattern);
            if name != LOCALE_WILDCARD && !admitted_name(name) {
                return Err(UNSUPPORTED);
            }
            // OpenSSH removes previously configured patterns, not variables
            // from the environment expanded by a surviving LC_* pattern.
            if removal.is_some() {
                self.patterns.retain(|entry| {
                    if name == LOCALE_WILDCARD {
                        !entry.starts_with("LC_")
                    } else {
                        entry != name
                    }
                });
            } else if !self.patterns.contains(name) {
                if self.patterns.len() == MAX_NAMES {
                    return Err(UNSUPPORTED);
                }
                self.patterns.insert(name.to_owned());
            }
            match args.next()? {
                Some(next) => pattern = next,
                None => return Ok(()),
            }
        }
    }

    pub(crate) fn apply_to<I>(
        &self,
        command: &mut Command,
        source: impl FnOnce() -> I,
    ) -> Result<(), ErrorCode>
    where
        I: Iterator<Item = (OsString, OsString)>,
    {
        let mut selected = BTreeMap::new();
        if !self.patterns.is_empty() {
            let include_lc = self.patterns.contains(LOCALE_WILDCARD);
            for (name, value) in source() {
                let Some(name) = name.to_str().filter(|name| admitted_name(name)) else {
                    continue;
                };
                if !(self.patterns.contains(name) || include_lc && name.starts_with("LC_")) {
                    continue;
                }
                if value.len() > MAX_VALUE_BYTES
                    || (selected.len() == MAX_NAMES && !selected.contains_key(name))
                {
                    return Err(UNSUPPORTED);
                }
                selected.insert(name.to_owned(), value);
            }
        }
        command.env_clear().env("LC_ALL", "C");
        for (name, value) in selected {
            // Expand the admitted wildcard before invoking OpenSSH so even the
            // local diagnostic locale is not sent unless explicitly selected.
            // Values stay in the child environment and never become argv/options.
            command.arg("-o").arg(format!("SendEnv={name}"));
            command.env(name, value);
        }
        Ok(())
    }
}

/// Policy v2: exact terminal-colour hints are the only admitted non-locale names.
const TERMINAL_HINTS: [&str; 2] = ["COLORTERM", "NO_COLOR"];

fn admitted_name(name: &str) -> bool {
    locale_name(name) || TERMINAL_HINTS.contains(&name)
}

fn locale_name(name: &str) -> bool {
    name == "LANG"
        || (name.len() <= MAX_NAME_BYTES
            && name.strip_prefix("LC_").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            }))
}
