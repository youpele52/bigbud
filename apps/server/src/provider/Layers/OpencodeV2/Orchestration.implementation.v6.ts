import { V2_THREAD_HANDLER_V5 } from "./Orchestration.implementation.v5.ts";
import type { V2PureJson } from "./Orchestration.implementation.types.ts";
import type { V2PureThreadHandler } from "./Orchestration.implementation.types.v6.ts";

export const V2_FINAL_RESULT_MAX_BYTES = 90_000;

export function boundV2ModelList<
  Row,
  Result extends { readonly models: readonly Row[]; readonly hasMore: boolean },
  Response extends { readonly result: Result },
>(response: Response): Response {
  if (Buffer.byteLength(JSON.stringify(response)) <= V2_FINAL_RESULT_MAX_BYTES) return response;
  const models: Row[] = [];
  const limited = { ...response, result: { ...response.result, models, hasMore: true } };
  let bytes = Buffer.byteLength(JSON.stringify(limited));
  for (const row of response.result.models) {
    bytes += Buffer.byteLength(JSON.stringify(row)) + (models.length > 0 ? 1 : 0);
    if (bytes > V2_FINAL_RESULT_MAX_BYTES) break;
    models.push(row);
  }
  return limited;
}

/** Keep old create arguments under the frozen validator; only the new field is lenient. */
export const V2_THREAD_HANDLER_V6: V2PureThreadHandler = Object.freeze<V2PureThreadHandler>({
  prepare(value) {
    if (value.action === "list_available_models") {
      const { limit } = value.input;
      if (
        Object.keys(value.input).some((key) => key !== "limit") ||
        (limit !== undefined &&
          (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200))
      ) {
        throw new Error("V2 model-list arguments rejected.");
      }
      return { action: value.action, ...(limit !== undefined ? { limit } : {}) };
    }
    if (value.action !== "create_thread")
      return V2_THREAD_HANDLER_V5.prepare({ ...value, action: value.action });
    const { modelSelection, ...input } = value.input;
    const body = V2_THREAD_HANDLER_V5.prepare({ ...value, action: value.action, input });
    if (modelSelection === undefined) return body;
    const selection =
      modelSelection !== null &&
      typeof modelSelection === "object" &&
      !Array.isArray(modelSelection)
        ? (Object.fromEntries(
            Object.entries(modelSelection).filter(([key]) =>
              ["provider", "model", "subProviderID", "effort"].includes(key),
            ),
          ) as V2PureJson)
        : modelSelection;
    return { ...body, modelSelection: selection };
  },
  interpret({ action, canonicalResult }) {
    if (
      action !== "list_available_models" ||
      !canonicalResult ||
      typeof canonicalResult !== "object" ||
      !("result" in canonicalResult)
    )
      return canonicalResult;
    const { result } = canonicalResult;
    if (
      !result ||
      typeof result !== "object" ||
      !("models" in result) ||
      !Array.isArray(result.models) ||
      !("hasMore" in result) ||
      typeof result.hasMore !== "boolean"
    )
      return canonicalResult;
    return boundV2ModelList({
      ...canonicalResult,
      result: {
        ...result,
        models: result.models as readonly V2PureJson[],
        hasMore: result.hasMore,
      },
    });
  },
});
