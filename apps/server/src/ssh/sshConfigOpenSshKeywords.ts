/**
 * U17: every `ssh_config(5)` keyword in OpenSSH 9.x plus Apple's `UseKeychain`, lowercase.
 * Mirrors `config/ignore_unknown.rs` in the owner. `IgnoreUnknown` ignores only keywords
 * outside this set: OpenSSH applies any keyword it knows, even when listed.
 *
 * @module sshConfigOpenSshKeywords
 */
const OPENSSH_KEYWORDS = new Set(
  (
    "addkeystoagent addressfamily batchmode bindaddress bindinterface canonicaldomains " +
    "canonicalizefallbacklocal canonicalizehostname canonicalizemaxdots " +
    "canonicalizepermittedcnames casignaturealgorithms certificatefile channeltimeout " +
    "checkhostip ciphers clearallforwardings compression connectionattempts connecttimeout " +
    "controlmaster controlpath controlpersist dynamicforward enableescapecommandline " +
    "enablesshkeysign escapechar exitonforwardfailure fingerprinthash forkafterauthentication " +
    "forwardagent forwardx11 forwardx11timeout forwardx11trusted gatewayports " +
    "globalknownhostsfile gssapiauthentication gssapidelegatecredentials gssapikeyexchange " +
    "gssapitrustdns hashknownhosts host hostbasedacceptedalgorithms hostbasedauthentication " +
    "hostbasedkeytypes hostkeyalgorithms hostkeyalias hostname identitiesonly identityagent " +
    "identityfile ignoreunknown include ipqos kbdinteractiveauthentication " +
    "kbdinteractivedevices kexalgorithms knownhostscommand localcommand localforward loglevel " +
    "logverbose macs match nohostauthenticationforlocalhost numberofpasswordprompts " +
    "obscurekeystroketiming passwordauthentication permitlocalcommand permitremoteopen " +
    "pkcs11provider port preferredauthentications proxycommand proxyjump proxyusefdpass " +
    "pubkeyacceptedalgorithms pubkeyacceptedkeytypes pubkeyauthentication rekeylimit " +
    "remotecommand remoteforward requesttty requiredrsasize revokedhostkeys " +
    "securitykeyprovider sendenv serveralivecountmax serveraliveinterval sessiontype setenv " +
    "stdinnull streamlocalbindmask streamlocalbindunlink stricthostkeychecking syslogfacility " +
    "tag tcpkeepalive tunnel tunneldevice updatehostkeys user userknownhostsfile usekeychain " +
    "verifyhostkeydns visualhostkey xauthlocation"
  ).split(" "),
);

export function isOpenSshKeyword(keyword: string): boolean {
  return OPENSSH_KEYWORDS.has(keyword.toLowerCase());
}
