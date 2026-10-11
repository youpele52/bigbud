import { requireContract } from "./errors";

/** Decoder-owned dense arrays only. Does not treat arbitrary proxies/modified realms as safe input. */
export function canonicalArrayValues(input: unknown): readonly unknown[] {
  requireContract(
    Array.isArray(input) &&
      Object.getPrototypeOf(input) === Array.prototype &&
      Object.getOwnPropertySymbols(input).length === 0,
    "CANONICAL_ARRAY",
  );
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(input);
  const length = descriptors.length?.value;
  requireContract(
    Number.isInteger(length) &&
      length >= 0 &&
      length <= 64 &&
      Object.keys(descriptors).length === length + 1,
    "CANONICAL_ARRAY",
  );
  const values: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    requireContract(descriptor && "value" in descriptor, "CANONICAL_ARRAY_ACCESSOR");
    values.push(descriptor.value);
  }
  return values;
}
