import type { EffortOption, ModelCapabilities } from "@bigbud/contracts";
import {
  formatEffortLabel,
  sanitizeEffortOptions,
  withEffortProvenance,
} from "@bigbud/shared/model";

export const PROVISIONAL_REASONING_EFFORT_LEVELS: ReadonlyArray<EffortOption> = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export const EMPTY_EFFORT_CAPABILITIES: ModelCapabilities = withEffortProvenance(
  {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  },
  "unknown",
  "unknown",
);

export const SEED_REASONING_CAPABILITIES: ModelCapabilities = withEffortProvenance(
  {
    ...EMPTY_EFFORT_CAPABILITIES,
    reasoningEffortLevels: [...PROVISIONAL_REASONING_EFFORT_LEVELS],
  },
  "seed",
  "seed",
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseVariantOption(id: string, raw: unknown): EffortOption | null {
  const value = id.trim();
  if (!value) return null;
  const record = asRecord(raw);
  if (record?.disabled === true) return null;
  const label =
    typeof record?.name === "string"
      ? record.name
      : typeof record?.label === "string"
        ? record.label
        : undefined;
  return {
    value,
    label: formatEffortLabel(value, label),
    ...(record?.default === true ? { isDefault: true } : {}),
  };
}

export function parseManagedModelVariants(variants: unknown): {
  readonly kind: "omitted" | "present" | "invalid";
  readonly levels: ReadonlyArray<EffortOption>;
} {
  if (variants === undefined) {
    return { kind: "omitted", levels: [] };
  }
  if (Array.isArray(variants)) {
    const levels = sanitizeEffortOptions(
      variants.flatMap((entry) => {
        const record = asRecord(entry);
        const id =
          typeof record?.id === "string" ? record.id : typeof entry === "string" ? entry : "";
        const option = parseVariantOption(id, record ?? {});
        return option ? [option] : [];
      }),
    );
    return { kind: "present", levels };
  }
  const record = asRecord(variants);
  if (!record) {
    return { kind: "invalid", levels: [] };
  }
  const levels = sanitizeEffortOptions(
    Object.entries(record).flatMap(([id, value]) => {
      const option = parseVariantOption(id, value);
      return option ? [option] : [];
    }),
  );
  return { kind: "present", levels };
}

export function capabilitiesFromManagedModel(input: {
  readonly reasoning?: boolean | undefined;
  readonly variants?: unknown;
  readonly emptyCapabilities: ModelCapabilities;
  readonly provenanceOrigin: NonNullable<ModelCapabilities["effortMetadataOrigin"]>;
}): ModelCapabilities {
  const variants = parseManagedModelVariants(input.variants);
  if (variants.kind === "present") {
    return withEffortProvenance(
      {
        ...input.emptyCapabilities,
        reasoningEffortLevels: [...variants.levels],
      },
      variants.levels.length > 0 ? "verified-supported" : "verified-unsupported",
      input.provenanceOrigin,
    );
  }
  if (variants.kind === "invalid") {
    return withEffortProvenance(
      { ...input.emptyCapabilities, reasoningEffortLevels: [] },
      "unknown",
      input.provenanceOrigin === "live" ? "live" : "unknown",
    );
  }
  if (input.reasoning === true) {
    return withEffortProvenance(
      {
        ...input.emptyCapabilities,
        reasoningEffortLevels: [...PROVISIONAL_REASONING_EFFORT_LEVELS],
      },
      "seed",
      "seed",
    );
  }
  if (input.reasoning === false) {
    return withEffortProvenance(
      { ...input.emptyCapabilities, reasoningEffortLevels: [] },
      "verified-unsupported",
      input.provenanceOrigin === "live" ? "live" : "unknown",
    );
  }
  return withEffortProvenance(
    { ...input.emptyCapabilities, reasoningEffortLevels: [] },
    "unknown",
    input.provenanceOrigin === "live" ? "live" : "unknown",
  );
}
