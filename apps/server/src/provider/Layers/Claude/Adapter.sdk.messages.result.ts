import { asRecord, finiteNumber, string } from "./Adapter.sdk.messages.ts";

type ClaudeSdkResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

type ClaudeFastModeState = "off" | "cooldown" | "on";

export interface ClaudeSdkResult {
  readonly type: "result";
  readonly subtype: ClaudeSdkResultSubtype;
  readonly uuid?: string;
  readonly sessionId: string;
  readonly errors: ReadonlyArray<string>;
  readonly stopReason: string | null;
  readonly usage?: Readonly<Record<string, number>>;
  readonly modelUsage?: Readonly<
    Record<string, { readonly contextWindow: number; readonly maxOutputTokens?: number }>
  >;
  readonly totalCostUsd?: number;
  readonly apiErrorStatus?: number | null;
  readonly fastModeState?: ClaudeFastModeState;
  readonly fastModeDisabledReason?: string;
}

function isResultSubtype(value: unknown): value is ClaudeSdkResultSubtype {
  return (
    typeof value === "string" &&
    [
      "success",
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ].includes(value)
  );
}

function isFastModeState(value: unknown): value is ClaudeFastModeState {
  return value === "off" || value === "cooldown" || value === "on";
}

function resultUsage(value: unknown): Readonly<Record<string, number>> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const fields = [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
    "total_tokens",
  ] as const;
  const normalized = Object.fromEntries(
    fields.flatMap((field) => {
      const parsed = finiteNumber(record[field]);
      return parsed === undefined ? [] : [[field, parsed]];
    }),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function modelUsage(
  value: unknown,
):
  | Readonly<Record<string, { readonly contextWindow: number; readonly maxOutputTokens?: number }>>
  | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(record).flatMap(([model, candidate]) => {
      const entry = asRecord(candidate);
      const contextWindow = finiteNumber(entry?.contextWindow);
      const maxOutputTokens = finiteNumber(entry?.maxOutputTokens);
      return contextWindow === undefined
        ? []
        : [
            [
              model,
              { contextWindow, ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) },
            ],
          ];
    }),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function decodeClaudeResultMessage(value: unknown): ClaudeSdkResult | undefined {
  const record = asRecord(value);
  const subtype = record?.subtype;
  if (record?.type !== "result" || !isResultSubtype(subtype)) return undefined;
  const sessionId = string(record.session_id);
  const uuid = string(record.uuid);
  const errors =
    record.errors === undefined
      ? []
      : Array.isArray(record.errors) && record.errors.every(string)
        ? record.errors
        : undefined;
  const stopReason = record.stop_reason ?? null;
  if (!sessionId || !errors || (stopReason !== null && typeof stopReason !== "string"))
    return undefined;
  const apiErrorStatus = record.api_error_status;
  const fastModeState = record.fast_mode_state;
  const fastModeDisabledReason = string(record.fast_mode_disabled_reason);
  if (
    (apiErrorStatus !== undefined &&
      apiErrorStatus !== null &&
      finiteNumber(apiErrorStatus) === undefined) ||
    (fastModeState !== undefined && !isFastModeState(fastModeState))
  )
    return undefined;
  const normalizedApiErrorStatus = apiErrorStatus === null ? null : finiteNumber(apiErrorStatus);
  const normalizedUsage = resultUsage(record.usage);
  const normalizedModelUsage = modelUsage(record.modelUsage);
  const totalCostUsd = finiteNumber(record.total_cost_usd);
  return {
    type: "result",
    subtype,
    sessionId,
    ...(uuid ? { uuid } : {}),
    errors,
    stopReason,
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    ...(normalizedModelUsage ? { modelUsage: normalizedModelUsage } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(normalizedApiErrorStatus !== undefined ? { apiErrorStatus: normalizedApiErrorStatus } : {}),
    ...(isFastModeState(fastModeState) ? { fastModeState } : {}),
    ...(fastModeDisabledReason ? { fastModeDisabledReason } : {}),
  };
}
