import { CopilotClient } from "@github/copilot-sdk";
import { makeCopilotClientOptions } from "./Adapter.types.cli.ts";
import { copilotRuntimeRoot } from "@bigbud/shared/copilotRuntime.paths";
import { acquireCopilotLease } from "@bigbud/shared/copilotRuntime.storage";

/** Leases precede resolution so uninstall cannot race a new probe, title request, or session. */
export async function createLeasedCopilotClient(
  input: Parameters<typeof makeCopilotClientOptions>[0],
  factory?: (options: ReturnType<typeof makeCopilotClientOptions>) => CopilotClient,
  root = copilotRuntimeRoot(),
): Promise<CopilotClient> {
  // Injected adapters are test doubles and never launch a managed runtime.
  if (factory) return factory(makeCopilotClientOptions(input));
  const release = await acquireCopilotLease(root);
  try {
    const client = new CopilotClient(makeCopilotClientOptions(input));
    const stop = client.stop.bind(client);
    const forceStop = client.forceStop.bind(client);
    client.stop = async () => {
      const errors = await stop();
      if (errors.length === 0) await release();
      return errors;
    };
    client.forceStop = async () => {
      await forceStop();
      await release();
    };
    return client;
  } catch (error) {
    await release();
    throw error;
  }
}
