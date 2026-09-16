import type { EffortOption, ModelCapabilities } from "@bigbud/contracts";

export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((level) => level.value === value);
}

export function getDefaultEffort(caps: ModelCapabilities): string | null {
  if (caps.effortMetadataStatus === "seed" || caps.effortMetadataStatus === "unknown") {
    return null;
  }
  return caps.reasoningEffortLevels.find((level) => level.isDefault)?.value ?? null;
}

export function getEffortMetadataStatus(
  caps: ModelCapabilities,
): NonNullable<ModelCapabilities["effortMetadataStatus"]> {
  return caps.effortMetadataStatus ?? "unknown";
}

export function isAuthoritativeEffortMetadata(caps: ModelCapabilities): boolean {
  const status = getEffortMetadataStatus(caps);
  return status === "verified-supported" || status === "verified-unsupported";
}

export function withEffortProvenance(
  caps: Omit<ModelCapabilities, "effortMetadataStatus" | "effortMetadataOrigin">,
  status: NonNullable<ModelCapabilities["effortMetadataStatus"]>,
  origin: NonNullable<ModelCapabilities["effortMetadataOrigin"]>,
): ModelCapabilities {
  return {
    ...caps,
    effortMetadataStatus: status,
    effortMetadataOrigin: origin,
  };
}

export function formatEffortLabel(value: string, provided?: string | null): string {
  const trimmed = provided?.trim();
  if (trimmed) return trimmed;
  if (value === "xhigh") return "Extra High";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function sanitizeEffortOptions(
  options: ReadonlyArray<EffortOption>,
): ReadonlyArray<EffortOption> {
  const seen = new Set<string>();
  const sanitized: EffortOption[] = [];
  for (const option of options) {
    const value = option.value.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = option.label.trim() || formatEffortLabel(value);
    sanitized.push({
      value,
      label,
      ...(option.isDefault === true ? { isDefault: true } : {}),
    });
  }
  const defaultCount = sanitized.filter((option) => option.isDefault === true).length;
  if (defaultCount <= 1) return sanitized;
  let keptDefault = false;
  return sanitized.map((option) => {
    if (option.isDefault !== true) return option;
    if (keptDefault) {
      const { isDefault: _discarded, ...rest } = option;
      return rest;
    }
    keptDefault = true;
    return option;
  });
}

/**
 * Resolve a raw effort option against capabilities.
 *
 * Explicit values survive seed/unknown metadata even when they are not in the
 * provisional list. Authoritative lists replace invalid selections with the
 * genuine default, or omit when no default is reported.
 */
export function resolveEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultEffort(caps);
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  const status = getEffortMetadataStatus(caps);
  const hasProvenance =
    Object.prototype.hasOwnProperty.call(caps, "effortMetadataStatus") ||
    Object.prototype.hasOwnProperty.call(caps, "effortMetadataOrigin");
  if (
    trimmed &&
    !caps.promptInjectedEffortLevels.includes(trimmed) &&
    hasEffortLevel(caps, trimmed)
  ) {
    return trimmed;
  }
  if (trimmed && caps.promptInjectedEffortLevels.includes(trimmed)) {
    return defaultValue ?? undefined;
  }
  if (status === "verified-unsupported") {
    return undefined;
  }
  if (trimmed && (status === "seed" || (status === "unknown" && hasProvenance))) {
    return trimmed;
  }
  // A discovered provider with no reported default must not inherit a
  // provisional seed's default. Keep an explicitly stored value recoverable
  // while discovery is pending, but leave a fresh selection unset.
  if (hasProvenance && (status === "seed" || status === "unknown")) {
    return undefined;
  }
  return defaultValue ?? undefined;
}
