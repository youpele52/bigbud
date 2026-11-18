# Provider provisioning action and lazy optional SDKs (WP-5C)

Date: 2026-11-18. Plan: [remote completion plan, M4](../plans/2026-11-17-remote-completion-plan.md).
Builds on [WP-5A/5B](2026-11-18-provider-provisioning-recipes.md).

## Status and provision flow

- `provider-provisioning/provision.ts` holds one action per recipe, run against an injected
  `ProvisioningEnvironment`. `provision.live.ts` builds that environment for each request from
  settings, the provider registry snapshots, the provider service PATH and the existing Copilot
  runtime lifecycle.
- Installation is decided from what bigbud can see on the host. A user tool is checked with
  `resolveProviderExecutable`, where an explicit configured path wins and is never replaced. Pi
  uses the graph closure (`resolveBundledPiCliPath`) unless a non-default binary path is set.
  Copilot uses `copilotRuntimeRequest({ action: "status" })`. In remote mode, a tuple without a
  bigbud artifact reports `unsupported`.
- Authentication is never re-implemented. `provision.readiness.ts` reads the snapshot produced by
  each recipe's `authReadiness` check, as published by `ProviderRegistry`. The result is one of
  `ready`, `needs-auth` (auth `unauthenticated`), `missing` (no executable found, or the check
  reports `installed: false`), `unsupported`, `disabled` or `unknown`. Each entry also carries
  `authStep`, `authCheck` (`module#export`), the exact `manualCommands` and `docsUrl`.
- The provision action works as follows:
  - Copilot that is `missing` with the default binary path starts the existing pinned install
    job (`Runtime.install.ts` through `copilotRuntimeRequest({ action: "install" })`) and returns
    `installing` with the job.
  - Copilot with an explicit path is never replaced and returns `needs-install`.
  - Pi returns `available` when the closure is present. Otherwise it returns `needs-install` with
    the fallback command. Nothing is installed.
  - Every other provider reports its state: `needs-install` with the recipe's exact commands,
    `needs-auth` with the sign-in step, or `available`. bigbud runs nothing.
  - OpenCode v2 is borrow-only. Status and provision read the registry snapshot and never
    borrow, ensure or start the shared service.
- RPCs are schema-only in `contracts/server/providerProvisioning.ts` and
  `rpc.providerProvisioning.ts`:
  - `server.getProviderProvisioningStatus` has no middleware.
  - `server.provisionProvider` uses the `ProviderProvisioningSetupAuthority` middleware.

  Both are registered in `WsRpcGroup` and handled by `ws/wsRpcHandlers.providerProvisioning.ts`.
  `MobileWsRpcGroup` has neither RPC.

- Authority (`provisionAuthority.ts`) follows the WP-4C pattern: a per-route capability header
  that is always stripped and then re-stamped. In remote mode it reuses
  `grantsRuntimeUpdateSetupAuthority`, so only the authenticated remote client socket (the
  SSH-relayed laptop) qualifies. Desktop and web keep the existing local path: the same trusted
  local presence that guards the Copilot runtime RPC.

## Lazy optional SDK imports

- `provider/optionalSdk.ts` provides `makeOptionalSdk(name, importer)`. It loads once, shares
  a pending load, retries after a failure, and turns a missing package into a typed
  `OptionalSdkUnavailableError`. Sync `loaded()` access works only after a load.
- **Copilot:** `copilotSdk.lazy.ts` exposes `loadCopilotSdk()`. Its two async entry points
  (`createLeasedCopilotClient` and `createMetadataCopilotClient`) await it before the sync
  option builders run. The load stays a literal `createRequire(import.meta.url)` call on
  purpose. An ESM `import()` resolved the SDK's ESM closure, and `--list-loader-sites` then
  reported two new unreviewed sites: a `createRequire` variable in `copilot-sdk/dist/runtimeArtifacts.js`
  and koffi's ESM `src/koffi/index.js` non-literal require. The CommonJS closure is the one the
  policy already reviewed. `Adapter.types.ts` now uses `import type`; the old import was already
  type-only and was elided.
- **Muse:** `Client.lifecycle.ts` awaits `museSdk.load()` before `spawnMspConnection`. An abort
  during the load is still settled by the handshake's own abort path.
- **OpenCode v2:** `Client.sdk.ts` imports `@opencode/client` and `/service` with literal
  dynamic imports. `makeV2Client` is synchronous and used by about 36 test files, so the module
  starts the load once with a caught top-level `await`. A missing package is recorded, and
  `makeV2Client` throws the typed error on first use. `Client.ts` and `SharedService.*` use
  `opencodeV2Sdk()`.
- **Pi:** no change. Pi has no SDK import; its CLI is resolved inside functions in `Pi/Cli.ts`,
  a reviewed region.
- The registry and composition files (`ProviderAdapterRegistry.ts`,
  `OptionalProviderComposition.ts`) need no change. Once the SDK edges are lazy, importing
  them, and the whole of `server.ts`, does not touch any SDK. The bootstrap test proves this.

### Loader policy

The fresh build was `bun run --cwd apps/server build`, plus the client relay. It was checked with
`bun run remote-backend-graph --target aarch64-unknown-linux-gnu --list-loader-sites`.

- Moving Muse and OpenCode v2 into lazy chunks renamed `read$2` to `read` inside
  `msgpackr/unpack.js`. The canonical digest cannot relate an unsuffixed name, so the hash
  changed. A build of the same workspace without the lazy changes matched the old pin, and
  `diff` of the two regions shows only that rename. The region also equals a HEAD build's text
  apart from `$<n>` renames. The pin was re-pinned in `build-remote-backend-graph.policy.data.ts`.
- `@anthropic-ai/claude-agent-sdk/sdk.mjs` was **not** re-pinned. Its digest already differs
  from the pin without these changes, and it moves with in-flight edits elsewhere in the bundle
  (`_a$1` to `_a`, a `node:process` binding spelled `ob` or `process`). Re-pin it once, on the
  final combined tree, after the same diff review.
- `src/remote-backend/runtimeUpdate.operation.ts` reports four `non-literal-require` sites. They
  are false positives: the local `Effect.fn` helper is named `require`. They became reachable
  with the uncommitted WP-4D wiring. Renaming the helper avoids them; review belongs to WP-4D.

## Service PATH

`provider-provisioning/servicePath.runtime.ts` provides `prepareProviderServicePath(mode)`.
`makeServerLayer` calls it once, just before the application layer.

- **Remote mode:** it runs the bounded `discoverServicePath()` and sets the backend PATH to the
  result, so provider spawns inherit it. It keeps the discovery for executable resolution.
  `fixPath()` never runs.
- **Desktop and web:** it calls the unchanged `fixPath()`.

Remote mode never ran `fixPath()` before this change; providers there saw only the supervisor's
cleared PATH. Mutating PATH matches what `fixPath()` does locally, and it is far less invasive
than threading PATH through about 15 spawn sites. Login-shell entries now come before the
supervisor's private node directory, so bare-`node` spawns would pick up the user's node.
bigbud's own spawns use `process.execPath` or `resolveNodeExecutable()`.

## Tests and checks

| Test file                                    | Tests                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision.test.ts`                          | `needs_auth_distinct_from_missing`; explicit path kept; unsupported tuple; `needs-install` for the seven user providers with exact commands (no install, no Copilot call); `opencodeV2_borrow_only_never_starts_service` (spies on the V2 borrow and owned-process start); Pi closure; Copilot install only when missing with the default path |
| `provisionAuthority.test.ts`                 | Copilot provisions under setup authority; a viewer is refused, even with a forged header, and the installer is not called; a foreign capability is refused; the RPC group and mobile group are checked                                                                                                                                         |
| `servicePath.runtime.test.ts`                | Service PATH is used in remote mode only                                                                                                                                                                                                                                                                                                       |
| `optionalSdk.bootstrap.test.ts`              | `unselected_absent_sdk_does_not_break_bootstrap`: `vi.mock` factories throw for every optional SDK; `server.ts`, the registry and the composition import cleanly; first use fails with a typed error                                                                                                                                           |
| `optionalSdk.test.ts`                        | Loader caching, retry and typed error                                                                                                                                                                                                                                                                                                          |
| `server.remote.providerProvisioning.test.ts` | The real remote client socket route                                                                                                                                                                                                                                                                                                            |

Checks: contracts, server and scripts typecheck; focused Vitest on the files above plus the
affected Copilot, Muse, OpenCode v2, composition, registry, authority, metadata and policy
tests; explicit-path oxfmt and oxlint. The bootstrap test also stubs `node:module`'s
`createRequire`, because Copilot's CommonJS load bypasses `vi.mock`. Remaining server typecheck
errors are in other in-flight work (`remote-backend/mobile*`, `peerRoutes.test.ts`).

Mutation check (one at a time, backups in a private directory; every mutant was killed):
needs-auth condition inverted; the Copilot explicit-path guard removed; install attempted for any
missing provider; viewer granted in remote mode; service PATH applied in every mode (it timed out
under machine load in the batch run, then failed in 9 ms when rerun alone); a static Muse SDK
import; an untyped load failure.

## Notes for WP-5D (conformance harness)

- Drive `server.getProviderProvisioningStatus` per tuple. Its `state`, `executableSource` and
  `authCheck` columns map directly to the matrix. Redact `executablePath` and `message`.
- Run Copilot `provisionProvider` only over the laptop client socket. Poll the job through the
  existing Copilot runtime status.
- To prove an unselected provider with its SDK absent, run with the SDK removed from the graph.
  Add `@github/copilot-sdk` to `absentOptionalExternals` for that build; every edge to it is
  now lazy. Expect `OptionalSdkUnavailableError` on first use.
- Consider teaching the region digest to canonicalize freed unsuffixed names. Today any
  chunking change in the bundle can invalidate the msgpackr and Claude SDK pins.

## Loader policy hardening (18 November 2026)

This fixes F-M5-1 (measurements report) and the last note above. A clean HEAD build now passes
the producer with no edits.

### Changes

- `runtimeUpdate.operation.ts`: the local `Effect.fn` helper `require` is now `getRequired`
  (span `RemoteRuntimeUpdate.getRequired`). Behaviour is unchanged. The four false-positive
  `non-literal-require` sites are gone.
- `build-remote-backend-graph.regionHash.ts`: the canonical region text now labels each
  identifier by the binding it resolves to. TypeScript's binder does the resolution on the
  parsed tree, with `noLib` and `noResolve`. Spelling is not used.
  - A binding declared only inside the region becomes `$#<k>`, numbered by first appearance,
    with or without a `$<n>` suffix. Two bindings with the same spelling (shadowing) get two
    labels, so bindings are never merged.
  - Free names keep their spelling. An undeclared global keeps its exact bytes. A binding
    declared elsewhere in the file is marked `<name>#`, so it never reads as a global. A suffixed
    one becomes `<base>$#<k>`, as before.
  - Property keys, labels, strings, comments and import or export names keep their bytes.
    Where one identifier is both a key and a binding, the key is written out: `{ a }` becomes
    `a: $#0`, `export { a }` becomes `$#0 as a`, and an object binding pattern is handled like
    `{ a }`.
  - The review guarantee holds: equal canonical text means the code is byte-equivalent up to a
    consistent renaming of local bindings.
- `build-remote-backend-graph.regionHash.test.ts` has 7 tests:
  - suffixed and unsuffixed renames (including WP-5C's `read$2` → `read`) give the same digest;
  - the raw digest is kept when nothing is renamed;
  - distinct and shadowed bindings are not merged;
  - a free name captured by a new local, a different global, a file binding versus a global,
    `posix$1` versus `posix`, and a binding that moved out of the region all change the digest;
  - keys, labels, strings and globals stay byte-exact;
  - `{ a }` equals `{ a: z }`, but swapping which binding `{ a }` holds is detected.
- Mutation check (backups in the job's private tmp directory, restored afterwards). Each mutant
  fails at least one test:
  - labelling by spelling instead of by binding;
  - also renaming free names;
  - dropping the written-out key;
  - leaving file-bound free names unmarked;
  - renaming property keys.
- `build-remote-backend-graph.policy.test.ts`: the fixture region now refers only to a global
  (`import(globalThis.target)`), so its pin is still the raw-text digest.

### Re-pins

The new canonical form changes every region digest, so all seven region pins were re-pinned. The
reference text is the reviewed M1 build: `/tmp/bigbud-m1-live-20261117T220256Z/…/server-GpjOiZW6.mjs`.

- With the old algorithm, that build's regions hash to the old pins. For `msgpackr/unpack.js` it
  hashes to the pin from before WP-5C (`4168ccbb…`).
- For each member, the new canonical text of the reference region is byte-identical to the new
  canonical text of the clean HEAD build (`server-kQedXKey.mjs`).
- File pins (Pi chunks, jiti, koffi, photon) are raw file hashes and did not change.

| Member                                   | Old pin     | New pin     | Raw difference from reviewed text                           |
| ---------------------------------------- | ----------- | ----------- | ----------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk/sdk.mjs` | `1e2e54a3…` | `c822c89d…` | `_a$1`→`_a` (8), `fs$6`→`fs$5` (5), `posix$1`→`posix$2` (4) |
| `msgpackr/unpack.js`                     | `90b22fe6…` | `6e04f456…` | `read$2`→`read` (22), `decode$5`→`decode$6` (1)             |
| `node-gyp-build-optional-packages/…`     | `b0909341…` | `51baa13c…` | `path$6`→`path$5` (12), `fs$7`→`fs$6` (2)                   |
| `msgpackr/struct.js`                     | `b45551c3…` | `7a42dcad…` | none                                                        |
| `Copilot/Runtime.executable.ts`          | `f89959ce…` | `ec03d459…` | none                                                        |
| `Copilot/Adapter.types.cli.ts`           | `b7ffc526…` | `7be52708…` | none                                                        |
| `Pi/Cli.ts`                              | `b1c8780b…` | `3de5ba64…` | none                                                        |

Counts are identifier tokens. With the old algorithm, only the Claude SDK pin had drifted on clean
HEAD (`1c86b915…`). It drifted because `_a$1` became the unsuffixed `_a`.

### Clean-HEAD build

- **Snapshot:** `git archive HEAD` (`4a1971a1e0`), tar sha256
  `ae953233c57893e2a46c5d3f779acf90a9ff2c0b4eaeb76568ccdd164ebb2b25`. Extracted to
  `/tmp/bigbud-loaderpol-20261118T003506Z/src`. The root and workspace `node_modules` were
  APFS-cloned.
- **Contents:** the snapshot is HEAD plus only the six files above. The sixth is a comment
  edit in `build-remote-backend-graph.reachability.ts`. `diff -rq` against a fresh extraction
  shows only these files. The x86_64 listing was re-run after the comment edit, with the same
  result.
- **Build:** both tsdown configs. No other edits to the snapshot.
- **aarch64:** `bun run remote-backend-graph --target aarch64-unknown-linux-gnu` passed. It was
  signed with a throwaway fixture key, and reported 27 reviewed sites.
  - Archive sha256: `c763d4069f04990b3da7e1748868e1ca142ebd50b37ca2c680cb110865bf09b6`.
  - `buildDigest`: `616fa340…0045`.
- **x86_64:** `--list-loader-sites` reported "0 unreviewed sites, 0 refusals; 828 reachable
  modules".
- **Not in this build:** staged work from another lane adds `remote-peer-relay` to the graph
  (`stage.ts`, `producer.ts`, `tsdown.clientRelay.config.ts`). Once it lands, check that bundle's
  loader sites again. The uncommitted `scripts/lib/workspace-agent-target.ts` change does not
  touch the backend graph.

## Deterministic loader-region digests (18 November 2026)

This fixes "Loader-region pin still unstable after `6716f8b8fe`" in
`2026-11-18-linux-arm64-deletion-fix.md`.

### Root cause

- tsdown 0.20.3 uses rolldown `1.0.0-rc.3`, and that rolldown does not name symbols
  deterministically. Fourteen rebuilds of one unchanged `git archive HEAD` snapshot gave seven
  different outputs. The chunk set was the same every time; only the names differed.
- The Claude SDK has `import ob from "node:process"`. Other modules import the same default as
  `process`. Rolldown merges these into one binding and names it after whichever importer it meets
  first, which depends on load timing: `process$1` in some builds and `ob` in others. The `$<n>`
  suffixes move the same way (`posix$1` ↔ `posix$2`).
- With the old canonical form, three of the seven outputs gave the Claude SDK region `5dd1aace…`
  and four gave the pinned `c822c89d…`. The overlay in the deletion fix was not the cause.
- No rc.3 option fixes this. The input and output options have no ordering or concurrency
  control, and `experimental.strictExecutionOrder` changes runtime semantics. The build config is
  unchanged.
- rolldown `1.1.5` (already installed for vite 8) was deterministic: 8 of 8 rebuilds gave
  identical whole-`dist` hashes. This was a throwaway symlink test in the snapshot only. Moving
  tsdown to a rolldown 1.x release is a separate dependency decision; it would also make
  `buildDigest` and the archive hash reproducible, which they are not today.

### Change

- `build-remote-backend-graph.regionHash.ts`: a file binding referenced from a region (declared
  anywhere outside the region) is now `$f#<k>`, numbered by first appearance in the region. Its
  spelling is ignored. Region-local bindings are still `$#<k>`. Undeclared globals, property
  keys, strings, labels and comments keep their bytes.
- The review guarantee is unchanged apart from file-binding spelling:
  - a reference that switches between a file binding and a global changes the digest;
  - two references to one file binding share a label, and two file bindings never do;
  - a file binding and a region-local binding never share a label.
  - Not detected: a consistent swap of which file bindings the region uses (`use(a, b)` versus
    `use(b, a)`). What a file binding holds was never pinned.
- `build-remote-backend-graph.regionHash.test.ts` has 8 tests. New cases cover the
  `process$1` ↔ `ob` rename, same versus different file bindings, file binding versus global
  (same or other spelling), and file binding versus local (including a `var` declared both inside
  and outside the region).
- Mutation check (backup in the job's private tmp directory, restored and compared with `cmp`).
  Each mutant fails at least one test:
  - labelling by spelling;
  - one shared file label;
  - treating file bindings as globals;
  - labelling file bindings as locals;
  - labelling locals as file bindings;
  - dropping the written-out shorthand key.

### Re-pins

Six region pins changed. `msgpackr/unpack.js` refers to no file binding, so its pin
(`6e04f456…`) did not change. File pins did not change.

- **Reference builds:** the reviewed M1 build (`server-GpjOiZW6.mjs`) and the earlier clean-HEAD
  build (`server-kQedXKey.mjs`). With the old algorithm, both hash to the old pins.
- **Check:** the old algorithm was run with each file-binding label marked, and the marks were
  checked to leave the text unchanged. Each marked label was then relabelled `$f#<k>` by first
  appearance. For every member, in both builds, the result is byte-identical to the new canonical
  text. So the new canonical text is the reviewed canonical text with only file-binding labels
  renamed.

| Member                                   | Old pin     | New pin     | File bindings |
| ---------------------------------------- | ----------- | ----------- | ------------- |
| `@anthropic-ai/claude-agent-sdk/sdk.mjs` | `c822c89d…` | `f99dc39c…` | 71            |
| `msgpackr/struct.js`                     | `7a42dcad…` | `c320bf3a…` | 5             |
| `node-gyp-build-optional-packages/…`     | `51baa13c…` | `c5cbd62e…` | 3             |
| `Copilot/Runtime.executable.ts`          | `ec03d459…` | `bbc91896…` | 7             |
| `Copilot/Adapter.types.cli.ts`           | `7be52708…` | `14857f59…` | 7             |
| `Pi/Cli.ts`                              | `3de5ba64…` | `9c4de834…` | 6             |

All seven rc.3 output variants from the rebuild sweep, including the three that gave `5dd1aace…`,
hash to the new pins.

### Three-build proof

- **Snapshot:** `git archive HEAD` (`295df61927`), tar sha256 `f4ae17b6…a879a`, plus only the three
  changed scripts files (checked with `diff -rq` against a fresh extraction). `node_modules` was
  APFS-cloned. Both tsdown configs were built, then the producer ran.
- **Builds:**
  - `b1` and `b2`: two separate fresh extractions.
  - `c`: a fresh extraction plus an unrelated overlay. `src/detOverlayProbe.ts` imports
    `node:process` and `node:path`, and `bin.ts` imports it; it lands in `bin.mjs`.

| Build | Server chunk          | Old SDK digest | Region digests       | aarch64 producer    | x86_64 `--list-loader-sites` |
| ----- | --------------------- | -------------- | -------------------- | ------------------- | ---------------------------- |
| `b1`  | `server-BfyPj7WT.mjs` | `c822c89d…`    | all seven equal pins | passed, 27 reviewed | 0 unreviewed, 0 refusals     |
| `b2`  | `server-CYOXumN5.mjs` | `c822c89d…`    | identical to `b1`    | passed, 27 reviewed | 0 unreviewed, 0 refusals     |
| `c`   | `server-uHTgn3-X.mjs` | `c822c89d…`    | identical to `b1`    | passed, 27 reviewed | 0 unreviewed, 0 refusals     |

- **Signing:** the aarch64 runs were signed with a throwaway ed25519 fixture key. Their
  `buildDigest`s differed (`09250b68…`, `380ce0cb…`, `a2faf73d…`) because rc.3 renames symbols
  in the bundle bytes.
- **x86_64:** each listing reported 829 reachable modules.
- **`remote-peer-relay`:** `remoteBackendPeerRelay.mjs` (P8, `e312c2fa1f`) is in every graph and
  has 0 loader sites. So does `remoteBackendClientRelay.mjs`.
- **Clean-up:** the build directories were deleted afterwards. Logs and digests are kept in the
  job's private tmp directory.

### Follow-up: rolldown 1.1.5

tsdown now runs on rolldown `1.1.5`. Server builds and aarch64 graphs are byte-reproducible
(archive sha256 and `buildDigest` included). Three region pins (msgpackr `unpack.js` and
`struct.js`, and the Claude SDK) change, and they are **not** re-pinned yet. See
[tsdown on rolldown 1.1.5](2026-11-18-tsdown-rolldown-1.1.5.md).
