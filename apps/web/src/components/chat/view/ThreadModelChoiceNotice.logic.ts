/**
 * Copy and countdown for a delegated thread's model choice: the tributary notice and the trunk's
 * `DelegatedChildrenCard` row read the same derivation, so they always agree.
 */
import { PROVIDER_DISPLAY_NAMES } from "@bigbud/contracts/constants/provider.constant.ts";
import {
  DELEGATED_MODEL_CHOICE_HOLD_MS,
  type ModelChoiceOption,
  type ModelChoiceResolvedBy,
  type ModelChoiceUnusableReason,
  type RequestedModelSelection,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import type { DelegatedModelChoiceRecord } from "@bigbud/shared/delegatedModelChoice";

import type { DelegatedChildModelChoice } from "../../../models/types/app.types";

/** The picker lists this many options before "Show all". */
export const MODEL_CHOICE_VISIBLE_OPTIONS = 12;

export type ModelChoiceNoticeKind =
  | "pending"
  | "requested"
  | "user-picked"
  | "fallback"
  | "cancelled";
/** Alert variants per AGENTS.md: blue working, green done, amber warning. */
export type ModelChoiceNoticeTone = "info" | "success" | "warning";

export interface ModelChoiceNotice {
  readonly kind: ModelChoiceNoticeKind;
  readonly tone: ModelChoiceNoticeTone;
  readonly title: string;
  readonly description: string | null;
}

export type ModelChoiceCardRow =
  | { readonly kind: "pending"; readonly label: string }
  | { readonly kind: "requested"; readonly label: string }
  | {
      readonly kind: "resolved";
      readonly tone: "success" | "warning";
      readonly label: string;
      readonly title: string;
    };

const REASON_TEXT: Record<ModelChoiceUnusableReason, string> = {
  "invalid-request": "the request was invalid",
  "unknown-provider": "unknown provider",
  "provider-disabled": "provider is disabled",
  "provider-not-installed": "provider isn't installed",
  "provider-unavailable": "provider is unavailable",
  "provider-unauthenticated": "provider isn't signed in",
  "provider-hidden": "provider is hidden",
  "provider-untrusted": "provider isn't trusted",
  "provider-retired": "provider is retired",
  "unsupported-execution-target": "not available where this thread runs",
  "unknown-model": "unknown model",
  "model-requires-setup": "model needs setup",
  "agent-choice-disabled": "agent model choice is off in settings",
  "catalog-unavailable": "model list unavailable",
};

const RESOLVED_BY_TEXT: Partial<Record<ModelChoiceResolvedBy, string>> = {
  timeout: `No model was chosen within ${DELEGATED_MODEL_CHOICE_HOLD_MS / 1000} seconds.`,
  "no-client": "No window was open to choose a model.",
  "no-alternatives": "No other model is available.",
  disabled: "Agents can't choose models (Settings → AI).",
  "restart-sweep": "The server restarted before a model was chosen.",
};

/** Remaining hold on this browser's clock only; server timestamps are never subtracted (D21). */
export function modelChoiceRemainingMs(observedAtMs: number, nowMs: number): number {
  return Math.max(0, DELEGATED_MODEL_CHOICE_HOLD_MS - Math.max(0, nowMs - observedAtMs));
}

// C0/C1 controls (including newlines) and bidi embedding, override and isolate marks.
const UNSAFE_DISPLAY_CHARACTERS =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Agent-supplied text is shown inline, so it must not break lines or reorder the copy (L10). */
function displayText(value: string | undefined): string | null {
  const text = value?.replace(UNSAFE_DISPLAY_CHARACTERS, "").trim() ?? "";
  return text.length > 0 ? text : null;
}

function requestedText(requested: RequestedModelSelection | null): string {
  if (requested === null) return "model";
  const model = displayText(requested.model);
  if (model !== null) return model;
  if (Object.hasOwn(PROVIDER_DISPLAY_NAMES, requested.provider)) {
    return (PROVIDER_DISPLAY_NAMES as Record<string, string>)[requested.provider]!;
  }
  return displayText(requested.provider) ?? "model";
}

function selectionText(selection: { readonly model: string }): string {
  return displayText(selection.model) ?? "model";
}

function reasonText(reason: ModelChoiceUnusableReason | null): string {
  return reason === null ? "unavailable" : REASON_TEXT[reason];
}

function resolvedNotice(
  record: Extract<DelegatedModelChoiceRecord, { status: "resolved" }>,
): ModelChoiceNotice {
  const requested = requestedText(record.requested);
  if (record.cancelled) {
    return {
      kind: "cancelled",
      tone: "warning",
      title: "Model choice cancelled",
      description: "The delegated message was not sent.",
    };
  }
  if (record.outcome === "requested") {
    return {
      kind: "requested",
      tone: "success",
      title: `Using requested model ${requested}`,
      description: null,
    };
  }
  if (record.outcome === "user-picked") {
    return {
      kind: "user-picked",
      tone: "success",
      title: `You chose ${selectionText(record.used)} (requested ${requested} unavailable)`,
      description: null,
    };
  }
  return {
    kind: "fallback",
    tone: "warning",
    title: `Requested ${requested} unavailable (${reasonText(record.reason)}); used ${selectionText(record.used)}`,
    description: RESOLVED_BY_TEXT[record.resolvedBy] ?? null,
  };
}

export function deriveModelChoiceNotice(
  record: DelegatedModelChoiceRecord,
  remainingMs: number,
): ModelChoiceNotice {
  if (record.status === "resolved") return resolvedNotice(record);
  const unavailable = `Requested ${requestedText(record.requested)} isn't available (${reasonText(record.reason)}).`;
  const seconds = Math.ceil(remainingMs / 1000);
  return {
    kind: "pending",
    tone: "info",
    title: "Choose a model for this thread",
    description:
      seconds > 0
        ? `${unavailable} Choose a model — using ${selectionText(record.fallback)} in ${seconds}s.`
        : `${unavailable} Using ${selectionText(record.fallback)} now…`,
  };
}

export function visibleModelChoiceOptions(
  options: ReadonlyArray<ModelChoiceOption>,
  showAll: boolean,
): { readonly visible: ReadonlyArray<ModelChoiceOption>; readonly hiddenCount: number } {
  if (showAll || options.length <= MODEL_CHOICE_VISIBLE_OPTIONS) {
    return { visible: options, hiddenCount: 0 };
  }
  return {
    visible: options.slice(0, MODEL_CHOICE_VISIBLE_OPTIONS),
    hiddenCount: options.length - MODEL_CHOICE_VISIBLE_OPTIONS,
  };
}

/**
 * The trunk card's row for one child. A linked summary can be stale after a reload, so it only
 * says what was requested; live status comes from the mirrored tributary record.
 */
export function deriveModelChoiceCardRow(
  choice: DelegatedChildModelChoice | undefined,
  remainingMs: number | null,
): ModelChoiceCardRow | null {
  if (choice === undefined) return null;
  if (choice.source === "linked") {
    const requested = choice.summary.requested;
    return requested === null
      ? null
      : { kind: "requested", label: `Requested ${requestedText(requested)}` };
  }
  const record = choice.record;
  if (record.status === "pending") {
    return {
      kind: "pending",
      label: `Choose model · ${Math.ceil((remainingMs ?? DELEGATED_MODEL_CHOICE_HOLD_MS) / 1000)}s`,
    };
  }
  const notice = resolvedNotice(record);
  return {
    kind: "resolved",
    tone: notice.tone === "success" ? "success" : "warning",
    label: record.cancelled ? "Cancelled" : selectionText(record.used),
    title: notice.title,
  };
}
