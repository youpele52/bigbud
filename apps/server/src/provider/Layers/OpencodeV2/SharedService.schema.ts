export type V2SchemaObject = Record<string, unknown>;

export function schemaObject(value: unknown): V2SchemaObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected contract object.");
  return value as V2SchemaObject;
}

/** Resolve only local references touched by the finite consumed-contract manifest. */
export function makeV2SchemaReader(schemas: V2SchemaObject) {
  let nodes = 0;
  function resolve(value: unknown, seen = new Set<string>()): V2SchemaObject {
    if (++nodes > 4096 || seen.size > 32) throw new Error("Contract reference bound.");
    const shape = schemaObject(value);
    if (shape.$ref !== undefined) {
      if (
        typeof shape.$ref !== "string" ||
        !shape.$ref.startsWith("#/components/schemas/") ||
        seen.has(shape.$ref)
      )
        throw new Error("Invalid contract reference.");
      const name = shape.$ref
        .slice("#/components/schemas/".length)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      return resolve(schemas[name], new Set([...seen, shape.$ref]));
    }
    if (Array.isArray(shape.anyOf)) {
      const nonNull = shape.anyOf.filter((part) => schemaObject(part).type !== "null");
      if (nonNull.length === 1) return resolve(nonNull[0], seen);
    }
    return shape;
  }
  function field(value: unknown, name: string, type?: string): V2SchemaObject {
    const shape = resolve(schemaObject(resolve(value).properties)[name]);
    if (type && shape.type !== type) throw new Error(`Incompatible ${name} field.`);
    return shape;
  }
  function content(value: unknown, media = "application/json") {
    return resolve(schemaObject(schemaObject(schemaObject(value).content)[media]).schema);
  }
  return { resolve, field, content };
}
