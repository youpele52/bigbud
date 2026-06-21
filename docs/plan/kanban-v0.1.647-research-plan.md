# Kanban Research Plan for v0.1.647

Related release note: [v0.1.647 note](/Users/youpele/.bigbud/userdata/notes/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/v0.1.647.md)

## Summary

The existing bigbud notes feature is the right starting point for the kanban board. It already has the right panel integration, project/global scope toggle, markdown-backed persistence, autosave flow, context menus, and a drag payload that the composer already accepts. The kanban feature should reuse that shell heavily, but it should not be modeled as "threads with derived status" like Synara.

Synara is useful mainly for its board UI architecture:

- a pure board derivation layer separated from React
- column and card components split cleanly
- `dnd-kit` usage isolated to the board surface
- explicit drop semantics instead of implicit mutation
- small UI store for persisted ordering / optimistic drag state

What should not be copied from Synara is the core data model. Synara's kanban is a control center over chat threads. Column placement is derived from runtime state (`draft`, `inProgress`, `done`) and drag-to-in-progress dispatches a prompt into a running thread. That is materially different from bigbud's requested feature, which is closer to structured notes/tasks with persisted board state: `backlog`, `todo`, `ongoing`, `done`, global or project scoped, and draggable to the composer.

## What Bigbud Already Has to Reuse

Relevant local implementation:

- [apps/web/src/components/notes/NotesPanel.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/notes/NotesPanel.tsx)
- [apps/web/src/components/notes/NotesPanel.list.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/notes/NotesPanel.list.tsx)
- [apps/web/src/stores/notes/notesPanel.coordinator.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/stores/notes/notesPanel.coordinator.ts)
- [apps/web/src/stores/rightPanel/rightPanelTabs.store.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/stores/rightPanel/rightPanelTabs.store.ts)
- [apps/web/src/components/right-panel/RightPanelHost.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/right-panel/RightPanelHost.tsx)
- [apps/server/src/persistence/Layers/ProjectionNotes.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/persistence/Layers/ProjectionNotes.ts)
- [packages/contracts/src/server/notes.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/server/notes.ts)
- [apps/web/src/components/files/filesPanel.dnd.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/filesPanel.dnd.ts)
- [apps/web/src/components/chat/view/chat-view/chat-view-interactions.files.hooks.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/components/chat/view/chat-view/chat-view-interactions.files.hooks.ts)

Concrete reuse points:

- Right-panel singleton pattern: notes already opens/closes through the panel coordinator and tab store.
- Scope model: notes already supports `global` and `project`, which matches the request directly.
- Persistence model: notes already stores markdown files in scoped directories under server state.
- Editor behavior: markdown edit/preview, autosave, rename, duplicate, delete, open externally.
- Composer drag target: note rows already emit `BIGBUD_FILES_PANEL_DRAG_MIME`, and the composer already accepts that MIME type as a file attachment/path reference.

## What Synara Does Well

Relevant Synara files inspected:

- `/tmp/synara/apps/web/src/components/kanban/kanban.logic.ts`
- `/tmp/synara/apps/web/src/components/kanban/KanbanProjectBoardView.tsx`
- `/tmp/synara/apps/web/src/components/kanban/KanbanColumn.tsx`
- `/tmp/synara/apps/web/src/components/kanban/useKanbanBoard.ts`
- `/tmp/synara/apps/web/src/kanbanUiStore.ts`
- `/tmp/synara/apps/web/src/lib/kanbanDispatch.ts`
- `/tmp/synara/apps/web/src/components/kanban/KanbanView.tsx`

Main lessons:

- Keep the board math pure.
  Synara isolates column derivation, ordering, and drop rules in `kanban.logic.ts`. Bigbud should do the same, even if the domain is simpler.

- Keep DnD local to the board surface.
  Synara contains `dnd-kit` wiring in the board and column components instead of spreading drag logic across unrelated files. That is worth adapting directly.

- Persist only UI state that is truly UI state.
  Synara persists manual order separately from domain data. Bigbud can use the same idea for transient board preferences, but card column/state itself should live in persisted kanban data, not only in a UI store.

- Make drop behavior explicit.
  Synara distinguishes reorder-in-column from semantic drops into another column. Bigbud should mirror that separation because `backlog -> todo` is a data mutation, while drag-to-composer is an attachment action.

## What Should Be Adapted, Not Copied

1. Board location

Synara's kanban is a full route-level surface. Bigbud's requirement says this should be a right-panel item placed after Notes. The board should therefore follow the notes panel integration path, not Synara's route architecture.

2. Domain model

Synara derives columns from thread runtime. Bigbud should persist columns on each kanban card. Otherwise `backlog`, `todo`, `ongoing`, and `done` cannot remain stable independent of session state.

3. Drag semantics

Synara's main semantic drop is "draft -> in progress = dispatch task". Bigbud's requirement is different:

- card -> another kanban column: persist `status` and maybe `order`
- card -> composer: attach/link the underlying markdown card file
- optionally card -> diff/composer support surfaces later, but composer is already implementable with existing drag MIME support

4. Data persistence

Synara largely derives from existing stores. Bigbud needs first-class persisted kanban entities, likely parallel to notes persistence rather than embedded in UI state.

## Recommended Bigbud Design

Use a notes-adjacent data model rather than trying to stretch notes themselves into cards.

Suggested persisted shape per card:

- `cardId`
- `projectId | null`
- `scope`
- `title`
- `content`
- `status`: `backlog | todo | ongoing | done`
- `order`
- `createdAt`
- `updatedAt`

Suggested storage strategy:

- Keep markdown files for content and external editability.
- Store lightweight card metadata in frontmatter or sidecar metadata.
- Reuse the notes repository pattern: scoped directories under state, list/get/create/update/delete RPCs, same error handling style.

Preferred implementation shape:

1. Server

- Add contracts for kanban RPCs parallel to notes.
- Add a `ProjectionKanbanRepository` parallel to `ProjectionNotes`.
- Persist global cards under a `kanban/global` directory and project cards under `kanban/<projectId>`.
- Support list/get/create/update/delete plus a focused move/reorder mutation.

2. Web state and panel wiring

- Add `kanban` to `RightPanelTabKind`.
- Wire a `kanbanPanel.coordinator.ts` parallel to notes.
- Place the launcher/tab entry after Notes.
- Reuse the same scope toggle language and selected-card/panel-open store pattern.

3. UI composition

- Split into `KanbanPanel.tsx`, `KanbanBoard.tsx`, `KanbanColumn.tsx`, and `kanban.logic.ts`.
- Reuse notes list/sidebar ideas for scope controls, create button, and selected-card editing.
- Use `dnd-kit` for intra-board drag and column drops, following Synara's component split rather than its thread semantics.

4. Composer integration

- Make each card draggable with the same `BIGBUD_FILES_PANEL_DRAG_MIME` payload format used by notes/files.
- Under the hood, drag the card's markdown file path so composer support works without new composer logic.
- If richer behavior is wanted later, add a dedicated kanban drag MIME, but start with the existing file-entry payload because it is already supported.

## Implementation Advice

Strong recommendation: do not try to "reuse notes" by making one note equal one whole board. That will make ordering, status changes, and DnD awkward fast.

A better interpretation of "reuse most of the notes features" is:

- reuse notes panel structure
- reuse notes persistence pattern
- reuse notes scope behavior
- reuse notes markdown editing and external-open behavior
- reuse notes drag payload format

But add a dedicated kanban domain with its own card metadata and board rendering.

## Practical First Slice

A low-risk first slice would be:

1. Add a right-panel `Kanban` tab after `Notes`.
2. Support `global` / `project` scoped boards.
3. Persist cards with the four requested columns.
4. Allow drag between columns.
5. Allow drag from a card to the composer by reusing existing file drag payloads.
6. Reuse markdown editor/preview for the selected card detail view.

Leave these for a follow-up unless they are immediately needed:

- cross-column optimistic UI beyond normal local state updates
- advanced board filtering/search
- drag to diff-specific affordances beyond composer/file-path attachment
- thread-derived statuses or auto-movement rules

## Recommendation

Adapt Synara's board structure and `dnd-kit` separation, but keep bigbud's persistence and right-panel model anchored on Notes. The best result here is not a port of Synara; it is a notes-powered kanban implementation with a dedicated kanban repository and a small, clean board UI layer.
