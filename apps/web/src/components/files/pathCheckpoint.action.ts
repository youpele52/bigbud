import type { DispatchableClientOrchestrationCommand, ThreadId } from "@bigbud/contracts";

type PathCheckpointCommand = Extract<
  DispatchableClientOrchestrationCommand,
  { type: "thread.path-checkpoint.capture" | "thread.path-checkpoint.restore" }
>;

export async function dispatchPathCheckpointAction(input: {
  readonly operation: "capture" | "restore";
  readonly threadId: ThreadId;
  readonly path: string;
  readonly commandId: PathCheckpointCommand["commandId"];
  readonly api: {
    readonly dialogs: { readonly confirm: (message: string) => Promise<boolean> };
    readonly orchestration: {
      readonly dispatchCommand: (command: PathCheckpointCommand) => Promise<unknown>;
    };
  };
}): Promise<void> {
  if (input.operation === "restore") {
    const confirmed = await input.api.dialogs.confirm(
      `Restore the checkpoint for ${input.path}?\nThis discards current changes in this path and cannot be undone.`,
    );
    if (!confirmed) return;
  }
  await input.api.orchestration.dispatchCommand({
    type: `thread.path-checkpoint.${input.operation}`,
    commandId: input.commandId,
    threadId: input.threadId,
    path: input.path,
    createdAt: new Date().toISOString(),
  });
}
