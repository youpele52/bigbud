import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  LEGACY_OPENCODE_READ_ONLY_MESSAGE,
  KILOCODE_READ_ONLY_MESSAGE,
} from "@bigbud/shared/providerLifecycle";
import { ensureSessionForThread } from "./ProviderCommandReactorSessionOps.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

it.each([
  ["opencode", LEGACY_OPENCODE_READ_ONLY_MESSAGE],
  ["kilocode", KILOCODE_READ_ONLY_MESSAGE],
] as const)(
  "replayed %s work fails before session discovery, startup or projection writes",
  async (provider, message) => {
    const threadId = ThreadId.makeUnsafe("legacy-replay");
    const runtime = vi.fn(() => Effect.die("legacy work must not reach runtime"));
    const services = {
      orchestrationEngine: {
        getReadModel: () =>
          Effect.succeed({
            threads: [{ id: threadId, modelSelection: { provider, model: "historical" } }],
          }),
      },
      providerService: { listSessions: runtime, startSession: runtime },
      setThreadSession: runtime,
    } as unknown as SessionOpServices;
    const result = await Effect.runPromise(
      Effect.result(ensureSessionForThread(services)(threadId, "2026-10-10T00:00:00.000Z")),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { issue: message },
    });
    expect(runtime).not.toHaveBeenCalled();
  },
);
