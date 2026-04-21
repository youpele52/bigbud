import { type ComponentProps } from "react";

import { type TurnDiffSummary } from "../../../models/types";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  createBaseTimelineProps,
  createChangedFilesSummary,
  createFillerMessages,
  createMessage,
  createPlan,
  createToolWorkEntry,
} from "./MessagesTimeline.virtualization.test.helpers";

export interface VirtualizationScenario {
  name: string;
  targetRowId: string;
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">;
  maxEstimateDeltaPx: number;
}

export function createChangedFilesScenario(input: {
  name: string;
  rowId: string;
  files: TurnDiffSummary["files"];
  maxEstimateDeltaPx?: number;
}): VirtualizationScenario {
  const beforeMessages = createFillerMessages({
    prefix: `${input.rowId}-before`,
    startOffsetSeconds: 0,
    pairCount: 2,
  });
  const afterMessages = createFillerMessages({
    prefix: `${input.rowId}-after`,
    startOffsetSeconds: 40,
    pairCount: 8,
  });
  const changedFilesMessage = createMessage({
    id: input.rowId,
    role: "assistant",
    text: "Validation passed on the merged tree.",
    offsetSeconds: 12,
  });

  return {
    name: input.name,
    targetRowId: changedFilesMessage.id,
    props: createBaseTimelineProps({
      messages: [...beforeMessages, changedFilesMessage, ...afterMessages],
      turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(
        changedFilesMessage.id,
        input.files,
      ),
    }),
    maxEstimateDeltaPx: input.maxEstimateDeltaPx ?? 72,
  };
}

export function createAssistantMessageScenario(input: {
  name: string;
  rowId: string;
  text: string;
  maxEstimateDeltaPx?: number;
}): VirtualizationScenario {
  const beforeMessages = createFillerMessages({
    prefix: `${input.rowId}-before`,
    startOffsetSeconds: 0,
    pairCount: 2,
  });
  const afterMessages = createFillerMessages({
    prefix: `${input.rowId}-after`,
    startOffsetSeconds: 40,
    pairCount: 8,
  });
  const assistantMessage = createMessage({
    id: input.rowId,
    role: "assistant",
    text: input.text,
    offsetSeconds: 12,
  });

  return {
    name: input.name,
    targetRowId: assistantMessage.id,
    props: createBaseTimelineProps({
      messages: [...beforeMessages, assistantMessage, ...afterMessages],
    }),
    maxEstimateDeltaPx: input.maxEstimateDeltaPx ?? 16,
  };
}

export function buildStaticScenarios(): VirtualizationScenario[] {
  const beforeMessages = createFillerMessages({
    prefix: "before",
    startOffsetSeconds: 0,
    pairCount: 2,
  });
  const afterMessages = createFillerMessages({
    prefix: "after",
    startOffsetSeconds: 40,
    pairCount: 8,
  });

  const longUserMessage = createMessage({
    id: "target-user-long",
    role: "user",
    text: "x".repeat(3_200),
    offsetSeconds: 12,
  });
  const workEntries = Array.from({ length: 4 }, (_, index) =>
    createToolWorkEntry({
      id: `target-work-${index}`,
      offsetSeconds: 12 + index,
      detail: `tool output line ${index + 1}`,
    }),
  );
  const moderatePlan = createPlan({
    id: "target-plan",
    offsetSeconds: 12,
    planMarkdown: [
      "# Stabilize virtualization",
      "",
      "- Gather baseline measurements",
      "- Add browser harness coverage",
      "- Compare estimated and rendered heights",
      "- Fix the broken rows without broad refactors",
      "- Re-run lint and typecheck",
    ].join("\n"),
  });

  return [
    {
      name: "long user message",
      targetRowId: longUserMessage.id,
      props: createBaseTimelineProps({
        messages: [...beforeMessages, longUserMessage, ...afterMessages],
      }),
      maxEstimateDeltaPx: 56,
    },
    {
      name: "grouped work log row",
      targetRowId: workEntries[0]!.id,
      props: createBaseTimelineProps({
        messages: [...beforeMessages, ...afterMessages],
        workEntries,
      }),
      maxEstimateDeltaPx: 56,
    },
    {
      name: "expanded grouped work log row with show more enabled",
      targetRowId: "target-work-expanded-0",
      props: createBaseTimelineProps({
        messages: [...beforeMessages, ...afterMessages],
        workEntries: Array.from({ length: 10 }, (_, index) =>
          createToolWorkEntry({
            id: `target-work-expanded-${index}`,
            offsetSeconds: 12 + index,
            detail: `tool output line ${index + 1}`,
          }),
        ),
        expandedWorkGroups: {
          "target-work-expanded-0": true,
        },
      }),
      maxEstimateDeltaPx: 72,
    },
    {
      name: "proposed plan row",
      targetRowId: moderatePlan.id,
      props: createBaseTimelineProps({
        messages: [...beforeMessages, ...afterMessages],
        proposedPlans: [moderatePlan],
      }),
      maxEstimateDeltaPx: 96,
    },
    createAssistantMessageScenario({
      name: "assistant single-paragraph row with plain prose",
      rowId: "target-assistant-plain-prose",
      text: [
        "The host is still expanding to content somewhere in the grid layout.",
        "I'm stripping it back further to a plain block container so the test width",
        "is actually the timeline width.",
      ].join(" "),
    }),
    createAssistantMessageScenario({
      name: "assistant single-paragraph row with inline code",
      rowId: "target-assistant-inline-code",
      text: [
        "Typecheck found one exact-optional-property issue in the browser harness:",
        "I was always passing `onVirtualizerSnapshot`, including `undefined`.",
        "I'm tightening that object construction and rerunning the checks.",
      ].join(" "),
      maxEstimateDeltaPx: 28,
    }),
    createChangedFilesScenario({
      name: "assistant changed-files row with a compacted single-chain directory",
      rowId: "target-assistant-changed-files-single-chain",
      files: [
        { path: "apps/web/src/components/chat/ChangedFilesTree.tsx", additions: 37, deletions: 45 },
        {
          path: "apps/web/src/components/chat/ChangedFilesTree.test.tsx",
          additions: 0,
          deletions: 26,
        },
      ],
    }),
    createChangedFilesScenario({
      name: "assistant changed-files row with a branch after compaction",
      rowId: "target-assistant-changed-files-branch-point",
      files: [
        { path: "apps/server/src/git/Layers/GitCore.ts", additions: 44, deletions: 38 },
        { path: "apps/server/src/git/Layers/GitCore.test.ts", additions: 18, deletions: 9 },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          additions: 27,
          deletions: 8,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.test.ts",
          additions: 36,
          deletions: 0,
        },
      ],
    }),
    createChangedFilesScenario({
      name: "assistant changed-files row with mixed root and nested entries",
      rowId: "target-assistant-changed-files-mixed-root",
      files: [
        { path: "README.md", additions: 5, deletions: 1 },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
      ],
    }),
  ];
}
