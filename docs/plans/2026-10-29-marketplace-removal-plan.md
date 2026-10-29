# Marketplace removal

Status: Implemented; independent scope review passed. The original server typecheck
blocker was resolved in the separately authorized Muse error-handling follow-up.

## Goal and exclusions

Remove bigbud's user-facing Plugin marketplace without replacing it. Preserve ordinary
project, user, provider and bundled skill/agent discovery, direct mentions, capability
catalogs, normal chat and orchestra composers. Provider-internal OpenCode V2 plugins,
native trust/setup, editor/build plugins and Electron webview plugins are unrelated.

Existing marketplace state (`stateDir/plugins`, including packages, registry, catalog
and snapshots) stays on disk untouched. It is no longer read, updated, installed,
uninstalled, watched or injected into discovery. No migration or global activation.
Conversation text and saved drafts are not rewritten.

## Implementation sequence and acceptance checklist

1. Remove marketplace registry/manifest implementation and marketplace-only tests;
   detach its startup layer, directories, discovery roots/listener and provenance.
   Remove HTTP asset route, RPC handlers/context mocks and marketplace contracts.
   Preserve native and ordinary discovery descriptors, watchers and capability logic.
2. Remove marketplace pages/components/update toasts, sidebar entry and Git probing.
   Retain only inert compatibility routes for `/plugins` and `/plugins/$pluginId`,
   redirecting to `/` with replacement. Keep these paths explicitly non-thread paths
   during bootstrap and restoration; route declarations need not change shape, so no
   manual generated route-tree edit is needed.
3. Filter retired sidebar IDs through existing sanitizers without resetting other
   order/visibility/project preferences. Reduce the positional primary group from
   five to four so default Pinned/Chats/Projects stay secondary. Persist a migrated
   boundary of five if Plugins had been moved into the old secondary group, so no
   unrelated action crosses groups. Preserve relative order and positional dragging.
4. Remove installed-plugin menu items, plugin selection insertion, `/plugins` command
   recognition and menu item rendering from both composers. Keep skills and agents.
   Keep legacy serialized mention recognition solely for readable drafts/history.
   Historical plugin chips are inert, explain retirement, and never open a store/file.
   Server expansion explicitly ignores legacy plugin tokens (no activation/path read).
5. Replace obsolete coverage with focused regressions for routes/restoration, saved
   sidebar preference sanitization/default groups, legacy mentions, preserved direct
   skill/agent menus and expansion, orchestra menus, and removed server surfaces.
   Regenerate server test-group manifests using their writer, without broad probes.

## Validation and review

- Use explicit changed-path oxfmt and oxlint, and explicit authored-file line counts
  (400-line maximum). Split existing oversized materially edited files by concern.
- Run configured `typecheck` only for affected packages (contracts/shared/server/web).
- Run focused Vitest files for discovery, expansion, startup/restoration, sidebar,
  UI preferences, composer logic/menus and relevant browser history/orchestra flows.
- Inspect source references for marketplace RPC/background work and protected areas.
- No repository/workspace/full-suite check, native integration or installed-app test
  without fresh approval. Never run `bun test`. No staging, commits or pushes.
- Preserve all unrelated concurrent work, including prior gauge formatting changes.

## Plan coverage review

The sequence covers UI, runtime, wire surface, legacy navigation/reference safety,
persisted preferences and data preservation. Compatibility remains inert, not a
registry/importer. Residual risk: unit/browser tests do not qualify every live provider.
The implementer completed a local plan/requirements review because nested delegation
was unavailable. A separate parent-session reviewer subsequently found no confirmed
defects or blocking findings in the removal scope. See the
[validation record](../validation/2026-10-29-marketplace-removal.md) for checks and the
resolution of the original unrelated typecheck blocker.
