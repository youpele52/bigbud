# Mascot screenshot to chat validation

Base: `02d0e8ecf0b2a145ac4eeef088175aff9fc89f1b`, branch `main`.

## Requirements

| Status   | Requirement                                                                 | Evidence                                                                                                                      |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Complete | Add screenshot menu entry below Open chat                                   | Floating window/menu tests                                                                                                    |
| Complete | Capture the mascot's display, or the system-selected PipeWire source        | Desktop screenshot source-selection tests for macOS, Windows and Linux                                                        |
| Complete | Screen Recording permission independent of Accessibility/CUA                | Native capture module uses only Electron screen permission; permission tests                                                  |
| Complete | Reuse existing macOS settings destination                                   | Shared URL used by settings and native capture recovery; tests                                                                |
| Complete | Hide floating UI and restore it on success/failure                          | Capture ordering, late-ready window and cancellation tests                                                                    |
| Complete | Append to selected/new floating draft without auto-send or lost text/images | Receiver browser tests and full CompactChatShell send test                                                                    |
| Complete | Preserve image-only drafts when switching chats                             | Cancelled New chat scenario in CompactChatShell test                                                                          |
| Complete | Reliable delivery across loading, retries and renderer remount/rehydration  | Desktop handoff tests; receiver tests for duplicate IDs, acknowledgement retry, reload, disposal and changed destination      |
| Complete | Bound capture size, queue depth and time; enforce attachment limits         | One pending screenshot; shared byte/count limits; native timeout test                                                         |
| Complete | Restrict screenshot IPC to compact-chat main frame                          | IPC authorization/input validation test                                                                                       |
| Complete | Broader floating chat regressions                                           | Ownership identity, live and delayed draft migration, durable restoration and synchronization repaired; 16 browser tests pass |
| Complete | Final repository-wide checks                                                | `bun fmt:check`, `bun lint`, and `bun typecheck` pass; lint reports only existing unrelated warnings                          |
| Complete | Native macOS capture, restoration and IPC                                   | Electron 40.6.0 on macOS 26.6.2 ARM64; Screen Recording granted, Accessibility denied                                         |
| Complete | Native Linux/X11 capture, restoration and IPC                               | Electron 40.6.0 on Debian 13 ARM64 with Xvfb/Openbox in an isolated container                                                 |
| Partial  | Remaining native platform certification                                     | Windows, Wayland portal selection, multiple physical monitors and packaged permission prompts remain unverified               |

## Exact successful commands

```sh
bun fmt
bun fmt:check
bun lint
bun typecheck
bun run --cwd apps/desktop test src/window/desktopScreenshot.test.ts src/window/compactScreenshotHandoff.test.ts src/window/floatingAssistantScreenshot.test.ts src/window/ipcHandlers.compactScreenshot.test.ts src/window/floatingAssistantWindows.test.ts src/window/floatingAssistantWindows.alwaysOnTop.test.ts
bun run --cwd apps/web test src/stores/ownership/ownershipLedger.scope.test.ts src/stores/composer/composer.store.draftThreadMapping.test.ts src/hooks/useHandleNewThread.ownership.test.ts src/hooks/draftOwnership.repair.test.ts src/hooks/materializationAttempts.reconcile.test.ts src/components/DraftOwnershipCoordinator.logic.test.ts src/components/chat/view/ChatView.sendTurn.ownership.test.ts src/hooks/useCompactChatThread.logic.test.ts src/stores/composer/composer.store.images.test.ts src/stores/composer/composer.store.syncPersisted.test.ts src/components/settings/ComputerUseAccessSettingsSection.test.tsx
bun run --cwd apps/web test:browser src/components/floating-assistant/CompactChatScreenshotReceiver.browser.tsx src/components/floating-assistant/FloatingAssistantShell.browser.tsx src/components/floating-assistant/CompactChatOwnership.browser.tsx src/components/floating-assistant/CompactChatSynchronization.browser.tsx
bun run --cwd apps/desktop build
bun run --cwd apps/desktop scripts/screenshot-smoke.mjs
```

- Desktop: 6 files, 53 tests passed.
- Web unit: 11 files, 58 tests passed.
- Browser: 4 files, 16 tests passed.
- Build: both main and preload bundles built.
- Formatting and lint: passed; existing unrelated warnings remain.
- `bun typecheck`: passed all 9 packages.
- All source and test files authored or materially edited for this feature are at
  most 400 lines. No Rust changes, new dependencies, commits or pushes.

## Broader regression diagnosis and repairs

The user explicitly expanded scope to investigate and fix the earlier failures.
Both original browser failures were reproduced before repairs.

- `ownershipLedger.toRecord` spread the previous record after assigning the new
  ID and generation, overwriting both. The corrected order keeps the replacement
  identity authoritative. Unit tests verify both renderer scopes, persisted
  records, matching project bindings and repeated reconciliation.
- A new browser case with the real `DraftOwnershipCoordinator` exposed a second
  failure: its synchronous ledger listener removed old metadata before composer
  migration resumed. Shared ledger-to-composer reconciliation now moves content
  before publishing replacement metadata. The browser cases preserve both prompt
  and screenshot with the coordinator enabled and disabled.
- A saved replacement could be ignored on restoration in favor of a newly
  generated ID. An unbound-draft browser case reproduced the wrong selection;
  restoration now uses the ID returned by the durable replacement operation.
  Shared lookup follows multiple missed replacement revisions to the live draft,
  preserves renderer scope, and terminates on cycles. Browser tests cover one and
  two missed writes with retained prompt/image; unit tests cover both scopes,
  repeated old-ID lookups and cycle termination.
- The synchronization fixture lacked ownership resolution and still delivered
  individual domain events. It now models absent-to-active ownership, delivery
  batches and acknowledgements. Sending, continued event updates and remount
  subscription cleanup pass.

## Native evidence

The repeatable smoke runner bundles the production screenshot coordinator, IPC
handlers and preload into a temporary profile. Three colored windows let it
check actual captured pixels before and after the floating windows are hidden.
It also verifies restoration, one availability notification, compact-only read
and acknowledgement, and retained delivery after a renderer reload. Screenshots
stay in memory; the runner removes its temporary profile afterward.

| Environment                                    | Result                                  | Scope                                                                                               |
| ---------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| macOS 26.6.2 ARM64, Electron 40.6.0            | Passed; 2560 × 1663 JPEG, 200,666 bytes | One physical display; Screen Recording granted and Accessibility denied                             |
| Debian 13 ARM64, Electron 40.6.0, Xvfb/Openbox | Passed; 1280 × 900 JPEG, 12,173 bytes   | Native X11 capture in an isolated Docker container, Chromium `--no-sandbox` for container execution |
| Windows                                        | Not run                                 | No Windows desktop runtime available in this session                                                |
| Linux/Wayland                                  | Not run                                 | No Wayland desktop with an interactive screenshot portal available                                  |

The Linux run used the same bundled smoke entry and preload as macOS, with
`BIGBUD_SCREENSHOT_SMOKE_DIR` pointing to an isolated writable directory and
`xvfb-run -a -s "-screen 0 1280x900x24" dbus-run-session` launching Openbox and
Electron. The temporary container is removed after verification. These results
do not certify packaged signing/TCC prompts or all physical monitor setups.

## Operational limits

- The pending desktop handoff survives renderer loading/reloads, not a full app
  exit before delivery. Delivered images use the existing draft persistence.
- Native Wayland screen selection and macOS permission UI remain OS-controlled.
- Capture timeout restores the floating UI. If the OS request remains outstanding,
  the user must finish/cancel it before another native capture can start.

## Final review

The independent requirements review passed the implementation and regression
fixes. Both review findings (durable replacement selection and missed replacement
chains) are closed, with no unresolved code defects found. Code green and
Implementation/Plan green are verified for the implementation and requested
fixes. Full native platform certification remains partial for the environments
listed above. Nothing was staged, committed or pushed.
