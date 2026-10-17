import { createHash } from "node:crypto";
import { assertV2SharedCapabilities } from "./SharedService.capabilities.ts";
import { makeV2SchemaReader, schemaObject } from "./SharedService.schema.ts";
import { verifyV2ConsumedRequest } from "./SharedService.protocol.requests.ts";
import { V2_CANONICAL_NATIVE_OPERATIONS } from "./NativeCompatibility.contract.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { verifyV2NativeSecurityProjections } from "./NativeCompatibility.api.security.ts";

type Reader = ReturnType<typeof makeV2SchemaReader>;
type Shape = Record<string, unknown>;

function exactValues(shape: Shape, allowed: readonly string[]) {
  const values = shape.enum ?? (shape.const === undefined ? undefined : [shape.const]);
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((v) => !allowed.includes(v as string))
  )
    throw new Error("Unknown consumed security state.");
}

function tags(value: unknown, key: string, allowed: readonly string[], read: Reader) {
  const variants = read.variants(value);
  for (const item of variants) exactValues(read.requiredField(item, key, "string"), allowed);
  for (const tag of allowed) read.tagged(value, key, tag);
}

function locationParameters(operation: Shape, route: string, read: Reader) {
  const parameters = operation.parameters ?? [];
  if (!Array.isArray(parameters)) throw new Error("Invalid parameter list.");
  const names = new Set<string>();
  for (const raw of parameters) {
    const p = schemaObject(raw),
      name = `${p.in}:${p.name}`;
    if (names.has(name)) throw new Error("Ambiguous parameter.");
    names.add(name);
    if (p.in === "path") {
      if (
        !route.includes(`{${p.name}}`) ||
        p.required !== true ||
        read.input.resolve(p.schema).type !== "string"
      )
        throw new Error("Unsupported path parameter.");
    } else if (p.required === true) throw new Error("New mandatory query/header input.");
    if (p.name !== "location") continue;
    if (p.in !== "query" || p.style !== "deepObject" || p.explode !== true || p.required !== false)
      throw new Error("Changed Location serialization.");
    const location = read.input.resolve(p.schema);
    read.input.field(location, "directory", "string");
    if (Array.isArray(location.required) && location.required.some((v) => v !== "directory"))
      throw new Error("New mandatory Location input.");
  }
  for (const match of route.matchAll(/\{([^}]+)\}/g))
    if (!names.has(`path:${match[1]}`)) throw new Error("Missing path input.");
  if (route !== "/api/debug/location" && !names.has("query:location"))
    throw new Error("Missing Location projection.");
}

function configProjection(response: Shape, read: Reader) {
  if (response.type !== "array") throw new Error("Config must be a raw array.");
  tags(response.items, "type", ["directory", "document"], read);
  read.requiredField(read.tagged(response.items, "type", "directory"), "path", "string");
  const doc = read.tagged(response.items, "type", "document");
  read.field(doc, "path", "string");
  const info = read.requiredField(doc, "info", "object");
  const plugins = read.field(info, "plugins", "array");
  // Entries are interpreted by strict runtime source/policy validation, not arbitrary config passthrough.
  for (const item of read.variants(plugins.items))
    if (item.type !== "string" && item.type !== "object")
      throw new Error("Unknown plugin control.");
  const permissions = read.field(info, "permissions", "array");
  const rule = read.resolve(permissions.items);
  for (const field of ["action", "resource", "effect"]) read.requiredField(rule, field, "string");
  exactValues(read.field(rule, "effect"), ["allow", "ask", "deny"]);
}

function pluginProjection(data: Shape, read: Reader) {
  const plugin = read.resolve(data.items);
  read.field(plugin, "id", "string"); // Builtins may be anonymous; the owned namespace must have its exact ID at runtime.
  const source = read.requiredField(plugin, "source");
  tags(source, "type", ["local", "builtin", "package", "sdk"], read);
  read.requiredField(read.tagged(source, "type", "local"), "path", "string");
  read.requiredField(read.tagged(source, "type", "package"), "target", "string");
  const state = read.requiredField(plugin, "state");
  tags(state, "status", ["active", "failed"], read);
}

function genericRpcObject(shape: Shape) {
  // Pinned generic RPC uses Unknown. A newly narrowed string/union/object schema cannot
  // authorize the distinct info/enrollment/cleanup objects merely because `input` exists.
  const annotations = ["title", "description", "default", "examples", "deprecated"];
  if (shape.type === undefined) {
    if (Object.keys(shape).some((key) => !annotations.includes(key)))
      throw new Error("Narrowed generic RPC value.");
  } else if (
    shape.type !== "object" ||
    shape.additionalProperties !== true ||
    (shape.properties !== undefined && Object.keys(schemaObject(shape.properties)).length !== 0) ||
    (shape.required !== undefined &&
      (!Array.isArray(shape.required) || shape.required.length !== 0)) ||
    Object.keys(shape).some(
      (key) =>
        ![...annotations, "type", "additionalProperties", "properties", "required"].includes(key),
    )
  )
    throw new Error("Narrowed generic RPC object.");
}

/** Directional finite consumed checks: unrelated paths/optional fields/ref aliases never enter the digest. */
export function assertV2CanonicalNativeApi(value: unknown, nativeVersion: string) {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 2097152) throw new Error("API byte bound.");
    const contract = schemaObject(value),
      paths = schemaObject(contract.paths);
    const read = makeV2SchemaReader(schemaObject(schemaObject(contract.components).schemas));
    // One reader budget covers discovery and canonical projections together, not 4096 per subset.
    assertV2SharedCapabilities(value, nativeVersion, read);
    verifyV2NativeSecurityProjections(paths, read);
    const projection: unknown[] = [];
    for (const [method, route, id] of V2_CANONICAL_NATIVE_OPERATIONS) {
      const operation = schemaObject(schemaObject(paths[route])[method]);
      if (operation.operationId !== id) throw new Error("Changed operation ID.");
      locationParameters(operation, route, read);
      verifyV2ConsumedRequest(operation, id === "rpc.call" ? { input: "" } : undefined, read.input);
      if (id === "rpc.call")
        genericRpcObject(read.input.field(read.input.content(operation.requestBody), "input"));
      const response = read.content(schemaObject(operation.responses)["200"]);
      if (id === "config.get") configProjection(response, read);
      else if (id === "debug.location.list") {
        if (response.type !== "array") throw new Error("Loaded Locations must be a raw array.");
        read.requiredField(read.resolve(response.items), "directory", "string");
      } else if (id === "rpc.call") {
        // The official generic RPC Unknown output is optional; the installed bootstrap handshake
        // separately requires its exact non-void info/ack fields. Missing schema fields still fail.
        genericRpcObject(read.field(response, "output"));
      } else {
        read.requiredField(
          read.requiredField(response, "location", "object"),
          "directory",
          "string",
        );
        const data = read.requiredField(response, "data", "array");
        if (id === "plugin.list") pluginProjection(data, read);
        else {
          const shell = read.resolve(data.items);
          read.requiredField(shell, "id", "string");
          exactValues(read.requiredField(shell, "status", "string"), [
            "running",
            "exited",
            "timeout",
            "killed",
          ]);
          projection.push([id, (read.field(shell, "status").enum as string[]).toSorted()]);
        }
      }
      projection.push([method, route, id, id === "rpc.call" ? "output" : response.type]);
    }
    // Canonical equivalent consumed projections have the same identity, independent of upstream ref names.
    return createHash("sha256")
      .update(JSON.stringify({ format: "bigbud.thread.consumed-api.v1", projection }))
      .digest("hex");
  } catch {
    throw new V2NativeCompatibilityError(
      "native-contract-incompatible",
      "native consumed API contract is incompatible; no installation, history intent or canonical dispatch is authorized.",
      nativeVersion,
    );
  }
}
