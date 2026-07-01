import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import { deleteThreadOrchestrationToolAuth } from "./ThreadOrchestrationToolAuth.ts";
import {
  prepareThreadOrchestrationSessionAuth,
  resolveThreadOrchestrationHttpConfig,
  type ThreadOrchestrationSessionBridgeInput,
} from "./threadOrchestrationBridge.shared.ts";

export interface PiOrchestrationBridge {
  readonly extensionPath: string;
  readonly bridgeDir: string;
  readonly extraArgs: ReadonlyArray<string>;
  readonly cleanup: () => Promise<void>;
}

export type PiOrchestrationBridgeInput = ThreadOrchestrationSessionBridgeInput;

export async function createPiOrchestrationBridge(
  input: PiOrchestrationBridgeInput,
): Promise<PiOrchestrationBridge> {
  const bridgeDir = await mkdtemp(path.join(os.tmpdir(), "bigbud-pi-orchestration-"));
  const { token } = await prepareThreadOrchestrationSessionAuth({
    stateDir: input.stateDir,
    threadId: input.threadId,
  });
  const httpConfig = resolveThreadOrchestrationHttpConfig(input, token);
  await mkdir(path.join(bridgeDir, ".bigbud"), { recursive: true });
  const extensionPath = path.join(bridgeDir, ".bigbud", "bigbud-orchestration-bridge.ts");
  await writeFile(extensionPath, renderPiOrchestrationBridgeSource(httpConfig), "utf8");

  return {
    extensionPath,
    bridgeDir,
    extraArgs: ["--extension", extensionPath],
    cleanup: async () => {
      await deleteThreadOrchestrationToolAuth({
        stateDir: input.stateDir,
        threadId: input.threadId,
      });
      await rm(bridgeDir, { recursive: true, force: true });
    },
  };
}
