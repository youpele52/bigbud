/**
 * Muse MSP wire schemas (Phase 0-qualified CLI 1.4.14-R7309.1 / SDK 1.4.14).
 *
 * Only required fields are decoded strictly; additive native fields are
 * tolerated and never forwarded into canonical contracts. Provenance: the
 * stable + experimental JSON Schema bundles exported by the installed CLI
 * (`muse schema generate-json-schema`, fingerprint sha256:c94c3d1f...).
 */
import { Schema } from "effect";

export const MuseReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type MuseReasoningEffort = typeof MuseReasoningEffort.Type;

/** Catalog effort variants are a known ordered list or the explicit "unknown" scalar. */
export const MuseEffortVariants = Schema.Union([
  Schema.Array(MuseReasoningEffort),
  Schema.Literal("unknown"),
]);

export const MuseModelCatalogEntry = Schema.Struct({
  modelId: Schema.String,
  displayLabel: Schema.String,
  providerId: Schema.String,
  isDefault: Schema.Boolean,
  isActive: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
  variants: Schema.optional(MuseEffortVariants),
  defaultReasoningEffort: Schema.optional(MuseReasoningEffort),
});
export type MuseModelCatalogEntry = typeof MuseModelCatalogEntry.Type;

export const MuseModelListResult = Schema.Struct({
  providerId: Schema.String,
  models: Schema.Array(MuseModelCatalogEntry),
});
export type MuseModelListResult = typeof MuseModelListResult.Type;

/** Experimental account/read. `label` is display-only (may be an email) and is never logged or persisted. */
export const MuseAccountState = Schema.Struct({
  state: Schema.String,
  credentialRequired: Schema.Boolean,
  label: Schema.optional(Schema.String),
});
export type MuseAccountState = typeof MuseAccountState.Type;

export const MusePermissionProfileRow = Schema.Struct({
  profileId: Schema.String,
  label: Schema.String,
  available: Schema.Boolean,
  reviewerAuthority: Schema.String,
  description: Schema.optional(Schema.String),
});
export type MusePermissionProfileRow = typeof MusePermissionProfileRow.Type;

export const MusePermissionProfileListResult = Schema.Struct({
  profiles: Schema.Array(MusePermissionProfileRow),
});
export type MusePermissionProfileListResult = typeof MusePermissionProfileListResult.Type;

export const MuseSession = Schema.Struct({
  sessionId: Schema.String,
  activeTurnId: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String),
  providerId: Schema.NullOr(Schema.String),
  status: Schema.optional(Schema.String),
});
export type MuseSession = typeof MuseSession.Type;

export const MuseSessionStartResult = Schema.Struct({
  session: MuseSession,
  viewCursor: Schema.String,
});
export type MuseSessionStartResult = typeof MuseSessionStartResult.Type;

const MuseHistory = Schema.Struct({
  mode: Schema.String,
  snapshot: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        viewCursor: Schema.String,
        state: Schema.Struct({
          activeTurn: Schema.NullOr(
            Schema.Struct({ turnId: Schema.NonEmptyString, commandId: Schema.NonEmptyString }),
          ),
          queuedTurns: Schema.Array(
            Schema.Struct({ turnId: Schema.NonEmptyString, commandId: Schema.NonEmptyString }),
          ),
        }),
      }),
    ),
  ),
});

export const MuseSessionResumeResult = Schema.Struct({
  session: MuseSession,
  viewCursor: Schema.String,
  history: MuseHistory,
  pendingRequests: Schema.Array(Schema.Unknown),
  lastTurn: Schema.optional(Schema.Struct({ turnId: Schema.String, terminal: Schema.String })),
});
export type MuseSessionResumeResult = typeof MuseSessionResumeResult.Type;

/** Minimal authoritative read: absence of activeTurnId is not proof of idleness. */
export const MuseSessionReadResult = Schema.Struct({
  viewCursor: Schema.optional(Schema.String),
  history: Schema.optional(MuseHistory),
  session: Schema.Struct({
    sessionId: Schema.NonEmptyString,
    activeTurnId: Schema.NullOr(Schema.NonEmptyString),
    modelId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  lastTurn: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        turnId: Schema.NonEmptyString,
        terminal: Schema.NonEmptyString,
      }),
    ),
  ),
  // SDK 1.4.14 root queue entries have sequence/text, not a turnId.
  // sourceCommandId is a model-authored SubagentInput ID, NOT a root turn ID.
  queuedInputs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        sequence: Schema.Number,
        text: Schema.String,
        sourceCommandId: Schema.optional(Schema.NonEmptyString),
      }),
    ),
  ),
});
export type MuseSessionReadResult = typeof MuseSessionReadResult.Type;

/** Queue identities are available only in a snapshot folded at the response's head. */
export function museSnapshotQueue(value: {
  readonly viewCursor?: string | undefined;
  readonly history?: typeof MuseHistory.Type | undefined;
}) {
  const snapshot = value.history?.snapshot;
  return snapshot && snapshot.viewCursor === value.viewCursor
    ? snapshot.state.queuedTurns
    : undefined;
}

export const MuseTurnStartResult = Schema.Struct({
  commandId: Schema.String,
  status: Schema.String,
  turnId: Schema.String,
  disposition: Schema.String,
  startedNewTurn: Schema.Boolean,
});
export type MuseTurnStartResult = typeof MuseTurnStartResult.Type;

export const MuseCommandAck = Schema.Struct({
  commandId: Schema.String,
  status: Schema.String,
  turnId: Schema.optional(Schema.String),
  approvalId: Schema.optional(Schema.String),
  terminal: Schema.optional(Schema.Boolean),
});
export type MuseCommandAck = typeof MuseCommandAck.Type;

export const MuseApprovalChoice = Schema.Struct({
  choiceId: Schema.NonEmptyString,
  decision: Schema.NonEmptyString,
  label: Schema.String,
  scope: Schema.NonEmptyString,
  rulePreview: Schema.optional(Schema.String),
});
export type MuseApprovalChoice = typeof MuseApprovalChoice.Type;

export const MuseApprovalRequestParams = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  turnId: Schema.NonEmptyString,
  itemId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  availableChoices: Schema.Array(MuseApprovalChoice),
  currentRequirementId: Schema.Struct({
    approvalId: Schema.NonEmptyString,
    sourceIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  subject: Schema.Struct({
    kind: Schema.String,
    command: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    toolName: Schema.optional(Schema.String),
  }),
});
export type MuseApprovalRequestParams = typeof MuseApprovalRequestParams.Type;

/** A native item as carried by item/started|updated|completed; unknown kinds stay generic activity. */
export const MuseItem = Schema.Struct({
  itemId: Schema.String,
  kind: Schema.String,
  status: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  /** Reasoning items carry summary parts instead of `text`. */
  summary: Schema.optional(Schema.Unknown),
});
export type MuseItem = typeof MuseItem.Type;

export const decodeCatalog = Schema.decodeUnknownOption(MuseModelListResult);
export const decodeAccount = Schema.decodeUnknownOption(MuseAccountState);
export const decodeProfiles = Schema.decodeUnknownOption(MusePermissionProfileListResult);
export const decodeSessionStart = Schema.decodeUnknownOption(MuseSessionStartResult);
export const decodeSessionResume = Schema.decodeUnknownOption(MuseSessionResumeResult);
export const decodeSessionRead = Schema.decodeUnknownOption(MuseSessionReadResult);
export const decodeTurnStart = Schema.decodeUnknownOption(MuseTurnStartResult);
export const decodeCommandAck = Schema.decodeUnknownOption(MuseCommandAck);

/** Recorded native settlement answers, SDK 1.4.14 UserInputSettledParams/UserInputAnswer. */
export const MuseUserInputSettlement = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  userInputId: Schema.NonEmptyString,
  outcome: Schema.NonEmptyString,
  answers: Schema.Array(
    Schema.Struct({
      questionId: Schema.NonEmptyString,
      selectedLabel: Schema.optional(Schema.NonEmptyString),
      selectedLabels: Schema.optional(Schema.Array(Schema.NonEmptyString)),
      freeText: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
      note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
    }),
  ),
});
export const decodeUserInputSettlement = Schema.decodeUnknownOption(MuseUserInputSettlement);
export const decodeApprovalRequest = Schema.decodeUnknownOption(MuseApprovalRequestParams);
export const decodeItem = Schema.decodeUnknownOption(MuseItem);

/** Contributor (training) catalog rows are identified by model id, never by fabricated metadata. */
export function isContributorModel(modelId: string): boolean {
  return modelId.endsWith("-contributor");
}
