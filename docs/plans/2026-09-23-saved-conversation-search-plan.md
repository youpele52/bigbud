# Saved conversation search

**Date:** 23 September, 2026

**Status:** Implemented and validated

## Repository evidence

- `SearchPalette.content.tsx` searches only `useStore().threads`, so unloaded thread messages are absent.
- `projection_thread_messages` is the durable message read model. The message projector upserts, reverts, and deletes rows inside the projection pipeline; thread ownership migrations cascade direct deletion.
- Catalog queries and orchestration WebSocket RPCs already provide bounded server reads without `getSnapshot`. Project/file search uses debounced React Query calls. The palette navigates by thread and message ID.

## Acceptance criteria and implementation

1. Add a persistent SQLite FTS5 trigram index over completed projected message text. Backfill existing rows in a migration, and maintain it with triggers on insert, update, and delete. Index streaming text only when it completes so partial token updates do not repeatedly rewrite a growing document. Trigger maintenance keeps event replay, revert, thread/project deletion, and baseline restore consistent with the projection row lifecycle.
2. Add a bounded orchestration catalog search query and typed RPC. Search only visible standard threads in non-deleting projects. Return real message/thread/project IDs and titles, a bounded snippet, a keyset cursor, and an explicit unavailable state when the index cannot be trusted. Do not load a snapshot or all threads.
3. Keep case-insensitive substring matching for queries of three to 160 Unicode code points. Explain both limits in the palette. Never shorten a longer query into a match the user did not type. Use SQL parameters for user text and cap page size.
4. Replace client-state message scanning in Search Palette with debounced server pages. Preserve current file, project, and thread-title search behavior, message focus/navigation, remote-project access behavior, and loading/error states. `See more` requests another server page. When a hit is outside the loaded message window, load a bounded detail page anchored at that message before focusing it.
5. Focused tests cover migration backfill, updates, replay-style delete/reinsert, deletion, pagination, visibility filtering, unavailable index, and palette integration. Run `bun fmt`, `bun lint`, `bun typecheck`, and relevant Vitest commands; review each criterion and keep all edited source/test files at 400 lines or less.

## Design limits

- Search indexes projected messages that are already persisted on this server. It does not query remote workspace files or remote agent storage.
- Trigram indexing needs at least three Unicode code points, not three JavaScript UTF-16 code units. For example, `😀a` is two code points despite its UTF-16 length of three; SQLite FTS5 trigram returns no match for it. The server and palette skip saved-message search and show the minimum-length hint for that input rather than imply that the index was searched. Supporting shorter queries would require a separate search strategy. Very large legacy databases pay a one-time index build during migration. Results reflect the committed projection and may lag canonical events until replay catches up.
- Saved-message search does not run for queries outside the three-to-160-code-point range. It sends the trimmed input without changing case, so Unicode lowercasing cannot change the length check. Project, file, and thread-title search keep their existing normalization and full input.

## Validation and review

- `bun fmt`, `bun lint`, and `bun typecheck` passed; typecheck completed all nine packages. Lint reported zero errors, plus pre-existing warnings and existing oversized test files outside this change.
- Focused server tests passed (4 files, 13 tests) for migration backfill, restart, update, replay-style reinsertion, cascade deletion, visibility, punctuation, Unicode case matching, long-query snippets, over-limit rejection, code-point minimum, pagination, stale/unavailable states, anchored detail, and RPC dispatch.
- Focused web tests passed (5 files, 41 tests) for the query adapter, Unicode query length, existing Search Palette matching, bounded bootstrap from absent thread state, and store sync behavior. Shared string tests passed (1 file, 7 tests). Chromium browser tests passed (1 file, 7 tests) for successful search followed by failed refetch, server-page `See more`, over-limit and short-query guidance, preserving typed Unicode case at the limit, selecting an unloaded old message through anchored detail and focus, and navigation from a hit whose thread was absent from client state.
- The search query reads a bounded FTS5 projection page and never requests a full orchestration snapshot. FTS5's match highlight locates snippets consistently with Unicode case matching; the capped query and context fit within a bounded 230-character snippet. The palette hides cached message hits and pagination on query error while retaining project, thread-title, and file results. A selected old message is loaded through an anchored bounded detail request before focus.
- Direct in-memory SQLite FTS5 trigram validation: with rows `😀a` and `😀ab`, quoted `MATCH '"😀a"'` returned no rows (two code points), while `MATCH '"😀ab"'` returned the matching row (three code points). Server, web query, shared utility, and browser tests cover the same minimum-length behavior.
