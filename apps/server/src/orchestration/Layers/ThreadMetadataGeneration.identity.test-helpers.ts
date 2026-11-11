import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  MetadataCapturedContext,
  MetadataCapturedPath,
} from "./ThreadMetadataGeneration.context.ts";
export function evidenceFixture(operation: "title" | "summary" = "title") {
  const model = "gpt-5.4";
  const effort = "medium";
  const path: MetadataCapturedPath = {
    selection: { provider: "copilot", model, options: { reasoningEffort: effort } },
    transport: "fixture-transport",
    accountIdentity: "fixture-account",
    executionTarget: "local",
    promptVersion: "1",
    validatorVersion: "1",
    mode: "auxiliary",
  };
  const base = {
    version: 1 as const,
    threadId: ThreadId.makeUnsafe("metadata-fixture-thread"),
    expectedRevision: 0,
    configEpoch: "fixture-epoch",
    configuredPrimary: true,
    primaryPath: path,
    threadPath: null,
    workspace: {
      projectId: ProjectId.makeUnsafe("metadata-fixture-project"),
      worktreePath: null,
      branch: null,
      executionTarget: "local",
      cwd: "/metadata-fixture/project",
    },
    source: { prefixLength: 1, frontier: 1, digest: "fixture-source" },
  };
  const context: MetadataCapturedContext =
    operation === "title"
      ? {
          ...base,
          operation,
          initialTitle: "New thread",
          titleSeed: "New thread",
          message: "Repair recovery",
          attachments: [],
        }
      : {
          ...base,
          operation,
          previousSummary: "Investigating recovery",
          previousMessageCount: 1,
          transcript: "User: Repair recovery\nAssistant: Found restart issue",
        };
  return { context, path };
}
