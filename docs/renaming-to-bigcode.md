# Renaming Project: T3 Code -> bigbud

**Status**: In Progress  
**Priority**: High  
**Last Updated**: April 8, 2026

## Goal

Complete the rename from `T3 Code` to `bigbud` while preserving compatibility
for external and persisted identifiers where needed.

This document replaces the earlier broad "rename everything" plan with a
phased approach based on the current post-refactor repo structure.

## Scope

### In Scope Now

- Product name shown in the web app
- Browser tab title
- Desktop product name and desktop-visible app strings
- User-facing settings/update/provider messages
- Documentation prose that refers to the product by name
- Tests that assert user-facing `T3 Code` strings

### Explicitly Out Of Scope For The Initial Branding Pass

- Logo, favicon, and icon replacement
- Repo rename from `t3code` to `bigbud`
- Branch/worktree prefix rename from `t3code/...`
- Temp-dir/test-fixture path prefix renames unless required by user-facing tests

These are intentionally not part of the initial user-facing rename, but some of
them should be tracked as a dedicated follow-up migration phase.

## Current Source Of Truth

These are the main current entrypoints for visible branding.

### Primary Branding Entry Points

1. `apps/web/src/config/branding/branding.config.ts`
   - `APP_BASE_NAME = "T3 Code"`
2. `apps/web/index.html`
   - `<title>T3 Code (Alpha)</title>`
3. `apps/desktop/package.json`
   - `productName: "T3 Code (Alpha)"`
4. `apps/desktop/src/main.ts`
   - desktop app display name and startup error strings

### Additional User-Facing Strings Already Confirmed

#### Web

- `apps/web/src/components/settings/ProvidersSettingsSection.tsx`
- `apps/web/src/components/settings/GeneralSettingsSection.tsx`
- `apps/web/src/components/layout/desktopUpdate.logic.ts`

#### Server

- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/server/src/provider/Layers/ClaudeProvider.ts`
- `apps/server/src/provider/Layers/CopilotProvider.ts`
- `apps/server/src/provider/Layers/OpencodeProvider.ts`
- `apps/server/src/provider/Layers/OpencodeAdapter.session.ts`

#### Docs

- `README.md`
- `AGENTS.md`
- `docs/observability.md`
- `docs/constants-refactoring.md`

## Phase 4 Candidates: Compatibility Identifier Migration

These currently serve compatibility, persistence, or external-reference roles.
They should not be renamed during the initial visible-branding pass, but they are
reasonable candidates for a dedicated migration phase after Phase 1-3 land.

- `@t3tools/*` package scope
- Package name `t3`
- `T3CODE_*` env vars
- `.t3code-keybindings.json`
- localStorage keys like `t3code:client-settings:v1`
- Repo URL and clone commands using `youpele52/bigbud`
- Branch/worktree prefixes like `t3code/...`
- Test temp directories and fixture paths containing `t3code`

Why this is a separate phase:

- `@t3tools/*` and `t3` affect package identity, imports, CLI/bin naming, and
  workspace/tooling references
- `T3CODE_*` env vars are an external config API and need a migration strategy
- `t3code:*` storage keys need dual-read or migration logic to avoid losing user
  state
- `.t3code-keybindings.json` needs compatibility handling if a new filename is
  introduced

## Implementation Plan

### Phase 0: Refresh The Plan

Update this document before doing rename work so execution follows current file
paths and current compatibility constraints.

### Phase 1: Visible Branding Only

Update all user-facing `T3 Code` strings to `bigbud`.

Primary targets:

- `apps/web/src/config/branding/branding.config.ts`
- `apps/web/index.html`
- `apps/desktop/package.json`
- `apps/desktop/src/main.ts`
- current user-facing settings/update/provider messaging in web and server

Important rule:

- Change display strings, not compatibility identifiers.

### Phase 2: Documentation

Update documentation prose that refers to the product as `T3 Code`, while
leaving repo/package/env/path references alone.

Examples:

- Change: `T3 Code has one server-side observability model`
- Keep: `git clone https://github.com/youpele52/bigbud.git`
- Keep: `T3CODE_OTLP_TRACES_URL`

### Phase 3: Tests

Update tests that assert visible product-name strings.

Do not mass-rename snapshots, branch names, temp directories, or storage keys
unless those values are asserted in a user-facing context.

### Phase 4: Compatibility Identifier Migration

This phase is optional but should be treated as a real follow-up plan, not as an
accidental leftover.

Current Phase 4 targets:

- `@t3tools/*` -> `@bigbud/*`
- `t3` -> `bigbud` where safe, while keeping a compatibility bin alias
- `T3CODE_*` -> `BIGBUD_*` with dual-read support
- `t3code:*` -> `bigbud:*` with browser-storage migration behavior
- runtime docs/help text updated to prefer `bigbud` / `BIGBUD_*`

Important rule:

- Only do this with explicit migration behavior and compatibility decisions.
- Do not rename runtime keybinding files unless the real runtime path changes.

### Phase 5: Deferred Logo And Asset Work

Do not block the textual rename on visual identity work.

It is acceptable for the app to temporarily show `bigbud` in text while still
using the existing T3-branded icons/assets.

## Todo List

### Phase 0: Plan Refresh

- [x] Review current repo structure and current branding entrypoints
- [x] Identify stale paths and stale assumptions in the old rename doc
- [x] Rewrite this document as a phased, current-state plan

### Phase 1: Visible Product Branding

- [x] Update `apps/web/src/config/branding/branding.config.ts`
- [x] Update `apps/web/index.html`
- [x] Update `apps/desktop/package.json`
- [x] Update visible app-name strings in `apps/desktop/src/main.ts`
- [x] Update user-facing strings in current web settings/update components
- [x] Update user-facing provider and startup messages on the server

### Phase 2: Documentation

- [x] Update `README.md` where `T3 Code` is product prose
- [x] Update `AGENTS.md` where `T3 Code` is product prose
- [x] Update `docs/observability.md`
- [x] Update `docs/constants-refactoring.md`
- [x] Search remaining docs for user-facing `T3 Code` references

### Phase 3: Tests

- [x] Update tests asserting visible `T3 Code` strings
- [x] Re-run searches for remaining user-facing rename assertions

### Phase 4: Compatibility Identifier Migration

- [x] Migrate workspace package scope from `@t3tools/*` to `@bigbud/*`
- [x] Rename the primary server package/bin from `t3` to `bigbud`
- [x] Keep `t3` as a compatibility CLI bin alias
- [x] Add dual-read support for migrated `BIGBUD_*` / `T3CODE_*` env vars in active Phase 4 surfaces
- [x] Add migration behavior for persisted `t3code:*` browser storage keys used by the web app
- [x] Separate compatibility-migration search results from user-facing branding results
- [ ] Audit remaining `T3CODE_*` surfaces and convert docs/examples to prefer `BIGBUD_*`
- [ ] Decide whether release/update env names also need `BIGBUD_*` aliases
- [ ] Revisit browser fixture references to `.t3code-keybindings.json`
- [ ] Leave runtime keybindings filename unchanged unless the actual runtime path changes

### Validation

- [x] Search for remaining `T3 Code` in source/docs
- [ ] Manually review remaining `t3code` matches and keep intentional ones
- [ ] Run `bun fmt`
- [ ] Run `bun lint`
- [ ] Run `bun typecheck`

### Phase 5: Deferred Logo / Icons / Visual Identity

- [ ] Create or approve a master `bigbud` logo asset
- [ ] Replace web favicons and apple-touch icon
- [ ] Replace desktop app icons
- [ ] Replace marketing icons/assets
- [ ] Replace `assets/prod/*` branded icon files
- [ ] Verify icon quality on macOS, Windows, web, and touch icon surfaces

## Validation Commands

Use these searches to separate true rename work from compatibility-sensitive
identifiers that should stay unchanged.

```bash
# Visible product-name strings
rg -n "T3 Code|T3Code" apps/ packages/ docs/ README.md AGENTS.md

# Compatibility-sensitive identifiers that should usually stay unchanged
rg -n "t3code|T3CODE|@t3tools|\.t3code-keybindings\.json" apps/ packages/ docs/
```

Required checks after any rename pass:

```bash
bun fmt
bun lint
bun typecheck
```

## Phase 5 Logo Notes

Logo work is intentionally deferred, but should be tracked now so it is not
forgotten.

Current asset locations already containing T3-branded names include:

- `assets/prod/t3-black-windows.ico`
- `assets/prod/t3-black-web-favicon-16x16.png`
- `assets/prod/t3-black-web-favicon-32x32.png`
- `assets/prod/t3-black-web-favicon.ico`
- `assets/prod/t3-black-web-apple-touch-180.png`

This later phase should also review:

- `apps/web/public/*`
- `apps/desktop/resources/*`
- `apps/marketing/public/*`
- `assets/prod/*`
- optionally `assets/dev/*`

## Success Criteria

- Web app visible branding says `bigbud`
- Desktop visible branding says `bigbud`
- No user-facing `T3 Code` strings remain in the active product surface
- Compatibility-sensitive `t3*` identifiers remain unchanged unless explicitly
  migrated
- Docs reflect the phased approach and current repo structure
