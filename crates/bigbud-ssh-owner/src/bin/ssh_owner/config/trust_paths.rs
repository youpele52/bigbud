use super::diagnostic::{ConfigDiagnostic, ConfigFailure, Directive, Located};
use super::paths::{self, Route};
use super::source::Scope;
use super::syntax::Tokens;
use super::{ErrorCode, UNSUPPORTED};
use std::path::{Path, PathBuf};

const MAX_TRUST_FILES_PER_LIST: usize = 16;

#[derive(Default)]
pub(super) struct TrustSettings {
    user: Option<Located<Vec<String>>>,
    global: Option<Located<Vec<String>>>,
}

pub(super) struct TrustPaths {
    pub(super) user: Vec<Located<PathBuf>>,
    pub(super) global: Vec<GlobalTrustPath>,
}

pub(super) struct GlobalTrustPath {
    pub(super) path: Located<PathBuf>,
    pub(super) system_scope: bool,
}

impl TrustSettings {
    pub(super) fn set(
        &mut self,
        diagnostic: ConfigDiagnostic,
        mut args: Tokens<'_>,
    ) -> Result<(), ErrorCode> {
        type Validate = fn(&str) -> Result<(), ErrorCode>;
        let (slot, validate) = match diagnostic.directive {
            Directive::UserKnownHostsFile => (
                &mut self.user,
                paths::validate_user_trust_operand as Validate,
            ),
            Directive::GlobalKnownHostsFile => (
                &mut self.global,
                paths::validate_global_trust_operand as Validate,
            ),
            _ => return Err(UNSUPPORTED),
        };
        let first = args.next()?.ok_or(UNSUPPORTED)?;
        let mut files = Vec::new();
        if first.eq_ignore_ascii_case("none") {
            if args.next()?.is_some() {
                return Err(UNSUPPORTED);
            }
        } else {
            let mut operand = Some(first);
            while let Some(value) = operand {
                if files.len() == MAX_TRUST_FILES_PER_LIST {
                    return Err(UNSUPPORTED);
                }
                validate(value)?;
                files.push(value.to_owned());
                operand = args.next()?;
            }
        }
        slot.get_or_insert(Located {
            value: files,
            diagnostic,
        });
        Ok(())
    }

    pub(super) fn resolve(
        &self,
        user_scope: &Scope,
        system_scope: Option<&Scope>,
        route: &Route<'_>,
    ) -> Result<TrustPaths, ConfigFailure> {
        // An omitted setting would mean OpenSSH's ambient defaults; the
        // fixture only admits explicitly configured user paths or `none`.
        let user_setting = self.user.as_ref().ok_or(UNSUPPORTED)?;
        let user = user_setting
            .value
            .iter()
            .map(|value| {
                Ok(Located {
                    value: paths::user_trust_file(user_scope, value, route)
                        .map_err(|code| user_setting.diagnostic.reject(code))?,
                    diagnostic: user_setting.diagnostic,
                })
            })
            .collect::<Result<Vec<_>, ConfigFailure>>()?;
        let mut global = Vec::new();
        if let Some(settings) = &self.global {
            for value in &settings.value {
                let system =
                    system_scope.filter(|scope| scope.relative_operand(Path::new(value)).is_ok());
                let scope = system.unwrap_or(user_scope);
                let value = paths::global_trust_file(scope, value)
                    .map_err(|code| settings.diagnostic.reject(code))?;
                global.push(GlobalTrustPath {
                    path: Located {
                        value,
                        diagnostic: settings.diagnostic,
                    },
                    system_scope: system.is_some(),
                });
            }
        }
        if user.is_empty() && global.is_empty() {
            return Err(user_setting.diagnostic.reject(UNSUPPORTED));
        }
        Ok(TrustPaths { user, global })
    }
}
