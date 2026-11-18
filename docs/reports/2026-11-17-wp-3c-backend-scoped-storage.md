# WP-3C: backend-scoped persisted storage

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M2 WP-3C
**State:** Implemented and unit/browser tested. Not live-tested. Not committed.

## What changed

A window bound to a remote backend (`?backend=<profileId>`) shares `localStorage` with the local
window. Every backend-owned persisted key now goes through
`apps/web/src/lib/backendScopedStorage.ts`:

- **Local window:** keys are unchanged (empty prefix). Existing users need no migration and see no
  change.
- **Bound window:** keys are `backend-v1:<authorityId>:<installationFingerprint>:<legacy key>`.
  This is the same pinned identity the scoped delivery cursor uses. Both parts have fixed,
  schema-validated formats, so the prefix is unambiguous.
- Ledger lock names, `BroadcastChannel` names and `StorageEvent` key checks use the same
  namespace. Windows bound to different backends never coordinate through one ledger.

## Identity timing (the decision to review)

The identity comes from the pinned relay profile. The bootstrap only knows it after it lists the
relay profiles, but stores are created earlier, during module evaluation. Some stores (for example
the banner dismissal store) are even imported by the bootstrap itself. We chose **deferred
hydration**, not a key from the profile id:

- Until the identity is known, scoped storage in a bound window is **inert**: reads return null,
  and writes and removes are dropped. It never falls back to the legacy keys.
- `bootstrapBackendScope` calls `setBackendStorageIdentity(profile.identity)` as soon as it finds
  the profile, before the owner opens and before the first render. That call runs the registered
  rehydrators: composer, terminal, files, banner dismissal and provider failure notices
  (`persist.rehydrate()`), plus the UI store (it re-reads `readPersistedState`).
- Debounced stores (composer, files) put the scope wrapper **outside** the debouncer. A write
  made before the identity is known is dropped, so it cannot be flushed later over that backend's
  saved data. In the UI store, the rehydrate update replaces any pending debounced write.
- Ledgers report `unavailable: storage` until the identity is known.
- A second, different identity is ignored with a warning, because a window's binding never
  changes.

A profile-id key was rejected: one profile could be re-pinned to a different installation.

## Classification

Backend-scoped:

| Store / file                                                            | Reason                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `stores/composer/composer.store.ts`, `persistence.store.ts`             | Drafts keyed by backend thread id                                  |
| `stores/terminal/terminal.store*.ts`                                    | Terminal state per backend thread                                  |
| `stores/files/filesPanel.store.ts`                                      | File history per backend workspace                                 |
| `stores/ui/ui.store.ts`, `ui.store.projects.ts`                         | Project expansion/order, last thread, visits                       |
| `stores/ui/bannerDismissal.store.ts` (`sessionNoticeStorage`)           | Keyed by backend server run                                        |
| `stores/ui/providerFailureNotice.store.ts`                              | Backend server run plus thread ids                                 |
| `stores/ledger/revisionedLedger.ts` (all ledgers)                       | Ownership, materialization, command ledgers, project-edit recovery |
| `stores/remoteAccess/remoteAgentAdmissionRequest.ts`                    | Backend execution target ids                                       |
| `Sidebar.projectActions.reconnect.persistence.ts`                       | Backend project ids                                                |
| `ProviderStatusBanner.advisory.state.ts`                                | The backend's OpenCode history advisory                            |
| `DatabaseCompaction.runState.ts`                                        | Backend compaction run ids                                         |
| `ThreadRetentionSettingsSection.progress.ts`                            | Backend retention run ids                                          |
| `useCompactChatThread.ts`                                               | Backend thread id                                                  |
| `chat-view-base-state.ephemeral.hooks.ts` (last script)                 | Keyed by backend project id                                        |
| `recentlyUsedModels.ts`, `useRecentlyUsedModels.ts`                     | Models come from the backend's providers                           |
| `compactChatModelPreference.ts`, `FloatingAssistantSettingsSection.tsx` | A model of the backend's providers                                 |

Device-global (unchanged):

| Store / file                                                                                                                 | Reason                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `useTheme.ts`                                                                                                                | Device appearance                                                 |
| `useSettings*.ts`, `openLink.ts`, `-__root.bounded-bootstrap.sort.ts`                                                        | Client settings are device preferences                            |
| `stores/inyosira/*`                                                                                                          | Sidebar arrangement mode (UI enum, no ids)                        |
| `stores/stt/stt.store.ts`                                                                                                    | Speech key used by this renderer and device                       |
| `stores/resource-monitor/*`                                                                                                  | Widget visibility preferences                                     |
| `stores/rightPanel/rightPanelWidth.store.ts`, `ui/sidebar.rail.tsx`, `FilesPanel.treeWidth.ts`, `useGitPanelSidebarWidth.ts` | Layout widths                                                     |
| `models/editor/preferences.models.ts`                                                                                        | Local editor choice                                               |
| `Sidebar.remoteWorkspaces.connectionSourcePreference.ts`                                                                     | Dialog default                                                    |
| `BrowserPanel.history.ts`, `BrowserAgentControlBridge.tsx`                                                                   | The embedded browser runs on this device                          |
| `games/*`                                                                                                                    | Cosmetic toast rotation                                           |
| `MobileRemoteControlSettingsSection*.ts(x)`                                                                                  | Tailscale and mobile web URLs are desktop/device facts (see note) |
| `rpc/orchestrationDeliveryCursor.ts`                                                                                         | Local-only cursor; bound windows already use the scoped cursor    |

## Notes for the user

- In a bound window, sidebar action order and visibility are part of the per-backend UI state blob
  (`bigbud:ui-state:v1`), so they start at their defaults there.
- Mobile remote control settings stay device-global. If that section is ever shown in a bound
  window, its pairing call goes to the remote backend while the stored URLs describe this device.
  Consider hiding it in bound windows.
- A pre-existing failure is unrelated to this work: `GeneralSettingsPanel.test.tsx` fails because
  of `window` in the Node environment, and it also fails without these changes.
