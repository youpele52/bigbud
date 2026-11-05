import { CommandId, EventId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  HTML_RENDER_ACTIVITY_KIND,
  HtmlRenderInput,
} from "@bigbud/contracts/orchestration/htmlRender.ts";
import { Effect, Schema } from "effect";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { stableThreadToolId } from "./ThreadOrchestrationTools.origins.ts";

/** Persist through the existing event store so replay, deletion and revert retain normal ownership. */
export const publishHtmlRender = Effect.fn("publishHtmlRender")(function* (input: {
  readonly engine: OrchestrationEngineShape;
  readonly threadId: ThreadId;
  readonly invocationId: string;
  readonly expectedTurnId?: string;
  readonly arguments: unknown;
}) {
  const content = yield* Schema.decodeUnknownEffect(HtmlRenderInput)(input.arguments).pipe(
    Effect.mapError(
      () => new Error("Expected title (1–120 characters) and HTML (1–24000 characters)."),
    ),
  );
  if (!input.invocationId.trim() || input.invocationId.length > 512)
    return yield* Effect.fail(new Error("A bounded invocation identity is required."));
  const identity = JSON.stringify([input.threadId, "render_html", input.invocationId]);
  const commandId = CommandId.makeUnsafe(stableThreadToolId("command", identity));
  const id = EventId.makeUnsafe(stableThreadToolId("html", identity));
  const previous = input.engine.readEventsByCommandId
    ? yield* input.engine
        .readEventsByCommandId(commandId)
        .pipe(Effect.mapError((error) => new Error(String(error))))
    : [];
  const published = previous.find((event) => event.type === "thread.activity-appended");
  if (published?.type === "thread.activity-appended") {
    if (
      input.expectedTurnId !== undefined &&
      input.expectedTurnId !== published.payload.activity.turnId
    )
      return yield* Effect.fail(
        new Error("HTML invocation belongs to a different originating turn."),
      );
    if (JSON.stringify(published.payload.activity.payload) !== JSON.stringify(content))
      return yield* Effect.fail(new Error("This invocation already published different HTML."));
    return { artifactId: id, turnId: published.payload.activity.turnId, published: true };
  }
  const thread = yield* ensureOrchestrationThreadState(input.engine, input.threadId, "operational");
  const turn = thread?.latestTurn;
  if (!thread || thread.deletedAt || thread.deletingAt || !turn || turn.completedAt)
    return yield* Effect.fail(new Error("HTML publication requires an active thread turn."));
  if (input.expectedTurnId !== undefined && input.expectedTurnId !== turn.turnId)
    return yield* Effect.fail(
      new Error("HTML invocation belongs to a different originating turn."),
    );
  // Stable timestamp keeps simultaneous retries identical at the engine receipt boundary.
  const createdAt = turn.startedAt ?? turn.requestedAt;
  yield* input.engine
    .dispatch({
      type: "thread.activity.append",
      commandId,
      threadId: input.threadId,
      createdAt,
      activity: {
        id,
        kind: HTML_RENDER_ACTIVITY_KIND,
        tone: "info",
        summary: content.title,
        payload: content,
        turnId: turn.turnId,
        createdAt,
      },
    })
    .pipe(Effect.mapError((error) => new Error(String(error))));
  return { artifactId: id, turnId: turn.turnId, published: true };
});
