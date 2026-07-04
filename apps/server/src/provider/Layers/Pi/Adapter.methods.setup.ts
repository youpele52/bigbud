import type { ThreadId } from "@bigbud/contracts";

import type { PiEmitEvents, PiSyntheticEventFn } from "./Adapter.types.ts";
import {
  makeAppendTextFileAttachments,
  makeResolveImages,
  makeStopSessionRecord,
} from "./Adapter.session.helpers.ts";

export function createPiMethodSetup(input: {
  readonly attachmentsDir: string;
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly threadId?: ThreadId;
}) {
  return {
    resolveImages: makeResolveImages(input.attachmentsDir),
    appendTextFileAttachments: makeAppendTextFileAttachments(input.attachmentsDir),
    stopSessionRecord: makeStopSessionRecord({
      emit: input.emit,
      makeSyntheticEvent: input.makeSyntheticEvent,
    }),
  };
}
