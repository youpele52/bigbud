/**
 * ClaudeProviderRefreshReactor - refreshes the Claude provider snapshot when a session
 * reports changed slash commands or new rate-limit info, so the composer's command list
 * and the usage panel follow the authoritative probe.
 *
 * It only reads the provider event stream and calls `ProviderRegistry.refresh`; it never
 * touches sessions, turns or ingestion.
 *
 * @module ClaudeProviderRefreshReactor
 */
import { Effect, Layer, Stream } from "effect";

import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  CLAUDE_PROVIDER_REFRESH_WINDOW,
  isClaudeProviderRefreshTrigger,
  makeCoalescedRefresh,
} from "./ClaudeProviderRefreshReactor.logic.ts";

export const ClaudeProviderRefreshReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const registry = yield* ProviderRegistry;
    const trigger = yield* makeCoalescedRefresh(
      registry.refresh("claudeAgent").pipe(Effect.asVoid),
      CLAUDE_PROVIDER_REFRESH_WINDOW,
    );
    yield* Stream.runForEach(providerService.streamEvents, (event) =>
      isClaudeProviderRefreshTrigger(event) ? trigger : Effect.void,
    ).pipe(Effect.forkScoped);
  }),
);
