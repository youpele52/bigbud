# Interactive replies: native question panel, render_html guidance, and a single outbound link message

**Date:** 13 November, 2026
**Status:** Implemented (Phase 1 and 3 in `2c6d307acd`, `b88b1921d1`, `9bfb3c2a6a`, `f76f8109c4`; Phase 2 in `a6a83cda84`)
**Owner:** bigbud core

## Summary

Three related improvements to how agents interact with the user inside a thread:

1. **Native question panel.** Replace the read-only "Input required" card with a thread-specific panel docked above the composer. Every question shows clickable options, and the composer editor itself is the free-text field, so the user can add context, images and files. Attachments added while answering are sent automatically as the next message, labelled so the agent knows they belong to the answer. Works for all providers with no protocol change.
2. **`render_html` guidance.** The tool is already in the capability LP, delta and skit. Agents lack a reason to pick it and a recipe for doing it well. Sharpen the Track triggers, add an explicit anti-pattern against HTML questions, provide a compact style recipe in the guide, and forward the rest of the theme tokens into the frame.
3. **One outbound link message.** Rendered visuals can offer source links that open through bigbud's normal link routing. The only script-to-app connection is a single typed message from the sandbox; the CSP and inbound surface do not change.

Agent-authored HTML never becomes a question or input channel.

## Related Work

- Changelog entry "Visual Replies Right in Chat" in `docs/CHANGELOG.md` (introduced `render_html`).
- Capability Track `chat.render.html` in `apps/server/src/capabilities/BigbudCapabilityTracks.ts:72`.

## Problem

1. **The native question card is read-only.** The pending branch in `apps/web/src/components/chat/messages/MessagesTimeline.rows.tsx` renders `UserInputQuestions`, which lists options as plain text, then tells the user to "Type your answer below". The option-selection draft logic exists (`togglePendingUserInputOptionSelection`, `setPendingUserInputCustomAnswer` in `apps/web/src/logic/user-input/pending.logic.ts`) and the click handler `onToggleActivePendingUserInputOption` is built at `ChatView.composerHandlers.logic.ts:295`, but no non-test component calls it. Only the custom-answer handler is consumed (`chat-view-interactions.hooks.ts:238`).
2. **Attachments cannot be part of an answer.** Every provider protocol accepts text-only answers (Claude elicitation content is string, number, boolean or string array, see `Adapter.approval.userInput.utils.ts`; Codex, OpenCode, Copilot, Pi and Cursor are the same shape). `respondToPendingUserInput` in `ChatView.sendTurn.actions.pending.ts` sends trimmed text only. A user who wants to answer with a screenshot has no path.
3. **Agents do not choose `render_html` when a visual would help.** The Track has one generic trigger. The guide served by `read_capability_guide` has no recipe, and nothing says questions are out of scope.
4. **Source links inside a visual are fatal.** The inner document CSP sets `frame-src 'none'`, `form-action 'none'`, `connect-src 'none'`, and the guard frame removes the visual on any trusted `frame-src` violation (`HtmlRenderFrame.guard.ts`). A research dashboard cannot link to its sources.
5. **Dashboards get a narrow theme.** Only ten CSS variables are forwarded (`HTML_RENDER_THEME_PROPERTIES` in `HtmlRenderFrame.document.ts`). `apps/web/src/index.css` also defines `--chart-1` to `--chart-5`, `--accent`, `--secondary`, `--destructive`, `--popover` and `--radius`.

## Goals

- A pending question appears as a modern, bigbud-styled panel docked above the composer, thread-specific, never a dialog.
- Every question offers clickable options; the composer editor is always available for free text, images and files.
- Attachments added while answering are delivered to the agent as the next message, explicitly tied to the answer, with no provider protocol change.
- Agents choose `render_html` for multi-source research, comparisons and metric summaries, and never for questions.
- Rendered visuals can link to sources; clicks route through `openLink` and leave the visual intact.
- Rendered visuals receive the full theme token set.

## Non-Goals

- No general JavaScript bridge, no RPC, no app state access, and no way for rendered HTML to start a turn or submit an answer.
- No relaxation of the sandbox CSP.
- No HTML-based question or form protocol. Questions remain `user-input.requested` payloads.
- No provider-specific changes to how questions are emitted or answered.
- No bigbud-owned web search tool.

## Current State

### Native question flow

- Contract: `UserInputQuestion` in `packages/contracts/src/orchestration/providerRuntime.payloads.ts:205` with `options`, `multiSelect` and optional `field` (`allowCustom`, type, bounds).
- Emitters: Claude, Codex, OpenCode V2, Copilot, Cursor, Pi, Muse (all under `apps/server/src/provider/Layers/`).
- Web: the composer enters `isOpencodePendingUserInputMode` (true whenever any question is pending, for every provider, despite the name); `ChatViewComposerHeader.tsx` already stacks content above the editor (prompt queue); draft answers live per request id in `pendingUserInputAnswersByRequestId`.
- **Two answer paths exist and only the weaker one is live.** The live path is `respondToPendingUserInput` in `ChatView.sendTurn.actions.pending.ts`: it takes the composer text and sends that same string as the answer to every question in the request, ignoring draft selections. The richer per-question path is dead code: `onAdvanceActivePendingUserInput` in `ChatView.composerHandlers.logic.ts` (submits `activePendingResolvedAnswers`, built by `buildPendingUserInputAnswers` from chips plus custom text) has no caller, `onToggleActivePendingUserInputOption` has no caller, and `pendingAction` in `chat-view-interactions.hooks.ts:265` is gated on `!thread.isOpencodePendingUserInputMode`, which is always false while a question is pending, so the per-question primary action never renders. Only the previous-question button and the custom-answer text handler are wired.
- **Attachments are hidden while a question is pending.** `ChatViewComposerPreviews.tsx` skips image and file previews when `isOpencodePendingUserInputMode` is true, and the pending send path never reads them.
- Prompt queue: `QueuedPromptSubmission` in `ChatView.promptQueue.logic.ts:33` carries `text` and `attachments`; the server flushes queued prompts durably (`QueuedPromptFlush.logic.ts`, `deciderThreads.turn.queue.release.ts`).
- Since this plan was written, Phase 1 and Phase 3 landed in commits `2c6d307acd`, `b88b1921d1`, `9bfb3c2a6a` and `f76f8109c4`. The `chat.render.html` Track now lives in `apps/server/src/capabilities/BigbudCapabilityTracks.workspace.ts`, and both it and the `render_html` tool description promise that bigbud renders native questions "with clickable options and a free-text field with attachments". Phase 2 makes that promise true.
- Prompt queue: `QueuedPromptSubmission` in `ChatView.promptQueue.logic.ts:33` carries `text` and `attachments`; the server flushes queued prompts durably (`QueuedPromptFlush.logic.ts`, `deciderThreads.turn.queue.release.ts`).

### `render_html` pipeline

- Contract: `packages/contracts/src/orchestration/htmlRender.ts`, title 1 to 120 characters, html 1 to 24,000 characters, activity kind `html.render.published`.
- Server: `apps/server/src/orchestration-tools/HtmlRenderTool.ts` validates, dedupes by invocation identity, requires an active turn, appends a thread activity. Reached through the thread-tools HTTP bridge and every provider bridge.
- Prompt exposure: LP at thread start (`serializeCapabilityLp`, 2,000-token hard limit), delta on catalog change, skit every fifth human prompt (`CAPABILITY_SKIT_PROMPT_INTERVAL` in `ProviderCommandReactorSessionOps.capabilityContext.ts`). Guide sections served by `readCapabilityGuide` with an 8,000-character limit (`CapabilityCatalog.operations.ts`).
- Web: `HtmlRenderFrame.tsx` hosts a guard iframe that hosts the agent document. Only `bigbud:html-theme` (inward) and `bigbud:html-height` (outward) are relayed; the host accepts height only from its own frame's `contentWindow`.
- Link routing: `apps/web/src/lib/openLink.ts` validates protocols and honours the "open web links in app" setting.

## Phases

### Phase 1: `render_html` guidance and theme tokens

Dependencies: none. Text and constants only.

1. `BigbudCapabilityTracks.ts`, Track `chat.render.html`:
   - `triggers`: add results gathered from several web sources or searches; comparisons across options, providers or products; small metric sets that read better as tiles or a chart.
   - `antiPatterns`: "Never use render_html to ask the user a question or collect input. Use your native question tool; bigbud renders it with clickable options and a free-text field with attachments."
   - `workflow`: a compact recipe. Structure: a heading, source cards or a comparison table, one-line takeaway per item. Styling: the forwarded theme tokens, 14px inherited font, `var(--radius)`, `var(--chart-n)` for series colours. Links: ordinary `<a href>` to http or https sources; they open in the user's browser (Phase 3). Keep under the 24,000-character limit; no external assets; images as data URLs.
   - `examples`: "Summarise five search results as source cards with a one-line takeaway each." and "Compare three providers in a table with a recommendation row."
   - Keep the LP summary sentence as is; the catalog tests assert budgets.
2. Mirror the question anti-pattern in `HTML_RENDER_TOOL_DESCRIPTION` (`htmlRenderTool.shared.ts`) so providers that never load the guide still see it.
3. Extend `HTML_RENDER_THEME_PROPERTIES` with `--chart-1` to `--chart-5`, `--accent`, `--accent-foreground`, `--secondary`, `--secondary-foreground`, `--destructive`, `--popover`, `--popover-foreground`, `--radius`, with defaults in the inner document's `:root`. The inner allow-list is generated from the same constant.
4. Expected result: agents pick dashboards for research output, avoid HTML questions, and dashboards look native.

### Phase 2: Native question panel docked above the composer

Dependencies: none on the other phases. The main piece of work.

1. **One answer path.** Revive the dead per-question flow instead of adding a third path. The composer's pending send (the branch in `ChatView.sendTurn.logic.ts` that calls `respondToPendingUserInput`) must submit `activePendingResolvedAnswers` (chips plus custom text per question, built by `buildPendingUserInputAnswers`) rather than broadcasting the composer text to every question. Keep `respondToPendingUserInput` as the single function that resolves a request; change its inputs, not its callers' shape. Delete or rewire `onAdvanceActivePendingUserInput` so there is exactly one submit path. Fix the `pendingAction` gate in `chat-view-interactions.hooks.ts:265` so the per-question primary action renders while a question is pending; renaming `isOpencodePendingUserInputMode` is out of scope.
2. **Component.** Add `PendingUserInputPanel.tsx` under `apps/web/src/components/chat/view/chat-view/` with a `.logic.ts` sibling for derivation. Rendered from `ChatViewComposerHeader.tsx` when `thread.activePendingUserInput` exists, in the same slot pattern as the approval panel and above the prompt queue. Visual: rounded card with a subtle "Needs you" label, question header and text, option chips, a "2 of 4" indicator with previous and next for multi-question requests, and a one-line hint for the composer. Use shadcn `Button` and `Badge`, `text-sm` body, `text-xs` hints, theme colours only. Keep every file at or under 400 lines.
3. **Options.** Chips call the existing `onToggleActivePendingUserInputOption`. Single select replaces, multi select toggles, respecting `field.type`, `allowCustom` and bounds already encoded in `pending.logic.ts`. Selected chips show a filled state. The composer editor remains the free-text field for the active question through `onChangeActivePendingUserInputCustomAnswer`; its pending placeholder becomes "Add context, or just send your selection". A required question with no selection and no text cannot be sent; optional ones can.
4. **Attachments.** Un-hide image and file previews in `ChatViewComposerPreviews.tsx` while a question is pending so attachments behave as usual. On send, the question resolves first with text and selections only. If the composer holds attachments, the client then submits one `QueuedPromptSubmission` through the existing prompt queue with those attachments and the text "The attached files are part of my answer to: <question header>" (one line per answered question). The queue delivers it when the provider is next idle, so the agent sees the answer and the files back to back. The composer draft and attachments are cleared only after both steps succeed; a failed follow-up keeps the attachments in the draft and shows an error toast. The label builder lives in a small logic file with a unit test.
5. **Timeline.** The timeline no longer renders the pending card; it keeps the answered accordion (`AnsweredUserInput`). The citation and navigation hooks that key on `data-chat-cite-question-id` move with the question content into the panel; `ChatCitation.questions.browser.tsx` and `ChatCitation.questions.navigation.browser.tsx` must stay green.
6. **Compact and mobile.** The panel renders in the compact composer used by `FloatingSideChat.tsx` and on narrow widths; chips wrap.
7. Expected result: a user clicks an option, optionally types context and attaches files, presses send once, and the agent receives the per-question answers followed by the labelled attachments.

### Phase 3: One outbound link message from rendered visuals

Dependencies: Phase 1 guidance text references anchor behaviour; otherwise independent.

1. **Inner document** (`buildHtmlRenderDocument`): delegated click listener on `document` for anchors. On click, `preventDefault`, then `parent.postMessage({ type: "bigbud:open-link", href }, "*")`. No CSP violation fires because navigation is prevented. The existing violation handler remains the backstop for scripts that set `location`.
2. **Guard document** (`buildHtmlRenderGuard`): relay `bigbud:open-link` to `parent` exactly like `bigbud:html-height`, accepting it only from `frame.contentWindow`.
3. **Host** (`HtmlRenderFrame.tsx`): accept `bigbud:open-link` only from its own `contentWindow`, allow http and https only, rate-limit to one open per second, and call `openLinkFromClick`. Non-web hrefs are ignored with the existing "Unable to open link." toast. The app window never navigates.
4. **Affordance**: anchors in the inner document use the primary colour and an external-link cursor.
5. Expected result: dashboards can list sources that open through the user's chosen browser, with no sandbox change.

## Risks And Decision Gates

- **Text-only answer protocols.** Attachments ride in a follow-up message by design. The label text must be stable and explicit so agents treat the files as part of the answer. Gate: unit test for the label builder and a browser test for answer-then-queue ordering.
- **Follow-up delivery when the provider resumes immediately.** After the answer resolves, the provider resumes the turn. The queued prompt is delivered on the next idle point by the existing durable queue, not by a race. Gate: the follow-up must never be sent before the answer resolves.
- **Prompt budget.** LP is capped at 2,000 tokens, guide at 8,000 characters. Recipe text goes in `workflow` and `examples`, not the LP summary. Gate: catalog tests pass.
- **Link bridge trust.** Host accepts the message only from its own frame and only for web schemes; the sandbox still has no app access. Gate: browser test proves `javascript:`, `file:` and `data:` hrefs are rejected and the visual remains intact.
- **Misleading link labels in agent HTML.** Same exposure as markdown links in assistant messages; `openLink` defaults to the in-app browser where the real URL is visible.
- **Send-gate regressions.** `ChatView.sendTurn.gates.browser.tsx` and `ChatView.sendTurn.pendingCitation.browser.tsx` cover the pending-input gates and citations. Gate: both stay green after the panel moves out of the timeline.

## Testing And Validation

Focused checks only. No full-suite runs without approval.

- Server: `bun run --cwd apps/server vitest run src/capabilities/CapabilityCatalog.test.ts src/capabilities/CapabilityCatalog.operations.test.ts src/orchestration-tools/htmlRenderTool.bridges.test.ts`.
- Web unit: `bun run --cwd apps/web vitest run src/components/chat/messages/HtmlRenderFrame.test.tsx src/logic/user-input/pending.logic.test.ts src/components/chat/view/ChatView.promptQueue.logic.test.ts` plus new tests for the panel logic and the attachment follow-up label.
- Web browser: `bun run --cwd apps/web test:browser src/components/chat/messages/HtmlRenderFrame.browser.tsx` extended with anchor click posts `bigbud:open-link` without removing the frame, unsafe hrefs ignored, theme message carries chart tokens. New browser test for the panel: click option, type context, attach an image, send; assert `onRespondToUserInput` payload and the queued follow-up submission. Existing `ChatView.sendTurn.gates.browser.tsx` and citation tests rerun.
- Manual: ask an agent a question-style prompt and confirm the panel appears above the composer with chips; answer with a screenshot and confirm the agent references it. Ask for a three-source comparison and confirm a dashboard with working source links.
- Formatting, lint, typecheck and the 400-line check scoped to changed files before each commit.

## Acceptance Criteria

- A pending question renders as a docked panel above the composer with clickable options, in both full and compact composers; no dialog.
- Free text, images and files can be added while answering; the answer resolves first and attachments follow as one labelled message.
- `chat.render.html` guidance names multi-source research and comparisons as triggers, forbids HTML questions, and includes a style recipe; the tool description carries the same prohibition.
- Rendered visuals receive the extended theme tokens.
- Web links in a rendered visual open via `openLink` and the visual stays on screen; non-web schemes are ignored.
- All changed files are 400 lines or fewer and the focused checks above pass.

## Open Questions

- Should the follow-up attachment message be shown in the timeline as a normal user bubble (current queue behaviour) or visually grouped under the answered question? The plan assumes a normal bubble for the first iteration.
- Should sending with no selection and no text be allowed for optional questions? The plan keeps today's behaviour, which follows `field.required`.
