import { BACKEND_GRAPH_TUPLES, type ProviderRecipe } from "../recipe.ts";

/** Pi (decision 6): bigbud ships the Pi package closure in the backend graph. */
export const piRecipe: ProviderRecipe = {
  kind: "pi",
  displayName: "Pi",
  provisionedBy: "bigbud",
  components: [
    {
      kind: "graphExternal",
      id: "pi-closure",
      description: "Pi coding agent and transitive packages, run as rpc-entry by private Node",
      packages: ["@earendil-works/pi-coding-agent"],
      tuples: BACKEND_GRAPH_TUPLES,
      nativePrerequisites: [
        {
          id: "pi-tui-x11",
          requirement: "libxcb.so.1",
          optional: true,
          note: "pi-tui's X11 helper loads it lazily and catches the failure on minimal hosts",
        },
      ],
      integrity: { kind: "backendGraph" },
    },
  ],
  authReadiness: {
    module: "provider/Layers/Pi/Provider.ts",
    exportName: "checkPiProviderStatus",
    userStep: "Configure a model provider (API key or login) in Pi on the host",
  },
  manual: {
    vendor: "Earendil",
    installCommands: ["npm install -g @earendil-works/pi-coding-agent"],
  },
  notes: [
    "The default `pi` setting uses the bundled closure; a non-default providers.pi.binaryPath " +
      "selects the user's own Pi CLI and is preserved.",
    "Pi TypeScript extensions may fail remotely: jiti's lazy babel.cjs edge is absent.",
  ],
};
