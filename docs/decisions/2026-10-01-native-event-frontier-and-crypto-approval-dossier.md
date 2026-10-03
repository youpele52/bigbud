# Native Event Frontier And Crypto Approval Dossier

Date: 1 October 2026
Status: Parent STATIC frontier/queued approval, no defects/P3 addressed; crypto NOT approved

## Approval provenance and safe continuation

Subsequent parent STATIC review approved frontier and queued receipts, no defects,
P3 addressed. NOT execution rerun107tests/23oracles. Crypto dossier credible but
explicitly NOT approved. Independent lifecycle append/read/replay slice proceeds in
[next decision](2026-10-01-native-lifecycle-event-store-foundation.md), no new crypto.

Parent independent STATIC0014 approved receipt foundation with no confirmed defects;
NOT execution rerun. Matching in-flight claims return Claimed to both callers, never
exclusive execution/retry authority. P3 deterministic real-worker queued sameID
matching/digest/version-conflict test added. Independently port read-only source
event frontier MAX retained-prefix/events/gaps and earliest retained event; canonical
reservations/compact/sqlite_sequence do not count. No append/event-decoder/replay/
consent/mutation API. No new schema, history/import/resume or unsafe authority.

## Exact approval boundary

Original `/root/DevWorld/bigbud/Cargo.toml` already declares `sha2 = "0.10"` and
`bigbud-remote-agent` directly uses sha2. Original Cargo.lock resolves0.10.9.
That is reuse precedent, NOT migration authorization: migration root AGENTS says
new dependencies require explicit approval; crates/AGENTS ownership amendment
expressly authorizes none; pinned original Rust guide Dependencies/features requires
inspection and engineering approval before adding to workspace. Migration Cargo
direct list has no sha2/getrandom/base64. getrandom0.3.4 and base640.22.1 are already
locked transitively; exposing them as direct security-authority dependencies still
requires explicit approval. Existing crypto transitives alone confer no authority.

## Pinned source contract and recommendation

`ThreadRetentionRepository.challenges.ts`: node:crypto randomBytes(32), base64url
without padding produces43 ASCII characters; SHA256 of UTF8(token string), lowercase
64hex characters stored, never bearer bytes. No hash of raw entropy substitute.
Issuance OS failure must not create token/challenge; no fallback PRNG/randomblob/
timestamp/subprocess/homegrown entropy. Scope/expiry/unused consent transaction
precedes finite settings write then authority write. Authority failure rolls
settings back; rollback failure takes precedence; consumed challenge stays consumed.
Repository persistence is not transport authorization or canonical command hashing.

**Exact proposed migration workspace dependencies**, inherited by bigbud-server:

```toml
getrandom = { version = "=0.3.4", default-features = false }
sha2 = { version = "=0.10.9", default-features = false, features = ["force-soft"] }
base64 = { version = "=0.22.1", default-features = false, features = ["alloc"] }
```

Use getrandom::fill on32bytes, base64 URL_SAFE_NO_PAD encoding, sha2::Sha256/Digest
on encoded token UTF8. Standard formatting for hex is encoding, not homemade hash.
No implementation added. Dependency approval alone would NOT approve consent API:
source fixtures/failure seams/durable consumption/settings-authority ordering and
security review required before exposing anything. No rand/ring/OpenSSL/asm/hex/
wasm/js/custom RNG crate/features proposed. force-soft avoids unnecessary SHA CPU
intrinsic dispatch for tiny authorization tokens at acceptable performance cost.
Future canonical command hashing has separate canonicalization/schema prerequisites.

## Exact candidate evidence (not latest-version claims)

Registry sparse index retrieved2026-10-01 via index.crates.io (API endpoint403).
Observed latest entries sha2=0.11.0/getrandom=0.4.3/base64=0.23.1. Proposed older
non-yanked revisions deliberately reuse reviewed original SHA and migration lock
to minimize dependency changes; not a claim those older lines have a support SLA.
Projects: RustCrypto/hashes, rust-random/getrandom, marshallpierce/rust-base64;
current index and project documentation show active upstream development. Approval
should weigh older-line security maintenance against a broader latest-major audit.
No exhaustive vulnerability audit or absence-of-advisories certification claimed.

| Candidate | Registry checksum | Cached upstream VCS revision | License/MSRV/build |
|---|---|---|---|
| sha2 0.10.9 | a7507d819769d01a365ab707794a4084392c824f54a7a6a7862f8c3d0892b283 | 82c36a428f8d6f05f3bfccdedb243e9d1f85359d | MIT OR Apache-2.0; manifest no MSRV; no build script |
| getrandom 0.3.4 | 899def5c37c4fd7b2664648c28120ecec138e4d395b459e5ca34f9cce2dd77fd | 38e4ad38309a85b56eef4fc759535ccfc322ba9a | MIT OR Apache-2.0; Rust1.63; compiler-query build script |
| base64 0.22.1 | 72b3254f16251a8381aa12e40e3c4d2f0199f8c6508fbecb9d91f575e0fbb8c6 | e14400697453bcc85997119b874bc03d9601d0af | MIT OR Apache-2.0; Rust1.48; no build script |

Cached Cargo.toml, Cargo.toml.orig, .cargo_vcs_info.json, README and actual source
examined. Checksums/VCS identify downloaded candidates, not an independent audit.
Exact metadata/index evidence under `/tmp/opencode/*-index.jsonl` and isolated
`/tmp/opencode/crypto-candidate-dossier`; no migration/original manifest changes.

### Transitives / unsafe / platforms

Linux tree: sha2 ->cfg-if1.0.5,cpufeatures0.2.17,digest0.10.7 ->block-buffer0.10.4,
crypto-common0.1.7 ->generic-array0.14.7,typenum1.20.1; generic-array build uses
version_check0.9.5. getrandom ->cfg-if1.0.5/libc0.2.189. base64 alloc no normal
dependencies. All these are already in migration Cargo.lock; adding sha2 is one
new registry package with this resolution. Target-specific locked getrandom edges:
r-efi5.3.0,wasip2 1.0.4+wasi-0.2.12/wit-bindgen0.57.1; no wasm_js feature proposed.
Transitive licenses MIT OR Apache-2.0 except generic-array MIT; exact metadata
records declared MSRVs, several older digest/array packages declare none.

base64 forbids unsafe. getrandom uses audited OS FFI/raw buffers (dependency unsafe
not prevented by application forbidunsafe), no application unsafe necessary. SHA
force-soft selects portable SHA256 code but cpufeatures remains an architecture
dependency; generic-array/libc/build scripts have their own unsafe/trust surfaces.
Feature unification must be inspected if later deps enable sha2 asm/other features.

Linux supported default OS backend may use getrandom syscall and documented
urandom fallback, early boot blocking/error propagation; no configurable insecure
fallback proposed. macOS uses getentropy via libc (not Apple-other CCRandom backend).
Windows Rust1.95 defaults ProcessPrng from bcryptprimitives.dll via raw-dylib on
supported Windows10+; older explicit Win7 backend is not proposed. Unsupported
targets must fail, not invent entropy. Cross-target compilation/runtime/packaging,
ACL/reparse/directory durability and hostile compiler environment are NOT certified.
Backend override cfg/env/rustflags remain trusted-build concerns to review, not
resolved by application lint. No OpenSSL/native crypto toolchain; libc/generic-array/
getrandom build scripts remain. getrandom queries rustc on Windows; trusted-parent/
compiler-tool protection is still outside current certified scope.

### Build evidence and limitations

Isolated metadata-only empty-main proposal built OFFLINE under Rust1.95.0 release
in3.27s on this Linux host. It executes no RNG/hash and links no used crypto code;
NOT production binary-size, throughput or functional/security certification. Linux
metadata succeeded. All-target offline metadata could not fetch cached-missing
r-efi5.3.0, so no cross-target build claim. No dependency added to either app.
API contracts cross-checked with current Context7 getrandom/SHA2 documentation;
exact release features/platform source inspected locally rather than assuming latest
docs match older pins.

## Actionable approval question at the next review gate

Approve the three exact direct declarations/features above for the migration
server's source-compatible token entropy/encoding/digest prerequisites, retaining
current transitive versions and force-soft, with consent/API activation separately
gated on source tests and independent security review? Or require a latest-major
candidate audit before authorization? This is a crypto-path dependency decision,
NOT a scope-wide block: event/history/read-only repository work can continue.
