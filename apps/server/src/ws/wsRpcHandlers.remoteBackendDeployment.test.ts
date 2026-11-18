import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import { RemoteBackendDeployment } from "../remote-backend/Services/RemoteBackendDeployment.ts";
import { makeWsRpcRemoteBackendDeploymentHandlers } from "./wsRpcHandlers.remoteBackendDeployment.ts";

const input = {
  executionTargetId: "ssh:host=vps.example&transport=agent",
  requestId: "11111111-2222-4333-8444-555555555555",
  enableBoot: false,
};
const call = (mode: "desktop" | "remote", authToken: string | undefined) => {
  const calls: unknown[] = [];
  const program = Effect.gen(function* () {
    const handlers = yield* makeWsRpcRemoteBackendDeploymentHandlers();
    return yield* Effect.result(handlers[WS_METHODS.serverSetupRemoteBackend](input));
  }).pipe(
    Effect.provideService(ServerConfig, { mode, authToken } as unknown as ServerConfigShape),
    Effect.provideService(RemoteBackendDeployment, {
      setupRemoteBackend: async (selected) => {
        calls.push(selected);
        return {
          profileId: "rb-x",
          authority: {
            authorityId: "a".repeat(32),
            keyFingerprint: `sha256:${"b".repeat(64)}`,
            keyEpoch: 1,
          },
          status: "started" as const,
        };
      },
    }),
  );
  return Effect.runPromise(program).then((result) => ({ result, calls }));
};

it("only the authenticated local backend may deploy (D7)", async () => {
  const local = await call("desktop", "token");
  expect(local.calls).toEqual([input]);
  expect(local.result._tag).toBe("Success");
  for (const [mode, token] of [
    ["remote", "token"],
    ["desktop", undefined],
  ] as const) {
    const refused = await call(mode, token);
    expect(refused.calls).toEqual([]);
    expect(refused.result).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } });
  }
});
