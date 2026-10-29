# Marketplace removal validation

Plan: [marketplace removal](../plans/2026-10-29-marketplace-removal-plan.md).

Base: `feature/computer-use`, `d72ac6f6615842edc7004ab837e769cbd76f9bbf`.
The working tree already contained extensive concurrent changes. No staging,
commit, push, reset, cleanup, native configuration or installed-app operation occurred.
Prior gauge changes and native OpenCode V2 plugin sources were not edited.

## Requirements review

| Status   | Requirement                                                                          | Evidence                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete | Remove marketplace UI, navigation, Git gating and update notifications               | Deleted marketplace components and sidebar Git hook; root no longer mounts update coordinator; sidebar rendering/menu tests                                                              |
| Complete | Remove catalog/installer/updater/uninstaller, startup work, assets and RPC/contracts | Registry/manifest and transport implementations deleted; runtime composition and context detached; RPC absence and ordinary HTTP fallback tests                                          |
| Complete | Preserve installed data without migrating or activating it                           | Directory initialization no longer creates plugins storage; temporary legacy registry/package regression proves byte preservation and absence from discovery                             |
| Complete | Preserve direct skill/agent discovery, capability catalog and invocation             | Discovery bigbud/native/live-refresh tests; capability dynamic tests; direct mention/skill expansion tests; shared resolution tests                                                      |
| Complete | Remove marketplace composer creation and invocation, preserve normal/orchestra flows | Shared menu no longer emits plugin items or `/plugins` (including provider echoes); normal selection tests and orchestra browser selection tests                                         |
| Complete | Keep old references readable, raw and inert                                          | Both `@plugin:` spellings retain legacy parser/serialized-node compatibility; history click tests prove no file/store navigation; server ignores tokens without catalog/path/file access |
| Complete | Handle old URLs deliberately, never as thread IDs                                    | Inert parent redirect to `/` with replace; browser memory-history tests for list/trailing-slash/detail URLs; bounded-bootstrap/restoration tests; generated route tree unchanged         |
| Complete | Sanitize saved sidebar preferences without resetting unrelated state/groups          | Existing sanitizers remove retired IDs; migrated positional boundary persists (four normally, five if Plugins was secondary); reset remains available; persistence/layout/menu tests     |
| Complete | Keep unrelated plugin mechanisms and concurrent work                                 | No edits under `provider/Layers/OpencodeV2`, native trust/setup, Lexical/build plugin modules, Electron/webview settings or gauge files                                                  |
| Complete | Independent removal-scope review                                                     | Separate reviewer found no confirmed defects or blocking findings; parent confirmed protected plugin mechanisms have no working-tree diff                                                |
| Complete | Original server typecheck blocker                                                    | Separately authorized Muse error-handling follow-up removed all six failing diagnostics; configured server typecheck now exits 0                                                         |

Independent scope review is complete. At original delivery the configured server
typecheck was blocked; the separately authorized Muse follow-up subsequently cleared
that blocker. This record preserves the original failure evidence below.
The removal has no replacement store, skill manager, Add Skill or MCP feature.
Historical reports/changelog entries were deliberately not rewritten.

## Exact focused checks

All commands ran from the repository root. No full-suite/workspace check was run.
The explicit changed-path list used below is retained at
`<qualification-root>/marketplace-changed-files.txt`.
It contains only this task's surviving edited/new paths (not concurrent gauge/provider work).

```sh
files=("${(@f)$(cat "<qualification-root>/marketplace-changed-files.txt")}")
bun run oxfmt "${files[@]}"
bun run oxfmt --check "${files[@]}"
bun run oxlint --report-unused-disable-directives "${files[@]:#*.md}"
for file in "${files[@]:#*.md}"; do
  lines=$(wc -l < "$file")
  if (( lines > 400 )); then printf 'OVER LIMIT: %s %s\n' "$lines" "$file"; exit 1; fi
done
git diff --check -- "${files[@]}"
```

Result: formatting passed; lint **0 errors, 0 warnings**; **50** source/test files
at most 400 lines; focused diff whitespace check passed.

```sh
bun run --cwd apps/web test src/components/sidebar/Sidebar.actions.logic.test.ts src/components/sidebar/Sidebar.actions.menu.test.ts src/components/sidebar/Sidebar.actionsSection.test.tsx src/stores/ui/ui.store.actions.test.ts src/stores/ui/ui.store.test.ts src/stores/ui/ui.store.remoteWorkspaces.test.ts src/components/chat/composer/composerMenuItems.test.ts src/components/chat/composer/ComposerCommandMenu.test.tsx src/logic/composer/composer.logic.test.ts src/logic/composer/editor-mentions.logic.test.ts src/components/chat/orchestra/OrchestraPlayerComposer.menu.test.ts src/components/chat/view/ChatView.composerCommandHandlers.logic.test.ts src/routes/-__root.bounded-bootstrap.route.test.ts src/routes/-__root.startup-restoration.test.ts src/components/standalone/StandalonePageContent.contract.test.ts

bun run --cwd apps/server vitest run src/orchestration/Layers/ProviderCommandReactorInputExpansion.test.ts src/server.marketplace.retired.test.ts src/provider/Layers/DiscoveryRegistry.bigbud.test.ts src/provider/Layers/DiscoveryRegistry.native.test.ts src/provider/Layers/DiscoveryRegistry.native.sources.test.ts src/provider/Layers/DiscoveryRegistry.liveRefresh.test.ts src/provider/Layers/DiscoveryRegistry.retiredMarketplace.test.ts src/capabilities/CapabilityCatalog.dynamic.test.ts src/learning/SkillMutationPolicy.test.ts src/terminal/Layers/Manager.lease.test.ts

bun run --cwd apps/web test:browser src/components/chat/messages/MessagesTimeline.userMessage.browser.tsx src/routes/-__root.startup.browser.tsx src/routes/-plugins.retired.browser.tsx src/components/chat/orchestra/OrchestraPlayerComposer.discovery.browser.tsx

bun run --cwd packages/shared vitest run src/discoveryReference.test.ts
```

Results: web **15 files / 138 tests**; server **10 files / 28 tests**; browser
**4 files / 18 tests**; shared **1 file / 5 tests** — passed.
Browser fixtures emit existing missing-RouterProvider warnings; no browser failures.
The parent session reran all four focused commands with the same **189 passing tests**.

```sh
bun run --cwd apps/web typecheck
bun run --cwd packages/contracts typecheck
bun run --cwd packages/shared typecheck
bun run --cwd apps/server typecheck
bun run --cwd apps/mobile-web typecheck
bun run --cwd apps/desktop typecheck
```

Web/contracts/shared/mobile-web/desktop: exit 0. The parent reran the original four
package checks and added mobile-web/desktop as contracts/shared consumers. At original
delivery server failed on six Effect warnings in unrelated concurrent Muse files,
with no marketplace error:

- `provider/Layers/Muse/Adapter.inspection.ts:20` — TS36, global Error in catch.
- `provider/Layers/Muse/Adapter.sendTurn.ts:115` — TS31/TS28, unknown error channel.
- `provider/Layers/Muse/Adapter.startSession.resume.ts:75` — TS36.
- `provider/Layers/Muse/Adapter.startSession.ts:161` — TS31/TS28.

The server log is in the same temporary directory as the path list,
`marketplace-server-typecheck.log`. These files were not changed to mask the failure.
An earlier web run also found concurrent terminal typing errors; they disappeared
on subsequent configured runs without edits to those files by this task.

### Subsequent blocker resolution

The user separately authorized a broader
[Muse error-handling investigation and fix](2026-10-29-muse-error-handling.md).
After that implementation, both implementer and parent reran
`bun run --cwd apps/server typecheck`: **exit 0**, with no failing diagnostics or
diagnostic suppression. Parent also reran **33 explicit Muse/affected test files,
197 tests**, all passing. These follow-up source changes are confined to Muse and do
not change the marketplace-removal behavior or data-preservation boundary.

The initial route test incorrectly used a browser-mode router in Node; moving it to
the existing browser workflow fixed the harness. The retired artwork URL follows the
existing wildcard static/dev handler, **not a new 404 tombstone**: in this fixture it
returns the ordinary missing-web 503 text. No marketplace asset resolver remains.

Generated server manifests were refreshed through the existing writer (no probes):

```sh
bun -e 'import { readParallelTestFiles, writeParallelTestFiles } from "./apps/server/scripts/serverTestGroups.manifest.ts"; const root = `${process.cwd()}/apps/server`; writeParallelTestFiles(root, readParallelTestFiles(root));'
```

Only `vitest.unit-files/src.plugins.txt` changed (deleted, all entries obsolete).

## Handoff / remaining qualification

- **Original server typecheck blocker: Resolved** by the separately authorized Muse
  follow-up; the configured check now passes.
- **Independent removal-scope review: Passed**, with no confirmed defects or blocking
  findings. This was a static source/reference review; the parent separately confirmed
  protected native/editor/webview plugin paths have no working-tree diff and reran
  focused tests, formatting, lint, length, document links and package typechecks.
- **Focused removal validation: Passed**, including the subsequently cleared server
  typecheck. This is not a full-suite or live-provider qualification claim.
- Planner, consistency, fixer and debugging delegation were attempted but blocked
  by the child-session depth limit; equivalent work was performed locally.
- Re-review any removal changes made after the independent review. The Muse follow-up
  has its own independent review and does not expand this removal's qualification.
- Live providers, packaged desktop and installed-app/native integrations were not run
  and are not claimed qualified by these unit/browser tests.
- Existing marketplace files remain on disk, inactive in bigbud discovery. No migration,
  uninstall or live provider operation was performed. Nothing was committed or pushed.
