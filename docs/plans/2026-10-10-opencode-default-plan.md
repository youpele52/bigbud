# OpenCode integration adoption

Status: **Implemented, validated and independently reviewed** (10 October 2026)

## Authoritative scope

- New chats expose one **OpenCode** option backed by `opencodeV2`. Keep `opencode`
  and `opencodeV2` contracts, history and persisted routing distinct.
- Legacy OpenCode chats are read-only history. Reject new/continued/retried turns,
  session recovery, queue flush, approvals, shell and runtime mutations with
  guidance to create a new OpenCode chat. History rendering and administrative
  archive/delete/pin operations remain available.
- Shared TUI remains the default supported connection mode. Unsupported service,
  version, storage or platform states use existing actionable V2 setup failures;
  never relax the V1 parser, fall back to V1 or start a competing daemon.
- Do not make OpenCode the global default; preserve other explicit choices.
- Repository only; no CLI upgrades, native database/config/account migration,
  desktop rebuild/install/relaunch, process manipulation, commit or push.

## Evidence and settings decision

`settings.opencodeV2.ts` currently defaults disabled; `settings.ts` defaults legacy
enabled. `serverSettings.persistence.ts:stripDefaultServerSettings` removes values
equal to defaults, including an explicit V2 disable. This intent cannot be recovered.
The user explicitly selected the conservative policy: **fresh installations enable
V2; existing settings files without an explicit V2 enable remain disabled**.
An explicit V2 enable wins even when legacy was disabled. Preserve legacy paths,
custom models and unrelated preferences. Persist the effective V2 enable bit on
subsequent writes, including default values, so future sparse settings round trips
cannot silently disable or enable it. Do not rewrite settings merely on load.

## Implementation

1. Add a shared retired-provider policy and read-only message. Keep compatibility
   schemas and history helpers; exclude legacy from public descriptors/pickers,
   settings cards, visibility and ready/default selection on web/mobile. Rename
   V2 display metadata to OpenCode. Existing legacy selections stay legacy history;
   never copy their model/subprovider routing into V2.
2. Change fresh schema defaults to V2 enabled / legacy disabled. Normalize raw
   existing settings before full and tolerant decode; pin V2 enabled on writes.
   Cover absent, explicit enable/disable, legacy disable, private paths and reload.
3. Remove legacy provider/adapter from production registries and server layer
   composition. Retain the shared V1 manager because KiloCode depends on it, but
   reject legacy acquire in production before spawning. Retain fixture-based V1
   internals for KiloCode and historical protocol tests.
4. Add authoritative command admission and provider start/routing/recovery guards.
   Include interrupt/session-stop admission and actionable legacy background-review
   rejection; settlement commands remain available for historical event ingestion.
   Guard existing legacy bindings against attempted V2 rebinding. Retire legacy
   workload eligibility so title/summary/learning fallback never starts V1; reject
   legacy learning rather than migrate a historical job. Validate replay/recovery
   with no adapter calls and no binding/storage mutation.
5. Replace legacy web/mobile composer with a read-only notice; keep transcript
   visible. Guard mobile command delivery and preserve other provider behavior.
6. Update provider documentation to reflect replacement and conservative settings
   policy, while retaining qualified runtime/platform/storage limitations.

## Validation and review

- Focused Vitest tests: shared policy, contracts defaults, settings service round
  trips, provider registry no V1 discovery, start/recovery/routing and decider
  rejection, workload eligibility, web/mobile descriptor/default selection and
  read-only presentation. Existing V2 chats/routing tests remain unchanged except
  display-name/default expectations.
- Run scoped `bun fmt <task files>` (no unrelated formatting), `bun lint`,
  `bun typecheck`, relevant documented Vitest commands and repository tests via
  `bun run test` (never `bun test`). No Rust changes planned.
- Every materially edited source/test file must remain <=400 lines.
- Review all requirements, replay and background seams, settings persistence and
  dirty-tree preservation; fix in-scope findings and rerun affected checks.
- Nested specialist delegation was attempted but unavailable (subagent depth
  limit); use the installed specialist instructions locally and report this
  limitation rather than claim an independent delegated review.

## Baseline

Branch `dev`, SHA `6a6c13ebdd94c76167b36b16893a921b1e458ce7`. Pre-existing
dirty files: `MessagesTimeline.workEntry.tsx`, `.test.tsx`, `.actions.tsx`,
`.logic.ts`, and `MessagesTimeline.workGroup.tsx`; preserve them. Prior ProviderCard
virtualization changes are already in HEAD. No applicable nested AGENTS for TS.
V2 docs consulted: `/v2/docs/migrate-v1` and `/v2/docs/build/client`; use current
V2 service discovery/authentication, not legacy SDK compatibility assumptions.

## Execution evidence (10 October 2026)

- Implementation follows the conservative settings decision. No native installation,
  accounts, shared settings, provider history IDs or database migrations were changed.
- Task-only `bun fmt` and repository `bun lint`/`bun typecheck` passed. The latter
  verified all nine packages. All 67 task-authored/edited code files are at most
  400 lines (70 task files total); pre-existing timeline files were not formatted.
- Focused title/streaming/expansion fixture suites: six files, 30 tests passed.
- Admission, responses, routing and replay guard suites: four files, 33 tests passed.
- Attachment, bundled-agent, recovery, registry, background-review and development
  snapshot regression suites: eight files, 46 tests passed. Retained V1-protocol
  runtime tests exercise KiloCode, not production legacy OpenCode. Historical
  ingestion tests continue asserting the original legacy identity is retained.
- Browser picker/settings regressions: two files, five tests passed.
- The first completed broad server run identified retirement/default-related stale
  fixtures. Those were corrected without restoring legacy runtime eligibility;
  a concurrent intermediate run used pre-fix transformed modules and reported three
  already-corrected policy assertions. The final stable-code `bun run test` passed:
  nine tasks successful, 7,565 tests passed, 98 skipped, zero failures. Per package:
  server 4,042 passed/94 skipped; web 2,389; mobile 212; desktop 421/4 skipped;
  shared 230; contracts 177; scripts 94. Native/live and non-host-platform suites
  remain repository-defined opt-in/skipped checks, not installed-app verification.
- Exact final workflow: `bun fmt $(cat "$TASK_FILE_MANIFEST")`, `bun lint`,
  `bun typecheck`, `bun run test`. The task manifest and completion logs are in the
  approved OpenCode temporary directory as `opencode-adoption-task-files.txt`,
  `opencode-adoption-fmt-final.log`, `opencode-adoption-lint-final.log`,
  `opencode-adoption-typecheck-final.log`, `opencode-adoption-tests-completion.log`.
- Nested specialist delegation is unavailable (`Subagent depth limit reached (1)`).
  The parent launched independent read-only review session
  `ses_eda27ccd4ffeIYSOsR5m78KHmP`. Its three confirmed blockers and shutdown
  follow-up were supplied by the parent and addressed below. The parent-managed
  follow-up review approved the corrections with no blocking findings.

## Independent review corrections

- P1 tolerant settings recovery: start from existing-file conservative defaults,
  retaining the normalized V2 enable bit independently of malformed provider fields.
  Explicit false and missing consent stay false; explicit true stays true. Tests cover
  malformed fields/entries and real-file load, unchanged-on-load, sparse writes and
  reload, preserving unrelated disables and historical legacy configuration.
- P2 bootstrap side effects: apply retirement checks to turn, submission and shell
  bootstrap before recipe claims, worktree Git operations, child metadata dispatch
  or setup. Checks recognize legacy selected/session identities and create payloads;
  non-retired shell queue semantics and durable receipt replay remain unchanged.
  Nine regressions verify zero Git/recipe/metadata/setup effects and unchanged history.
- P2 duplicate visibility row: use public provider descriptors. Three SSR regressions
  verify exactly one OpenCode toggle and that V2, not legacy, controls its preference.
- Shutdown follow-up: skip both active-session and persisted-binding upserts for
  retired identities. Two tests verify unchanged legacy bindings while preserving
  active-provider stop/upsert behavior; existing adapter cleanup remains intact.
- Focused corrected-state checks passed: 11 server files/73 tests and three web
  files/nine tests. `bun fmt`, `bun lint` and `bun typecheck` passed; all 74 materially
  edited source/test files remain at most 400 lines (77 task files total).
- Corrected-state `bun run test` passed all nine tasks: 7,587 tests passed, 98
  repository-defined skips, zero failures. Per package: server 4,061 passed/94
  skipped; web 2,392; mobile 212; desktop 421/4 skipped; shared 230; contracts 177;
  scripts 94. Browser picker/settings checks passed again: two files/five tests.
- The exact corrected-state sequence was scoped `bun fmt`, `bun lint`,
  `bun typecheck`, focused server/web Vitest, `bun run test` and focused browser
  Vitest. There are no unresolved validation failures or running validation jobs.
  Follow-up independent review approved all four corrections with no blocking findings;
  Implementation/Plan green is confirmed for the repository-only scope.
  Logs use the `opencode-adoption-review-*` prefix in the same approved temporary
  directory: `fmt.log`, `lint.log`, `typecheck.log`, `server.log`, `web.log`,
  `full.log` and `browser.log` after that prefix.
