import type { RemoteWorkspaceBridgeConfig } from "../../../remote-workspace-bridge/remoteWorkspaceBridge.ts";

export function renderToolSource(input: {
  readonly description: string;
  readonly argsSource: string;
  readonly executeBody: ReadonlyArray<string>;
}): string {
  return [
    'import { tool } from "@opencode-ai/plugin";',
    'import * as runtime from "../../.bigbud/opencode-remote-runtime.ts";',
    "",
    "export default tool({",
    `  description: ${JSON.stringify(input.description)},`,
    "  args: {",
    input.argsSource,
    "  },",
    "  async execute(args) {",
    ...input.executeBody.map((line) => `    ${line}`),
    "  },",
    "});",
  ].join("\n");
}

export function renderConfig(input: RemoteWorkspaceBridgeConfig): string {
  return JSON.stringify(
    {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      destination: input.destination,
      transportArgs: [...input.transportArgs],
    },
    null,
    2,
  );
}
