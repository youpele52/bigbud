//! Binding a resolved config to exact file identities, and revalidating them
//! before use: the ordered sources, identities and trust files must not change.

use super::*;

impl Scope {
    pub(in super::super) fn bind(
        self,
        system: Option<Scope>,
        config: ConfigSources,
        alias: &str,
        facts: &RouteFacts,
        identities: &[Located<PathBuf>],
        trust: &TrustPaths,
    ) -> Result<SourceToken, ConfigFailure> {
        let mut trust_files = Vec::with_capacity(trust.user.len() + trust.global.len());
        for path in &trust.user {
            trust_files.push(self.bind_trust(path, &config, false)?);
        }
        for global in &trust.global {
            let scope = if global.system_scope {
                system.as_ref().ok_or(UNSUPPORTED)?
            } else {
                &self
            };
            let token = scope.bind_trust(&global.path, &config, global.system_scope)?;
            // A persistable user file must never also be a global input.
            if trust_files
                .iter()
                .take(trust.user.len())
                .any(|user| user.id == token.id)
            {
                return Err(global.path.diagnostic.reject(UNSUPPORTED));
            }
            trust_files.push(token);
        }
        let mut bound_identities = Vec::with_capacity(identities.len());
        for identity in identities {
            let reject_identity = |code| identity.diagnostic.reject(code);
            let relative = identity
                .value
                .strip_prefix(&self.canonical)
                .map_err(|_| reject_identity(UNSUPPORTED))?;
            let version = self.identity_stamp(relative).map_err(reject_identity)?;
            if trust_files.iter().any(|trust| trust.id == version.id) || config.contains(version.id)
            {
                return Err(reject_identity(UNSUPPORTED));
            }
            bound_identities.push((relative.to_owned(), version));
        }
        Ok(SourceToken {
            alias: alias.to_owned(),
            facts: facts.clone(),
            config,
            identities: bound_identities,
            trust: trust_files,
            user: self.into_root(),
            system: system.map(Scope::into_root),
        })
    }

    fn into_root(self) -> RootToken {
        RootToken {
            path: self.path,
            canonical: self.canonical,
            directory_id: self.directory_id,
            openssh: self.openssh,
        }
    }

    fn bind_trust(
        &self,
        path: &Located<PathBuf>,
        config: &ConfigSources,
        system_scope: bool,
    ) -> Result<TrustToken, ConfigFailure> {
        let reject = |code| path.diagnostic.reject(code);
        let relative = path
            .value
            .strip_prefix(&self.canonical)
            .map_err(|_| reject(UNSUPPORTED))?;
        let id = self.trust_id(relative).map_err(reject)?;
        if config.contains(id) {
            return Err(reject(UNSUPPORTED));
        }
        Ok(TrustToken {
            relative: relative.to_owned(),
            id,
            system_scope,
        })
    }
}

impl RootToken {
    fn reopen(&self) -> Result<Scope, ErrorCode> {
        let scope = Scope::open_with(&self.path, self.openssh)?;
        if scope.canonical != self.canonical || scope.directory_id != self.directory_id {
            return Err(UNSUPPORTED);
        }
        Ok(scope)
    }
}

impl SourceToken {
    pub(in super::super) fn revalidate(&self) -> Result<(), ErrorCode> {
        let user = self.user.reopen()?;
        let system = self.system.as_ref().map(RootToken::reopen).transpose()?;
        let (_, config) = include::evaluate(&user, system.as_ref(), &self.alias, &self.facts)
            .map_err(|failure| failure.code)?;
        if config != self.config {
            return Err(UNSUPPORTED);
        }
        for (path, version) in &self.identities {
            if user.identity_stamp(path)? != *version {
                return Err(UNSUPPORTED);
            }
        }
        // Transport compares trust contents at use. Revalidation here binds
        // the complete ordered source list and rejects replaced/unsafe paths.
        for token in &self.trust {
            let scope = if token.system_scope {
                system.as_ref().ok_or(UNSUPPORTED)?
            } else {
                &user
            };
            if scope.trust_id(&token.relative)? != token.id {
                return Err(UNSUPPORTED);
            }
        }
        Ok(())
    }
}
