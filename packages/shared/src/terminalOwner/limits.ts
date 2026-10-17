import type { Limits } from "@bigbud/contracts/terminal-owner/identity";
import { requireContract } from "./errors";

/** Session limits do not lend or enlarge any global reservation pool. */
export function ownerLimits(role: number, statusOnly = false): Limits {
  requireContract([1, 2, 3, 4].includes(role), "ROLE_DENIED");
  const values = [
    65536,
    8192,
    49152,
    5000,
    30000,
    5000,
    statusOnly ? 30000 : 600000,
    5000,
    role === 1 ? 524288 : role === 4 ? 131072 : 262144,
    role === 4 ? 128 : 256,
    role === 1 || role === 4 ? 0 : 262144,
    role === 1 || role === 4 ? 0 : 256,
    32768,
    1,
    5000,
    30000,
    4096,
    role === 1 || role === 4 ? 8 : 128,
    32,
    64,
    4096,
    4,
    300000,
    30000,
  ];
  return { entries: values.map((value, index) => ({ key: index + 1, value: String(value) })) };
}

export function validateLimits(limits: Limits, role: number, statusOnly: boolean): void {
  const ceiling = ownerLimits(role, statusOnly).entries;
  requireContract(limits.entries.length === 24, "LIMITS_INVALID");
  limits.entries.forEach((entry, index) => {
    const bound = ceiling[index]!;
    const roleDependent = [9, 10, 11, 12, 18].includes(entry.key);
    requireContract(
      entry.key === bound.key &&
        (roleDependent ? BigInt(entry.value) <= BigInt(bound.value) : entry.value === bound.value),
      "LIMITS_INVALID",
    );
  });
}
