# Native canonical runtime custody

Date: 2 October 2026. Status: Implementing; new independentreview required.

Superseding resume verdict: both 0020 targeted security and eligibility/receipt
code reviews are APPROVED STATIC, no defects, no rerun of prior 141 tests/29
oracles and no activation approval. All freezes lifted. The older background/
freeze note below is historical. New custody implementation now uses actual
`--serve-db` workers, std profile lease/role guards, a private guarded SQLite
factory, real authenticated WS principals and a private settings mutation port,
plus retained off-reactor retirement. No mutation RPC/table/dependency added.
Real-process regression uncovered and fixed POSIX lock loss from closing the
reservation descriptor after SQLite opened it (and sidecar descriptors).

New ordered fmt/clippy/149 tests/release/29 oracles pass; these are new execution
results, not prior parent STATIC reruns. New security/requirements review calls
are depth-blocked; no activation until material independent closure. Linux only,
trusted-parent/hostile-inode limitations and indefinite FS retirement documented.
Migration records: `docs/rust-port/0022-canonical-runtime-custody.md`,
`docs/plans/2026-10-02-canonical-runtime-custody-validation.md`,
`docs/reports/2026-10-02-canonical-runtime-custody-handoff.md`.

Restart qualification: completed 149-test/29-oracle evidence is server-custody
scope before parallel native desktop expansion. Resumed full-workspace fmt
passed; clippy hit rustc SIGKILL compiling desktop dependency `ash`, with other
desktop builds concurrent. Expanded-workspace tests/release not reached. Current
full-workspace green is unverified; no desktop work/process was overwritten or
cancelled. New independent custody review remains depth-blocked.

Latest independent 0022 code review confirmed three P2s before settings RPC
activation. Native corrections now bound actual pretty+newline persisted bytes
before staging, compact queued patch allocations, and return DB/settings owner
handles after retirement runtime setup failure for supervised retry. Each has
fail-before/pass-after regression evidence; new scoped fmt/clippy/152 tests/
release and 10 affected source/process oracles pass. No lock/principal/dependency/
desktop changes. Current full-workspace fmt fails on concurrent desktop sidebar
indentation, not fixed here; targeted re-review depth-blocked and separate custody
security verdict pending. Mutation activation still refused. Migration evidence:
`docs/plans/2026-10-02-canonical-runtime-custody-p2-validation.md`.

Superseding final 0022 verdict: both reviews APPROVED STATIC, fresh read-only
custody/trusted-parent security no vulnerabilities and all three P2s closed with
no new defects. No reviewer reran 152 tests/10 oracles. New settings RPC candidate
has separate activation review: `2026-10-02-native-settings-update-rpc.md`.

0020 targetedsecurity STATIC approvesprivateoneclock/issuanceIMMEDIATE/offreactorjoin
fixes, notactivation/no executionrerun. EligibilitySQL/receiptbounds code-reviewer
BACKGROUND: freeze22review-ownedfiles. Newrecord only, do noteditreview-owned0020docs.

Production --serve-db willownsafe stdexclusiveFilelock onmanagedprofile marker,
validatedmigrationidentity/canonicalroot/state andsingle DB/settingsrolepermits.
Opaquelease boundtoProfilePaths, privateguardedcanonicalconnection factory keepsrole/
file lease without rawConnection export or edits tofrozenworker. Nativecoordinator
ownsactualworkers/liveview andretirement supervision. Existingprofile adoptionstays
refused; persistentlockfile is native-only metadata, notsource canonicalSQL table.
Safe stdAPI only/no newdeps. Advisorycooperation andtrustedparent preconditions;
SQLiteexclusive protectsDB fromother writers; no hostileFileIO/ACL/Windowscertificate.

RealWSauthentication mintsprofile/session principal, revokedonconnectionend; bound
liveview can'tadopt otherprofile. Private decodedgenericsettingspatch path canqueue
onlywithlivecorrectprincipal, persist/publish usingexistingsettingsowner. No new
mutator RPC activation, genericretentionpatchinclNever remainsrefused. Trueaggregate-
lesspolicyjournal/resultidentity/restart semantics stillopen; never fabricate
thread/projectreceipts/tables or convertmatchingauthority intopolicycompletion.

Aftertimeout coordinator retainslease/owners inoffreactorretirement andcontinues
supervision/escalation ratherthanreturn/drop/release prematurely. No hardcancel or
absoluteOSshutdownpromise. Tests/sourceoracles/syntheticonly; originaldecision-dir
writes only, preserveall dirty/live data, no publication, authoredsource<=400.
