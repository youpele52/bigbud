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
