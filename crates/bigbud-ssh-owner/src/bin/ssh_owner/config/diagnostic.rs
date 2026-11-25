//! Only parser-owned identifiers and bounded locations may escape resolution.

use super::ErrorCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SourceClass {
    UserConfig,
    UserInclude,
    SystemConfig,
    SystemInclude,
}

impl SourceClass {
    /// Stable, path-free label for diagnostics and discovery metadata.
    pub(crate) const fn identifier(self) -> &'static str {
        match self {
            Self::UserConfig => "user_config",
            Self::UserInclude => "user_include",
            Self::SystemConfig => "system_config",
            Self::SystemInclude => "system_include",
        }
    }
}

macro_rules! directive_names {
    ($($variant:ident => $keyword:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub(crate) enum Directive {
            $($variant,)+
            Unknown,
        }

        impl Directive {
            pub(super) fn parse(keyword: &str) -> Self {
                match keyword.to_ascii_lowercase().as_str() {
                    $($keyword => Self::$variant,)+
                    _ => Self::Unknown,
                }
            }

            #[allow(dead_code, reason = "diagnostics are not yet wired")]
            pub(crate) const fn identifier(self) -> &'static str {
                match self {
                    $(Self::$variant => stringify!($variant),)+
                    Self::Unknown => "unknown",
                }
            }
        }
    };
}

directive_names! {
    Host => "host",
    Match => "match",
    Include => "include",
    SendEnv => "sendenv",
    HostName => "hostname",
    Port => "port",
    User => "user",
    HostKeyAlias => "hostkeyalias",
    UserKnownHostsFile => "userknownhostsfile",
    HashKnownHosts => "hashknownhosts",
    IdentityFile => "identityfile",
    ConnectTimeout => "connecttimeout",
    ServerAliveInterval => "serveraliveinterval",
    ServerAliveCountMax => "serveralivecountmax",
    AddressFamily => "addressfamily",
    BatchMode => "batchmode",
    ClearAllForwardings => "clearallforwardings",
    IdentitiesOnly => "identitiesonly",
    PubkeyAuthentication => "pubkeyauthentication",
    StrictHostKeyChecking => "stricthostkeychecking",
    AddKeysToAgent => "addkeystoagent",
    CanonicalizeHostname => "canonicalizehostname",
    CheckHostIP => "checkhostip",
    ControlMaster => "controlmaster",
    ControlPersist => "controlpersist",
    ForwardAgent => "forwardagent",
    ForwardX11 => "forwardx11",
    ForwardX11Trusted => "forwardx11trusted",
    GSSAPIAuthentication => "gssapiauthentication",
    GSSAPIDelegateCredentials => "gssapidelegatecredentials",
    GSSAPIKeyExchange => "gssapikeyexchange",
    GSSAPITrustDNS => "gssapitrustdns",
    HostbasedAuthentication => "hostbasedauthentication",
    KbdInteractiveAuthentication => "kbdinteractiveauthentication",
    PasswordAuthentication => "passwordauthentication",
    PermitLocalCommand => "permitlocalcommand",
    ProxyUseFdpass => "proxyusefdpass",
    RequestTTY => "requesttty",
    UpdateHostKeys => "updatehostkeys",
    VerifyHostKeyDNS => "verifyhostkeydns",
    CertificateFile => "certificatefile",
    ControlPath => "controlpath",
    GlobalKnownHostsFile => "globalknownhostsfile",
    IdentityAgent => "identityagent",
    KnownHostsCommand => "knownhostscommand",
    ProxyCommand => "proxycommand",
    ProxyJump => "proxyjump",
    RemoteCommand => "remotecommand",
    HostKeyAlgorithms => "hostkeyalgorithms",
    PubkeyAcceptedAlgorithms => "pubkeyacceptedalgorithms",
    PreferredAuthentications => "preferredauthentications",
    DynamicForward => "dynamicforward",
    IgnoreUnknown => "ignoreunknown",
    LocalCommand => "localcommand",
    LocalForward => "localforward",
    PKCS11Provider => "pkcs11provider",
    RemoteForward => "remoteforward",
    SecurityKeyProvider => "securitykeyprovider",
    SetEnv => "setenv",
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ConfigDiagnostic {
    pub directive: Directive,
    pub source: SourceClass,
    /// One-based line number within this source, not the flattened config.
    pub line: usize,
}

impl ConfigDiagnostic {
    #[allow(dead_code, reason = "diagnostics are not yet wired")]
    pub(crate) const fn remedy(self) -> &'static str {
        use Directive::*;
        match self.directive {
            Unknown => {
                "Check the directive name and syntax at this line; remove it from the selected host if unsupported."
            }
            Host => "Use supported Host patterns (literal names or paths, * or ?, and optional !).",
            Match => {
                "Use supported host or user criteria. Match localuser needs a trusted initiating account; exec and final are not supported."
            }
            Include => {
                "Use a readable, owner-private Include within the selected config root and check for cycles."
            }
            HostName => "Use a numeric IPv4 or IPv6 loopback destination.",
            Port => "Use a decimal port from 1 to 65535.",
            User => {
                "Use a nonempty user name of at most 64 letters, digits, dots, underscores or hyphens, not starting with a hyphen."
            }
            IdentityAgent => {
                "Use none or a protected Unix socket within the selected user fixture; ambient agents are not supported."
            }
            IdentityFile => {
                "Use an allowed number of distinct, owner-private identity files within the user config scope."
            }
            UserKnownHostsFile => {
                "Use owner-private user trust files (approval writes only to the first), or use none with scoped global pins for read-only trust."
            }
            GlobalKnownHostsFile => {
                "Use literal paths to separate, owner-private known-hosts files within a selected fixture scope, or use none."
            }
            StrictHostKeyChecking => {
                "Set StrictHostKeyChecking to yes; verify and approve the host key separately."
            }
            ProxyJump => "Use a direct fixture route with no proxy.",
            ProxyCommand => {
                "Use ProxyCommand nc %h %p (or a qualified absolute nc with exactly %h %p), or a direct route."
            }
            GSSAPIAuthentication
            | GSSAPIDelegateCredentials
            | GSSAPIKeyExchange
            | GSSAPITrustDNS => {
                "Only GSSAPIAuthentication is admitted, and the owner forces it off. Remove other GSSAPI directives."
            }
            SendEnv => {
                "Send only LANG, LC_*, COLORTERM or NO_COLOR, or remove the SendEnv line for this host."
            }
            _ => "Correct the directive to a supported value or exclude it from the selected host.",
        }
    }

    pub(super) fn reject(self, code: ErrorCode) -> ConfigFailure {
        ConfigFailure {
            code,
            diagnostic: Some(self),
            jump_hop: None,
        }
    }
}

#[derive(Debug)]
pub(crate) struct ConfigFailure {
    pub code: ErrorCode,
    /// Absent when no specific line can be identified (e.g. opening a root).
    pub diagnostic: Option<ConfigDiagnostic>,
    pub jump_hop: Option<usize>,
}

impl From<ErrorCode> for ConfigFailure {
    fn from(code: ErrorCode) -> Self {
        Self {
            code,
            diagnostic: None,
            jump_hop: None,
        }
    }
}

impl ConfigFailure {
    pub(super) fn at_jump_hop(mut self, hop: usize) -> Self {
        self.jump_hop = Some(hop);
        self
    }

    pub(super) fn at(mut self, diagnostic: ConfigDiagnostic) -> Self {
        self.diagnostic.get_or_insert(diagnostic);
        self
    }
}

pub(super) struct Located<T> {
    pub value: T,
    pub diagnostic: ConfigDiagnostic,
}

impl<T> Located<T> {
    pub(super) fn try_map<U>(
        &self,
        map: impl FnOnce(&T) -> Result<U, ErrorCode>,
    ) -> Result<Located<U>, ConfigFailure> {
        let value = map(&self.value).map_err(|code| self.diagnostic.reject(code))?;
        Ok(Located {
            value,
            diagnostic: self.diagnostic,
        })
    }
}
