# Codex Voice Input And Task Summary Speech Plan

**Date:** 4 August, 2026  
**Status:** Revised proposal after codebase review  
**Owner:** bigbud team

## Summary

Add subscription-first voice prompting to Codex threads, with the existing OpenAI API-key transcription path as a sequential fallback. Preserve today's provider-neutral API-key dictation everywhere it already works; only the new subscription route is Codex-specific. Users can review the transcript and send manually or opt into sending it after a configurable period of detected silence, initially 10 seconds.

Add optional text-to-speech (TTS) for task milestones without reading the agent's live stream. The supported modes are off, completion summary only, or a short start announcement plus periodic status reminders and a completion summary. The first version uses operating-system-provided speech synthesis and observes bigbud's settled orchestration state, so it does not introduce another model call, expose reasoning, or speak partial assistant output. Documentation must not promise that every OS voice is processed entirely offline; that depends on the user's operating-system and voice configuration.

The subscription path is conditional. Current public Codex app-server documentation does not document a general speech-to-text method, token export, or a supported way to reuse Codex credentials for arbitrary OpenAI API calls. Synara demonstrates a viable mechanism, but it relies on an experimental legacy auth request and a private ChatGPT transcription endpoint. Phase 0 must prove that mechanism against the minimum supported Codex version and obtain an explicit product/security decision before it can ship. Routine provider discovery must remain credential-free: experimental token acquisition may occur only after an enabled, user-initiated voice action. If the route cannot be supported safely, bigbud keeps the current API-key path and reports subscription transcription as unavailable.

## Review Corrections Incorporated

This revision closes the main gaps found during codebase review:

- existing non-Codex API-key dictation remains supported;
- auto-send guards cover the complete sendable composer state, not text alone;
- routine Codex provider refresh never requests or caches a ChatGPT bearer token;
- buffered PCM replay into the Realtime fallback has an explicit transport design;
- transcript conflicts have defined Insert, Copy, and Discard recovery actions;
- silence timers fail safe across blur, hidden windows, suspend, and wake;
- TTS uses turn-scoped, sanitized text and pauses while work awaits user action;
- one cross-renderer speech leader prevents duplicate utterances;
- rollout flags, upload authorization, privacy boundaries, and replacement-module tests are explicit.

## Related Work

- Source discussion: [Codex subscription-first voice input and task summaries](bigbud-thread://48ebc845-9a80-4802-bb5d-87fac568d697).
- Kanban card: [Add configurable FluidVoice STT backend with OpenAI default v0.1.649](bigbud-kanban://kanban/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/1782674222638-3e0db588.md). This is adjacent future work; it reinforces the need for one voice-input controller with provider-specific transports, but FluidVoice is not part of this plan.
- Reference implementation: [Synara at reviewed commit `4db2587`](https://github.com/Emanuele-web04/synara/tree/4db258720234c5c5ed8b4d7661641e8362664758).
- Synara subscription transcription: [`voiceTranscription.ts`](https://github.com/Emanuele-web04/synara/blob/4db258720234c5c5ed8b4d7661641e8362664758/apps/server/src/voiceTranscription.ts#L24-L104) and [`chatGptVoiceTranscription.ts`](https://github.com/Emanuele-web04/synara/blob/4db258720234c5c5ed8b4d7661641e8362664758/packages/shared/src/chatGptVoiceTranscription.ts#L9-L82).
- Synara browser lifecycle: [`useComposerVoiceController.ts`](https://github.com/Emanuele-web04/synara/blob/4db258720234c5c5ed8b4d7661641e8362664758/apps/web/src/components/chat/useComposerVoiceController.ts#L1-L331).
- Official references: [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex app-server](https://developers.openai.com/codex/app-server), and [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription).
- No repository issue or pull request was identified. Create an issue ID before implementation so the capability decision and rollout can be tracked independently from the FluidVoice card.

## Problem

bigbud already supports microphone transcription, but only by opening an OpenAI Realtime WebSocket directly from the renderer with a separately configured API key. That means a user who is already signed into Codex with a ChatGPT subscription still has to supply an API key for voice input.

The current microphone flow also has no voice-activity state machine. Stopping commits the Realtime audio buffer and inserts the final transcript into the draft; it never sends the prompt. There is no configurable silence timeout, no safe auto-send guard, and no explicit distinction between cancelling a recording and stopping it for transcription.

Finally, bigbud has completion notifications but no spoken task lifecycle. Reading every assistant delta or tool update would be noisy, leak implementation detail, and produce unstable speech. Spoken output needs to be derived from canonical turn transitions and final assistant content instead.

The requested experience is therefore:

1. On a selected, idle Codex thread, press the microphone and speak a prompt.
2. Prefer transcription covered by the authenticated Codex/ChatGPT subscription when the runtime explicitly supports it.
3. If that route is unavailable or the individual request fails with a classified recoverable error, try the existing verified OpenAI API-key route once.
4. In manual mode, put the transcript in the composer and wait for the user to send it.
5. In auto-send mode, stop after the configured silence period, transcribe, and send only if the original thread and draft are still safe to mutate.
6. While the task runs, speak only configured lifecycle summaries—never raw reasoning, tool logs, deltas, code, or every assistant message.

## Goals

- Provide voice input for Codex threads even when the composer has no text yet.
- Preserve existing provider-neutral OpenAI API-key dictation in every composer where it currently appears.
- Prefer a proven subscription-backed path for eligible Codex threads and fall back sequentially to the existing OpenAI Realtime API-key path.
- Keep Codex/ChatGPT bearer credentials in server memory only and acquire them only for an enabled, user-initiated request; never serialize them into contracts, logs, renderer state, local storage, snapshots, or error messages.
- Preserve the existing 24 kHz PCM AudioWorklet capture path and API-key behavior instead of replacing proven browser audio code.
- Support manual send and opt-in auto-send after a configurable silence duration, with 10 seconds as the initial default.
- Make cancel, stop/transcribe, transcribing, fallback, transcript-conflict recovery, and auto-send countdown states visible and predictable.
- Prevent stale transcription results from crossing thread, provider, navigation, unmount, complete-composer-revision, or recording boundaries.
- Support TTS modes `off`, `completion`, and `milestones`, where `milestones` means start, active-work intervals, and completion.
- Speak only turn-scoped, sanitized text derived from canonical Codex state and settled assistant output.
- Degrade safely when subscription transcription, the API key, microphone access, operating-system speech synthesis, or cross-renderer speech coordination is unavailable.

## Non-Goals

- Adding subscription-backed transcription, silence auto-send, or task speech to Claude, Copilot, OpenCode, Orchestra mode, local chats, active-turn steering, or queued prompts in the first release. Existing provider-neutral manual API-key dictation is retained and is not removed by this scope boundary.
- A general provider-neutral claim that every provider supports subscription transcription. The initial subscription implementation is Codex-specific behind an optional adapter capability.
- Copying Synara's implementation or deprecated `ScriptProcessorNode`; only its lifecycle, auth, validation, and backpressure lessons are adapted.
- Streaming partial transcripts from the subscription route. The subscription route may be record-then-transcribe while the existing API fallback retains live partials when it is selected from the start.
- Cloud TTS, voice cloning, generated audio persistence, audio playback from Codex realtime events, or an additional LLM call to create summaries.
- Speaking model reasoning, tool invocations, shell output, diffs, code, approval contents, or raw provider events.
- Auto-sending while a turn is already running, while an approval or user-input request is pending, in shell mode, or after the user changes the draft during transcription.
- Changing the existing OpenAI transcription model as part of this work. Model migration should be a separate, measured change because the current Realtime guide and the repository's configured model are not identical.
- Implementing the related FluidVoice card. The controller boundary should permit it later without pre-implementing it now.

## Current State

### Voice capture and transcription

- `apps/web/src/hooks/useVoiceTranscribe.ts:43-55` documents the current renderer-owned Realtime transcription flow and its commit/final event sequence.
- `apps/web/src/hooks/useVoiceTranscribe.ts:70-87` reads the local API key and owns microphone, AudioContext, AudioWorklet, and WebSocket cleanup.
- `apps/web/src/hooks/useVoiceTranscribe.ts:95-105` stops microphone capture and commits the remote audio buffer, but has no separate cancel operation.
- `apps/web/src/hooks/useVoiceTranscribe.ts:107-179` requires an API key, requests microphone access, opens the OpenAI WebSocket, and streams PCM chunks.
- `apps/web/src/hooks/useVoiceTranscribe.ts:181-225` applies partial and final transcripts and tears the session down. Request IDs already provide a small stale-start guard, but not a full thread/draft lifecycle guard.
- `apps/web/src/hooks/useVoiceTranscribe.session.ts:3-46` fixes capture at 24 kHz PCM and sets `turn_detection` to `null`, so stopping is entirely manual today.
- `apps/web/src/hooks/pcm16-processor.worklet.ts:21-34` converts microphone samples to PCM16 and transfers buffers without a main-thread copy. This is the capture primitive to extend with level metadata and bounded recording, not replace.
- `apps/web/src/stores/stt/stt.store.ts:3-81` stores the OpenAI key, verification state, and one transcription model in local storage under `bigbud:stt:v2`.
- `apps/web/src/components/settings/SttSettingsSection.tsx:9-29` defines the current model and verifies API keys directly with OpenAI.
- `apps/web/src/components/settings/SttSettingsSection.tsx:79-175` presents only API-key and model controls, and correctly documents current renderer-only key handling.
- `apps/web/src/components/chat/composer/ComposerMicButton.tsx:24-68` snapshots the existing draft as a prefix and writes partial/final transcript text into the composer.
- `apps/web/src/components/chat/composer/ComposerMicButton.tsx:70-142` disables the microphone unless the API key is verified and exposes stopping to the listening bar.
- `apps/web/src/components/chat/view/chat-view/ChatViewComposer.tsx:320-330` mounts the microphone without a provider restriction today. The revised controller must preserve this API-key path for non-Codex providers rather than hiding it.
- `apps/web/src/components/chat/view/chat-view/ChatViewComposer.actions.ts:18-36` is the current prompt/cursor update path used by microphone transcription; it does not call send and is not the complete send boundary.
- `apps/web/src/components/chat/view/chat-view/chat-view-prompt-queue.hooks.ts:68-131` assembles `onSend`, while `apps/web/src/components/chat/view/ChatView.sendTurn.logic.ts:20-115` and `apps/web/src/components/chat/view/ChatView.sendTurn.actions.chat.ts:77-178` implement normal send behavior and snapshot attachments.
- `apps/web/src/stores/composer/types.store.ts:190-205` shows that sendable composer state includes more than prompt text: images, files, annotations, terminal contexts, reply and interaction state can change independently. Voice auto-send therefore needs a user-mutation revision covering the complete sendable composer state, not only a text revision.

### Codex auth and capability discovery

- `apps/server/src/codex/codexAppServerManager.startSession.ts:124-175` starts one Codex app-server per session, initializes it, calls documented `account/read`, and keeps a normalized account snapshot.
- `apps/server/src/provider/codexAccount.ts:3-18` distinguishes API-key, ChatGPT, and unknown Codex auth with plan metadata.
- `apps/server/src/provider/codexAccount.ts:36-74` normalizes `account/read` and produces an auth subtype without exposing a credential.
- `apps/server/src/provider/codexAppServer.ts:184-240` already has a bounded, abortable, short-lived app-server discovery process. It is the local pattern to extract or extend for a pre-session voice capability probe rather than adding a second ad hoc subprocess implementation.
- `apps/server/src/provider/codexAppServer.ts:251-329` performs initialize, model/list, skills/list, and account/read before terminating the probe. It currently has no supported voice request or token acquisition step.
- `apps/server/src/provider/Layers/Codex/Provider.ts:216-249` merges discovery account data into the Codex provider snapshot; `apps/server/src/provider/Layers/Codex/Provider.ts:268-330` reports login health.
- `apps/server/src/provider/makeManagedServerProvider.ts:80-101` refreshes managed provider state every 60 seconds, and `apps/server/src/provider/Layers/Codex/Provider.ts:341-359` caches Codex discovery for five minutes. Any experimental request that includes a bearer token must be excluded from this routine discovery path.
- `packages/contracts/src/server/server.ts:110-124` has no transcription availability field in `ServerProvider`.
- `apps/server/src/provider/Services/ProviderAdapter.ts:75-157` has no optional voice operations. Adding optional operations here follows Synara's adapter boundary without claiming semantic equivalence across providers.

### Realtime events are not a transcription request API

- `apps/server/src/provider/Layers/Codex/Adapter.stream.handlers.thread.ts:103-187` maps Codex realtime started, item, transcript, audio, error, and close notifications into provider runtime events.
- No current bigbud code or public app-server reference establishes a corresponding supported client request for microphone transcription. These event mappings must not be used as proof that subscription STT is available.

### Turn completion and speech lifecycle reuse

- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.processor.runtime.ts:75-108` rejects conflicting or late turn lifecycle events.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.processor.runtime.ts:114-151` projects accepted `turn.started` and `turn.completed` events into canonical session state.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.processor.runtime.ts:238-268` finalizes assistant messages before turn completion processing finishes. TTS should observe the resulting thread projection, not raw provider event order.
- `apps/web/src/notifications/taskCompletion.logic.ts:19-51` already extracts and bounds the latest assistant text, but only by trimming/slicing; it does not remove Markdown, code, URLs, paths, or guarantee that the message belongs to the completed turn.
- `apps/web/src/models/types/app.types.ts:99-108` exposes `turnId` on messages, which TTS must use to avoid speaking a previous turn when the completed turn has no assistant message.
- `apps/web/src/notifications/taskCompletion.logic.ts:53-95` detects a transition into the same settled completed state used by current task notifications and ignores pre-existing completion state.
- `apps/server/src/orchestration/ThreadWorkflowStatus.logic.ts:222-250` distinguishes active work from `awaiting_approval` and `awaiting_input`; milestone timers must pause in those states.
- `apps/web/src/notifications/taskCompletion.tsx:94-160` demonstrates the existing headless watcher pattern and local client settings integration, but its deduplication is renderer-local.
- `apps/web/src/routes/__root.tsx:97-105` can mount the watcher in each renderer. TTS needs one cross-renderer leader so multiple windows or tabs do not speak the same event.
- `packages/contracts/src/core/settings.ts:54-122` is the schema-backed home for local-only behavior settings and defaults.

### Desktop microphone permission

- `apps/desktop/src/window/windowManager.ts:146-173` grants audio media permission and denies unrelated permission requests.
- `apps/desktop/resources/entitlements.mac.plist:12-14` includes the macOS audio-input entitlement.

### Synara findings to adapt

- Synara routes voice through optional provider adapter methods, resolves ChatGPT auth on the server, retries token refresh once after 401/403, and validates captured WAV input before upload.
- Its outbound transcription helper restricts the destination, disallows redirects, applies timeouts and response limits, and bounds concurrency. Those safeguards are relevant if bigbud approves the private endpoint.
- Its composer voice controller prewarms after recording starts, guards results with request generations and thread/provider identity, and discards stale results after navigation or cancellation.
- Its preferred transport is binary HTTP with a WebSocket/base64 compatibility fallback. bigbud does not need that compatibility fallback because server and web ship together; it should use an authenticated one-use binary upload ticket instead of paying the base64 memory cost.
- Synara does not implement TTS. The TTS portion of this plan derives from bigbud's existing completion projection and notification logic.

## Phases

### Phase 0: Prove The Subscription Capability And Set The Policy

**Goal:** Determine whether the minimum supported Codex app-server can safely provide subscription-backed transcription without assuming that ChatGPT login implies general API access.

1. Record the issue ID, decision owner, decision date, exact minimum supported Codex CLI/app-server versions, tested ChatGPT plans, and rollback owner in the implementation issue.
2. Extend or extract the abortable one-shot JSON-RPC process lifecycle in `apps/server/src/provider/codexAppServer.ts`; do not duplicate process startup, initialize, timeout, abort, and cleanup logic.
3. Separate two concepts:
   - **credential-free eligibility**, derived only from installed version, initialized protocol behavior, account type, and safe capability metadata;
   - **operational subscription access**, resolved only on demand after a user starts an enabled Codex voice action.
4. Test in this order:
   - A documented app-server transcription method, if current official protocol documentation defines one.
   - A safe runtime capability or URL explicitly returned by a documented method.
   - A bounded method-not-found probe only if protocol negotiation cannot answer the question without side effects.
   - Only if no supported method exists, Synara's experimental legacy `getAuthStatus` request with token inclusion and its private ChatGPT transcription endpoint.
5. Never request token inclusion during startup, periodic provider refresh, settings rendering, login-health checks, or ordinary `ServerProvider` discovery. The routine 60-second/five-minute refresh path must stay credential-free.
6. Exercise ChatGPT Plus/Pro, Codex API-key login, custom model provider configuration, expired login, no active Codex session, and an already-running Codex session.
7. Capture only capability metadata and categorized results. Never log, snapshot-test, persist, or return bearer tokens. Default to no bearer cache; add a short in-memory cache only if measurements prove it necessary and the product/security decision explicitly permits it.
8. Require a product/security decision before enabling the private endpoint. The decision must state that the endpoint and legacy auth method are undocumented, may violate future provider policy, may break independently of bigbud, and are controlled by the default-off `providers.codex.rollout.subscriptionVoiceTranscription` kill switch.
9. Define a capability result that fails closed, for example `eligible | unavailable | unsupported | temporarily-failed`, plus a user-safe reason. `account.type === "chatgpt"` is necessary but not sufficient, and eligibility must not imply that a token has already been acquired.
10. Record the user-facing data-flow disclosure: captured microphone audio is sent to the effective transcription service, while OS speech output may be processed according to the user's operating-system voice settings.

**Exit criteria:** A supported native route is proven, or the private route is explicitly accepted and live-tested, or subscription transcription is marked unavailable and later phases proceed with the existing API fallback only.

### Phase 1: Add A Secure Codex Transcription Service And Fallback Contract

**Dependency:** Phase 0 has produced a capability decision.

**Goal:** Add a server-owned subscription route that does not expose credentials, while preserving the current renderer-owned API fallback.

1. Add direct-subpath voice contracts under `packages/contracts/src/server/` for:
   - credential-free subscription eligibility and a safe reason;
   - an on-demand prewarm/transcription request correlation ID;
   - a short-lived, one-use upload ticket scoped to Codex, the selected thread or local draft identity, and one renderer connection;
   - transcription success and categorized failure (`unavailable`, `unauthorized`, `forbidden`, `rate-limited`, `timeout`, `network`, `invalid-audio`, `empty-transcript`, `cancelled`, `internal`).
2. Add optional `prewarmVoice`/`transcribeVoice` operations to `ProviderAdapterShape`. Implement subscription operations only for Codex. Other providers omit that capability, while their existing renderer-owned `openai-api` dictation remains usable.
3. Expose credential-free eligibility separately from operational status. If `ServerProvider` carries an optional summary, populate it without token extraction or private endpoint traffic; obtain operational access only in the user-initiated voice RPC.
4. Define a real renderer/connection identity before claiming ticket binding. The current server-wide WebSocket query token is not a renderer identity. On WebSocket authentication, issue a per-connection random upload proof kept only in that renderer and server connection state. Bind each ticket to that connection ID, provider, thread or local-draft ID, MIME type, byte limit, request ID, and short expiry.
5. Add a binary `POST /api/voice/transcribe` route that requires both the one-use ticket and the per-connection proof in dedicated non-URL headers, verifies them with constant-time comparison where applicable, and atomically consumes the ticket before buffering the body. Invalidate all outstanding tickets when the owning WebSocket closes. Require same-origin or an explicit trusted-origin policy, `Cache-Control: no-store`, no credentials in URLs, and redaction in HTTP access/error logs.
6. Define authorization for both persisted threads and pre-first-prompt local drafts. The server must not pretend it can verify renderer selection state that only exists in the client; the connection proof plus scoped one-use ticket authorizes only that upload, not arbitrary thread operations.
7. Validate `audio/wav`, mono PCM16, 24 kHz, maximum 120 seconds, and maximum 10 MiB. Reject missing/invalid `Content-Length` and oversized bodies before allocation when the HTTP runtime permits it; parse WAV chunks and recheck encoding, channels, sample rate, frame alignment, and decoded duration afterward.
8. Keep raw PCM, WAV bodies, outbound multipart bytes, and transcript content request-scoped and memory-only. Never write them to temporary files, persisted queues, logs, metrics, snapshots, diagnostics, crash reports, or error payloads; release references on every exit path.
9. Bound subscription uploads to two active requests with a queue of four or fewer. Release admission on success, failure, timeout, disconnect, cancellation, and server shutdown.
10. Resolve auth from a live Codex app-server when one safely owns the selected thread; otherwise reuse the one-shot process lifecycle so voice works before the first prompt starts a session. Serialize refresh, abort prewarm/auth work when the request is cancelled, and do not cache the bearer by default.
11. For an approved private HTTP route, wrap the WAV as the required multipart `file` upload, enforce the canonical HTTPS origin/path, `redirect: "error"`, public-address resolution, connection/upload/response timeouts, a 1 MiB response limit, response content/schema validation, and redacted logging. Refresh at most once after 401/403, then fail.
12. Define both route-specific and end-to-end latency budgets. A subscription timeout followed by API fallback must not wait indefinitely; the UI remains cancellable throughout, and late results are ignored by request ID.
13. Never return the Codex credential to the renderer. Return only normalized transcript text, route used (`codex-subscription`), safe latency bucket, request ID, and a safe failure category.
14. Preserve the current direct OpenAI Realtime route as `openai-api`. The renderer may try it once after an allowlisted subscription failure when a verified key exists; it must not hedge both routes concurrently.
15. Use one authoritative fallback matrix in contracts and controller logic:
    - fallback once: `unavailable`, `unauthorized`, `forbidden`, `rate-limited`, `timeout`, and `network` after the subscription route has exhausted its permitted auth refresh;
    - no automatic fallback: `invalid-audio`, `empty-transcript`, `cancelled`, and `internal`;
    - a fallback failure reports both safe categories but never raw provider errors.
16. Treat one fallback-eligible subscription failure as a per-request fallback, not a permanent capability downgrade. Only an explicit auth/capability refresh may update advertised eligibility.
17. Add `providers.codex.rollout.subscriptionVoiceTranscription`, decoded as `false` by default, to Codex server settings and its patch schema. It is the sole kill switch for the undocumented route. Disabling it aborts active prewarm/auth/upload work, rejects queued tickets, prevents new token/private-endpoint traffic, and leaves API-key dictation unchanged.

**Expected result:** A Codex thread can request secure record-then-transcribe service when proven available, and the renderer still has one explicit API-key fallback with no duplicated audio capture.

### Phase 2: Replace The Mic Hook With One Guarded Voice Controller

**Dependency:** The Phase 1 contracts and route are stable.

**Goal:** Make recording, transcription selection, cancellation, fallback, and draft application one coherent state machine.

1. Split the existing non-test hook by concern before it exceeds 400 lines, using the repository's dot-notation pattern, for example:
   - `useComposerVoiceController.ts` for orchestration;
   - `useComposerVoiceController.capture.ts` for microphone lifecycle and bounded PCM storage;
   - `useComposerVoiceController.transcription.ts` for route selection/fallback;
   - `useComposerVoiceController.realtimeReplay.ts` for prerecorded PCM backpressure, commit, final-result timeout, and cancellation;
   - `voiceActivity.logic.ts` for pure level and silence transitions;
   - `voiceWav.ts` for the minimal PCM16 WAV wrapper;
   - `voiceTranscriptConflict.ts` for transient Insert/Copy/Discard recovery state.
2. Reuse `pcm16-processor.worklet.ts`. Extend its message shape to include the transferred PCM chunk and a cheap level measurement needed by voice activity detection; do not add a second microphone graph.
3. Keep at most 120 seconds of raw PCM in a bounded chunk list for every route. Stop with an actionable error at the limit instead of allowing unbounded renderer memory. Wrap the same PCM as WAV only for the subscription upload.
4. Define explicit states: `idle`, `requesting-microphone`, `recording`, `stopping`, `transcribing-subscription`, `replaying-api`, `transcribing-api`, `transcript-conflict`, `ready`, `cancelled`, and `error`.
5. Separate operations:
   - **Cancel** stops capture, invalidates the request generation, aborts prewarm/auth/upload/replay, discards buffered audio, and never mutates or sends the draft.
   - **Stop** stops capture and begins transcription.
   - **Retry fallback** is automatic once only for the Phase 1 allowlisted categories.
   - **Resolve conflict** explicitly inserts, copies, or discards the transcript; it never auto-sends.
6. Track three distinct guard layers:
   - immutable operation scope: renderer/draft ID, thread, project, provider, request generation, and route policy;
   - a user-mutation revision covering prompt, cursor/selection, images, files, annotations, terminal contexts, reply target, interaction/shell mode, model/effort/runtime choices, and any other send-affecting state;
   - controller-owned prompt state tagged with the voice operation ID, so API partial/final updates can advance the expected prompt without counting as user edits.
7. At start, snapshot immutable scope, selection/cursor, and user-mutation revision. Before each result, require current operation scope. Before auto-send, also require the original user-mutation revision and final send eligibility. Conflict actions require only the same live draft/thread scope and explicit user intent; they must not require the original unchanged fingerprint.
8. If subscription is credential-free eligible and enabled, buffer and upload the final WAV. Prewarm only after microphone permission succeeds, abort it on cancel/navigation, and do not surface prewarm failure as a recording failure.
9. If subscription is unavailable before recording and a verified API key exists, start the current Realtime streaming path immediately. Preserve partial transcript behavior by tagging controller-owned prompt updates with the voice operation ID and advancing the controller's expected prompt. If a user mutation occurs, stop applying partials and route the final result to conflict recovery.
10. If subscription fails after recording, call a defined `transcribeBufferedPcm(chunks, signal)` path. Open and initialize a fresh Realtime session, send raw PCM chunks in order, throttle on `WebSocket.bufferedAmount`, commit exactly once only after all chunks are queued/drained, wait for one bounded final transcript, and ignore late events. Do not send the WAV container, recapture audio, or run both providers concurrently.
11. Allow at most one active recording/transcription and one Realtime replay per renderer controller. Starting a new operation cancels and releases the previous one before admission; add broader cross-renderer replay limiting only if measurements justify shared coordination.
12. During post-subscription replay, do not apply partial transcripts directly to a possibly changed draft. Keep them internal and apply only the guarded final transcript or conflict payload.
13. If neither route is usable, disable the microphone with an actionable explanation and a link to Voice settings. Distinguish missing Codex subscription eligibility, disabled rollout, and missing API fallback key.
14. Preserve existing API-key dictation for non-Codex providers and composers. Route them through the shared capture/controller in API-only manual mode; never hide a mic that is currently available merely because the selected provider is not Codex.
15. Use the real send boundary assembled by `chat-view-prompt-queue.hooks.ts` and implemented by `ChatView.sendTurn.logic.ts`. Add one atomic integration helper that updates prompt and `promptRef`, revalidates the user-mutation revision and current send eligibility, and invokes `onSend` exactly once.
16. Define transcript application semantics:

- unchanged same draft: replace the captured selection or insert at the captured cursor with deterministic whitespace normalization;
- user-mutated same draft: store a bounded transient conflict payload containing transcript and captured insertion context, show preview plus **Insert**, **Copy**, and **Discard**, and never overwrite or auto-send;
- cancellation, supersession, thread/provider/draft change, navigation, or unmount: discard audio, transcript, conflict, and request state; never carry content into another scope.

17. Keep raw PCM, WAV, partial/final transcripts, and conflict payloads memory-only and scoped to one active draft. Never persist them to local storage, crash reports, logs, metrics, snapshots, or diagnostics; clear references on every terminal transition.
18. Handle device removal, permission revocation, `AudioContext` suspension, worklet failure, WebSocket close, server restart, and rapid double-start/double-stop as explicit transitions with resource cleanup.
19. Expose recording/transcribing state and an optional no-op voice-output interlock for Phase 4. Before TTS exists, capture has no coordinator dependency; once TTS is enabled, its coordinator must cancel speech and report idle before capture accepts audio.
20. Gate subscription routing and silence auto-send to an idle selected Codex thread with no pending approval/user-input request. API-only manual recording follows the existing composer availability rules, including current Codex queued-prompt behavior during an active turn. Lifecycle speech is governed by Phase 4 active/waiting/completed states, not by this idle-start gate. Keep existing non-Codex manual API-key behavior intact.

**Expected result:** Manual recording has predictable stop/cancel behavior, one designed sequential transcription fallback, bounded memory, complete-composer race protection, explicit transcript-conflict recovery, and no regression to existing non-Codex API-key dictation.

### Phase 3: Add Configurable Silence And Safe Auto-Send

**Dependency:** The guarded controller can reliably produce one final transcript.

**Goal:** Let users opt into automatic stop/transcribe/send after a meaningful pause without sending ambient noise or stale drafts.

1. Add local-only voice settings through `ClientSettingsSchema`, preserving defaults for existing installations:
   - `voiceSendMode: "manual" | "after-silence"`, default `manual`;
   - `voiceSilenceTimeoutMs`, default `10_000`, constrained to a product range such as 3–30 seconds;
   - transcription preference `prefer-codex` for this release;
   - TTS settings introduced in Phase 4.
2. Keep the API credential and verification state in the existing STT store. Do not duplicate credential persistence into client settings. Rename user-facing “Speech to Text” settings to “Voice” only if the navigation/search entries can be updated without breaking stored state; a source-file rename is not required.
3. Implement voice activity as pure logic with an initial noise-floor calibration window, adaptive noise floor, separate speech-start and speech-stop thresholds, hysteresis, minimum voiced duration, short hangover, and monotonic timestamps. Calibration must not discard captured PCM.
4. Start the silence countdown only after meaningful speech has been detected. Reset it on renewed speech. Never stop or send a recording that contains no accepted speech.
5. Pause the countdown when the app window loses focus, the document becomes hidden, the `AudioContext` is suspended, or a large monotonic-time gap indicates system sleep. On resume, require fresh accepted speech or explicit “Stop now”; never fire a stale deadline immediately.
6. Show the remaining countdown in the listening bar, along with Cancel and “Stop now”. Manual mode shows no countdown. Keep visual updates smooth but throttle `aria-live` announcements so screen readers do not announce every tick.
7. When the silence deadline fires, call the same stop/transcribe path as the button. Do not create a second finalization path.
8. After final transcription, auto-send only if all of these remain true:
   - the same renderer still owns the same selected Codex thread, provider, and request generation;
   - the document is visible, the app window is focused, and no suspend/resume invalidation occurred;
   - the thread is idle and can accept a new turn;
   - there is no pending approval, pending user input, shell/command mode, reply conflict, active upload, or connection uncertainty;
   - the user-mutation revision still matches the captured snapshot, including prompt, attachments, and send-affecting options;
   - the transcript is non-empty after normalization;
   - the request has not been cancelled, timed out, or superseded.
9. Apply the final transcript through the atomic composer/send helper and invoke the existing `onSend` path exactly once. Do not bypass attachments, mentions, prompt refs, draft clearing, queue rules, or send eligibility logic.
10. Use one explicit failed-auto-send matrix:
    - same renderer/thread/draft with only a user mutation, focus/visibility loss, suspend invalidation, busy transition, or send-eligibility change: keep a scoped transcript-conflict payload and show “Not sent because the conversation changed,” with Insert, Copy, and Discard;
    - cancellation, supersession, thread/provider/draft change, navigation, unmount, or renderer ownership loss: discard transcript/conflict state and never carry it into the new scope;
    - reconnect/server restart: retain a completed transcript only if the same operation scope and draft identity are still provably current; otherwise discard.
11. A lost connection has an uncertain outcome only for transcription, never for prompt send. Auto-send requires a locally observed successful transcript response, current operation scope, unchanged user-mutation revision, and a final synchronous send-eligibility check. Never guess whether a late send is still wanted.

**Expected result:** The default remains review-before-send. Opted-in users get a 10-second silence workflow that uses the normal send path once and fails safely under races.

### Phase 4: Add Lifecycle-Aware TTS Without Reading The Stream

**Dependency:** Canonical turn identity and voice recording state are available to the watcher.

**Goal:** Speak concise Codex task milestones while never narrating raw agent work.

1. Add local-only settings:
   - `taskSpeechMode: "off" | "completion" | "milestones"`, default `off` to avoid surprise audio;
   - `taskSpeechIntervalMs`, with a conservative default such as five minutes and a bounded settings choice;
   - use the OS-selected default voice/rate for the first release;
   - expose a short “Test voice” action and an accurate disclosure that processing location depends on OS/voice configuration.
2. Add a testable `TaskSpeechCoordinator` beside task completion notifications. Use `window.speechSynthesis` and `SpeechSynthesisUtterance` behind an adapter; handle missing voices, asynchronous `voiceschanged`, utterance errors, cancellation, and unsupported environments without affecting STT.
3. Elect exactly one **active-renderer** speech leader across windows using desktop main-process focus ownership, or Web Locks plus `BroadcastChannel` focus/visibility claims in browser deployments. A renderer is eligible only while focused and visible; focus changes transfer leadership before new speech, no focused renderer means silence, and leadership loss cancels queued speech.
4. Observe projected canonical thread/workflow state, not provider deltas. Speak only the active leader's selected visible Codex thread, so a background window's selection cannot override the user's focused window and parallel/background threads do not talk over one another.
5. Announce start exactly once when a new canonical turn enters active work. Derive deterministic bounded copy through a speech sanitizer; if the title/prompt contains code, logs, URLs, long paths, secrets-like text, or no safe phrase, use the generic “Starting your task.” Do not ask a model to summarize the prompt.
6. In `milestones` mode, measure intervals from accumulated active-work time, not wall-clock turn start. Cancel/pause timers while the workflow is `awaiting_approval`, `awaiting_input`, plan-ready, disconnected, or otherwise blocked. Never say “Still working” while waiting for the user, and never emit catch-up reminders after sleep or resume.
7. Optionally speak one short deduplicated attention cue such as “Your task needs input” when entering an awaiting state only if product design explicitly enables it; otherwise remain silent. This cue is not an interval milestone.
8. Reuse the settled-completion transition, but replace raw `summarizeLatestAssistantMessage` output with a turn-scoped selector keyed by `turnId` and a deterministic speech sanitizer. Remove code fences, inline code, Markdown syntax, URLs, long file paths, tables, raw IDs, and unsafe/empty fragments; enforce a strict character or estimated-duration cap and use a generic completion phrase when nothing safe remains.
9. For failed or cancelled turns, speak a short outcome derived from canonical state and allowlisted safe error copy. Do not read stack traces, provider payloads, commands, or previous-turn assistant text.
10. Deduplicate globally by `threadId:turnId:phase`. Reconnects, snapshot rehydration, renderer failover, and repeated renders must not repeat already-spoken phases.
11. Use one queue with these rules:

- microphone recording/transcribing cancels and suppresses TTS, and capture waits until the coordinator reports speech idle;
- completion supersedes queued interval speech;
- awaiting states cancel interval speech;
- a newer selected turn cancels older queued speech;
- utterances never overlap;
- switching away from a thread or losing speech leadership cancels pending speech.

12. Do not persist audio or utterance text. Persist only user preferences. Keep global dedup state bounded and non-content-bearing; initial hydration and already-running turns must not produce retroactive start speech.
13. If guaranteed semantic summaries are later required, plan a separate model-backed summary feature with its own cost, privacy, cancellation, and provider-policy review. Do not smuggle that call into this release.

**Expected result:** Users can choose silent operation, a final turn-scoped sanitized spoken summary, or start/active-work-interval/final milestones, with one global utterance, no narration while awaiting the user, no live-stream narration, and no self-transcription feedback loop.

### Phase 5: Rollout And Documentation

1. Ship in separable increments: shared controller/API-key regression preservation, guarded manual subscription transcription, silence auto-send, then TTS. Do not couple all features behind one release gate.
2. Keep the undocumented subscription route behind a `providers.codex.rollout.subscriptionVoiceTranscription` default-off server kill switch until Phase 0's supported-version matrix and decision record pass. Keep auto-send and TTS behind independent client defaults (`manual` and `off`).
3. Show both eligibility and the effective per-request route in Voice settings/status: “Codex subscription eligible”, “Subscription disabled”, “Using OpenAI API fallback”, or a specific unavailable state. Do not claim that all ChatGPT plans include the route unless an on-demand request proves it.
4. Explain that microphone audio is sent to the effective transcription service and that TTS uses an OS-provided voice whose processing location may depend on operating-system configuration.
5. Add troubleshooting for microphone permission, expired Codex login, disabled rollout, missing/invalid API key, unsupported Codex version, private endpoint changes, unavailable system speech, duplicate-window leadership recovery, and the 120-second recording limit.
6. Add metrics only if the repository's approved telemetry path exists. Use low-cardinality outcomes: route selected, credential-free capability class, fallback reason class, latency bucket, cancellation stage, auto-send outcome, and TTS phase. Never record transcript, prompt, audio, bearer, API key, thread title, file name, raw error payload, or utterance text.
7. Roll back subscription use by disabling its kill switch; no token extraction or private traffic occurs afterward. Roll back auto-send/TTS independently through their defaults. The current provider-neutral API-key path and manual send remain usable, and client settings decode to safe defaults if newer fields are absent.
8. Provide a redacted diagnostics view or log event that reports version, safe capability class, route, and failure category without secrets or content, so support does not need users to expose tokens or transcripts.

## Risks And Decision Gates

### Gate 1: Undocumented subscription mechanism

Synara's mechanism is evidence that the workflow can function, not an authoritative promise from OpenAI. Codex subscription credentials are not automatically general-purpose OpenAI API credentials. Do not ship the private `chatgpt.com/backend-api/transcribe` route unless Phase 0 confirms current behavior and the product/security owner accepts breakage and support risk. If rejected, the rest of the UI/controller/TTS plan remains valid with API-only transcription.

### Gate 2: No active Codex session

Voice must work before the first prompt, when no thread app-server exists. Reuse/extract the discovery subprocess lifecycle and prove that concurrent provider refresh, recording prewarm, server shutdown, and abort cannot leak or orphan Codex processes. Do not keep a second permanent Codex process solely for voice unless measurements prove one-shot startup is too slow and a bounded manager is separately approved.

### Gate 3: Credential and endpoint isolation

Any bearer returned by an experimental method is highly sensitive. The renderer must receive only capability/result data. Logs must redact request headers and raw app-server auth responses. The outbound destination must be fixed and redirects blocked to prevent credential forwarding.

### Gate 4: Fallback semantics

Fallback is sequential and at most once. The authoritative matrix is: fall back for `unavailable`, exhausted `unauthorized`/`forbidden`, `rate-limited`, `timeout`, and `network`; do not automatically fall back for `invalid-audio`, `empty-transcript`, `cancelled`, or `internal`. A fallback failure reports both safe categories without duplicating raw error text.

### Gate 5: Silence detection reliability

Ten seconds is a UX default, not the only VAD rule. Auto-send may begin only after speech is detected, must use hysteresis, and must keep manual mode as the default. Browser tests with fake audio levels and live checks in quiet/noisy rooms are required before enabling it broadly.

### Gate 6: Draft and send races

The highest-risk user-visible failure is sending the wrong or incomplete prompt. Thread/provider/draft/request generations and the normal composer send eligibility are mandatory. Retain a transcript for review only when uncertainty remains within the same renderer/thread/draft scope; cancellation, supersession, identity changes, navigation, and unmount follow the discard matrix.

### Gate 7: TTS source and timing

Browser speech synthesis quality and voice availability vary by OS. It is acceptable for the first release only if desktop manual tests confirm stable start/cancel behavior. TTS must be triggered by projected state, must wait for the finalized assistant message, and must never consume stream deltas.

### Gate 8: Scope overlap with FluidVoice

The related FluidVoice card proposes a provider abstraction. This plan should create only the narrow controller/adapter seam needed for Codex subscription and OpenAI API fallback. Do not add generic backend registry complexity until FluidVoice implementation is actually scheduled.

### Gate 9: Existing dictation regression

The microphone is currently provider-neutral when a verified OpenAI key exists. Subscription routing may be Codex-only, but the shared controller must preserve existing manual API-key dictation for non-Codex and local-draft composers. Hiding or disabling that path is a release blocker.

### Gate 10: Complete composer atomicity

Prompt text is only one part of a send. Attachments, annotations, terminal context, reply target, interaction mode, model/runtime choices, and prompt refs must be covered by one composer revision and a final synchronous eligibility check. If any send-affecting state changes, produce a review-only transcript conflict instead of auto-sending.

### Gate 11: TTS content and ownership

A bounded raw assistant message is not automatically safe speech. Completion text must match the completed `turnId`, pass deterministic sanitization, and fall back to generic copy. Exactly one renderer may own speech at a time; duplicate utterances across windows are a release blocker.

### Gate 12: Timer suspension and waiting states

Browser timers can jump after blur, throttling, or system sleep, and canonical work can pause for approval/input. Silence auto-send must fail safe after suspension, while milestone speech must count active-work time only and remain silent while the task awaits the user.

## Testing And Validation

### Contract and unit tests

- Decode older `ServerProvider` snapshots with no voice field and new snapshots with all availability states.
- Reject malformed upload ticket requests, invalid thread/provider bindings, reused/expired tickets, unsupported content types, and unsafe result/error payloads.
- Test PCM16 WAV headers, exact duration/size boundaries, empty audio, wrong sample rates, stereo data, truncation, and normalization.
- Test pure voice-activity transitions with fake monotonic time: no speech, background noise, short bursts, continuous speech, silence reset, exact timeout, and maximum duration.
- Test route selection: subscription success, credential-free eligibility without token acquisition, capability unavailable to API, recoverable subscription failure to API once, non-recoverable audio failure with no fallback, rollout disabled, and neither route available.
- Test buffered Realtime replay ordering, `bufferedAmount` backpressure, exactly one commit, final-result timeout, close/error before commit, 120-second input, cancellation mid-replay, and late-event rejection.
- Test controller generations for cancel, rapid restart, navigation, provider change, unmount, reconnect, late subscription response, late API response, and every complete-composer mutation class.
- Test conflict payload Insert/Copy/Discard behavior, captured selection replacement, cursor insertion, whitespace normalization, payload scoping, and no silent overwrite.
- Test auto-send guards and exactly-once invocation of the atomic normal send helper, including attachment/model/reply/interaction changes and final synchronous revalidation.
- Test focus/visibility/suspend behavior with fake clocks: blur, hidden document, throttled timer, sleep past deadline, wake, fresh-speech requirement, and `AudioContext` suspension.
- Test TTS mode selection, active-work interval accounting, awaiting-approval/input pause, no catch-up after sleep, global cross-renderer deduplication/failover, completion superseding interval speech, active-thread scoping, microphone suppression, failure/cancel copy, navigation cancellation, and unsupported speech synthesis.
- Test turn-scoped speech sanitization with previous-turn messages, no assistant output, Markdown, code fences, inline code, URLs, long paths, tables, raw IDs, secrets-like text, oversized text, and generic fallback.

### Server/provider tests

- Mock the Codex app-server sequence for initialize, credential-free capability checks, on-demand auth request, refresh, timeout, abort, process exit, and shutdown.
- Assert startup, 60-second provider refresh, settings rendering, and login-health checks never request token inclusion or call the private endpoint.
- Assert secrets never occur in returned schemas, structured logs, metrics, HTTP access logs, thrown messages, or snapshots.
- Test live-session on-demand auth reuse and pre-session one-shot process handling independently, with no bearer cache by default.
- Test connection-bound ticket mint/consume, required proof header, constant-time proof rejection, local-draft authorization, wrong connection/thread/provider, WebSocket-close invalidation, replay, expiry, atomic one-use behavior, same-origin policy, and `Cache-Control: no-store`.
- Test fixed-origin enforcement, DNS/public-address validation, redirect rejection, multipart format, content and response limits, response schema validation, 401/403 refresh exactly once, rate limiting, timeout, and cancellation.
- Test two active uploads plus bounded queue behavior, admission release on every exit, and server shutdown with queued/active work.
- Test capability refresh after login/logout, unsupported Codex versions, API-key Codex auth, custom model providers, temporary probe failure, and kill-switch disable while a request is pending.

### Web and browser tests

- Add focused tests for the replacement modules: controller orchestration, capture/bounds, route selection, Realtime replay, WAV parsing, voice activity, transcript conflicts, atomic composer/send integration, speech sanitization, and cross-renderer speech leadership. Keep old-hook tests only as migration/regression coverage until the old hook is removed.
- Extend `apps/web/src/components/chat/composer/ComposerMicButton.browser.tsx` and `apps/web/src/stores/stt/stt.store.test.ts`, splitting files before 500 lines.
- Verify microphone enabled/disabled explanations for subscription eligible, rollout disabled, API fallback only, no credentials, non-Codex provider with existing API-key dictation, local draft, busy turn, and pending interaction.
- Verify accessible names and visible states for recording, countdown, stopping, subscription transcription, fallback replay/transcription, cancel, and transcript conflict. Throttle screen-reader countdown announcements.
- Verify manual mode never sends, auto mode sends once after a final guarded transcript, focus/suspend invalidation becomes review-only, and cancel never transcribes or sends.
- Verify every mutation of prompt, attachments, annotations, terminal context, reply, model/runtime, or interaction mode suppresses auto-send and preserves the transcript conflict actions.
- Verify recording cancels TTS, waits for speech idle, and TTS output never enters captured/transcribed prompt text.
- Run two-renderer browser tests proving one utterance per `threadId:turnId:phase`, focused/visible active-renderer arbitration when each window selects a different thread, silence when neither is focused, and clean leader failover.

### Desktop and live matrix

- macOS, Windows, and Linux/Electron microphone permission and system speech checks where supported.
- ChatGPT Plus/Pro with no OpenAI API key.
- Supported and deliberately unsupported Codex versions.
- Codex API-key auth with a verified STT fallback key.
- Claude/Copilot/OpenCode or other currently supported composer with the existing verified API-key dictation path, confirming no regression and no Codex credential request.
- Expired ChatGPT auth plus valid fallback key.
- No active Codex session before the first prompt, a local draft, and an existing active idle session.
- No credentials, offline mode, slow upload, timeout, rate limit, server restart mid-transcription, device unplug, permission revocation, and AudioContext suspension.
- Quiet room, fan/background noise, speech-pause-speech, no-speech recording, 10-second pause, manual stop, window blur, hidden window, machine sleep/wake, and 120-second limit.
- TTS completion-only and milestone modes during successful, failed, cancelled, approval-paused, input-paused, disconnected, and background-thread tasks.
- Two windows/renderers observing the same selected thread, leader close/failover, and no duplicate speech.

### Required repository validation

Run from the repository root after each implementation phase:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Never use `bun test`; it bypasses the repository's Vitest/Turbo path.

## Acceptance Criteria

- A user on a supported, ChatGPT-authenticated Codex installation can record a prompt without configuring a separate OpenAI API key when Phase 0 has approved and `providers.codex.rollout.subscriptionVoiceTranscription` is enabled.
- Existing verified API-key dictation remains available everywhere it works today, including non-Codex composers and current Codex queued-prompt/manual recording during an active turn; selecting another provider never triggers Codex auth or hides the existing mic.
- Routine provider refresh, settings rendering, and login-health checks never request token inclusion or call the private endpoint.
- Voice uploads require a one-use scoped ticket plus a per-WebSocket-connection proof in headers; tickets expire, are invalidated when their connection closes, and cannot be replayed from another renderer.
- Subscription auth is never visible in renderer-facing RPC/HTTP responses, local storage, persisted state, logs, metrics, snapshots, diagnostics, or errors, and no bearer is cached by default. The internal experimental app-server auth response is handled only in server memory and is immediately redacted from observability.
- If subscription transcription returns `unavailable`, exhausted `unauthorized`/`forbidden`, `rate-limited`, `timeout`, or `network`, one verified OpenAI API fallback replays the same raw PCM with ordered backpressure, exactly one commit, bounded completion wait, and cancellation; other categories do not auto-fallback.
- When neither route is available, the mic is disabled or fails with a clear, actionable settings message; bigbud never claims operational subscription support from login state alone.
- Manual mode applies the transcript at the captured selection/cursor when safe and never sends automatically. A changed composer produces a bounded Insert/Copy/Discard conflict payload with no silent overwrite.
- Auto-send mode defaults to a 10-second silence threshold after real speech begins, calls the atomic normal send path exactly once, and does not send after cancel, any send-affecting composer mutation, navigation, provider change, focus/visibility loss, suspend/wake, busy state, connection uncertainty, or pending interaction.
- Audio capture is bounded to 120 seconds/10 MiB, subscription upload concurrency is globally bounded, each renderer permits only one active Realtime replay, cancellation releases all media/process/network/content references, and stale results cannot cross draft, thread, provider, operation, or renderer boundaries.
- TTS is off by default and can be configured for completion only or start/active-work-interval/completion milestones.
- TTS speaks only for the selected Codex thread from canonical state and assistant content matching the completed `turnId`; deterministic sanitization removes code, Markdown artifacts, URLs, long paths, raw IDs, and unsafe/oversized text, with generic fallback copy.
- TTS emits no “still working” interval while awaiting approval/input, emits no catch-up burst after sleep, and is spoken by exactly one renderer globally.
- Starting microphone capture cancels/suppresses TTS, waits for speech idle, and spoken output cannot be captured into a new prompt.
- Existing API-key Realtime transcription, composer draft/send behavior, completion notifications, and desktop microphone permissions do not regress.
- `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass.

## Open Questions

1. Is the product/security owner willing to ship Synara's undocumented private ChatGPT endpoint if no supported Codex app-server transcription method exists, or must subscription voice wait for an official capability?
2. What is the issue ID for implementation and rollout tracking, and who owns the decision record and `providers.codex.rollout.subscriptionVoiceTranscription` kill switch?
3. Is OS-provided speech synthesis acceptable for the first TTS release with the documented caveat that some OS voices may be downloadable or network-backed, or is higher-quality API TTS separate future work?
4. Should completion speech remain limited to the focused renderer's selected thread as recommended, or should users later be able to opt into background-thread announcements?
5. Is the proposed five-minute active-work interval appropriate, and what minimum/maximum choices should the settings UI expose?
6. Should entering `awaiting_approval` or `awaiting_input` speak one short “needs input” cue, or remain silent until completion?
7. For transcript conflicts, should **Insert** use the captured selection when it is still valid or always insert at the current cursor? The safety behavior is fixed: explicit Insert/Copy/Discard and no auto-send.
8. After the Codex-only subscription/auto-send/TTS release is stable, should the shared voice controller be extended first for FluidVoice, other AI providers, or active-turn voice steering?
