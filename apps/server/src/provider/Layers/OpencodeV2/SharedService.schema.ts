export type V2SchemaObject = Record<string, unknown>;

export function schemaObject(value: unknown): V2SchemaObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected contract object.");
  return value as V2SchemaObject;
}

/** Resolve only local references touched by the finite consumed-contract manifest. */
export function makeV2SchemaReader(schemas: V2SchemaObject) {
  let nodes = 0;
  function reader(direction: "request" | "response") {
    function resolve(
      value: unknown,
      seen = new Set<string>(),
      allowNull = direction === "request",
    ): V2SchemaObject {
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
        return resolve(schemas[name], new Set([...seen, shape.$ref]), allowNull);
      }
      const alternatives = shape.anyOf ?? shape.oneOf;
      if (Array.isArray(alternatives)) {
        // Inputs need to accept our nonnull value; outputs must guarantee every advertised alternative.
        const accepted = allowNull
          ? alternatives.filter((part) => resolve(part, seen, false).type !== "null")
          : alternatives;
        if (accepted.length === 1) return resolve(accepted[0], seen, allowNull);
      }
      return shape;
    }
    function field(value: unknown, name: string, type?: string, nullable = false): V2SchemaObject {
      const parent = resolve(value);
      if (parent.type !== "object") throw new Error("Incompatible object projection.");
      const shape = resolve(
        schemaObject(parent.properties)[name],
        new Set(),
        nullable || direction === "request",
      );
      if (
        type &&
        shape.type !== type &&
        !(direction === "response" && type === "number" && shape.type === "integer")
      )
        throw new Error(`Incompatible ${name} field.`);
      return shape;
    }
    function nullableField(value: unknown, name: string, type: string) {
      return field(value, name, type, true);
    }
    function requiredField(value: unknown, name: string, type?: string) {
      const parent = resolve(value);
      if (!Array.isArray(parent.required) || !parent.required.includes(name))
        throw new Error(`Missing required ${name} projection.`);
      return field(parent, name, type);
    }
    function content(value: unknown, media = "application/json") {
      return resolve(schemaObject(schemaObject(schemaObject(value).content)[media]).schema);
    }
    function variants(value: unknown, depth = 0): V2SchemaObject[] {
      if (depth > 32) throw new Error("Contract union bound.");
      const shape = resolve(value);
      const alternatives = shape.anyOf ?? shape.oneOf;
      return Array.isArray(alternatives)
        ? alternatives.flatMap((part) => variants(part, depth + 1))
        : [shape];
    }
    function tagged(value: unknown, key: string, tag: string) {
      const matches = variants(value).filter((part) => {
        const discriminator = field(part, key, "string");
        return (
          discriminator.const === tag ||
          (Array.isArray(discriminator.enum) && discriminator.enum.includes(tag))
        );
      });
      if (matches.length !== 1) throw new Error(`Missing or ambiguous ${tag} projection.`);
      requiredField(matches[0], key, "string");
      return matches[0]!;
    }
    return { resolve, field, nullableField, requiredField, content, variants, tagged };
  }
  return { ...reader("response"), input: reader("request") };
}

/** Check literal values actually sent or interpreted, not the spelling of a referenced component. */
export function acceptsV2Values(shape: V2SchemaObject, values: readonly (string | boolean)[]) {
  if (
    (shape.const !== undefined && values.some((value) => value !== shape.const)) ||
    (shape.enum !== undefined &&
      (!Array.isArray(shape.enum) ||
        values.some((value) => !(shape.enum as unknown[]).includes(value))))
  )
    throw new Error("Unsupported consumed value.");
}
