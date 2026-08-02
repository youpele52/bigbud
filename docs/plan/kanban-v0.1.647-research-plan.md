# Kanban Implementation Plan for v0.1.647

Related release note: [v0.1.647 note](/Users/youpele/.bigbud/userdata/notes/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/v0.1.647.md)

## Goal

Add a right-panel Kanban surface, placed after Notes, with four persisted columns:

- `backlog`
- `todo`
- `ongoing`
- `done`

The board must support:

- global and project scope
- drag between columns
- drag to the composer
- markdown-backed card content
- the same general reliability expectations as notes, files, and other right-panel tools

This item should be implemented as a first-class kanban feature, not by stretching notes into a shape they do not fit.

## Current Constraints From The Codebase

The existing Notes feature is the right integration model, but not the right concrete implementation to extend inline.

Relevant files:

- [apps/web/src/components/notes/NotesPanel.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/notes/NotesPanel.tsx)
- [apps/web/src/components/notes/NotesPanel.list.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/notes/NotesPanel.list.tsx)
- [apps/web/src/stores/notes/notesPanel.store.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/stores/notes/notesPanel.store.ts)
- [apps/web/src/stores/notes/notesPanel.coordinator.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/stores/notes/notesPanel.coordinator.ts)
- [apps/web/src/components/right-panel/RightPanelHost.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/right-panel/RightPanelHost.tsx)
- [apps/web/src/components/right-panel/RightPanelTabs.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/right-panel/RightPanelTabs.tsx)
- [apps/web/src/components/right-panel/RightPanelLauncher.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/right-panel/RightPanelLauncher.tsx)
- [apps/server/src/persistence/Layers/ProjectionNotes.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/persistence/Layers/ProjectionNotes.ts)
- [apps/server/src/persistence/Services/ProjectionNotes.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/persistence/Services/ProjectionNotes.ts)
- [apps/server/src/ws/wsRpcHandlers.notes.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/wsRpcHandlers.notes.ts)
- [packages/contracts/src/server/notes.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/server/notes.ts)
- [packages/contracts/src/server/rpc.workspace.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/server/rpc.workspace.ts)
- [apps/web/src/components/files/filesPanel.dnd.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/filesPanel.dnd.ts)

Important observations:

1. Notes already proves the right panel, scope toggle, markdown persistence, and composer drag path.
2. `@dnd-kit` is already installed and used in `apps/web`, so board DnD can follow local precedent.
3. Notes persistence is file-backed, not SQL-backed. Kanban should stay in that family unless there is a hard reason not to.
4. [NotesPanel.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/notes/NotesPanel.tsx) is already 651 lines. Extending it or copying its shape directly would deepen existing file-size debt and violate repo expectations for new work.

## Recommendation

Build Kanban as a dedicated projection-backed feature that reuses the Notes shell patterns, not Notes implementation files.

The correct reuse boundary is:

- reuse notes right-panel lifecycle
- reuse notes scope behavior
- reuse notes markdown detail editing pattern
- reuse notes drag payload format
- reuse notes persistence architecture style

Do not reuse notes by making cards equal notes in the same repository or by embedding board state into one giant markdown file.

## Data Model

Persist one markdown file per card plus one JSON metadata file per card.

Recommended persisted shape:

- `cardId`
- `projectId | null`
- `scope`
- `status`: `backlog | todo | ongoing | done`
- `order`: number
- `createdAt`
- `updatedAt`
- `title`
- `absolutePath`
- `content`

Recommended storage layout:

- global cards:
  `stateDir/kanban/global/<card-id>.md`
  `stateDir/kanban/global/<card-id>.json`
- project cards:
  `stateDir/kanban/<project-id>/<card-id>.md`
  `stateDir/kanban/<project-id>/<card-id>.json`

Why JSON sidecars instead of frontmatter:

1. The repo does not currently have a general frontmatter parsing stack for runtime app data.
2. Sidecars keep markdown content clean for external editing.
3. Sidecars make metadata validation simpler with Effect schemas.
4. Metadata corruption can be isolated from content corruption more cleanly.
5. Column/order updates avoid rewriting markdown bodies.

Title behavior:

- persist `title` in metadata for fast board rendering and empty-card support
- keep content as markdown body
- when editing in the detail pane, support explicit title edits rather than deriving title only from H1

This is a better fit for kanban than notes, where title derivation from content is acceptable.

## Persistence Behavior

Repository operations should be explicit and small:

- `list`
- `getById`
- `create`
- `update`
- `deleteById`
- `move`
- `reorderWithinStatus`

Behavior requirements:

1. Stable IDs
   Card IDs must not change when title/content changes.

2. Predictable ordering
   Order is persisted in metadata, not inferred from timestamps.

3. Scope isolation
   Project boards only show project cards. Global boards show global cards only.
   Unlike notes, there is no clear value in mixing project + global cards in one board view for the first slice.

4. External edit tolerance
   If a markdown file changes outside the app, reload should preserve metadata and update `updatedAt`.

5. Missing sidecar/file handling
   The repository should fail soft where possible:
   - missing markdown with existing sidecar: skip or surface as invalid card
   - missing sidecar with existing markdown: ignore for first slice rather than inventing metadata
   - invalid JSON: skip card and log internally rather than crashing list calls

6. Atomicity expectations
   Create, update, move, and delete should write both artifacts in a deterministic order.
   Full filesystem atomicity is not required, but partial-write behavior must be understood and tested.

## Contracts And RPC

Add a dedicated kanban contract parallel to notes.

New contract file:

- [packages/contracts/src/server/kanban.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/server/kanban.ts)

New RPC additions in:

- [packages/contracts/src/constants/websocket.constant.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/constants/websocket.constant.ts)
- [packages/contracts/src/server/rpc.workspace.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/server/rpc.workspace.ts)
- [packages/contracts/src/index.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/index.ts)

Recommended methods:

- `kanban.list`
- `kanban.get`
- `kanban.create`
- `kanban.update`
- `kanban.delete`
- `kanban.move`

Recommended input/result shapes:

- `KanbanScope`
- `KanbanStatus`
- `KanbanCardSummary`
- `KanbanCard`
- `KanbanListInput`
- `KanbanListResult`
- `KanbanGetInput`
- `KanbanCreateInput`
- `KanbanUpdateInput`
- `KanbanDeleteInput`
- `KanbanDeleteResult`
- `KanbanMoveInput`

Keep `move` separate from `update`. This matters because drag between columns is a semantic board operation with concurrency and ordering implications, not just a generic content update.

## Server Implementation Plan

### 1. Add repository service

Create:

- `apps/server/src/persistence/Services/ProjectionKanban.ts`
- `apps/server/src/persistence/Layers/ProjectionKanban.ts`

Mirror the notes repository layering, but do not copy its derivation shortcuts blindly.

Key differences from notes:

- status/order live in metadata
- title is explicit
- listing should group/sort by status and order
- `move` should adjust neighboring card orders deterministically

### 2. Add WS handlers

Create:

- `apps/server/src/ws/wsRpcHandlers.kanban.ts`

Then wire into:

- `apps/server/src/ws/ws.ts`

The handler should follow the same `observeRpcEffect` instrumentation pattern as notes.

### 3. Native API surface

Extend:

- `apps/web/src/rpc/wsRpcClient.ts`
- `apps/web/src/rpc/wsNativeApi.ts`
- any matching API tests

Expose:

- `api.kanban.list`
- `api.kanban.get`
- `api.kanban.create`
- `api.kanban.update`
- `api.kanban.delete`
- `api.kanban.move`

## Web State And Panel Wiring Plan

### 1. Right panel registration

Update:

- [apps/web/src/stores/rightPanel/rightPanelTabs.store.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/stores/rightPanel/rightPanelTabs.store.ts)
- [apps/web/src/stores/rightPanel/rightPanel.coordinator.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/stores/rightPanel/rightPanel.coordinator.ts)
- [apps/web/src/components/right-panel/RightPanelTabs.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/right-panel/RightPanelTabs.tsx)
- [apps/web/src/components/right-panel/RightPanelLauncher.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/right-panel/RightPanelLauncher.tsx)
- [apps/web/src/components/right-panel/RightPanelHost.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/right-panel/RightPanelHost.tsx)

Add a new singleton tab kind:

- `kanban`

Place it after `notes` in launcher and tab affordances where the UI order is explicit.

### 2. Kanban panel store

Create:

- `apps/web/src/stores/kanban/kanbanPanel.store.ts`
- `apps/web/src/stores/kanban/kanbanPanel.coordinator.ts`

Recommended state:

- `open`
- `scope`
- `selectedCardId`
- `previewMode`

This mirrors notes closely enough to keep the mental model consistent.

## Web UI Composition Plan

Do not create one large component. Keep files under 400 lines by splitting early.

Recommended file map:

- `apps/web/src/components/kanban/KanbanPanel.tsx`
- `apps/web/src/components/kanban/KanbanPanel.toolbar.tsx`
- `apps/web/src/components/kanban/KanbanBoard.tsx`
- `apps/web/src/components/kanban/KanbanColumn.tsx`
- `apps/web/src/components/kanban/KanbanCard.tsx`
- `apps/web/src/components/kanban/KanbanDetail.tsx`
- `apps/web/src/components/kanban/kanban.logic.ts`
- `apps/web/src/components/kanban/kanban.dnd.ts`
- optional tests split by concern

Recommended layout:

1. Header / scope controls
   Reuse notes-style global/project toggle and create action.

2. Board surface
   Four columns in fixed order.

3. Detail pane
   Selected card editor/preview on the side, reusing notes-like markdown editing behavior.

This yields a right-panel layout similar to notes:

- list-like navigation surface on the left
- content/detail surface on the right

Except the left side is a board instead of a vertical note list.

## DnD Plan

Use `@dnd-kit` only inside the board surface.

Recommended behavior split:

1. Reorder within same column
   Pure ordering update.

2. Move across columns
   Status change plus order update.

3. Drag card to composer
   Reuse `BIGBUD_FILES_PANEL_DRAG_MIME` with the card markdown file path.

4. Drag card into unsupported surfaces
   No-op for first slice.

Implementation guidance:

- keep board derivation and reorder math in `kanban.logic.ts`
- keep DnD wiring in `KanbanBoard.tsx` and `KanbanColumn.tsx`
- use optimistic local state during drag, then persist through `kanban.move`
- on failure, snap back to last server state and show a toast

Do not invent a dedicated kanban composer protocol in v0.1.647. The existing file drag payload is already accepted by the composer and matches the requirement that threads receive text/file paths only.

## Notes Reuse Strategy

Reusing notes does not mean sharing files directly.

Safe reuse:

- scope toggle UX
- markdown edit / preview behavior
- context menu affordances
- open externally
- copy path
- drag payload shape

Unsafe reuse:

- stuffing board state into note markdown
- adding kanban code into `NotesPanel.tsx`
- reusing note IDs for cards
- deriving board order from timestamps

## Context Menu And Card Actions

Recommended first-slice card actions:

- open
- rename
- duplicate
- delete
- open externally
- copy path
- move to backlog
- move to todo
- move to ongoing
- move to done

These match notes/file affordances and reduce friction when DnD is not ideal.

## Refresh And Sync Strategy

Notes currently uses polling to refresh every 3 seconds. Kanban can start with the same model for release safety.

Recommended first-slice behavior:

- initial load on panel mount / scope change
- reload selected card on selection change
- 3-second board refresh loop
- do not overwrite unsaved local edits in the detail pane
- reconcile remote move/update changes when local detail content matches last saved content

This is not perfect, but it is predictable and aligned with current notes behavior.

## Concurrency Rules

There are two important write classes:

1. Content writes
   Protected with `expectedUpdatedAt` like notes.

2. Move/reorder writes
   Use server-side ordering logic and return updated moved card or refreshed summaries.

Recommended rule:

- `kanban.update` should reject stale content writes
- `kanban.move` should operate on latest server ordering and return authoritative state

This avoids trusting stale local order after multiple drags or cross-surface edits.

## Testing Plan

### Server tests

Add focused tests for:

- list project vs global scope
- create card writes markdown + sidecar
- update card content and title
- move across columns
- reorder within column
- delete removes both files
- invalid sidecar is skipped safely
- stale `expectedUpdatedAt` update is rejected

Likely files:

- `apps/server/src/persistence/Layers/ProjectionKanban.test.ts`
- `apps/server/src/ws/wsRpcHandlers.kanban.test.ts`

### Web tests

Add focused tests for:

- right-panel tab open/close behavior
- launcher visibility/order
- create/select/edit card flow
- drag payload to composer uses existing file MIME
- optimistic drag state rollback on move failure
- scope switching

Likely files:

- `apps/web/src/stores/rightPanel/rightPanelTabs.store.test.ts`
- `apps/web/src/components/right-panel/RightPanelHost.test.tsx`
- `apps/web/src/components/kanban/KanbanPanel.test.tsx`
- `apps/web/src/components/kanban/kanban.logic.test.ts`

Keep test files split by concern to stay under the repo file-length limits.

## Delivery Plan

### Phase 1: Contracts and server persistence

- add kanban contract types and RPC definitions
- add projection service + layer
- add WS handlers
- wire web native API client surface
- cover repository and handler tests

Exit criteria:

- server can create/list/get/update/delete/move cards without UI

### Phase 2: Right panel integration

- register `kanban` in right-panel stores
- add launcher and tab UI
- add coordinator/store
- render placeholder panel shell

Exit criteria:

- kanban tab opens/closes correctly and sits after notes

### Phase 3: Board UI and detail editor

- implement four-column board
- implement selected-card detail pane
- implement create/rename/delete/context menu
- reuse markdown edit/preview pattern

Exit criteria:

- cards can be managed end-to-end without DnD

### Phase 4: DnD and composer integration

- add intra-board reordering
- add cross-column moves
- add drag to composer via existing file MIME payload
- add failure rollback

Exit criteria:

- user can move cards between columns and drag a card into the composer

### Phase 5: hardening

- invalid file handling
- stale update handling
- polling refresh reconciliation
- tests and fit-and-finish

Exit criteria:

- behavior remains predictable under external edits, reloads, and move conflicts

## Non-Goals For v0.1.647

Do not include these in the first delivery:

- thread-derived kanban statuses
- cross-board filtering and saved views
- nested sub-tasks
- swimlanes
- diff-panel-specific drops
- multi-select drag
- route-level kanban page
- real-time subscriptions beyond current polling patterns

## Main Risks

1. File-shape drift
   If markdown and metadata files get out of sync, card discovery can become noisy. The repository must define conservative fallback behavior.

2. Scope confusion
   Notes global scope can include project notes. Kanban should avoid that mixing in the first slice to keep board semantics obvious.

3. Oversized components
   Copying notes patterns into one large React file would create immediate maintenance debt.

4. Drag complexity
   Mixing board DnD semantics with composer drag semantics in one abstraction will create brittle code if not separated cleanly.

5. Order corruption
   If move/reorder logic is spread across client and server without one authoritative rule set, cards will jump unexpectedly after refresh.

## Final Recommendation

Implement Kanban as a dedicated right-panel feature with:

- its own contracts
- its own projection repository
- markdown content files plus JSON metadata sidecars
- explicit move/reorder RPCs
- a split React board UI built around `@dnd-kit`
- composer integration by reusing the existing file drag MIME

This is the most robust path that still reuses the proven Notes integration model and stays aligned with the repo's performance, reliability, and maintainability requirements.
