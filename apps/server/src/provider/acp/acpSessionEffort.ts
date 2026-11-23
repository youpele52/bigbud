import type { EffortOption, ModelCapabilities } from "@bigbud/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { AcpRequestError, type AcpError } from "effect-acp/errors";
import { Effect, ServiceMap } from "effect";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import {
  formatEffortLabel,
  sanitizeEffortOptions,
  withEffortProvenance,
} from "@bigbud/shared/model";

export interface AcpSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

export function flattenAcpSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<AcpSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() } satisfies AcpSessionSelectOption]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies AcpSessionSelectOption,
        ),
  );
}

function getConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  // ACP servers are allowed to use arbitrary IDs and labels for the
  // standardized thought-level category. Prefer that category before the
  // legacy name/id heuristics so values such as `depth` are still discovered.
  if (getConfigOptionCategory(option) === "thought_level") return true;
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

export function findAcpEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function uniqueAliasMatch(
  requested: string,
  options: ReadonlyArray<AcpSessionSelectOption>,
): string | undefined {
  const exact = options.find((option) => option.value === requested);
  if (exact) return exact.value;
  const lowered = requested.trim().toLowerCase();
  const aliases =
    lowered === "xhigh" || lowered === "extra-high" || lowered === "extra high"
      ? ["xhigh", "extra-high", "extra high", "max"]
      : [lowered];
  const matches = options.filter((option) => {
    const value = option.value.trim().toLowerCase();
    const name = option.name.trim().toLowerCase();
    return aliases.includes(value) || aliases.includes(name);
  });
  return matches.length === 1 ? matches[0]?.value : undefined;
}

export function resolveAcpEffortChoice(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: string | null | undefined,
): string | undefined {
  const trimmed = requested?.trim();
  if (!configOption || !trimmed) return undefined;
  return uniqueAliasMatch(trimmed, flattenAcpSessionConfigSelectOptions(configOption));
}

/** Internal execution context, present only when dispatching the delegated initial prompt. */
export const ExactDelegatedAcpEffort = ServiceMap.Reference<string | undefined>(
  "bigbud/provider/acp/ExactDelegatedAcpEffort",
  { defaultValue: () => undefined },
);

export const applyExactDelegatedAcpEffort = Effect.fn("applyExactDelegatedAcpEffort")(function* (
  runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions"> & {
    readonly setConfigOption: (configId: string, value: string) => Effect.Effect<unknown, AcpError>;
  },
  requested: string,
  modelSelected = true,
) {
  const option = findAcpEffortConfigOption(yield* runtime.getConfigOptions);
  const mismatch = (actual: string | undefined) =>
    new AcpRequestError({
      code: -32602,
      errorMessage: `Delegated effort ${JSON.stringify(requested)} was not applied: ${actual === undefined ? "the exact tier is not available for the selected model" : `ACP reported ${JSON.stringify(actual)}`}. No prompt was sent.`,
    });
  if (
    !modelSelected ||
    !option ||
    !flattenAcpSessionConfigSelectOptions(option).some(({ value }) => value === requested)
  ) {
    return yield* mismatch(undefined);
  }
  yield* runtime.setConfigOption(option.id, requested);
  const applied = (yield* runtime.getConfigOptions).find(({ id }) => id === option.id);
  const actual = applied?.type === "select" ? applied.currentValue : undefined;
  if (actual !== requested) return yield* mismatch(actual);
});

export function buildAcpEffortLevels(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  empty: ModelCapabilities,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return withEffortProvenance(empty, "unknown", "unknown");
  }
  const reasoningConfig = findAcpEffortConfigOption(configOptions);
  if (!reasoningConfig || reasoningConfig.type !== "select") {
    return withEffortProvenance(empty, "verified-unsupported", "live");
  }
  const levels = sanitizeEffortOptions(
    flattenAcpSessionConfigSelectOptions(reasoningConfig).map((entry) => ({
      value: entry.value,
      label: formatEffortLabel(entry.value, entry.name),
    })),
  );
  return withEffortProvenance(
    { ...empty, reasoningEffortLevels: [...levels] },
    levels.length > 0 ? "verified-supported" : "verified-unsupported",
    "live",
  );
}

export function acpEffortLevels(levels: ReadonlyArray<EffortOption>): ReadonlyArray<EffortOption> {
  return levels;
}
