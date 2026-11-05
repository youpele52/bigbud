/**
 * Test-only validator for the JSON Schema subset used by the pinned
 * cua-driver live input schemas. Unsupported keywords throw instead of
 * passing silently, so a richer upstream schema cannot be under-checked.
 */
type Schema = Readonly<Record<string, unknown>>;

const ANNOTATIONS = new Set(["description", "default", "title"]);
const SUPPORTED = new Set([
  "type",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "minimum",
  "maximum",
  "items",
  "minItems",
  "pattern",
]);

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const matchesType = (value: unknown, expected: unknown): boolean => {
  const actual = typeOf(value);
  const allowed = Array.isArray(expected) ? expected : [expected];
  return allowed.some((type) => type === actual || (type === "number" && actual === "integer"));
};

/** Returns the first violation as `path: reason`, or null when valid. */
export function schemaViolation(schema: Schema, value: unknown, path = "$"): string | null {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(`${path}: unsupported schema keyword ${keyword}`);
    }
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return `${path}: expected ${String(schema.type)}, got ${typeOf(value)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path}: not in enum`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return `${path}: below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return `${path}: above maximum`;
  }
  if (typeof value === "string" && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern, "u").test(value)) return `${path}: pattern mismatch`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${path}: too few items`;
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        const violation = schemaViolation(schema.items as Schema, item, `${path}[${index}]`);
        if (violation !== null) return violation;
      }
    }
  }
  if (typeOf(value) === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    const properties = (schema.properties ?? {}) as Readonly<Record<string, Schema>>;
    for (const name of (schema.required ?? []) as ReadonlyArray<string>) {
      if (!(name in object)) return `${path}.${name}: required`;
    }
    for (const [name, field] of Object.entries(object)) {
      const property = properties[name];
      if (property === undefined) {
        if (schema.additionalProperties === false) return `${path}.${name}: not allowed`;
        continue;
      }
      const violation = schemaViolation(property, field, `${path}.${name}`);
      if (violation !== null) return violation;
    }
  }
  return null;
}
