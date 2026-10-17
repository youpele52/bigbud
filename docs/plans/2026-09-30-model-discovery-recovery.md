# Model discovery recovery

Status: Ready for implementation

## Goal and decisions

- Two genuine source attempts before exposing a fallback; then three additional,
  scoped background attempts. A successful source result replaces fallback models.
- Prefer the last successful catalog for the same provider settings identity;
  otherwise use the provider's static fallback. This is the explicit implementation
  assumption for the unanswered last-known-good preference.
- Model recovery is separate from CLI/authentication health recovery. Missing or
  disabled providers and actionable authentication failures retain existing behavior.
- Manual refresh cancels the previous model cycle and bypasses discovery caches.
  Background work is bounded, serialized, scoped, and generation guarded.
- Preserve selected model identities; changing available options must not select
  a different model implicitly.

## Implementation

1. Add a shared model discovery recovery controller and snapshot recovery metadata.
   Integrate at the managed-provider boundary so catalog enrichment participates in
   each source attempt, rather than publishing fallback before discovery completes.
2. Mark live/fallback source outcomes consistently for Codex, Claude, Copilot,
   Cursor, Devin, OpenCode, KiloCode, and Pi (custom-only fallback). OpenCode V2 is
   dormant and CLI Proxy has no hardcoded fallback, so leave their behavior intact.
3. Remove nested Codex/Claude discovery caches. Keep useful error details and make
   Codex account/skills enrichment best-effort without discarding successful models.
4. Review each real fallback catalog against authoritative provider catalogs or
   installed authenticated source output; never copy model names across providers.
5. Display per-provider progress/outcome toasts: blue working, green recovered,
   amber exhausted with fallback still usable. Deduplicate snapshot replays.
6. Add focused policy, integration, discovery, and toast tests; verify selected-model
   preservation using the existing picker/store conventions.

## Validation and safety

Preserve the pre-existing dirty worktree. No Git publication or installed-app edits.
All authored/edited source files must remain at most 400 lines. Run targeted oxfmt,
oxlint, package-filtered typechecking and focused Vitest suites (never `bun test`).
The root lint script combines linting and a global length audit, so use its equivalent
targeted commands if argument forwarding cannot scope both stages; report this.
Nested planner/implementation/review agents cannot run because this session is at
the configured depth limit; perform these gates directly and report the limitation.

## Catalog evidence (2026-09-30)

- Codex: authenticated Codex 0.159.0 `model/list` output from the investigation:
  GPT-6.1 Sol, GPT-6 Astra/Sol/Luna, GPT-5.6 Sol/Terra/Luna, GPT-5.5. Older entries
  remain compatibility fallback choices, including plan-gated Spark; successful
  live discovery replaces the entire fallback rather than merging legacy choices.
- Claude: https://code.claude.com/docs/en/model-config.md — explicit Sonnet/Opus
  5.5 and Fable 5.1 IDs; aliases depend on account/provider, so default/opus labels
  must not falsely claim a fixed 4.6 version.
- Copilot: https://docs.github.com/en/copilot/reference/ai-models/supported-models
  corroborates current supported names; IDs checked in Models.dev's
  `github-copilot` catalog (not copied from Anthropic IDs).
- OpenCode/KiloCode: https://models.dev/api.json, the catalog already consumed by
  these providers; gateway IDs checked independently (`opencode` versus `kilo`).
- Cursor, Devin, and Pi have **custom-only** fallback lists, not bundled model
  names. Preserve this rather than inventing supported models. They still receive
  the same discovery retry and last-known-good policy.
- CLIProxy has no bundled fallback; OpenCode V2 is dormant. Neither gains invented
  catalog entries or activation behavior.

## Implementation and validation evidence

- Shared controller: `apps/server/src/provider/modelDiscoveryRecovery.ts`, integrated
  with opt-in catalog probing/enrichment at `makeManagedServerProvider.ts`.
- Snapshot contract: optional `modelRecovery`, distinct from provider health recovery.
- Two foreground attempts and three delayed background attempts are covered by policy
  and managed-provider integration tests. Cancellation tests cover an in-flight
  background probe, generation supersession, and settings identity changes.
- The foreground publication barrier prevents a fast background result from being
  overwritten by a slower fallback snapshot decorator.
- Codex optional account/skills enrichment has a bounded 500ms grace period after
  models arrive. Errors/stalls no longer discard successful model results.
- An actual post-change Codex probe returned all eight current models and 29 skills.
- Selection regression tests cover all eight participating providers, including a
  Copilot explicit model ID that previously could be rewritten via a legacy alias.
- Focused `bun fmt` passed for all 29 task files. Targeted
  `bun x oxlint --report-unused-disable-directives` passed for all 28 source/test
  files with zero warnings/errors. All edited source/test files are at most 400 lines.
- `bun typecheck --filter=@bigbud/server --filter=@bigbud/web --filter=@bigbud/contracts`
  passed (including required shared/effect-acp dependency checks). Existing Effect
  language-service informational messages outside this task remain unchanged.
- Focused `bun run --cwd apps/server vitest run ...`: 117 tests in 23 files passed.
- Focused `bun run --cwd apps/web vitest run ...`: 19 tests in four files passed.
- Focused `git diff --check` passed.
- Independent nested review was attempted and blocked by the configured subagent
  depth limit. The initial direct review was subsequently superseded by the
  parent-session independent review described below.

### Validation limitations for parent-session handoff

The literal root `bun lint` script cannot accept file scoping for its first command:
it runs repository-wide oxlint, then an unscopable repository-wide test-length audit.
The equivalent targeted oxlint checks and an explicit line-count audit were used to
honor the user's focused-only requirement. Do not claim that literal root command
was run. Full-repository checks and a packaged desktop/browser smoke test were not run.
The parent session can perform independent review without the nested-agent limit.

## Independent review corrections

All three reported issues have focused regression coverage:

1. **Hung Claude initialization cancellation:** `Provider.probeRuntime.ts` now owns
   the SDK runtime with `Effect.acquireUseRelease`, forwards the Effect cancellation
   signal to its AbortController, and closes the runtime in the Effect finalizer.
   Cleanup does not depend on the initialization Promise settling. Tests cover both
   the 8-second timeout and explicit fiber interruption.
2. **Empty fallback after complete probe failure:** failure snapshots now use the
   initial-snapshot factory with current settings, not the deliberately empty initial
   published snapshot. OpenCode, KiloCode, and Pi now pass factories rather than
   precomputed snapshots. Recovery still prefers settings-scoped last-good models.
   Tests cover all five whole-probe timeouts, last-good precedence on thrown failures,
   and settings changes rebuilding the fallback.
3. **Superseded async decoration:** generation is checked again after awaiting the
   decorator, before committing settings/snapshot state, and before publication.
   A deferred-decorator test verifies that the stale snapshot is neither committed
   nor published while a superseding refresh is pending.

Correction validation: formatting and targeted oxlint passed on all nine correction
files (zero warnings/errors); `bun typecheck --filter=@bigbud/server` passed along
with its required dependencies; 87 tests in 14 focused server files passed.
All correction files remain below 400 lines (largest: 372).

Root lint scoping was rechecked against the installed `oxlint --help` and the root
script. Oxlint accepts file paths, but root `bun lint` invokes it without a parameter
slot before `&&`. The subsequent length-audit script unconditionally walks the
repository and reads neither scope arguments nor a scope environment variable.
There is no supported way to scope both without changing the script or bypassing a
required stage. The literal root lint gate therefore remains unverified; targeted
checks must not be represented as a full root-lint pass.

## Follow-up: publish catalogs before optional capabilities

The latest user direction supersedes implementation item 1's blanket treatment of
all enrichment as source discovery. Hook classification found Cursor and Devin
already return their live model lists from the core probe; their ACP capability
enrichment is optional. OpenCode and KiloCode instead use their old enrichment
hooks to perform actual source catalog discovery. Codex, Claude, Copilot and Pi
discover catalogs in the core probe. CLIProxy and dormant OpenCode V2 are unchanged.

- `discoverSnapshot` now explicitly identifies source work. It runs inside the
  coordinated probe's deadline and participates in the existing two foreground
  attempts plus three background retries. Availability-only fallbacks never count
  as successful source catalogs.
- `enrichSnapshot` is optional background work, managed by the shared scoped
  `managedProviderEnrichment.ts` controller. Core state and stream publication
  happen first. Optional work has a 30-second default deadline, is serialized,
  cancelled on replacement/settings/disable/shutdown, and guarded by generation
  plus operation lifetime. Timeout/error leaves the already-published catalog intact.
- Recovered background catalogs also schedule optional enrichment. Manual refresh
  no longer defers core publication while awaiting optional enrichment.
- Added focused coverage for blocked optional work, ready stream publication,
  independent-provider progress, manual cancellation/no overlap, disable, shutdown,
  timeout and stale callbacks, failure preservation, background recovery enrichment,
  and bounded source hooks retaining the two-plus-three attempt policy.

No Codex-specific implementation was changed. The parallel runtime investigation
found successful Codex server checks after waiting for shared probe capacity; this
change does not claim to resolve the separately unverified renderer symptom.
Packaged-release/renderer smoke verification remains with the parent session.

### Independent review: single source-attempt permit ownership

Review found the managed-server catalog helper still acquired the same aggregate
probe permit already held by the new outer source attempt. OpenCode and KiloCode
plus a third occupied permit could deadlock until the outer deadline expired.
The helper is now named `discoverManagedServerCatalog` and explicitly delegates
permit/deadline ownership to its caller. Both production callers are inside
`makeManagedServerProvider`'s coordinated source attempt; standalone aggregate-cap
tests explicitly coordinate their own calls. No other production callers exist.
A new regression runs both real catalog wrappers through managed providers while
a third coordinated probe is blocked: it failed before this correction and passes
without advancing to a timeout after the correction.
