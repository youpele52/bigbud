# Lessons for bigbud

Each lesson names the bigbud file or plan phase it lands on. Effort is engineering time for one person who already knows the area. Risk is the chance of duplicated work or a wrong continuation, not schedule risk.

The designs being copied from are OpenCode's service-mode agent (`opencode.md`) and Pi Durable, the experimental harness in the [1 October 2026 post](https://earendil.com/posts/pi-durable/). The Pi coding agent bigbud launches is the cautionary case, not the template (`pi.md`).

## Already true, or already planned

These are confirmations. They are not new work.

1. **The UI already resumes from a cursor.** The renderer stores the last applied orchestration sequence and the server replays it. OpenCode and the Pi coding agent do not replay a live stream; Pi Durable's watch API sends the current view and then deltas. Keep bigbud's replay. A durable agent does not replace it. Lands on `apps/web/src/rpc/orchestrationDeliveryCursor.ts` and the server replay paths. Effort: none. Risk: regressing to re-fetch-only would make reconnects drop timeline events.

2. **A turn is not tied to the renderer's socket.** Nothing in `apps/server/src/ws` aborts work on close. That matches OpenCode and Pi Durable, and it is the opposite of the Pi coding agent. Effort: none.

3. **The address already survives a backend restart.** Electron keeps the port, token and URL (`apps/desktop/src/backend/backendManager.ts:86–96`, `:256–264`). A Rust process is not required to give the renderer a stable place to reconnect.

4. **Reconcile before continuing.** The auto-resume plan (`docs/plans/2026-09-10-rust-coordinated-thread-auto-resume-plan.md`, Phase 1 item 3 and the invariant in the opening) and connection-resilience Phase 6 already specify a recovery intent, a `may-have-been-sent` marker before the provider call, and a refusal to replay an uncertain tool. That is the same safety choice as Pi Durable's default for a tool that is not `replay: "safe"`, and it is stricter than OpenCode's continue prompt. Effort: the Phase 6 estimate already in that plan, about two to three weeks, after the event-loop freezes are gone. Risk of building a second coordinator: high if this is redesigned instead of implemented as written.

5. **OpenCode V2 turns already outlive the bigbud server.** bigbud borrows `opencode serve --service` (`docs/reports/providers-opencode-v2.md`). The remaining hole is the at-least-once continue, which Phase 6's "do not continue while a tool may have been mid-flight" already refuses to copy blindly.

## Worth taking

1. **Classify tools, and keep the default unsafe.** Pi Durable reruns a tool after a crash only when the tool declares `replay: "safe"`. Everything else becomes an interrupted result the model can see, including the output saved so far. Phase 6 item 5 currently treats every in-flight tool as uncertain and asks the user. That default should stay. The addition is an allowlist of read-only tools (file read, search) that may rerun once, and a stored partial so the uncertain case can name the command and the output already captured. Lands on Phase 6 item 5 and the provider tool metadata in `apps/server/src/provider/`. Effort: a few days after the durable-intent rows exist. Risk: medium if a writing tool is marked safe. Ship the allowlist empty and add tools only with a test that the action is idempotent.

2. **Flush partial output on a short interval, and mark it provisional.** Pi Durable commits streamed text and tool output about every 100 ms, so a crash loses a window rather than the whole step. bigbud already coalesces assistant text into 256-character `thread.message-sent` chunks (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.helpers.ts`). OpenCode drops the open block. The Pi coding agent writes nothing until `message_end`. The gap is provider-side partials that never reach that ingestion path, especially Pi, and tool output that exists only in the child process. Lands on the Pi adapter stream path and Phase 6's resolution prompt. Effort: about a week. Risk: medium if a provisional chunk is later treated as a finished message and the resumed turn appends it again. The chunk needs a provisional flag the resume path can supersede.

3. **Park a crash loop, and show it.** OpenCode stops after 10 resume attempts. Pi Durable parks a task after 5 crash cuts and waits for an explicit retry. The auto-resume plan has leases and refuses to redispatch an ambiguous attempt; it does not yet say "this turn is parked, here is the button." Lands on Phase 6 item 7 (the thread status) and the auto-resume plan's blocked state. Effort: a few days inside that UX. Risk: low. An infinite resume would be the expensive failure.

4. **Give the Pi process an owner that stays up.** The coding agent aborts when stdin ends (`pi.md`). Keeping the renderer's WebSocket open does not keep that stdin open. The process that spawned `pi --mode rpc` has to survive a TypeScript server restart, the way OpenCode's daemon survives because it was never a child of bigbud. That owner is the Rust background-service plan (`docs/plans/2026-10-15-rust-background-service-plan.md`), which already proposes owning backend lifetime. A separate "Pi nanny" would be a second owner. Effort: that plan's size, not a side task. Risk of a one-off supervisor: high. Until that owner exists, a backend crash ends Pi turns, and the honest behavior is the one Phase 6 already specifies for an uncertain tool.

5. **Use `get_entries` after a Pi restart.** The RPC command `get_entries {since}` is a durable cursor over the session file, and bigbud does not call it (`pi.md`). It does not resume the dead turn. It does let bigbud see messages the file has that the transcript missed, and the reverse. Lands on `apps/server/src/provider/Layers/Pi/Adapter.methods.ts`. Effort: a few days. Risk: low. This is reconciliation, which the auto-resume invariant already requires.

## Leave alone

1. **Do not embed `@earendil-works/pi-durable`.** The README marks the API experimental. The coding agent does not use it, and the post says the coding agent is not being replaced. bigbud would gain a second transcript store and a runtime that covers none of Codex, Claude, Copilot or OpenCode. Canonical state stays in TypeScript SQLite (`docs/plans/2026-08-25-rust-systems-core-plan.md`).

2. **Do not adopt OpenCode's synthetic continue as the default after a tool has started.** It is how OpenCode gets unattended resume, and it is also how a shell command runs twice. Phase 6 already limits automatic continue to a cut model request with no tool in flight. That split matches Pi Durable more closely than it matches OpenCode, and it should stay.

3. **Do not replace orchestration replay with "attach to current view."** Pi Durable and OpenCode both do that for their own clients. bigbud's timeline is an event log with a cursor. Attachment-only would drop the events a disconnected window missed, unless every projection can be rebuilt from a snapshot. That is a larger change than durability needs.
