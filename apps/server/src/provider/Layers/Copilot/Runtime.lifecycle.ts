import { lstat, rm, rmdir } from "node:fs/promises";
import Path from "node:path";
import {
  activeCopilotLeases,
  readRuntimeState,
  withCopilotRuntimeLock,
  writeRuntimeState,
} from "@bigbud/shared/copilotRuntime.storage";
import { managedCopilotInstallations } from "./Runtime.discovery.ts";

/** Removes only marked, symlink-free managed versions, never external paths/auth/settings/chats. */
export async function uninstallCopilotRuntime(root: string): Promise<void> {
  await withCopilotRuntimeLock(
    root,
    () =>
      withCopilotRuntimeLock(root, async () => {
        if (await activeCopilotLeases(root))
          throw new Error("Stop active GitHub Copilot sessions and requests before uninstalling.");
        const installations = await managedCopilotInstallations(root);
        // Validate the entire inventory before making any destructive change.
        for (const runtime of installations) {
          if (!(await lstat(runtime.directory)).isDirectory())
            throw new Error("Unsafe Copilot runtime directory.");
        }
        await writeRuntimeState(root, ".onboarding.json", true);
        await writeRuntimeState(root, ".bridge-preserved.json", true);
        await rm(Path.join(root, "current"), { force: true });
        for (const runtime of installations) await rm(runtime.directory, { recursive: true });
        for (const version of new Set(installations.map((runtime) => runtime.version)))
          await rmdir(Path.join(root, version));
      }),
    undefined,
    true,
  );
}

export async function acknowledgeCopilotSetup(root: string): Promise<void> {
  await withCopilotRuntimeLock(root, async () => {
    if (!(await copilotSetupAcknowledged(root)))
      await writeRuntimeState(root, ".onboarding.json", true);
  });
}

export async function copilotSetupAcknowledged(root: string): Promise<boolean> {
  return (await readRuntimeState(root, ".onboarding.json")) === true;
}
