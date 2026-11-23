import { V2_SUMMARY_BOOTSTRAP_SPECS } from "./Orchestration.plugin.specs.v5.ts";

function extendCreateTool(spec: (typeof V2_SUMMARY_BOOTSTRAP_SPECS)[number]) {
  return spec.action !== "create_thread"
    ? spec
    : {
        ...spec,
        description: `${spec.description} Use list_available_models to choose a provider, model, and optional exact native effort ID. Omit modelSelection to inherit. The result reports whether effort was configured, not whether the provider honored it.`,
        input: {
          ...spec.input,
          properties: {
            ...spec.input.properties,
            modelSelection: {
              type: "object",
              properties: {
                provider: {
                  type: "string",
                  description: "Provider ID from list_available_models",
                },
                model: {
                  type: "string",
                  description: "Model ID; omit to use the provider's recent model",
                },
                subProviderID: { type: "string", description: "Sub-provider ID, when listed" },
                effort: {
                  type: "string",
                  description: "Exact native effort ID for the listed model and target",
                },
              },
            },
          },
        },
      };
}

/** Frozen ABI 6: old tool definitions stay intact except for the extended create tool. */
export const V2_DELEGATION_BOOTSTRAP_SPECS = [
  ...V2_SUMMARY_BOOTSTRAP_SPECS.map(extendCreateTool),
  {
    name: "bigbud_thread_v1_list_available_models",
    action: "list_available_models",
    description:
      "List usable models and exact native effort choices for the current target. Do not infer an effort tier when the listing reports unknown; another project can have different capabilities.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      required: [],
    },
  },
] as const;
