# First-launch welcome tour plan

| Field                | Value                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Status               | Ready for implementation. Steps, audience and rules were decided by the user.                                          |
| Created              | 2026-11-20                                                                                                             |
| Project root         | `/Users/youpele/DevWorld/bigbud`                                                                                       |
| Inspected branch/SHA | `dev` @ `b801019eb0`                                                                                                   |
| Scope                | `apps/web` (desktop and web share it), one client setting in `packages/contracts`, one copy entry in `packages/shared` |
| Out of scope         | `apps/mobile-web`, `apps/desktop` computer-use runtime (another agent is working there)                                |

---

## 1. Goal

Replace the first-launch File Access dialog with one short welcome tour, shown at the same moment,
that walks a new user through:

1. **What should bigbud call you?** Optional greeting name, the same setting and save logic as
   Settings → General.
2. **Connect AI.** The providers bigbud auto-discovered, with their ready / not found / needs
   sign-in state from the same server provider status Settings → Providers uses, and a CTA that
   opens Settings → Providers to add or set up more.
3. **File access.** The existing File Access question (same two choices, same settings write, same
   server mirror patch, same `probeFileAccessLevel` call).

Finishing lands on a new chat whose empty-state screen greets the user by name next to the bigbud
logo. Without a name it keeps "A blank canvas for whatever’s next."

## 2. Findings from the current code

- `apps/web/src/routes/__root.tsx` opens `FileAccessPermissionDialog` 800 ms after bootstrap and
  server config load when `settings.hasSeenFileAccessPrompt` is false
  (`-__root.permissionPrompts.ts`). Nothing else renders that dialog.
- `hasSeenFileAccessPrompt` is a client setting (`ClientSettingsSchema`, localStorage). Settings →
  AI → File Access → "Reset permissions" sets it back to false so bigbud asks again.
- The greeting name is a server setting (`greetingName`), saved through
  `ensureNativeApi().server.updateSettings` in `GeneralSettingsGreetingName.tsx`, which only
  acknowledges a persisted value.
- The empty new-chat screen is `ChatGreeting` (`ChatGreetingSurface` from `@bigbud/ui`). The copy
  comes from `useChatGreeting`, which picks a random message per thread identity from
  `@bigbud/shared/greeting` and renders `{name}` when the message has a named variant. "A blank
  canvas for whatever’s next." is the `anytime-canvas` message.
- Settings → Providers builds its rows with `buildProviderCards({ serverProviders, settings })`
  (`ProvidersSettingsSection.logic.ts`), giving each provider a title, status dot style and a
  status headline ("Authenticated", "Not found", "Not authenticated", ...).
- New chats are created with `useHandleNewThread` + `useSidebarNewChatActions().handleNewChats`.
- Ephemeral UI flags use small zustand stores in `apps/web/src/stores/ui/` (for example
  `commandPalette.store.ts`).

## 3. Decisions

| Topic                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence of "tour done"          | New client setting `hasSeenWelcomeTour` (default `false`) next to `hasSeenFileAccessPrompt`, written through `useUpdateSettings`. No second store.                                                                                                                                                                                                                                                                                                                                                 |
| Who sees the tour                   | `!hasSeenFileAccessPrompt && !hasSeenWelcomeTour` after bootstrap and server config load (same gate and 800 ms delay as today). Existing users already answered File Access, so they never see it automatically.                                                                                                                                                                                                                                                                                   |
| Re-asking after "Reset permissions" | `hasSeenFileAccessPrompt` false but `hasSeenWelcomeTour` true opens the same dialog in a single-step `file-access` mode, so the reset feature keeps working without a second copy of the choice UI. "Reset permissions" also sets `hasSeenWelcomeTour: true`, so users from before the tour existed are re-asked only File Access.                                                                                                                                                                 |
| Closing / skipping                  | "Skip tour", Escape, the close button and finishing all set `hasSeenWelcomeTour: true` and `hasSeenFileAccessPrompt: true` (the same thing "Maybe Later" did). Outside clicks do not dismiss. A typed but unsaved name is saved on skip so nothing typed is lost. Skipping never writes a File Access level.                                                                                                                                                                                       |
| Standalone dialog                   | Removed. Its choice UI moves into a shared `FileAccessLevelChoice` component and its write sequence into `applyFileAccessChoice`, both used by the tour step.                                                                                                                                                                                                                                                                                                                                      |
| Name step                           | The save logic of `GeneralSettingsGreetingName` moves into a `useGreetingNameDraft` hook used by both Settings → General and the tour step. Empty name = skip.                                                                                                                                                                                                                                                                                                                                     |
| Providers step                      | Reuses `useServerProviders` + `buildProviderCards` and lists every supported provider with the same status headline as Settings → Providers ("Authenticated", "Not found", "Not authenticated", ...), plus a "bigbud found N AI providers" summary ("checking" until the server reports). The CTA "Add more providers after the tour" moves on to File Access and makes finishing open `/settings/providers` instead of a new chat, so the File Access question is never lost behind a navigation. |
| Greeting on landing                 | A shared `WELCOME_GREETING` message (`named: "Welcome to bigbud, {name}."`, `nameless: "A blank canvas for whatever’s next."`) in `greeting.messages.ts`. Finishing the tour creates a new chat and requests the welcome greeting; the next eligible empty chat claims it for its thread identity for the page lifetime. Rendering stays in `renderGreeting`, so no parallel path.                                                                                                                 |
| Reopening                           | Settings → About gets a "Welcome tour" row with a "Show welcome tour" button that opens the full tour.                                                                                                                                                                                                                                                                                                                                                                                             |
| Accessibility                       | base-ui Dialog keeps focus trapped and restores focus; each step moves focus to its first control; option cards are `aria-pressed` buttons; step indicator uses `aria-live="polite"`; Escape = skip.                                                                                                                                                                                                                                                                                               |

## 4. Files

| Area          | File                                                                                                                | Change                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts     | `packages/contracts/src/core/settings.ts`                                                                           | Add `hasSeenWelcomeTour`.                                                                                                                  |
| Shared copy   | `packages/shared/src/greeting.messages.ts`                                                                          | Add `WELCOME_GREETING`.                                                                                                                    |
| Store         | `apps/web/src/stores/ui/welcomeTour.store.ts` (+ test)                                                              | Open/close tour with mode; request/claim welcome greeting.                                                                                 |
| Gate          | `apps/web/src/components/welcome-tour/WelcomeTourDialog.firstLaunch.ts` (+ test)                                    | `resolveFirstLaunchTourMode` and `useFirstLaunchWelcomeTour` replace `routes/-__root.permissionPrompts.ts` (`shouldShowFileAccessPrompt`). |
| Root          | `apps/web/src/routes/__root.tsx`                                                                                    | Mount `WelcomeTourDialog` instead of `FileAccessPermissionDialog`.                                                                         |
| File access   | `apps/web/src/components/file-access/FileAccessLevelChoice.tsx`, `FileAccessLevelChoice.logic.ts`                   | Extracted choice UI and write sequence. Delete `FileAccessPermissionDialog.tsx`.                                                           |
| Greeting name | `apps/web/src/components/settings/GeneralSettingsGreetingName.hooks.ts`                                             | Extracted save hook; `GeneralSettingsGreetingName.tsx` uses it.                                                                            |
| Tour          | `apps/web/src/components/welcome-tour/WelcomeTourDialog.tsx`, `.steps.tsx`, `.providers.tsx`, `.logic.ts` (+ tests) | Dialog shell, steps, providers list, step model.                                                                                           |
| Greeting      | `apps/web/src/components/chat/common/ChatGreeting.hooks.ts`                                                         | Use `WELCOME_GREETING` for the claimed thread.                                                                                             |
| About         | `apps/web/src/components/settings/AboutSettingsSection.tsx`, `SettingsSidebarNav.items.ts`                          | "Show welcome tour" row and settings search entry.                                                                                         |
| Reset         | `apps/web/src/components/settings/FileAccessSettingsSection.tsx`                                                    | Reset also sets `hasSeenWelcomeTour: true`.                                                                                                |

## 5. Validation

- Focused Vitest: store, gate, tour logic, greeting logic, existing greeting and file-access tests.
- Browser test (`WelcomeTourDialog.browser.tsx`): shows once, skip (button and Escape) marks seen
  without writing a level, name saved through the server RPC, File Access level saved + server
  mirror patch + probe called, finishing creates a new chat and requests the welcome greeting,
  and the greeting renders the name.
- Existing browser tests: `GeneralSettingsGreetingName.browser.tsx`, `-__root.startup.browser.tsx`.
- `bunx oxfmt` / `bunx oxlint` on explicit changed files; `bun run typecheck` in `apps/web`,
  `packages/contracts`, `packages/shared`.
- No repository-wide checks.

## 6. Acceptance criteria

1. New install (no File Access decision) sees the tour once; after skip or finish it never shows
   again automatically.
2. Existing users who answered File Access never see it automatically; Settings → About can reopen it.
3. Every step is skippable and "Skip tour" is always visible; Escape skips without losing a typed name.
4. Name step writes `greetingName`; providers step shows discovered providers and links to
   Settings → Providers; File Access step writes the client level, the server mirror and runs the probe.
5. Finishing lands on a new chat greeting the user by name; without a name the copy is
   "A blank canvas for whatever’s next."
6. Reset permissions still re-asks the File Access question.
