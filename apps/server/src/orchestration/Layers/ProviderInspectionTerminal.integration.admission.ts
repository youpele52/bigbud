import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { ProviderSessionDirectoryShape } from "../../provider/Services/ProviderSessionDirectory.ts";
import { makeThreadOperations } from "../../provider/Layers/ProviderService.threadOperations.ts";

type Operations = Pick<
  ProviderServiceShape,
  | "sendTurn"
  | "startSession"
  | "startSessionFresh"
  | "recordInspectionTerminal"
  | "publishInspectionTerminal"
  | "confirmInspectedTurn"
>;

/** Capture raw operations: terminal replay bypasses admission, never reacquires the same lease. */
export function makeInspectionAdmission(
  directory: ProviderSessionDirectoryShape,
  operations: Operations,
): Operations {
  const run = makeThreadOperations(directory);
  return {
    sendTurn: (input) => run(input.threadId, operations.sendTurn(input)),
    startSession: (threadId, input) => run(threadId, operations.startSession(threadId, input)),
    startSessionFresh: (threadId, input) =>
      run(threadId, operations.startSessionFresh(threadId, input)),
    recordInspectionTerminal: (event, items) =>
      run(event.threadId, operations.recordInspectionTerminal!(event, items), true),
    publishInspectionTerminal: (record) =>
      run(record.terminal.threadId, operations.publishInspectionTerminal!(record), true),
    confirmInspectedTurn: (input) =>
      run(input.threadId, operations.confirmInspectedTurn!(input), true),
  };
}
