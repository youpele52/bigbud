//! U17 `IgnoreUnknown`, with OpenSSH's own semantics: a listed keyword is
//! ignored only when OpenSSH does not know it. A keyword OpenSSH knows is
//! applied by OpenSSH even when listed, so the owner must evaluate (or refuse)
//! it rather than ignore it.

use super::syntax::wildcard;

/// Every `ssh_config(5)` keyword in OpenSSH 9.x, plus Apple's `UseKeychain`,
/// lowercase. Anything outside this set is unknown to OpenSSH.
const OPENSSH_KEYWORDS: &[&str] = &[
    "addkeystoagent",
    "addressfamily",
    "batchmode",
    "bindaddress",
    "bindinterface",
    "canonicaldomains",
    "canonicalizefallbacklocal",
    "canonicalizehostname",
    "canonicalizemaxdots",
    "canonicalizepermittedcnames",
    "casignaturealgorithms",
    "certificatefile",
    "channeltimeout",
    "checkhostip",
    "ciphers",
    "clearallforwardings",
    "compression",
    "connectionattempts",
    "connecttimeout",
    "controlmaster",
    "controlpath",
    "controlpersist",
    "dynamicforward",
    "enableescapecommandline",
    "enablesshkeysign",
    "escapechar",
    "exitonforwardfailure",
    "fingerprinthash",
    "forkafterauthentication",
    "forwardagent",
    "forwardx11",
    "forwardx11timeout",
    "forwardx11trusted",
    "gatewayports",
    "globalknownhostsfile",
    "gssapiauthentication",
    "gssapidelegatecredentials",
    "gssapikeyexchange",
    "gssapitrustdns",
    "hashknownhosts",
    "host",
    "hostbasedacceptedalgorithms",
    "hostbasedauthentication",
    "hostbasedkeytypes",
    "hostkeyalgorithms",
    "hostkeyalias",
    "hostname",
    "identitiesonly",
    "identityagent",
    "identityfile",
    "ignoreunknown",
    "include",
    "ipqos",
    "kbdinteractiveauthentication",
    "kbdinteractivedevices",
    "kexalgorithms",
    "knownhostscommand",
    "localcommand",
    "localforward",
    "loglevel",
    "logverbose",
    "macs",
    "match",
    "nohostauthenticationforlocalhost",
    "numberofpasswordprompts",
    "obscurekeystroketiming",
    "passwordauthentication",
    "permitlocalcommand",
    "permitremoteopen",
    "pkcs11provider",
    "port",
    "preferredauthentications",
    "proxycommand",
    "proxyjump",
    "proxyusefdpass",
    "pubkeyacceptedalgorithms",
    "pubkeyacceptedkeytypes",
    "pubkeyauthentication",
    "rekeylimit",
    "remotecommand",
    "remoteforward",
    "requesttty",
    "requiredrsasize",
    "revokedhostkeys",
    "securitykeyprovider",
    "sendenv",
    "serveralivecountmax",
    "serveraliveinterval",
    "sessiontype",
    "setenv",
    "stdinnull",
    "streamlocalbindmask",
    "streamlocalbindunlink",
    "stricthostkeychecking",
    "syslogfacility",
    "tag",
    "tcpkeepalive",
    "tunnel",
    "tunneldevice",
    "updatehostkeys",
    "user",
    "userknownhostsfile",
    "usekeychain",
    "verifyhostkeydns",
    "visualhostkey",
    "xauthlocation",
];

/// The first active `IgnoreUnknown` value, as OpenSSH keeps it.
#[derive(Default)]
pub(super) struct IgnoreUnknown(Option<Vec<String>>);

impl IgnoreUnknown {
    pub(super) fn set(&mut self, raw: &str) {
        self.0.get_or_insert_with(|| {
            raw.split([',', ' ', '\t'])
                .filter(|pattern| !pattern.is_empty())
                .map(str::to_ascii_lowercase)
                .collect()
        });
    }

    /// True only for a keyword OpenSSH would itself ignore here.
    pub(super) fn ignores(&self, line: &str) -> bool {
        let keyword = line
            .trim_start()
            .split([' ', '\t', '='])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        !keyword.is_empty()
            && !OPENSSH_KEYWORDS.contains(&keyword.as_str())
            && self.0.as_ref().is_some_and(|patterns| {
                patterns.iter().any(|pattern| {
                    wildcard(
                        pattern.as_bytes(),
                        keyword.as_bytes(),
                        |atom| *atom == b'*',
                        |atom, byte| *atom == b'?' || *atom == byte,
                    )
                })
            })
    }
}

#[cfg(test)]
#[path = "ignore_unknown_tests.rs"]
mod tests;
