# Mascot screenshot to chat

Status: Implemented and validated

## Goal

Add **Add screenshot to chat** below **Open chat** in the mascot menu. Capture the
desktop and append the image to the last-used floating chat's unsent composer,
preserving existing text and attachments. A first-time floating chat uses its
normal new-chat initialization.

## Implementation

- Use Electron desktop capture in the desktop process. Prefer the mascot's display;
  accept the system-selected source on Linux/PipeWire. Bound image dimensions and
  bytes. Hide the menu, mascot, and compact chat before capture; restore floating
  windows on success, failure, or cancellation without changing preferences.
- Check macOS Screen Recording independently through Electron, reusing the existing
  System Settings destination. Do not require Accessibility, the Computer Use
  setting, or its runtime. Surface denied permission and empty/failed capture.
- Use a bounded desktop-owned pending handoff with a stable image ID and a pinned
  destination. Subscribe and pull when the composer is ready; acknowledge after
  insertion. Retain pending handoffs across renderer loading/reloads and show
  retry/discard controls when attachment is blocked. Do not silently change a
  claimed destination or lose drafts. A full application restart before delivery
  is outside the in-memory handoff guarantee; delivered images use existing draft
  persistence.
- Reuse composer attachment storage, hydration, persistence, and provider limits.
  Respect pending user-input questions. Do not send automatically.
- Keep new IPC restricted to the registered compact-chat main frame. Release
  pending capture data when the floating assistant is disabled or the app quits.

## Acceptance and validation

| Requirement                                                    | Evidence required                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Menu action and capture order                                  | Desktop menu and coordinator tests                                             |
| macOS screen-only permission and existing settings link        | Capture tests, including Accessibility independence                            |
| Windows, Linux/X11 and PipeWire source handling                | Platform/source-selection unit tests; native certification reported separately |
| Preserve and append to the selected/new floating draft         | Browser test using composer store and actual compact shell                     |
| Loading, retries, duplicate notifications, destination changes | Handoff and receiver tests                                                     |
| Capture failures, window restoration, limits                   | Focused desktop/browser tests                                                  |
| Existing floating chat behavior                                | Existing floating window and compact chat tests                                |
| Repository checks                                              | bun fmt, bun lint, bun typecheck; focused Vitest/browser tests                 |

No commits or pushes. No Rust changes or new dependencies are planned.

## Implementation notes

- Capture uses JPEG at quality 85, with the longest edge capped at 2560 pixels and
  the existing provider image-byte limit. Native capture has a 30-second timeout;
  a still-pending OS request cannot overlap another capture.
- A screenshot's destination is pinned at capture time when the floating composer
  is already known, or when a cold-start composer first claims it. A changed
  destination produces retry/discard guidance instead of redirecting the image.
- Existing composer persistence is flushed after insertion. If storage is full,
  the existing non-persisted-image warning applies; the image remains usable in
  the current draft.
- Switching away from an image/file-only floating draft now uses the existing
  discard confirmation, preserving screenshots when the user cancels.

## Validation status

Focused capture, IPC, window, attachment, settings, and browser checks pass. The
desktop bundle builds, and the repository-wide format, lint, and typecheck gates
pass. The follow-up expands the original scope to repair the two broader
floating-chat failures: replacement ownership records retain their new identity,
composer content moves before live ledger listeners expose replacement metadata,
restoration follows the durable replacement through missed revisions, and
synchronization fixtures use the current ownership and delivery protocols.

Native Electron capture checks pass on macOS and Linux/X11. Windows, Wayland
portal interaction, multi-monitor hardware, and packaged permission prompts
still need their respective desktop environments.

See [validation details](../validation/mascot-screenshot-to-chat.md).
