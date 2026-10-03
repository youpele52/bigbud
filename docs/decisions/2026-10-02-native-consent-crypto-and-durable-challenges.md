# Native Consent Crypto And Durable Challenges

Date: 2 October 2026
Status: Exact dependencies approved by user; private consent prerequisites pending security review

User explicitly approved the reviewed exact declarations: getrandom=0.3.4 defaults
off; sha2=0.10.9 defaults off force-soft; base64=0.22.1 defaults off alloc. This
supersedes the NOTapproved dependency state in the historical 2026-10-01 dossier,
not its source/platform/security limitations. No other crypto/native dependency or
mutable transport API approved. Capture exact feature closure and license/provenance.

Parent independent0016 event review running BACKGROUND. Freeze event code/tests/
fixtures/docs and shared event-worker composition until verdict relayed. Independent
private consent module compiled but unexposed: no challenge grant/preview issuance
or policy RPC, scheduler/cleanup execution, or sharedworker binding before security
review. Narrow non-test dead-code expectation documents deliberately dormant
prerequisites, not a runtime authority. Existing source-backed retention admission/
rollback helpers and authority repository SQL reused through internal type methods.

Implement OS CSPRNG32bytes -> URL_SAFE_NO_PAD43ASCII -> SHA256UTF8encodedtoken
lowerhex64. Tokens opaque/redacted Debug, never persisted in DB/settings/logs.
Entropy failure fails before DB writes, no fallback/homegrown entropy/hash. Test
fixedbytes seams compiled only for tests; actual OS generator separately exercised.

Challenge issue transaction prunes consumed/strictlyexpired theninsert thenkeeps
newest32 byissuedAt/id descending. Source defaults per-thread/activity; expiry is
lexicographic String with inclusiveconsume boundary, mismatchbeforeused/expired.
Durable read/generalconsume/policyconsume/manualconsume, finitepolicies only.
No new consent-and-create-run implementation until durable run prerequisites exist.
Private interface trusts owner-supplied scope/clock only, not clientpreview grants.
Typed/bounded input/secret lengths, no caller-supplied digest authorizes consent.

Concrete private adapter reuses retention::set_policy andOwnedSettings plus existing
PolicyAuthority singleton SQL: finite consumed BEFOREsettings thenauthority write,
authorityfailure rollssettingsback, consumedtoken staysused; rollbackfailureprecedence.
Never bypasses token andadmindisable preserving previousauthorityselectors; disabled
finite refuses withoutconsumption. No persistence success advertised as client/API
authority; production server stillNever/freshonly until owner/security/runtime gates.

Source live repository fixtures must prove exact hash/issuance/scope/default/prune/
expiry/reuse/32cap behavior, realSQLitefaultrollback/concurrentconsume/restart and
source settings+authority traces versus concrete syntheticRustintegration. Mandatory
orderedchecks/oracles <=400, originalonlydecision-dir/no publication/live data.
