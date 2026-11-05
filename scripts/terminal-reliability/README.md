# Terminal reliability feasibility harness

## Current recovery direction

The exact-private-state experiments below are preserved for comparison, not selected for
production recovery. The user's current direction is bounded Orca-style ANSI snapshots;
see [the decision, evidence and implementation status](../../docs/reports/terminal-recovery-2026-11-01.md).

## Production-version qualification and navigation diagnostics

```sh
python3 scripts/terminal-reliability/checkpoint.production.py
bun run --cwd apps/web test:browser src/components/terminal/TerminalCheckpoint.themeAuthority.browser.tsx src/components/terminal/TerminalViewport.navigationDiagnostics.browser.tsx
```

The production probe fetches the pinned **6.1.0-beta.304** headless package into memory,
verifies its archive and bundle hashes, checks the installed browser version, and uses the
actual frontend Unicode11/`bigbud-11-zwj` provider. It installs nothing and changes no package
or production emulator. The runner uses Bun to import the existing TypeScript provider.
It first verifies stock split ZWJ/parser input, alternate-screen/paste modes and cursor responses,
then runs the isolated production-pair capture/import experiment described below.
The older 6.0.0 checkpoint experiment below remains isolated and unqualified for production.

The matching stock headless parser recognizes three OSC color queries but emits no color
replies. The browser fixture independently demonstrates different replies from two themes,
changed replies after a live theme update, and application palette overrides. Existing
`TerminalViewport.theme.ts` intentionally answers from the rendered theme. A single backend
responder therefore needs an explicit session palette policy. **Approved policy:** the most
recently focused view supplies effective palette/theme updates; retain its last palette when
all views detach. Other views may keep their own visual themes, but TUI queries use the elected
palette. This policy is implemented and tested only in the isolated palette adapter, not in the
runtime or its stream protocol. Do not silently
replace those semantics with default black/white replies.
No backend response authority or exact checkpoint capability is enabled by these probes.
Full field/handler coverage, hostile-payload qualification, image state and successful
maximum-state capture/import remain outstanding. Tested malformed imports now leave the target unchanged.

The probe also verifies that the existing selected-state capture cannot read the production
state: it expects `coreMouseService`, whereas this version exposes `mouseStateService`. Its
DEC-mode schema additionally lacks `colorSchemeUpdates` and `win32InputMode` (source inspection).
This is evidence against directly transplanting the 6.0.0 experiment, not proof that renaming
the service and adding two fields would make it complete. The production source additionally
contains optional Kitty keyboard state; any future profile enabling it must qualify its normal/
alternate flag stacks as well. The current frontend does not enable that extension.

### Production-pair selected-state experiment — gate remains closed

`checkpoint.production.{state,values,parser,links,palette}.mjs` is a new version-specific,
isolated JSON-wire projection, **not** a renamed 6.0.0 codec and **not** a qualified production decoder.
It uses the pinned headless bundle and separately hash-pins the installed production browser
ESM bundle. The browser build explicitly resolves xterm from `apps/web`, not the older xterm
dependency in `scripts`. It uses the real frontend addon attachment with Unicode11/ZWJ and
search, at synthetic 20×6 geometry, 5000 scrollback, cursor blinking and default text modes.
The fixture driver uses the already installed Playwright browser and a temporary loopback-only
HTTP server. The existing owned-process executor bounds runtime/output and cleans up the worker
process tree on failure. Pinned vendor input is passed through a fresh, owned temporary file
under the `opencode` temp directory and removed after confirmed cleanup; no terminal journal is
written. Browser bundle bytes remain in memory. It installs no browser or dependencies.

Selected state and ownership:

| Area         | Selected state                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buffers      | Both normal/alternate line cell words, combined strings, extended attributes/links, wrapping, scrollback, cursor, margins, tabs and active buffer                                             |
| Saved state  | Saved cursor, attributes, charset set/level, origin and wrap modes (including new 6.1 fields)                                                                                                 |
| Parser       | CSI parameters/subparameters, parser/Unicode join state, UTF-16/UTF-8 carry, OSC/DCS/APC state and active handler bindings; new `LimitedStringBuilder` payloads restored into target handlers |
| Modes        | Common/DEC modes, mouse protocol/encoding, cursor state; optional Kitty state is copied but its enabled profile is not qualified                                                              |
| Hyperlinks   | Link data/IDs and normal/alternate marker positions; subscriptions are rebuilt against target buffer trim/insert/delete events, never copied from source                                      |
| Colors       | Complete 259-slot effective RGB palette and restore defaults; OSC 4/10/11/12 and reset responses plus color-scheme query/update behavior                                                      |
| Presentation | Rendering/search caches, fonts, selection, browser focus/IME and view-specific mouse wheel/dedup state are not transferred                                                                    |

**51 deterministic continuation cases pass** through headless→headless, headless→browser and
browser→browser restore. These cover 32 mixed-stream cuts, all three partial four-byte UTF-8
cuts, split surrogate/ZWJ, CSI, OSC/DCS/APC tails, saved modes/charsets, alternate buffers, colors,
existing/partial hyperlinks and hyperlink eviction after 5010 newlines. The browser compares
an uninterrupted emulator with the restored one, then resizes, exercises ArrowUp and paste,
and performs a second browser capture/import plus continuation. Historical import emits no
responses in these fixtures. The oracle is separate from capture helpers and compares buffer
cells, colors/styles, cursor positions, modes, links, titles, palette and response bytes; it is
not an exhaustive proof of every private xterm field or native interaction.

The palette policy test elects view B after view A, rejects A's stale update and verifies B's
last background query response survives detachment. No production focus lease or generation
fencing is implied. Six local refusal/custody checks cover schema/capability mismatch,
additional handlers, external markers, unsettled writes and source/snapshot aliasing.
The actual image addon is loaded in a browser refusal case; its changed profile is
rejected rather than silently omitting image state.

**Concrete failed qualification gates (intentional negative evidence):**

- Import now accepts strings only, scans resource estimates before JSON parsing, validates
  selected state and materializes buffers, attributes, parser builders and link subscriptions
  before commit. Twenty-nine adversarial refusals (including the former handler-limit failure)
  assert unchanged captured target state, with sentinel hyperlinks and a pending parser tail;
  raw objects/getters/proxies are refused without caller callbacks. The report's
  `malformedImportAtomic: true` describes these tests, not arbitrary hostile-input certification.
  Commit-time callbacks, exhaustive semantic validation and allocation-failure behavior remain
  unqualified. Do not import these modules into production.
- The one-million-potential-cell cutoff is removed, without changing product configuration.
  A fresh owned worker populates all 5500 normal-buffer lines at 1000×500 with independently
  varying RGB attributes and nonuniform characters. Its 16,500,000 cell words need at least
  264,000,000 bytes for numeric arrays, minimum wire and materialized cells, exceeding the
  unchanged 128 MiB staging ceiling. Capture is refused before projection; a cell digest remains
  unchanged. One local run measured RSS at 46,170,112 bytes before creation, 132,202,496 after
  population and 136,609,792 after refusal/digest checks. These are process observations, not
  allocator guarantees or imported-state peaks; hashing also contributes to measurements.
  Reports retain the runtime's raw high-water counter without asserting its units.
  Encoded, staging and estimated-state budgets remain 128 MiB each, aggregate 512 MiB.
  Capture admission uses lower bounds, not a complete live reservation system. Full combined/
  extended-attribute worst cases, aggregate live targets and maximum import remain unqualified.
- Handler fingerprints are compatibility observations, not a complete handler-state schema
  or security authority. Async/custom/image handlers, all terminal options, optional extensions,
  selection/search-marker reconstruction, IME and real mouse/browser renderer integration still
  require explicit qualification. This is private-state adaptation, not a maintained upstream
  source patch or validated production packaging boundary.

Every report and checkpoint remains `exactCapability: false`. Passing these continuations
does not open the exact-recovery production gate. This private-state experiment enables no
runtime recovery or PTY response authority. The separate bounded ANSI implementation and its
guarded production rollout are documented in the canonical report linked above.

After mounting a terminal, opt into content-free lifecycle traces from the browser console:

```js
window.__bigbudTerminalLifecycleDiagnostics.setEnabled(true);
// Reproduce navigation/remount/reconnect, then inspect:
window.__bigbudTerminalLifecycleDiagnostics.read();
// Disable and clear retained metadata:
window.__bigbudTerminalLifecycleDiagnostics.setEnabled(false);
```

The in-memory ring retains at most 256 events, with identifiers capped at 128 characters.
It contains emulator view IDs, visibility/renderer transitions, subscription requests and
local unsubscribe/resync, hydration/input transitions, and a projection of accepted snapshots
(PID, generation, status, history length and availability flags). No terminal text, input,
paths, environment values or error messages are recorded or transmitted. Enabling starts a
new trace window; a view mounted before enabling has no synthetic `mounted` event. Snapshot
PID/generation values are observations, not independent proof of native process continuity.
Use the existing `__bigbudTerminalDiagnostics()` alongside it for current stream credit,
queued-byte and renderer diagnostics. No server hold state is inferred from a view trace.

The navigation browser fixture verifies that four hide/show cycles retain one real xterm,
then an explicit unmount/remount with a truncated mocked snapshot refuses input while reporting
the same PID/generation. It does **not** reproduce real thread routing, real pi/OpenCode, or
prove why a user's terminal remounted after two to four switches. Collect a real navigation
trace before assigning that trigger to view retention or GPU eviction.

Run from the project root:

```sh
python3 scripts/terminal-reliability/checkpoint.py
node scripts/terminal-reliability/checkpoint.inventory.mjs
bun run scripts/terminal-reliability/baseline.mjs dom
bun run scripts/terminal-reliability/baseline.mjs webgl
bun run --cwd apps/web test:browser src/components/terminal/TerminalViewport.rendering.browser.tsx
```

The first command fetches **published, version-pinned** MIT headless 6.0.0 and SerializeAddon 0.14.0 artifacts into memory, verifies all four recorded counterexamples, and reports artifact SHA-256 plus Python/Node versions. It writes no disk journal or package installation. Reports contain synthetic fixtures/counters only. Redirect stdout to an explicitly chosen external artifact path if retention is needed.

The bounded replay reference exercises nine synthetic continuations including split UTF-8, partial CSI/OSC/DCS, alternate/wide/combining cells, queries and ordered resize. It rejects exhaustion rather than truncating. It is deliberately **not** a checkpoint extension: it requires every operation from an empty generation, re-executes historical replies, and cannot compact state. It is not integrated in production. These successes do not open exact recovery.

The synthetic headless baseline measures write-callback latency only. The isolated baseline driver measures actual loopback WebSocket→browser xterm delivery with one callback-credited output record outstanding, in DOM and WebGL modes. It does not exercise bigbud's production WS/PTY, backend queues or real shell latency. Hardware/driver and power mode are not inferred from setting intent or headless WebGL availability. No performance improvement is claimed. Browser tests use the pinned public APIs and an owned canvas/context-loss event, not renderer internals. Packaged GPU/driver faults and the production WS/PTY baseline matrix remain outstanding.

## Isolated state checkpoint experiment (not exact capability)

```sh
EXPERIMENT=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/terminal-checkpoint-extension
python3 scripts/terminal-reliability/checkpoint.extension.fetch.py "$EXPERIMENT"
bun run scripts/terminal-reliability/checkpoint.extension.generate.mjs "$EXPERIMENT"
node scripts/terminal-reliability/checkpoint.extension.runner.mjs "$EXPERIMENT"
node --expose-gc scripts/terminal-reliability/checkpoint.extension.memory.mjs "$EXPERIMENT"
node --expose-gc scripts/terminal-reliability/checkpoint.extension.browser-memory.mjs "$EXPERIMENT"
bun run --cwd scripts test checkpoint-node.test.ts
```

The generator enforces the repository's declared **Bun `^1.3.9`** support policy and fingerprints the actual executing compiler version and configuration; both 1.3.9 and 1.3.14 are supported. The Vitest wrapper above provisions fresh owned fixtures and supplies the tickets required by all three genuine Node test suites; invoking those suites directly without a ticket refuses. The execution anchor is the **trusted reviewed repository source + pinned vendor input bytes + installed supported toolchain**, NOT the adjacent mutable manifest. Before either artifact executes, every runner invokes a read-only `--derive-only` rebuild to independently derive both expected output hashes, then compares the manifest AND actual output bytes to them. This mode never loads candidate bundles or rewrites the experiment. Source/build/input/bundler metadata must also match. Runners execute immutable verified source strings, not a later file read. Coordinated output+manifest replacement, bare-vendor/known-hash substitution and post-verification file replacement cannot redirect execution. This trusts the local checkout/runtime/toolchain; it is not a sandbox against an attacker controlling those anchors or a remote package-signing claim. No installed dependency or production terminal is patched. Temporary files contain vendor inputs, generated experiment code and synthetic evidence only, never a terminal journal.

Schema 2 replaces the JSON projection with **≤48 KiB typed binary pages**. Fixed field/type/order descriptors select trusted local prototypes; the payload never selects a class or arbitrary service property. Cell content/fg/bg planes use lossless uniform-plane encoding or typed words, not per-cell JS arrays/maps. Strings retain UTF-16 code units (including split/unpaired surrogates), not lossy UTF-8 substitution. Counts, offsets, types, enums and budgets are checked during a bounded metadata scan. Cell arrays and long strings remain borrowed slices until all selected-state cross-field/handler/parameter/cell references pass; only then are payload arrays, strings, circular lists and active handler bindings constructed. Commit restores fixed fields without VT writes, public resize/option events or historical replies. Corruption with a recomputed digest still refuses without target mutation. This is a selected-state compatibility boundary, **not yet a reviewed complete hostile-checkpoint decoder or maintained upstream source fork**.

Page custody uses captured **intrinsic TypedArray/ArrayBuffer accessors** to validate actual buffer brand/type/offset/current length. Only full, zero-offset `Uint8Array` views over ordinary fixed, non-detached ArrayBuffers are accepted. Shared, resizable, detached, proxy and custom-prototype views or shadowed metadata/iterator accessors refuse before payload use; no caller getters are invoked. Hashing uses indexed bytes over normalized local page-list metadata, never caller iterators. Frozen containers do not freeze backing bytes: ordinary same-realm byte borrowing is safe here only because validation→digest→scan→materialization→commit is synchronous, with **no awaits or caller callbacks**. This assumption is not a transferable cross-worker/shared-memory custody contract. Headless and cross-origin-isolated browser tests cover 14 refusal cases each, asserting zero caller callbacks and unchanged target/reservations.

The **80 headless + 80 browser cases** retain the earlier fixtures and extend to 64 deterministic byte-cut/resize cases, cursor shape/wrap-pending, long partial OSC, extended graphemes, mouse event deduplication and partial OSC 8 before link creation. A separate oracle reads the uninterrupted services directly, independently of capture/schema/codec, and compares selected metadata/raw cells plus subsequent state and response bytes. Browser terminals open only after detached import. Existing hyperlink/marker custody, palette/color-query authority, unsupported custom option/handler/Unicode sets and unsettled asynchronous/callback cuts fail closed. **Theme restriction:** only an initially empty theme that has never been publicly replaced is supported; constructor nonempty themes, public theme setters/options replacement (even revert to empty) and observable in-place theme changes refuse capture/import. Nine theme refusals pass in each realm; this is not full palette capture. Partial OSC 8 without a pre-existing link can continue and create correctly linked markers; this does **not** mean existing links can be checkpointed. Every envelope remains `exactCapability: false`; passing the selected oracle is not future-field omission/completeness proof.

Ceilings follow the plan's **128 MiB encoded / 128 MiB restore staging / 128 MiB estimated emulator state**, with a stricter combined 512 MiB reservation pool in each harness realm, ≤2 retained checkpoints per source, separately charged pages, old targets and capture scratch. Export measures/reserves before allocating pages. Import reserves incoming bytes + decoded staging before payload construction; budget failure keeps the old target and checkpoint intact. Explicit `releaseExperimentalCheckpoint` returns page custody; disposing a source does not release externally retained checkpoints. Accounting estimates V8 object/string overhead conservatively; it is **not allocator instrumentation, cross-process profile accounting or pre-write/resize admission enforcement**. GC/process peaks remain separate evidence.

Product geometry is **1000×500 with 5000 scrollback** (`workspace/terminal.ts` bounds and `TerminalViewport.session.ts` setting), not the old experiment's 500×500/10,000 stress geometry. Neither is reduced. The isolated `--expose-gc` memory cases fill every retained line with nonuniform text and prove non-refusing capture/import and independent raw-state digest equality under the declared ceiling at both geometries. Product cells alone require 66,000,000 bytes; the checkpoint is 22,237,134 B. Latest source + fresh import + pages reach 267,552 KiB headless RSS. The browser test transfers one page at a time, checks all 5500 line digests, opens the view and reports CDP heap/backing bytes and 25 ms sampled renderer RSS (244,560 KiB observed peak; not a guaranteed allocator peak).

**Unresolved maximum-state blocker:** independent foreground/background colors in every product-max cell require 66,193,134 B encoded + ~73.97 MB decoded state, exceeding unchanged 128 MiB restore staging. Import explicitly refuses before payload allocation/mutation, preserving the old state/checkpoint; latest source + target + both retained checkpoints reach 332,112 KiB RSS. Long payloads/combined maps may impose further limits. Do not raise budgets, shrink configurations or call compressible maximum text universal exact-state proof. Parent CODE accepted the supported experimental projection, not complete P6a/exact readiness. Its SECURITY review requested the two focused corrections above; focused SECURITY re-review remains outstanding. P6a/exact/native gates stay closed pending maintained hyperlink/palette authority and complete field/memory proof.

**Maintenance/removal policy:** terminal reliability owns this experiment. Source concerns are split as `codec/pages/page-custody/schema/digest/budget/state/validation`; generator/entry/artifact verification stay separate. Any xterm or generator-tool update requires explicit new verified inputs, source-field coverage review, regenerated paired build hashes, all seven codec/artifact/custody tests, 80+80 continuations, realm refusal cases and both maximum-state memory cases. Never edit generated artifacts or minified vendor private names. Keep authored modules ≤400 lines; the generator checks source and generated output lengths at its boundary. Replace this prototype with a reviewed source-level extension (or remove it once a maintained equivalent passes the same gates); never silently install it in production. Packaging/dependency decisions and state-host/native integration still require separate review/approval.
