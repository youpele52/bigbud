import type { ThreadId } from "@bigbud/contracts";
import {
  MessageId,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { Effect, Queue } from "effect";

import type { OrchestrationDispatchError } from "../orchestration/Errors";

export type ShellOutputEvent =
  | {
      readonly type: "append";
      readonly text: string;
    }
  | {
      readonly type: "replace";
      readonly text: string;
    }
  | {
      readonly type: "complete";
    };

interface ShellOutputDispatchServices {
  readonly orchestrationEngine: {
    readonly dispatch: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
  };
  readonly serverCommandId: (tag: string) => OrchestrationCommand["commandId"];
  readonly toDispatchCommandError: (
    cause: unknown,
    fallbackMessage: string,
  ) => OrchestrationDispatchCommandError;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

export const dispatchShellAssistantDelta = (
  input: ShellOutputDispatchServices & { readonly delta: string },
) =>
  input.orchestrationEngine
    .dispatch({
      type: "thread.message.assistant.delta",
      commandId: input.serverCommandId("shell-output-delta"),
      threadId: input.threadId,
      messageId: input.messageId,
      delta: input.delta,
      createdAt: new Date().toISOString(),
    })
    .pipe(
      Effect.mapError((cause) =>
        input.toDispatchCommandError(cause, "Failed to append shell output."),
      ),
    );

const dispatchShellAssistantComplete = (input: ShellOutputDispatchServices) =>
  input.orchestrationEngine
    .dispatch({
      type: "thread.message.assistant.complete",
      commandId: input.serverCommandId("shell-output-complete"),
      threadId: input.threadId,
      messageId: input.messageId,
      createdAt: new Date().toISOString(),
    })
    .pipe(
      Effect.mapError((cause) =>
        input.toDispatchCommandError(cause, "Failed to complete shell output message."),
      ),
    );

const dispatchShellAssistantReplace = (
  input: ShellOutputDispatchServices & { readonly text: string },
) =>
  input.orchestrationEngine
    .dispatch({
      type: "thread.message.assistant.replace",
      commandId: input.serverCommandId("shell-output-replace"),
      threadId: input.threadId,
      messageId: input.messageId,
      text: input.text,
      createdAt: new Date().toISOString(),
    })
    .pipe(
      Effect.mapError((cause) =>
        input.toDispatchCommandError(cause, "Failed to replace shell output message."),
      ),
    );

export const consumeShellOutputEvents = (
  input: {
    readonly outputQueue: Queue.Queue<ShellOutputEvent>;
  } & ShellOutputDispatchServices,
) =>
  Effect.gen(function* () {
    let hasWrittenBody = false;

    while (true) {
      const event = yield* Queue.take(input.outputQueue);

      if (event.type === "complete") {
        yield* dispatchShellAssistantComplete(input);
        return;
      }

      if (event.text.length === 0) {
        continue;
      }

      if (event.type === "replace") {
        hasWrittenBody = event.text.length > 0;
        yield* dispatchShellAssistantReplace({
          ...input,
          text: event.text,
        });
        continue;
      }

      const delta = hasWrittenBody ? event.text : `\n\n${event.text}`;
      hasWrittenBody = true;
      yield* dispatchShellAssistantDelta({ ...input, delta });
    }
  });
