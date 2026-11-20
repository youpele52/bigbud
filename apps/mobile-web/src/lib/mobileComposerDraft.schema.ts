import {
  ClientOrchestrationCommand,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@bigbud/contracts";
import * as Schema from "effect/Schema";
import { OrchestrationCommandRejectionReason } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { MobileCommandReceiptSource } from "./mobileCommandReceiptSource";
const MobileDraftThreadSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  modelSelection: Schema.NullOr(ModelSelection),
});

const MobileDraftAnswerSchema = Schema.Struct({
  selectedOptionKeys: Schema.optional(Schema.Array(Schema.String)),
  selectedOptionIds: Schema.optional(Schema.Array(Schema.String)),
  selectedOptionLabels: Schema.optional(Schema.Array(Schema.String)),
  customAnswer: Schema.optional(Schema.String),
});

const submittedFields = {
  command: ClientOrchestrationCommand,
  submittedRevision: NonNegativeInt,
  submittedAt: IsoDateTime,
  deadlineAt: Schema.Number,
  status: Schema.Literals(["pending", "accepted", "rejected", "uncertain", "reconciling"]),
  rejectionReason: Schema.optional(OrchestrationCommandRejectionReason),
};
const MobileSubmittedCommandSchema = Schema.Struct(submittedFields);
const CarriedSubmittedCommandSchema = Schema.Struct({
  ...submittedFields,
  receiptSource: Schema.optional(MobileCommandReceiptSource),
});

const draftFields = {
  threadId: ThreadId,
  prompt: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  newThread: Schema.NullOr(MobileDraftThreadSchema),
  userInputAnswersByRequestId: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, MobileDraftAnswerSchema),
  ),
  userInputQuestionIndexByRequestId: Schema.Record(Schema.String, NonNegativeInt),
  revision: NonNegativeInt,
  submitted: Schema.NullOr(MobileSubmittedCommandSchema),
  decisionSubmitted: Schema.optional(Schema.NullOr(MobileSubmittedCommandSchema)),
  updatedAt: IsoDateTime,
};
export const LegacyMobileComposerDraftSchema = Schema.Struct({
  ...draftFields,
  version: Schema.Literal(1),
});
export const MobileComposerDraftSchema = Schema.Union([
  LegacyMobileComposerDraftSchema,
  Schema.Struct({
    ...draftFields,
    version: Schema.Literal(2),
    submitted: Schema.NullOr(CarriedSubmittedCommandSchema),
    decisionSubmitted: Schema.optional(Schema.NullOr(CarriedSubmittedCommandSchema)),
  }),
]);
