import { makeV2SchemaReader, schemaObject } from "./SharedService.schema.ts";
import { verifyV2ConsumedRequest } from "./SharedService.protocol.requests.ts";
import { verifyV2ConsumedOperation } from "./SharedService.protocol.ts";

/** Auxiliary generation is optional: reject its missing ABI without widening chat compatibility. */
export function assertV2TextGenerationContract(value: unknown): void {
  const contract = schemaObject(value);
  const paths = schemaObject(contract.paths);
  const read = makeV2SchemaReader(schemaObject(schemaObject(contract.components).schemas));
  const generate = schemaObject(schemaObject(paths["/api/session/{sessionID}/generate"]).post);
  if (generate.operationId !== "session.generate") throw new Error("V2 generation ABI missing.");
  const parameters = generate.parameters;
  if (!Array.isArray(parameters)) throw new Error("V2 generation session parameter missing.");
  const parameter = parameters.map(schemaObject).find((item) => item.name === "sessionID");
  if (!parameter || parameter.in !== "path" || parameter.required !== true)
    throw new Error("V2 generation session parameter rejected.");
  const sessionId = read.input.resolve(parameter.schema);
  if (
    sessionId.type !== "string" ||
    (typeof sessionId.maxLength === "number" && sessionId.maxLength < 96)
  )
    throw new Error("V2 generation session ID rejected.");
  for (const item of parameters.map(schemaObject))
    if (item.required === true && item.name !== "sessionID")
      throw new Error("V2 generation required parameter rejected.");
  verifyV2ConsumedRequest(generate, { prompt: "string" }, read.input);
  const request = read.input.content(generate.requestBody);
  read.input.requiredField(request, "prompt", "string");
  const response = read.content(schemaObject(generate.responses)["200"]);
  read.requiredField(read.requiredField(response, "data", "object"), "text", "string");
  const remove = schemaObject(schemaObject(paths["/api/session/{sessionID}"]).delete);
  if (remove.operationId !== "session.remove" || !("204" in schemaObject(remove.responses)))
    throw new Error("V2 auxiliary session disposal is unsupported.");
  verifyV2ConsumedOperation(remove, "session.remove", "/api/session/{sessionID}", read);
}
