import { MobileRecoveryBaselineError } from "@bigbud/contracts/server/mobile.recovery";

import {
  MOBILE_BASELINE_MAX_BYTES,
  MOBILE_BASELINE_TOO_LARGE_MESSAGE,
  MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH,
  previewMobileText,
} from "../../mobile/mobileRecordBounds.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { serializedBytes } from "../../ws/wsMobileRecovery.frames.ts";
import type { ProjectionMobileRecoveryBaseline } from "../Services/ProjectionSnapshotQuery.ts";
import {
  mobileRecordKey,
  type MobileRecordBounds,
} from "./ProjectionSnapshotQuery.mobileRecordBounds.ts";

/** Upper bound on the bytes `hasOlderHistory: true` adds to the selected thread. */
const HAS_OLDER_HISTORY_FLAG_BYTES = serializedBytes({ hasOlderHistory: true });

/**
 * Step (a): drops the selected thread's oldest messages until the measured excess is gone, never
 * below the newest message, and flags the older history.
 */
function dropOldestSelectedMessages(
  baseline: ProjectionMobileRecoveryBaseline,
  excessBytes: number,
): ProjectionMobileRecoveryBaseline {
  const selected = baseline.selectedThread;
  if (selected?.status !== "present" || selected.thread.messages.length <= 1) return baseline;
  const messages = selected.thread.messages;
  const target =
    excessBytes + (selected.hasOlderHistory === true ? 0 : HAS_OLDER_HISTORY_FLAG_BYTES);
  let dropped = 0;
  let freed = 0;
  while (dropped < messages.length - 1 && freed < target) {
    // Each array element also costs its separating comma.
    freed += serializedBytes(messages[dropped]) + 1;
    dropped += 1;
  }
  return {
    ...baseline,
    selectedThread: {
      ...selected,
      thread: { ...selected.thread, messages: messages.slice(dropped) },
      hasOlderHistory: true,
    },
  };
}

/**
 * Step (b): cuts every summary message to a short preview with the too-large notice. Streaming
 * messages stay whole, because live deltas append to them.
 */
function previewSummaryMessages(
  baseline: ProjectionMobileRecoveryBaseline,
  bounds: MobileRecordBounds,
): ProjectionMobileRecoveryBaseline {
  return {
    ...baseline,
    snapshot: {
      ...baseline.snapshot,
      threads: baseline.snapshot.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.streaming
            ? message
            : {
                ...message,
                text: previewMobileText(
                  message.text,
                  MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH,
                  bounds.messageLengths.get(mobileRecordKey(thread.id, message.id)) ??
                    message.text.length,
                ),
              },
        ),
      })),
    },
  };
}

const measure = (baseline: ProjectionMobileRecoveryBaseline) =>
  serializedBytes({
    snapshot: baseline.snapshot,
    snapshotSequence: baseline.snapshotSequence,
    selectedThread: baseline.selectedThread,
  });

/**
 * Fits the baseline within `maxBytes` of serialized JSON, degrading in order and re-measuring
 * after each step: (a) older selected-thread messages, then (b) summary message previews. Returns
 * `null` when neither is enough (c). Pending approvals and questions are never dropped.
 */
export function fitMobileBaselineBudget(
  baseline: ProjectionMobileRecoveryBaseline,
  bounds: MobileRecordBounds,
  maxBytes: number = MOBILE_BASELINE_MAX_BYTES,
): ProjectionMobileRecoveryBaseline | null {
  const initialBytes = measure(baseline);
  if (initialBytes <= maxBytes) return baseline;
  const newestOnly = dropOldestSelectedMessages(baseline, initialBytes - maxBytes);
  if (newestOnly !== baseline && measure(newestOnly) <= maxBytes) return newestOnly;
  const previewed = previewSummaryMessages(newestOnly, bounds);
  return measure(previewed) <= maxBytes ? previewed : null;
}

/**
 * Step (c). The baseline query's typed failure is a persistence error, so the mobile error rides
 * as its cause; the RPC layer turns it into a `MobileRecoveryBaselineError` response, never a
 * socket close.
 */
export function mobileBaselineTooLargeError(): PersistenceSqlError {
  return new PersistenceSqlError({
    operation: "ProjectionSnapshotQuery.getMobileRecoveryBaseline:byteBudget",
    detail: MOBILE_BASELINE_TOO_LARGE_MESSAGE,
    cause: new MobileRecoveryBaselineError({
      message: MOBILE_BASELINE_TOO_LARGE_MESSAGE,
      retryable: false,
    }),
  });
}
