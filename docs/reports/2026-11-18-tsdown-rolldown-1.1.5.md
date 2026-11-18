# tsdown on rolldown 1.1.5

**Date:** 18 November 2026
**Related:** [Deterministic loader-region digests](2026-11-18-provider-provisioning-action.md#deterministic-loader-region-digests-18-november-2026)
**Status:** Working tree only (uncommitted). The three changed loader-policy pins were
re-reviewed and re-pinned (see [Security re-review](#security-re-review)); signed graph builds
pass with the repository policy.

## Summary

- Server builds and aarch64 backend graphs are now byte-reproducible.
- tsdown 0.20.3 builds every target with rolldown `1.1.5`, and the output works the same as with
  rc.3.
- rolldown 1.x changed two code-generation defaults. Both are switched back for the server
  bundles so that `//#region` markers survive.
- Three reviewed region pins change. Two differ only in syntax. The Claude SDK region has real
  code changes. All three passed a security re-review and are **re-pinned**.

## How rolldown is pinned

`package.json` `overrides` now contains `"rolldown": "1.1.5"` and `"vite": "8.1.4"`.

- **Why an override:** Bun 1.3 applies only top-level overrides. Nested forms
  (`tsdown>rolldown`, `tsdown/rolldown`, `**/tsdown/rolldown`) left rc.3 in place when tested.
- **Why not a newer tsdown:** tsdown 0.22.5–0.22.9 depend on rolldown `~1.1.5`, but that range
  resolves to 1.1.8. Those versions also bring two minor-version jumps of option changes, which is
  more invasive than an override.
- **Why vite is pinned:** the rolldown override applies to every consumer. vitest's nested
  `vite@8.0.9` pins rolldown `1.0.0-rc.16` exactly, so under 1.1.5 vitest failed at startup:
  `rolldown/experimental` does not export `viteWasmFallbackPlugin`. vitest accepts
  `vite ^6 || ^7 || ^8`. The override moves it to `vite@8.1.4`, which the web app already uses.
  **This is the one change beyond rolldown.**
- **Lock diff:** `bun install` (Bun 1.3.14) only removed resolved versions; it added none:
  - rolldown rc.3 and rc.16, with their bindings and `@rolldown/pluginutils`;
  - `@oxc-project/types` 0.112.0 and 0.126.0;
  - wasm-only helpers that only those bindings used: `@emnapi/core@1.9.2`,
    `@emnapi/wasi-threads@1.2.1`, `@napi-rs/wasm-runtime@1.1.4`, `@tybys/wasm-util@0.10.1`;
  - `vite@8.0.9` and its unique `postcss@8.5.10` and `nanoid@3.3.11`.

  Some `@pierre/*`, `@emnapi/runtime` and `@napi-rs/wasm-runtime` entries only moved between the
  hoisted and nested positions; each consumer resolves the same version as before.

- **Stale store links:** with the isolated linker, `bun install` left the existing
  `node_modules/.bun` links for tsdown, unrun, vitest and `@vitest/mocker` pointing at the old
  packages. Deleting those store directories and running `bun install` again relinked them.
  Other checkouts may need the same step, or a clean `bun install`.

## Compatibility (tsdown 0.20.3 with rolldown 1.1.5)

- **Option API:** no errors or deprecation warnings. The desktop
  `MODULE_TYPELESS_PACKAGE_JSON` warning was there before.
- **Changed defaults:**
  - rolldown rc.3 defaulted to `minify: false` and `inlineConst: false`.
  - rolldown 1.1.5 defaults to `minify: "dce-only"` and `inlineConst: { mode: "smart" }`.
  - tsdown passes `minify: undefined`, so it picks up the new defaults.
- **Effect of the new defaults:** they inline or drop a module's first statement, and its
  `//#region` marker goes with it.
  - 97 bigbud and contracts modules lost their markers.
  - Pi's reviewed `createRequire` site (`Pi/Cli.ts`, whose first statement is
    `DEFAULT_PI_BINARY_PATH`) was attributed to the preceding `runtimeUpdate.authority.ts`
    region instead.
  - That breaks the loader policy's attribution, so `tsdown.config.ts` and
    `tsdown.clientRelay.config.ts` now set `minify: false` and
    `inputOptions.optimization.inlineConst: false`.
  - Desktop and contracts keep the 1.1.5 defaults.

The table compares the rc.3 baseline with the final configuration:

| Target                  | Files            | Size                                   | Notes                                                                 |
| ----------------------- | ---------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Server `dist`           | 94, same entries | 41.99 → 41.79 MB (JS 13.83 → 13.55 MB) | `chunk-*` is now `rolldown-runtime-*`; `Mime-*` is now `HttpServer-*` |
| Client and peer relays  | 1 file each      | —                                      | both print the expected "unavailable" message                         |
| Desktop `dist-electron` | 12, same names   | ±1% per file                           | every file passes `node --check`                                      |
| Contracts `dist`        | 4                | —                                      | identical `.d.mts`/`.d.cts`; 1096 ESM and CJS exports, same key set   |

- **Region markers:** 3362 of the 3368 rc.3 markers remain. The 6 missing ones are dead code that
  rc.3 kept and 1.1.5 removes (`effect` `Request`/`ExecutionPlan`/`doNotation` internals, and the
  unreferenced `computerUseProtocol` constant).
- **`node dist/bin.mjs --help`:** output identical to rc.3, apart from the pid and cwd.

## Determinism proof

All builds were made from `git archive` of `git stash create` (`de3545db55`, i.e. HEAD
`d8beeded52` plus this change), with `node_modules` APFS-cloned.

| Build                                                     | `dist` tree sha256 (server and both relays)                           |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| Snapshot A, three clean builds (`dist` removed each time) | `4a8e70c778a68796b0e4e1933df7da893d90a600b85496aa673f51ab3ed1d360` ×3 |
| Snapshot B, fresh extraction                              | `4a8e70c778a68796b0e4e1933df7da893d90a600b85496aa673f51ab3ed1d360`    |

All four hashes are identical. Before the codegen options were added, a further 6 rebuilds plus
one fresh snapshot also gave one identical hash (`b7194398…`).

The aarch64 graph was produced from each snapshot with `bun run remote-backend-graph`, the
pinned Node archive and a throwaway ed25519 fixture key:

| Graph | Archive sha256                                                     | `buildDigest`                                                      |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| A     | `64a1edf586a220a6e05dfd1934e4a37ee4469b9afa879bd58f39b083f6f99dc2` | `6745a69bacce7d281ea01e943cd660efc37627c27bf19aeea55f498d61c57a9e` |
| B     | identical                                                          | identical                                                          |

- `manifest.json` and `provenance.json` were also byte-identical.
- **Caveat:** to sign, both snapshots carried the same **snapshot-local** policy edit (the three
  new hashes below). The repository's policy is unchanged. A real `buildDigest` will differ
  because it covers the policy hash.
- **Loader sites, checked-in policy:** aarch64 and x86_64 `--list-loader-sites` each report 7
  unreviewed sites in the 3 members below, 0 refusals and 829 reachable modules. With the
  snapshot-local pins, aarch64 has 0 unreviewed sites.

## Region pins

A rebuild with rc.3 (the tsdown link pointed back at rc.3 in a HEAD snapshot) reproduces every
current pin. The other four region pins (both Copilot regions, `Pi/Cli.ts` and
`node-gyp-build`) are unchanged under 1.1.5.

| Member                                   | rc.3 pin    | 1.1.5 digest                                                       | Canonical diff                                                                                   |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `msgpackr/unpack.js`                     | `6e04f456…` | `15bff2e606ca40b410bb609715fd83f0819ef28f342a8e43356d8dd278645226` | `var a, b, c;` split into three statements; `/* @__PURE__ */` added before `new Float32Array(1)` |
| `msgpackr/struct.js`                     | `c320bf3a…` | `786e8edea024ebddc826226c8b8f923c4c2e21bcfe0d8777dcf738e9b07de0be` | `let a, b;` split into two statements                                                            |
| `@anthropic-ai/claude-agent-sdk/sdk.mjs` | `f99dc39c…` | `e17af7aa0bff3353f0ded5d73ea8a03adb2079736d862208855dafde5bbaf3f5` | 87 hunks of real code changes (below)                                                            |

- **msgpackr:** after declarators are split and comments dropped, the canonical texts are
  identical. That is a semantics-preserving syntax change, but not the binding-only rename that
  the documented procedure accepts, so it needs an explicit decision.
- **Claude SDK:** after the same normalisation, and with labels ignored, 829 lines in 87 hunks
  still differ:
  - mostly removed dead code (53 deletion hunks): unused functions and constants;
  - single-use object literals and variables inlined into their use site;
  - `this.size = (this.__data__ = new X(y)).size` split through a temporary;
  - `h()?.session ?? y` folded to `y` where `h` is a no-op;
  - one object literal wrapped in `(() => ({ … }))()`.

  None of these are binding renames, so the region needed the security re-review below. The
  reviewed loader sites themselves (`Function(...)`, `new Function("")`,
  `createRequire$1(...)`) appear in both builds.

## Checks

- `oxfmt --check` and `oxlint` on the three changed TypeScript files and `package.json`: clean.
- `bun run --cwd apps/server typecheck` and `bun run --cwd scripts typecheck`: pass (existing
  Effect advisories only).
- vitest:
  - server: `src/build/serverBundle.entrypoints.test.ts`, the new determinism test and
    `scripts/releaseAssetWorkflows.test.ts`: all passed;
  - scripts: graph `stage`, `regionHash`, `policy` and producer tests, plus `node-entrypoints`
    and `turbo-config`: 51 passed;
  - web: `src/lib/` (exercises vitest on vite 8.1.4): 568 passed.
- **New test** `apps/server/scripts/serverBundle.determinism.test.ts`:
  - two in-process builds must be byte-identical;
  - the `Pi/Cli.ts` region must keep its `DEFAULT_PI_BINARY_PATH` first statement and its
    `createRequire` site.
  - Mutation check: with the codegen options removed, the region test fails.
- **Untracked test:** the root `.gitignore` rule `build/` ignores `apps/server/src/build/`, so
  the existing `serverBundle.entrypoints.test.ts` is not in git. The new test is in
  `apps/server/scripts/` for that reason.
- The existing `stage_is_deterministic` already asserts archive-level determinism from a fixed
  `dist`; it was left unchanged.
- **Not run:** full suites and the Linux `server/bin.mjs --help` container smoke. The signed
  graph with the repository policy is covered in [Security re-review](#security-re-review).

## Security re-review

**Verdict:** all three regions are safe to re-pin, and they are re-pinned in
`scripts/build-remote-backend-graph.policy.data.ts`. No change adds a loader site, changes a
loader-site argument, or adds a call with side effects.

### Method

- Two builds from `git archive HEAD`, each with its own `bun install --frozen-lockfile`:
  - **rc.3:** HEAD unchanged. tsdown resolves rolldown `1.0.0-rc.3`.
  - **1.1.5:** HEAD plus this change. tsdown resolves rolldown `1.1.5`.
- The rc.3 build reproduces all three current pins, so it is the reviewed code.
- Each region was extracted with the repository's `makeCanonicalRegion`, labels intact, plus its
  raw text.
- Two extra normalised views were compared:
  - **Structural:** declarator lists split, comments dropped, `$n` suffixes removed. This leaves
    63 SDK hunks.
  - **Binding-resolved:** every reference renamed by what TypeScript's binder resolves it to. An
    import becomes `I__<module>__<name>`; a region binding keeps its unsuffixed name.
- In the binding-resolved view:
  - no two region bindings share an unsuffixed name, in either build;
  - the region refers to no file binding other than imports (71 in each build);
  - the SDK diff drops to the same structural hunks, minus the `process$1` → `ob` lines (both
    are the default import of `node:process`);
  - both msgpackr diffs are empty.

### Per-region verdict

| Region                                   | Verdict | Change                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msgpackr/unpack.js`                     | Safe    | Labelled canonical diff is only `var $#22, $#23, $#24;` split into three statements and `/* @__PURE__ */` before `new Float32Array(1)`. Labels and raw names are identical on both sides.                                                               |
| `msgpackr/struct.js`                     | Safe    | Only `let $#11, $#12;` (`textEncoder$2`, `currentSource`, module scope, no initialisers) split into two statements.                                                                                                                                     |
| `@anthropic-ai/claude-agent-sdk/sdk.mjs` | Safe    | Dead-code removal (including the DirectConnect WebSocket/fetch transport), single-use values inlined, calls to empty functions folded, temporaries introduced in evaluation order, and two discarded `new Set(...)` expressions kept that rc.3 dropped. |

### Loader-site inventory

The same sites, the same arguments and the same bindings in both builds. Only label numbers and
line positions move, because removed bindings renumber later labels.

| Region         | Site (1.1.5 labelled text)                                                                                       | Bindings (identical in rc.3)                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `unpack.js`    | `$#98 = $#95.read = new Function("r", … $#8.freezeData … $#95.map(($#99) => … $#94.test($#99) …) …)($#56)`       | `Function`, `JSON` globals; `structure` parameter of `createStructureReader`; `currentUnpackr = {}`; `validName = /^[a-zA-Z_$][…]*$/`; `read` |
| `struct.js`    | `new Function("")`                                                                                               | `Function` global                                                                                                                             |
| `struct.js`    | `let $#170 = new Function(...$#164, "…" + $#163.join(";") + "…").apply($#105, $#109.map(($#171) => $#171.get))`  | `args = []`, `objectLiteralProperties = []`, `fullConstruct = structure.fullConstruct`, `properties = []`                                     |
| SDK (ajv)      | `let $#1306 = Function(\`${$#1284.default.self}\`, \`${$#1284.default.scope}\`, $#1304)(this, this.scope.get())` | `oa = Zo()`; `d`, the generated source built by the same compile function                                                                     |
| SDK (lodash)   | `var $#3923 = $#3921 \|\| $#3922 \|\| Function("return this")()`                                                 | `uf` (the `global` probe), `I3` (the `self` probe). rc.3 had `I3` in the same `var` list                                                      |
| SDK (CSP)      | `return new Function(""), !0;`                                                                                   | `Function` global                                                                                                                             |
| SDK (CLI path) | `let $#16236 = $f#69($f#70(import.meta.url)), $#16237 = $#15406(($#16238) => $#16236.resolve($#16238))`          | `$f#69` = `createRequire` from `node:module`, `$f#70` = `fileURLToPath` from `node:url` (`$f#69`/`$f#70` in both builds); `N9` unchanged      |

None of the 61 binding-resolved hunks touches a loader site, its enclosing statement or the
declaration of any argument.

### Open items

1. **`processJSONSchema = (n, r, o) => WA(e, n, r, o)` became `=> void 0`: yes.** `WA` has one
   declaration, `WA = (e, t, n, r) => {}`, and is never reassigned. Its only other use was the
   unused `gU` map, which is also removed. The arguments are plain identifiers.
2. **Removed `gt({ noFollowAny: "untried", localVolumes: void 0 }, (e) => { … })`: yes.** `gt`
   has one declaration, `function gt(e, t) { return e; }`, and is never reassigned. The
   arguments are a data-only object literal and an arrow that is never called, so the call has
   no effect.
3. **Removed bare `K2();`: yes, but `K2` is not empty.** It is a pure factory that returns a
   fresh literal: `active: !1`, `needsRebuild: !1`, `keptLegacyNames: 0`, two no-op arrows, and 15
   no-argument `new Map()`/`new Set()`. `Map` and `Set` are undeclared globals and there are no accessors.
   The result was discarded. `K2` itself stays (`new As(K2)`).
4. **`JP()?.session ?? uE` → `uE` and `S8()?.sessionId ?? Za().id` → `Za().id`: yes.**
   `JP = () => {}` (one declaration, never reassigned) and
   `function S8() { let e = JP(); return e?.session ? void 0 : e; }`, so both always yield
   `undefined`. `JP` is declared after `Za`, but nothing at module scope calls `Yt`, `Za`, `S8` or
   `dE` before that line. The same fold applies to `kx`: `Dc() !== void 0` became `false`, with
   `function Dc() {}`. And `eje`'s `let e = tje(); if (e !== void 0) return e;` was dropped, with
   `function tje() {}` (`return}` in the SDK source).
5. **Added `new Set(Object.keys({ … }))` and `new Set(ow)`: yes.** Both are initialisers from the
   SDK source (`var cW = { cli: !0, … }` with `new Set(Object.keys(cW))`, and
   `var qvt = new Set(ow)`). rc.3 dropped them; 1.1.5 keeps them as discarded expressions.
   - The literal has 27 data properties, all `!0`, and no accessors.
   - `ow = [...rw, "GIT_CONFIG_COUNT", …, "GIT_CONFIG"]`, and `rw` is a literal array of 12
     strings.
   - `Set` and `Object` are globals, so these iterate only plain arrays.
   - The other kept fragments (`[...aw, …, ...pw]`, `[...iw, ...sGe]`,
     `[...new Set([…]), ...JGe]`, `[...new Set([…])]`) iterate the same arrays and Sets that rc.3
     already iterated, minus the outer `Set` construction.
6. **Loader-site bindings: yes.** See the inventory above.
7. **Reorderings: yes.**
   - **`kM`/`IM` (~19599/19614):** `s ? { ...s, direction: "backward" } : { direction: "backward" }`
     is evaluated into a temporary before the call `t(r, o, a, km(n, i))`.
     - The literal has no accessors.
     - The `...s` spread ran in rc.3 too, at the same point relative to `km(n, i)`.
     - It only moves ahead of reads of `t` (`let t = Gu(e)`, never reassigned) and of the
       parameters `r` and `o`.
   - **`new Py(...)` (~45672):** the options literal is hoisted into `t3` before
     `new Py(Uv, n, D, rt, S, Nv, Lv, t3, …)`.
     - The literal has data properties only, reading `p.*`, `e?.*` and locals. Its one call is
       `Vf("CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS")`, which is
       `Oe(process.env[e])` → a string test.
     - `Py` (module `var Py = class Py`), `Uv`, `n`, `D`, `rt`, `S`, `Nv` and `Lv` have one
       declaration each and are never reassigned, so reading them later yields the same values.
   - **Other temporaries:** the rest (`La`, `Ka`, `ZodObject._getCached`, `_error`, `_x`, the
     `/proc/version` read and the `result`/`bridge_session_id` handlers) keep the original
     evaluation order.
   - **URI schemes:** `wss`/`urn`/`urn:uuid` were inlined into `Rh`. These are single-use
     literals, and `Ah` is a data-only literal.

### New pins

| Member                                   | Pin                                                                |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `msgpackr/unpack.js`                     | `15bff2e606ca40b410bb609715fd83f0819ef28f342a8e43356d8dd278645226` |
| `msgpackr/struct.js`                     | `786e8edea024ebddc826226c8b8f923c4c2e21bcfe0d8777dcf738e9b07de0be` |
| `@anthropic-ai/claude-agent-sdk/sdk.mjs` | `e17af7aa0bff3353f0ded5d73ea8a03adb2079736d862208855dafde5bbaf3f5` |

### Proof with the repository policy

Two fresh `git archive HEAD` snapshots were made, each with the working-tree change (including
these pins) and a clean `bun install --frozen-lockfile`. The server and relay `dist` tree sha256
was `4a8e70c7…d1360` in both.

| Check                                                                          | Result                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `bun run remote-backend-graph --target aarch64-unknown-linux-gnu`, fixture key | Both pass, signed, 27 reviewed sites                                                                                             |
| Archive sha256                                                                 | `64a1edf586a220a6e05dfd1934e4a37ee4469b9afa879bd58f39b083f6f99dc2` in both                                                       |
| `buildDigest`                                                                  | `6745a69bacce7d281ea01e943cd660efc37627c27bf19aeea55f498d61c57a9e` in both; `manifest.json` and `provenance.json` byte-identical |
| `--list-loader-sites`, x86_64 and aarch64                                      | 0 unreviewed sites, 0 refusals, 829 reachable modules                                                                            |

The `buildDigest` equals the earlier snapshot-local run, which used the same pins. So the
policy hash it covers evidently does not include the header comment.

**Store links:** a `bun install` over an existing rc.3 `node_modules` again left tsdown linked to
rc.3. Removing `node_modules` and reinstalling fixed it.
