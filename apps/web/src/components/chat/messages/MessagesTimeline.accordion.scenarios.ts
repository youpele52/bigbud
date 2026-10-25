import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { RuntimeTaskId, TurnId, type OrchestrationTask } from "@bigbud/contracts";

import { type WorkLogEntry } from "../../../logic/session";
import { type AnsweredUserInput } from "../../../logic/session/session.userInputHistory.logic";
import {
  createBaseTimelineProps,
  createFillerMessages,
  createToolWorkEntry,
  isoAt,
} from "./MessagesTimeline.virtualization.test.fixtures";
import { type VirtualizationScenario } from "./MessagesTimeline.virtualization.scenarios";

const CHECKOUT_COMMAND =
  "git -C /repo/project log --oneline --graph --decorate --all --max-count=200 -- apps/web/src";

function withFillers(name: string) {
  return {
    before: createFillerMessages({ prefix: `${name}-before`, startOffsetSeconds: 0, pairCount: 2 }),
    after: createFillerMessages({ prefix: `${name}-after`, startOffsetSeconds: 40, pairCount: 8 }),
  };
}

function workLog(prefix: string, count: number): WorkLogEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...createToolWorkEntry({ id: `${prefix}-${index}`, offsetSeconds: 12 + index }),
    tone: index === 0 ? ("info" as const) : ("tool" as const),
    command: index === count - 1 ? CHECKOUT_COMMAND : `echo step ${index}`,
  }));
}

export function answeredQuestion(): AnsweredUserInput {
  return {
    requestId: ApprovalRequestId.makeUnsafe("request-accordion"),
    createdAt: isoAt(12),
    answeredAt: isoAt(13),
    questions: [
      {
        id: "mode",
        header: "Mode",
        question: "Which mode should we use?",
        multiSelect: false,
        options: [
          { label: "Safe mode", description: "Read only" },
          { label: "Write mode", description: "Allow changes" },
        ],
      },
    ],
    answers: { mode: "Safe mode" },
  };
}

export function historicalSubagents(): OrchestrationTask[] {
  return ["first", "second"].map((id) => ({
    id: RuntimeTaskId.makeUnsafe(`subagent-${id}`),
    kind: "providerSubagent",
    nativeId: id,
    activityFresh: false,
    status: "completed",
    subject: `Subagent ${id}`,
    source: "observed",
    freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
    turnId: TurnId.makeUnsafe("turn-accordion"),
    createdAt: isoAt(12),
    updatedAt: isoAt(14),
  }));
}

const thinkingDetail = "Comparing the persisted accordion state against the virtualizer. ".repeat(
  6,
);

/** Collapsed and open accordion rows whose estimates must track the rendered height. */
export function buildAccordionScenarios(): VirtualizationScenario[] {
  const { before, after } = withFillers("accordion");
  const thinking: WorkLogEntry = {
    id: "target-thinking",
    createdAt: isoAt(12),
    label: "Thinking",
    detail: thinkingDetail,
    tone: "thinking",
  };
  const messages = [...before, ...after];
  return [
    {
      name: "collapsed finished work log",
      targetRowId: "target-work-collapsed-0",
      props: createBaseTimelineProps({
        messages,
        workEntries: workLog("target-work-collapsed", 4),
      }),
      maxEstimateDeltaPx: 2,
    },
    {
      name: "open work log with a command details toggle",
      targetRowId: "target-work-open-0",
      props: createBaseTimelineProps({
        messages,
        workEntries: workLog("target-work-open", 4),
        activityAccordionOpenById: { "work:target-work-open-0": true },
      }),
      maxEstimateDeltaPx: 4,
    },
    {
      name: "open work log with open command details",
      targetRowId: "target-work-full-0",
      props: createBaseTimelineProps({
        messages,
        workEntries: workLog("target-work-full", 4),
        activityAccordionOpenById: {
          "work:target-work-full-0": true,
          "work-entry:target-work-full-3": true,
        },
      }),
      maxEstimateDeltaPx: 8,
    },
    {
      name: "collapsed single tool call",
      targetRowId: "target-work-single",
      props: createBaseTimelineProps({
        messages,
        workEntries: [createToolWorkEntry({ id: "target-work-single", offsetSeconds: 12 })],
      }),
      maxEstimateDeltaPx: 2,
    },
    {
      name: "open single tool call",
      targetRowId: "target-work-single",
      props: createBaseTimelineProps({
        messages,
        workEntries: [createToolWorkEntry({ id: "target-work-single", offsetSeconds: 12 })],
        activityAccordionOpenById: { "work:target-work-single": true },
      }),
      maxEstimateDeltaPx: 2,
    },
    {
      name: "collapsed finished thinking",
      targetRowId: "target-thinking",
      props: createBaseTimelineProps({ messages, workEntries: [thinking] }),
      maxEstimateDeltaPx: 2,
    },
    {
      name: "open thinking",
      targetRowId: "target-thinking",
      props: createBaseTimelineProps({
        messages,
        workEntries: [thinking],
        activityAccordionOpenById: { "thinking:target-thinking": true },
      }),
      maxEstimateDeltaPx: 8,
    },
    {
      name: "collapsed answered question",
      targetRowId: "user-input-question:request-accordion",
      props: createBaseTimelineProps({ messages, answeredUserInputs: [answeredQuestion()] }),
      maxEstimateDeltaPx: 2,
    },
    {
      name: "open answered question",
      targetRowId: "user-input-question:request-accordion",
      props: createBaseTimelineProps({
        messages,
        answeredUserInputs: [answeredQuestion()],
        activityAccordionOpenById: { "question:user-input-question:request-accordion": true },
      }),
      maxEstimateDeltaPx: 8,
    },
    {
      name: "collapsed subagents history",
      targetRowId: "subagents-history:turn:turn-accordion",
      props: createBaseTimelineProps({ messages, historicalAgents: historicalSubagents() }),
      maxEstimateDeltaPx: 2,
    },
    {
      name: "open subagents history",
      targetRowId: "subagents-history:turn:turn-accordion",
      props: createBaseTimelineProps({
        messages,
        historicalAgents: historicalSubagents(),
        activityAccordionOpenById: { "subagents:subagents-history:turn:turn-accordion": true },
      }),
      maxEstimateDeltaPx: 4,
    },
  ];
}
