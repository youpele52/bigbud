const WSL_PREFIX = "wsl:";

/** Explicit terminal-only distro identity; never a workspace/provider target. */
export function wslTerminalTargetId(distribution: string): string {
  if (!isWslDistributionName(distribution)) throw new Error("Invalid WSL distribution name.");
  return `${WSL_PREFIX}${encodeURIComponent(distribution)}`;
}

export function isWslDistributionName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    // In Unicode mode valid surrogate pairs are one code point; reject only unpaired surrogates.
    !/[\uD800-\uDFFF]/u.test(value) &&
    // oxlint-disable-next-line no-control-regex -- Distro names are protocol identifiers, not terminal output.
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

/** Reject noncanonical/ambiguous encodings rather than silently changing a target. */
export function parseWslTerminalTargetId(target: string | null | undefined): string | null {
  if (!target?.startsWith(WSL_PREFIX)) return null;
  try {
    const distribution = decodeURIComponent(target.slice(WSL_PREFIX.length));
    return isWslDistributionName(distribution) && wslTerminalTargetId(distribution) === target
      ? distribution
      : null;
  } catch {
    return null;
  }
}

export function isWslTerminalTargetId(target: string | null | undefined): boolean {
  return target?.startsWith(WSL_PREFIX) === true;
}
