# Provider-Neutral Plugin Store Plan

**Date:** 8 August, 2026  
**Status:** Proposed  
**Owner:** bigbud team

## Summary

Add a first-class, provider-neutral plugin system to bigbud, beginning with the skills-only plugins published in OpenAI's public `openai/plugins` repository. The first release reads `.agents/plugins/api_marketplace.json`, which contained 29 compatible entries at review time, and never hardcodes that count. The catalog is the source of public availability; each plugin's `.codex-plugin/plugin.json` is the source of identity, descriptions, skills, presentation metadata, and bundled assets.

Users get a standalone `/plugins` page alongside Usage and Scheduled. It shows installed plugins and public plugins available to install, supports search and category grouping, uses bundled PNG/SVG artwork, and provides install/uninstall, store-managed update, and refresh actions. Every catalog item opens a dedicated `/plugins/$pluginId` detail page showing its description, examples, provenance, and contained capabilities such as Skills and, in later phases, Apps. The left sidebar adds **Plugins** with Lucide's `PlugIcon` immediately before **Scheduled**.

Installed plugin skills enter bigbud's existing discovery system as `provider: "bigbud"` and `source: "plugin"`, making them available to every supported provider without transferring plugin ownership to Codex. Users can explicitly select installed plugins from the composer with `@` or `/plugins`; the persisted token is `@plugin::plugin-name`. The plugin's composer artwork is reused in the composer mention, sent-message chip, and store. Provider input receives a compact plugin activation/index block and loads only the relevant bundled skill rather than injecting every skill eagerly.

Phase 1 supports only the official public skills-only catalog. Personal marketplaces, arbitrary repository installation, MCP servers, apps/connectors, hooks, browser extensions, and scheduled-task templates are deferred. Installations remain global in all planned phases. Personal marketplaces will later support both local paths and Git repositories through the same store. Once non-skill hosting exists, the same store and detail-page model expands to the complete universal marketplace; users continue to see one concept—Plugins—while each detail page explains what the package contains. No product implementation is included in this planning change.

Later phases extend that same registry with a bigbud-owned capability broker, centralized Connections and secret handling, supervised MCP runtimes, scheduled templates, sandboxed plugin UI, canonical lifecycle hooks, explicit browser capabilities, and managed enterprise policy. These remain sequenced follow-up work rather than hidden phase-1 scope.

## Related Work

- Source discussion: [Provider-neutral plugin system and store](bigbud-thread://ef5f16e7-7b23-4f57-9bba-6a56115a4793).
- Marketplace inventory: [Open-Source Codex Plugins Count](bigbud-thread://8250379b-de04-4568-999f-64f6e13ca702).
- Official repository: [openai/plugins](https://github.com/openai/plugins).
- Skills-only public catalog: [`.agents/plugins/api_marketplace.json`](https://github.com/openai/plugins/blob/main/.agents/plugins/api_marketplace.json).
- Remotion package: [`plugins/remotion`](https://github.com/openai/plugins/tree/main/plugins/remotion).
- Official plugin packaging documentation: [Package your plugin](https://developers.openai.com/plugins/build/plugins).
- Official plugin concepts: [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins).
- No repository issue ID, pull request, note, or Kanban card was identified. Create an issue ID before implementation so catalog compatibility, rollout, and follow-up non-skill support can be tracked.

## Problem

bigbud discovers provider agents and skills but has no plugin package boundary, public catalog, installation lifecycle, or presentation model. A user can manually place skills into provider-specific directories, but that requires setup, obscures provenance, duplicates installation across providers, and cannot reuse plugin metadata or artwork.

Codex and ChatGPT now use a public plugin marketplace repository whose packages can include skills, assets, MCP wiring, apps, and hooks. The repository also publishes a deliberately narrower API marketplace containing skills-only packages. Remotion is present in that catalog and its manifest provides a display name, short and long descriptions, category, brand color, prompt examples, `composerIcon`, `logo`, and `logoDark` paths. bigbud currently throws away that package-level context because its discovery model begins at `SKILL.md`.

The requested experience is:

1. Open **Plugins** from the left sidebar before **Scheduled**.
2. Browse and search the official skills-only public catalog on a standalone page.
3. See installed plugins separately from available plugins.
4. Install Remotion or another compatible plugin with one explicit action.
5. See the plugin's bundled artwork consistently in the store, composer, and sent chat message.
6. Type `@` or `/plugins`, select an installed plugin, and send an explicit plugin mention.
7. Use the same installed plugin with the fully supported Codex, Claude, Copilot, and OpenCode providers, and with future providers once they consume the same bigbud discovery contract, subject to each runtime's ordinary tools and permissions.
8. Keep working from the last valid local catalog and installed packages when GitHub is unavailable.
9. Open a full plugin detail page that explains the package and lists its contained Skills; the same page later lists Apps and other supported component types without creating a separate plugin category.
10. See update availability in the store, receive one bounded launch notification, and explicitly update only from the plugin store.

Without a bigbud-owned registry, delegating installation to Codex app-server would make behavior provider-specific, couple storage to one provider's cache, and leave non-Codex sessions unable to reason about installed packages consistently. Without immutable installation snapshots, refreshing the marketplace could silently change an installed plugin during an active or future session. Without an asset boundary, the renderer would need unsafe arbitrary filesystem paths or brittle data URLs.

## Goals

- Treat OpenAI's public `openai/plugins` repository as the sole phase-1 marketplace source.
- Read `.agents/plugins/api_marketplace.json` dynamically; do not hardcode the reviewed count of 29.
- Accept only marketplace entries whose current manifest remains skills-only and passes bigbud validation.
- Make plugin ownership and installation provider-neutral through a bigbud `PluginRegistry` service.
- Install plugins globally for the current bigbud server state so all projects and supported providers see the same enabled installation.
- Keep the catalog snapshot, immutable installed package snapshots, and registry state under a derived bigbud server-state path.
- Never silently mutate an installed package when the remote marketplace refreshes.
- Feed installed child skills into existing discovery as `provider: "bigbud"`, `source: "plugin"`.
- Add a standalone `/plugins` route using the existing standalone page shell and page-title behavior.
- Add a dedicated `/plugins/$pluginId` page with breadcrumb navigation, artwork, descriptions, example prompt treatment, source links, install/update state, and counted component sections.
- Add **Plugins** to the sidebar between Search and Scheduled using Lucide `PlugIcon`.
- Show a searchable installed section and a category-grouped public catalog with correct loading, stale, offline, empty, installing, installed, uninstalling, and error states.
- Reuse `composerIcon`, `logo`, `logoDark`, and supported image assets through a bounded same-origin HTTP asset route.
- Add `@plugin::name` as an explicit, round-trippable composer mention rendered with the plugin artwork.
- Add `/plugins` as a composer discovery command for installed plugins; it does not navigate to or substitute for the standalone store.
- Preserve the original user message and expand plugin context only in provider input, following current agent/skill behavior.
- Load only the relevant plugin skill instructions when possible; avoid injecting an entire multi-skill plugin into every tagged turn.
- Detect newer marketplace revisions without mutating installations, notify once on launch, and permit explicit updates only from the plugin store.
- Serialize install/update/uninstall/refresh mutations and recover predictably from interruption, reconnect, concurrent windows, and partial filesystem operations.
- Make third-party provenance, version, source commit, capabilities, and compatibility visible before installation.
- Meet repository size, formatting, lint, typecheck, and Vitest requirements.

## Non-Goals

- Displaying the full `.agents/plugins/marketplace.json` catalog in phase 1.
- Showing unsupported entries as disabled or “Coming soon.” Every plugin shown in phase 1 must be installable by the phase-1 host.
- Personal, local-path, and Git marketplace sources in phase 1. A later global-only marketplace phase supports both local paths and Git repositories.
- A **Personal** tab or functional **Add** menu copied from the reference screenshots.
- MCP server, `.app.json`, `.mcp.json`, connector, OAuth, hook, browser-extension, scheduled-template, or custom plugin UI hosting.
- Calling Codex app-server plugin install/list methods as bigbud's source of truth.
- Installing provider-specific copies under `~/.codex`, `~/.claude`, `~/.copilot`, or `~/.config/opencode`.
- Executing plugin scripts, hooks, npm lifecycle scripts, build steps, or dependency installers during installation.
- Guaranteeing that every installed skill can complete on every provider. Installation makes instructions available; runtime tools, executables, network access, sandbox policy, and approvals still govern execution.
- Automatically updating installed packages when the catalog refreshes or from a launch toast. Updates require an explicit action inside the plugin store.
- Project-scoped or workspace-managed installation. Plugin installation remains global. Managed enterprise policy is later-phase work; ratings, reviews, analytics, recommendations, and paid plugins remain out of scope.
- Pixel-for-pixel duplication of the ChatGPT/Codex plugin directory. The information architecture is a reference; bigbud's existing shell, typography, controls, and responsive conventions remain authoritative.
- Editing `apps/web/src/routeTree.gen.ts`; TanStack Router regenerates it.

## Current State

### Decisions Locked For Phase 1

- **Public Plugin Catalog:** `.agents/plugins/api_marketplace.json` from `https://github.com/openai/plugins`.
- **Observed catalog size:** 29 entries on 8 August 2026. This is evidence, not a constant or acceptance threshold.
- **Marketplace scope:** official public catalog only.
- **Installation scope:** global only, now and in later marketplace phases. One bigbud server-state directory is shared by all projects and providers connected to that server; project/workspace precedence will not be introduced.
- **Installed state:** installed means enabled and discoverable. Phase 1 has install and uninstall, not a separate enable switch.
- **Plugin identity:** manifest `name`, normalized to the official kebab-case form and namespaced internally by marketplace ID.
- **Explicit mention token:** `@plugin::name`; the visible label uses `interface.displayName`.
- **Composer command:** `/plugins` opens installed-plugin search. The standalone store remains `/plugins` navigation from the sidebar; the parser distinguishes a full composer command from a route.
- **Sidebar icon/order:** Lucide `PlugIcon`; New chat, Search, Plugins, Scheduled, Usage.
- **Presentation:** `composerIcon` for compact square contexts; theme-appropriate `logo`/`logoDark` where a larger brand treatment fits; `PlugIcon` is the fallback.
- **Detail-page model:** every plugin has a dedicated `/plugins/$pluginId` page. The page treats the package as one Plugin and separately enumerates contained Skills, Apps, and later supported component types with counts and descriptions.
- **Update policy:** catalog refresh detects but never applies updates. Users update only from the plugin store. Updates stage a new immutable revision and atomically switch the registry; failure keeps or restores the prior revision.
- **Launch update notification:** after the initial launch catalog check, name each plugin when one to three updates exist. When more than three exist, say “More than 3 plugins have updates.” The toast links to the store's update view and never performs the update itself.
- **Unavailable source behavior:** use the last known good catalog and installed snapshots; surface staleness without clearing data.

### Decisions Locked For Later Plugin Phases

- **Personal marketplace inputs:** both local filesystem paths and Git repositories.
- **Add trust flow:** **Add** first chooses Local folder or Git repository, resolves and validates the source, then shows the same plugin detail model with provenance, commit/ref where applicable, component counts, scripts/hooks, capability or permission changes, and warnings before the user confirms installation.
- **Personal refresh flow:** local sources expose **Refresh from folder**; Git sources expose **Check for updates**. Resulting revisions follow the same store-only update and atomic rollback rules as the public source.
- **Unified store:** after bigbud can host non-skill components, use the complete universal marketplace in the same store. Do not split “skills-only plugins” from “app plugins” in navigation or catalog language.
- **Composition disclosure:** the detail page, not the top-level product taxonomy, explains whether a plugin contains only Skills or also Apps, MCP-backed connections, hooks, browser extensions, or scheduled templates.
- **Runtime ownership:** bigbud owns plugin installation, connection state, authentication, capability authorization, process supervision, and auditing. Provider runtimes consume normalized capabilities through adapters and never become the canonical plugin manager.
- **Core runtime terms:** a **Plugin** is the installed package; a **Connection** is one authorized external-service identity; a **Runtime** is the local or remote MCP/tool service exposing capabilities. A connector is a user-facing MCP-backed connection, not a separate low-level primitive.
- **Authentication boundary:** OAuth tokens and API keys stay in the desktop OS keychain or an encrypted server-side secret store. Renderers and provider processes receive status/scopes and opaque call handles, never reusable credentials.
- **Capability broker:** one bigbud service exposes normalized tool schemas to provider adapters, authorizes every invocation, dispatches it to the owning runtime, applies approval/policy checks, and returns normalized availability or errors without fabricating support.
- **Lifecycle ownership:** remote HTTPS MCP comes before local stdio MCP. Remote connections may be safely pooled; local processes are supervised, reference-counted by active sessions, health-checked, restarted with bounded backoff, and stopped after an idle period.
- **Turn stability:** each active turn receives a pinned capability/runtime snapshot. Plugin updates or connection changes affect later turns and cannot replace schemas or executables mid-turn.
- **Connection state:** installation and authorization are independent. A plugin may be installed while showing **Connect required**, disconnected, unavailable, or policy-blocked.
- **Scheduled templates:** templates are declarative inputs to the existing Scheduled review flow. Installing a plugin never creates or starts a background task.
- **Hooks:** hooks target canonical bigbud lifecycle events and receive declared permissions, timeouts, bounded input/output, explicit failure behavior, and audit records. A hook may block only an operation bigbud actually controls.
- **Custom UI:** plugin UI runs in an origin-isolated sandboxed iframe/webview with strict CSP, no Node.js or direct filesystem access, a versioned message bridge, declared-tool access only, and scoped storage quotas.
- **Browser access:** plugins request provider-neutral bigbud browser/computer-use capabilities and domain scope. Plugin installation never silently installs or grants control to a third-party browser extension.
- **Enterprise controls:** managed policy may hide, preinstall, version-lock, disable, and audit plugins, plus constrain sources, component types, OAuth scopes, destinations, local executables, personal marketplaces, and update approval.
- **Enterprise installation scope:** installations remain global. Managed policy changes effective visibility and execution rights; it does not introduce project-scoped package copies.
- **Enterprise terminology:** **Hide** affects catalog discovery only; **Preinstall** manages package presence without authorizing user accounts; **Version lock** replaces the ambiguous term “pin”; **Disable** blocks new capability activation while retaining files; **Audit** records lifecycle/security metadata without content by default.

### Official Marketplace And Remotion Shape

- The public repository README describes plugin directories containing `.codex-plugin/plugin.json`, optional `assets/`, skills, hooks, MCP/app files, and other supporting files.
- `.agents/plugins/api_marketplace.json` provides marketplace identity, plugin `name`, local source path, installation/authentication policy, optional product filters, and category.
- Every marketplace `source.path` is relative to the repository snapshot and must remain within that snapshot after normalization and symlink resolution.
- Remotion currently resolves to `plugins/remotion` and declares a skills directory plus `assets/icon.png`, `assets/logo.png`, and `assets/logo-dark.png`.
- Remotion's manifest presentation fields include `displayName`, short/long descriptions, category, capabilities, website/privacy/terms URLs, prompt examples, brand color, and three asset paths.
- The implementation must tolerate catalog additions/removals and optional manifest presentation fields. It must not assume every plugin has all three images.

### Provider-Neutral Discovery Reuse

- `packages/contracts/src/constants/provider.constant.ts:58` already adds the pseudo-provider label `bigbud` beside runtime provider kinds.
- `apps/server/src/capabilities/CapabilityCatalog.dynamic.ts:34` makes `bigbud` discovery entries available to every selected provider.
- `packages/contracts/src/server/server.ts:129-150` already models discovery sources, including `plugin`, but lacks plugin identity/presentation metadata on discovered skills.
- `apps/server/src/provider/Layers/DiscoveryRegistry.ts:137-247` resolves descriptor roots, recursively finds skill files, parses them, merges entries, watches roots, and emits catalog changes.
- `apps/server/src/provider/Layers/DiscoveryRegistry.descriptors.ts:30` is the authoritative descriptor list but is already 389 lines. Plugin-root resolution must be injected through a focused module/service rather than appended inline.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.ts:14-139` parses compact agent/skill mentions and `/skills`, resolves provider-neutral entries, and ranks `plugin` sources. The file is already 388 lines and must be split before plugin expansion is added.
- Existing mutation policy treats plugin/system discoveries as non-user-authored. Installed bundles must remain read-only through skill editing/learning flows.

### Composer And Chat Reuse

- `apps/web/src/logic/composer/composer.logic.ts:4-30` defines path, slash, model, and skill triggers plus `/agents`, `/skill`, and `/skills`; it has no plugin trigger or `/plugins` command.
- `apps/web/src/logic/composer/editor-mentions.logic.ts:6-58` round-trips path, agent, and skill mention segments; plugin must become a fourth explicit mention kind.
- `apps/web/src/components/chat/composer/ComposerCommandMenu.tsx:1-63` owns discriminated menu item types and already renders agent/skill/path groups.
- `apps/web/src/components/chat/composer/composerMenuItems.ts:18-130` is the pure ranking/filtering boundary to extend with installed plugin items.
- ChatView and Orchestra maintain separate synthetic agent/skill menu orchestration. Both must reuse shared plugin item builders and token insertion rather than duplicating plugin-specific filtering.
- `apps/web/src/components/chat/messages/MessagesTimeline.userMessage.tsx:39-277` parses and renders sent mention chips. It is already 399 lines and must be split by concern before adding plugin metadata and artwork.
- `apps/web/src/components/chat/composer/ComposerPromptEditor.nodes.tsx:26-195` renders Lexical mention DOM. The node needs serializable plugin identity plus an artwork URL that can be re-resolved; it must not persist an absolute filesystem path.
- Existing agent/skill sent chips open their source files. A plugin chip instead opens `/plugins/$pluginId` because a package has multiple files and its composition belongs on a dedicated page.

### Standalone Page And Sidebar Reuse

- `apps/web/src/routes/_chat.usage.tsx:1-16` and `apps/web/src/routes/_chat.automations.tsx:1-16` close the right panel and host standalone nested routes.
- `apps/web/src/components/standalone/StandaloneChatPageShell.tsx:1-18` is the shell for a full-height page inside the chat/sidebar layout.
- `apps/web/src/components/usage/UsagePage.tsx:37-117` demonstrates page title, standalone header, async data, and centered responsive content.
- `apps/web/src/components/sidebar/Sidebar.actionsSection.tsx:9-120` owns New chat, Search, Scheduled, and Usage ordering, tooltips, and compact sizing.
- `apps/web/src/components/sidebar/Sidebar.tsx:46-59` supplies route navigation callbacks.
- The plugin routes should be `_chat.plugins.tsx`, `_chat.plugins.index.tsx`, and `_chat.plugins.$pluginId.tsx`, letting TanStack generate `/plugins` and `/plugins/$pluginId` consistently with Usage and Scheduled.

### Persistence, RPC, Query, And Asset Reuse

- `apps/server/src/startup/config.ts:65-101` derives state paths centrally. Plugin paths belong in `ServerDerivedPaths`, not ad hoc home-directory calculations.
- `apps/server/src/ws/serverSettings.ts:115-203` demonstrates serialized mutation, temporary-file writes, atomic rename, cached state, PubSub, and external change handling.
- `packages/contracts/src/server/rpc.automation.ts` and `apps/server/src/ws/wsRpcHandlers.automation.ts` demonstrate focused Effect RPC contracts and handlers.
- `packages/contracts/src/server/server.ts` is already 417 lines. New plugin schemas belong in `packages/contracts/src/server/plugins.ts` and RPC definitions in `rpc.plugins.ts`, exposed by the existing `./server/*` subpath pattern.
- `apps/server/src/ws/ws.ts:17-31` composes focused handler groups, and `apps/server/src/server.ts:324-333` composes HTTP route layers.
- `apps/web/src/lib/providerReactQuery.ts` demonstrates typed query keys/options over `ensureNativeApi`; plugin catalog queries and mutations should use an analogous focused module.
- `apps/server/src/ws/http.ts:34-83` and `http.fileResponse.ts:67` demonstrate bounded same-origin file responses. Plugin assets need their own registry-backed route rather than workspace preview parameters or arbitrary paths.

### File-Length Constraints That Affect The Design

- `ProviderCommandReactorInputExpansion.ts`: 388 lines.
- `DiscoveryRegistry.descriptors.ts`: 389 lines.
- `MessagesTimeline.userMessage.tsx`: 399 lines.
- `OrchestraPlayerComposer.logic.ts`: 378 lines.
- `packages/contracts/src/server/server.ts`: 417 lines, already over the normal limit.
- The implementation must extract by concern with dot-notation files while touching these areas. This is required maintenance work, not a license for unrelated refactoring.

## Phases

### Phase 0: Freeze Compatibility, Fixtures, And Domain Contracts

**Goal:** Establish a tested, provider-neutral interpretation of the official skills-only marketplace before any install mutation or UI depends on it.

1. Create an issue ID and record this plan, the reviewed OpenAI repository URL, the catalog path, and the initial reviewed commit SHA. Do not pin implementation behavior to a mutable `main` response without recording the resolved commit.
2. Add versioned test fixtures copied from a reviewed commit for:
   - the skills-only marketplace with Remotion and at least one additional category;
   - the Remotion manifest and asset path declarations;
   - a minimal valid skills-only plugin;
   - malformed JSON, missing manifest, invalid name/version, missing skills root, absolute paths, `..` traversal, symlink escape, duplicate plugin IDs, duplicate skill names, unsupported component fields, missing assets, and mismatched marketplace/manifest names.
3. Define canonical domain terms in contract documentation:
   - **Marketplace Source:** a catalog origin. Phase 1 has exactly `openai-public`.
   - **Catalog Snapshot:** one validated marketplace view resolved to a Git commit.
   - **Plugin Package:** one manifest-rooted directory in a snapshot.
   - **Plugin Installation:** a registry entry pointing to an immutable copied package revision.
   - **Plugin Presentation:** validated display text, URLs, brand color, prompt examples, and bounded asset keys.
   - **Plugin Component:** a typed contained capability such as a Skill or App, represented separately while remaining part of one Plugin.
   - **Plugin Skill:** a discovered `SKILL.md` associated with one installed plugin.
4. Add focused Effect schemas in `packages/contracts/src/server/plugins.ts` for marketplace-qualified IDs, presentation metadata, typed/countable component summaries, catalog summaries/details, installation and update summaries, compatibility, sync state, and normalized typed errors.
5. Use stable external identity `<marketplaceId>:<pluginName>` even though phase 1 has one marketplace. Do not rely on display name, array position, or source path as identity.
6. Extend `ServerDiscoveredSkill` with optional plugin provenance sufficient for collision handling and presentation, for example `pluginId`, while preserving decode compatibility for existing discovery payloads.
7. Define compatibility as a closed result rather than a boolean:
   - `compatible`;
   - `invalid` with safe reasons;
   - `unsupported-components` with the declared component kinds.
     Only `compatible` entries are returned as available in phase 1.
8. Validate that a phase-1 package declares at least one skills root and does not declare apps, MCP servers, hooks, browser extensions, or scheduled-task templates. Repeat this validation at install time even though the API marketplace is intended to be skills-only; catalog drift must fail closed.
9. Decide asset allowlists in code, initially PNG, JPEG, WebP, and SVG with validated MIME/extension agreement and bounded file size. SVG must be served as an image resource and never injected with `innerHTML`.
10. Add an ADR only if implementation review selects a materially different ownership model. The current decision—bigbud owns registry state while consuming a Codex-compatible public format—is explicit in this plan and does not require a separate ADR yet.

**Likely files:**

- `packages/contracts/src/server/plugins.ts` (new)
- `packages/contracts/src/server/rpc.plugins.ts` (new in Phase 2, schemas may be stubbed here)
- `packages/contracts/src/server/server.ts`
- `apps/server/src/plugins/PluginManifest.ts` (new)
- `apps/server/src/plugins/PluginManifest.test.ts` (new)
- `apps/server/src/plugins/__fixtures__/...` (new)

**Exit criteria:** The reviewed marketplace and Remotion fixture decode; all unsafe or unsupported fixture shapes fail with deterministic safe reasons; existing discovery payloads remain decodable.

### Phase 1: Build The Read-Only Marketplace Snapshot Service

**Dependency:** Phase 0 contracts and validation rules are stable.

**Goal:** Reliably expose the official public catalog and its presentation assets without installing anything.

1. Extend `ServerDerivedPaths` with a plugin state root under `stateDir`, including marketplace snapshots, immutable package cache, registry file, staging, and quarantine/cache-garbage paths. Ensure them in `ensureServerDirectories`.
2. Add `PluginRegistry` and `PluginRegistryLive` under `apps/server/src/plugins/Services` and `Layers`, matching the repository's Effect service naming.
3. Split implementation by concern, keeping non-test TypeScript files at or below 400 lines, for example:
   - `PluginRegistry.ts` for orchestration and public operations;
   - `PluginRegistry.catalog.ts` for catalog decode/normalization;
   - `PluginRegistry.sync.ts` for Git snapshot refresh;
   - `PluginRegistry.paths.ts` for derived contained paths;
   - `PluginRegistry.persistence.ts` for atomic metadata;
   - `PluginRegistry.assets.ts` for validated asset keys;
   - `PluginRegistry.errors.ts` for typed internal errors.
4. Sync from the fixed HTTPS Git repository `https://github.com/openai/plugins.git`. Use a shallow, blob-filtered sparse checkout that includes `.agents/plugins/api_marketplace.json` and the referenced plugin directories. Never accept a repository URL from renderer input in phase 1.
5. Resolve `main` to a commit SHA, stage the checkout in a unique directory, decode and validate the complete catalog, then atomically publish the snapshot. Do not expose a partially fetched checkout.
6. Serialize refresh with one semaphore. Coalesce concurrent manual/startup refresh requests rather than launching duplicate Git operations.
7. Keep startup non-blocking when a valid local snapshot exists. Return it immediately and refresh in the background only when stale. If no snapshot exists, expose a loading state while attempting the first sync.
8. Define freshness metadata: resolved commit, successful sync timestamp, last attempted timestamp, safe last failure category, and `fresh | stale | unavailable` state. Do not persist raw Git stderr that may contain credentials or machine paths.
9. On refresh failure, preserve the prior valid snapshot and its assets. Never replace the catalog with an empty list merely because GitHub, DNS, TLS, Git, disk, or validation failed.
10. A manual refresh button requests refresh and remains cancel-safe at the RPC/client boundary. Client disconnect does not corrupt the server operation; another client can observe the eventual snapshot.
11. Normalize marketplace and manifest metadata into bounded contract objects. Enforce limits on entry count, strings, arrays, total manifest size, number/size of assets, skill count, and directory traversal work.
12. Exclude incompatible entries from `available` while returning aggregate compatibility diagnostics for logs/tests. The phase-1 page must not show an Install button for a package that failed current validation.
13. Preserve the snapshot commit in every catalog item so later installation can copy exactly what the user viewed.
14. Add observability for sync duration, resolved commit, valid/invalid entry counts, and safe failure categories without logging skill bodies or asset bytes.

**Likely files:**

- `apps/server/src/startup/config.ts`
- `apps/server/src/plugins/Services/PluginRegistry.ts` (new)
- `apps/server/src/plugins/Layers/PluginRegistry.ts` (new)
- focused `PluginRegistry.*.ts` modules and tests (new)
- `apps/server/src/server.ts`

**Failure and recovery behavior:** An interrupted staging checkout is ignored on restart and later garbage-collected. A published snapshot is immutable. The last valid snapshot remains readable across restart. A missing Git executable becomes an actionable unavailable state on first run and a stale warning when cache exists.

**Exit criteria:** A fresh server can populate the official skills-only catalog; an offline server can return its last valid snapshot; corrupted or partial refreshes cannot replace it.

### Phase 2: Add RPC, Asset Delivery, And Installation Lifecycle

**Dependency:** A validated immutable catalog snapshot exists.

**Goal:** Let clients inspect, refresh, install, update, and uninstall skills-only packages safely.

1. Add focused RPC definitions and methods:
   - `plugins.listCatalog` returning catalog items, installed state, sync state, and revision;
   - `plugins.get` returning full normalized detail for one qualified ID;
   - `plugins.refreshCatalog` returning the resulting revision/sync state;
   - `plugins.install` requiring qualified ID plus the catalog commit the user viewed;
   - `plugins.update` requiring qualified ID, current installed revision, and the target catalog commit reviewed in the store;
   - `plugins.uninstall` requiring qualified ID plus the installed revision for stale-write protection.
2. Add typed safe errors: unavailable source, stale catalog revision, not found, incompatible, invalid package, already installed, not installed, conflicting mutation, insufficient disk, and internal failure. Never return raw command output or filesystem paths.
3. Reject installation when the requested catalog revision no longer matches the active item. Return a stale-catalog error and make the UI refresh/reconfirm instead of silently installing different bytes.
4. During install, copy the complete plugin directory from the validated immutable marketplace snapshot into a unique staging directory. Include skills, references, rules, scripts, and assets; execute none of them.
5. Revalidate the staged manifest, skills roots, real paths, symlinks, file types, file count, individual/total sizes, and unsupported components. Reject sockets, devices, FIFOs, escaping links, and paths outside the package root.
6. Publish the immutable package directory atomically, then atomically update `registry.json`. If registry publication fails, leave the package as unreferenced cache; no half-installed registry state is visible.
7. Serialize refresh/install/update/uninstall with a registry mutation semaphore or an explicit lock ordering that prevents deadlocks. Reads use one coherent in-memory snapshot.
8. Treat identical repeated install/update/uninstall requests idempotently when revision/precondition permits. Conflicting revisions return a typed stale/conflict result.
9. On uninstall, atomically remove the registry reference and emit state/discovery changes. Keep the immutable package cache long enough for an already-running provider turn that received a skill path to finish; garbage-collect only unreferenced revisions after a safe age/restart boundary.
10. If a catalog refresh removes an installed plugin, keep the installation usable and label it `installed-unavailable` in the store. Uninstall still works.
11. Detect update availability by comparing the immutable installed revision/version with the validated current catalog target. Catalog refresh changes only this availability metadata.
12. The update operation copies and revalidates the target into a new immutable directory, computes a bounded presentation/component/capability diff, and atomically switches the registry pointer only after validation. A failed pre-switch update leaves the old revision active; a failed post-switch health/discovery check automatically restores the old pointer.
13. Keep at least the immediately previous revision through a safe rollback window. Phase 1 has automatic failure rollback but no separate user-facing downgrade browser.
14. Expose update-diff data to the detail page. If scripts, executable files, capabilities, or component declarations change, require explicit confirmation inside the store before calling `plugins.update`. An update that introduces unsupported components is blocked rather than partially applied.
15. Add a bounded registry-backed asset route, for example `/api/plugin-assets/:scope/:revision/:pluginId/:assetKey`, where `assetKey` is one of normalized presentation keys rather than an arbitrary relative path.
16. Resolve every asset through `PluginRegistry`, recheck containment and file type, serve with `nosniff`, correct MIME, and immutable cache headers keyed by snapshot/revision. Return the Lucide fallback in the client for missing/invalid assets rather than allowing arbitrary fallback file reads.
17. Require the existing server auth boundary for asset requests in remote deployments. If normal `<img>` requests cannot attach the WebSocket token safely, mint short-lived opaque asset URLs or route through the existing authenticated HTTP strategy; do not put filesystem paths or durable secrets in URLs.
18. Add `makeWsRpcPluginHandlers(context)`, `PluginRegistry` to `WsRpcContext`, the RPC group to `WsRpcGroup`, the live service to the runtime layer, and the plugin asset route before the static wildcard route.
19. Use a dedicated plugin change subscription or lightweight revision event so multiple windows invalidate plugin React Query data. Do not place the full catalog in `ServerConfig` or its bootstrap stream.

**Likely files:**

- `packages/contracts/src/server/plugins.ts`
- `packages/contracts/src/server/rpc.plugins.ts`
- `packages/contracts/src/server/rpc.ts`
- `packages/contracts/src/server/wsMethods.ts` or the current method-constant home
- `apps/server/src/ws/wsRpcContext.ts`
- `apps/server/src/ws/wsRpcHandlers.plugins.ts` (new)
- `apps/server/src/ws/http.plugins.ts` (new)
- `apps/server/src/ws/http.ts`
- `apps/server/src/ws/ws.ts`
- `apps/server/src/server.ts`
- `apps/server/src/plugins/Layers/PluginRegistry*.ts`

**Exit criteria:** Install/update/uninstall is atomic and reconnect-safe; stale clicks cannot install unseen content; failed updates retain or restore the prior revision; assets render through bounded same-origin URLs; multiple clients converge on the same registry revision.

### Phase 3: Integrate Installed Skills With Discovery And Provider Input

**Dependency:** Installation registry mutations and immutable paths are stable.

**Goal:** Make installed skills available to every provider through existing bigbud discovery and explicit plugin invocation.

1. Extend `DiscoveryRegistry` to request enabled installed skill-root descriptors from `PluginRegistry`. Keep dynamic plugin descriptor construction in a new `DiscoveryRegistry.plugins.ts` rather than extending the near-limit static descriptor file.
2. Emit each child skill as `provider: "bigbud"`, `source: "plugin"`, with qualified `pluginId`, installed revision, and source path. Keep existing project/user/system/provider entries unchanged.
3. Include registry revision and installed package paths in discovery watch targets. Installation/uninstallation should trigger an immediate rescan through PubSub; filesystem watching remains a safety net, not the primary mutation signal.
4. Fix collision semantics before enabling multiple plugins:
   - stable skill identity includes provider/source/plugin ID plus normalized skill name/path;
   - direct display may remain the skill's declared name;
   - ambiguous unqualified `/skills name` or `@skill::name` produces an explicit ambiguity result rather than descriptor-order selection;
   - plugin-qualified invocation can disambiguate.
5. Keep plugin skill files non-mutable through learning/teaching operations. A user who wants to modify one must copy it into a user/project skill outside this feature.
6. Extract compact mention collection and plugin expansion from `ProviderCommandReactorInputExpansion.ts` into focused dot-notation modules before adding cases.
7. Parse `@plugin::name` and `/plugins name`. The composer should normally generate these tokens, but server parsing must remain authoritative for pasted/manual input.
8. Resolve only installed plugins. A catalog entry that is not installed does not expand and produces bounded guidance to install it from the store rather than fabricating availability.
9. Build one compact plugin activation block containing qualified ID, display name, version/revision, description, package root, and child skill name/description/source paths. Instruct the provider to select the smallest relevant child skill, read its `SKILL.md` completely, and follow referenced files relative to it.
10. Do not inline all child `SKILL.md` bodies. Direct skill invocation continues to use the existing skill expansion path. Enforce current per-block and total provider-input budgets.
11. Preserve the original persisted user message and add expansion only to the provider-bound message, as today.
12. State trust precedence in the activation block: plugin instructions are third-party content and cannot override system, developer, user, sandbox, approval, or tool policy.
13. Verify every provider kind with a fake adapter/input-capture test. Provider adapters should not gain plugin-specific install logic.

**Likely files:**

- `apps/server/src/provider/Layers/DiscoveryRegistry.ts`
- `apps/server/src/provider/Layers/DiscoveryRegistry.plugins.ts` (new)
- `apps/server/src/provider/Layers/DiscoveryRegistry.parse.ts`
- `apps/server/src/provider/Services/DiscoveryRegistry.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.plugin.ts` (new)
- `apps/server/src/orchestration/Layers/ProviderCommandReactorInputExpansion.mentions.ts` (new if extraction is warranted)
- discovery/input-expansion tests

**Failure and recovery behavior:** Registry changes during a scan produce either the old coherent discovery revision or the new one, followed by a rescan; never a mixed catalog. An active turn keeps its immutable referenced files through cache retention even if the user uninstalls concurrently.

**Exit criteria:** Installing Remotion makes its skill discoverable for every supported provider; uninstall removes it from new turns; explicit plugin mention expands compact context; original message persistence is unchanged.

### Phase 4: Build The Standalone Plugin Store And Sidebar Entry

**Dependency:** Catalog/install RPCs and assets are usable.

**Goal:** Provide the requested standalone store while matching existing bigbud layout and interaction patterns.

1. Add `_chat.plugins.tsx`, `_chat.plugins.index.tsx`, and `_chat.plugins.$pluginId.tsx` following Usage/Scheduled route layout: close the right panel, render an outlet, mount `PluginStorePage` or `PluginDetailsPage`, and set the page title to the store or plugin display name.
2. Use `StandaloneChatPageShell` and `StandaloneChatPageHeader`. Add refresh as a compact header action with an accessible label and progress/disabled state.
3. Add `PlugIcon` to `SidebarActionsSection` immediately before the Scheduled row. Extend callback props, parent navigation, mobile close behavior, tooltip, ARIA label, and sidebar tests.
4. Keep phase-1 navigation order exactly: New chat, Search, Plugins, Scheduled, Usage.
5. Build `apps/web/src/components/plugins/` by concern:
   - `PluginStorePage.tsx` for page composition;
   - `PluginStoreHeader.tsx` if header/search actions exceed a focused page size;
   - `InstalledPluginStrip.tsx`;
   - `PluginCatalogSection.tsx`;
   - `PluginCatalogItem.tsx`;
   - `PluginDetailsPage.tsx`;
   - `PluginComponentSection.tsx` for counted Skills now and Apps/other component types later;
   - `PluginUpdateDiff.tsx` for store-only update review;
   - `PluginUpdateToastWatcher.tsx` for one launch-scoped notification;
   - `PluginArtwork.tsx` for theme/fallback behavior;
   - `PluginStore.states.tsx` for loading/error/empty states;
   - pure filter/group/sort logic and tests.
6. Add `apps/web/src/lib/pluginReactQuery.ts` with query keys for catalog/detail and mutation options for refresh/install/update/uninstall. Invalidate from mutation success and plugin revision subscription. Use deduped React Query requests rather than component-local duplicate fetches.
7. Render an **Installed** section first, using compact square `composerIcon` artwork, display name tooltip, deterministic marketplace order, and an empty explanation when none are installed.
8. Render one official public catalog; do not show Public/Personal tabs or Add. Group by the catalog/manifest category, sort groups and entries deterministically, and use a responsive one-column/two-column list matching bigbud's 14px default typography.
9. Search client-side over display name, manifest name, short/long descriptions, developer, category, and keywords. Preserve the search term during install/update/uninstall/refetch. Provide a clear button and accessible result count/status.
10. A catalog row shows compact artwork, display name, short description, and Install/Installed/Update available state. Clicking the row or name navigates to `/plugins/$pluginId`. Avoid overstated capability copy; use manifest text verbatim only within normal copyright limits or normalized short descriptions from the package.
11. Build the detail page from the attached reference while retaining bigbud's shell and typography:

- breadcrumb/header `Plugins › Display name` and a source/website link action;
- primary artwork, display name, short description, and Install, Installed, Update, or Uninstall management state;
- a branded example-prompt panel sourced from `defaultPrompt`; when the plugin is installed, its arrow starts a new chat with `@plugin::name` plus the example prefilled for review and never auto-sends; when uninstalled, the action explains that installation is required;
- long description, developer, version, category, capabilities, source commit/repository, website/privacy/terms links, and compatibility state;
- separate counted component sections such as **Skills 5** and, in later phases, **Apps 1**;
- component rows with their own icon/fallback, display name, and description.

12. In phase 1 every detail page normally shows a Skills section and may label its composition “Skills only.” Keep the component contract and page generic so the later universal catalog adds Apps and other types without a second store, route family, or top-level plugin taxonomy.
13. Installation requires an explicit user action in details or the row. Show source and package contents before confirming when the plugin contains scripts or executable files, even though installation executes none.
14. Update is available only in the store list/detail page. Before updating, show old/new version and commit plus component, capability, script/executable, and presentation changes. Never put an Update action in the launch toast, composer, chat chip, or settings.
15. Uninstall requires confirmation naming the plugin and explaining that new conversations lose its skills while active work may finish. Do not imply that project files created by a plugin are deleted.
16. Represent network/sync states independently from local install states:

- no local catalog + sync pending;
- no local catalog + sync failed with Retry;
- stale cached catalog with warning and usable entries;
- refresh running while current catalog remains usable;
- per-plugin install/update/uninstall progress;
- mutation failure preserving previous stable state.

17. Mount one launch-scoped update watcher after server state and the first catalog check are ready:

- one update: “Remotion has an update.”;
- two or three: name all affected plugins in one toast;
- more than three: “More than 3 plugins have updates.”;
- every variant says or links “Visit Plugin Store to update” and navigates to `/plugins?filter=updates`;
- emit at most once per app launch for the resolved update set, never once per renderer/reconnect/refetch.

18. Prevent duplicate per-plugin mutation clicks across rows/details using mutation keys and server serialization. Keep unrelated plugins usable during one plugin mutation when safe.
19. Make keyboard navigation, focus return, visible focus, tooltip labels, page/breadcrumb semantics, reduced motion, alt text, and color contrast part of acceptance—not follow-up polish.
20. Regenerate the route tree via the normal TanStack/Vite process; never edit `routeTree.gen.ts` manually.

**Likely files:**

- `apps/web/src/routes/_chat.plugins.tsx` (new)
- `apps/web/src/routes/_chat.plugins.index.tsx` (new)
- `apps/web/src/routes/_chat.plugins.$pluginId.tsx` (new)
- `apps/web/src/components/plugins/*` (new)
- `apps/web/src/lib/pluginReactQuery.ts` (new)
- `apps/web/src/components/sidebar/Sidebar.actionsSection.tsx`
- `apps/web/src/components/sidebar/Sidebar.tsx`
- `apps/web/src/components/sidebar/Sidebar.actionsSection.test.tsx`

**Exit criteria:** The standalone store and nested detail pages work, the sidebar order/icon are correct, users can search/install/update/uninstall Remotion only through the store, component composition is explicit, the launch notification follows the bounded count rules, artwork is theme-correct, and offline/stale states remain usable and honest.

### Phase 5: Add Composer Selection And Branded Chat Mentions

**Dependency:** Installed-plugin query data and provider expansion are stable.

**Goal:** Let users explicitly invoke installed plugins from normal and Orchestra composers and see the same identity after sending.

1. Add `plugin` to shared composer trigger, menu item, discovery-search, segment, Lexical serialized node, and mention-kind unions. Centralize the union/type if repeated edits reveal an existing duplication seam.
2. Add `plugins` to slash-command detection. `/plugins` opens a searchable installed-plugin menu; `/plugins query` prefilters it. If none are installed, show “No plugins installed” with an action/link to `/plugins` rather than catalog entries in the composer.
3. Include installed plugins in the `@` menu alongside agents and paths. Rank an exact plugin display/name match before partial matches, then installed plugin items, agents, and paths using deterministic local rules. Do not list uninstalled catalog entries under `@`.
4. Add a plugin `ComposerCommandItem` containing the normalized contract summary, display label, description, and resolved composer asset URL.
5. Selecting a plugin inserts a non-editable mention node whose text serializes to `@plugin::manifest-name`, whose label is `interface.displayName`, and whose artwork URL is derived from current installed metadata.
6. Do not serialize base64 image bytes or absolute local paths into the Lexical draft. On restore, re-resolve artwork by qualified plugin ID; use `PlugIcon` if metadata is unavailable.
7. Extract a shared plugin menu builder/selection helper so ChatView and Orchestra reuse filtering, insertion, keyboard behavior, and `/plugins` synthetic search.
8. Keep `$` as skill discovery. Plugin installation does not hide its individual skills from `/skills`/`$`; users can invoke either the package or a specific workflow.
9. Split `MessagesTimeline.userMessage.tsx` before adding plugin behavior. Move mention parsing/lookup and chip rendering into focused dot-notation files.
10. Render sent `@plugin::name` mentions with the installed/cached composer icon and display name. If uninstalled later, retain the raw token and a stable fallback label/icon; old messages must remain readable.
11. Clicking a plugin mention navigates to `/plugins/$pluginId`, whether currently installed or only present in the cached catalog. If absent from both, the chip remains non-destructive and explains that metadata is unavailable.
12. Add image `alt=""` for decorative icons and retain a text label so the mention is readable without artwork.
13. Ensure copy/paste, plain-text serialization, draft persistence, cursor movement, deletion, undo/redo, theme change, and legacy mention nodes remain stable.

**Likely files:**

- `apps/web/src/logic/composer/composer.logic.ts`
- `apps/web/src/logic/composer/editor-mentions.logic.ts`
- `apps/web/src/components/chat/composer/ComposerCommandMenu.tsx`
- `apps/web/src/components/chat/composer/composerMenuItems.ts`
- `apps/web/src/components/chat/composer/ComposerPromptEditor.nodes.tsx`
- `apps/web/src/components/chat/composer/ComposerPromptEditor.nodes.helpers.prompt.ts`
- `apps/web/src/components/chat/view/ChatView.composerCommandHandlers.*`
- `apps/web/src/components/chat/view/ChatViewComposer.syntheticMenu.ts`
- `apps/web/src/components/chat/orchestra/OrchestraPlayerComposer.logic.ts`
- `apps/web/src/components/chat/orchestra/OrchestraPlayerComposer.menu.ts`
- `apps/web/src/components/chat/messages/MessagesTimeline.userMessage.tsx`
- new focused message mention modules and tests

**Exit criteria:** `@` and `/plugins` find only installed plugins in ChatView and Orchestra; selection persists as `@plugin::name`; composer and sent message use the same plugin artwork; server expansion resolves the same qualified installation.

### Phase 6: Harden, Roll Out, And Document Follow-Up Boundaries

**Dependency:** End-to-end catalog, installation, discovery, store, and invocation work in focused tests.

**Goal:** Ship predictably without turning phase 1 into an implicit general-purpose package manager.

1. Add a server rollout setting for the public plugin store only if staged release/rollback requires it. Default-on is acceptable after fixture, security, offline, and migration tests pass because no existing installation behavior is replaced.
2. On startup, decode registry/catalog metadata defensively. Quarantine invalid metadata, retain immutable packages, and expose a repairable safe error rather than crashing the server.
3. Define bounded garbage collection for abandoned staging directories, invalid snapshots, and unreferenced immutable packages. Never delete the active catalog snapshot, installed revision, or packages inside a safety retention window.
4. Add disk-space and write-permission errors before/through copy, clean only the operation's own staging path, and preserve prior state.
5. Test rapid refresh/install/update/uninstall, two clients mutating the same plugin, server termination between copy/rename/registry publication, update pointer rollback, source removal, manifest/component change, asset removal, live discovery rescan, active turn plus uninstall/update, and reconnect during mutation.
6. Document that plugin skills are third-party instructions, bundled scripts are not run at install time, and later execution remains subject to provider tools, bigbud permissions, sandboxing, approvals, and user intent.
7. Document Remotion runtime expectations accurately: its skill may require Node/npm/npx, browser/rendering support, FFmpeg or other tools, network access, and project writes. Plugin installation alone does not install those runtimes.
8. Add release notes describing the official public skills-only scope, global installation, provider neutrality, detailed composition pages, store-only updates and launch notices, sidebar/store usage, `@` invocation, `/plugins`, offline catalog behavior, and deferred non-skill plugins.
9. Create follow-up issue IDs separately for:
   - global personal marketplaces with both Local folder and Git repository **Add** flows using the resolved trust/refresh model;
   - MCP/app/connector authentication and lifecycle;
   - hooks/browser extensions/scheduled templates;
   - switching the same store/detail model to the complete universal marketplace after compatibility hosting exists.
10. Do not claim “supports every Codex plugin” in UI or release copy until all declared component kinds are hosted. Phase-1 copy is “Official skills-only plugins.” Once that hosting exists, retain the single user-facing **Plugins** term and explain composition on each detail page.

**Exit criteria:** Recovery and concurrency tests pass, scope is accurately documented, rollout has a bounded rollback path, and follow-up capabilities are not silently implied.

### Phase 7: Add The Provider-Neutral Capability Broker And Connections

**Dependency:** The phase-1 registry and immutable revision model are stable, and a separate issue ID has approved non-skill runtime hosting.

**Goal:** Host remote MCP-backed plugins without giving any provider ownership of plugin lifecycle, credentials, or policy.

1. Extend the plugin component contract with normalized Tool, Runtime, Connection requirement, authentication, scope, and health metadata. Keep upstream-specific manifest fields in source metadata rather than leaking them into provider adapters.
2. Add a server-owned `PluginCapabilityBroker` that:
   - publishes normalized, versioned tool schemas;
   - resolves each tool to its installed plugin revision and runtime;
   - checks installation, connection, consent, enterprise policy, and provider availability before every invocation;
   - delegates execution through opaque runtime handles;
   - normalizes unavailable, denied, timed-out, disconnected, and runtime-failure results;
   - records bounded audit metadata without prompt, argument, result, token, or secret content by default.
3. Add a `PluginConnectionService` separating package installation from account authorization. Model at least `connect-required`, `authorizing`, `connected`, `expired`, `disconnected`, `unavailable`, and `policy-blocked` states.
4. Keep OAuth refresh tokens and API keys outside renderer and provider processes. Prefer the desktop OS keychain for desktop-owned credentials and an encrypted server secret store for headless/server deployments; expose only connection IDs, scopes, expiry/status, and opaque call handles.
5. Implement remote HTTPS MCP first. Validate origins, TLS, redirects, declared scopes, endpoint changes, timeouts, response limits, and reconnect/backoff behavior. Pool only connections whose protocol and account-isolation rules make pooling safe.
6. Pin a capability/runtime schema snapshot at turn start. Connection or plugin changes invalidate future snapshots but never replace a tool schema or destination during an active turn.
7. Adapt Codex, Claude, Copilot, and OpenCode through thin provider mappings that consume the broker's normalized catalog. Providers may decline unsupported schemas, but may not own connection state or bypass broker authorization.
8. Show install state and connection state independently on the plugin detail page. **Install plugin** never grants external-account access; **Connect** presents requested scopes and account/destination information.
9. Add local stdio MCP only after remote MCP is reliable. Supervise each process with an explicit executable allowlist, sanitized environment, working-directory policy, resource bounds, reference counts, health checks, bounded restart backoff, idle shutdown, and revision-pinned executable/configuration.
10. Do not pass credentials through process arguments, logs, provider prompts, environment inherited from bigbud, or renderer IPC payloads. Redact known secret shapes and treat raw runtime stderr as sensitive.

**Likely files:**

- `packages/contracts/src/plugins/plugins.ts` plus focused runtime/connection contract modules if the existing file approaches the limit
- `apps/server/src/plugins/Layers/PluginCapabilityBroker.ts`
- `apps/server/src/plugins/Layers/PluginConnectionService.ts`
- `apps/server/src/plugins/Layers/PluginRuntimeSupervisor.ts`
- `apps/server/src/plugins/PluginRuntime.remoteMcp.ts`
- `apps/server/src/plugins/PluginRuntime.stdioMcp.ts` in the later stdio slice
- provider adapter capability-mapping modules under `apps/server/src/provider/`
- desktop secret/keychain IPC modules, reusing an existing secret abstraction if discovery finds one
- plugin detail connection components under `apps/web/src/components/plugins/`

**Exit criteria:** A remote MCP plugin can be installed globally, connected once through bigbud, invoked through each capable provider, disconnected centrally, audited without content leakage, and kept schema-stable throughout an active turn. Local stdio remains gated until its separate supervision tests pass.

### Phase 8: Add Scheduled Templates, Then Sandboxed Custom UI

**Dependency:** The capability broker can authorize declared tool calls independently of any provider.

**Goal:** Add provider-neutral non-chat experiences while retaining bigbud's existing review and security boundaries.

1. Define scheduled templates as declarative initial values for the existing Scheduled creation flow: title, prompt, plugin references, suggested cadence, required connections/capabilities, and optional parameter schema.
2. Selecting a template opens the existing Scheduled editor with values prefilled. The user must review destination, cadence, permissions, connections, and prompt before saving. Install, update, or connect never creates, enables, or runs a schedule.
3. Store the chosen plugin revision/range and revalidate capabilities when a schedule is saved and before every run. Disabled, disconnected, incompatible, or policy-blocked plugins pause or fail visibly rather than silently changing behavior.
4. Add custom UI only after scheduled templates ship. Host plugin surfaces in an origin-isolated sandboxed iframe/webview with strict CSP, no Node integration, no direct filesystem/network privilege, and no unsandboxed app-shell component injection.
5. Expose a small versioned message bridge for declared tool calls, connection-status reads, scoped key/value storage, theme/locale, sizing, and navigation to first-party plugin/store pages. Every privileged call still traverses the capability broker.
6. Enforce per-plugin storage quotas, payload/rate limits, origin validation, teardown on revision change/disable, and visible attribution. Treat bridge expansion as a reviewed public API.
7. Detail pages enumerate **Scheduled templates** and **UI surfaces** alongside Skills, Apps, and Connections without changing the top-level Plugin taxonomy.

**Likely files:**

- focused plugin component contracts under `packages/contracts/src/plugins/`
- existing Scheduled creation/editor modules in `apps/web` and scheduling services in `apps/server`, extended through adapters rather than duplicated
- `apps/server/src/plugins/Layers/PluginUiBridgeService.ts`
- `apps/web/src/components/plugins/PluginUiSandbox.tsx`
- desktop webview/window policy modules only if Electron requires a distinct sandbox path

**Exit criteria:** A template can only prefill the reviewed Scheduled flow, and a custom surface can call only declared broker capabilities through a versioned sandbox bridge with no renderer, Node, filesystem, or ambient-network escape.

### Phase 9: Add Canonical Hooks And Explicit Browser Capabilities

**Dependency:** Broker authorization, audit events, and sandbox boundaries are stable enough to govern indirect execution.

**Goal:** Support automation around bigbud-owned lifecycle events without exposing provider-specific hooks or silently granting browser control.

1. Define a small canonical event vocabulary such as `session.started`, `turn.beforeStart`, `tool.beforeCall`, `tool.afterCall`, `turn.completed`, and `schedule.beforeRun`. Add an event only when bigbud can emit it consistently or explicitly mark provider availability.
2. Require every hook to declare event, permissions, input/output schema, timeout, failure mode, and whether it may advise, transform, or block. Blocking is allowed only before an operation bigbud controls; provider-internal lifecycle events are observational at most.
3. Execute hooks in a bounded runtime with deterministic ordering, recursion/re-entry protection, per-hook timeouts, output-size limits, cancellation, version pinning, and audit records. Failure behavior must be explicit and default to preserving the core operation where safe.
4. Model browser access as provider-neutral capabilities such as browser navigation/control, allowed domains, downloads/uploads, and—where separately approved—desktop computer use. Reuse bigbud's browser/computer-use permission system rather than provider-specific browser-extension APIs.
5. Installation may declare browser needs but never installs an extension, opens a browser, signs in, grants domains, or enables computer use automatically. Consent is separate, revocable, destination-aware, and enforced per call by the broker.
6. If future extension interoperability is required, treat the extension as one runtime adapter behind the same capability boundary; do not make extension installation a universal plugin primitive.

**Likely files:**

- `packages/contracts/src/plugins/pluginHooks.ts`
- `apps/server/src/plugins/Layers/PluginHookEngine.ts`
- orchestration lifecycle emitters extended through focused integration modules
- existing browser/computer-use capability and permission modules, referenced through broker adapters
- plugin detail permission and hook disclosure components

**Exit criteria:** Hook behavior is deterministic, bounded, auditable, and truthful across providers; browser actions require explicit scoped consent and use the existing bigbud capability boundary without silent extension installation.

### Phase 10: Add Managed Enterprise Policy And Privacy-Safe Audit

**Dependency:** Plugin lifecycle, Connections, broker calls, hooks, browser access, and update flows all emit normalized policy inputs and audit outcomes.

**Goal:** Let managed deployments govern one global plugin installation model without creating provider-specific or project-specific package copies.

1. Add a `PluginPolicyService` whose resolved precedence is: managed organization policy, global installation state, user connection/consent, then provider/runtime availability. A less-authoritative layer can further restrict access but cannot override a higher-level denial.
2. Support explicit controls:
   - **Hide:** omit a plugin from catalog discovery while preserving separately governed installed state;
   - **Preinstall:** ensure an approved package revision is present globally without connecting or authorizing a user's account;
   - **Version lock:** allow only an approved revision/range and block unapproved store updates;
   - **Disable:** block activation and new execution while retaining package files and readable history;
   - **Audit:** record normalized lifecycle and security events.
3. Also allow source allow/deny rules, personal-marketplace policy, component-type restrictions, OAuth scope/destination restrictions, local executable rules, browser/domain/computer-use bounds, update approval requirements, and custom UI/hook enablement.
4. Apply policy at catalog presentation, install/update/connect, capability publication, every tool call, hook execution, schedule validation/run, custom UI bridge calls, and browser access. UI hiding alone is never enforcement.
5. Audit install, update, rollback, uninstall, connection grant/revoke/refresh failure, policy decisions, tool identity/destination/outcome/approval, hook outcome, and schedule/plugin validation. Exclude prompts, tool arguments/results, OAuth codes/tokens, API keys, files, and custom UI content by default.
6. Define retention, export, administrator access, user visibility, clock/source identity, tamper evidence, and failover behavior before enabling enterprise audit. Content audit requires a separate explicit policy, warning, retention model, and legal/privacy review.
7. Validate managed policy authenticity/version and retain the last valid policy across transient fetch failures. Fail closed for an explicit managed denial or expired mandatory policy; do not invent new restrictions when no management policy has ever been configured.

**Likely files:**

- focused policy/audit contracts under `packages/contracts/src/plugins/`
- `apps/server/src/plugins/Layers/PluginPolicyService.ts`
- `apps/server/src/plugins/Layers/PluginAuditService.ts`
- persistence migrations for policy metadata and audit records, following the existing migration registration pattern
- plugin store/detail managed-state components and settings/admin surfaces

**Exit criteria:** Administrators can manage visibility, presence, version, execution, sources, permissions, and audit for global plugins; enforcement occurs server-side at every privileged boundary; preinstall never implies authentication; and default audit contains metadata rather than user content.

## Risks And Decision Gates

### Gate 1: Marketplace Repository Access And Stability

- The catalog is mutable and its schema may evolve. The decoder must be tolerant of optional unknown fields but strict about fields bigbud executes or resolves.
- GitHub or Git may be unavailable. First-run unavailability blocks browsing/install; cached snapshots remain usable afterward.
- If OpenAI stops publishing the API marketplace or changes its distribution terms, pause new syncs and preserve existing installed packages while product/legal review decides migration. Do not silently switch to the 180-entry catalog.

### Gate 2: Licensing And Redistribution

- The repository being public does not make every plugin or bundled asset universally relicensable. Before shipping cached/bundled assets, verify that bigbud fetches them at runtime from the upstream package and displays them under the package's declared license/brand terms.
- Do not vendor the marketplace or plugin artwork into the bigbud binary in phase 1 unless licensing review explicitly approves it.
- Show developer/source/license metadata where supplied and avoid modifying brand artwork beyond sizing, clipping, and theme selection.

### Gate 3: Trust And Filesystem Containment

- A skills-only plugin can still contain scripts and instructions that later cause tool execution. Installation is a trust event even though installation itself executes nothing.
- All catalog paths, manifest component paths, skill references, assets, symlinks, and copy targets require canonical containment checks.
- Asset URLs must map through validated keys. Never expose `?path=/absolute/file` for plugin data.

### Gate 4: Identity And Collisions

- Two marketplaces or plugins can eventually share names, and two installed plugins can expose the same skill name. Phase 1 still uses marketplace-qualified IDs so later sources do not require a migration.
- Discovery merge order must not silently choose among duplicate plugin skills. Ambiguity must be visible and resolvable by qualification.

### Gate 5: Installation Versus Runtime Compatibility

- “Installable” means bigbud can validate and expose the package, not that every provider has every executable/tool the workflow may request.
- Provider runtime capability gaps must surface as unavailable during use; they must never be replaced with fabricated results or another provider's context-window usage.

### Gate 6: Installed Package Updates

- Refreshing the catalog must never alter installed behavior. This invariant is required before install ships.
- Update is an explicit store-only mutation. The list/detail page shows availability and provenance; the launch toast only navigates to the update-filtered store.
- A component, capability, script/executable, or provenance change requires an explicit diff confirmation. Unsupported new components block the update.
- Publish the target as a new immutable revision, atomically switch the registry, retain the previous revision through the rollback window, and automatically restore it when post-switch discovery/health validation fails.
- Active turns continue against their referenced immutable revision; an update affects only later resolution after the registry switch.

### Gate 7: Cross-Window And Restart Consistency

- Server registry state is authoritative. Optimistic UI must reconcile to server revision.
- A disconnected client cannot infer mutation success. After reconnect it refetches catalog/installation state before enabling another action.

### Gate 8: Asset Performance

- Do not encode all marketplace PNGs into bootstrap/config payloads. Serve lazy, cacheable same-origin image URLs.
- Bound dimensions/file sizes and use lazy loading in long lists. Add an in-memory decoded image cache only if browser/network measurements show a need beyond normal HTTP caching.

### Gate 9: File-Length And Structural Drift

- Near-limit files must be split only by the concern being added. Do not combine plugin work with unrelated cleanup.
- New plugin domain files, tests, and components must stay within repository length limits from their first revision.

### Gate 10: Credentials, Accounts, And Deployment Topology

- Desktop keychain and headless/server secret storage have different trust and recovery models. Phase 7 cannot start until the existing deployment modes, credential abstraction, encryption-key custody, backup behavior, and multi-user server ownership are documented.
- Account identity, tenant, scopes, endpoint, and expiry are connection metadata; reusable credentials are not. Logs, renderer state, provider input, telemetry, and audit events must be tested for secret leakage.
- OAuth redirect handling, PKCE/state validation, refresh-token rotation, reauthorization, revocation, and account switching require focused threat review before a connector is called production-ready.

### Gate 11: Runtime And Tool Lifecycle Consistency

- Providers differ in how and when they accept tool schemas. The broker must define a stable capability snapshot and map provider limitations explicitly; it must never mutate an active turn or fabricate tool support.
- Remote endpoint changes and local executable/configuration changes are permission-relevant update diffs. A package update cannot silently redirect an authorized connection or replace a supervised executable.
- Local stdio expands the attack and reliability surface materially. Keep it behind a distinct rollout gate after remote MCP, with process containment, resource, crash-loop, idle-shutdown, and orphan cleanup tests.

### Gate 12: Hooks And Background Execution

- Hooks and schedules can cause work without a fresh chat prompt. Every execution needs a visible owner, declared trigger, current authorization, bounded resources, version identity, and an audit outcome.
- Provider-specific lifecycle signals cannot be advertised as universal. Canonical hooks are limited to events bigbud owns or can truthfully expose with availability metadata.
- A hook cannot block or rewrite a provider-internal operation that bigbud does not control. Unsupported enforcement must fail closed at configuration time rather than imply protection.

### Gate 13: Custom UI And Browser Control

- Plugin HTML is untrusted content. Sandbox escape, origin confusion, bridge spoofing, oversized messages, storage abuse, navigation, downloads/uploads, and teardown after disable/update require security testing.
- Declared browser access is not consent. Domain scope, browser/computer-use permission, connection identity, and action approval remain separate and revocable.
- Do not add arbitrary plugin components to the trusted React tree or install browser extensions as an implicit side effect of package installation.

### Gate 14: Managed Policy And Audit Privacy

- Policy enforcement must occur in server services, not only through hidden buttons. Conflicts resolve through the documented precedence and return an explainable effective-policy result.
- Preinstall must not create an account connection, accept OAuth scopes, or run setup code. Disable must stop new work while preserving history and recoverable package state.
- Default audit is metadata-only. Any prompt, arguments, results, files, or UI content collection requires a separately approved content-audit design, visible disclosure, access controls, retention, and legal/privacy review.
- Policy distribution, signature validation, last-known-good behavior, mandatory-policy expiry, administrator identity, and audit tamper evidence are implementation gates, not assumptions.

## Testing And Validation

### Contract And Parsing Tests

- Decode the reviewed API marketplace and Remotion manifest fixture.
- Preserve backward compatibility for discovery entries without plugin provenance.
- Reject invalid qualified IDs, unsafe strings, oversized arrays/content, unsupported components, malformed presentation metadata, and catalog/manifest identity mismatch.
- Verify unknown optional upstream fields do not break compatible packages.

### Marketplace Sync Tests

- Fresh clone/sparse snapshot success with a local Git fixture remote.
- Resolve and persist commit SHA.
- Concurrent refresh coalescing/serialization.
- Offline first run versus offline cached run.
- Invalid new snapshot preserves previous valid snapshot.
- Process interruption leaves active snapshot valid.
- Catalog addition/removal/category change is reflected only after atomic publication.
- Safe logging excludes raw stderr, skill bodies, and local paths.

### Installation And Security Tests

- Install/update/uninstall Remotion fixture.
- Idempotent repeated requests and stale-revision conflicts.
- Missing package, missing manifest, missing skill, traversal, absolute path, symlink escape, hard-link/special-file policy, oversized file/tree, and unsupported component rejection.
- Failure before copy, during copy, before rename, after package rename, and before/after registry rename.
- Concurrent install/update/uninstall/refresh lock ordering.
- Update availability comparison, reviewed-target preconditions, permission/component diff confirmation, unsupported-component rejection, atomic pointer switch, pre-switch failure, post-switch health failure, and automatic rollback.
- An active turn retains its old immutable revision while a successful update affects later discovery.
- Uninstall during an active reference retains immutable files until safe cleanup.
- Source catalog removal preserves installed package and uninstall.
- Registry corruption recovery does not crash startup or erase immutable packages.

### Asset Route Tests

- Resolve composer icon, light logo, and dark logo through known asset keys.
- Correct MIME, `nosniff`, immutable cache headers, missing asset, wrong extension/MIME, oversized asset, traversal, symlink escape, unknown plugin/revision/key, and unauthorized remote request.
- Browser theme switching selects `logoDark`/`logo` without refetch loops.
- Broken images fall back to `PlugIcon` with readable text.

### Discovery And Input Expansion Tests

- Installed skills appear as `provider: "bigbud"`, `source: "plugin"`, with plugin provenance.
- Every supported provider sees bigbud plugin skills.
- Uninstall removes skills from new discovery snapshots.
- Immediate registry events and watcher fallback converge.
- Duplicate skill names produce ambiguity instead of order-dependent selection.
- `@plugin::remotion` and `/plugins remotion` resolve only when installed.
- Plugin activation includes compact metadata/index, not all skill bodies.
- Direct skill invocation still works.
- Original persisted message remains unchanged.
- Provider input size/block limits and third-party trust wording remain enforced.

### Store And Sidebar Tests

- `/plugins` route closes the right panel and renders within the standalone shell.
- `/plugins/$pluginId` renders breadcrumb, artwork, description, example prompt treatment, source metadata, management action, and counted component sections; an installed example prefills a new chat with the plugin mention without sending, while an uninstalled example requires installation.
- Sidebar order is New chat, Search, Plugins, Scheduled, Usage; plugin row uses `PlugIcon`, correct tooltip/ARIA label, navigation, and mobile close behavior.
- Loading, first-run failure, stale cached data, background refresh, empty result, category grouping, search, installed strip, per-plugin install/update/uninstall, update diff, rollback failure, conflict, and uninstall confirmation states.
- Search matches all documented fields and preserves input across refetch.
- Installed and catalog rows reconcile after another client changes state.
- Launch update toast names one to three plugins, uses the generic more-than-three copy above three, emits once per app launch, and links to `/plugins?filter=updates` without performing an update.
- Keyboard-only operation, focus return, page/breadcrumb semantics, screen-reader labels, reduced motion, responsive one/two-column layout, and 14px default typography.

### Composer And Chat Tests

- `@` includes installed plugins only and preserves deterministic ordering.
- `/plugins`, `/plugins rem`, keyboard selection, escape, empty installed state, and store link.
- ChatView and Orchestra use the same builder/selection behavior.
- Lexical insert, export/import, copy/paste, undo/redo, deletion, cursor movement, draft restore, and legacy node compatibility.
- Persisted plain text is `@plugin::name`; displayed label is manifest display name.
- Composer and sent message use the same cached artwork and fallback.
- Sent chip navigation opens `/plugins/$pluginId`.
- Old messages remain readable after uninstall, catalog removal, or offline startup.

### Later-Phase Runtime And Connection Tests

- Install and connection state remain independent; preinstall/install never authorizes an account.
- OAuth state/PKCE, redirect origin, scope diff, token rotation, revocation, expiry, reconnect, account switching, and secret redaction.
- The renderer and each provider process receive no reusable credentials.
- Capability publication and invocation enforce connection, user consent, managed policy, destination, provider availability, timeouts, and payload bounds.
- An active turn retains its pinned schemas/runtime destinations through plugin update, disconnect, policy refresh, and provider reconnect; later turns see the new snapshot.
- Remote MCP pooling never crosses user/account or incompatible policy boundaries.
- Local stdio process start, crash, bounded restart, health failure, cancellation, reference counting, idle shutdown, server termination, orphan cleanup, environment sanitization, and executable update diff.

### Later-Phase Template, UI, Hook, And Browser Tests

- A scheduled template only prefills the existing editor and cannot save, enable, or run without review.
- Every scheduled run revalidates plugin revision, connection, capability, and policy; loss pauses/fails visibly.
- Custom UI origin/CSP isolation, bridge version/origin validation, declared-tool enforcement, storage quota, rate/payload bounds, teardown, navigation, and no Node/filesystem/ambient-network access.
- Hook ordering, version pinning, timeout, cancellation, recursion protection, output bounds, explicit fail-open/fail-closed behavior, provider availability, and audit outcome.
- Browser/domain/computer-use consent is separate from install, enforced per call, revocable, destination-aware, and never installs an extension silently.

### Later-Phase Enterprise Policy And Audit Tests

- Managed policy precedence over global install state, user connection/consent, and provider availability; lower layers can restrict but never override denial.
- Hide, preinstall, version lock, disable, source/component/scope/destination/executable/update rules, and personal-marketplace policy are enforced in UI and server boundaries.
- Invalid, stale, unavailable, expired mandatory, and last-known-good policy behavior is deterministic and explainable.
- Audit includes required lifecycle/security metadata, actor/source/time/outcome, retention/export controls, and tamper-evidence checks while excluding content and secrets by default.
- Multiple clients and providers converge on the same effective global plugin policy without project-scoped installation copies.

### End-To-End Manual Checks

1. Start with no local catalog online; refresh and confirm compatible entries appear.
2. Inspect the Remotion detail page and verify breadcrumb, descriptions, example prompt, source links, Skills count/list, and icon/logo/light-dark artwork come from its package.
3. Install Remotion; confirm Installed section, store row, discovery, `@`, `/plugins`, and `$`/`/skills` behavior.
4. Invoke Remotion once with Codex and once with each enabled non-Codex provider; inspect provider-bound input to confirm provider-neutral compact expansion.
5. Send a branded mention and confirm the sent chip remains correct after restart.
6. Disable network and restart; confirm installed Remotion and cached catalog remain usable with a stale indicator.
7. Uninstall during/after a turn; confirm new discovery removes it and old message/active files remain safe.
8. Publish a newer fixture revision, restart, verify the bounded update toast, visit the update-filtered store, review the diff, update, and exercise automatic rollback with a forced post-switch validation failure.
9. Test desktop and browser deployments, narrow/mobile sidebar behavior, light/dark themes, and remote-auth asset loading.

### Required Repository Commands

Run focused tests throughout, then complete all required checks before considering implementation complete:

```sh
bun run --cwd apps/server vitest run src/plugins
bun run --cwd apps/server vitest run src/provider/Layers/DiscoveryRegistry.test.ts
bun run --cwd apps/server vitest run src/orchestration/Layers/ProviderCommandReactorInputExpansion.test.ts
bun run --cwd apps/web vitest run src/components/plugins
bun run --cwd apps/web vitest run src/logic/composer
bun run --cwd apps/web vitest run src/components/chat/messages/MessagesTimeline.chips.test.tsx
bun run --cwd apps/web test:browser
bun fmt
bun lint
bun typecheck
bun run test
```

Never run `bun test`; it bypasses the repository's Vitest/Turbo configuration.

## Acceptance Criteria

- The standalone `/plugins` page is reachable from a **Plugins** sidebar row immediately before **Scheduled** and uses Lucide `PlugIcon`.
- Every catalog item has a dedicated `/plugins/$pluginId` page with breadcrumb, artwork, descriptions, source links, example-prompt treatment, management state, and counted component sections.
- The page reads the official skills-only API marketplace dynamically and shows only currently validated compatible entries.
- No Personal/Add or unsupported catalog UI appears in phase 1.
- The page separates installed plugins from available plugins and supports search, category grouping, refresh, install, explicit store-only update, and uninstall.
- Phase-1 detail pages disclose Skills and “Skills only” composition where appropriate; the same contract/page can later disclose Apps and other component types without a separate store or user-facing plugin class.
- Remotion's packaged PNG artwork appears in the store, composer mention, and sent chat message; missing/invalid artwork uses `PlugIcon` without losing the text label.
- Catalog and asset loading work from a last known good snapshot when offline and visibly report staleness.
- Installations are global-only, immutable, commit/version-provenanced, atomic, and do not change during catalog refresh.
- One to three available updates are named in one launch toast; more than three use the agreed generic count message. The toast links to the update-filtered plugin store and cannot update directly.
- Updates require explicit action in the plugin store, show relevant revision/component/capability/script changes, atomically switch immutable revisions, and automatically retain/restore the prior revision on failure.
- Installation executes no plugin code or dependency lifecycle scripts.
- Unsafe paths, symlink escapes, special files, unsupported components, oversized packages/assets, and stale install clicks fail closed.
- Installed skills appear through existing discovery as bigbud-owned plugin sources and are available to every supported provider.
- `@` and `/plugins` list only installed plugins in normal and Orchestra composers.
- Selecting Remotion persists `@plugin::remotion`, renders `Remotion`, and expands only bounded package/index context for the provider.
- Direct plugin child-skill invocation remains available through `$` and `/skills`.
- Uninstall affects new discovery/turns without breaking old message rendering or deleting project output.
- Refresh/install/update/uninstall are serialized, reconnect-safe, multi-client coherent, and recover from partial filesystem operations without clearing prior valid state.
- Full plugin catalog data and image bytes are not added to `ServerConfig` bootstrap payloads.
- No non-test TypeScript file added or materially extended by this work exceeds 400 lines; no test exceeds 500 lines.
- Focused tests, browser checks, `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass.
- Product/release copy says **official skills-only plugins**, not “all Codex plugins.”

### Later-Phase Acceptance Gates

- bigbud, not a provider runtime, owns Connections, reusable credentials, capability authorization, runtime supervision, and audit.
- Remote HTTPS MCP ships before local stdio; local processes do not ship until the separate supervision/security gate passes.
- Each turn uses an immutable capability/runtime snapshot, and every privileged invocation traverses the provider-neutral broker.
- Plugin installation, connection authorization, consent, and provider availability remain distinct visible states.
- Scheduled templates only prefill the existing reviewed Scheduled flow and never create background work during install.
- Custom UI runs only in the sandboxed versioned bridge, and hooks run only against canonical events with declared bounded behavior.
- Browser or computer control always requires explicit provider-neutral capability consent and domain/destination policy; no plugin install silently adds an extension.
- Managed policy can hide, preinstall, version-lock, disable, and audit global plugins without authenticating users or creating project-scoped copies.
- Audit is metadata-only by default, and server-side enforcement uses the documented policy precedence at every privileged boundary.

## Open Questions

No product-architecture questions remain at this planning level. Personal sources are Local folder plus Git repository; installations are global-only; updates are store-only; the future universal catalog remains one user-facing Plugin store; bigbud owns capability/auth/runtime lifecycle; scheduled templates, sandboxed UI, canonical hooks, and explicit browser capabilities are provider-neutral primitives; and managed policy supports hide, preinstall, version lock, disable, and metadata-first audit.

The following implementation-discovery gates must be resolved from code and platform evidence before their respective later phases begin:

- Which existing bigbud secret/keychain abstractions and deployment identities can be reused, and what approved encrypted-store design covers headless/server mode?
- What exact dynamic tool-registration and active-turn guarantees does each supported provider adapter expose?
- Which lifecycle events can bigbud emit consistently across providers, and which must advertise limited availability?
- How will managed policy be distributed, authenticated, cached, expired, and recovered, and what audit retention/export requirements apply?
- Which upstream non-skill manifest/component schema versions are stable enough to normalize without coupling bigbud to Codex internals?

These are evidence and implementation gates, not invitations to change the settled user-facing model. Any answer that requires a new library, public API, storage architecture, or cross-subsystem deviation must return for explicit approval before implementation.
