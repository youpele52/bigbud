import type {
  OrchestrationReadModel,
  OrchestrationThread,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import {
  isOversizedMobileRecord,
  withMobileTooLargeNotice,
} from "../../mobile/mobileRecordBounds.ts";
import { activityTruncationFields } from "./ProjectionCatalogQuery.boundedText.ts";
import type {
  MobileProposedPlanDbRow,
  MobileThreadActivityDbRow,
  MobileThreadMessageDbRow,
} from "./ProjectionSnapshotQuery.mobileSql.bounds.ts";

/** Stored lengths of the records the mobile SQL cut, keyed by `mobileRecordKey`. */
export interface MobileRecordBounds {
  readonly messageLengths: ReadonlyMap<string, number>;
  readonly planLengths: ReadonlyMap<string, number>;
  readonly activityLengths: ReadonlyMap<string, number>;
}

export const mobileRecordKey = (threadId: string, recordId: string) =>
  `${threadId}\u0000${recordId}`;

function oversizedLengths<T extends { readonly threadId: string }>(
  rows: ReadonlyArray<T>,
  recordId: (row: T) => string,
  storedLength: (row: T) => number | null,
): ReadonlyMap<string, number> {
  const lengths = new Map<string, number>();
  for (const row of rows) {
    const length = storedLength(row);
    if (isOversizedMobileRecord(length)) {
      lengths.set(mobileRecordKey(row.threadId, recordId(row)), length);
    }
  }
  return lengths;
}

export function collectMobileRecordBounds(rows: {
  readonly messageRows: ReadonlyArray<MobileThreadMessageDbRow>;
  readonly proposedPlanRows: ReadonlyArray<MobileProposedPlanDbRow>;
  readonly activityRows: ReadonlyArray<MobileThreadActivityDbRow>;
}): MobileRecordBounds {
  return {
    messageLengths: oversizedLengths(
      rows.messageRows,
      (row) => row.messageId,
      (row) => row.textLength,
    ),
    planLengths: oversizedLengths(
      rows.proposedPlanRows,
      (row) => row.planId,
      (row) => row.planMarkdownLength,
    ),
    activityLengths: oversizedLengths(
      rows.activityRows,
      (row) => row.activityId,
      (row) => row.payloadLength,
    ),
  };
}

const hasBounds = (bounds: MobileRecordBounds) =>
  bounds.messageLengths.size > 0 || bounds.planLengths.size > 0 || bounds.activityLengths.size > 0;

/**
 * Marks the records the mobile SQL cut: a message or plan preview gains the too-large notice, and
 * an activity whose payload became `{}` gains `payloadTruncated`/`payloadLength`.
 */
export function applyMobileRecordBoundsToThread(
  thread: OrchestrationThread,
  bounds: MobileRecordBounds,
): OrchestrationThread {
  if (!hasBounds(bounds)) return thread;
  const lengthOf = (lengths: ReadonlyMap<string, number>, recordId: string) =>
    lengths.get(mobileRecordKey(thread.id, recordId));
  return {
    ...thread,
    messages: thread.messages.map((message) => {
      const length = lengthOf(bounds.messageLengths, message.id);
      return length === undefined
        ? message
        : { ...message, text: withMobileTooLargeNotice(message.text, length) };
    }),
    proposedPlans: thread.proposedPlans.map((plan) => {
      const length = lengthOf(bounds.planLengths, plan.id);
      return length === undefined
        ? plan
        : { ...plan, planMarkdown: withMobileTooLargeNotice(plan.planMarkdown, length) };
    }),
    activities: thread.activities.map((activity) => {
      const length = lengthOf(bounds.activityLengths, activity.id);
      return length === undefined ? activity : { ...activity, ...activityTruncationFields(length) };
    }),
  };
}

export function applyMobileRecordBounds(
  model: OrchestrationReadModel,
  bounds: MobileRecordBounds,
): OrchestrationReadModel {
  if (!hasBounds(bounds)) return model;
  return {
    ...model,
    threads: model.threads.map((thread) => applyMobileRecordBoundsToThread(thread, bounds)),
  };
}
